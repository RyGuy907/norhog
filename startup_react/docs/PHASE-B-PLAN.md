# Phase B — Deployment Plan

Everything between "the app works locally" and "the app is live, verified, and
deploys itself." [DEPLOY.md](DEPLOY.md) is the mechanical runbook for the AWS
steps; this document is the plan around it — order, decisions, the work that
still needs building, and how we know each stage is done.

---

## Where things stand

**Done (Phase A + hardening):**

- React/Vite SPA + Node/Express API + MongoDB Atlas, 26 quizzes / 780 questions
- bcrypt auth with httpOnly session cookies, role-based admin CMS, suggestion queue
- Real-time WebSocket leaderboard, points system, per-difficulty stats
- Security pass: request sanitization, rate limiting, unique indexes, constant-time
  login, locked answers, server-authoritative attempt timing
- 68 tests (unit, component, contract, API integration)
- S3 presigned upload code written — **bucket not yet created**

**Not done:**

- Nothing is deployed. `NODE_ENV=production` has never run anywhere.
- No domain, no EC2 instance, no S3 bucket, no IAM roles
- Email verification: **not built** (design below)
- CI/CD: **not built** (design below)

---

## Order of operations

Dependencies are real here — several steps block others.

```
0. Pre-flight (merge PR, wipe test data)
        │
1. Atlas network access ──┐
2. EC2 + runtime          │
3. Elastic IP ────────────┼──> 4. Domain + DNS ──> 5. Caddy + HTTPS
        │                 │                              │
        └─ add EIP to Atlas allowlist                    │
                                                          ▼
                                            6. First deploy + pm2
                                                          │
                                    ┌─────────────────────┼─────────────────┐
                                    ▼                     ▼                 ▼
                            7. S3 + IAM          8. SES email verify   9. CI/CD
```

Steps 7–9 are independent of each other and can be done in any order, but all
three need step 6 finished first. **Do not start CI/CD until one manual deploy
has succeeded** — otherwise you're debugging the pipeline and the server setup
at the same time.

---

## 0. Pre-flight

- [ ] Merge the `harden-and-polish` PR into `main`
- [ ] **Wipe test data from Atlas** — `claude-test@example.com` (currently an
      admin) and its scores, plus any other throwaway accounts. Launch with a
      clean leaderboard.
- [ ] Confirm `service/dbConfig.json` is still gitignored and untracked
- [ ] `npm test` in both halves, `npm run lint` — all green
- [ ] Decide the domain name

---

## 1–6. Get it live

Follow [DEPLOY.md](DEPLOY.md) sections 1–6. The things most likely to bite:

| Trap | Symptom | Fix |
|---|---|---|
| `NODE_ENV` not set | Login "works" but every later request 401s | Cookies need `Secure` in prod; verify with `pm2 env 0 \| grep NODE_ENV` |
| Atlas allowlist missing the Elastic IP | Service exits at boot with a connection error | Add the EIP under Atlas → Network Access |
| Caddy started before DNS propagated | Certificate provisioning fails | Wait for `nslookup`, then `sudo systemctl restart caddy` |
| `pm2 restart` on first deploy | Script errors at the last step | First run needs `pm2 start index.js -n startup` |
| Port 4000 open to the world | Bypasses HTTPS entirely | Security group should allow only 22 (your IP), 80, 443 |

**Done when:** `https://yourdomain.com` serves the site over HTTPS, you can
register and log in, a score reaches the leaderboard, a second browser sees it
update live, and the site survives `sudo reboot`.

---

## 7. S3 bucket + IAM

Follow [DEPLOY.md](DEPLOY.md) section 7. Two things worth restating:

- **Use the EC2 instance role in production** — no access keys on the box. A
  local IAM user with the same policy is fine for `aws configure` on your machine.
- The upload endpoint returns **501** when `s3Bucket`/`s3Region` are absent from
  `dbConfig.json`, and the admin form silently falls back to pasting a URL. So
  if uploads "don't work" after setup, check the config file first.

**Done when:** an admin uploads an image through the quiz form and it renders on
the quiz page from an `s3.amazonaws.com` URL.

---

## 8. Email verification with AWS SES

This is the one genuinely new feature in Phase B. Everything below is unbuilt.

### Why SES

It keeps the stack all-AWS (good for the resume line), costs effectively nothing
at this volume, and the same sender module later powers password reset.

### The catch: sandbox mode

New SES accounts are **sandboxed** — you can only send to addresses you've
individually verified. That makes real signups impossible until AWS grants
production access (a request form, usually approved within a day).

**Plan around it with a soft gate first:**

| Stage | Behaviour |
|---|---|
| Sandbox | Record `verified` on the user, send the email, show an "unverified" banner — but **don't block anything**. Site stays fully usable. |
| Production access granted | Flip one flag to enforce: unverified users can play, but can't post scores or submit quiz suggestions. |

A soft gate that becomes a hard gate. Never ship a hard gate while sandboxed —
you'd lock out every new user.

### Data model

Add to the user document:

```js
verified: false,
verifyToken: uuidv4(),        // cleared once used
verifyTokenSentAt: '<ISO>',   // for expiry + resend throttling
```

Existing users (yours, `rjr13`) should be backfilled `verified: true` — they
predate the feature and shouldn't be penalised.

### Server work

**New `service/mailer.js`** — mirrors the `imageStore.js` pattern exactly:
optional config, graceful no-op fallback, so local dev needs no AWS at all.

```js
// Reads sesRegion + mailFrom from dbConfig.json.
// When unconfigured, logs the verification link to the console instead of
// sending — that IS the local dev flow.
export function mailerConfigured() { ... }
export async function sendVerificationEmail(to, link) { ... }
```

**Endpoints:**

| Method | Route | Notes |
|---|---|---|
| `GET` | `/api/auth/verify?token=…` | Marks verified, clears the token, redirects to `/profile?verified=1` |
| `POST` | `/api/auth/resend` | Auth'd, rate limited hard (e.g. 3 / hour / account) |

**Changes to existing code:**

- `/api/auth/create` — generate the token, send the mail, return as normal
- `userResponse()` — include `verified` so the client can show the banner
- `/api/attempt/finish` and `/api/suggestion` — check `req.user.verified` **only
  once the hard gate is enabled**

**Token rules:** single-use, 24-hour expiry, invalid/expired shows a page with a
resend button. Never reveal whether an address is registered.

### Client work

- Banner on `/profile` when `verified === false`, with a resend button
- `/profile?verified=1` shows a success message
- The existing login-prompt component on quiz pages gains an "unverified" variant

### DNS records (registrar or Route 53)

SES → **Verified identities** → create a *domain* identity (not just an email),
then add what it generates:

| Type | Purpose |
|---|---|
| 3 × CNAME | DKIM signing — SES generates these; without them mail lands in spam |
| TXT (SPF) | `v=spf1 include:amazonses.com ~all` |
| TXT (DMARC) | `_dmarc` → `v=DMARC1; p=none; rua=mailto:you@yourdomain.com` — start at `p=none` |
| MX + TXT | Optional custom MAIL FROM subdomain, improves deliverability |

### IAM

Add to the EC2 instance role:

```json
{ "Effect": "Allow", "Action": ["ses:SendEmail", "ses:SendRawEmail"], "Resource": "*" }
```

### Config

```json
"sesRegion": "us-east-1",
"mailFrom": "no-reply@yourdomain.com"
```

### Sequence

1. Build the feature locally (console-log sender — no AWS needed)
2. Add tests: token issued on signup, verify marks the flag, expired/used token
   rejected, resend throttled
3. Create the SES domain identity, add DNS records, wait for verification
4. Deploy with the soft gate; test against your own verified address
5. Request production access
6. Once granted, flip the hard gate and redeploy

**Done when:** a real signup from an outside address receives the email, the
link verifies the account, and an unverified account is blocked from scoring.

---

## 9. CI/CD with GitHub Actions — **DONE**, but not as planned

Built in `.github/workflows/ci.yml`. Two things changed from the design above.

### Why the SSH deploy was abandoned

The plan assumed CI could `scp`/`ssh` into the box. It cannot: the security group
allows port 22 from one home IP, and GitHub runners come from a large rotating
pool. Opening 22 to the world to work around that trades a real security property
for convenience. A self-hosted runner on the instance was also ruled out — only
~140 MB of RAM is free on a `t3.nano`, less than the Actions runner needs before
it does any work.

**What was built instead:** CI builds a tarball, uploads it to S3, and calls
`ssm:SendCommand` to run `deployFromS3.sh` on the instance. GitHub never opens a
connection to the server, so **port 22 stays closed**, and there is no SSH key in
the repository at all. Authentication is GitHub OIDC federation into an IAM role,
so there are no long-lived AWS keys either — the `EC2_HOST` / `EC2_SSH_KEY`
secrets in the table above were never needed.

### One workflow, not two

Deploy is a gated job inside `ci.yml` rather than a separate `deploy.yml`, so
`needs: [frontend, service]` gates it on the test jobs directly. A separate
workflow would need `workflow_run`, which fires on completion regardless of
outcome and then needs its own conclusion check and explicit ref handling — more
moving parts for the same guarantee.

### Actual configuration

| Where | Name | Value |
|---|---|---|
| GitHub secret | `AWS_DEPLOY_ROLE_ARN` | the `norhog-github-deploy` role |
| GitHub variable | `DEPLOY_BUCKET` | `norhog-deploy-artifacts` |
| GitHub variable | `INSTANCE_ID` | `i-054760b34c781e845` |
| IAM role | `norhog-ec2-role` | `AmazonSSMManagedInstanceCore` + `s3:GetObject` on the artifact bucket |
| IAM role | `norhog-github-deploy` | `s3:PutObject`, `ssm:SendCommand`, `ssm:GetCommandInvocation` |

The trust policy pins the OIDC subject to
`repo:RyGuy907/norhog:ref:refs/heads/main`. That exact string matters: the repo
was renamed from `startup`, and the first attempt used the old name, which would
have failed `AssumeRoleWithWebIdentity`. Restricting the branch is what stops a
pull request from a fork assuming the deploy role.

### Safety properties

- **Credentials never leave the server.** The bundle contains only `*.js` and the
  two package manifests; the workflow asserts `dbConfig.json` is absent and fails
  the build if it appears.
- **Automatic rollback.** `deployFromS3.sh` keeps one previous release and
  restores it if either `npm ci` or the post-restart smoke check fails.
- **`NODE_ENV` is exported explicitly** before `pm2 restart --update-env`, because
  pm2 adopts the calling shell's environment and SSM invokes commands with a bare
  one. Without that line every deploy would quietly drop the flag that makes
  session cookies `Secure`.
- **The smoke check tests the port, not the process.** pm2 reporting "online" does
  not mean anything is listening — see the boot-guard bug in section 6.

**Done:** verified end to end on 2026-07-28. A push to `main` runs lint, both test
suites, and a build; on success it deploys and confirms `https://norhog.com`
returns 200. `NODE_ENV=production` confirmed intact on the running process
afterwards.

---

## Post-launch checklist

- [ ] Add `og:image` — take a screenshot, drop it at `public/og-image.png`, add
      the meta tag. Right now the link previews with no image.
- [ ] Set your own account to `role: "admin"` in Atlas (register on the live site first)
- [ ] Confirm the rate limiter behaves behind Caddy — `trust proxy` is set to 1,
      so `req.ip` should be the real client IP, not Caddy's
- [ ] `pm2 startup` + `pm2 save` so the service survives reboots
- [ ] Update the README's "Live demo" line with the real URL
- [ ] Update the resume bullets — only once all of this is true

---

## Rough costs

This account is **not** free-tier eligible, so everything below is billed from day one.

| Item | Cost |
|---|---|
| EC2 t3.nano | ~$3.80/mo (t3.micro would be ~$7.59) |
| Public IPv4 address | ~$3.65/mo — charged since Feb 2024 on *any* public IPv4, Elastic or auto-assigned. Unavoidable for a public web server. |
| EBS 8 GB gp3 root volume | ~$0.64/mo |
| Domain | ~$12/yr (varies) |
| Route 53 hosted zone | $0.50/mo if you use Route 53 for DNS |
| S3 | Pennies at this scale |
| MongoDB Atlas M0 | Free |
| SES | ~$0.10 per 1,000 emails |

Roughly **$8–9/month plus the domain** — call it $110–120/year.

Take the Elastic IP: it costs the same as the auto-assigned address it replaces, and
without one a stop/start (AWS hardware retirement, or resizing the instance) hands you
a new IP that has to be fixed in both DNS and the Atlas allowlist while the site is down.

Set an AWS budget alert before launching, not after the first bill.

---

## Risks and open questions

| Risk | Mitigation |
|---|---|
| SES production access denied or delayed | Soft gate means the site works regardless; resubmit with more detail on use case |
| Free tier expires and EC2 starts billing | Set an AWS budget alert now, not later |
| Instance stopped → Elastic IP detached | EIPs bill when unattached; keep the instance running or release the IP |
| Atlas IP allowlist vs. changing home IP | Re-add your home IP when it changes, or use a wider CIDR for dev only |
| Losing `dbConfig.json` | It's gitignored by design — keep a copy in a password manager |

---

## Suggested working order

1. Pre-flight + steps 1–6 → **site is live** (highest value, unblocks everything)
2. Step 7, S3 → completes the AWS story
3. Step 9, CI/CD → fastest remaining win, and makes the rest of the work easier to ship
4. Step 8, SES → largest new build; do it last so a slow production-access
   approval doesn't hold up the deploy

This order gets a working URL on the resume soonest, then layers depth onto it.
