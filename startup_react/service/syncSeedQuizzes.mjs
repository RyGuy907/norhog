// Pushes the current seedData.js content into quizzes that already exist in
// the database. Startup seeding only inserts missing slugs, so edits to a
// seeded quiz never reach a database that already has it. This script is how
// those edits get applied.
//
//   node syncSeedQuizzes.mjs                  # dry run against dbConfig's database
//   node syncSeedQuizzes.mjs --write          # apply the changes
//   node syncSeedQuizzes.mjs --db quiz        # target a database other than dbConfig's
//
// The --db flag lets production be updated from a checkout whose dbConfig.json
// points at a scratch database, without editing that file and possibly leaving
// it pointed at production.
//
// Only quiz content is changed (title, image, imagePosition, imageCaption,
// description, instructions, timeLimits, and difficulties). Scores, users,
// suggestions, and quizzes created in the admin UI are left alone.
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
    && (existing.imagePosition || '') === (quiz.imagePosition || '')
    && (existing.imageCaption || '') === (quiz.imageCaption || '')
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
        imagePosition: quiz.imagePosition || '',
        imageCaption: quiz.imageCaption || '',
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
