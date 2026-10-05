#!/usr/bin/env bash
# Run 39: a complete Linux x64 release of ALKAO for MochaHost (cPanel, Passenger).
# It holds the committed sources, the UIs, the migrations and the production node_modules
# installed here, so the host never runs npm. Only committed files go in: never a .env.
#   bash scripts/pack-artifact.sh [output-dir]      -> <output-dir>/alkao-<commit>.tar.gz
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$(mkdir -p "${1:-$ROOT/var/artifacts}" && cd "${1:-$ROOT/var/artifacts}" && pwd)"
ID="$(git -C "$ROOT" rev-parse --short=12 HEAD)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
STAGE="$WORK/alkao-$ID"

mkdir -p "$STAGE"
git -C "$ROOT" archive HEAD | tar -x -C "$STAGE"
rm -rf "$STAGE/test" "$STAGE/.github" "$STAGE/docker-compose.yml" "$STAGE/Dockerfile" "$STAGE/.dockerignore"
(cd "$STAGE" && NODE_ENV=production npm ci --omit=dev --no-audit --no-fund)
echo "$ID" > "$STAGE/BUILD_ID"

# The release must start: load the server's modules once, without listening or a database.
(cd "$STAGE" && node --import tsx -e 'await import("./src/api/app.ts"); await import("./src/ops/cron.ts"); await import("./src/ops/golive.ts")')
if find "$STAGE" -maxdepth 1 -name '.env*' ! -name '.env.example' | grep -q .; then
  echo "refusing: a .env file is in the release" >&2
  exit 1
fi

tar -czf "$OUT/alkao-$ID.tar.gz" -C "$WORK" "alkao-$ID"
echo "$OUT/alkao-$ID.tar.gz ($(du -h "$OUT/alkao-$ID.tar.gz" | cut -f1))"
