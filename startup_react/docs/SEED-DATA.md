# Seed data and demo players

## Quizzes

`service/seedData.js` holds the 183 starter quizzes. The service inserts any
missing slugs at boot and never overwrites an existing quiz, so edits made
through the admin UI survive a restart.

Because boot seeding only inserts, editing a quiz in `seedData.js` does not
reach a database that already has it. `service/syncSeedQuizzes.mjs` applies
those edits:

```bash
node syncSeedQuizzes.mjs              # dry run against dbConfig's database
node syncSeedQuizzes.mjs --write      # apply
node syncSeedQuizzes.mjs --db quiz    # target a different database
```

It touches quiz content only. Scores, users, suggestions, and quizzes created
through the admin UI are left alone.

### Daily quiz flags

The daily quiz (`service/daily.js`) draws five questions a day from every
quiz. Two optional flags on a question control what it may use:

- `followsPrevious: true` marks a question that leans on the one before it
  ("Who was his queen?"). The daily quiz shows that earlier question and its
  answer as a lead-in. A chain deeper than two lead-ins is left out.
- `daily: false` keeps a question out of the daily quiz altogether.

- `choices: [three wrong answers]` replaces the automatic multiple-choice
  options. It also lets in a question the automatic options would leave out.

All three can be set per question in the admin quiz editor, and the admin
page's Upcoming Daily Quizzes list can exclude a question or edit its choices
in one click. The flags live on the quiz documents, so edits to them in
`seedData.js` reach an existing database only through `syncSeedQuizzes.mjs`.
A sync keeps any exclusion or hand-written choices already set on the live
site for a question whose text hasn't changed, so it doesn't undo admin work.

**Deploying the daily quiz for the first time:** run the sync (dry run, then
`--write`) before the new service goes live. Each day is built and stored the
first time anyone opens `/daily`, and a day built before the flags arrive
would keep its unflagged questions. If that happens, delete that day's
document from the `daily` collection before anyone plays it.

## Demo players on the live site

The live leaderboard is seeded with 18 fictional players so the boards, the
per-quiz fastest times, and the Most Played ranking have something to show. The
accounts use a `demo.norhog.com` email domain and password hashes of random
bytes that are discarded, so nobody can sign into them. Their scores are
generated with the same points formula the service uses, so the boards stay
self-consistent.

```bash
node seedDemoPlayers.mjs --db quiz            # preview, writes nothing
node seedDemoPlayers.mjs --db quiz --apply    # write
node seedDemoPlayers.mjs --db quiz --purge    # remove
```

`--db` has no default, so writing to production is always explicit.

## Local development data

`service/seedDevData.mjs` fills a scratch database with players (including an
admin) and play history, using a known password so you can sign in. It refuses
to run unless `dbName` is set to something other than `quiz`.

```bash
cd service && node seedDevData.mjs
```
