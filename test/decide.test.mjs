// Decision rules, tested on recorded-shape answers (no network, no spending).
import test from 'node:test';
import assert from 'node:assert/strict';
import { decide, approve } from '../src/guard.mjs';
import { Telegraph, BudgetExceeded } from '../src/telegraph.mjs';

const NOW = new Date('2026-11-26T12:00:00Z');
const order = { product: 'Raspberry Pi 5 8GB', url: 'https://thepihut.com/products/raspberry-pi-5?variant=42531604955331', retailer: 'thepihut.com', maxPrice: 180, currency: 'GBP' };
const call = (purpose, answer, extra = {}) => ({ purpose, ok: true, answer, miner: purpose + '-provider', miner_id: purpose, receipts: [{ receipt_hash: '0x' + purpose }], cost_usd: 0.02, warnings: [], ...extra });
const good = () => ({
  stock_second: call('stock_second', { in_stock: true }),
  url_safety: call('url_safety', { verdict: 'Safe', detections: 0 }),
  price_ranked: call('price_ranked', { price: 168, currency: 'GBP', date: '2026-11-26' }),
  price_second: call('price_second', { price: 168, currency: 'GBP', date: '2026-11-26' }),
  stock: call('stock', { in_stock: true }),
});
const status = (d, id) => d.checks.find(c => c.id === id)?.status;

test('all evidence agrees and is within budget: READY, but nothing is bought', () => {
  const d = decide(order, good(), { now: NOW });
  assert.equal(d.decision, 'READY');
  assert.match(d.summary, /approval/);
});

test('malicious URL blocks the purchase', () => {
  const e = good(); e.url_safety = call('url_safety', { verdict: 'Malicious', detections: 3 });
  const d = decide(order, e, { now: NOW });
  assert.equal(d.decision, 'BLOCK');
  assert.equal(status(d, 'url_safety'), 'block');
});

test('wrong price: two Providers disagree, so wait for a person', () => {
  const e = good(); e.price_second = call('price_second', { price: 43.2, currency: 'GBP', date: '2026-11-26' });
  const d = decide(order, e, { now: NOW });
  assert.equal(d.decision, 'WAIT');
  assert.equal(status(d, 'price_agreement'), 'wait');
});

test('two out of three: an outlier is ignored when the other two agree', () => {
  const e = good();
  e.price_second = call('price_second', { price: 43.2, currency: 'GBP', date: '2026-11-26' });
  e.price_third = call('price_third', { price: 167.5, currency: 'GBP', date: '2026-11-26' });
  const d = decide(order, e, { now: NOW });
  assert.equal(status(d, 'price_agreement'), 'pass');
  assert.match(d.checks.find(c => c.id === 'price_agreement').detail, /outlier/);
  assert.equal(d.decision, 'READY');
});

test('price above the user limit waits', () => {
  const d = decide({ ...order, maxPrice: 80 }, good(), { now: NOW });
  assert.equal(d.decision, 'WAIT');
  assert.equal(status(d, 'within_budget'), 'wait');
});

test('stale price (observed four days ago) waits', () => {
  const e = good();
  e.price_ranked.answer.date = '2026-11-22'; e.price_second.answer.date = '2026-11-22';
  const d = decide(order, e, { now: NOW });
  assert.equal(status(d, 'price_fresh'), 'wait');
  assert.equal(d.decision, 'WAIT');
});

test('undated price is not treated as fresh', () => {
  const e = good(); e.price_ranked.answer.date = null; e.price_second.answer.date = null;
  assert.equal(status(decide(order, e, { now: NOW }), 'price_fresh'), 'wait');
});

test('stale stock: Providers disagree on stock, so wait; unknown stock waits', () => {
  const e = good(); e.stock = call('stock', { in_stock: false });
  assert.equal(status(decide(order, e, { now: NOW }), 'in_stock'), 'wait');
  e.stock = call('stock', { in_stock: null }); e.stock_second = call('stock_second', { in_stock: null });
  assert.equal(status(decide(order, e, { now: NOW }), 'in_stock'), 'wait');
});

test('stock: two of three in stock outvotes one stale "out of stock"', () => {
  const e = good(); e.stock = call('stock', { in_stock: false }); e.stock_third = call('stock_third', { in_stock: 'available' });
  assert.equal(status(decide(order, e, { now: NOW }), 'in_stock'), 'pass');
});

test('both Providers say out of stock: wait', () => {
  const e = good(); e.stock = call('stock', { in_stock: false }); e.stock_second = call('stock_second', { in_stock: 'Out of stock' });
  assert.match(decide(order, e, { now: NOW }).checks.find(c => c.id === 'in_stock').detail, /^Out of stock/);
});

test('a currency mismatch is never converted silently', () => {
  const e = good(); e.price_ranked.answer.currency = 'USD'; e.price_second.answer.currency = 'USD';
  assert.equal(status(decide(order, e, { now: NOW }), 'currency'), 'wait');
});

test('a failed Provider call is evidence of nothing', () => {
  const e = good(); e.url_safety = { purpose: 'url_safety', ok: false, error: 'timeout after 75000 ms', receipts: [], cost_usd: 0 };
  assert.equal(status(decide(order, e, { now: NOW }), 'url_safety'), 'wait');
});

test('exhausted intelligence budget waits instead of guessing', () => {
  const e = good(); delete e.stock;
  const d = decide(order, e, { now: NOW, budgetErrors: ['intelligence budget exhausted: spent $0.10 of $0.10'] });
  assert.equal(d.decision, 'WAIT');
  assert.equal(status(d, 'intelligence_budget'), 'wait');
});

test('approval: refused without an explicit name, refused unless READY', () => {
  const run = { order, decision: decide(order, good(), { now: NOW }), ledger: { calls: Object.values(good()) } };
  assert.equal(approve(run, {}).ok, false);
  const ok = approve(run, { approvedBy: 'alice', now: NOW });
  assert.equal(ok.ok, true); assert.equal(ok.simulated, true); assert.equal(ok.evidence_receipts.length, 5);
  const waitRun = { ...run, decision: decide({ ...order, maxPrice: 10 }, good(), { now: NOW }) };
  assert.equal(approve(waitRun, { approvedBy: 'alice' }).ok, false);
});

test('the client refuses to spend past its cap', async () => {
  let calls = 0;
  const fake = async () => { calls++; return new Response(JSON.stringify({ result: { miner_name: 'm', result: { verdict: 'Safe' }, cost_usd_total: 0.03, payments: [] } }), { status: 200 }); };
  const tg = new Telegraph({ apiKey: 'test', capUsd: 0.10, fetchImpl: fake });
  await tg.ask('URL_SAFE_GENERAL', { url: 'https://example.com' });
  await tg.ask('URL_SAFE_GENERAL', { url: 'https://example.com' });
  await assert.rejects(() => tg.ask('URL_SAFE_GENERAL', { url: 'https://example.com' }), BudgetExceeded);
  assert.equal(calls, 2);
  assert.equal(tg.ledger.spent, 0.06);
});

test('parallel asks cannot cross the cap together', async () => {
  // Regression: on 27 Nov a heartbeat tick with $0.06 left fired 4 asks at once;
  // each saw spent=0, all went through, and the tick spent $0.09.
  let calls = 0;
  const fake = async () => { calls++; await new Promise(r => setTimeout(r, 20)); return new Response(JSON.stringify({ result: { miner_name: 'm', result: { verdict: 'Safe' }, cost_usd_total: 0.03, payments: [] } }), { status: 200 }); };
  const tg = new Telegraph({ apiKey: 'test', capUsd: 0.06, fetchImpl: fake });
  const res = await Promise.allSettled([1, 2, 3, 4].map(() => tg.ask('URL_SAFE_GENERAL', { url: 'https://example.com' })));
  assert.equal(calls, 1);
  assert.equal(res.filter(r => r.status === 'rejected' && r.reason instanceof BudgetExceeded).length, 3);
  assert.ok(tg.ledger.spent <= 0.06);
  assert.equal(tg.ledger.reserved, 0);
});

test('a refused payment is recorded as a failure, not an answer', async () => {
  const fake = async () => new Response(JSON.stringify({ message: 'Invalid API key' }), { status: 401 });
  const tg = new Telegraph({ apiKey: 'bad', capUsd: 0.10, fetchImpl: fake });
  const c = await tg.ask('URL_SAFE_GENERAL', { url: 'https://example.com' });
  assert.equal(c.ok, false); assert.match(c.error, /payment refused/); assert.equal(c.cost_usd, 0);
});

test('return policy quoted from the store: shown as info, READY unchanged', () => {
  const e = good(); e.returns = call('returns', { returnable: null, return_window_days: 7, window_unit: 'working days', window_counts_from: 'delivery', return_shipping_paid_by: 'customer',
    evidence: ['…you can do so provided you inform us of your decision within 7 working days of receipt.'], policy_url: 'https://thepihut.com/policies/refund-policy' });
  const d = decide(order, e, { now: NOW });
  assert.equal(d.decision, 'READY');
  const c = d.checks.find(c => c.id === 'returns');
  assert.equal(c.status, 'info'); assert.match(c.detail, /7 working days from delivery \(you pay return postage\)/); assert.match(c.detail, /policies\/refund-policy/);
});

test('a store that takes no change-of-mind returns makes the buyer confirm first', () => {
  const e = good(); e.returns = call('returns', { returnable: false, return_window_days: null, days_remaining: null,
    evidence: ['…we are unable to offer any returns or exchanges for any other reasons.'], policy_url: 'https://colourpop.com/policies/refund-policy' });
  const d = decide(order, e, { now: NOW });
  assert.equal(d.decision, 'WAIT'); assert.equal(status(d, 'returns'), 'wait');
});

test('canonical Telegraph answer from Shelf Truth (conditions + verified + sources)', () => {
  const e = good(); e.returns = call('returns', { retailer: 'thepihut.com', return_window_days: 7, verified: true, sources: ['https://thepihut.com/policies/refund-policy'],
    conditions: ['Return window: 7 working days from delivery', 'Faulty or damaged items: 28 calendar days', 'Restocking fee: none stated in the policy', 'Return shipping paid by: customer',
      'Policy: "…provided you inform us of your decision within 7 working days of receipt."'] });
  const d = decide(order, e, { now: NOW });
  assert.equal(d.decision, 'READY');
  const c = d.checks.find(c => c.id === 'returns');
  assert.match(c.detail, /^Return window 7 working days from delivery \(Faulty or damaged items: 28 calendar days; Restocking fee: none stated in the policy; Return shipping paid by: customer\)\. Store policy: "…provided/);
  const n = good(); n.returns = call('returns', { retailer: 'colourpop.com', return_window_days: null, verified: true, sources: ['https://colourpop.com/policies/refund-policy'],
    conditions: ['No change-of-mind returns: only damaged or faulty items', 'Policy: "…unable to offer any returns or exchanges for any other reasons."'] });
  assert.equal(decide(order, n, { now: NOW }).decision, 'WAIT');
});

test('URL "Unknown" from one Provider and "Safe" from a second: passes, and says so', () => {
  const e = good(); e.url_safety = call('url_safety', { verdict: 'Unknown', detections: 0 }); e.url_second = call('url_second', { verdict: 'Safe', detections: 0 });
  const d = decide(order, e, { now: NOW });
  assert.equal(status(d, 'url_safety'), 'pass');
  assert.match(d.checks.find(c => c.id === 'url_safety').detail, /other Provider said "Unknown"/);
  assert.equal(d.decision, 'READY');
});

test('URL "Unknown" alone waits; any Provider flagging it blocks even if another says Safe', () => {
  const e = good(); e.url_safety = call('url_safety', { verdict: 'Unknown', detections: 0 });
  assert.equal(status(decide(order, e, { now: NOW }), 'url_safety'), 'wait');
  e.url_safety = call('url_safety', { verdict: 'Safe', detections: 0 }); e.url_second = call('url_second', { verdict: 'Suspicious', detections: 1 });
  assert.equal(status(decide(order, e, { now: NOW }), 'url_safety'), 'block');
});

test('a Provider that labels a GBP shop "$" is outvoted by two GBP answers; with no third answer it waits', () => {
  const e = good(); e.price_ranked = call('price_ranked', { price: 168, currency: '$', date: '2026-11-26' });
  const two = decide(order, e, { now: NOW });
  assert.equal(status(two, 'price_agreement'), 'wait');
  assert.match(two.checks.find(c => c.id === 'price_agreement').detail, /168\.00 \$ vs 168\.00 GBP/);
  e.price_third = call('price_third', { price: 169, currency: 'GBP', date: '2026-11-26' });
  const three = decide(order, e, { now: NOW });
  assert.equal(status(three, 'price_agreement'), 'pass');
  assert.equal(status(three, 'currency'), undefined);
  assert.equal(three.decision, 'READY');
});
