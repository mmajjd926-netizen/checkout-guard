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

test('a refused payment is recorded as a failure, not an answer', async () => {
  const fake = async () => new Response(JSON.stringify({ message: 'Invalid API key' }), { status: 401 });
  const tg = new Telegraph({ apiKey: 'bad', capUsd: 0.10, fetchImpl: fake });
  const c = await tg.ask('URL_SAFE_GENERAL', { url: 'https://example.com' });
  assert.equal(c.ok, false); assert.match(c.error, /payment refused/); assert.equal(c.cost_usd, 0);
});
