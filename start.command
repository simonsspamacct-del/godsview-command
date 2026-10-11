#!/usr/bin/env bash
# Double-click this file on macOS to set up and start GodsView Command.
# Terminal opens in your home folder, so move to this file's folder first.
cd "$(dirname "$0")" || exit 1

bash ./start.sh "$@"
status=$?
if [ "$status" -ne 0 ]; then
  echo
  read -r -p "GodsView Command stopped. Press Return to close this window. " _
fi
exit "$status"
