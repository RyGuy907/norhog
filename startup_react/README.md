# Norhog — History Quiz App

Norhog is a full-stack quiz web application where users race a 60-second clock to answer
history questions, then compete for spots on a live leaderboard.

**Live demo:** _(URL coming after deployment)_

## Features

- **Timed quizzes** — three difficulty levels (easy/medium/hard) of fill-in-the-blank
  history questions with a per-quiz time limit; type a correct answer and it's revealed
  instantly.
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
| POST   | `/api/score`          | ✅    | Submit a validated attempt; broadcasts new leaderboards |
| GET    | `/api/scores`         | —     | Total-points leaderboard; `?quiz=&difficulty=` fastest perfect runs |
| GET    | `/api/scores/me`      | ✅    | Your per-quiz best points and total |
| GET    | `/api/scores/best`    | ✅    | Your best attempt for a quiz + difficulty |
| POST   | `/api/suggestion`     | ✅    | Submit a quiz suggestion to the review queue |
| GET    | `/api/suggestions`    | admin | List pending suggestions |
| DELETE | `/api/suggestions/:id`| admin | Remove (reject or after approving) a suggestion |
| WS     | `/ws`                 | —     | Server-push `{type: 'updateScores', quiz, quizScores, allScores}` |

### Scoring

Each quiz contributes up to **10 points** to a player's total: easy attempts max out at 6
points, medium at 8, and hard at 10, scaled by the fraction of questions answered
(rounded). A quiz counts once toward the total — retakes can only improve its best. Quiz
pages also keep a fastest-times board per difficulty.

### Admin role

There is no self-service admin signup. To make an account an admin: register normally,
then in MongoDB Atlas (Browse Collections → `quiz.users`) add `"role": "admin"` to your
user document. The Admin nav item and quiz manager appear on next page load.

## Running locally

Prereqs: Node 18+, a MongoDB Atlas cluster (free M0 tier works).

1. Create `service/dbConfig.json` from [service/dbConfig.example.json](service/dbConfig.example.json)
   with your Atlas hostname and credentials (this file is gitignored). The `s3Bucket`/
   `s3Region` fields are optional — without them, image uploads are disabled and the
   admin form accepts pasted image URLs only. With them, the service needs AWS
   credentials (locally: `aws configure`; on EC2: the instance role).
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

## Deployment

Deployed to AWS EC2 behind Caddy (automatic HTTPS + WebSocket proxying), with the
Node service managed by pm2. See [docs/DEPLOY.md](docs/DEPLOY.md) for the full setup
checklist and `deployService.sh` for the deploy script:

```bash
./deployService.sh -k <pem key> -h <hostname> -s startup
```
