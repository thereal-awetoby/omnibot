// Pure helpers for the three detail views (Top holders, Dev, Lore). No Telegram, no network, no Solana library.
import { esc, formatUsd } from '@omnibot/shared';
import { formatDuration, formatCount } from './scan.js';

const ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const isAddr = (a) => typeof a === 'string' && ADDR_RE.test(a);
const short = (a) => `${a.slice(0, 4)}…${a.slice(-4)}`;
// A wallet as a tappable Solscan link (plain text when it is not a real address).
export const walletLink = (a) => (isAddr(a) ? `<a href="https://solscan.io/account/${a}">${short(a)}</a>` : esc(String(a).slice(0, 12)));
const name = (m) => (m?.symbol ? `$${esc(m.symbol)}` : 'this token');

// ---------- Dev: which tokens a wallet created ----------

// A parsed transaction (web3.js getParsedTransaction shape) -> mints created in it by `creator`.
// Only counts successful transactions that this wallet paid for, and reads the mint straight from
// the token program's "initializeMint" step, so it works for any launchpad.
export function createdMintsFromTx(tx, creator) {
  if (!tx || tx.meta?.err) return [];
  const keys = tx.transaction?.message?.accountKeys ?? [];
  const k0 = keys[0]?.pubkey ?? keys[0];
  const payer = typeof k0 === 'string' ? k0 : String(k0?.toBase58?.() ?? k0 ?? '');
  if (!creator || payer !== creator) return [];
  const steps = [
    ...(tx.transaction?.message?.instructions ?? []),
    ...(tx.meta?.innerInstructions ?? []).flatMap((i) => i.instructions ?? []),
  ];
  const mints = [];
  for (const ix of steps) {
    const p = ix?.parsed;
    if (p && typeof p.type === 'string' && p.type.startsWith('initializeMint') && isAddr(p.info?.mint)) mints.push(p.info.mint);
  }
  return [...new Set(mints)];
}

// launches: [{ mint, createdAt }]; markets: Map(mint -> market from DexScreener). Newest first.
export function mergeLaunches(launches, markets, currentMint) {
  return launches
    .filter((l) => l.mint !== currentMint)
    .map((l) => {
      const m = markets.get(l.mint);
      return {
        mint: l.mint,
        symbol: m?.symbol ?? l.symbol ?? null,
        createdAt: l.createdAt ?? m?.createdAt ?? null,
        marketCapUsd: m?.marketCapUsd ?? null,
      };
    })
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
}

// info: { creator, devPct, solBalance, launches: [...] | null, source: 'pump' | 'rpc' | null, scannedTx, total }
export function buildDevText({ market, creator, devPct, solBalance, launches, source, scannedTx, now = Date.now() }) {
  const lines = [`👨‍💻 <b>Dev</b> · ${name(market)}`];
  if (!creator) {
    lines.push('', 'The dev wallet for this token is not known yet. Try again in a minute.');
    return lines.join('\n');
  }
  const bits = [walletLink(creator)];
  if (typeof solBalance === 'number') bits.push(`◎ ${solBalance.toFixed(solBalance >= 10 ? 1 : 2)} SOL`);
  lines.push(bits.join('  ·  '));
  if (typeof devPct === 'number') lines.push(`Holds <b>${devPct.toFixed(devPct % 1 ? 1 : 0)}%</b> of this token`);
  lines.push('');

  if (!launches) {
    lines.push('🚀 <b>Other launches</b>', 'Could not load this wallet\'s launches right now. Tap Dev again in a moment.');
    return lines.join('\n');
  }
  if (!launches.length) {
    lines.push('🚀 <b>Other launches</b>', 'None found from this wallet.');
  } else {
    const over = launches.filter((l) => (l.marketCapUsd ?? 0) >= 100_000).length;
    const first = launches.map((l) => l.createdAt).filter(Boolean).sort((a, b) => a - b)[0];
    const firstAgo = first ? formatDuration(now - first) : null;
    const head = [`<b>${launches.length}</b> found`];
    if (over) head.push(`${over} now over $100K`);
    if (firstAgo) head.push(`earliest ${firstAgo} ago`);
    lines.push('🚀 <b>Other launches</b>', head.join(' · '), '');
    launches.slice(0, 8).forEach((l, i) => {
      const age = l.createdAt ? formatDuration(now - l.createdAt) : null;
      const label = l.symbol ? `$${esc(l.symbol)}` : `<code>${short(l.mint)}</code>`;
      lines.push(`${i + 1}. ${label} · ${l.marketCapUsd != null ? formatUsd(l.marketCapUsd) : 'no market data'}${age ? ` · ${age} ago` : ''}`);
    });
    if (launches.length > 8) lines.push(`…and ${launches.length - 8} more`);
  }
  if (source === 'rpc') lines.push('', `<i>Based on this wallet's last ${scannedTx} transactions.</i>`);
  return lines.join('\n');
}

// ---------- Top holders and what else they hold ----------

// tokens: [{ mint, amount (ui units) }]; prices: Map(mint -> { symbol, priceUsd, liquidityUsd }).
// Thinly traded pairs (under $1K liquidity) are not valued: their prices are not real.
export function valueHoldings(tokens, prices, excludeMint) {
  const priced = [];
  let other = 0;
  for (const t of tokens ?? []) {
    if (t.mint === excludeMint || !(t.amount > 0)) continue;
    const p = prices.get(t.mint);
    if (p?.priceUsd > 0 && (p.liquidityUsd ?? 0) >= 1000) priced.push({ mint: t.mint, symbol: p.symbol ?? null, usd: t.amount * p.priceUsd });
    else other += 1;
  }
  priced.sort((a, b) => b.usd - a.usd);
  return { top: priced.slice(0, 3), count: priced.length + other, totalUsd: priced.reduce((a, r) => a + r.usd, 0) };
}

// holders: [{ owner, pct, linked, sol (number|null), holdings (valueHoldings result | null) }]
export function buildHoldersText({ market, holders }) {
  const lines = [`👥 <b>Top holders</b> · ${name(market)}`, '<i>Pool and bonding curve are not counted.</i>', ''];
  if (!holders.length) {
    lines.push('Holder data is not available right now. Tap Top holders again in a moment.');
    return lines.join('\n');
  }
  holders.forEach((h, i) => {
    lines.push(`${i + 1}. ${walletLink(h.owner)}  <b>${h.pct.toFixed(1)}%</b>${h.linked ? ' 🔗' : ''}`);
    const bits = [];
    if (typeof h.sol === 'number') bits.push(`◎ ${h.sol.toFixed(h.sol >= 10 ? 1 : 2)} SOL`);
    if (h.holdings) {
      if (h.holdings.count) bits.push(`${formatCount(h.holdings.count)} other token${h.holdings.count === 1 ? '' : 's'}${h.holdings.totalUsd > 0 ? ` · ~${formatUsd(h.holdings.totalUsd)}` : ''}`);
      else bits.push('no other tokens');
    } else bits.push('holdings unavailable');
    lines.push(`   ${bits.join(' · ')}`);
    if (h.holdings?.top.length) lines.push(`   ${h.holdings.top.map((t) => `${t.symbol ? `$${esc(t.symbol)}` : 'token'} ${formatUsd(t.usd)}`).join(' · ')}`);
  });
  if (holders.some((h) => h.linked)) lines.push('', '<i>🔗 = flagged as linked to other wallets by RugCheck.</i>');
  return lines.join('\n');
}

// ---------- Lore ----------

// meta: { name, symbol, description } as the token's creator published it.
export function buildLoreText({ market, meta, now = Date.now(), detectedAt = null }) {
  const lines = [`📖 <b>Lore</b> · ${name(market)}`, ''];
  const d = meta?.description ? meta.description.replace(/\s+/g, ' ').trim() : '';
  if (d) {
    const text = d.length > 700 ? `${d.slice(0, 700).trimEnd()}…` : d;
    lines.push(`<blockquote>${esc(text)}</blockquote>`, '<i>Written by the token\'s creator. Accuracy not guaranteed.</i>');
  } else {
    lines.push('The creator did not publish a description for this token.');
  }
  if (detectedAt) lines.push('', `First seen ${formatDuration(now - detectedAt) ?? 'just now'} ago`);
  return lines.join('\n');
}
