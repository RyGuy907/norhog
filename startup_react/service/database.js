import { MongoClient, ObjectId } from 'mongodb';
import fs from 'fs';

let config;
try {
  config = JSON.parse(fs.readFileSync(new URL('./dbConfig.json', import.meta.url)));
} catch {
  console.log('Missing or invalid dbConfig.json. Copy dbConfig.example.json and fill in your MongoDB Atlas credentials.');
  process.exit(1);
}

const url = `mongodb+srv://${config.userName}:${encodeURIComponent(config.password)}@${config.hostname}`;
const client = new MongoClient(url);
// Defaults to the production database. Set dbName in dbConfig.json to point a
// local checkout at a scratch database instead — otherwise `npm start` on a
// laptop reads and writes the same records the live site is serving.
const db = client.db(config.dbName || 'quiz');
const userCollection = db.collection('users');
const scoreCollection = db.collection('scores');
const quizCollection = db.collection('quizzes');
const suggestionCollection = db.collection('suggestions');

// Verify the connection at startup so a bad config fails fast, and enforce
// uniqueness at the storage layer (the check-then-insert in the register
// handler is not atomic on its own).
(async function testConnection() {
  try {
    await db.command({ ping: 1 });
    console.log('Connected to MongoDB Atlas');
    await userCollection.createIndex({ email: 1 }, { unique: true });
    await userCollection.createIndex({ nameLower: 1 }, { unique: true });
    await userCollection.createIndex({ token: 1 });
    await scoreCollection.createIndex({ user: 1, quiz: 1, difficulty: 1 });
    await quizCollection.createIndex({ slug: 1 }, { unique: true });
  } catch (ex) {
    console.log(`Unable to connect to database with ${config.hostname} because ${ex.message}`);
    process.exit(1);
  }
})();

// Every lookup takes a string. Objects (e.g. {$gt: ''} smuggled through a
// request body, query string, or cookie) would be interpreted by MongoDB as
// query operators, so they are rejected here as a last line of defense.
const asKey = (value) => (typeof value === 'string' && value !== '' ? value : null);

export function getUser(email) {
  const key = asKey(email);
  return key ? userCollection.findOne({ email: key }) : Promise.resolve(null);
}

// Display names are unique case-insensitively (nameLower is the key).
export function getUserByName(nameLower) {
  const key = asKey(nameLower);
  return key ? userCollection.findOne({ nameLower: key }) : Promise.resolve(null);
}

export function getUserByToken(token) {
  // Must be a non-empty string: missing tokens would match logged-out users
  // (token: null), and objects would be treated as query operators.
  const key = asKey(token);
  return key ? userCollection.findOne({ token: key }) : Promise.resolve(null);
}

export async function addUser(user) {
  await userCollection.insertOne(user);
}

export async function updateUser(user) {
  await userCollection.updateOne({ email: user.email }, { $set: { token: user.token } });
}

// Account deletion removes the user and everything they created.
export async function deleteUser(email) {
  if (!asKey(email)) return;
  await scoreCollection.deleteMany({ user: email });
  await suggestionCollection.deleteMany({ suggestedBy: email });
  await userCollection.deleteOne({ email });
}

export async function addScore(score) {
  await scoreCollection.insertOne(score);
}

// Fastest-times board for one quiz + difficulty: only perfect (full-score)
// runs count, ranked by each user's quickest. Public display names only —
// emails never leave the server.
export function getQuizTimes(quiz, difficulty, limit = 10) {
  if (!asKey(quiz) || !asKey(difficulty)) {
    return Promise.resolve([]);
  }
  return scoreCollection
    .aggregate([
      { $match: { quiz, difficulty, $expr: { $eq: ['$score', '$total'] } } },
      { $group: { _id: '$user', timeSpent: { $min: '$timeSpent' }, name: { $last: '$name' } } },
      { $sort: { timeSpent: 1 } },
      { $limit: limit },
      { $project: { _id: 0, name: 1, timeSpent: 1 } },
    ])
    .toArray();
}

// Total points per user: sum of each quiz's best points. Display names only.
export function getUserTotals(limit = 10) {
  return scoreCollection
    .aggregate([
      {
        $group: {
          _id: { user: '$user', quiz: '$quiz' },
          points: { $max: '$points' },
          name: { $last: '$name' },
        },
      },
      {
        $group: {
          _id: '$_id.user',
          points: { $sum: '$points' },
          quizzes: { $sum: 1 },
          name: { $last: '$name' },
        },
      },
      { $sort: { points: -1 } },
      { $limit: limit },
      { $project: { _id: 0, name: 1, points: 1, quizzes: 1 } },
    ])
    .toArray();
}

// One user's best points on a quiz across all difficulties (0 if unplayed).
export async function getQuizBestPoints(user, quiz) {
  if (!asKey(user) || !asKey(quiz)) return 0;
  const best = await scoreCollection.findOne(
    { user, quiz },
    { sort: { points: -1 }, projection: { _id: 0, points: 1 } }
  );
  return best ? best.points : 0;
}

// One user's best attempt for a quiz + difficulty (highest score, then fastest).
export function getUserBest(user, quiz, difficulty) {
  if (!asKey(user) || !asKey(quiz) || !asKey(difficulty)) return Promise.resolve(null);
  return scoreCollection.findOne(
    { user, quiz, difficulty },
    { sort: { score: -1, timeSpent: 1 }, projection: { _id: 0, score: 1, total: 1, points: 1 } }
  );
}

// One user's fastest perfect (full-score) run for a quiz + difficulty.
export async function getUserBestTime(user, quiz, difficulty) {
  if (!asKey(user) || !asKey(quiz) || !asKey(difficulty)) return null;
  const best = await scoreCollection.findOne(
    { user, quiz, difficulty, $expr: { $eq: ['$score', '$total'] } },
    { sort: { timeSpent: 1 }, projection: { _id: 0, timeSpent: 1 } }
  );
  return best ? best.timeSpent : null;
}

// One user's best points on every quiz they have played, plus how many
// difficulties they have a perfect run on (for completed/starred tiles).
export function getUserScores(user) {
  if (!asKey(user)) return Promise.resolve([]);
  return scoreCollection
    .aggregate([
      { $match: { user } },
      {
        $group: {
          _id: { quiz: '$quiz', difficulty: '$difficulty' },
          points: { $max: '$points' },
          perfect: { $max: { $cond: [{ $eq: ['$score', '$total'] }, 1, 0] } },
        },
      },
      {
        $group: {
          _id: '$_id.quiz',
          points: { $max: '$points' },
          perfectCount: { $sum: '$perfect' },
        },
      },
      { $project: { _id: 0, quiz: '$_id', points: 1, perfectCount: 1 } },
      { $sort: { quiz: 1 } },
    ])
    .toArray();
}

// Rank quizzes by play count and attach the fields a tile needs. Shared by the
// site-wide board and the per-user one so the two can't drift apart.
const playCountPipeline = (limit) => [
  { $group: { _id: '$quiz', plays: { $sum: 1 } } },
  { $sort: { plays: -1, _id: 1 } },
  { $limit: limit },
  {
    $lookup: {
      from: 'quizzes',
      localField: '_id',
      foreignField: 'slug',
      as: 'quiz',
    },
  },
  // Scores are deleted with their quiz, so an empty lookup should not happen —
  // but drop it rather than render a card with no title if it ever does.
  { $match: { 'quiz.0': { $exists: true } } },
  {
    $project: {
      _id: 0,
      slug: '$_id',
      plays: 1,
      title: { $arrayElemAt: ['$quiz.title', 0] },
      image: { $arrayElemAt: ['$quiz.image', 0] },
    },
  },
];

// Most-played quizzes across everyone, for the leaderboard's sidebar. One score
// document is written per finished run, so this counts plays rather than
// distinct players — and only signed-in runs are recorded, guests play unscored.
export function getPopularQuizzes(limit = 5) {
  return scoreCollection.aggregate(playCountPipeline(limit)).toArray();
}

// The same board scoped to one player: the quizzes they come back to most.
export function getUserFavoriteQuizzes(user, limit = 4) {
  const key = asKey(user);
  if (!key) return Promise.resolve([]);
  return scoreCollection.aggregate([{ $match: { user: key } }, ...playCountPipeline(limit)]).toArray();
}

export function deleteScoresForQuiz(quiz) {
  const key = asKey(quiz);
  if (!key) return Promise.resolve(null);
  return scoreCollection.deleteMany({ quiz: key });
}

export function getSuggestions() {
  return suggestionCollection.find().sort({ date: 1 }).toArray();
}

export async function addSuggestion(suggestion) {
  await suggestionCollection.insertOne(suggestion);
}

export function getSuggestion(id) {
  return suggestionCollection.findOne({ _id: new ObjectId(id) });
}

export async function deleteSuggestion(id) {
  await suggestionCollection.deleteOne({ _id: new ObjectId(id) });
}

export function getQuizzes() {
  return quizCollection
    .find()
    // imagePosition rides along because the menu cards crop to 3:2 and need the
    // focal point to place that crop; without it every tile falls back to the
    // generic top/centre crop and subjects get cut out of frame.
    .project({ _id: 0, slug: 1, title: 1, image: 1, imagePosition: 1, description: 1 })
    .sort({ title: 1 })
    .toArray();
}

export function getQuiz(slug) {
  const key = asKey(slug);
  return key ? quizCollection.findOne({ slug: key }, { projection: { _id: 0 } }) : Promise.resolve(null);
}

export async function addQuiz(quiz) {
  await quizCollection.insertOne(quiz);
}

export async function updateQuiz(slug, quiz) {
  await quizCollection.replaceOne({ slug }, quiz);
}

export async function deleteQuiz(slug) {
  await quizCollection.deleteOne({ slug });
}
