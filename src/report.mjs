// Human-readable report: decision first, then every fact with the Provider and receipt that backs it.

const ICON = { pass: 'PASS', wait: 'WAIT', block: 'BLOCK', info: 'INFO' };

export function toMarkdown(run) {
  const d = run.decision;
  const o = run.order;
  const L = run.ledger;
  const lines = [];
  lines.push(`# Checkout Guard: ${d.decision}`);
  lines.push('');
  lines.push(`**${o.product}** at ${o.retailer || o.url}  `);
  lines.push(`Limit: ${o.currency || ''} ${o.maxPrice ?? 'none'} · Checked ${run.started_at.replace('T', ' ').slice(0, 19)} UTC · Network: Telegraph testnet (Ethereum Sepolia, test USDC)`);
  lines.push('');
  lines.push(`> ${d.summary}`);
  lines.push('');
  lines.push('| Check | Result | Detail |');
  lines.push('|---|---|---|');
  for (const c of d.checks) lines.push(`| ${c.id} | ${ICON[c.status]} | ${c.detail.replace(/\|/g, '/')} |`);
  lines.push('');
  lines.push(`## Evidence bought through Telegraph (${L.paid_calls} paid answers, $${L.spent_usd.toFixed(2)} of a $${L.cap_usd.toFixed(2)} cap)`);
  lines.push('');
  lines.push('| Purpose | Intent | Provider | Answer | Cost | Latency | Receipt / signal |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const c of L.calls) {
    const ans = c.ok ? short(c.answer) : `failed: ${c.error || 'no answer'}`;
    const rec = c.receipts?.[0]?.receipt_hash ? `receipt \`${c.receipts[0].receipt_hash.slice(0, 14)}…\`` : c.signal_hash ? `signal \`${c.signal_hash.slice(0, 14)}…\`` : '-';
    lines.push(`| ${c.purpose} | ${c.intent} | ${c.miner || c.pinned_miner || '-'} | ${ans.replace(/\|/g, '/')} | $${c.cost_usd.toFixed(2)} | ${(c.latency_ms / 1000).toFixed(1)} s | ${rec} |`);
  }
  const warn = L.calls.filter(c => c.warnings?.length);
  if (warn.length) {
    lines.push('');
    lines.push('Provider warnings: ' + warn.map(c => `${c.purpose}: ${c.warnings.slice(0, 2).join('; ')}${c.warnings.length > 2 ? ` (+${c.warnings.length - 2})` : ''}`).join(' · '));
  }
  if (run.approval) {
    lines.push('');
    lines.push(`## Approval\n\n${run.approval.ok ? `Approved by ${run.approval.approved_by} at ${run.approval.approved_at}. ${run.approval.note}` : `Not approved: ${run.approval.reason}`}`);
  }
  lines.push('');
  lines.push('Receipts can be reconciled on `receipt_hash`; each answer also has a `signal_hash` that resolves at `https://devnode.telegraphprotocol.com/engine/v1/signal/<hash>`.');
  return lines.join('\n');
}

function short(a) {
  if (!a || typeof a !== 'object') return String(a);
  const keep = ['verdict', 'detections', 'price', 'currency', 'date', 'in_stock', 'quantity', 'return_window_days', 'verified'];
  const parts = keep.filter(k => k in a && a[k] !== null && a[k] !== undefined).map(k => `${k}=${a[k]}`);
  return parts.join(', ') || JSON.stringify(a).slice(0, 80);
}
