#!/usr/bin/env bash
# Codespaces, each time you open the codespace: start the console, which
# starts God's Eye View. Codespaces opens the console in a new browser tab.
cd "$(dirname "$0")/.."

if curl -fsS -o /dev/null "http://127.0.0.1:${PORT:-5050}/api/status" 2>/dev/null; then
  echo "GodsView Command is already running. Open it from the Ports tab (port 5050)."
  exit 0
fi

echo "Starting GodsView Command. It opens in a new browser tab."
echo "If no tab opens: open the Ports tab and click the globe icon next to port 5050."
exec node scripts/start.mjs --no-godsview
