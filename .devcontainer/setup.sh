#!/usr/bin/env bash
# Codespaces, once when the codespace is created: install the console, then
# download and install God's Eye View next to it (/workspaces/gods-eye-view).
set -euo pipefail
cd "$(dirname "$0")/.."
node scripts/start.mjs --yes --setup-only
