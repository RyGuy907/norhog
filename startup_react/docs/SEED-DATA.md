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
