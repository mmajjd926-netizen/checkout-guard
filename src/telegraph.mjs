// Telegraph client with a hard spending cap and a per-call evidence ledger.
//
// Pays through an Anjoman API key (escrow rail): POST {API}/engine/ask[/minerId].
// Every answered call returns a payment record with a receipt hash; we keep it
// next to the answer so a reviewer can trace each fact to the request that bought it.

export const DEFAULT_API = 'https://backend.telegraphprotocol.com';
export const NODE = 'https://devnode.telegraphprotocol.com';

// The most one answer has cost us so far is $0.03. We reserve a bit more per call
// so the cap is never crossed even if a provider prices higher.
export const RESERVE_PER_CALL = 0.05;

export class BudgetExceeded extends Error {
  constructor(spent, cap) { super(`intelligence budget exhausted: spent $${spent.toFixed(2)} of $${cap.toFixed(2)}`); this.code = 'budget_exhausted'; }
}

export class Ledger {
  constructor(capUsd) { this.cap = capUsd; this.spent = 0; this.reserved = 0; this.calls = []; }
  // Calls run in parallel, so money already promised to in-flight calls counts too.
  // Without this, four parallel asks all saw spent=0 and together crossed the cap.
  canAfford() { return this.spent + this.reserved + RESERVE_PER_CALL <= this.cap + 1e-9; }
  reserve() { this.reserved = round(this.reserved + RESERVE_PER_CALL); }
  release() { this.reserved = Math.max(0, round(this.reserved - RESERVE_PER_CALL)); }
  record(call) { this.calls.push(call); this.spent = round(this.spent + (call.cost_usd || 0)); }
  summary() {
    const paid = this.calls.filter(c => c.cost_usd > 0);
    return { cap_usd: this.cap, spent_usd: this.spent, calls: this.calls.length, paid_calls: paid.length, failed_calls: this.calls.filter(c => !c.ok).length };
  }
}

const round = x => Math.round(x * 10000) / 10000;

export class Telegraph {
  constructor({ apiKey, api = DEFAULT_API, capUsd = 0.25, timeoutMs = 75000, fetchImpl = fetch } = {}) {
    if (!apiKey) throw new Error('TELEGRAPH_API_KEY is not set (create one at https://anjoman.ai/dashboard/api-keys)');
    this.apiKey = apiKey; this.api = api.replace(/\/$/, ''); this.timeoutMs = timeoutMs; this.fetch = fetchImpl;
    this.ledger = new Ledger(capUsd);
  }

  // Ask one Intent. `miner` pins a specific Provider (second opinion); otherwise the
  // network routes to its ranked supply. Never throws for provider errors: the
  // failure is part of the evidence.
  async ask(intent, params, { miner, purpose } = {}) {
    if (!this.ledger.canAfford()) throw new BudgetExceeded(this.ledger.spent, this.ledger.cap);
    this.ledger.reserve();
    const started = new Date();
    const url = `${this.api}/engine/ask${miner ? '/' + encodeURIComponent(miner) : ''}`;
    let http = 0, body = null, error = null;
    try {
      const r = await this.fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ intent, params }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      http = r.status;
      const text = await r.text();
      try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 300) }; }
      if (!r.ok) error = describeError(http, body);
    } catch (e) {
      error = e.name === 'TimeoutError' ? `timeout after ${this.timeoutMs} ms` : String(e.message || e);
    }
    const res = body?.result || null;
    const pay = res?.payments || [];
    const call = {
      purpose: purpose || intent,
      intent, params, pinned_miner: miner || null,
      ok: !error && !!res && res.delivery !== 'last_resort',
      http, error,
      miner_id: res?.miner_id ?? null,
      miner: res?.miner_name ?? null,
      delivery: res?.delivery ?? null,
      answer: res?.result ?? null,
      field_status: res?.field_status ?? null,
      warnings: res?.warnings ?? [],
      cost_usd: Number(res?.cost_usd_total ?? res?.cost_usd ?? 0) || 0,
      receipts: pay.map(p => ({ miner: p.miner, amount_uusdc: p.amount_uusdc, receipt_hash: p.receipt_hash })),
      signal_hash: res?.signal_hash ?? null,
      started_at: started.toISOString(),
      latency_ms: Date.now() - started.getTime(),
    };
    if (res?.delivery === 'last_resort') call.error = 'no Provider answered; the node fell back to a general model (not used as evidence)';
    this.ledger.release();
    this.ledger.record(call);
    return call;
  }

  // Ranked Providers for an Intent (free discovery call on the node).
  async providers(intent) {
    try {
      const r = await this.fetch(`${NODE}/engine/v1/intents/${encodeURIComponent(intent)}`, { signal: AbortSignal.timeout(45000) });
      const j = await r.json();
      return (j.miners || []).filter(m => m.compatible !== false).map(m => ({ id: String(m.id), slug: m.slug, name: m.name }));
    } catch { return []; }
  }

  // Free balance check (escrow) so the app can refuse to start with no money.
  async balance() {
    try {
      const r = await this.fetch(`${this.api}/engine/escrow/balance`, { headers: { authorization: `Bearer ${this.apiKey}` }, signal: AbortSignal.timeout(15000) });
      if (!r.ok) return { ok: false, http: r.status };
      return { ok: true, ...(await r.json()) };
    } catch (e) { return { ok: false, error: String(e.message || e) }; }
  }
}

function describeError(http, body) {
  const m = body?.message || body?.error || body?.raw || '';
  const msg = Array.isArray(m) ? m.join('; ') : String(m);
  if (http === 401 || http === 403) return `payment refused (HTTP ${http}): ${msg}`;
  if (http === 402) return `payment required (HTTP 402): escrow balance too low? ${msg}`;
  return `HTTP ${http}: ${msg.slice(0, 300)}`;
}
