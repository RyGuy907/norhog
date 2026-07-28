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
const db = client.db('quiz');
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
    .project({ _id: 0, slug: 1, title: 1, image: 1, description: 1 })
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
