#!/usr/bin/env bash
# Simple shell wrapper for non-Node users — same as npm run music:local
# Usage: ./scripts/run-lavalink-local.sh
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

if ! command -v node >/dev/null 2>&1; then
  echo "node not found — install Node 20+ first"
  exit 1
fi

# Prefer node runner (downloads jar, checks java, copies config)
exec node scripts/run-lavalink-local.mjs "$@"
