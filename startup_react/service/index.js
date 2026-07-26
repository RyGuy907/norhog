import express from 'express';
import cookieParser from 'cookie-parser';
import bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';
import * as DB from './database.js';
import * as ImageStore from './imageStore.js';
import { initWebSocket, broadcast } from './scoreBroadcaster.js';
import { seedQuizzes } from './seedData.js';

const app = express();
const port = process.argv.length > 2 ? process.argv[2] : 4000;

const authCookieName = 'token';

app.use(express.json());
app.use(cookieParser());
app.use(express.static('public'));

const apiRouter = express.Router();
app.use('/api', apiRouter);

function setAuthCookie(res, token) {
  res.cookie(authCookieName, token, {
    secure: true,
    httpOnly: true,
    sameSite: 'strict',
  });
}

function userResponse(user) {
  return { email: user.email, creationDate: user.creationDate, role: user.role || null };
}

apiRouter.post('/auth/create', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !email.includes('@') || !email.includes('.')) {
    return res.status(400).send({ msg: 'A valid email is required' });
  }
  if (!password || password.length < 8) {
    return res.status(400).send({ msg: 'Password must be at least 8 characters' });
  }

  if (await DB.getUser(email)) {
    return res.status(409).send({ msg: 'User already exists' });
  }

  const user = {
    email,
    password: await bcrypt.hash(password, 10),
    token: uuidv4(),
    creationDate: new Date().toISOString(),
  };
  await DB.addUser(user);

  setAuthCookie(res, user.token);
  res.status(201).send(userResponse(user));
});

apiRouter.post('/auth/login', async (req, res) => {
  const { email, password } = req.body;
  const user = await DB.getUser(email);

  if (user && (await bcrypt.compare(password, user.password))) {
    user.token = uuidv4();
    await DB.updateUser(user);
    setAuthCookie(res, user.token);
    return res.status(200).send(userResponse(user));
  }

  res.status(401).send({ msg: 'Invalid email or password' });
});

apiRouter.post('/auth/logout', async (req, res) => {
  const user = await DB.getUserByToken(req.cookies[authCookieName]);
  if (user) {
    user.token = null;
    await DB.updateUser(user);
  }
  res.clearCookie(authCookieName);
  res.status(200).send({ msg: 'Logged out' });
});

// Middleware that requires a valid auth cookie.
async function verifyAuth(req, res, next) {
  const user = await DB.getUserByToken(req.cookies[authCookieName]);
  if (user) {
    req.user = user;
    next();
  } else {
    res.status(401).send({ msg: 'Unauthorized' });
  }
}

// Middleware that requires the authenticated user to be an admin.
function verifyAdmin(req, res, next) {
  if (req.user.role === 'admin') {
    next();
  } else {
    res.status(403).send({ msg: 'Admin access required' });
  }
}

apiRouter.get('/auth/me', verifyAuth, (req, res) => {
  res.status(200).send(userResponse(req.user));
});

// --- Quizzes ---

apiRouter.get('/quizzes', async (_req, res) => {
  res.status(200).send(await DB.getQuizzes());
});

apiRouter.get('/quiz/:slug', async (req, res) => {
  const quiz = await DB.getQuiz(req.params.slug);
  if (!quiz) {
    return res.status(404).send({ msg: 'Quiz not found' });
  }
  res.status(200).send(quiz);
});

// Validate and sanitize a quiz payload. Returns { quiz } or { error }.
function validateQuiz(body) {
  const slug = (body.slug || '').trim();
  const title = (body.title || '').trim();
  const timeLimit = body.timeLimit ?? 60;

  if (!/^[a-z0-9-]+$/.test(slug)) {
    return { error: 'Slug must contain only lowercase letters, numbers, and dashes' };
  }
  if (!title) {
    return { error: 'Title is required' };
  }
  if (!Number.isInteger(timeLimit) || timeLimit < 10 || timeLimit > 600) {
    return { error: 'Time limit must be between 10 and 600 seconds' };
  }

  const difficulties = {};
  for (const level of ['easy', 'medium', 'hard']) {
    const entries = body.difficulties?.[level];
    if (!Array.isArray(entries) || entries.length === 0) {
      return { error: `At least one question is required for ${level} difficulty` };
    }
    difficulties[level] = [];
    for (const entry of entries) {
      const question = (entry.question || '').trim();
      const answer = (entry.answer || '').trim();
      if (!question || !answer) {
        return { error: `Every ${level} question needs both a question and an answer` };
      }
      const accept = Array.isArray(entry.accept)
        ? entry.accept.map((alt) => String(alt).trim()).filter(Boolean)
        : [];
      difficulties[level].push({ question, answer, accept });
    }
  }

  return {
    quiz: {
      slug,
      title,
      image: (body.image || '').trim(),
      description: (body.description || '').trim(),
      instructions: (body.instructions || '').trim(),
      timeLimit,
      difficulties,
    },
  };
}

apiRouter.post('/quiz', verifyAuth, verifyAdmin, async (req, res) => {
  const { quiz, error } = validateQuiz(req.body);
  if (error) {
    return res.status(400).send({ msg: error });
  }
  if (await DB.getQuiz(quiz.slug)) {
    return res.status(409).send({ msg: 'A quiz with this slug already exists' });
  }
  await DB.addQuiz(quiz);
  res.status(201).send(quiz);
});

apiRouter.put('/quiz/:slug', verifyAuth, verifyAdmin, async (req, res) => {
  const existing = await DB.getQuiz(req.params.slug);
  if (!existing) {
    return res.status(404).send({ msg: 'Quiz not found' });
  }
  const { quiz, error } = validateQuiz({ ...req.body, slug: req.params.slug });
  if (error) {
    return res.status(400).send({ msg: error });
  }
  if (existing.image && existing.image !== quiz.image) {
    ImageStore.deleteImage(existing.image);
  }
  await DB.updateQuiz(req.params.slug, quiz);
  res.status(200).send(quiz);
});

apiRouter.delete('/quiz/:slug', verifyAuth, verifyAdmin, async (req, res) => {
  const quiz = await DB.getQuiz(req.params.slug);
  if (!quiz) {
    return res.status(404).send({ msg: 'Quiz not found' });
  }
  await DB.deleteQuiz(req.params.slug);
  await DB.deleteScoresForQuiz(req.params.slug);
  ImageStore.deleteImage(quiz.image);
  res.status(200).send({ msg: 'Quiz deleted' });
});

apiRouter.post('/quiz-image-url', verifyAuth, verifyAdmin, async (req, res) => {
  if (!ImageStore.imagesConfigured()) {
    return res.status(501).send({ msg: 'Image uploads are not configured; paste an image URL instead' });
  }
  const { contentType } = req.body;
  if (!ImageStore.isValidImageType(contentType)) {
    return res.status(400).send({ msg: 'Images must be JPEG, PNG, WebP, or GIF' });
  }
  res.status(200).send(await ImageStore.createUploadUrl(contentType));
});

// --- Scores ---

// A quiz is worth up to 10 points; harder difficulties are worth more.
const difficultyPoints = { easy: 6, medium: 8, hard: 10 };

apiRouter.post('/score', verifyAuth, async (req, res) => {
  const { quiz: quizSlug, score, difficulty, timeLeft } = req.body;

  const quiz = await DB.getQuiz(quizSlug);
  if (!quiz) {
    return res.status(400).send({ msg: 'Unknown quiz' });
  }
  if (!(difficulty in difficultyPoints)) {
    return res.status(400).send({ msg: 'Invalid difficulty' });
  }
  const total = quiz.difficulties[difficulty].length;
  if (!Number.isInteger(score) || score < 0 || score > total) {
    return res.status(400).send({ msg: 'Invalid score' });
  }
  if (!Number.isInteger(timeLeft) || timeLeft < 0 || timeLeft > quiz.timeLimit) {
    return res.status(400).send({ msg: 'Invalid time' });
  }

  const points = Math.round((score / total) * difficultyPoints[difficulty]);
  const timeSpent = quiz.timeLimit - timeLeft;

  // How much this run improves the player's total (a quiz counts once).
  const previousBest = await DB.getQuizBestPoints(req.user.email, quiz.slug);
  const pointsGained = Math.max(0, points - previousBest);

  await DB.addScore({
    user: req.user.email,
    quiz: quiz.slug,
    difficulty,
    score,
    total,
    points,
    timeSpent,
    date: new Date().toISOString(),
  });

  broadcast({ type: 'updateScores', allScores: await DB.getUserTotals(10) });

  res.status(200).send({
    scores: await DB.getQuizTimes(quiz.slug, difficulty, 10),
    summary: { score, total, points, pointsGained, timeSpent },
  });
});

apiRouter.get('/scores', async (req, res) => {
  const { quiz, difficulty } = req.query;
  if (quiz && difficulty) {
    return res.status(200).send(await DB.getQuizTimes(quiz, difficulty, 10));
  }
  res.status(200).send(await DB.getUserTotals(10));
});

apiRouter.get('/scores/best', verifyAuth, async (req, res) => {
  const { quiz, difficulty } = req.query;
  if (!quiz || !difficulty) {
    return res.status(400).send({ msg: 'quiz and difficulty are required' });
  }
  const best = await DB.getUserBest(req.user.email, quiz, difficulty);
  res.status(200).send(best || {});
});

apiRouter.get('/scores/me', verifyAuth, async (req, res) => {
  const scores = await DB.getUserScores(req.user.email);
  const total = scores.reduce((sum, entry) => sum + entry.points, 0);
  res.status(200).send({ total, scores });
});

// --- Quiz suggestions ---

apiRouter.post('/suggestion', verifyAuth, async (req, res) => {
  const { quiz, error } = validateQuiz(req.body);
  if (error) {
    return res.status(400).send({ msg: error });
  }
  await DB.addSuggestion({
    ...quiz,
    suggestedBy: req.user.email,
    date: new Date().toISOString(),
  });
  res.status(201).send({ msg: 'Suggestion submitted for review' });
});

apiRouter.get('/suggestions', verifyAuth, verifyAdmin, async (_req, res) => {
  res.status(200).send(await DB.getSuggestions());
});

apiRouter.delete('/suggestions/:id', verifyAuth, verifyAdmin, async (req, res) => {
  try {
    await DB.deleteSuggestion(req.params.id);
  } catch {
    return res.status(400).send({ msg: 'Invalid suggestion id' });
  }
  res.status(200).send({ msg: 'Suggestion removed' });
});

// Serve the React app for unknown routes
app.use((_req, res) => {
  res.sendFile('index.html', { root: 'public' });
});

// Seed starter quizzes that aren't in the database yet (never overwrites edits).
for (const quiz of seedQuizzes) {
  if (!(await DB.getQuiz(quiz.slug))) {
    await DB.addQuiz(quiz);
    console.log(`Seeded quiz: ${quiz.slug}`);
  }
}

const httpService = app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});

initWebSocket(httpService);
