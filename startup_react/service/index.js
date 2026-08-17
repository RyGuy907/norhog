import express from 'express';
import cookieParser from 'cookie-parser';
import bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';
import * as DB from './database.js';
import * as ImageStore from './imageStore.js';
import { initWebSocket, broadcast } from './scoreBroadcaster.js';
import { seedQuizzes } from './seedData.js';
import { sanitizeRequest, asString, route, rateLimit } from './security.js';
import { acceptedAnswers } from './answerMatch.js';
import { newSalt, lockAnswer } from './answerLock.js';

const app = express();
const port = process.argv.length > 2 ? process.argv[2] : 4000;

const authCookieName = 'token';

// Behind Caddy in production, so req.ip reflects X-Forwarded-For.
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(express.json({ limit: '256kb' }));
app.use(cookieParser());
app.use(sanitizeRequest);
app.use(express.static('public'));

const apiRouter = express.Router();
app.use('/api', apiRouter);

// Brute-force protection on credential endpoints.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: 'Too many attempts. Please wait a few minutes and try again.',
});
const writeLimiter = rateLimit({ windowMs: 60 * 1000, max: 60 });

// Plain HTTP (a bare EC2 IP or LAN address) silently drops secure cookies,
// so only require HTTPS when running in production behind Caddy.
const cookieOptions = {
  secure: process.env.NODE_ENV === 'production',
  httpOnly: true,
  sameSite: 'strict',
};
const sessionMaxAge = 7 * 24 * 60 * 60 * 1000;

function setAuthCookie(res, token) {
  res.cookie(authCookieName, token, { ...cookieOptions, maxAge: sessionMaxAge });
}

function clearAuthCookie(res) {
  res.clearCookie(authCookieName, cookieOptions);
}

function userResponse(user) {
  return {
    email: user.email,
    displayName: user.displayName,
    creationDate: user.creationDate,
    role: user.role || null,
  };
}

// bcrypt silently truncates at 72 bytes; reject longer rather than accept a
// password whose tail is ignored.
const maxPasswordLength = 72;

apiRouter.post('/auth/create', authLimiter, route(async (req, res) => {
  const email = asString(req.body.email, 254);
  const password = typeof req.body.password === 'string' ? req.body.password : null;
  const displayName = asString(req.body.displayName, 50);

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).send({ msg: 'A valid email is required' });
  }
  if (!password || password.length < 8) {
    return res.status(400).send({ msg: 'Password must be at least 8 characters' });
  }
  if (password.length > maxPasswordLength) {
    return res.status(400).send({ msg: `Password must be ${maxPasswordLength} characters or fewer` });
  }
  if (!displayName || displayName.length < 3 || displayName.length > 20) {
    return res.status(400).send({ msg: 'Display name must be 3-20 characters' });
  }
  if (!/^[a-zA-Z0-9 _-]+$/.test(displayName)) {
    return res.status(400).send({ msg: 'Display name can only use letters, numbers, spaces, _ and -' });
  }

  const emailLower = email.toLowerCase();
  if (await DB.getUser(emailLower)) {
    return res.status(409).send({ msg: 'An account with this email already exists' });
  }
  if (await DB.getUserByName(displayName.toLowerCase())) {
    return res.status(409).send({ msg: 'That display name is already taken' });
  }

  const user = {
    email: emailLower,
    displayName,
    nameLower: displayName.toLowerCase(),
    password: await bcrypt.hash(password, 10),
    token: uuidv4(),
    creationDate: new Date().toISOString(),
  };

  try {
    await DB.addUser(user);
  } catch (err) {
    // Unique indexes are the real guard against two simultaneous signups
    // claiming the same email or display name.
    if (err.code === 11000) {
      return res.status(409).send({ msg: 'That email or display name is already taken' });
    }
    throw err;
  }

  setAuthCookie(res, user.token);
  res.status(201).send(userResponse(user));
}));

// Compared against when no user matches, so a bad email costs the same time
// as a bad password (otherwise response timing reveals which emails exist).
const dummyHash = bcrypt.hashSync('timing-equalizer', 10);

apiRouter.post('/auth/login', authLimiter, route(async (req, res) => {
  const email = asString(req.body.email, 254);
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const user = email ? await DB.getUser(email.toLowerCase()) : null;
  const passwordMatches = await bcrypt.compare(password, user ? user.password : dummyHash);

  if (user && passwordMatches) {
    user.token = uuidv4();
    await DB.updateUser(user);
    setAuthCookie(res, user.token);
    return res.status(200).send(userResponse(user));
  }

  res.status(401).send({ msg: 'Invalid email or password' });
}));

apiRouter.post('/auth/logout', route(async (req, res) => {
  const user = await DB.getUserByToken(asString(req.cookies[authCookieName], 100));
  if (user) {
    user.token = null;
    await DB.updateUser(user);
  }
  clearAuthCookie(res);
  res.status(200).send({ msg: 'Logged out' });
}));

// Middleware that requires a valid auth cookie.
async function verifyAuth(req, res, next) {
  try {
    const user = await DB.getUserByToken(asString(req.cookies[authCookieName], 100));
    if (user) {
      req.user = user;
      next();
    } else {
      res.status(401).send({ msg: 'Unauthorized' });
    }
  } catch (err) {
    next(err);
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

// Permanently delete the account, its scores, and its pending suggestions.
apiRouter.delete('/user', verifyAuth, writeLimiter, route(async (req, res) => {
  if (req.body?.confirm !== true) {
    return res.status(400).send({ msg: 'Deletion must be confirmed' });
  }
  await DB.deleteUser(req.user.email);
  clearAuthCookie(res);
  broadcast({ type: 'updateScores', allScores: await DB.getUserTotals(leaderboardLimit) });
  res.status(200).send({ msg: 'Account deleted' });
}));

// --- Quizzes ---

apiRouter.get('/quizzes', route(async (_req, res) => {
  res.status(200).send(await DB.getQuizzes());
}));

// Most-played quizzes for the leaderboard sidebar. Public, like the boards it
// sits next to, and returns only display fields — no answers, no player names.
apiRouter.get('/quizzes/popular', route(async (_req, res) => {
  res.status(200).send(await DB.getPopularQuizzes(5));
}));

// The signed-in player's own most-played quizzes. The identity comes from the
// session cookie via verifyAuth, never from the request, so one user cannot ask
// for another's history.
apiRouter.get('/quizzes/favorites', verifyAuth, route(async (req, res) => {
  res.status(200).send(await DB.getUserFavoriteQuizzes(req.user.email, 4));
}));

// Public quiz payload: question text plus locked answers. Each accepted
// spelling becomes an id (to match a guess against) and a ciphertext of the
// display answer keyed by that spelling, so nothing readable ships to the
// browser and a client can only reveal answers it has actually guessed.
// Unguessed answers are released by /attempt/finish once the run is over.
function publicQuiz(quiz) {
  const salt = newSalt();
  const difficulties = {};
  for (const level of ['easy', 'medium', 'hard']) {
    difficulties[level] = (quiz.difficulties[level] || []).map((entry) => ({
      question: entry.question,
      locks: [...acceptedAnswers(entry)].map((variant) => lockAnswer(salt, variant, entry.answer)),
    }));
  }
  return { ...quiz, salt, difficulties };
}

apiRouter.get('/quiz/:slug', route(async (req, res) => {
  const quiz = await DB.getQuiz(req.params.slug);
  if (!quiz) {
    return res.status(404).send({ msg: 'Quiz not found' });
  }
  res.status(200).send(publicQuiz(quiz));
}));

// Admins editing a quiz need the answers.
apiRouter.get('/quiz/:slug/full', verifyAuth, verifyAdmin, route(async (req, res) => {
  const quiz = await DB.getQuiz(req.params.slug);
  if (!quiz) {
    return res.status(404).send({ msg: 'Quiz not found' });
  }
  res.status(200).send(quiz);
}));

// Validate and sanitize a quiz payload. Returns { quiz } or { error }.
const defaultTimeLimits = { easy: 300, medium: 480, hard: 600 };

const maxQuestionsPerLevel = 100;

// Quiz images are rendered into an <img src>, so only allow http(s) URLs —
// a javascript: or data: URL there would be a stored XSS vector.
function safeImageUrl(value) {
  const url = asString(value, 500);
  if (!url) {
    return '';
  }
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? url : '';
  } catch {
    return '';
  }
}

function validateQuiz(body) {
  const slug = asString(body.slug, 100) || '';
  const title = asString(body.title, 120) || '';

  if (!/^[a-z0-9-]{1,60}$/.test(slug)) {
    return { error: 'Slug must contain only lowercase letters, numbers, and dashes' };
  }
  if (!title) {
    return { error: 'Title is required' };
  }

  const timeLimits = {};
  for (const level of ['easy', 'medium', 'hard']) {
    const value = body.timeLimits?.[level] ?? defaultTimeLimits[level];
    if (!Number.isInteger(value) || value < 10 || value > 900) {
      return { error: `The ${level} time limit must be between 10 and 900 seconds` };
    }
    timeLimits[level] = value;
  }

  const difficulties = {};
  for (const level of ['easy', 'medium', 'hard']) {
    const entries = body.difficulties?.[level];
    if (!Array.isArray(entries) || entries.length === 0) {
      return { error: `At least one question is required for ${level} difficulty` };
    }
    if (entries.length > maxQuestionsPerLevel) {
      return { error: `A difficulty can have at most ${maxQuestionsPerLevel} questions` };
    }
    difficulties[level] = [];
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') {
        return { error: `Every ${level} question needs both a question and an answer` };
      }
      const question = asString(entry.question, 300) || '';
      const answer = asString(entry.answer, 100) || '';
      if (!question || !answer) {
        return { error: `Every ${level} question needs both a question and an answer` };
      }
      const accept = Array.isArray(entry.accept)
        ? entry.accept
            .slice(0, 20)
            .map((alt) => asString(alt, 100))
            .filter(Boolean)
        : [];
      difficulties[level].push({ question, answer, accept });
    }
  }

  return {
    quiz: {
      slug,
      title,
      image: safeImageUrl(body.image),
      description: asString(body.description, 500) || '',
      instructions: asString(body.instructions, 500) || '',
      timeLimits,
      difficulties,
    },
  };
}

apiRouter.post('/quiz', verifyAuth, verifyAdmin, writeLimiter, route(async (req, res) => {
  const { quiz, error } = validateQuiz(req.body);
  if (error) {
    return res.status(400).send({ msg: error });
  }
  if (await DB.getQuiz(quiz.slug)) {
    return res.status(409).send({ msg: 'A quiz with this slug already exists' });
  }
  await DB.addQuiz(quiz);
  res.status(201).send(quiz);
}));

apiRouter.put('/quiz/:slug', verifyAuth, verifyAdmin, writeLimiter, route(async (req, res) => {
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
}));

apiRouter.delete('/quiz/:slug', verifyAuth, verifyAdmin, writeLimiter, route(async (req, res) => {
  const quiz = await DB.getQuiz(req.params.slug);
  if (!quiz) {
    return res.status(404).send({ msg: 'Quiz not found' });
  }
  await DB.deleteQuiz(req.params.slug);
  await DB.deleteScoresForQuiz(req.params.slug);
  ImageStore.deleteImage(quiz.image);
  res.status(200).send({ msg: 'Quiz deleted' });
}));

apiRouter.post('/quiz-image-url', verifyAuth, verifyAdmin, writeLimiter, route(async (req, res) => {
  if (!ImageStore.imagesConfigured()) {
    return res.status(501).send({ msg: 'Image uploads are not configured; paste an image URL instead' });
  }
  const { contentType } = req.body;
  if (!ImageStore.isValidImageType(contentType)) {
    return res.status(400).send({ msg: 'Images must be JPEG, PNG, WebP, or GIF' });
  }
  res.status(200).send(await ImageStore.createUploadUrl(contentType));
}));

// --- Scores ---

// A quiz is worth up to 10 points; harder difficulties are worth more.
const difficultyPoints = { easy: 6, medium: 8, hard: 10 };

// The leaderboard shows everyone rather than a top ten, so the page can scroll
// through the full standings. Still bounded, because this payload is also
// broadcast to every open socket on each score submission.
const leaderboardLimit = 200;

// In-flight quiz attempts, keyed by a single-use token. The server records
// when play actually started so elapsed time can't be claimed by the client.
const attempts = new Map();
const attemptGraceMs = 15000;
// Floor on plausible human speed; anything faster is a scripted submission.
const minSecondsPerAnswer = 0.4;

setInterval(() => {
  const now = Date.now();
  for (const [id, attempt] of attempts) {
    if (attempt.expiresAt <= now) {
      attempts.delete(id);
    }
  }
}, 60 * 1000).unref();

// Attaches req.user when a valid session cookie is present, but doesn't
// require one — guests can play, their runs just aren't scored.
async function optionalAuth(req, _res, next) {
  try {
    req.user = await DB.getUserByToken(asString(req.cookies[authCookieName], 100));
  } catch {
    req.user = null;
  }
  next();
}

// Starting a quiz issues an attempt token recording when play began, so the
// elapsed time on a submission comes from the server's clock, not the client.
apiRouter.post('/attempt', optionalAuth, writeLimiter, route(async (req, res) => {
  const quizSlug = asString(req.body.quiz, 100);
  const difficulty = asString(req.body.difficulty, 20);

  const quiz = await DB.getQuiz(quizSlug);
  if (!quiz) {
    return res.status(400).send({ msg: 'Unknown quiz' });
  }
  if (!Object.hasOwn(difficultyPoints, difficulty)) {
    return res.status(400).send({ msg: 'Invalid difficulty' });
  }

  const timeLimit = quiz.timeLimits[difficulty];
  const attemptId = uuidv4();
  const startedAt = Date.now();
  attempts.set(attemptId, {
    user: req.user ? req.user.email : null,
    quiz: quiz.slug,
    difficulty,
    timeLimit,
    startedAt,
    answers: quiz.difficulties[difficulty].map((entry) => entry.answer),
    expiresAt: startedAt + timeLimit * 1000 + attemptGraceMs + 5 * 60 * 1000,
  });

  res.status(201).send({ attemptId, timeLimit });
}));

// Look up an attempt, enforcing that it belongs to the caller.
function getAttempt(req) {
  const attemptId = asString(req.body.attemptId, 100);
  const attempt = attemptId ? attempts.get(attemptId) : null;
  if (!attempt) {
    return null;
  }
  const caller = req.user ? req.user.email : null;
  return attempt.user === caller ? attempt : null;
}


// Ending a run: the server already knows the score (from tracked guesses)
// and the elapsed time, so nothing about the result is client-asserted.
// Always returns the full answer key for the reveal, since the run is over.
apiRouter.post('/attempt/finish', optionalAuth, writeLimiter, route(async (req, res) => {
  const attempt = getAttempt(req);
  if (!attempt) {
    return res.status(400).send({ msg: 'No active attempt' });
  }

  const { quiz: slug, difficulty, timeLimit, startedAt, answers } = attempt;
  const { score } = req.body;
  const total = answers.length;
  attempts.delete(asString(req.body.attemptId, 100));

  if (!Number.isInteger(score) || score < 0 || score > total) {
    return res.status(400).send({ msg: 'Invalid score' });
  }

  const elapsed = (Date.now() - startedAt) / 1000;
  if (elapsed > timeLimit + attemptGraceMs / 1000) {
    return res.status(400).send({ msg: 'Time expired for this attempt' });
  }
  if (score > 0 && elapsed < score * minSecondsPerAnswer) {
    return res.status(400).send({ msg: 'Submission rejected' });
  }
  const timeSpent = Math.min(Math.max(Math.round(elapsed), 0), timeLimit);

  // Guests can play; only signed-in runs are recorded.
  if (!attempt.user) {
    return res.status(200).send({
      answers,
      summary: { score, total, timeSpent, timeLimit, difficulty },
    });
  }

  const points = Math.round((score / total) * difficultyPoints[difficulty]);
  const previousBest = await DB.getQuizBestPoints(attempt.user, slug);
  const pointsGained = Math.max(0, points - previousBest);

  await DB.addScore({
    user: attempt.user,
    name: req.user.displayName,
    quiz: slug,
    difficulty,
    score,
    total,
    points,
    timeSpent,
    date: new Date().toISOString(),
  });

  broadcast({ type: 'updateScores', allScores: await DB.getUserTotals(leaderboardLimit) });

  res.status(200).send({
    answers,
    scores: await DB.getQuizTimes(slug, difficulty, 10),
    summary: {
      score,
      total,
      points,
      pointsGained,
      timeSpent,
      timeLimit,
      difficulty,
      bestTime: await DB.getUserBestTime(attempt.user, slug, difficulty),
    },
  });
}));

apiRouter.get('/scores', route(async (req, res) => {
  const quiz = asString(req.query.quiz, 100);
  const difficulty = asString(req.query.difficulty, 20);
  if (req.query.quiz !== undefined && !quiz) {
    return res.status(400).send({ msg: 'Invalid quiz' });
  }
  if (quiz && difficulty) {
    return res.status(200).send(await DB.getQuizTimes(quiz, difficulty, 10));
  }
  if (quiz) {
    // All three fastest-times boards at once so the quiz page loads them in one call.
    const [easy, medium, hard] = await Promise.all(
      ['easy', 'medium', 'hard'].map((level) => DB.getQuizTimes(quiz, level, 10))
    );
    return res.status(200).send({ easy, medium, hard });
  }
  res.status(200).send(await DB.getUserTotals(leaderboardLimit));
}));

apiRouter.get('/scores/best', verifyAuth, route(async (req, res) => {
  const quiz = asString(req.query.quiz, 100);
  const difficulty = asString(req.query.difficulty, 20);
  if (!quiz) {
    return res.status(400).send({ msg: 'quiz is required' });
  }

  const bestFor = async (level) => ({
    ...((await DB.getUserBest(req.user.email, quiz, level)) || {}),
    bestTime: await DB.getUserBestTime(req.user.email, quiz, level),
  });

  if (difficulty) {
    return res.status(200).send({
      ...(await bestFor(difficulty)),
      quizPoints: await DB.getQuizBestPoints(req.user.email, quiz),
    });
  }

  // All three difficulties at once so the quiz page loads them in one call.
  const [easy, medium, hard, quizPoints] = await Promise.all([
    bestFor('easy'),
    bestFor('medium'),
    bestFor('hard'),
    DB.getQuizBestPoints(req.user.email, quiz),
  ]);
  res.status(200).send({ easy, medium, hard, quizPoints });
}));

apiRouter.get('/scores/me', verifyAuth, route(async (req, res) => {
  const scores = await DB.getUserScores(req.user.email);
  const total = scores.reduce((sum, entry) => sum + entry.points, 0);
  res.status(200).send({ total, scores });
}));

// --- Quiz suggestions ---

apiRouter.post('/suggestion', verifyAuth, writeLimiter, route(async (req, res) => {
  const { quiz, error } = validateQuiz(req.body);
  if (error) {
    return res.status(400).send({ msg: error });
  }
  await DB.addSuggestion({
    ...quiz,
    suggestedBy: req.user.email,
    suggestedByName: req.user.displayName,
    date: new Date().toISOString(),
  });
  res.status(201).send({ msg: 'Suggestion submitted for review' });
}));

apiRouter.get('/suggestions', verifyAuth, verifyAdmin, route(async (_req, res) => {
  res.status(200).send(await DB.getSuggestions());
}));

apiRouter.delete('/suggestions/:id', verifyAuth, verifyAdmin, route(async (req, res) => {
  try {
    await DB.deleteSuggestion(req.params.id);
  } catch {
    return res.status(400).send({ msg: 'Invalid suggestion id' });
  }
  res.status(200).send({ msg: 'Suggestion removed' });
}));

// Unknown API routes should be a JSON 404, not the SPA's HTML.
apiRouter.use((_req, res) => {
  res.status(404).send({ msg: 'Not found' });
});

// Any unhandled error becomes a 500 instead of taking the process down.
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.log(`Unhandled error: ${err?.message}`);
  res.status(500).send({ msg: 'Something went wrong' });
});

// Serve the React app for unknown routes
app.use((_req, res) => {
  res.sendFile('index.html', { root: 'public' });
});

async function seedStarterQuizzes() {
  // Seed starter quizzes that aren't in the database yet (never overwrites edits).
  for (const quiz of seedQuizzes) {
    if (!(await DB.getQuiz(quiz.slug))) {
      await DB.addQuiz(quiz);
      console.log(`Seeded quiz: ${quiz.slug}`);
    }
  }
}

function start() {
  // Last-resort net: log rather than let an escaped async error kill the service.
  process.on('unhandledRejection', (reason) => {
    console.log(`Unhandled rejection: ${reason?.message || reason}`);
  });
  process.on('uncaughtException', (err) => {
    console.log(`Uncaught exception: ${err?.message}`);
  });

  const httpService = app.listen(port, () => {
    console.log(`Server running on port ${port}`);
  });

  initWebSocket(httpService);
}

// Boot unless the test runner imported us — importing this module from a test
// should give you the Express app without opening a port or seeding.
//
// This deliberately checks for the test runner rather than asking "am I the entry
// point?". The previous version compared import.meta.url against
// resolve(process.argv[1]), which works under `node index.js` but fails silently
// under a process manager: pm2's fork mode points argv[1] at its own wrapper
// script, so the comparison was false, start() never ran, and nothing ever
// listened on the port. The service looked healthy — pm2 reported it online and
// the database connected, because that is an import side effect — while every
// request through Caddy returned 502.
if (!process.env.VITEST) {
  await seedStarterQuizzes();
  start();
}

// Test-only helper: the limiters hold per-process counters that outlive an
// individual case, so a suite sharing one app instance must clear them between
// tests. Not referenced by the running service.
export function resetRateLimits() {
  authLimiter.reset();
  writeLimiter.reset();
}

export { app };
