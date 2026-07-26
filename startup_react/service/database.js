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

// Verify the connection at startup so a bad config fails fast.
(async function testConnection() {
  try {
    await db.command({ ping: 1 });
    console.log('Connected to MongoDB Atlas');
  } catch (ex) {
    console.log(`Unable to connect to database with ${config.hostname} because ${ex.message}`);
    process.exit(1);
  }
})();

export function getUser(email) {
  return userCollection.findOne({ email });
}

export function getUserByToken(token) {
  // Guard against missing tokens matching logged-out users (token: null).
  if (!token) {
    return Promise.resolve(null);
  }
  return userCollection.findOne({ token });
}

export async function addUser(user) {
  await userCollection.insertOne(user);
}

export async function updateUser(user) {
  await userCollection.updateOne({ email: user.email }, { $set: { token: user.token } });
}

export async function addScore(score) {
  await scoreCollection.insertOne(score);
}

// Fastest-times board for one quiz + difficulty: only perfect (full-score)
// runs count, ranked by each user's quickest.
export function getQuizTimes(quiz, difficulty, limit = 10) {
  return scoreCollection
    .aggregate([
      { $match: { quiz, difficulty, $expr: { $eq: ['$score', '$total'] } } },
      { $group: { _id: '$user', timeSpent: { $min: '$timeSpent' } } },
      { $sort: { timeSpent: 1 } },
      { $limit: limit },
      { $project: { _id: 0, user: '$_id', timeSpent: 1 } },
    ])
    .toArray();
}

// Total points per user: sum of each quiz's best points.
export function getUserTotals(limit = 10) {
  return scoreCollection
    .aggregate([
      { $group: { _id: { user: '$user', quiz: '$quiz' }, points: { $max: '$points' } } },
      { $group: { _id: '$_id.user', points: { $sum: '$points' }, quizzes: { $sum: 1 } } },
      { $sort: { points: -1 } },
      { $limit: limit },
      { $project: { _id: 0, user: '$_id', points: 1, quizzes: 1 } },
    ])
    .toArray();
}

// One user's best points on a quiz across all difficulties (0 if unplayed).
export async function getQuizBestPoints(user, quiz) {
  const best = await scoreCollection.findOne(
    { user, quiz },
    { sort: { points: -1 }, projection: { _id: 0, points: 1 } }
  );
  return best ? best.points : 0;
}

// One user's best attempt for a quiz + difficulty (highest score, then fastest).
export function getUserBest(user, quiz, difficulty) {
  return scoreCollection.findOne(
    { user, quiz, difficulty },
    { sort: { score: -1, timeSpent: 1 }, projection: { _id: 0, score: 1, total: 1, points: 1 } }
  );
}

// One user's best points on every quiz they have played, plus how many
// difficulties they have a perfect run on (for completed/starred tiles).
export function getUserScores(user) {
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
  return scoreCollection.deleteMany({ quiz });
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
  return quizCollection.findOne({ slug }, { projection: { _id: 0 } });
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
