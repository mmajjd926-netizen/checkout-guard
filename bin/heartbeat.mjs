#!/usr/bin/env node
// checkout-guard heartbeat: an always-on assistant that watches one purchase.
//
// Every tick it reuses its last answer while that answer is fresh, otherwise it buys
// fresh evidence through Telegraph, but never past a daily spending limit. When the
// decision first turns READY it alerts and waits for explicit approval; it never buys.
//
//   TELEGRAPH_API_KEY=anjoman_... node bin/heartbeat.mjs watch.json [--once] [--ticks 3]
//
// watch.json:
// { "product": "Raspberry Pi 5 8GB", "url": "https://...", "maxPrice": 180, "currency": "GBP",
//   "everyMinutes": 30, "freshMinutes": 60, "dailyBudgetUsd": 0.50, "perCheckCapUsd": 0.15,
//   "notifyUrl": "https://ntfy.sh/<your-topic>" }

import fs from 'node:fs';
import path from 'node:path';
import { Telegraph, RESERVE_PER_CALL } from '../src/telegraph.mjs';
import { runCheck, hostOf } from '../src/guard.mjs';
import { toMarkdown } from '../src/report.mjs';

const [file, ...rest] = process.argv.slice(2);
if (!file) { console.error('Usage: heartbeat.mjs watch.json [--once] [--ticks N]'); process.exit(2); }
const once = rest.includes('--once');
const ticks = rest.includes('--ticks') ? Number(rest[rest.indexOf('--ticks') + 1]) : (once ? 1 : Infinity);

const watch = JSON.parse(fs.readFileSync(file, 'utf8'));
const cfg = { everyMinutes: 30, freshMinutes: 60, dailyBudgetUsd: 0.5, perCheckCapUsd: 0.15, ...watch };
const stateFile = cfg.stateFile || file.replace(/\.json$/, '') + '.state.json';
const runsDir = cfg.runsDir || path.join(path.dirname(file), 'runs');
fs.mkdirSync(runsDir, { recursive: true });

const log = (msg, extra = {}) => {
  const line = JSON.stringify({ at: new Date().toISOString(), msg, ...extra });
  console.log(line);
  fs.appendFileSync(stateFile.replace(/\.state\.json$/, '') + '.log.jsonl', line + '\n');
};

for (let i = 0; i < ticks; i++) {
  await tick();
  if (i + 1 < ticks) await new Promise(r => setTimeout(r, cfg.everyMinutes * 60e3));
}

async function tick() {
  const st = load();
  const today = new Date().toISOString().slice(0, 10);
  if (st.day !== today) { st.day = today; st.spentToday = 0; }

  // 1. A fresh local answer is reused, a stale one is not.
  if (st.last && Date.now() - Date.parse(st.last.finished_at) < cfg.freshMinutes * 60e3) {
    log('reused fresh answer', { decision: st.last.decision, age_min: Math.round((Date.now() - Date.parse(st.last.finished_at)) / 60e3) });
    return save(st);
  }
  if (st.last) log('local answer is stale; buying fresh evidence', { age_min: Math.round((Date.now() - Date.parse(st.last.finished_at)) / 60e3) });

  // 2. Daily wallet limit.
  const left = Math.round((cfg.dailyBudgetUsd - st.spentToday) * 10000) / 10000;
  const cap = Math.min(cfg.perCheckCapUsd, left);
  if (cap < RESERVE_PER_CALL) {
    log('no budget left today; not buying', { spent_today: st.spentToday, daily_budget: cfg.dailyBudgetUsd });
    return save(st);
  }

  // 3. Buy evidence and decide.
  let run;
  try {
    const tg = new Telegraph({ apiKey: process.env.TELEGRAPH_API_KEY, api: process.env.TELEGRAPH_API, capUsd: cap });
    run = await runCheck(tg, { product: cfg.product, url: cfg.url, retailer: cfg.retailer || hostOf(cfg.url), maxPrice: cfg.maxPrice, currency: cfg.currency });
  } catch (e) {
    log('check failed; nothing decided', { error: String(e.message || e) });
    return save(st);
  }
  st.spentToday = Math.round((st.spentToday + run.ledger.spent_usd) * 10000) / 10000;
  const failed = run.ledger.calls.filter(c => !c.ok);
  if (failed.length === run.ledger.calls.length) log('every paid request failed (payment refused or no supply); keeping the previous decision', { errors: [...new Set(failed.map(c => c.error))].slice(0, 3) });

  const stamp = run.started_at.replace(/[:.]/g, '-').slice(0, 19);
  fs.writeFileSync(path.join(runsDir, `${stamp}-heartbeat.json`), JSON.stringify(run, null, 2));
  fs.writeFileSync(path.join(runsDir, `${stamp}-heartbeat.md`), toMarkdown(run));

  const d = run.decision.decision;
  const prev = st.last?.decision;
  st.last = { decision: d, finished_at: run.finished_at, summary: run.decision.summary, spent_usd: run.ledger.spent_usd };
  st.history = [...(st.history || []).slice(-49), st.last];
  log('decision', { decision: d, previous: prev || null, spent_usd: run.ledger.spent_usd, spent_today: st.spentToday, summary: run.decision.summary });

  // 4. Alert once when it turns READY. Approval stays a separate, explicit step.
  if (d === 'READY' && prev !== 'READY') await notify(`READY to buy ${cfg.product} (limit ${cfg.currency} ${cfg.maxPrice}). Approve with: node bin/guard.mjs --product "${cfg.product}" --url "${cfg.url}" --max-price ${cfg.maxPrice} --currency ${cfg.currency} --approve "<your name>"`);
  save(st);
}

async function notify(text) {
  log('alert', { text });
  if (!cfg.notifyUrl) return;
  try { await fetch(cfg.notifyUrl, { method: 'POST', body: text, signal: AbortSignal.timeout(10000) }); } catch (e) { log('alert delivery failed', { error: String(e.message || e) }); }
}
function load() { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return { spentToday: 0 }; } }
function save(st) { fs.writeFileSync(stateFile, JSON.stringify(st, null, 2)); }
