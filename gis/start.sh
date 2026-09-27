#!/bin/sh
# PSICITS - start a local web server and open the app (macOS / Linux).
cd "$(dirname "$0")" || exit 1
PORT="${PORT:-8000}"
URL="http://localhost:$PORT/"
open_browser() { (sleep 1; (command -v xdg-open >/dev/null && xdg-open "$URL") || (command -v open >/dev/null && open "$URL")) >/dev/null 2>&1 & }
if command -v python3 >/dev/null 2>&1; then
  open_browser; echo "PSICITS is running at $URL (Ctrl+C to stop)"; exec python3 -m http.server "$PORT"
elif command -v node >/dev/null 2>&1; then
  open_browser; exec node tools/serve.js "$PORT"
else
  echo "Neither python3 nor node found - open index.html in your browser instead."
fi
