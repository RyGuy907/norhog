import express from 'express';
import cookieParser from 'cookie-parser';
import bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';
import * as DB from './database.js';
import * as ImageStore from './imageStore.js';
import { initWebSocket, broadcast } from './scoreBroadcaster.js';
import { seedQuizzes } from './seedData.js';
import { sanitizeRequest, asString, route, rateLimit } from './security.js';
import { acceptedAnswers, normalize } from './answerMatch.js';
import { newSalt, lockAnswer } from './answerLock.js';
import * as Daily from './daily.js';

const app = express();
const port = process.argv.length > 2 ? process.argv[2] : 4000;

const authCookieName = 'token';

// In production the service sits behind Caddy, so req.ip is read from X-Forwarded-For.
app.set('trust proxy', 1);
app.disable('x-powered-by');

// Basic security headers, since Caddy doesn't add any by default. HSTS is only
// sent in production, where the site is always served over HTTPS.
app.use((_req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
  });
  if (process.env.NODE_ENV === 'production') {
    res.set('Strict-Transport-Security', 'max-age=15552000');
  }
  next();
});

app.use(express.json({ limit: '256kb' }));
app.use(cookieParser());
app.use(sanitizeRequest);
app.use(express.static('public'));

const apiRouter = express.Router();
app.use('/api', apiRouter);

// Limits guessing on the login and signup endpoints.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: 'Too many attempts. Please wait a few minutes and try again.',
});
const writeLimiter = rateLimit({ windowMs: 60 * 1000, max: 60 });

// Browsers drop Secure cookies over plain HTTP, which would break local
// development, so the flag is only set in production where Caddy serves HTTPS.
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

// Looks up the user for the request's session cookie. The token's age is
// checked here as well as by the cookie's maxAge, so a copied token stops
// working after the same 7 days instead of lasting until the next login.
async function sessionUser(req) {
  const user = await DB.getUserByToken(asString(req.cookies[authCookieName], 100));
  if (!user) {
    return null;
  }
  const age = Date.now() - Date.parse(user.tokenIssuedAt);
  return age >= 0 && age < sessionMaxAge ? user : null;
}

function userResponse(user) {
  return {
    email: user.email,
    displayName: user.displayName,
    creationDate: user.creationDate,
    role: user.role || null,
  };
}

// bcrypt ignores everything past 72 bytes, so longer passwords are rejected
// instead of being quietly cut short.
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
  // Measured in bytes, since accented letters and emoji take more than one.
  if (Buffer.byteLength(password, 'utf8') > maxPasswordLength) {
    return res.status(400).send({ msg: 'Password is too long' });
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
    tokenIssuedAt: new Date().toISOString(),
    creationDate: new Date().toISOString(),
  };

  try {
    await DB.addUser(user);
  } catch (err) {
    // The checks above can race when two signups arrive at once, so the unique
    // indexes on email and display name are what actually prevent duplicates.
    if (err.code === 11000) {
      return res.status(409).send({ msg: 'That email or display name is already taken' });
    }
    throw err;
  }

  setAuthCookie(res, user.token);
  res.status(201).send(userResponse(user));
}));

// When no user matches, the password is still compared against this hash so an
// unknown email takes as long as a wrong password. Without it, response timing
// would show which emails have accounts.
const dummyHash = bcrypt.hashSync('timing-equalizer', 10);

apiRouter.post('/auth/login', authLimiter, route(async (req, res) => {
  const email = asString(req.body.email, 254);
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const user = email ? await DB.getUser(email.toLowerCase()) : null;
  const passwordMatches = await bcrypt.compare(password, user ? user.password : dummyHash);

  if (user && passwordMatches) {
    user.token = uuidv4();
    user.tokenIssuedAt = new Date().toISOString();
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
    user.tokenIssuedAt = null;
    await DB.updateUser(user);
  }
  clearAuthCookie(res);
  res.status(200).send({ msg: 'Logged out' });
}));

// Middleware that requires a valid auth cookie.
async function verifyAuth(req, res, next) {
  try {
    const user = await sessionUser(req);
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

// Most-played quizzes for the leaderboard sidebar. It is public like the boards
// next to it and returns display fields only, with no answers or player names.
apiRouter.get('/quizzes/popular', route(async (_req, res) => {
  res.status(200).send(await DB.getPopularQuizzes(5));
}));

// The signed-in player's own most-played quizzes. The user comes from the
// session cookie through verifyAuth rather than a request parameter, so nobody
// can ask for another player's history.
apiRouter.get('/quizzes/favorites', verifyAuth, route(async (req, res) => {
  res.status(200).send(await DB.getUserFavoriteQuizzes(req.user.email, 4));
}));

// Builds the public quiz payload, which has the question text and locked
// answers. Each accepted spelling becomes an id (compared against a guess) and
// a ciphertext of the display answer keyed by that spelling. No readable
// answers reach the browser, and the client can only unlock an answer it has
// actually guessed. The rest are sent by /attempt/finish when the run ends.
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

// The plaintext answers, which admins need when editing a quiz.
apiRouter.get('/quiz/:slug/full', verifyAuth, verifyAdmin, route(async (req, res) => {
  const quiz = await DB.getQuiz(req.params.slug);
  if (!quiz) {
    return res.status(404).send({ msg: 'Quiz not found' });
  }
  res.status(200).send(quiz);
}));

// Time limits in seconds, used when a quiz payload leaves them out.
const defaultTimeLimits = { easy: 360, medium: 480, hard: 600 };

const maxQuestionsPerLevel = 100;

// Quiz images end up in an <img src>, so only http and https URLs are kept.
// A javascript: or data: URL there could be used for stored XSS.
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

// The image position is written directly into an inline style, so only the
// CSS keywords and percentages a focal point needs are allowed. Free text could
// otherwise slip in url() or extra declarations.
function safeObjectPosition(value) {
  const raw = asString(value, 40);
  if (!raw) {
    return '';
  }
  const tokens = raw.trim().toLowerCase().split(/\s+/);
  if (tokens.length < 1 || tokens.length > 2) {
    return '';
  }
  const ok = /^(left|right|top|bottom|center|-?\d{1,3}(\.\d+)?%)$/;
  return tokens.every((t) => ok.test(t)) ? tokens.join(' ') : '';
}

// Hand-written wrong answers for the daily quiz's multiple choice. Returns
// { choices } for exactly three distinct wrong answers, { error } when some
// were given but they don't qualify, and {} when none were given. A choice
// that matches any accepted spelling of the answer would be marked wrong when
// picked, so those are refused too.
function cleanChoices(value, entry) {
  if (!Array.isArray(value)) {
    return {};
  }
  const choices = value.map((choice) => asString(choice, 100)).filter(Boolean);
  if (choices.length === 0) {
    return {};
  }
  const correct = acceptedAnswers(entry);
  const distinct = new Set(choices.map((choice) => normalize(choice)));
  if (choices.length !== 3 || distinct.size !== 3 || [...distinct].some((choice) => correct.has(choice))) {
    return { error: 'Daily quiz wrong answers need to be three different answers, none of them a correct one.' };
  }
  return { choices };
}

// Validates and cleans a quiz payload. Returns { quiz } or { error }.
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
      const cleaned = { question, answer, accept };
      // Flags for the daily quiz picker (see daily.js).
      // A first question has nothing before it to lean on.
      if (entry.followsPrevious === true && difficulties[level].length > 0) {
        cleaned.followsPrevious = true;
      }
      if (entry.daily === false) {
        cleaned.daily = false;
      }
      const { choices, error } = cleanChoices(entry.choices, cleaned);
      if (error) {
        return { error: `${error} (${level} question ${difficulties[level].length + 1})` };
      }
      if (choices) {
        cleaned.choices = choices;
      }
      difficulties[level].push(cleaned);
    }
  }

  return {
    quiz: {
      slug,
      title,
      image: safeImageUrl(body.image),
      imagePosition: safeObjectPosition(body.imagePosition),
      imageCaption: asString(body.imageCaption, 300) || '',
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
  invalidatePool();
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
  invalidatePool();
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
  invalidatePool();
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

// The leaderboard lists the full standings instead of a top ten. It still has
// a cap because the same payload is broadcast to every open socket whenever a
// score comes in.
const leaderboardLimit = 200;

// Quiz runs in progress, keyed by a single-use token. The server records when
// play started so the client can't report its own elapsed time.
const attempts = new Map();
const attemptGraceMs = 15000;
// Attempts don't require an account, so the map has a hard cap to keep a flood
// of requests from using up the server's memory.
const maxAttempts = 10000;
// The fastest pace a person could plausibly type answers. Anything quicker is
// treated as a scripted submission.
const minSecondsPerAnswer = 0.4;

setInterval(() => {
  const now = Date.now();
  for (const [id, attempt] of attempts) {
    if (attempt.expiresAt <= now) {
      attempts.delete(id);
    }
  }
}, 60 * 1000).unref();

// Sets req.user when a valid session cookie is present but doesn't require
// one. Guests can play, but their runs aren't scored.
async function optionalAuth(req, _res, next) {
  try {
    req.user = await sessionUser(req);
  } catch {
    req.user = null;
  }
  next();
}

// Starting a quiz issues an attempt token that records when play began, so the
// elapsed time on a submission comes from the server's clock.
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
  if (attempts.size >= maxAttempts) {
    return res.status(503).send({ msg: 'The server is busy. Please try again in a minute.' });
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

// Looks up an attempt and returns it only if it belongs to the caller.
function getAttempt(req) {
  const attemptId = asString(req.body.attemptId, 100);
  const attempt = attemptId ? attempts.get(attemptId) : null;
  if (!attempt) {
    return null;
  }
  const caller = req.user ? req.user.email : null;
  return attempt.user === caller ? attempt : null;
}

// Ends a run. The attempt token is consumed, elapsed time comes from the
// server's clock, and the score is range-checked and rejected if it was
// reached faster than a person could type. The full answer key is always
// returned for the end-of-run reveal.
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

// --- Daily quiz ---

// Today's day, cached for the process. A day is built from the library the
// first time anyone asks for it and stored, so it never changes once played.
let cachedDay = null;

// The prepared question pool, shared by practice rounds. Building it takes
// about half a second, so it is kept and rebuilt after a quiz changes or ten
// minutes pass.
let cachedPool = null;
const poolMaxAgeMs = 10 * 60 * 1000;

async function getPreparedPool() {
  if (!cachedPool || Date.now() - cachedPool.builtAt > poolMaxAgeMs) {
    cachedPool = { prepared: Daily.prepare(await DB.getQuizzesForDaily()), builtAt: Date.now() };
  }
  return cachedPool.prepared;
}

function invalidatePool() {
  cachedPool = null;
}

async function getOrCreateDay(date) {
  if (cachedDay?.date === date) {
    return cachedDay;
  }
  let day = await DB.getDaily(date);
  if (!day) {
    const built = Daily.buildDay(await DB.getQuizzesForDaily(), date, await DB.getUsedDailyKeys(date));
    if (!built) {
      return null;
    }
    day = await DB.addDaily(built);
  }
  cachedDay = day;
  return day;
}

async function dailyStreak(user, today) {
  return Daily.streakFrom(await DB.getDailyPlayDates(user.email), today);
}

apiRouter.get('/daily', optionalAuth, route(async (req, res) => {
  const today = Daily.dailyDate();
  const day = await getOrCreateDay(today);
  if (!day) {
    return res.status(503).send({ msg: "Today's quiz isn't ready yet. Please try again soon." });
  }
  const payload = { ...Daily.publicDay(day), nextResetAt: Daily.nextResetAt() };
  if (req.user) {
    payload.player = req.user.displayName;
    payload.played = await DB.getDailyPlay(req.user.email, today);
    payload.streak = await dailyStreak(req.user, today);
  }
  res.status(200).send(payload);
}));

// Records a signed-in player's result. Each player gets one per day; guests
// keep theirs in the browser instead.
apiRouter.post('/daily/result', optionalAuth, writeLimiter, route(async (req, res) => {
  const today = Daily.dailyDate();
  const date = Daily.isDateKey(req.body.date) ? req.body.date : null;
  const { results } = req.body;
  // Today's quiz, or yesterday's when it was started before midnight and
  // finished within the grace period after it.
  if (date !== today && !Daily.isInGracePeriod(date)) {
    return res.status(400).send({ msg: 'That daily quiz has ended' });
  }
  if (!Daily.isValidResults(results)) {
    return res.status(400).send({ msg: 'Invalid results' });
  }
  if (!req.user) {
    return res.status(200).send({ saved: false });
  }
  const added = await DB.addDailyPlay({
    user: req.user.email,
    date,
    number: Daily.dailyNumber(date),
    results,
    score: Daily.scoreResults(results),
    playedAt: new Date().toISOString(),
  });
  const streak = await dailyStreak(req.user, today);
  if (!added) {
    return res.status(409).send({ msg: "You've already played this daily quiz", played: await DB.getDailyPlay(req.user.email, date), streak });
  }
  res.status(201).send({ saved: true, streak });
}));

// The coming days as the picker would build them today, for admins to check.
// Days already stored are shown as stored.
apiRouter.get('/daily/preview', verifyAuth, verifyAdmin, route(async (req, res) => {
  const count = Math.min(Math.max(parseInt(req.query.days, 10) || 14, 1), 60);
  const today = Daily.dailyDate();
  const quizzes = await DB.getQuizzesForDaily();
  const prepared = Daily.prepare(quizzes);
  const used = await DB.getUsedDailyKeys(today);
  const days = [];
  for (let offset = 0; offset < count; offset++) {
    const date = Daily.addDays(today, offset);
    const stored = await DB.getDaily(date);
    const day = stored || Daily.buildDay(quizzes, date, used, prepared);
    if (!day) {
      break;
    }
    day.questions.forEach((q) => used.add(q.key));
    days.push({ ...day, stored: Boolean(stored) });
  }
  res.status(200).send(days);
}));

// A practice round in the daily quiz's format, as many times as a player
// likes. Nothing is recorded. The player sends the ids of questions they've
// already seen so the round avoids them.
const maxSeenIds = 3000;

apiRouter.post('/practice', writeLimiter, route(async (req, res) => {
  const counts = Daily.practiceCounts(req.body);
  if (!counts) {
    return res.status(400).send({
      msg: `Choose up to ${Daily.practiceLimits.perLevel} questions per difficulty and ${Daily.practiceLimits.total} in all.`,
    });
  }
  const seenIds = Array.isArray(req.body.seen) ? req.body.seen.slice(-maxSeenIds) : [];
  const seen = new Set(seenIds.map((id) => asString(id, 20)).filter(Boolean));

  const round = Daily.buildPracticeRound(await getPreparedPool(), counts, seen);
  if (!round) {
    return res.status(503).send({ msg: "Couldn't put a round together. Try fewer questions." });
  }
  res.status(200).send({ questions: round.map(Daily.publicQuestion) });
}));

// Takes a question out of the daily pool (or puts it back). A day that is
// already stored keeps its questions.
apiRouter.post('/daily/exclude', verifyAuth, verifyAdmin, writeLimiter, route(async (req, res) => {
  const { slug, level, index, question } = req.body;
  const allowed = req.body.allowed === true;
  const ok = await DB.setQuestionDaily(asString(slug, 100), asString(level, 20), index, asString(question, 300), allowed);
  if (!ok) {
    return res.status(404).send({ msg: 'Question not found. The quiz may have been edited; reload and try again.' });
  }
  invalidatePool();
  res.status(200).send({ msg: allowed ? 'Question allowed in the daily quiz' : 'Question excluded from the daily quiz' });
}));

// Sets a question's hand-written wrong answers, or clears them (an empty list)
// so the automatic ones come back. A day already served keeps its choices.
apiRouter.post('/daily/choices', verifyAuth, verifyAdmin, writeLimiter, route(async (req, res) => {
  const { slug, level, index, question } = req.body;
  const notFound = { msg: 'Question not found. The quiz may have been edited; reload and try again.' };
  const validTarget = Number.isInteger(index) && index >= 0 && ['easy', 'medium', 'hard'].includes(level);
  const quiz = validTarget ? await DB.getQuiz(asString(slug, 100)) : null;
  const entry = quiz?.difficulties?.[level]?.[index];
  if (!entry || entry.question !== asString(question, 300)) {
    return res.status(404).send(notFound);
  }
  const clearing = Array.isArray(req.body.choices) && req.body.choices.length === 0;
  const { choices, error } = clearing ? {} : cleanChoices(req.body.choices, entry);
  if (!clearing && !choices) {
    return res.status(400).send({ msg: error || 'Enter three different wrong answers, none of them a correct one.' });
  }
  const saved = await DB.setQuestionChoices(quiz.slug, level, index, entry.question, choices || null);
  if (!saved) {
    return res.status(404).send(notFound);
  }
  invalidatePool();
  res.status(200).send({ choices: choices || null });
}));

// Unknown API routes get a JSON 404 instead of the React app's HTML.
apiRouter.use((_req, res) => {
  res.status(404).send({ msg: 'Not found' });
});

// Any unhandled error becomes a 500 instead of taking the process down. A
// request the body parser refused (malformed JSON, or over the size limit)
// keeps its own 400 or 413, since that's the client's error, not the server's.
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (err?.type && Number.isInteger(err.status) && err.status >= 400 && err.status < 500) {
    return res.status(err.status).send({ msg: err.status === 413 ? 'Request too large' : 'Invalid request' });
  }
  console.log(`Unhandled error: ${err?.message}`);
  res.status(500).send({ msg: 'Something went wrong' });
});

// Every other route serves the React app, which handles its own routing.
app.use((_req, res) => {
  res.sendFile('index.html', { root: 'public' });
});

// Inserts any starter quizzes missing from the database. Existing quizzes are
// never overwritten, so admin edits survive a restart. The existing slugs are
// fetched in one query instead of one lookup per quiz.
async function seedStarterQuizzes() {
  const present = new Set((await DB.getQuizzes()).map((quiz) => quiz.slug));
  const missing = seedQuizzes.filter((quiz) => !present.has(quiz.slug));
  for (const quiz of missing) {
    await DB.addQuiz(quiz);
    console.log(`Seeded quiz: ${quiz.slug}`);
  }
  if (missing.length) {
    console.log(`Seeding complete: ${missing.length} quizzes added`);
  }
}

function start() {
  // A last resort that logs an escaped async error instead of letting it stop the service.
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

// Tests import this module to get the Express app without opening a port or
// seeding. The check looks for the test runner instead of comparing
// import.meta.url with process.argv[1], because pm2 points argv[1] at its own
// wrapper script and that comparison would stop the server from ever starting.
//
// Seeding runs in the background after the port opens. Awaiting it first can
// push app.listen() past the deploy script's health check when many quizzes
// need inserting, which rolls the release back.
if (!process.env.VITEST) {
  start();
  seedStarterQuizzes().catch((err) => {
    console.log(`Seeding failed: ${err?.message}`);
  });
}

// Only used by tests. The limiters keep counters for the life of the process,
// so a suite that shares one app instance clears them between tests.
export function resetRateLimits() {
  authLimiter.reset();
  writeLimiter.reset();
}

// Only used by tests, which swap the database contents between cases.
export function resetDailyCache() {
  cachedDay = null;
  cachedPool = null;
}

export { app };
