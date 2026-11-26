# Tutorial: an agent that pays for evidence and refuses to act on one answer

This walks through the four ideas that make Checkout Guard safe to leave running, with the code that does each one.
They are not specific to shopping: any agent that buys Telegraph intelligence and then *acts* can reuse them.
Everything here runs on the Telegraph testnet with test USDC; the numbers come from our runs on 26 November 2026.

You need Node.js 20+, an Anjoman account, test USDC in escrow and an API key (see the README, "Run it yourself").

## 1. One paid ask, with the escrow rail

An API key pays from your escrow balance, so the agent needs no wallet or gas:

```js
const r = await fetch('https://backend.telegraphprotocol.com/engine/ask', {
  method: 'POST',
  headers: { authorization: `Bearer ${process.env.TELEGRAPH_API_KEY}`, 'content-type': 'application/json' },
  body: JSON.stringify({ intent: 'URL_SAFE_GENERAL', params: { url: 'https://thepihut.com/' } }),
  signal: AbortSignal.timeout(75000),
});
const { result } = await r.json();
// result.result         the answer in the Intent's schema
// result.miner_id/name  the Provider that answered
// result.cost_usd_total what it cost
// result.payments[]     one receipt_hash per payment
// result.signal_hash    re-read the stored answer at https://devnode.telegraphprotocol.com/engine/v1/signal/<hash>
```

Append `/<minerId>` to the path (`/engine/ask/20260828`) to pin a specific Provider. That is how the second opinion below works.

Answers take 5 to 60 seconds (median about 19 s in our runs). Use a long timeout, and do not retry blindly: a retry is a second payment.

## 2. A cap that is checked *before* each call

Checking the total after a call means the call that crosses the line has already been paid. Reserve a worst-case
price per call and refuse up front (`src/telegraph.mjs`):

```js
export const RESERVE_PER_CALL = 0.05;              // our most expensive answer so far was $0.03
canAfford() { return this.spent + RESERVE_PER_CALL <= this.cap; }

async ask(intent, params, { miner } = {}) {
  if (!this.ledger.canAfford()) throw new BudgetExceeded(this.ledger.spent, this.ledger.cap);
  ...
}
```

The heartbeat (`bin/heartbeat.mjs`) adds a second, daily cap on top: each tick computes
`min(perCheckCapUsd, dailyBudgetUsd - spentToday)` and buys nothing if that is below one call's reserve.

## 3. Failures are evidence, not exceptions

A Provider error should not crash the agent, and it must never be mistaken for an answer. Every call, good or bad,
goes into the ledger with its HTTP status and reason, and only `ok` calls count as evidence:

```js
ok: !error && !!res && res.delivery !== 'last_resort',
```

`delivery: "last_resort"` deserves a special mention: when no Provider answers, the node can fall back to a general
model and still return a well-formed answer. For a purchase decision that is not evidence, so we record it as a failure.
In our 8 recorded decisions, 7 of 51 calls failed (timeouts, HTTP 5xx, fallbacks); each one is in `evidence/` with its reason.

Other failures worth handling explicitly: HTTP 401/403 (bad or revoked key: stop, decide nothing), HTTP 402 (escrow too low).

## 4. Never act on one answer

This is the finding that shaped the app. For a Raspberry Pi 5 **8GB** (GBP 168.00 on the store), the ranked Provider
answered GBP 168.00, but a second Provider, given the exact variant URL, answered GBP 43.20: the price of the **1GB**
variant (filed as [telegraphprotocol/bounties#239](https://github.com/telegraphprotocol/bounties/issues/239)). Stock answers for the
same store also disagreed. An agent trusting one routed answer would have acted on a price that does not exist.

So every fact that triggers an action needs two independent Providers (`src/guard.mjs`):

1. Ask the ranked route by product name.
2. List the Intent's Providers (free: `GET https://devnode.telegraphprotocol.com/engine/v1/intents/<INTENT>`), skip the one that
   already answered, and **pin** the next one (Providers that have answered this Intent for us before go first) with the **exact URL** (names map to the wrong variant surprisingly often).
3. Accept a price only if two answers agree within 5 %. Otherwise buy a third opinion if the budget allows; otherwise WAIT.
4. Stock: two answers must agree; a conflict is WAIT, never a coin toss.

The decision rules are pure functions over the ledger, so they are tested offline (`npm test`, 16 cases) without spending anything.

## What it costs

A full decision (URL safety, two prices, two stock answers, a return-policy hint) costs $0.08 to $0.12 of test USDC and
takes 30 to 60 seconds. Supply for retail Intents is thin: of 25 Providers listed for `LIVE_SHELF_PRICE_GENERAL`, two returned
a price for this UK store. When no second opinion exists, the guard says so and waits.

## Try it

- In the browser, no account: https://mmajjd926-netizen.github.io/checkout-guard/
- From the command line: README, "Run it yourself" (about 10 minutes).
- The unattended heartbeat log, with every receipt: [`evidence/heartbeat/`](../evidence/heartbeat/).

If you build something on these pieces, or find a Provider answer that is wrong, open an issue here or on
[telegraphprotocol/bounties](https://github.com/telegraphprotocol/bounties/issues). The Telegraph docs are at https://anjoman.ai/docs.
