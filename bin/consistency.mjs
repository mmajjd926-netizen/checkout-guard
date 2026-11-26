#!/usr/bin/env node
// Repeat-consistency check for a stock Provider: ask the same SKU_IN_STOCK_GENERAL question
// N times, pinned to one Provider, next to the store's own variant data (Shopify stores only).
// A Provider that reads the store gives the same answer every time; one that guesses flips.
//
//   TELEGRAPH_API_KEY=anjoman_... node bin/consistency.mjs <minerId> <shopify product URL with ?variant=> [N=3] [SKU]
//   e.g. node bin/consistency.mjs 302 'https://thepihut.com/products/raspberry-pi-5?variant=55037260890497' 3 SC2162
//
// Cost: N (or 2N with a SKU) paid asks, about $0.01 each on testnet. Output: one JSON line per ask.
import { Telegraph } from '../src/telegraph.mjs';
import { stockValue } from '../src/guard.mjs';

const [miner, url, nArg, sku] = process.argv.slice(2);
if (!miner || !url) { console.error('usage: consistency.mjs <minerId> <product URL with ?variant=> [N] [SKU]'); process.exit(2); }
const n = Math.max(1, Math.min(10, Number(nArg) || 3));
const u = new URL(url);
const variantId = u.searchParams.get('variant');
const retailer = u.hostname.replace(/^www\./, '');

const store = await (await fetch(`${u.origin}${u.pathname.replace(/\/$/, '')}.js`)).json();
const v = store.variants.find(x => String(x.id) === variantId);
if (!v) { console.error(`variant ${variantId} not found on ${u.origin}${u.pathname}`); process.exit(1); }
console.log(JSON.stringify({ at: new Date().toISOString(), store: { variant: v.id, title: v.title, sku: v.sku, available: v.available } }));

const tg = new Telegraph({ apiKey: process.env.TELEGRAPH_API_KEY, api: process.env.TELEGRAPH_API, capUsd: 0.05 * n * (sku ? 2 : 1) + 0.05 });
const tally = { agree: 0, disagree: 0, none: 0 };
for (const q of [url, sku].filter(Boolean)) {
  for (let i = 0; i < n; i++) {
    const c = await tg.ask('SKU_IN_STOCK_GENERAL', { sku: q, retailer }, { miner, purpose: 'consistency' });
    const got = stockValue(c);
    tally[got === null ? 'none' : got === v.available ? 'agree' : 'disagree']++;
    console.log(JSON.stringify({ at: c.started_at, sku: q, miner: c.miner, in_stock: got, store_available: v.available, signal_hash: c.signal_hash, cost_usd: c.cost_usd, error: c.error || undefined }));
  }
}
console.log(JSON.stringify({ summary: tally, spent_usd: tg.ledger.spent }));
