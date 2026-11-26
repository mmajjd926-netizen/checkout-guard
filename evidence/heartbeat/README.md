# Unattended heartbeat run (Mission 09, route 1)

`pi5-8gb-watch.json` (Raspberry Pi 5 8GB at The Pi Hut, limit GBP 180) is checked by `node bin/heartbeat.mjs evidence/heartbeat/pi5-8gb-watch.json --once` every 3 hours from cron
on our server, from 26 November 2026 until the end of Season II. Nobody touches it between ticks.

- `pi5-8gb-watch.log.jsonl`: every tick (reused / stale → bought / no budget left / decision / alert), with cost, paid and
  failed calls and the receipt and signal hashes of each paid answer.
- `runs/`: the full JSON ledger and Markdown report of each paid check.
- Daily wallet limit: $0.36 (at most about three paid checks a day); a fresh answer (under 170 minutes old) is reused.

The log is committed as it grows, so the history in git shows when each tick happened.
