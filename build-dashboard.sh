#!/usr/bin/env sh
# Discord Voice Ledger — build the dashboard (macOS / Linux)
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js was not found. Install it from https://nodejs.org" >&2
  exit 1
fi

node build.mjs "$@"

OUT="dist/discord-voice-ledger.html"
echo
echo "Done: $OUT"
if command -v xdg-open >/dev/null 2>&1; then xdg-open "$OUT"
elif command -v open >/dev/null 2>&1; then open "$OUT"
fi
