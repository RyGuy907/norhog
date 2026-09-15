// Seeds fictional demo players and play history so the leaderboard, the
// per-quiz fastest-times boards, and the Most Played ranking have something to
// show. Like the seeded quizzes, this is display content. It is documented in
// the README, and nobody can log into the accounts.
//
//   node seedDemoPlayers.mjs --db quiz            # dry run, prints a preview
//   node seedDemoPlayers.mjs --db quiz --apply    # writes
//   node seedDemoPlayers.mjs --db quiz --purge    # removes demo data only
//
// --db has no default, so writing to production always has to be spelled out.
// Re-running replaces the demo set instead of adding to it.
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

// Every demo account uses this email domain, so the data can be removed in one
// query and is clearly fake when inspected.
const DEMO_DOMAIN = 'demo.norhog.com';

// Playful names that are clearly fictional, so none of them read as real people.
const NAMES = [
  'HistoryHawk', 'ClioQueen', 'MarginaliaMax', 'TriviaTiberius', 'BronzeAgeBen',
  'SaltyScribe', 'DustyTome', 'InkwellIvy', 'VellumVic', 'AbacusAnnie',
  'ScrollSeeker', 'CodexCarl', 'RelicRhea', 'ObeliskOtto', 'PapyrusPip',
  'LanternLou', 'QuillQuinn', 'ArchiveAda',
];

const DIFFICULTIES = ['easy', 'medium', 'hard'];
const POINTS = { easy: 6, medium: 8, hard: 10 };
const LIMITS = { easy: 300, medium: 480, hard: 600 };
// Seconds a person might spend per question at each difficulty. These sit well
// inside the time limits, since a board where every run finished near the
// buzzer would look generated.
const PACE = { easy: 11, medium: 16, hard: 22 };

// A seeded random generator, so re-running produces the same data and the dry
// run matches what --apply writes.
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
  console.error(`No quizzes in "${DB_NAME}". Start the service once so they seed, then re-run.`);
  await client.close();
  process.exit(1);
}

// Each player gets a fixed skill and pace, so the same few people show up as
// consistently quick on the fastest-times boards instead of random noise.
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

// The quizzes that get the most plays, most popular first. These are chosen by
// hand because real players tend toward the famous topics, and a Most Played
// board topped by the Silk Road would look generated. Quizzes not listed still
// get a baseline number of plays.
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

// Score out of 10, from the player's skill adjusted for difficulty.
const rollScore = (player, difficulty) => {
  const p = difficulty === 'easy' ? Math.min(0.97, player.skill + 0.12)
    : difficulty === 'hard' ? Math.max(0.18, player.skill - 0.16)
      : player.skill;
  let correct = 0;
  for (let i = 0; i < 10; i += 1) if (rnd() < p) correct += 1;
  return correct;
};

// Time comes from the player's pace, and players who know the material finish a
// little quicker. It always stays inside the difficulty's limit.
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
    // The same formula the service uses, so the boards stay consistent.
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
    // Easy gets played most and hard the least, which is how real players tend to pick.
    const r = rnd();
    const difficulty = r < 0.46 ? 'easy' : r < 0.79 ? 'medium' : 'hard';
    scores.push(makeScore(pickPlayer(), quiz.slug, difficulty));
  }

  // The per-quiz boards only rank perfect runs, so each quiz gets a few from the
  // stronger players. Otherwise most quiz pages would say "No perfect runs yet".
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

// Display names are unique regardless of case, and the purge above only clears
// this script's own accounts. If another account (a real signup or the
// seedDevData fixture) already holds a name, stop with a readable message
// instead of a bulk-write error.
const taken = await db
  .collection('users')
  .find({ nameLower: { $in: players.map((p) => p.nameLower) } })
  .project({ _id: 0, email: 1, displayName: 1 })
  .toArray();

if (taken.length) {
  console.error(`\nAborted: ${taken.length} display name(s) are already in use by other accounts:`);
  for (const t of taken) console.error(`  ${t.displayName}  (${t.email})`);
  console.error('\nRemove or rename those accounts, or edit NAMES in this script.\n');
  await client.close();
  process.exit(1);
}

const userDocs = await Promise.all(players.map(async (p) => ({
  email: p.email,
  displayName: p.displayName,
  nameLower: p.nameLower,
  // A hash of random bytes that are never printed or stored, so nobody can sign
  // into these accounts.
  password: await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10),
  token: uuidv4(),
  creationDate: new Date(NOW - p.joinedDaysAgo * DAY).toISOString(),
})));

await db.collection('users').insertMany(userDocs);
await db.collection('scores').insertMany(scores);
console.log(`\nwrote ${userDocs.length} demo players and ${scores.length} scores to "${DB_NAME}"\n`);

await client.close();
