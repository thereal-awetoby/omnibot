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
  // A new token's mint address signs the transaction that creates it, and pump.fun mint addresses end in "pump".
  for (const k of keys) {
    const a = str(k?.pubkey ?? k);
    if (k?.signer && a !== creator && a.endsWith('pump') && isAddr(a)) mints.push(a);
  }
  for (const ix of steps) {
    const p = ix?.parsed;
    if (p && typeof p.type === 'string' && p.type.startsWith('initializeMint') && isAddr(p.info?.mint)) mints.push(p.info.mint);
    const m = pumpCreateMint(ix?.programId, ix?.accounts);
    if (m) mints.push(m);
  }
  return [...new Set(mints)];
}

const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const str = (x) => (x == null ? '' : String(x?.toBase58 ? x.toBase58() : x));
// pump.fun's "create" step lists the new mint first, and every pump.fun mint address ends in "pump".
function pumpCreateMint(programId, accounts) {
  if (str(programId) !== PUMP_PROGRAM) return null;
  const first = str(accounts?.[0]);
  return first.endsWith('pump') && isAddr(first) ? first : null;
}

// Helius "enhanced" transactions (100 per request, already decoded) -> launches [{ mint, createdAt }] made by `creator`.
export function createdMintsFromEnhanced(txs, creator) {
  const out = [];
  for (const tx of txs ?? []) {
    if (!tx || tx.transactionError || tx.feePayer !== creator) continue;
    const steps = [...(tx.instructions ?? []), ...(tx.instructions ?? []).flatMap((i) => i.innerInstructions ?? [])];
    for (const ix of steps) {
      const m = pumpCreateMint(ix?.programId, ix?.accounts);
      if (m && !out.some((o) => o.mint === m)) out.push({ mint: m, createdAt: tx.timestamp ? tx.timestamp * 1000 : null });
    }
  }
  return out;
}

// A wallet's oldest transaction (parsed) -> who first sent it SOL, how much, and when. null if not a plain transfer.
export function fundingFromTx(tx, owner) {
  const ixs = [...(tx?.transaction?.message?.instructions ?? []), ...((tx?.meta?.innerInstructions ?? []).flatMap((i) => i.instructions ?? []))];
  for (const ix of ixs) {
    const p = ix?.parsed;
    if (ix?.program !== 'system' || !p?.info) continue;
    const to = p.type === 'transfer' ? p.info.destination : (p.type === 'createAccount' || p.type === 'createAccountWithSeed') ? p.info.newAccount : null;
    if (to === owner && p.info.source && p.info.source !== owner) return { funder: p.info.source, sol: Number(p.info.lamports) / 1e9, at: tx.blockTime ? tx.blockTime * 1000 : null };
  }
  return null;
}

// Helius getAssetBatch answer -> Map(mint -> symbol). Tokens with no readable symbol are left out.
export function parseAssetNames(json) {
  const out = new Map();
  for (const a of Array.isArray(json?.result) ? json.result : []) {
    const sym = a?.content?.metadata?.symbol ?? a?.token_info?.symbol;
    const nm = a?.content?.metadata?.name;
    const label = typeof sym === 'string' && sym.trim() ? sym.trim() : typeof nm === 'string' && nm.trim() ? nm.trim() : null;
    if (a?.id && label) out.set(a.id, label.slice(0, 20));
  }
  return out;
}

// Helius getAsset answer -> the token's picture as an https link (ipfs:// links go through a public gateway), or null.
export function parseAssetImage(json) {
  const c = json?.result?.content;
  const file = Array.isArray(c?.files) ? c.files[0] : null;
  const pick = [file?.cdn_uri, c?.links?.image, file?.uri].find((u) => typeof u === 'string' && u.trim());
  return imageHttps(pick);
}
export function imageHttps(u) {
  if (typeof u !== 'string') return null;
  const x = u.trim();
  if (/^ipfs:\/\//i.test(x)) return `https://ipfs.io/ipfs/${x.slice(7).replace(/^ipfs\//i, '')}`;
  return /^https:\/\/[^\s]+$/i.test(x) ? x : null;
}
// The token's metadata json (content.json_uri) -> its image link, or null.
export function imageFromMetadata(meta) {
  return imageHttps(meta?.image) ?? imageHttps(meta?.image_uri) ?? imageHttps(meta?.properties?.files?.[0]?.uri);
}

// launches: [{ mint, createdAt }]; markets: Map(mint -> market from DexScreener). Newest first.
// The token being scanned stays in the list, flagged `current`.
export function mergeLaunches(launches, markets, currentMint) {
  const seen = new Set();
  return launches
    .filter((l) => (seen.has(l.mint) ? false : seen.add(l.mint)))
    .map((l) => {
      const m = markets.get(l.mint);
      return {
        mint: l.mint,
        symbol: m?.symbol ?? l.symbol ?? null,
        createdAt: l.createdAt ?? m?.createdAt ?? null,
        marketCapUsd: m?.marketCapUsd ?? null,
        current: l.mint === currentMint,
      };
    })
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
}

// Compact dollars for lists: $14.8K, $377, $0.12
export function usdShort(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return 'n/a';
  if (n >= 1000) return formatUsd(n);
  return n >= 1 ? `$${Math.round(n)}` : `$${n.toFixed(2)}`;
}

const launchLine = (l, now) => {
  const age = (l.createdAt ? formatDuration(now - l.createdAt) ?? '' : '').padEnd(4);
  const label = l.symbol ? esc(l.symbol) : short(l.mint);
  return `<code>${age}</code> <b>${label}</b> @ ${l.marketCapUsd != null ? usdShort(l.marketCapUsd) : 'n/a'}${l.current ? '  ◀ this token' : ''}`;
};

// launches: result of mergeLaunches (or null when they could not be loaded).
export function buildDevText({ market, creator, creatorFees = null, funding = null, devPct, solBalance, launches, source, scannedTx, partial = false, scanDone = false, scanning = false, now = Date.now() }) {
  if (!creator) return `👨‍💻 <b>Dev</b> · ${name(market)}\n\nThe dev wallet for this token is not known yet. Try again in a minute.`;
  const head = [`👨‍💻 ${walletLink(creator)}`];
  const facts = [];
  const dated = (launches ?? []).map((l) => l.createdAt).filter(Boolean);
  if (launches && launches.length >= 2 && dated.length >= 2) {
    const days = Math.max(1, (now - Math.min(...dated)) / 86_400_000);
    facts.push(`Deploys/day: <b>${(launches.length / days).toFixed(launches.length / days >= 10 ? 0 : 1)}</b>`);
  }
  if (funding?.funder) {
    const when = funding.at ? formatDuration(now - funding.at) : null;
    facts.push(`${walletLink(funding.funder)} funded <b>${funding.sol >= 1 ? funding.sol.toFixed(2) : funding.sol.toFixed(3)} SOL</b>${when ? ` <i>(${when} ago)</i>` : ''}`);
  }
  if (typeof solBalance === 'number') facts.push(`Balance: ◎ ${solBalance.toFixed(solBalance >= 10 ? 1 : 2)} SOL`);
  if (creatorFees && creatorFees !== creator) facts.push(`Fee wallet: ${walletLink(creatorFees)}`);
  if (typeof devPct === 'number') facts.push(`Holds <b>${devPct.toFixed(devPct % 1 ? 1 : 0)}%</b> of ${market?.symbol ? `$${esc(market.symbol)}` : 'this token'}`);
  facts.forEach((f, i) => head.push(`${i === facts.length - 1 ? '└' : '├'} ${f}`));
  const lines = [...head, ''];

  if (!launches) {
    lines.push('🔄 <b>Recent launches</b>', 'Could not load this wallet\'s launches right now. Tap Dev again in a moment.');
  } else if (!launches.length) {
    lines.push('🔄 <b>Recent launches</b>', 'None found from this wallet.');
  } else {
    const n = launches.length;
    lines.push(`🔄 <b>Recent launches</b> [${n}${source === 'pump' && n >= 50 ? '+' : ''}]`, `<blockquote>${launches.slice(0, 5).map((l) => launchLine(l, now)).join('\n')}</blockquote>`);
    const top = launches.filter((l) => l.marketCapUsd != null).sort((a, b) => b.marketCapUsd - a.marketCapUsd).slice(0, 5);
    if (top.length > 1) lines.push('', '🚀 <b>Top launches</b> (market cap now)', `<blockquote>${top.map((l) => launchLine(l, now)).join('\n')}</blockquote>`);
  }
  lines.push('', `<code>${creator}</code>`);
  if (scanDone && scannedTx > 0) lines.push(`<i>Read this wallet's full history (${scannedTx.toLocaleString('en-US')} transactions).</i>`);
  else if (scanning && scannedTx > 0) lines.push(`<i>Read ${scannedTx.toLocaleString('en-US')} transactions so far. This message updates by itself when the scan finishes.</i>`);
  else if (source === 'rpc' && scannedTx > 0) lines.push(`<i>Based on this wallet's last ${scannedTx} transactions.</i>`);
  else if (partial) lines.push('<i>Could not read this wallet\'s full history right now, so older launches may be missing. Tap Dev again in a moment.</i>');
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
// One small block per wallet: the share it holds on top, its details underneath.
export function buildHoldersText({ market, holders }) {
  const lines = [`👥 <b>Top holders</b> · ${name(market)}`, '<i>Pool and bonding curve are not counted.</i>', ''];
  if (!holders.length) {
    lines.push('Holder data is not available right now. Tap Top holders again in a moment.');
    return lines.join('\n');
  }
  holders.forEach((h, i) => {
    const rows = [];
    if (typeof h.sol === 'number') rows.push(`◎ ${h.sol.toFixed(h.sol >= 10 ? 1 : 2)} SOL`);
    if (!h.holdings) rows.push('Other tokens: unavailable');
    else if (!h.holdings.count) rows.push('No other tokens');
    else {
      rows.push(`${formatCount(h.holdings.count)} other token${h.holdings.count === 1 ? '' : 's'}${h.holdings.totalUsd > 0 ? ` · ~${usdShort(h.holdings.totalUsd)}` : ''}`);
      if (h.holdings.top.length) rows.push(h.holdings.top.slice(0, 2).map((t) => `${t.symbol ? `$${esc(t.symbol)}` : 'token'} ${usdShort(t.usd)}`).join(' · '));
    }
    lines.push(`<b>${i + 1}.</b> ${walletLink(h.owner)} · <b>${h.pct.toFixed(1)}%</b>${h.linked ? ' 🔗' : ''}`);
    rows.forEach((r, k) => lines.push(`${k === rows.length - 1 ? '└' : '├'} ${r}`));
    lines.push('');
  });
  if (holders.some((h) => h.linked)) lines.push('<i>🔗 = flagged as linked to other wallets by RugCheck.</i>');
  return lines.join('\n').trimEnd();
}

// ---------- Lore ----------

// narrative: AI-written story (or null). grounded: true when it came from a web search, false when the AI only had
// the token's own listing. meta: { name, symbol, description } as the creator published it.
// headlines: [{ title, url, source, at }] from the news search (may be empty).
export function buildLoreText({ market, narrative = null, grounded = true, meta, headlines = [], now = Date.now(), detectedAt = null, debugNote = null }) {
  const lines = [`📖 <b>Lore</b> · ${name(market)}`, ''];
  const clip = (t, n) => (t.length > n ? `${t.slice(0, n).trimEnd()}…` : t);
  const d = meta?.description ? meta.description.replace(/\s+/g, ' ').trim() : '';
  if (narrative) {
    lines.push(`<blockquote>${esc(clip(narrative.replace(/\s+/g, ' ').trim(), 800))}</blockquote>`,
      grounded ? '<i>Written by AI from a web search. Accuracy not guaranteed.</i>' : '<i>Written by AI from the token\'s own listing and linked post, no web search. Accuracy not guaranteed.</i>');
  } else if (d) {
    lines.push(`<blockquote>${esc(clip(d, 700))}</blockquote>`, '<i>Written by the token\'s creator. Accuracy not guaranteed.</i>');
  } else if (!headlines.length) {
    lines.push('The creator did not publish a description for this token.');
  }
  if (debugNote) lines.push('', `<i>AI summary unavailable: ${esc(String(debugNote).slice(0, 200))}</i>`);
  if (headlines.length) {
    lines.push('', '📰 <b>In the news</b>');
    for (const h of headlines.slice(0, 3)) {
      const ago = h.at ? formatDuration(now - h.at) : null;
      lines.push(`• <a href="${h.url.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}">${esc(clip(h.title, 110))}</a>${h.source || ago ? ` <i>(${[h.source ? esc(h.source) : null, ago ? `${ago} ago` : null].filter(Boolean).join(', ')})</i>` : ''}`);
    }
  }
  if (detectedAt) lines.push('', `First seen ${formatDuration(now - detectedAt) ?? 'just now'} ago`);
  return lines.join('\n');
}
