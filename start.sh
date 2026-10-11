#!/usr/bin/env bash
# Set up and start GodsView Command on macOS or Linux:  ./start.sh
# (or: bash start.sh). Options: --yes, --no-godsview, --check.
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo
  echo "Node.js is not installed, or this terminal cannot see it."
  echo "Install the LTS version (24 or later) from https://nodejs.org/en/download,"
  echo "then open a new terminal window and run this again."
  echo
  exit 1
fi

exec node scripts/start.mjs "$@"
