# Security notes

What the service does to protect itself, and what it deliberately does not. The
README summarizes this; the detail lives here.

## Injection

Every request body, query string, cookie, and route param is scrubbed of MongoDB
operator keys (`$`-prefixed, dotted, and prototype-polluting keys) before it
reaches a route, in [service/security.js](../service/security.js). The scrub
copies into a null-prototype object, so a `__proto__` key can't re-parent
anything.

Cookies matter here as much as bodies: cookie-parser turns a `j:`-prefixed
cookie into a parsed object, which made `Cookie: token=j:{"$gt":""}` a real way
to reach `findOne` with an operator. The database helpers in
[service/database.js](../service/database.js) also refuse non-string lookups as
a second layer, so a bad value fails twice.

## Validation

Text fields go through `asString`, which returns null for anything that isn't a
string and caps the length. Allowlists use `Object.hasOwn` rather than `in`, so
prototype keys like `constructor` can't pass as a difficulty or content type.
Quiz image URLs must parse as http or https, and image focal points accept only
CSS keywords and percentages, since both are rendered into markup.

## Accounts and sessions

- Passwords are hashed with bcrypt and capped at its 72-byte limit, measured in
  bytes rather than characters so multibyte passwords aren't silently truncated.
- Login compares against a dummy hash when no user matches, so an unknown email
  takes about as long as a wrong password.
- Session tokens are uuids that rotate on login and live in `httpOnly`,
  `sameSite=strict` cookies, `Secure` in production. They carry an issue time
  and are rejected after 7 days by the server, not only by the cookie's expiry.
- Deleting an account removes the user, their scores, and their pending
  suggestions in one step.

## Abuse and load

- Login and registration allow 20 attempts per 15 minutes per IP; writes allow
  60 per minute. Counters key on the matched route, so changing a URL's case or
  adding a trailing slash doesn't hand out a fresh counter.
- Attempts are held in memory and need no account, so the map is capped and the
  route returns 503 rather than growing without limit.
- WebSocket upgrades are limited to one path, a fixed number of clients, and
  same-origin requests.
- Async routes are wrapped so a rejected promise becomes a 500 instead of
  stopping the process.

## Score integrity

Pressing Play issues a single-use attempt token, and the server records the
start time. On finish, the server derives elapsed time from its own clock and
rejects the submission if the token was already used, belongs to another
account, arrived after the time limit, or claims answers faster than a person
could plausibly type. See the README's Known limitations for what this does
*not* stop.

## Locked answers

Quiz payloads carry no readable answers. Each accepted spelling ships as a
salted SHA-256 digest plus the display answer encrypted under a key derived from
that spelling, so the browser can only decrypt an answer it actually guessed.
The salt is regenerated per response, so ids can't be catalogued across page
loads. Remaining answers are released when the run ends.

This is obfuscation, not protection: short answers such as years could be
brute-forced offline against the digests. It exists to keep answers out of the
network tab during play.

## Deployment

No credentials are stored in the repository. `dbConfig.json` is gitignored,
lives outside the release directory on the server, and is symlinked in on each
deploy. CI asserts it is absent from the bundle and fails the build if it
appears. GitHub authenticates to AWS through OIDC federation, so there are no
long-lived access keys, and it reaches the instance through SSM rather than SSH,
so port 22 stays closed.

## Known gaps

- No Content-Security-Policy. Other headers (nosniff, `X-Frame-Options`,
  referrer policy, HSTS in production) are set by the service and by Caddy.
- The CI deploy job runs `npm ci`, which executes dependency install scripts, in
  the job that can assume the deploy role. Splitting build from deploy, or
  installing with `--ignore-scripts`, would close that path.
- Registration returns a distinct error for an email that already exists, which
  reveals whether an address has an account.
