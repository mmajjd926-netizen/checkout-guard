// Public demo for Checkout Guard: anyone can submit a product page; the server buys the
// evidence through Telegraph with its own testnet key, under hard per-run and daily caps.
//
//   TELEGRAPH_API_KEY=anjoman_... PORT=8788 node web/server.mjs

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Telegraph } from '../src/telegraph.mjs';
import { runCheck, approve, hostOf } from '../src/guard.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const RUNS = process.env.RUNS_DIR || path.join(ROOT, 'runs', 'web');
const PORT = Number(process.env.PORT || 8788);
const PER_RUN_CAP = Number(process.env.PER_RUN_CAP || 0.15);
const DAILY_CAP = Number(process.env.DAILY_CAP || 1.5);
const PER_IP_DAILY = Number(process.env.PER_IP_DAILY || 6);
const REPO = process.env.REPO_URL || 'https://github.com/mmajjd926-netizen/checkout-guard';
fs.mkdirSync(RUNS, { recursive: true });

const jobs = new Map();          // id -> { status, run?, error? }
const quota = { day: '', spent: 0, ips: new Map() };

function today() { return new Date().toISOString().slice(0, 10); }
function resetQuota() { if (quota.day !== today()) { quota.day = today(); quota.spent = spentOn(quota.day); quota.ips = new Map(); } }
function spentOn(day) {
  let s = 0;
  for (const f of fs.readdirSync(RUNS)) if (f.startsWith(day) && f.endsWith('.json')) { try { s += JSON.parse(fs.readFileSync(path.join(RUNS, f), 'utf8')).ledger.spent_usd || 0; } catch {} }
  return s;
}
function listRuns(n = 20) {
  return fs.readdirSync(RUNS).filter(f => f.endsWith('.json')).sort().reverse().slice(0, n).map(f => {
    try { const r = JSON.parse(fs.readFileSync(path.join(RUNS, f), 'utf8')); return { id: f.replace(/\.json$/, ''), r }; } catch { return null; }
  }).filter(Boolean);
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://x');
    if (req.method === 'GET' && u.pathname === '/') return html(res, home());
    if (req.method === 'GET' && u.pathname === '/health') return json(res, 200, { ok: true, day: quota.day, spent_today_usd: quota.spent });
    if (req.method === 'GET' && u.pathname.startsWith('/run/')) return showRun(res, u.pathname.slice(5));
    if (req.method === 'GET' && u.pathname.startsWith('/api/run/')) return apiRun(res, u.pathname.slice(9));
    if (req.method === 'GET' && u.pathname.startsWith('/api/job/')) { const j = jobs.get(u.pathname.slice(9)); return json(res, j ? 200 : 404, j || { error: 'unknown job' }); }
    if (req.method === 'POST' && u.pathname === '/api/check') return startCheck(req, res);
    if (req.method === 'POST' && u.pathname.startsWith('/api/approve/')) return doApprove(req, res, u.pathname.slice(13));
    res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found');
  } catch (e) { json(res, 500, { error: String(e.message || e) }); }
});
server.listen(PORT, () => console.log(`checkout-guard web on :${PORT}`));

async function body(req) { let b = ''; for await (const c of req) { b += c; if (b.length > 8000) throw new Error('body too large'); } return b; }
function json(res, code, o) { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(o, null, 2)); }
function html(res, s) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(s); }
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function startCheck(req, res) {
  resetQuota();
  const ip = (req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim();
  let p; try { p = JSON.parse(await body(req)); } catch { return json(res, 400, { error: 'send JSON: {product, url, maxPrice, currency}' }); }
  const product = String(p.product || '').trim().slice(0, 120);
  const url = String(p.url || '').trim().slice(0, 400);
  if (!product || !/^https?:\/\/[^\s]+$/.test(url)) return json(res, 400, { error: 'product and a full http(s) product URL are required' });
  const maxPrice = p.maxPrice === '' || p.maxPrice == null ? undefined : Number(p.maxPrice);
  if (maxPrice !== undefined && !(maxPrice > 0)) return json(res, 400, { error: 'maxPrice must be a positive number' });
  const currency = String(p.currency || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3) || undefined;
  if (quota.spent + PER_RUN_CAP > DAILY_CAP) return json(res, 429, { error: `Demo budget for today is used up ($${quota.spent.toFixed(2)} of $${DAILY_CAP.toFixed(2)} in test USDC). Run it yourself with your own key: ${REPO}` });
  const n = quota.ips.get(ip) || 0;
  if (n >= PER_IP_DAILY) return json(res, 429, { error: `Limit of ${PER_IP_DAILY} checks per visitor per day reached.` });
  quota.ips.set(ip, n + 1);
  quota.spent += PER_RUN_CAP;   // reserve now, correct after the run

  const id = crypto.randomBytes(6).toString('hex');
  jobs.set(id, { status: 'running', started_at: new Date().toISOString() });
  json(res, 202, { job: id });

  const order = { product, url, retailer: hostOf(url), maxPrice, currency };
  try {
    const tg = new Telegraph({ apiKey: process.env.TELEGRAPH_API_KEY, api: process.env.TELEGRAPH_API, capUsd: PER_RUN_CAP });
    const run = await runCheck(tg, order);
    quota.spent += run.ledger.spent_usd - PER_RUN_CAP;
    const rid = `${run.started_at.replace(/[:.]/g, '-').slice(0, 19)}-${id}`;
    run.id = rid; run.source = 'web demo';
    fs.writeFileSync(path.join(RUNS, rid + '.json'), JSON.stringify(run, null, 2));
    jobs.set(id, { status: 'done', run_id: rid, decision: run.decision.decision });
  } catch (e) {
    quota.spent -= PER_RUN_CAP;
    jobs.set(id, { status: 'error', error: String(e.message || e) });
  }
}

function loadRun(id) { if (!/^[\w-]+$/.test(id)) return null; try { return JSON.parse(fs.readFileSync(path.join(RUNS, id + '.json'), 'utf8')); } catch { return null; } }
function apiRun(res, id) { const r = loadRun(id); return json(res, r ? 200 : 404, r || { error: 'unknown run' }); }

async function doApprove(req, res, id) {
  const r = loadRun(id); if (!r) return json(res, 404, { error: 'unknown run' });
  let p = {}; try { p = JSON.parse(await body(req) || '{}'); } catch {}
  const name = String(p.name || '').trim().slice(0, 60);
  r.approval = approve(r, { approvedBy: name });
  if (r.approval.ok) fs.writeFileSync(path.join(RUNS, id + '.json'), JSON.stringify(r, null, 2));
  return json(res, r.approval.ok ? 200 : 409, r.approval);
}

// ------------------------------------------------------------------ pages

const CSS = `
:root{--bg:#0d1117;--card:#161b22;--line:#30363d;--fg:#e6edf3;--mut:#8b949e;--ok:#3fb950;--wait:#d29922;--block:#f85149;--acc:#58a6ff}
*{box-sizing:border-box}body{margin:0;font:15px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--fg)}
main{max-width:980px;margin:0 auto;padding:28px 18px 60px}a{color:var(--acc)}h1{font-size:26px;margin:0 0 4px}h2{font-size:18px;margin:28px 0 10px}
.mut{color:var(--mut)}.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px;margin:14px 0}
label{display:block;font-size:13px;color:var(--mut);margin:10px 0 4px}input{width:100%;padding:9px 10px;border-radius:8px;border:1px solid var(--line);background:#0b0f14;color:var(--fg);font:inherit}
.row{display:grid;grid-template-columns:2fr 1fr 1fr;gap:12px}@media(max-width:640px){.row{grid-template-columns:1fr}}
button{margin-top:14px;padding:10px 16px;border:0;border-radius:8px;background:#238636;color:#fff;font:600 15px system-ui;cursor:pointer}button:disabled{opacity:.6}
table{width:100%;border-collapse:collapse;font-size:13.5px}td,th{border-bottom:1px solid var(--line);padding:7px 6px;text-align:left;vertical-align:top}th{color:var(--mut);font-weight:600}
.pill{display:inline-block;padding:2px 9px;border-radius:99px;font-weight:700;font-size:12px}.READY,.pass{background:#12361d;color:var(--ok)}.WAIT,.wait{background:#3a2c0b;color:var(--wait)}.BLOCK,.block{background:#3d1214;color:var(--block)}.info{background:#0c2d4e;color:var(--acc)}
code{font:12.5px ui-monospace,Menlo,monospace;color:#c9d1d9}.big{font-size:30px;font-weight:800}footer{margin-top:40px;font-size:13px;color:var(--mut)}
.steps{display:flex;gap:10px;flex-wrap:wrap;font-size:13px}.steps span{background:#0b0f14;border:1px solid var(--line);border-radius:99px;padding:4px 10px}`;

function page(title, inner) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta name="description" content="A purchase agent that buys price, stock and URL-safety evidence through Telegraph and only asks to check out when the evidence holds up."><style>${CSS}</style></head>
<body><main>${inner}<footer>Checkout Guard runs on the Telegraph testnet (Ethereum Sepolia, test USDC). Nothing is ever bought from a retailer: READY only asks for approval, and approval writes a simulated checkout record.
Built for Telegraph Season II (Consumer Automation, Personal Agent). Source and tutorial: <a href="${REPO}">${REPO.replace('https://', '')}</a> (MIT).</footer></main></body></html>`;
}

function home() {
  const runs = listRuns(15);
  const rows = runs.map(({ id, r }) => `<tr><td><a href="/run/${id}">${esc(r.started_at.slice(0, 16).replace('T', ' '))}</a></td><td>${esc(r.order.product)}</td><td>${esc(r.order.retailer)}</td><td><span class="pill ${r.decision.decision}">${r.decision.decision}</span></td><td>$${r.ledger.spent_usd.toFixed(2)}</td><td>${r.ledger.paid_calls}</td></tr>`).join('');
  return page('Checkout Guard: buy only on verified price and stock', `
<h1>Checkout Guard</h1>
<div class="mut">A purchase agent for people who let software shop for them. Before any checkout it <b>buys evidence through Telegraph</b>: is the store URL safe, what does the exact item cost today (two independent Providers must agree), is it in stock. Then it says <b>BLOCK</b>, <b>WAIT</b> or <b>READY</b>, and READY still needs your explicit approval.</div>
<div class="steps" style="margin-top:12px"><span>1 · your product page + limit</span><span>2 · paid Telegraph asks: URL_SAFE, LIVE_SHELF_PRICE ×2–3, SKU_IN_STOCK, RETURN_POLICY</span><span>3 · rules: agree within 5 %, observed ≤ 48 h, under limit</span><span>4 · decision + receipts</span><span>5 · approval (simulated checkout)</span></div>
<div class="card"><form id="f">
<div class="row"><div><label>Product (name and variant)</label><input name="product" required value="Raspberry Pi 5 8GB"></div><div><label>Max price</label><input name="maxPrice" type="number" step="0.01" value="180"></div><div><label>Currency</label><input name="currency" value="GBP" maxlength="3"></div></div>
<label>Product page URL (the exact variant if the store has one)</label><input name="url" required value="https://thepihut.com/products/raspberry-pi-5?variant=42531604955331">
<button id="go">Buy the evidence and decide (~$0.10 test USDC, about a minute)</button> <span id="st" class="mut"></span></form></div>
<h2>Recent decisions</h2>
<div class="card" style="overflow-x:auto"><table><tr><th>When (UTC)</th><th>Product</th><th>Store</th><th>Decision</th><th>Spent</th><th>Paid answers</th></tr>${rows || '<tr><td colspan=6 class="mut">none yet</td></tr>'}</table></div>
<script>
const f=document.getElementById('f'),st=document.getElementById('st'),go=document.getElementById('go');
f.onsubmit=async e=>{e.preventDefault();go.disabled=true;st.textContent='buying evidence…';
const d=Object.fromEntries(new FormData(f));const r=await fetch('/api/check',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(d)});const j=await r.json();
if(!r.ok){st.textContent=j.error;go.disabled=false;return}let t=0;const iv=setInterval(async()=>{t+=3;st.textContent='buying evidence… '+t+' s';
const s=await (await fetch('/api/job/'+j.job)).json();if(s.status==='done'){clearInterval(iv);location='/run/'+s.run_id}if(s.status==='error'){clearInterval(iv);st.textContent=s.error;go.disabled=false}},3000)}
</script>`);
}

function showRun(res, id) {
  const r = loadRun(id); if (!r) { res.writeHead(404); return res.end('unknown run'); }
  const d = r.decision, L = r.ledger;
  const checks = d.checks.map(c => `<tr><td>${esc(c.id)}</td><td><span class="pill ${c.status}">${c.status.toUpperCase()}</span></td><td>${esc(c.detail)}</td></tr>`).join('');
  const calls = L.calls.map(c => `<tr><td>${esc(c.purpose)}</td><td><code>${esc(c.intent)}</code></td><td>${esc(c.miner || c.pinned_miner || '-')}</td><td>${c.ok ? esc(Object.entries(c.answer || {}).filter(([k, v]) => v !== null && typeof v !== 'object').map(([k, v]) => `${k}=${v}`).join(', ')) : '<span class="mut">failed: ' + esc(c.error) + '</span>'}</td><td>$${c.cost_usd.toFixed(2)}</td><td>${(c.latency_ms / 1000).toFixed(1)} s</td><td>${c.receipts?.[0] ? '<code title="receipt_hash">' + esc(c.receipts[0].receipt_hash.slice(0, 12)) + '…</code>' : c.signal_hash ? `<a href="https://devnode.telegraphprotocol.com/engine/v1/signal/${esc(c.signal_hash)}"><code title="signal_hash">${esc(c.signal_hash.slice(0, 12))}…</code></a>` : '-'}</td></tr>`).join('');
  const appr = r.approval ? `<div class="card"><b>Approval:</b> ${r.approval.ok ? `approved by ${esc(r.approval.approved_by)} at ${esc(r.approval.approved_at)}. ${esc(r.approval.note)}` : esc(r.approval.reason)}</div>`
    : d.decision === 'READY' ? `<div class="card"><b>Approve the purchase?</b> <span class="mut">Type your name. This writes a simulated checkout record; no retailer is paid.</span><input id="n" placeholder="your name"><button onclick="ap()">Approve</button> <span id="as" class="mut"></span></div>
<script>async function ap(){const r=await fetch('/api/approve/${esc(id)}',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:document.getElementById('n').value})});const j=await r.json();if(r.ok)location.reload();else document.getElementById('as').textContent=j.reason||j.error}</script>` : '';
  html(res, page(`${d.decision}: ${r.order.product}`, `
<a href="/">← Checkout Guard</a>
<div class="card"><div class="big"><span class="pill ${d.decision}" style="font-size:22px">${d.decision}</span> ${esc(r.order.product)}</div>
<div class="mut">${esc(r.order.retailer)} · limit ${esc(r.order.currency || '')} ${esc(r.order.maxPrice ?? 'none')} · checked ${esc(r.started_at.replace('T', ' ').slice(0, 19))} UTC · <a href="${esc(r.order.url)}" rel="nofollow noopener">product page</a></div>
<p>${esc(d.summary)}</p></div>${appr}
<h2>Checks</h2><div class="card" style="overflow-x:auto"><table><tr><th>Check</th><th>Result</th><th>Why</th></tr>${checks}</table></div>
<h2>Evidence bought through Telegraph</h2><div class="mut">${L.paid_calls} paid answers, $${L.spent_usd.toFixed(2)} of a $${L.cap_usd.toFixed(2)} cap. Failed asks are shown too; they cost nothing and count as no evidence.</div>
<div class="card" style="overflow-x:auto"><table><tr><th>Purpose</th><th>Intent</th><th>Provider</th><th>Answer</th><th>Cost</th><th>Latency</th><th>Receipt / signal</th></tr>${calls}</table></div>
<div class="mut">Raw record: <a href="/api/run/${esc(id)}">/api/run/${esc(id)}</a></div>`));
}
