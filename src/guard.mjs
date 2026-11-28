// Checkout Guard: buy evidence through Telegraph, then decide BLOCK / WAIT / READY.
// READY never buys anything by itself: it asks the user for explicit approval.

import { BudgetExceeded } from './telegraph.mjs';

export const RULES = {
  priceAgreementPct: 5,      // two independent prices must agree within 5 %
  maxPriceAgeHours: 48,      // a dated price older than this is stale
  intents: {
    url: 'URL_SAFE_GENERAL',
    price: 'LIVE_SHELF_PRICE_GENERAL',
    stock: 'SKU_IN_STOCK_GENERAL',
    returns: 'RETURN_POLICY_VERIFY_GENERAL',
  },
};

// ---------------------------------------------------------------- gathering

export async function gather(tg, order, { secondOpinion = true, returns = true } = {}) {
  const { url, price, stock, returns: ret } = RULES.intents;
  const retailer = order.retailer || hostOf(order.url);
  const product = order.product;
  const tasks = {
    url_safety: () => tg.ask(url, { url: order.url }, { purpose: 'url_safety' }),
    price_ranked: () => tg.ask(price, { product, store: retailer }, { purpose: 'price_ranked' }),
    stock: () => tg.ask(stock, { sku: product, retailer }, { purpose: 'stock' }),
  };
  // Return policy: asked of a Provider that quotes the store's own published policy (Shelf Truth by default),
  // with the ranked Provider as the fallback when that one cannot answer.
  // Since the node's schema v3 (2026-11-27 20:17 UTC) this Intent takes exactly one param, `retailer`; any other
  // param (we used to send `store` and a free-text `question`) is refused with 400 before payment.
  if (returns) tasks.returns = async () => {
    const pinned = order.returnsMiner === null ? null : String(order.returnsMiner || '7310457');
    if (pinned) {
      const c = await tg.ask(ret, { retailer }, { miner: pinned, purpose: 'returns' });
      if (c.ok && (isNum(c.answer?.return_window_days) || c.answer?.returnable === false)) return c;
    }
    return tg.ask(ret, { retailer }, { purpose: 'returns' });
  };

  const evidence = {};
  const errors = [];
  await Promise.all(Object.entries(tasks).map(async ([k, f]) => {
    try { evidence[k] = await f(); } catch (e) { if (e instanceof BudgetExceeded) errors.push(e.message); else throw e; }
  }));

  // Second opinions: a different Provider, asked with the exact product URL (the URL pins
  // the variant; the name alone often does not). If the two disagree, buy one more opinion
  // and let two out of three decide.
  if (secondOpinion) {
    // URL safety: "Unknown" means a Provider had no data, not that the link is bad. Ask one other Provider then.
    if (!urlVerdictKnown(evidence.url_safety)) {
      await opinions(tg, evidence, errors, {
        intent: url, first: 'url_safety', slots: ['url_second'], params: { url: order.url },
        preferred: order.urlMiners || ['83159274', '20260828', '771353'], usable: urlVerdictKnown, disagree: () => false,
      });
    }
    await opinions(tg, evidence, errors, {
      intent: price, first: 'price_ranked', slots: ['price_second', 'price_third'],
      params: { product: order.url, store: retailer }, preferred: order.priceMiners || ['7310457', '20260828', '1900999010', '9002', '7310991'],
      usable: c => isNum(c.answer?.price), disagree: (a, b) => pctApart(a.answer.price, b.answer.price) > RULES.priceAgreementPct || !sameCurrency(a, b),
    });
    await opinions(tg, evidence, errors, {
      intent: stock, first: 'stock', slots: ['stock_second', 'stock_third'],
      params: { sku: order.url, retailer }, preferred: order.stockMiners || ['7310457', '302', '20260828', '9002'],
      usable: c => stockValue(c) !== null, disagree: (a, b) => stockValue(a) !== stockValue(b),
    });
  }
  return { evidence, errors };
}

// ---------------------------------------------------------------- deciding (pure)

export function decide(order, evidence, { now = new Date(), budgetErrors = [] } = {}) {
  const checks = [];
  const add = (id, status, detail, sources = []) => checks.push({ id, status, detail, sources });

  // 1. URL safety
  // Any Provider flagging the URL blocks; otherwise one "Safe" passes, and the other's "Unknown" is mentioned.
  const u = evidence.url_safety, u2 = evidence.url_second;
  const us = [u, u2].filter(c => c?.ok);
  const flagged = us.find(c => /malicious|suspicious/i.test(String(c.answer?.verdict || '')));
  const safe = us.find(c => /^safe$/i.test(String(c.answer?.verdict || '')));
  const uSrc = [...src(u), ...src(u2)];
  if (flagged) add('url_safety', 'block', `URL flagged as ${flagged.answer.verdict}${flagged.answer?.detections ? ` by ${flagged.answer.detections} source(s)` : ''}.`, uSrc);
  else if (safe) {
    const other = us.find(c => c !== safe);
    add('url_safety', 'pass', `URL not listed by threat sources (${safe.answer?.detections ?? 0} detections)${other ? `; the other Provider said "${other.answer?.verdict || 'Unknown'}"` : ''}.`, uSrc);
  } else if (!us.length) add('url_safety', 'wait', `No usable URL-safety answer${u?.error ? ` (${u.error})` : ''}.`, uSrc);
  else add('url_safety', 'wait', `URL safety is "${us.map(c => c.answer?.verdict || 'Unknown').join('" / "')}".`, uSrc);

  // 2. Price: present, fresh, and (when two Providers answered) consistent
  const prices = ['price_ranked', 'price_second', 'price_third'].map(k => evidence[k]).filter(c => c?.ok && isNum(c.answer?.price));
  const want = (order.currency || '').toUpperCase();
  if (prices.length === 0) add('price_found', 'wait', 'No Provider returned a price for this product and store.', [...src(evidence.price_ranked), ...src(evidence.price_second)]);
  else {
    let agreed = prices;
    if (prices.length >= 2) {
      const vals = prices.map(c => Number(c.answer.price));
      const pairs = [];
      for (let i = 0; i < vals.length; i++) for (let j = i + 1; j < vals.length; j++) pairs.push([i, j, pctApart(vals[i], vals[j])]);
      const ok = pairs.filter(p => p[2] <= RULES.priceAgreementPct && sameCurrency(prices[p[0]], prices[p[1]])).sort((a, b) => a[2] - b[2])[0];
      if (ok) {
        agreed = [prices[ok[0]], prices[ok[1]]];
        const outliers = prices.filter((_, k) => k !== ok[0] && k !== ok[1]);
        add('price_agreement', 'pass', `Two independent Providers agree within ${ok[2].toFixed(1)} %: ${fmt(vals[ok[0]], want)} and ${fmt(vals[ok[1]], want)}.` + (outliers.length ? ` Ignored outlier: ${outliers.map(c => `${Number(c.answer.price).toFixed(2)} ${c.answer.currency || '?'} from ${c.miner}`).join(', ')}.` : ''), prices.flatMap(src));
      } else {
        const named = prices.map(c => `${Number(c.answer.price).toFixed(2)} ${c.answer.currency || '?'}`);
        add('price_agreement', 'wait', `Providers disagree: ${named.join(' vs ')} (no two in the same currency within ${RULES.priceAgreementPct} %). Often a different variant, a stale page or a mislabelled currency; a person should look.`, prices.flatMap(src));
      }
    } else add('price_agreement', 'wait', `Only one Provider priced it (${fmt(prices[0].answer.price, want)}); a second opinion was not available.`, prices.flatMap(src));

    // Currency is judged on the answers actually used: a third opinion can outvote a Provider that labelled a GBP shop "$".
    const cur = agreed.map(c => String(c.answer.currency || '').toUpperCase()).filter(Boolean);
    const curOk = !want || cur.length === 0 || cur.every(c => c === want);
    if (!curOk) add('currency', 'wait', `Price quoted in ${[...new Set(cur)].join('/')}, budget is in ${want}; not converting silently.`, agreed.flatMap(src));

    const dated = agreed.map(c => ({ c, d: parseDate(c.answer.date) })).filter(x => x.d);
    if (dated.length === 0) add('price_fresh', 'wait', 'No Provider stated when the price was observed.', prices.flatMap(src));
    else {
      const newest = Math.max(...dated.map(x => x.d.getTime()));
      const ageH = (now.getTime() - newest) / 3600e3;
      if (ageH > RULES.maxPriceAgeHours) add('price_fresh', 'wait', `Newest price observation is ${Math.round(ageH)} h old (limit ${RULES.maxPriceAgeHours} h).`, dated.map(x => x.c).flatMap(src));
      else add('price_fresh', 'pass', `Price observed ${new Date(newest).toISOString().slice(0, 10)} (within ${RULES.maxPriceAgeHours} h).`, dated.map(x => x.c).flatMap(src));
    }
    const best = Math.max(...agreed.map(c => Number(c.answer.price)));  // be conservative: the higher of the agreeing prices
    if (isNum(order.maxPrice)) {
      if (best > order.maxPrice) add('within_budget', 'wait', `Price ${fmt(best, want)} is above your limit of ${fmt(order.maxPrice, want)}.`, prices.flatMap(src));
      else add('within_budget', 'pass', `Price ${fmt(best, want)} is within your limit of ${fmt(order.maxPrice, want)}.`, prices.flatMap(src));
    }
  }

  // 3. Stock: every usable answer must say "in stock"; any disagreement goes to a person
  const stocks = ['stock', 'stock_second', 'stock_third'].map(k => evidence[k]).filter(c => stockValue(c) !== null);
  const stockSrc = ['stock', 'stock_second', 'stock_third'].flatMap(k => src(evidence[k]));
  if (stocks.length === 0) add('in_stock', 'wait', `Stock is unknown${evidence.stock?.error ? ` (${evidence.stock.error})` : ''}.`, stockSrc);
  else {
    const yes = stocks.filter(c => stockValue(c) === true), no = stocks.filter(c => stockValue(c) === false);
    if (yes.length && no.length) {
      if (yes.length >= 2 && yes.length > no.length) add('in_stock', 'pass', `${yes.length} of ${stocks.length} Providers report it in stock (ignored: ${no.map(c => c.miner).join(', ')}).`, stockSrc);
      else add('in_stock', 'wait', `Providers disagree on stock: in stock per ${yes.map(c => c.miner).join(', ')}; out of stock per ${no.map(c => c.miner).join(', ')}.`, stockSrc);
    } else if (no.length) add('in_stock', 'wait', `Out of stock per ${no.map(c => c.miner).join(', ')}.`, stockSrc);
    else if (yes.length >= 2) add('in_stock', 'pass', `${yes.length} independent Providers report it in stock.`, stockSrc);
    else add('in_stock', 'pass', `Provider reports it in stock (${yes[0].miner}); no second opinion was available.`, stockSrc);
  }

  // 4. Return policy (informational: never blocks, but shown with a quality note)
  // A store that takes no change-of-mind returns is the one case that waits: the buyer should know before paying.
  const r = evidence.returns;
  const a = r?.ok ? r.answer || {} : {};
  // Through Telegraph the answer is canonical: { return_window_days, conditions, verified, sources }. Shelf Truth puts
  // summary lines first in conditions and the quoted policy sentences after them ("Policy: \"...\"").
  const conds = Array.isArray(a.conditions) ? a.conditions.map(String) : [];
  const policyUrl = typeof a.policy_url === 'string' ? a.policy_url : (Array.isArray(a.sources) && /^https?:\/\//.test(a.sources[0]) ? a.sources[0] : null);
  const firstQuote = (Array.isArray(a.evidence) && a.evidence[0]) || (conds.find(c => c.startsWith('Policy: ')) || '').replace(/^Policy: "?|"$/g, '');
  const quoted = !!(firstQuote && policyUrl && (a.verified === true || Array.isArray(a.evidence)));
  const quote = quoted ? ` Store policy: "${String(firstQuote).slice(0, 220)}" (${policyUrl})` : '';
  const noReturns = (a.returnable === false && a.days_remaining == null) || conds.some(c => /^No change-of-mind returns/.test(c));
  if (r?.ok && noReturns && quoted) {
    add('returns', 'wait', `This store does not accept change-of-mind returns; confirm you still want to buy.${quote}`, src(r));
  } else if (r?.ok && isNum(a.return_window_days)) {
    const weak = !quoted && (a.verified === false || looksLikeNoise(a.sources));
    const summary = conds.filter(c => !c.startsWith('Policy: ') && !/^Return window/.test(c));
    const extra = summary.length ? summary.join('; ') : [a.return_fee && `return fee ${a.return_fee}`, a.restocking_fee && `restocking fee ${a.restocking_fee}`,
      a.return_shipping_paid_by === 'customer' && 'you pay return postage'].filter(Boolean).join(', ');
    const head = conds.find(c => /^Return window/.test(c))?.replace(/^Return window: /, '') || `${a.return_window_days} ${a.window_unit || 'days'}${a.window_counts_from ? ` from ${a.window_counts_from}` : ''}`;
    add('returns', 'info', `Return window ${head}${extra ? ` (${extra})` : ''}.${quote}${weak ? ' (Provider marked it unverified or cited unrelated sources; treat as a hint)' : ''}`, src(r));
  }

  for (const e of new Set(budgetErrors)) add('intelligence_budget', 'wait', e);

  const status = checks.some(c => c.status === 'block') ? 'BLOCK' : checks.some(c => c.status === 'wait') ? 'WAIT' : 'READY';
  const why = checks.filter(c => c.status === (status === 'BLOCK' ? 'block' : 'wait')).map(c => c.detail);
  return {
    decision: status,
    summary: status === 'READY' ? 'All checks passed. Waiting for your explicit approval; nothing has been bought.'
      : status === 'BLOCK' ? `Do not buy: ${why.join(' ')}` : `Not yet: ${why.join(' ')}`,
    checks,
  };
}

// ---------------------------------------------------------------- approval (simulated checkout)

export function approve(result, { approvedBy, now = new Date() } = {}) {
  if (result.decision.decision !== 'READY') return { ok: false, reason: `Decision is ${result.decision.decision}; approval refused.` };
  if (!approvedBy) return { ok: false, reason: 'No explicit approval given; nothing was done.' };
  return {
    ok: true,
    simulated: true,
    note: 'Checkout is simulated: this record is what a real checkout integration would receive. No payment to the retailer was made.',
    order: { product: result.order.product, url: result.order.url, max_price: result.order.maxPrice, currency: result.order.currency },
    approved_by: approvedBy,
    approved_at: now.toISOString(),
    evidence_receipts: result.ledger.calls.flatMap(c => c.receipts.map(x => x.receipt_hash)),
  };
}

// ---------------------------------------------------------------- run

export async function runCheck(tg, order, opts = {}) {
  const started = new Date();
  const { evidence, errors } = await gather(tg, order, opts);
  const decision = decide(order, evidence, { budgetErrors: errors });
  return {
    app: 'checkout-guard', version: '0.1.0',
    order, started_at: started.toISOString(), finished_at: new Date().toISOString(),
    decision, ledger: { ...tg.ledger.summary(), calls: tg.ledger.calls },
  };
}


async function opinions(tg, evidence, errors, { intent, first, slots, params, preferred, usable, disagree }) {
  const used = new Set([String(evidence[first]?.miner_id)]);
  const candidates = await tg.providers(intent);
  // Preferred Providers are tried even if the discovery call failed; the rest of the ranked list follows.
  const queue = [...preferred.filter(id => !used.has(id)).map(id => candidates.find(c => c.id === id) || { id }), ...candidates.filter(c => !preferred.includes(c.id))];
  let failures = 0;
  const next = async slot => {
    while (queue.length && failures < 3) {
      const cand = queue.shift();
      if (used.has(cand.id)) continue;
      used.add(cand.id);
      let c;
      try { c = await tg.ask(intent, params, { miner: cand.id, purpose: slot }); }
      catch (e) { if (e instanceof BudgetExceeded) { errors.push(e.message); return null; } throw e; }
      if (c.ok && usable(c)) { evidence[slot] = c; return c; }
      failures++;
    }
    return null;
  };
  const second = await next(slots[0]);
  const base = evidence[first];
  if (second && base?.ok && usable(base) && disagree(base, second)) await next(slots[1]);
}

export function urlVerdictKnown(c) { return !!c?.ok && /^(safe|malicious|suspicious)$/i.test(String(c.answer?.verdict || '')); }
// Two prices are comparable only in the same currency (an unstated currency is not held against either).
export function sameCurrency(a, b) {
  const x = String(a?.answer?.currency || '').toUpperCase(), y = String(b?.answer?.currency || '').toUpperCase();
  return !x || !y || x === y;
}

export function stockValue(c) {
  if (!c?.ok) return null;
  const v = c.answer?.in_stock;
  if (v === true || /^(true|yes|in.?stock|available|1)$/i.test(String(v))) return true;
  if (v === false || /^(false|no|out.?of.?stock|unavailable|sold.?out|0)$/i.test(String(v))) return false;
  return null;
}

// ---------------------------------------------------------------- helpers

const pctApart = (a, b) => Math.abs(Number(a) - Number(b)) / Math.min(Number(a), Number(b)) * 100;
const isNum = x => typeof x === 'number' && Number.isFinite(x) || (typeof x === 'string' && x.trim() !== '' && Number.isFinite(Number(x)));
function src(c) { if (!c) return []; return [{ purpose: c.purpose, miner: c.miner, miner_id: c.miner_id, receipt: c.receipts?.[0]?.receipt_hash || null, signal_hash: c.signal_hash || null, cost_usd: c.cost_usd, error: c.error || null }]; }
function fmt(v, cur) { const n = Number(v); return `${cur ? cur + ' ' : ''}${n.toFixed(2)}`; }
function parseDate(d) { if (!d) return null; const t = new Date(d); return Number.isNaN(t.getTime()) ? null : t; }
export function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } }
function looksLikeNoise(sources) {
  // A return policy "source" should be a URL or a document title, not a list of people.
  if (!Array.isArray(sources) || sources.length === 0) return true;
  return sources.every(s => typeof s === 'string' && /^[A-Z][a-zé'-]+, [A-Z]/.test(s));
}
