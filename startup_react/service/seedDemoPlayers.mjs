// Seeds fictional demo players and play history so the leaderboard, the
// per-quiz fastest-times boards and the Most Played ranking have something to
// show. This is display content in the same spirit as the seeded quizzes — it
// is documented in the README, and the accounts cannot be logged into.
//
//   node seedDemoPlayers.mjs --db quiz            # dry run, prints a preview
//   node seedDemoPlayers.mjs --db quiz --apply    # writes
//   node seedDemoPlayers.mjs --db quiz --purge    # removes demo data only
//
// --db is required and never defaults, so writing to production is always a
// deliberate act. Re-running replaces the demo set rather than stacking on it.
import fs from 'fs';
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';
import { MongoClient } from 'mongodb';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? null : argv[i + 1];
};

const DB_NAME = value('--db');
const APPLY = flag('--apply');
const PURGE = flag('--purge');

if (!DB_NAME) {
  console.error('\nUsage: node seedDemoPlayers.mjs --db <database> [--apply|--purge]');
  console.error('--db is required so that writing to production is never accidental.\n');
  process.exit(1);
}

// Every demo account lives under this domain, which is what makes the data
// removable in one query and obviously non-real on inspection.
const DEMO_DOMAIN = 'demo.norhog.com';

// Deliberately playful and clearly fictional — these should never read as real
// people whose activity is being fabricated.
const NAMES = [
  'HistoryHawk', 'ClioQueen', 'MarginaliaMax', 'TriviaTiberius', 'BronzeAgeBen',
  'SaltyScribe', 'DustyTome', 'InkwellIvy', 'VellumVic', 'AbacusAnnie',
  'ScrollSeeker', 'CodexCarl', 'RelicRhea', 'ObeliskOtto', 'PapyrusPip',
  'LanternLou', 'QuillQuinn', 'ArchiveAda',
];

const DIFFICULTIES = ['easy', 'medium', 'hard'];
const POINTS = { easy: 6, medium: 8, hard: 10 };
const LIMITS = { easy: 120, medium: 180, hard: 240 };
// Seconds a person plausibly spends per question at each difficulty.
const PACE = { easy: 6.5, medium: 9, hard: 12 };

// Deterministic PRNG: re-running produces the same fixture instead of drifting,
// and a preview matches what --apply will write.
let seed = 970729;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const between = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
const jitter = (lo, hi) => lo + rnd() * (hi - lo);

const config = JSON.parse(fs.readFileSync(new URL('./dbConfig.json', import.meta.url)));
const client = new MongoClient(
  `mongodb+srv://${config.userName}:${encodeURIComponent(config.password)}@${config.hostname}`
);
const db = client.db(DB_NAME);
const demoEmail = new RegExp(`@${DEMO_DOMAIN.replace(/\./g, '\\.')}$`);

if (PURGE) {
  const u = await db.collection('users').deleteMany({ email: demoEmail });
  const s = await db.collection('scores').deleteMany({ user: demoEmail });
  console.log(`purged from "${DB_NAME}": ${u.deletedCount} demo users, ${s.deletedCount} demo scores`);
  await client.close();
  process.exit(0);
}

const quizzes = await db.collection('quizzes').find().project({ _id: 0, slug: 1, title: 1 }).toArray();
if (!quizzes.length) {
  console.error(`No quizzes in "${DB_NAME}" — start the service once so they seed, then re-run.`);
  await client.close();
  process.exit(1);
}

// Each player gets a stable skill and pace so the fastest-times boards look like
// the same few people are consistently quick, rather than noise.
const players = NAMES.map((displayName, i) => ({
  email: `${displayName.toLowerCase()}@${DEMO_DOMAIN}`,
  displayName,
  nameLower: displayName.toLowerCase(),
  skill: jitter(0.5, 0.93),
  pace: jitter(0.6, 1.25),
  // A few enthusiasts, a long tail of casual players.
  weight: i < 4 ? jitter(2.2, 3.2) : i < 10 ? jitter(1.0, 1.8) : jitter(0.3, 0.9),
  joinedDaysAgo: between(20, 82),
}));

const weightTotal = players.reduce((a, p) => a + p.weight, 0);
const pickPlayer = () => {
  let r = rnd() * weightTotal;
  for (const p of players) {
    r -= p.weight;
    if (r <= 0) return p;
  }
  return players[players.length - 1];
};

// Which quizzes draw the most plays, most popular first. Chosen by hand rather
// than at random: a real audience gravitates toward the famous topics, so a
// Most Played board topped by the Silk Road and Victorian Britain would look
// generated. Anything not listed still gets a baseline of plays.
const POPULAR_ORDER = [
  'world-war-2', 'ancient-egypt', 'roman-empire', 'world-war-1', 'vikings',
  'ancient-greece', 'cold-war', 'french-revolution', 'space-race', 'civil-war',
  'middle-ages', 'black-death', 'napoleon', 'american-revolution',
];
const popularRank = new Map(
  POPULAR_ORDER.filter((slug) => quizzes.some((q) => q.slug === slug)).map((slug, i) => [slug, i])
);

const NOW = Date.UTC(2026, 6, 29);
const DAY = 86400000;

// score out of 10, from the player's skill adjusted for difficulty.
const rollScore = (player, difficulty) => {
  const p = difficulty === 'easy' ? Math.min(0.97, player.skill + 0.12)
    : difficulty === 'hard' ? Math.max(0.18, player.skill - 0.16)
      : player.skill;
  let correct = 0;
  for (let i = 0; i < 10; i += 1) if (rnd() < p) correct += 1;
  return correct;
};

// Time is driven by the player's pace, with people who know the material
// finishing a little quicker. Always inside the difficulty's limit.
const rollTime = (player, difficulty, score) => {
  const base = PACE[difficulty] * 10 * player.pace;
  const knowledgeBonus = 1 - (score / 10) * 0.18;
  const t = Math.round(base * knowledgeBonus * jitter(0.82, 1.24));
  return Math.max(12, Math.min(LIMITS[difficulty], t));
};

const makeScore = (player, slug, difficulty, forcePerfect = false) => {
  const score = forcePerfect ? 10 : rollScore(player, difficulty);
  const timeSpent = rollTime(player, difficulty, score);
  const daysAgo = Math.min(player.joinedDaysAgo, between(0, 60));
  return {
    user: player.email,
    name: player.displayName,
    quiz: slug,
    difficulty,
    score,
    total: 10,
    // Exactly the formula the service uses, so the boards stay self-consistent.
    points: Math.round((score / 10) * POINTS[difficulty]),
    timeSpent,
    date: new Date(NOW - daysAgo * DAY - between(0, 82800) * 1000).toISOString(),
  };
};

const scores = [];
for (const quiz of quizzes) {
  const rank = popularRank.get(quiz.slug);
  const extra = rank === undefined ? 0 : Math.round((14 - rank) * jitter(1.4, 2.6));
  const plays = between(2, 5) + extra;

  for (let i = 0; i < plays; i += 1) {
    // Easy gets tried most; hard is the minority, as with real players.
    const r = rnd();
    const difficulty = r < 0.46 ? 'easy' : r < 0.79 ? 'medium' : 'hard';
    scores.push(makeScore(pickPlayer(), quiz.slug, difficulty));
  }

  // The per-quiz boards only rank perfect runs, so guarantee a few or most quiz
  // pages would read "No perfect runs yet". Strong players get them.
  const strong = players.filter((p) => p.skill > 0.72);
  const guaranteed = rank === undefined ? ['easy'] : DIFFICULTIES;
  for (const difficulty of guaranteed) {
    const n = rank === undefined ? between(1, 2) : between(2, 4);
    for (let i = 0; i < n; i += 1) {
      scores.push(makeScore(pick(strong), quiz.slug, difficulty, true));
    }
  }
}

// ---- preview -------------------------------------------------------------

const bestPerUserQuiz = new Map();
for (const s of scores) {
  const k = `${s.user}|${s.quiz}`;
  bestPerUserQuiz.set(k, Math.max(bestPerUserQuiz.get(k) || 0, s.points));
}
const totals = new Map();
for (const [k, pts] of bestPerUserQuiz) {
  const email = k.split('|')[0];
  const t = totals.get(email) || { points: 0, quizzes: 0 };
  t.points += pts;
  t.quizzes += 1;
  totals.set(email, t);
}
const board = [...totals.entries()]
  .map(([email, t]) => ({ name: players.find((p) => p.email === email).displayName, ...t }))
  .sort((a, b) => b.points - a.points);

const playsPerQuiz = new Map();
for (const s of scores) playsPerQuiz.set(s.quiz, (playsPerQuiz.get(s.quiz) || 0) + 1);
const top = [...playsPerQuiz.entries()].sort((a, b) => b[1] - a[1]);
const perfectByQuiz = new Set(scores.filter((s) => s.score === 10).map((s) => s.quiz));

console.log(`\nTarget database: "${DB_NAME}"   ${APPLY ? '*** APPLYING ***' : '(dry run)'}\n`);
console.log(`players: ${players.length}`);
console.log(`scores:  ${scores.length} across ${playsPerQuiz.size}/${quizzes.length} quizzes`);
console.log(`quizzes with at least one perfect run: ${perfectByQuiz.size}/${quizzes.length}`);
console.log(`\nLeaderboard (top 10 of ${board.length}):`);
board.slice(0, 10).forEach((r, i) =>
  console.log(`  ${String(i + 1).padStart(2)}. ${String(r.points).padStart(3)} pts  ${String(r.quizzes).padStart(2)} quizzes  ${r.name}`)
);
console.log(`\nMost Played (top 8):`);
top.slice(0, 8).forEach(([slug, n]) =>
  console.log(`  ${String(n).padStart(3)} plays  ${quizzes.find((q) => q.slug === slug).title}`)
);
const times = scores.map((s) => s.timeSpent);
console.log(`\nSanity: times ${Math.min(...times)}–${Math.max(...times)}s, ` +
  `mean score ${(scores.reduce((a, s) => a + s.score, 0) / scores.length).toFixed(1)}/10, ` +
  `plays per quiz ${Math.min(...playsPerQuiz.values())}–${Math.max(...playsPerQuiz.values())}`);

if (!APPLY) {
  console.log('\nNothing written. Re-run with --apply to commit this.\n');
  await client.close();
  process.exit(0);
}

// ---- write ---------------------------------------------------------------

await db.collection('users').deleteMany({ email: demoEmail });
await db.collection('scores').deleteMany({ user: demoEmail });

const userDocs = await Promise.all(players.map(async (p) => ({
  email: p.email,
  displayName: p.displayName,
  nameLower: p.nameLower,
  // Hash of bytes that are generated here and never printed or stored, so these
  // accounts exist for display and cannot be signed into by anyone.
  password: await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10),
  token: uuidv4(),
  creationDate: new Date(NOW - p.joinedDaysAgo * DAY).toISOString(),
})));

await db.collection('users').insertMany(userDocs);
await db.collection('scores').insertMany(scores);
console.log(`\nwrote ${userDocs.length} demo players and ${scores.length} scores to "${DB_NAME}"\n`);

await client.close();
