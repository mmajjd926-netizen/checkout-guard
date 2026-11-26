#!/bin/bash
# HTTPS for the demo via a Cloudflare quick tunnel (own process; PID in web/tunnel.pid, URL in web/tunnel_url.txt).
cd "$(dirname "$0")"
CF=${CLOUDFLARED:-cloudflared}
if [ -f tunnel.pid ] && kill -0 "$(cat tunnel.pid)" 2>/dev/null; then echo "tunnel running $(cat tunnel.pid): $(cat tunnel_url.txt)"; exit 0; fi
: > tunnel.log
nohup "$CF" tunnel --no-autoupdate --url http://127.0.0.1:8788 >> tunnel.log 2>&1 &
echo $! > tunnel.pid
for i in $(seq 1 30); do u=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' tunnel.log | head -1); [ -n "$u" ] && break; sleep 1; done
echo "$u" > tunnel_url.txt; echo "$(date -u +%FT%TZ) $u" >> tunnel_history.log
echo "tunnel $! $u"
