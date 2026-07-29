// Fills a LOCAL scratch database with believable users and play history so the
// leaderboard, Most Played and Your Favorites boards have something to show.
//
//   node seedDevData.mjs
//
// Refuses to run unless dbConfig.json sets dbName to something other than the
// production database — this writes fake accounts and scores, and they must
// never reach the live site.
import fs from 'fs';
import bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';
import { MongoClient } from 'mongodb';

const config = JSON.parse(fs.readFileSync(new URL('./dbConfig.json', import.meta.url)));
const dbName = config.dbName || 'quiz';

if (dbName === 'quiz') {
  console.error('\nREFUSING TO RUN: dbName is "quiz", the production database.');
  console.error('Set "dbName": "quiz-dev" in service/dbConfig.json first.\n');
  process.exit(1);
}

const DEMO_PASSWORD = 'demo-password';
const PLAYERS = [
  { displayName: 'RyGuy907', email: 'demo@norhog.dev', admin: true },
  { displayName: 'HistoryHawk', email: 'hawk@norhog.dev' },
  { displayName: 'MarginaliaMax', email: 'max@norhog.dev' },
  { displayName: 'ClioQueen', email: 'clio@norhog.dev' },
  { displayName: 'TriviaTiberius', email: 'tiberius@norhog.dev' },
  { displayName: 'BronzeAgeBen', email: 'ben@norhog.dev' },
  { displayName: 'SaltyScribe', email: 'scribe@norhog.dev' },
  { displayName: 'DustyTome', email: 'tome@norhog.dev' },
];

// How many times each quiz gets played, highest first, so the boards have a
// clear shape rather than everything sitting on one play.
const PLAY_WEIGHTS = [
  ['world-war-ii', 34], ['ancient-egypt', 29], ['roman-empire', 25],
  ['space-race', 21], ['french-revolution', 18], ['vikings', 16],
  ['tudor-england', 13], ['american-revolution', 11], ['cold-war', 9],
  ['ancient-greece', 8], ['napoleon', 7], ['middle-ages', 6],
  ['black-death', 5], ['renaissance', 4], ['imperial-china', 3],
  ['aztec-empire', 2], ['feudal-japan', 2], ['mesopotamia', 1],
];

const DIFFICULTIES = ['easy', 'medium', 'hard'];
const POINTS = { easy: 6, medium: 8, hard: 10 };

// Deterministic PRNG so re-running produces the same fixture rather than drift.
let seed = 20260728;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const between = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));

const client = new MongoClient(
  `mongodb+srv://${config.userName}:${encodeURIComponent(config.password)}@${config.hostname}`
);
const db = client.db(dbName);

console.log(`Seeding demo data into "${dbName}" (production "quiz" is untouched)\n`);

const quizzes = await db.collection('quizzes').find().project({ _id: 0, slug: 1 }).toArray();
const known = new Set(quizzes.map((q) => q.slug));
console.log(`  ${known.size} quizzes present`);

// Start clean so re-running doesn't pile plays on top of the last run.
await db.collection('users').deleteMany({ email: /@norhog\.dev$/ });
await db.collection('scores').deleteMany({ user: /@norhog\.dev$/ });

const hash = await bcrypt.hash(DEMO_PASSWORD, 10);
const users = PLAYERS.map((p) => ({
  email: p.email,
  displayName: p.displayName,
  nameLower: p.displayName.toLowerCase(),
  password: hash,
  token: uuidv4(),
  creationDate: new Date(Date.UTC(2026, between(0, 6), between(1, 27))).toISOString(),
  ...(p.admin ? { role: 'admin' } : {}),
}));
await db.collection('users').insertMany(users);
console.log(`  ${users.length} demo players inserted`);

const scores = [];
for (const [slug, plays] of PLAY_WEIGHTS) {
  if (!known.has(slug)) continue;
  for (let i = 0; i < plays; i += 1) {
    // The first player is weighted toward the top quizzes so their Favorites
    // board has an obvious shape when you log in as them.
    const player = i % 3 === 0 && PLAY_WEIGHTS.findIndex(([s]) => s === slug) < 5
      ? users[0]
      : pick(users);
    const difficulty = pick(DIFFICULTIES);
    const total = 10;
    const score = between(4, 10);
    scores.push({
      user: player.email,
      name: player.displayName,
      quiz: slug,
      difficulty,
      score,
      total,
      points: Math.round((score / total) * POINTS[difficulty]),
      timeSpent: between(35, 170),
      date: new Date(Date.UTC(2026, 6, between(1, 28), between(0, 23))).toISOString(),
    });
  }
}
await db.collection('scores').insertMany(scores);
console.log(`  ${scores.length} scores inserted across ${new Set(scores.map((s) => s.quiz)).size} quizzes\n`);

const totals = await db.collection('scores').aggregate([
  { $group: { _id: { user: '$user', quiz: '$quiz' }, points: { $max: '$points' }, name: { $last: '$name' } } },
  { $group: { _id: '$_id.user', points: { $sum: '$points' }, quizzes: { $sum: 1 }, name: { $last: '$name' } } },
  { $sort: { points: -1 } },
]).toArray();
console.log('Leaderboard preview:');
for (const t of totals) console.log(`  ${String(t.points).padStart(4)} pts  ${t.quizzes} quizzes  ${t.name}`);

console.log(`\nLog in at http://localhost:5173/profile`);
console.log(`  email:    ${PLAYERS[0].email}`);
console.log(`  password: ${DEMO_PASSWORD}`);

await client.close();
