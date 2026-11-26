# Checkout Guard

**A purchase agent that buys its evidence before it lets you buy anything.**

Shopping agents and checkout bots act on whatever price and stock they last saw. Checkout Guard asks the
[Telegraph](https://anjoman.ai/docs) network first, pays for each answer, and only then decides:

- **BLOCK**: the store URL is flagged by threat sources.
- **WAIT**: the price is above your limit, stale, undated, or two Providers disagree; the item is out of stock or the stock answers conflict; or the evidence budget ran out.
- **READY**: everything holds up. It still does nothing until you approve, and approval writes a *simulated* checkout record. It never pays a retailer.

Every fact in a decision links to the Telegraph Provider that answered, what it cost and its receipt or signal hash.

Built for Telegraph Season II: **Consumer Automation** (route 2, verified price-and-stock purchase) and **Personal Agent** (route 1, a heartbeat with a wallet budget, logging and limits). This is a hackathon entry with a prize incentive.

**Live demo:** https://mmajjd926-netizen.github.io/checkout-guard/ (forwards to the running instance; Telegraph testnet, test USDC) · **Video (3 min):** https://mmajjd926-netizen.github.io/checkout-guard/demo.mp4

## What one decision looks like

```
$ node bin/guard.mjs --product "Raspberry Pi 5 8GB" \
    --url "https://thepihut.com/products/raspberry-pi-5?variant=42531604955331" --max-price 180 --currency GBP

# Checkout Guard: WAIT
> Not yet: Providers disagree: GBP 168.00 vs GBP 43.20 (no two within 5 %). Often a different variant or a stale page; a person should look.

| Check           | Result | Detail                                                            |
| url_safety      | PASS   | URL not listed by threat sources (0 detections).                  |
| price_agreement | WAIT   | Providers disagree: GBP 168.00 vs GBP 43.20 ...                   |
| price_fresh     | PASS   | Price observed 2026-11-26 (within 48 h).                          |
| within_budget   | PASS   | Price GBP 168.00 is within your limit of GBP 180.00.              |
| in_stock        | PASS   | Provider reports the item in stock.                               |

## Evidence bought through Telegraph (6 paid answers, $0.10 of a $0.25 cap)
| price_ranked | LIVE_SHELF_PRICE_GENERAL | MetricWire Live Shelf Price      | price=168 ...  | $0.02 | 21.9 s | receipt 0xab7eb50884aa… |
| price_second | LIVE_SHELF_PRICE_GENERAL | PREFLIGHT Infrastructure Signals | price=43.2 ... | $0.01 | 12.6 s | signal 0xd2f3de45f84a…  |
...
```

The store's own page says the 8GB board costs £168.00; £43.20 is the 1GB variant. A bot trusting one answer
would either have bought at the wrong price or skipped a valid offer. The guard stopped and said why.

Recorded runs from the public demo are in [`evidence/`](evidence/) (JSON with every call, answer, cost, latency and receipt).

## How it works

```
your product page + price limit
        │
        ▼
paid Telegraph asks (escrow rail, API key)          rules
  URL_SAFE_GENERAL ──────────────────────────────►  Malicious/Suspicious → BLOCK
  LIVE_SHELF_PRICE_GENERAL  ranked + 2nd Provider ►  two prices within 5 %, else 3rd opinion, else WAIT
                            (pinned, exact URL)      observed ≤ 48 h, under your limit
  SKU_IN_STOCK_GENERAL      ranked + 2nd Provider ►  in stock, conflicts → 3rd opinion or WAIT
  RETURN_POLICY_VERIFY_GENERAL ──────────────────►  shown as a hint only (quality is weak)
        │
        ▼
BLOCK / WAIT / READY  →  explicit approval  →  simulated checkout record (with the receipt hashes)
```

- The second opinion is asked of a **different Provider** with the **exact product URL**, because the name alone often maps to the wrong variant.
- A hard **evidence budget** (default $0.25 per decision) is enforced before every call, not after.
- Failed asks (timeouts, HTTP 5xx, "no Provider answered" fallbacks to a general model) are recorded and count as *no evidence*.

## Run it yourself (about 10 minutes)

Prerequisites: Node.js 20 or newer, an Anjoman account (email, Google or wallet).

1. Sign in at https://anjoman.ai and claim test USDC at https://anjoman.ai/dashboard/faucet (5 USDC per day).
2. Deposit it to escrow (the faucet page shows an **Add to escrow** button; email accounts need no gas).
3. Create an API key at https://anjoman.ai/dashboard/api-keys.
4. Clone and run:

```bash
git clone https://github.com/mmajjd926-netizen/checkout-guard && cd checkout-guard
npm test                                   # 16 offline tests, no key, no spending
export TELEGRAPH_API_KEY=anjoman_...
node bin/guard.mjs --product "Raspberry Pi Pico 2 (without headers)" \
  --url "https://thepihut.com/products/raspberry-pi-pico-2?variant=54063366668673" \
  --max-price 6 --currency GBP
```

Expected: a decision in 30–60 seconds, about $0.08–0.12 of test USDC, and two files in `runs/` (`.json` with every call, `.md` report).
Exit codes: `0` READY, `10` WAIT, `20` BLOCK, so it can gate a script.

Approve a READY decision explicitly (refused if the decision is not READY or no name is given):

```bash
node bin/guard.mjs ... --approve "Alice"
```

Options: `--intel-budget 0.25` (USD cap for evidence), `--retailer thepihut.com`, `--no-second-opinion`, `--json`.

### Heartbeat: an always-on assistant with a wallet limit

```bash
node bin/heartbeat.mjs examples/pi5-watch.json            # runs forever, every 30 min
node bin/heartbeat.mjs examples/pi5-watch.json --once     # one tick
```

Each tick reuses its last answer while it is fresh (`freshMinutes`), buys new evidence when it is stale, never spends past
`dailyBudgetUsd`, logs every step to `*.log.jsonl`, and alerts once (console, or `notifyUrl` such as an ntfy topic) when the
decision turns READY. Buying still needs `--approve`. Tested cases: stale local answer, no budget left, refused payment
(bad key → HTTP 401, nothing decided), conflicting Providers.

### Host the web demo

```bash
TELEGRAPH_API_KEY=anjoman_... PORT=8788 node web/server.mjs
```

The server pays from its own key with hard caps (`PER_RUN_CAP` $0.15, `DAILY_CAP` $1.50, `PER_IP_DAILY` 6). No database; runs are JSON files in `runs/web/`.

## What we learned about the evidence (honest results)

From the runs on 26 November 2026 against a UK store whose own product data we checked by hand:

| Question | What Providers said | Store's own data |
|---|---|---|
| Pi 5 **8GB** price | £168.00 (MetricWire); £43.20 (PREFLIGHT, priced the 1GB variant); earlier £72 by name | £168.00 |
| Pi 5 **1GB** in stock? | yes (PREFLIGHT); no (ChainSight) | no |
| Pico 2 in stock? | no (TxLens, one run); yes (PREFLIGHT, TxLens other run) | yes |
| Return window | 14 or 30 days, "sources" were names of paper authors | (not checked) |

- Single-Provider price or stock answers were wrong often enough that **acting on one answer is not safe**. Requiring two independent Providers to agree turned those errors into WAIT instead of a wrong purchase.
- Supply is thin for retail: of 25 Providers listed for `LIVE_SHELF_PRICE_GENERAL`, two returned a price for this store; the rest failed or had no record. When no second opinion exists the guard says so.
- Answers take 5–60 s; a full decision costs $0.08–0.12 on testnet prices.
- Return-policy answers are not reliable enough to gate a purchase, so they are shown as hints.

## Tests

`npm test` runs 16 offline tests on the decision rules and the client:
READY needs approval · malicious URL blocks · wrong price (Providers disagree) waits · two-of-three outlier ignored ·
price above limit · stale and undated prices · stale stock (conflicting stock answers) · out of stock · currency mismatch
never converted silently · failed Provider call is no evidence · exhausted evidence budget · approval refused without a name
or unless READY · client refuses to spend past its cap · refused payment recorded as a failure.

## Limitations

- Testnet only (Ethereum Sepolia, test USDC). Prices of answers will differ on mainnet.
- Checkout is simulated by design. A real integration would hand the approval record to a store or card API.
- No currency conversion yet: a price in another currency waits instead of converting.
- Product URL with an explicit variant works best; marketplaces with dynamic pricing were not tested.

## Files

- `src/telegraph.mjs`: client, spending cap, evidence ledger
- `src/guard.mjs`: evidence gathering, second opinions, decision rules, approval
- `src/report.mjs`: Markdown report
- `bin/guard.mjs`, `bin/heartbeat.mjs`: CLIs
- `web/server.mjs`: public demo (no dependencies)

## License

MIT. Not an official Telegraph or Anjoman product.
