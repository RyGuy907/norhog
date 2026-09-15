# Norhog

Norhog is a full-stack history quiz site. Players race the clock to type answers
to fill-in-the-blank questions, and signed-in players earn points toward a
leaderboard that updates live over WebSockets.

**Live site:** [norhog.com](https://norhog.com)

I started it as my startup project for BYU's CS 260 (Web Programming) and kept
building on it afterward. It now has 183 quizzes, a server-checked scoring
system, an admin quiz builder, and a CI/CD pipeline that deploys to AWS.

## Features

- **Timed quizzes.** Each quiz has 20 questions at each of three difficulties,
  with limits of 6, 8, and 10 minutes. A correct answer is revealed the moment it
  is typed, and answers are matched loosely (case, accents, punctuation, a leading
  "the", roman numerals, and per-question alternate spellings).
- **Live leaderboard.** When anyone finishes a scored run, every open leaderboard
  page updates over a WebSocket without a refresh.
- **Accounts.** Registration and login use bcrypt-hashed passwords and httpOnly
  session cookies. Anyone can play, but only signed-in runs are scored. Players
  can delete their account and all of its data from the profile page.
- **Admin quiz builder.** Quizzes live in MongoDB, not in the code. Admins can
  create, edit, and delete them, and images upload straight from the browser to
  S3 through presigned URLs.
- **Quiz suggestions.** Signed-in players can submit a quiz, which goes into a
  review queue that admins approve or reject.
- **Boards.** Each quiz page shows the fastest perfect runs for each difficulty
  and the player's own bests, and the leaderboard and profile pages show the most
  played quizzes.

## Tech stack

| Layer | Tools |
|---|---|
| Frontend | React 19, React Router 7, Bootstrap 5, Vite |
| Backend | Node.js 22, Express 5, `ws` |
| Data | MongoDB Atlas, Amazon S3 (quiz images) |
| Testing | Vitest, React Testing Library, supertest |
| Hosting | AWS EC2, Caddy (HTTPS and reverse proxy), pm2 |
| CI/CD | GitHub Actions, OIDC federation into AWS, S3, SSM |

## Architecture

```
React SPA (Vite) ──HTTP──> Express REST API ──> MongoDB Atlas
     │                         │    │           (users, quizzes, scores, suggestions)
     │                         │    └─────────> S3 (presigned image uploads)
     └────────WebSocket────────┘
       (server pushes leaderboard updates)
```

The app lives in [startup_react/](startup_react/), with the frontend in
[src/](startup_react/src/) and the backend in
[service/](startup_react/service/). In production Express also serves the built
frontend, and Caddy sits in front of it for HTTPS.

| File | Purpose |
|---|---|
| [service/index.js](startup_react/service/index.js) | REST endpoints, auth middleware, attempt tracking, static hosting |
| [service/database.js](startup_react/service/database.js) | MongoDB queries and aggregations |
| [service/security.js](startup_react/service/security.js) | Request sanitization, type-checked field reads, rate limiting |
| [service/answerLock.js](startup_react/service/answerLock.js) | Locks answers before they are sent to the browser |
| [service/answerMatch.js](startup_react/service/answerMatch.js) | Normalizes answers and expands accepted variants |
| [service/scoreBroadcaster.js](startup_react/service/scoreBroadcaster.js) | WebSocket server for leaderboard updates |
| [service/imageStore.js](startup_react/service/imageStore.js) | S3 presigned upload URLs |
| [service/seedData.js](startup_react/service/seedData.js) | The 183 starter quizzes, inserted at boot if missing |

## How scoring works

Pressing Play asks the server for a single-use attempt token, and the server
records when the run started. When the run ends, the browser sends the token and
its score. The server takes the elapsed time from its own clock and rejects the
result if the token was already used, belongs to another account, arrived after
the time limit, or claims answers faster than a person could type them.

Each quiz is worth up to 10 points. Easy runs max out at 6 points, medium at 8,
and hard at 10, scaled by the fraction answered. Only a player's best result on
each quiz counts toward their total, so replaying can raise a score but never
stack it.

### Locked answers

The quiz payload never contains readable answers. Each accepted spelling is sent
as a salted SHA-256 digest (to compare a guess against) plus the display answer
encrypted with a key derived from that same spelling. The browser normalizes each
guess, checks it against the digests locally, and can only decrypt an answer it
actually guessed. The rest are sent when the run ends. Because matching happens
in the browser, typing doesn't send any network requests.

## Security

- **Injection.** Every request body, query, cookie, and route param is scrubbed of
  MongoDB operator keys (`$`-prefixed, dotted, and prototype keys). Database
  helpers also refuse non-string lookups as a second layer, which covers
  cookie-parser turning a `j:` cookie into an object.
- **Validation.** Text fields go through a checked reader with a length cap, and
  allowlists use `Object.hasOwn` so keys like `constructor` can't slip through.
  Image URLs must be http or https, and image positions only accept CSS keywords
  and percentages.
- **Sessions.** Passwords are hashed with bcrypt and capped at bcrypt's 72-byte
  limit. Login takes the same time whether or not the email exists. Session
  tokens rotate on login, live in `httpOnly`, `sameSite=strict` cookies (`Secure`
  in production), and expire after 7 days on the server as well as in the browser.
- **Rate limiting.** Login and registration allow 20 attempts per 15 minutes per
  IP, and writes allow 60 per minute. Counters are keyed on the matched route, so
  changing a URL's case doesn't reset them.
- **Headers and sockets.** Responses include `nosniff`, `X-Frame-Options`, a
  referrer policy, and HSTS in production. WebSocket upgrades from other origins
  are refused.
- **Data exposure.** Public boards return display names only. Emails, password
  hashes, and tokens never leave the server.
- **Deploys.** No credentials are stored in the repository. CI assumes an AWS role
  through OIDC, the deploy bundle is checked to make sure `dbConfig.json` isn't in
  it, and the server keeps its own copy of the database config.

### Known limitations

The score check limits what a modified client can claim, but it doesn't make
cheating impossible. A script could still report a perfect score after waiting
long enough to pass the timing check. Checking each guess on the server would
close that gap, but it would cost a request per answer, and I chose to keep
matching local. Similarly, the answer locks keep answers out of casual view in
the network tab, but short answers like years could be brute-forced offline by
someone determined to.

## Tests

90 tests run in CI on every push.

- **Unit tests** cover guess normalization, roman numeral handling, shuffling,
  request sanitization, rate limiting, and the WebSocket origin check.
- **Component tests** render `QuizCard` with React Testing Library.
- **Contract tests** check the browser's answer unlocking against a
  re-implementation of the server's locking, so the two halves can't drift apart.
- **Integration tests** drive the real Express app with supertest, with only the
  database stubbed. They cover registration, login, session expiry, admin
  authorization, the full attempt flow, rate limiting, and injection attempts
  including the operator-in-a-cookie case.

```bash
cd startup_react
npm test                  # frontend
cd service && npm test    # backend
```

## Running locally

You need Node 22 and a MongoDB Atlas cluster (the free M0 tier works). Every
command below runs from `startup_react/`.

1. Copy [service/dbConfig.example.json](startup_react/service/dbConfig.example.json) to
   `service/dbConfig.json` and fill in your Atlas hostname, user, and password.
   The file is gitignored. Set `"dbName"` to something like `"quiz-dev"`, since it
   defaults to `quiz`. The `s3Bucket` and `s3Region` fields are optional; without
   them the admin form only accepts pasted image URLs.
2. Start the backend from `service/`, since static paths are relative to it:
   ```bash
   cd service
   npm install
   npm start
   ```
3. In another terminal, start the frontend dev server. It proxies `/api` and `/ws`
   to port 4000.
   ```bash
   npm install
   npm run dev
   ```
4. Open http://localhost:5173.

To fill a local database with players and play history, run
`node seedDevData.mjs` from `service/`. It refuses to run against the `quiz`
database.

### Making an admin

There is no way to sign up as an admin. Register normally, then add
`"role": "admin"` to your user document in Atlas. The Admin link appears on the
next page load.

## Seed data

The live site's leaderboard is populated with 18 fictional demo players so the
boards aren't empty. Their accounts use a `demo.norhog.com` email domain and
password hashes of discarded random bytes, so nobody can sign into them.

| Script | Purpose |
|---|---|
| `service/seedData.js` | The starter quizzes. Loaded at boot, and only inserts missing slugs so admin edits are kept. |
| `service/syncSeedQuizzes.mjs` | Pushes edits in `seedData.js` to quizzes that already exist. Dry run by default. |
| `service/seedDevData.mjs` | Local test players with a known password. Refuses to run against `quiz`. |
| `service/seedDemoPlayers.mjs` | The live site's demo players. Needs an explicit `--db`, and `--purge` removes them. |

## Deployment

Pushing to `main` runs lint, both test suites, and a production build. If they
pass, GitHub Actions builds a bundle, uploads it to S3, and uses SSM to run
[deployFromS3.sh](startup_react/deployFromS3.sh) on the EC2 instance. That script installs
dependencies, restarts the service, checks that the port answers, and rolls back
to the previous release if anything fails. GitHub never opens a connection to the
server, so SSH stays closed to the internet.

[docs/DEPLOY.md](startup_react/docs/DEPLOY.md) covers the one-time AWS, Atlas, DNS, and Caddy
setup. [deployService.sh](startup_react/deployService.sh) is a manual SSH deploy for first-time
setup.

## License

[MIT](LICENSE)
