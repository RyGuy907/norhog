// One-time sync: pushes the current seedData.js content into the quizzes
// collection for quizzes that ALREADY exist there. Startup seeding only ever
// inserts missing slugs, so content changes to seeded quizzes (like the move to
// 20 questions per difficulty) never reach a database that has them already —
// this script is the deliberate way to apply them.
//
//   node syncSeedQuizzes.mjs                  # dry run against dbConfig's database
//   node syncSeedQuizzes.mjs --write          # apply the changes
//   node syncSeedQuizzes.mjs --db quiz        # target a database other than dbConfig's
//
// The --db override exists so the production database can be updated from a
// checkout whose dbConfig.json deliberately points at a scratch database,
// without editing that file and risking it being left pointing at production.
//
// Only quiz content is touched (title, image, description, instructions,
// timeLimits, difficulties). Scores, users, suggestions, and quizzes created
// through the admin UI (slugs not in seedData.js) are left alone.
import fs from 'fs';
import { MongoClient } from 'mongodb';
import { seedQuizzes } from './seedData.js';

const write = process.argv.includes('--write');
const config = JSON.parse(fs.readFileSync(new URL('./dbConfig.json', import.meta.url)));
const url = `mongodb+srv://${config.userName}:${encodeURIComponent(config.password)}@${config.hostname}`;
const client = new MongoClient(url);
const dbFlag = process.argv.indexOf('--db');
const dbName = dbFlag !== -1 ? process.argv[dbFlag + 1] : (config.dbName || 'quiz');
if (dbFlag !== -1 && !dbName) {
  console.error('--db needs a database name');
  process.exit(1);
}
const db = client.db(dbName);
const quizCollection = db.collection('quizzes');

let updated = 0;
let inserted = 0;
let unchanged = 0;
for (const quiz of seedQuizzes) {
  const existing = await quizCollection.findOne({ slug: quiz.slug });
  if (!existing) {
    if (write) await quizCollection.insertOne(quiz);
    inserted += 1;
    console.log(`insert   ${quiz.slug}`);
    continue;
  }
  const counts = ['easy', 'medium', 'hard']
    .map((level) => `${existing.difficulties?.[level]?.length ?? 0}->${quiz.difficulties[level].length}`)
    .join(' ');
  const same = ['easy', 'medium', 'hard'].every(
    (level) => JSON.stringify(existing.difficulties?.[level]) === JSON.stringify(quiz.difficulties[level])
  ) && JSON.stringify(existing.timeLimits) === JSON.stringify(quiz.timeLimits)
    && existing.title === quiz.title
    && existing.image === quiz.image
    && existing.description === quiz.description
    && existing.instructions === quiz.instructions;
  if (same) {
    unchanged += 1;
    continue;
  }
  if (write) {
    await quizCollection.updateOne(
      { slug: quiz.slug },
      { $set: {
        title: quiz.title,
        image: quiz.image,
        description: quiz.description,
        instructions: quiz.instructions,
        timeLimits: quiz.timeLimits,
        difficulties: quiz.difficulties,
      } }
    );
  }
  updated += 1;
  console.log(`update   ${quiz.slug} (${counts})`);
}

console.log(`\n${write ? 'Applied' : 'Dry run'}: ${inserted} inserted, ${updated} updated, ${unchanged} unchanged (db: ${dbName} @ ${config.hostname})`);
if (!write) console.log('Re-run with --write to apply.');
await client.close();
