# Norhog — History Quiz App

Norhog is a full-stack quiz web application where users race the clock to answer
history questions, then compete for spots on a live leaderboard.

**Live demo:** [norhog.com](https://norhog.com)

> **A note on the data.** The live site ships with seeded content so the features
> are visible rather than empty: 60 starter quizzes, and 18 fictional players
> with generated play history behind the leaderboard, the per-quiz fastest-times
> boards and the Most Played ranking. Those accounts are display data, not real
> users — they have unusable password hashes and cannot be signed into. Scores
> and times are generated to be self-consistent with the app's own scoring rules.
> `service/seedDemoPlayers.mjs` creates them and `--purge` removes them.

## Features

- **Timed quizzes** — three difficulty levels (easy/medium/hard) of fill-in-the-blank
  history questions, each with its own time limit (5/8/10 minutes by default); type a
  correct answer and it's revealed instantly.
- **Admin quiz builder** — quizzes live in the database, not the code. Admins get a
  quiz manager UI to create, edit, and delete quizzes: title, description, image,
  time limit, and any number of questions per difficulty.
- **S3 image uploads** — quiz images upload straight from the browser to an S3 bucket
  via presigned URLs issued by the service (admin-only); the service never handles
  image bytes and no AWS credentials reach the client.
- **Secure user accounts** — registration and login with bcrypt-hashed passwords and
  httpOnly session cookies, plus role-based authorization for admin features. Anyone
  can play; logging in lets you post scores.
- **Real-time leaderboard** — when anyone submits a score, every open leaderboard page
  updates instantly over WebSockets, filterable per quiz. No refresh needed.
- **Persistent data** — users, quizzes, and scores are stored in MongoDB Atlas.

## Architecture

```
React (Vite) SPA  ──HTTP──>  Express REST API  ──>  MongoDB Atlas
      │                            │                 (users, scores)
      └────────WebSocket───────────┘
        (server pushes leaderboard updates)
```

- **Frontend:** React 18 + React Router + Bootstrap, bundled with Vite ([src/](src/))
- **Backend:** Node.js + Express ([service/](service/))
  - `index.js` — REST endpoints (auth, quizzes, scores), static hosting of the built frontend
  - `database.js` — MongoDB Atlas data access (users, quizzes, scores)
  - `scoreBroadcaster.js` — WebSocket server that pushes leaderboard updates
  - `imageStore.js` — S3 presigned upload URLs for quiz images
  - `seedData.js` — the starter quiz, inserted automatically on first run
- **Auth:** uuid session token in an `httpOnly`/`secure`/`sameSite=strict` cookie;
  passwords hashed with bcrypt. Score submissions are authorized server-side from the
  cookie — the client never says who it is. Quiz management requires the `admin` role.

### API

| Method | Endpoint              | Auth  | Purpose |
|--------|-----------------------|-------|---------|
| POST   | `/api/auth/create`    | —     | Register (validates email + 8-char min password) |
| POST   | `/api/auth/login`     | —     | Login, rotates session token |
| POST   | `/api/auth/logout`    | —     | Clears session |
| GET    | `/api/auth/me`        | ✅    | Restore session from cookie |
| GET    | `/api/quizzes`        | —     | List quizzes (slug, title, image, description) |
| GET    | `/api/quiz/:slug`     | —     | Full quiz with questions |
| POST   | `/api/quiz`           | admin | Create a quiz (validated) |
| PUT    | `/api/quiz/:slug`     | admin | Update a quiz |
| DELETE | `/api/quiz/:slug`     | admin | Delete a quiz, its scores, and its S3 image |
| POST   | `/api/quiz-image-url` | admin | Presigned S3 upload URL for a quiz image |
| GET    | `/api/quiz/:slug/full`| admin | Full quiz including plaintext answers (for editing) |
| POST   | `/api/attempt`        | —     | Start a run; returns a single-use, server-timed attempt token |
| POST   | `/api/attempt/finish` | —     | End a run: records the score if signed in, reveals the answer key |
| GET    | `/api/scores`         | —     | Total-points leaderboard; `?quiz=` all three fastest-time boards; `?quiz=&difficulty=` one board |
| GET    | `/api/scores/me`      | ✅    | Your per-quiz best points and total |
| GET    | `/api/scores/best`    | ✅    | Your bests for a quiz (`?quiz=` all difficulties, or `&difficulty=` one) |
| DELETE | `/api/user`           | ✅    | Permanently delete your account, scores, and suggestions |
| POST   | `/api/suggestion`     | ✅    | Submit a quiz suggestion to the review queue |
| GET    | `/api/suggestions`    | admin | List pending suggestions |
| DELETE | `/api/suggestions/:id`| admin | Remove (reject or after approving) a suggestion |
| WS     | `/ws`                 | —     | Server-push `{type: 'updateScores', quiz, quizScores, allScores}` |

### Scoring

Each quiz contributes up to **10 points** to a player's total: easy attempts max out at 6
points, medium at 8, and hard at 10, scaled by the fraction of questions answered
(rounded). A quiz counts once toward the total — retakes can only improve its best. Quiz
pages also keep a fastest-times board per difficulty.

### Security

- **Input sanitization** ([service/security.js](service/security.js)) strips MongoDB
  operator keys (`$…`, dotted, and prototype-polluting keys) from every request body,
  query string, cookie, and route param, so user input can't be reinterpreted as a
  query operator. Database helpers independently reject non-string keys as a second layer.
- **Type-safe validation** — every string field goes through a checked reader with a
  length cap; allowlists use `Object.hasOwn` rather than `in` so prototype keys like
  `constructor` can't slip through.
- **Crash resistance** — all async routes are wrapped so a thrown error becomes a 500
  instead of killing the process, backed by a global error handler.
- **Rate limiting** — 20 attempts per 15 minutes per IP on login/registration
  (brute-force and signup-spam protection), 60/minute on writes.
- **Sessions** — bcrypt-hashed passwords (72-byte cap, since bcrypt truncates),
  constant-time login regardless of whether the email exists, rotating uuid tokens in
  `httpOnly`/`sameSite=strict` cookies with a 7-day expiry, `Secure` in production.
- **Data exposure** — public endpoints return display names only; emails, hashes, and
  tokens never leave the server.
- **Score integrity** — pressing Play issues a single-use attempt token; the server
  records the start time and derives elapsed time from its own clock, so a client can't
  claim a faster run than it played. Attempts can't be replayed, used by another
  account, or submitted after the time limit, and implausibly fast runs are rejected.
- **Locked answers** — quiz payloads never contain readable answers. Each accepted
  spelling ships as a salted digest (to match a guess against) plus a ciphertext of the
  display answer keyed by that spelling, so the browser can only decrypt an answer it
  actually guessed; the rest are released when the run ends. Matching stays local, so
  typing costs no network requests. The salt is regenerated per response.

### Admin role

There is no self-service admin signup. To make an account an admin: register normally,
then in MongoDB Atlas (Browse Collections → `quiz.users`) add `"role": "admin"` to your
user document. The Admin nav item and quiz manager appear on next page load.

## Tests

Vitest across both halves of the app — 68 tests:

- **Unit** — guess normalization and accepted-answer expansion (including
  roman-numeral handling), shuffling, request sanitization, and rate limiting.
- **Component** — `QuizCard` rendered with React Testing Library, covering the
  completed and perfect-run states.
- **Contract** — the browser's answer-unlocking verified against a
  re-implementation of the server's locking, so the two halves can't drift apart.
- **Integration** — the Express app driven end to end with supertest (real
  routing, middleware, auth, and validation; only the database is stubbed):
  registration and login, session restore and logout, admin authorization,
  the full attempt/finish flow, and injection defences including the
  operator-in-a-cookie vector.

```bash
npm test            # frontend (Vitest + React Testing Library)
```

```bash
cd service && npm test    # backend (Vitest)
```

## Running locally

Prereqs: Node 18+, a MongoDB Atlas cluster (free M0 tier works).

1. Create `service/dbConfig.json` from [service/dbConfig.example.json](service/dbConfig.example.json)
   with your Atlas hostname and credentials (this file is gitignored). The `s3Bucket`/
   `s3Region` fields are optional — without them, image uploads are disabled and the
   admin form accepts pasted image URLs only. With them, the service needs AWS
   credentials (locally: `aws configure`; on EC2: the instance role).

   **Set `"dbName": "quiz-dev"`.** It defaults to `quiz`, which is the database the
   live site serves — without this, a local checkout reads and writes production
   records, and anything you try locally is immediately visible to everyone.
2. Start the backend (must run from `service/` — static paths are cwd-relative):
   ```bash
   cd service
   npm install
   npm start
   ```
3. Start the frontend dev server in another terminal (proxies `/api` and `/ws` to :4000):
   ```bash
   npm install
   npm run dev
   ```
4. Open http://localhost:5173.
5. Optional — fill the scratch database with players and play history so the boards
   have something to show:
   ```bash
   cd service && node seedDevData.mjs
   ```
   It refuses to run unless `dbName` is set to something other than `quiz`.

## Seed and demo scripts

| Script | Purpose |
|---|---|
| `service/seedData.js` | The 60 starter quizzes. Applied automatically at boot; only inserts slugs that are missing, so admin edits are never overwritten. |
| `service/seedDevData.mjs` | Local fixture — demo players with a known password for signing in during development. Refuses to run against `quiz`. |
| `service/seedDemoPlayers.mjs` | The live site's 18 fictional players. Requires an explicit `--db` and `--apply`; passwords are hashes of discarded random bytes, so the accounts cannot be signed into. `--purge` removes them. |

```bash
node seedDemoPlayers.mjs --db quiz            # preview, writes nothing
node seedDemoPlayers.mjs --db quiz --apply    # write
node seedDemoPlayers.mjs --db quiz --purge    # remove
```

## Deployment

Deployed to AWS EC2 behind Caddy (automatic HTTPS + WebSocket proxying), with the
Node service managed by pm2. See [docs/DEPLOY.md](docs/DEPLOY.md) for the full setup
checklist and `deployService.sh` for the deploy script:

```bash
./deployService.sh -k <pem key> -h <hostname> -s startup
```
