#!/usr/bin/env node
// checkout-guard: one purchase decision.
//
//   TELEGRAPH_API_KEY=anjoman_... node bin/guard.mjs \
//     --product "Raspberry Pi 5 8GB" --url https://thepihut.com/products/raspberry-pi-5 \
//     --max-price 80 --currency GBP [--intel-budget 0.25] [--approve "your name"] [--json]

import fs from 'node:fs';
import path from 'node:path';
import { Telegraph } from '../src/telegraph.mjs';
import { runCheck, approve, hostOf } from '../src/guard.mjs';
import { toMarkdown } from '../src/report.mjs';

const args = parseArgs(process.argv.slice(2));
if (args.help || !args.product || !args.url) {
  console.log(`Usage: checkout-guard --product <name/variant> --url <product page> --max-price <n> --currency <ISO>
       [--retailer <domain>] [--intel-budget <usd, default 0.25>] [--approve <name>] [--no-second-opinion] [--json] [--out runs/]`);
  process.exit(args.help ? 0 : 2);
}

const order = {
  product: args.product,
  url: args.url,
  retailer: args.retailer || hostOf(args.url),
  maxPrice: args['max-price'] !== undefined ? Number(args['max-price']) : undefined,
  currency: (args.currency || '').toUpperCase() || undefined,
};
const cap = Number(args['intel-budget'] ?? 0.25);
const tg = new Telegraph({ apiKey: process.env.TELEGRAPH_API_KEY, api: process.env.TELEGRAPH_API, capUsd: cap });

const bal = await tg.balance();
if (bal.ok && Number(bal.effectiveBalance ?? bal.escrowBalance ?? 0) < 0.05) {
  console.error(`Escrow balance is ${bal.effectiveBalance ?? bal.escrowBalance} USDC: too low to buy evidence. Top up at https://anjoman.ai/dashboard/faucet then deposit to escrow.`);
  process.exit(3);
}

process.stderr.write(`Buying evidence for "${order.product}" at ${order.retailer} (cap $${cap.toFixed(2)})...\n`);
const run = await runCheck(tg, order, { secondOpinion: !args['no-second-opinion'] });
if (args.approve !== undefined) run.approval = approve(run, { approvedBy: args.approve === true ? '' : args.approve });

const outDir = args.out || path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'runs');
fs.mkdirSync(outDir, { recursive: true });
const stamp = run.started_at.replace(/[:.]/g, '-').slice(0, 19);
const slug = order.product.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40).replace(/-$/, '');
const base = path.join(outDir, `${stamp}-${slug}`);
fs.writeFileSync(base + '.json', JSON.stringify(run, null, 2));
fs.writeFileSync(base + '.md', toMarkdown(run));

if (args.json) console.log(JSON.stringify(run, null, 2));
else console.log(toMarkdown(run));
process.stderr.write(`\nSaved ${base}.json and .md\n`);
process.exit(run.decision.decision === 'READY' ? 0 : run.decision.decision === 'WAIT' ? 10 : 20);

function parseArgs(a) {
  const o = {};
  for (let i = 0; i < a.length; i++) {
    if (!a[i].startsWith('--')) continue;
    const k = a[i].slice(2);
    if (a[i + 1] === undefined || a[i + 1].startsWith('--')) o[k] = true; else o[k] = a[++i];
  }
  return o;
}
