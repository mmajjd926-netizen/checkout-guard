#!/bin/bash
# Start the public demo (own process only; PID in web/server.pid).
cd "$(dirname "$0")/.."
: "${TELEGRAPH_API_KEY:?set TELEGRAPH_API_KEY}"
export PORT=${PORT:-8788}
if [ -f web/server.pid ] && kill -0 "$(cat web/server.pid)" 2>/dev/null; then echo "already running $(cat web/server.pid)"; exit 0; fi
nohup node web/server.mjs >> web/server.log 2>&1 &
echo $! > web/server.pid
echo "started $!"
