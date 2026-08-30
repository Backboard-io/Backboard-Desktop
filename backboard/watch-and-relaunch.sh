#!/usr/bin/env bash
# Kill any running Backboard Studio instance, recompile, relaunch, and tail the launch log.
# Usage: ./watch-and-relaunch.sh [--watch]
#   --watch   use `npm run watch` (continuous rebuild) instead of a one-shot `npm run compile`
set -euo pipefail
cd "$(dirname "$0")"

pkill -f "Backboard Studio" || true

if [[ "${1:-}" == "--watch" ]]; then
  echo "Starting continuous watch build (npm run watch)..."
  npm run watch &
  WATCH_PID=$!
  echo "Watch process running as PID $WATCH_PID. Waiting for initial build..."
  sleep 5
else
  echo "Running one-shot compile..."
  npm run compile
fi

RUN_DIR="/tmp/backboard-studio-dev-$(date +%s)"
/usr/bin/nohup ./run-backboard-ide.sh > "$RUN_DIR.launch.log" 2>&1 &

echo "Launched. Tailing $RUN_DIR.launch.log (Ctrl-C to stop tailing; app keeps running)"
tail -f "$RUN_DIR.launch.log"
