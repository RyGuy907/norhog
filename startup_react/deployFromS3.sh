#!/usr/bin/env bash
#
# Server-side half of the CI/CD deploy. Invoked by AWS SSM (as the ubuntu user)
# with an s3:// URL to a tarball built by GitHub Actions:
#
#   deployFromS3.sh s3://norhog-deploy-artifacts/<sha>.tar.gz
#
# Lives on the instance at ~/bin/deployFromS3.sh. Kept in the repo so it is
# version controlled, but note that updating it here does NOT update the copy on
# the server — reinstall it deliberately when it changes.
#
# There is no SSH involved and no inbound port: GitHub never connects to this
# box, it only asks SSM to run this script.
set -uo pipefail

ARTIFACT="${1:?usage: deployFromS3.sh s3://bucket/key.tar.gz}"
SERVICE="${2:-startup}"
DEST="$HOME/services/$SERVICE"
CONFIG="$HOME/config/$SERVICE/dbConfig.json"
HEALTH="http://127.0.0.1:4000/api/quizzes"

# pm2 --update-env takes the environment of *this* shell. SSM runs with a bare
# environment, so without setting this explicitly a deploy would quietly drop
# NODE_ENV=production — session cookies would lose their Secure flag and every
# authenticated request would start 401ing. This line is load-bearing.
export NODE_ENV=production

# nvm is not on PATH for non-login shells, so node/npm/pm2 must be sourced in.
export NVM_DIR="$HOME/.nvm"
# shellcheck source=/dev/null
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

for cmd in node npm pm2 aws curl tar; do
  command -v "$cmd" >/dev/null || { echo "FATAL: $cmd not found on PATH" >&2; exit 1; }
done

# Credentials never travel with the bundle; the server keeps its own copy.
[ -f "$CONFIG" ] || { echo "FATAL: missing $CONFIG" >&2; exit 1; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

echo "==> Downloading $ARTIFACT"
aws s3 cp "$ARTIFACT" "$TMP/artifact.tar.gz" --only-show-errors || exit 1

echo "==> Extracting"
mkdir -p "$TMP/new"
tar -xzf "$TMP/artifact.tar.gz" -C "$TMP/new" || exit 1
[ -f "$TMP/new/index.js" ] || { echo "FATAL: bundle has no index.js" >&2; exit 1; }

# Keep exactly one previous release so a failed smoke check can roll back.
echo "==> Swapping in the new release"
mkdir -p "$HOME/services"
if [ -d "$DEST" ]; then
  rm -rf "$DEST.prev"
  mv "$DEST" "$DEST.prev"
fi
mv "$TMP/new" "$DEST"
ln -sf "$CONFIG" "$DEST/dbConfig.json"

# Restores the previous release and makes sure it is serving again. Safe to call
# any time after the swap above.
rollback() {
  if [ ! -d "$DEST.prev" ]; then
    echo "!!! No previous release to roll back to" >&2
    return 1
  fi
  echo "!!! Rolling back to the previous release" >&2
  rm -rf "$DEST"
  mv "$DEST.prev" "$DEST"
  cd "$DEST" || return 1
  pm2 restart "$SERVICE" --update-env
  sleep 6
  if curl -fsS -m 10 -o /dev/null "$HEALTH"; then
    echo "!!! Rollback succeeded — the site is serving the previous release" >&2
    return 0
  fi
  echo "!!! ROLLBACK ALSO FAILED — the site is down, manual intervention needed" >&2
  return 1
}

cd "$DEST" || exit 1
echo "==> Installing production dependencies"
if ! npm ci --omit=dev; then
  # The old process is still running from the previous inode, so the site is up,
  # but the release directory now holds code that was never installed. Put the
  # previous release back rather than leaving that inconsistency behind.
  echo "!!! npm ci failed" >&2
  rollback
  exit 1
fi

echo "==> Restarting"
pm2 restart "$SERVICE" --update-env || pm2 start index.js -n "$SERVICE" --update-env

# pm2 reporting "online" only means the process is alive, not that it bound the
# port — a boot path that dies before app.listen leaves pm2 green while every
# request through Caddy 502s. Check the port, not the process.
echo "==> Smoke check"
sleep 6
if curl -fsS -m 10 -o /dev/null "$HEALTH"; then
  echo "==> OK: service is answering on port 4000"
  pm2 save --force >/dev/null 2>&1 || true
  rm -rf "$DEST.prev"
  exit 0
fi

echo "!!! Smoke check FAILED" >&2
rollback
exit 1
