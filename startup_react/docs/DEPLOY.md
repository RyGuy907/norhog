# Deployment: AWS EC2, Caddy, and MongoDB Atlas

One-time setup for hosting Norhog on AWS. After this, a manual deploy is
`./deployService.sh -k key.pem -h yourdomain.com -s startup`, and pushing to
`main` deploys automatically (see [CI/CD](#9-cicd) at the end).

Hosting costs roughly $8-9 a month plus the domain: about $3.80 for a t3.nano,
$3.65 for the public IPv4 address (charged on any public address since February
2024), and under a dollar for the EBS volume. Set a billing alert before
launching rather than after the first bill.

## 1. MongoDB Atlas (free)

1. Create an account at https://www.mongodb.com/cloud/atlas and a new **M0 (free)** cluster.
2. **Database Access** → add a database user with a strong password
   (role: *Read and write to any database*, or scope it to the `quiz` database).
3. **Network Access** → add IP addresses:
   - your home IP (for local dev)
   - the EC2 Elastic IP (step 3 — come back and add it once you have it)
4. Get the cluster hostname from *Connect → Drivers* (the `cluster0.xxxxx.mongodb.net` part
   of the connection string).
5. Create `service/dbConfig.json` locally from `dbConfig.example.json` with the hostname,
   user, and password. **Never commit it** (it's gitignored), and keep a copy in a
   password manager — losing it means recreating the database user.

   The deploy script deliberately does **not** ship this file. The server gets its own
   copy, placed once by hand (step 6), so credentials never ride along with a deploy
   and CI can run the same script without ever seeing them.

## 2. EC2 instance

1. AWS Console → EC2 → **Launch instance**:
   - AMI: Ubuntu Server 24.04 LTS — supported to 2029, where 22.04 lapses in April 2027.
     The deploy script SSHes as `ubuntu@`, so a non-Ubuntu AMI means editing it.
   - Type: `t3.nano` — enough for this workload given a production-only install and the
     swap file below. Resize to `t3.micro` later if it struggles: stop, change type,
     start. The Elastic IP stays attached, so no DNS change and no new certificate.
   - Architecture: x86_64. ARM (`t4g.nano`, ~$9/yr cheaper) also works — the only
     native module is `bcrypt`, and since v6 it bundles a `linux-arm64` prebuild, so
     nothing compiles either way. If you take ARM, switch the AMI selector to
     **64-bit (Arm)** first; a `t4g` type is not selectable against an x86 AMI.
   - Storage: 8 GiB gp3 is enough (~4 GiB free after the OS, swap file, and runtime),
     and EBS volumes grow online if it ever isn't. Keep the default 3000 IOPS — gp3
     includes it free at any size. **Tick "Encrypted"** with the default `aws/ebs`
     key: it is free, and it is the one setting on that screen that cannot be changed
     later without snapshotting and rebuilding the volume. Leave File systems as None.
   - Key pair: create one and download the `.pem`. On **Windows**, `chmod 600` does
     nothing useful — OpenSSH checks NTFS ACLs, not POSIX bits, and rejects a key
     that inherits broad permissions with `UNPROTECTED PRIVATE KEY FILE`. Move it out
     of `Downloads` (which inherits the whole profile's ACLs) and restrict it:
     ```powershell
     icacls "$env:USERPROFILE\keys\yourkey.pem" /inheritance:r
     icacls "$env:USERPROFILE\keys\yourkey.pem" /grant:r "$($env:USERNAME):(R)"
     ```
   - Security group inbound rules:
     - SSH (22) — *your IP only*
     - HTTP (80) — anywhere
     - HTTPS (443) — anywhere
     - **Do not** open port 4000 — Caddy proxies to it internally.
2. **Swap first — before installing anything.** On a 0.5 GB `t3.nano` this is not an
   optimisation, it is what keeps the box responsive while apt works. A fresh Ubuntu
   AMI runs `unattended-upgrades` in the background over ~78 pending packages, and
   piling `nvm`, a global `npm` install, and a 36 MB `apt update` on top of that with
   no swap can drive it into thrashing. The failure is confusing rather than obvious:
   the kernel keeps completing TCP handshakes, so ports look open, but no userspace
   process gets scheduled — SSH cannot even emit its banner and HTTP requests hang
   with zero bytes returned.
   ```bash
   sudo fallocate -l 1G /swapfile
   sudo chmod 600 /swapfile
   sudo mkswap /swapfile
   sudo swapon /swapfile
   echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab   # survives reboot
   free -h   # confirm the swap line is non-zero
   ```
   Then let the pending upgrades finish deliberately, rather than racing them:
   ```bash
   sudo apt upgrade -y
   ```
   If the instance does become unresponsive: wait a few minutes before rebooting so a
   partial `dpkg` transaction can finish, and check **Actions → Monitor and
   troubleshoot → Get system log** for `Out of memory: Killed process` lines to
   confirm the cause.
3. Install the runtime:
   ```bash
   # Node 22 via nvm — matches local dev (v22.11.0) and is in LTS maintenance.
   # Do NOT install Node 20: it went end-of-life in April 2026.
   curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
   . ~/.nvm/nvm.sh && nvm install 22 && nvm alias default 22
   npm install -g pm2

   # Caddy. Note this differs from Caddy's official install docs, which are written
   # for Debian: debian-keyring and debian-archive-keyring do not exist on Ubuntu
   # 24.04 and apt-transport-https is obsolete (folded into apt). All three are
   # unnecessary — adding the repo needs only curl, gpg, and CA certs.
   sudo apt install -y curl gnupg ca-certificates
   curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor --batch --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
   curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
   sudo apt update && sudo apt install -y caddy

   # Confirm it came from Cloudsmith and not Ubuntu's older universe package.
   caddy version   # expect 2.10.x; a 2.7.x means the repo line did not take
   ```
4. **Log rotation** — unrotated pm2 logs are what actually fills a small root volume:
   ```bash
   pm2 install pm2-logrotate
   ```

## 3. Elastic IP

EC2 → Elastic IPs → **Allocate** → **Associate** with the instance.
(Without this, the public IP changes every time the instance stops.)
Tick "Allow this Elastic IP address to be reassociated" so replacing the instance
later is one action rather than two.

Now add that IP to Atlas → Network Access as `<elastic-ip>/32` (step 1.3). The
service exits at boot with a connection error until you do.

## 4. Domain

Register the domain and delegate it to Route 53 nameservers.

Route 53 → Hosted zones → your domain → **Create record**, twice:

| Record name | Type | Value | TTL |
|---|---|---|---|
| *(leave empty, the apex)* | A | `<elastic-ip>` | 300 |
| `www` | A | `<elastic-ip>` | 300 |

A short TTL (300s) while setting up means mistakes cost five minutes, not a day.
Raise it to 3600 once things are stable.

Wait for propagation before touching Caddy — certificate provisioning fails if the
record is not live yet, and Caddy then backs off before retrying:

```bash
nslookup yourdomain.com 8.8.8.8       # must show the Elastic IP
nslookup www.yourdomain.com 8.8.8.8   # must show the Elastic IP
```

## 5. Caddy

Replace `/etc/caddy/Caddyfile` on the instance with:

```
yourdomain.com {
	encode zstd gzip
	reverse_proxy localhost:4000

	header {
		Strict-Transport-Security "max-age=15552000"
		X-Content-Type-Options nosniff
		X-Frame-Options DENY
		Referrer-Policy strict-origin-when-cross-origin
	}
}

www.yourdomain.com {
	redir https://yourdomain.com{uri} permanent
}
```

Two things here are not in the stock template and both matter for this app:

- **`encode zstd gzip`** — nothing else in the stack compresses. `express.static`
  does not, and no compression middleware is installed, so without this line the
  272 kB JS bundle goes over the wire uncompressed. With it, ~85 kB.
- **`www` redirects to the apex rather than serving it.** Session cookies are
  scoped to the host, so someone who logs in on `www.` and later lands on the
  apex would appear logged out. One canonical origin avoids that.
- **The headers are also set by the service**, so they survive if Caddy is
  replaced. Setting them in both places is harmless.

```bash
sudo systemctl restart caddy
sudo systemctl status caddy --no-pager    # confirm active, no cert errors
```

Caddy provisions HTTPS certificates automatically once the DNS record is live,
and it proxies WebSocket upgrades natively, so `wss://yourdomain.com/ws` works
with no extra configuration. It also forwards the original `Host` header, which
the service's WebSocket origin check depends on.

## 6. First deploy

### 6a. Place the database credentials on the server (once)

The deploy wipes `~/services/startup` every time, so the credentials live outside it
and the script symlinks them back in. Do this before the first deploy or the script
will stop and tell you to:

```bash
ssh -i ~/keys/yourkey.pem ubuntu@yourdomain.com
mkdir -p ~/config/startup
nano ~/config/startup/dbConfig.json     # paste the same contents as your local copy
chmod 600 ~/config/startup/dbConfig.json
```

This file is written once and never touched again by a deploy.

### 6b. Deploy

From `startup_react/` on your machine (Git Bash on Windows):

```bash
./deployService.sh -k ~/keys/yourkey.pem -h yourdomain.com -s startup
```

The script builds the frontend, bundles it with the service, and copies everything to
`~/services/startup` on the instance. The script ends with
`pm2 restart startup`, which fails the very first time — start it once manually:

```bash
ssh -i ~/keys/yourkey.pem ubuntu@yourdomain.com
cd services/startup
pm2 start index.js -n startup --env production
pm2 save
pm2 startup   # follow the printed instructions so pm2 survives reboots
```

> **Important:** the service must run with `NODE_ENV=production` so session
> cookies are issued with the `Secure` flag. If pm2 doesn't pick it up from
> `--env production`, set it explicitly:
> ```bash
> pm2 delete startup
> NODE_ENV=production pm2 start index.js -n startup
> pm2 save
> ```
> Verify with `pm2 env <id> | grep NODE_ENV`, where `<id>` is the app's id from
> `pm2 list` — **not necessarily 0**. Installing `pm2-logrotate` first takes id 0,
> which makes `pm2 env 0` report the module's environment and look like a failure.
> The authoritative check reads the kernel's view of the process instead:
> ```bash
> sudo tr '\0' '\n' < /proc/$(pm2 pid startup | tail -1)/environ | grep NODE_ENV
> ```
> Without it, cookies are sent over
> plain HTTP too — which is what makes local development work, but is not
> what you want in production.

## 7. S3 bucket + IAM (quiz image uploads)

Optional but recommended — without it the admin quiz form only accepts pasted image URLs.

1. S3 → **Create bucket** (for example `norhog-quiz-images`, in the same region as
   the EC2 instance).
   - Uncheck "Block all public access". Public access is then scoped to reads of
     `images/*` only.
2. Bucket → Permissions → **Bucket policy**:
   ```json
   {
     "Version": "2012-10-17",
     "Statement": [{
       "Sid": "PublicReadImages",
       "Effect": "Allow",
       "Principal": "*",
       "Action": "s3:GetObject",
       "Resource": "arn:aws:s3:::norhog-quiz-images/images/*"
     }]
   }
   ```
3. Bucket → Permissions → **CORS** (browser PUTs go directly to S3):
   ```json
   [{
     "AllowedHeaders": ["*"],
     "AllowedMethods": ["PUT"],
     "AllowedOrigins": ["https://yourdomain.com", "http://localhost:5173", "http://localhost:4000"],
     "ExposeHeaders": []
   }]
   ```
4. IAM → Policies → create `norhog-image-upload`:
   ```json
   {
     "Version": "2012-10-17",
     "Statement": [{
       "Effect": "Allow",
       "Action": ["s3:PutObject", "s3:DeleteObject"],
       "Resource": "arn:aws:s3:::norhog-quiz-images/images/*"
     }]
   }
   ```
5. **Production credentials (no keys on the box):** IAM → Roles → create role for EC2 with
   that policy → EC2 console → instance → Actions → Security → **Modify IAM role** → attach.
6. **Local dev credentials:** IAM → Users → create a user with the same policy → access key
   → run `aws configure` locally.
7. Add to `service/dbConfig.json`: `"s3Bucket": "norhog-quiz-images", "s3Region": "us-west-2"`.

## 8. Verify

- `https://yourdomain.com` loads the app over HTTPS
- register / login works; cookie visible in DevTools (httpOnly)
- play a quiz logged in → score appears on the leaderboard
- leaderboard open in a second browser updates live on submission
- admin account (role set in Atlas) can create a quiz, including an image upload
- `pm2 logs startup` shows "Connected to MongoDB Atlas"
- reboot test: `sudo reboot`, site comes back up on its own

## 9. CI/CD

`.github/workflows/ci.yml` runs lint, both test suites, and a production build on
every push. On `main`, a gated deploy job then ships the build.

### Why it uses SSM instead of SSH

The obvious design is for CI to `scp` and `ssh` into the instance, but that
doesn't work here: the security group only allows port 22 from one home IP, and
GitHub's runners come from a large rotating pool. Opening 22 to the world would
trade a real security property for convenience. A self-hosted runner on the
instance was also ruled out, since a t3.nano has only about 140 MB of RAM free.

Instead, CI builds a tarball, uploads it to S3, and calls `ssm:SendCommand` to run
`deployFromS3.sh` on the instance. GitHub never connects to the server, so port 22
stays closed and there is no SSH key in the repository. Authentication uses GitHub
OIDC federation into an IAM role, so there are no long-lived AWS keys either.

Deploy is a job inside `ci.yml` rather than a separate workflow, so `needs:` can
gate it on the test jobs directly. A separate workflow would need `workflow_run`,
which fires regardless of outcome and then needs its own conclusion check.

### Configuration

| Where | Name | Value |
|---|---|---|
| GitHub secret | `AWS_DEPLOY_ROLE_ARN` | the deploy role's ARN |
| GitHub variable | `DEPLOY_BUCKET` | the artifact bucket |
| GitHub variable | `INSTANCE_ID` | the EC2 instance id |
| IAM role (EC2) | `AmazonSSMManagedInstanceCore` plus `s3:GetObject` on the artifact bucket |
| IAM role (GitHub) | `s3:PutObject`, `ssm:SendCommand`, `ssm:GetCommandInvocation` |

The role's trust policy pins the OIDC subject to
`repo:<owner>/<repo>:ref:refs/heads/main`. That string has to match exactly, and
restricting the branch is what stops a pull request from a fork from assuming the
deploy role. Renaming the repository breaks it until the policy is updated.

### What keeps it safe

- The bundle holds only `*.js` and the two package manifests. The workflow fails
  the build if `dbConfig.json` appears in it, and the server keeps its own copy.
- `deployFromS3.sh` keeps one previous release and restores it if `npm ci` or the
  smoke check fails.
- `NODE_ENV` is exported before `pm2 restart --update-env`, because pm2 takes the
  calling shell's environment and SSM runs commands with an empty one. Without
  it, every deploy would quietly drop the flag that makes cookies `Secure`.
- The smoke check tests the port rather than the process, since pm2 reporting
  "online" doesn't mean anything is listening.

One weakness worth knowing: the deploy job runs `npm ci`, which executes
dependency install scripts, in a job that can assume the deploy role. A
compromised dependency could reach that role. Splitting the build and deploy into
separate jobs, or installing with `--ignore-scripts`, would close it.
