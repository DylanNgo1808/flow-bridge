#!/usr/bin/env bash
# Launch Chrome with a dedicated user-data-dir so the Flow extension
# never shares cookies with the everyday / main Google account.
set -euo pipefail

PROFILE="${FLOW_BRIDGE_CHROME_PROFILE:-$HOME/.flow-bridge/chrome-test-profile}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EXTENSION="$ROOT/extension"
CHROME="${FLOW_BRIDGE_CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"

if [[ ! -x "$CHROME" ]]; then
  echo "Chrome not found at: $CHROME"
  echo "Set FLOW_BRIDGE_CHROME to the Chrome binary and retry."
  exit 1
fi

mkdir -p "$PROFILE"

echo "Flow Bridge — isolated Chrome"
echo "  profile:   $PROFILE"
echo "  extension: $EXTENSION"
echo
echo "In this window only:"
echo "  1. chrome://extensions → Developer mode → Load unpacked → extension/"
echo "  2. Sign in at labs.google/fx/tools/flow with the TEST account"
echo "  3. Do not use the main Google account in this window"
echo

exec "$CHROME" \
  --user-data-dir="$PROFILE" \
  --no-first-run \
  --no-default-browser-check \
  --new-window \
  "chrome://extensions" \
  "https://labs.google/fx/tools/flow"
