# Deployment Checklist — AWS EC2 + Caddy + MongoDB Atlas

One-time setup for hosting Norhog on AWS. After this, every deploy is just
`./deployService.sh -k key.pem -h yourdomain.com -s startup`.

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
   user, and password. **Never commit it** (it's gitignored). The deploy script ships it
   to the server automatically.

## 2. EC2 instance

1. AWS Console → EC2 → **Launch instance**:
   - AMI: Ubuntu Server 22.04 LTS (or the CS260 course AMI, which has Caddy/Node preinstalled)
   - Type: `t3.micro` (or `t2.micro` on the free tier)
   - Key pair: create one, download the `.pem`, `chmod 600` it
   - Security group inbound rules:
     - SSH (22) — *your IP only*
     - HTTP (80) — anywhere
     - HTTPS (443) — anywhere
     - **Do not** open port 4000 — Caddy proxies to it internally.
2. If using stock Ubuntu, install the runtime:
   ```bash
   # Node 20 via nvm
   curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
   . ~/.nvm/nvm.sh && nvm install 20
   npm install -g pm2

   # Caddy
   sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
   curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
   curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
   sudo apt update && sudo apt install caddy
   ```

## 3. Elastic IP

EC2 → Elastic IPs → **Allocate** → **Associate** with the instance.
(Without this, the public IP changes every time the instance stops.)
Now go back and add this IP to the Atlas network access list (step 1.3).

## 4. Domain

1. Register a domain (Route 53, Namecheap, Porkbun — anywhere).
2. Create DNS **A records** pointing to the Elastic IP:
   - `yourdomain.com` → Elastic IP
   - `*.yourdomain.com` → Elastic IP (optional, for subdomains)
3. Wait for DNS to propagate (`nslookup yourdomain.com` shows the Elastic IP).

## 5. Caddy

Edit `/etc/caddy/Caddyfile` on the instance:

```
yourdomain.com {
    reverse_proxy localhost:4000
}
```

```bash
sudo systemctl restart caddy
```

Caddy provisions HTTPS certificates automatically (needs the DNS record live first)
and proxies WebSocket upgrades natively — `wss://yourdomain.com/ws` just works.

## 6. First deploy

From `startup_react/` on your machine (Git Bash on Windows):

```bash
./deployService.sh -k ~/keys/yourkey.pem -h yourdomain.com -s startup
```

The script builds the frontend, bundles it with the service (including `dbConfig.json`),
and copies everything to `~/services/startup` on the instance. The script ends with
`pm2 restart startup`, which fails the very first time — start it once manually:

```bash
ssh -i ~/keys/yourkey.pem ubuntu@yourdomain.com
cd services/startup
pm2 start index.js -n startup
pm2 save
pm2 startup   # follow the printed instructions so pm2 survives reboots
```

## 7. S3 bucket + IAM (quiz image uploads)

Optional but recommended — without it the admin quiz form only accepts pasted image URLs.

1. S3 → **Create bucket** (e.g. `norhog-quiz-images`, same region as the EC2 instance).
   - Uncheck "Block all public access" (we'll scope public access to reads of `images/*` only).
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
7. Add to `service/dbConfig.json`: `"s3Bucket": "norhog-quiz-images", "s3Region": "us-east-1"`.

## 8. Verify

- `https://yourdomain.com` loads the app over HTTPS
- register / login works; cookie visible in DevTools (httpOnly)
- play a quiz logged in → score appears on the leaderboard
- leaderboard open in a second browser updates live on submission
- admin account (role set in Atlas) can create a quiz, including an image upload
- `pm2 logs startup` shows "Connected to MongoDB Atlas"
- reboot test: `sudo reboot`, site comes back up on its own
