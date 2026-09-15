#!/usr/bin/env bash
#
# Server-side half of the CI/CD deploy. AWS SSM runs it as the ubuntu user with
# an s3:// URL to a tarball built by GitHub Actions:
#
#   deployFromS3.sh s3://<deploy-bucket>/<sha>.tar.gz
#
# The copy that runs lives on the instance at ~/bin/deployFromS3.sh. It is kept
# here for version control, but changing this file does not update the server's
# copy, so it has to be reinstalled by hand when it changes.
#
# No SSH or inbound port is involved. GitHub never connects to the server; it
# only asks SSM to run this script.
set -uo pipefail

ARTIFACT="${1:?usage: deployFromS3.sh s3://bucket/key.tar.gz}"
SERVICE="${2:-startup}"
DEST="$HOME/services/$SERVICE"
CONFIG="$HOME/config/$SERVICE/dbConfig.json"
HEALTH="http://127.0.0.1:4000/api/quizzes"

# pm2 --update-env takes its environment from this shell, and SSM starts with an
# empty one. Without this line a deploy would drop NODE_ENV=production and
# session cookies would lose their Secure flag.
export NODE_ENV=production

# nvm isn't on PATH for non-login shells, so it is loaded here for node, npm, and pm2.
export NVM_DIR="$HOME/.nvm"
# shellcheck source=/dev/null
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

for cmd in node npm pm2 aws curl tar; do
  command -v "$cmd" >/dev/null || { echo "FATAL: $cmd not found on PATH" >&2; exit 1; }
done

# Credentials never travel with the bundle, so the server keeps its own copy.
[ -f "$CONFIG" ] || { echo "FATAL: missing $CONFIG" >&2; exit 1; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

echo "==> Downloading $ARTIFACT"
aws s3 cp "$ARTIFACT" "$TMP/artifact.tar.gz" --only-show-errors || exit 1

echo "==> Extracting"
mkdir -p "$TMP/new"
tar -xzf "$TMP/artifact.tar.gz" -C "$TMP/new" || exit 1
[ -f "$TMP/new/index.js" ] || { echo "FATAL: bundle has no index.js" >&2; exit 1; }

# One previous release is kept so a failed smoke check can roll back.
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
    echo "!!! Rollback succeeded: the site is serving the previous release" >&2
    return 0
  fi
  echo "!!! ROLLBACK ALSO FAILED: the site is down and needs manual attention" >&2
  return 1
}

cd "$DEST" || exit 1
echo "==> Installing production dependencies"
if ! npm ci --omit=dev; then
  # The old process is still running, so the site is up, but the release
  # directory now holds code whose dependencies never installed. The previous
  # release is put back so the two match again.
  echo "!!! npm ci failed" >&2
  rollback
  exit 1
fi

echo "==> Restarting"
pm2 restart "$SERVICE" --update-env || pm2 start index.js -n "$SERVICE" --update-env

# pm2 reporting "online" only means the process is alive, not that it opened the
# port. If startup fails before app.listen, pm2 still looks fine while Caddy
# returns 502, so the port is checked directly.
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
