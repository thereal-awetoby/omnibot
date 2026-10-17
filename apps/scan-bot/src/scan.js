// Pure helpers for the Scan bot: text cards, price-change maths, alert rules. No Telegram, no network.
import { esc, formatUsd, formatPrice } from '@omnibot/shared';

const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const looksLikeMint = (s) => MINT_RE.test(String(s ?? '').trim());

// "/token <mint>" or a bare pasted mint -> mint, else null.
export function parseMintInput(text) {
  const m = /^(?:\/\w+(?:@\w+)?\s+)?([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(String(text ?? '').trim());
  return m ? m[1] : null;
}

// Percent change from `from` to `to` (e.g. 1 -> 1.25 = 25). null if either price is unusable.
export function changePct(from, to) {
  if (!(from > 0) || !(to > 0)) return null;
  return ((to - from) / from) * 100;
}

export function formatChange(pct) {
  if (typeof pct !== 'number' || !Number.isFinite(pct)) return 'n/a';
  const arrow = pct > 0 ? '🟢' : pct < 0 ? '🔴' : '⚪';
  return `${arrow} ${pct > 0 ? '+' : ''}${pct.toFixed(Math.abs(pct) >= 100 ? 0 : 1)}%`;
}

// Alert when the price moved at least alertPct up or down from the base price.
export function shouldAlert(basePrice, price, alertPct) {
  const c = changePct(basePrice, price);
  return c !== null && Math.abs(c) >= alertPct;
}

// alertPct typed by the user: 1 to 1000, up to one decimal.
export function parseAlertPct(raw) {
  const s = String(raw ?? '').trim().replace(/%$/, '');
  if (!/^\d+(\.\d)?$/.test(s)) return null;
  const n = Number(s);
  return n >= 1 && n <= 1000 ? n : null;
}

const symLabel = (m) => (m.symbol ? `$${esc(m.symbol)}` : 'Unknown');

// ---- small formatters ----
export function formatCount(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return 'n/a';
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}

export function shortPct(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return 'n/a';
  return `${n > 0 ? '+' : ''}${n.toFixed(Math.abs(n) >= 100 ? 0 : 1)}%`;
}

// ms duration -> "45m", "9h", "3d", "2mo", "1y"
export function formatDuration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return null;
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${Math.max(m, 1)}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 60) return `${d}d`;
  const mo = Math.floor(d / 30);
  return mo < 24 ? `${mo}mo` : `${Math.floor(d / 365)}y`;
}

// Only http(s) links, safe to put inside an HTML attribute.
export function safeUrl(u) {
  try {
    const url = new URL(String(u));
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.href.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  } catch { return null; }
}

const SOCIAL_NAMES = { twitter: 'X', x: 'X', telegram: 'Telegram', discord: 'Discord', website: 'Web' };
export function buildInfoLine(market) {
  const parts = [market.hasProfile ? '✅ DexScreener profile' : '▫️ No DexScreener profile'];
  const links = [];
  for (const w of market.websites ?? []) links.push({ label: w.label && w.label.length <= 12 ? w.label : 'Web', url: w.url });
  for (const x of market.socials ?? []) links.push({ label: SOCIAL_NAMES[String(x.type).toLowerCase()] ?? String(x.type ?? 'Link').slice(0, 12), url: x.url });
  const seen = new Set();
  for (const l of links) {
    const href = safeUrl(l.url);
    if (!href || seen.has(href)) continue;
    seen.add(href);
    parts.push(`<a href="${href}">${esc(l.label)}</a>`);
    if (seen.size >= 5) break;
  }
  return parts.join(' · ');
}

// ---- card layout ----
// Every row is "tree glyph + fixed-width monospace label + bold value", so the values line up in Telegram.
const SUB = '₀₁₂₃₄₅₆₇₈₉';
// Price for the card: 4 significant digits, and "$0.0₄2491" (4 zeros) for very small prices.
export function formatPriceCard(p) {
  if (typeof p !== 'number' || !(p > 0)) return 'n/a';
  if (p >= 1) return `$${p.toLocaleString('en-US', { maximumFractionDigits: p >= 100 ? 2 : 4 })}`;
  const [mant, exp] = p.toExponential(3).split('e');
  const zeros = -Number(exp) - 1;
  if (zeros < 4) return `$${Number(p.toPrecision(4))}`;
  return `$0.0${String(zeros).split('').map((d) => SUB[Number(d)]).join('')}${mant.replace('.', '')}`;
}

const LABEL_W = 8; // longest label is 7 characters, so there is always a gap before the value
const lab = (t) => `<code>${t.padEnd(LABEL_W)}</code>`;
const row = (label, value) => `${lab(label)}${value}`;
const val = (t) => `<b>${t}</b>`;
const NA = '<i>n/a</i>';
const tree = (rows) => rows.map((r, i) => `${i === rows.length - 1 ? '└' : '├'} ${r}`);
const lvl = (v, warnAt, badAt) => (v > badAt ? '⚠️' : v > warnAt ? '🟡' : '✅');
const pctText = (n, d = 1) => `${n.toFixed(d)}%`;

function statsBlock(m, now, intel = null) {
  const rows = [];
  const d24 = m.change?.h24 ?? m.change24h;
  rows.push(row('Price', `${val(formatPriceCard(m.priceUsd))}${d24 != null ? `  (${shortPct(d24)})` : ''}`));
  const fdvDiffers = m.fdvUsd != null && m.marketCapUsd != null && Math.abs(m.fdvUsd - m.marketCapUsd) / Math.max(m.marketCapUsd, 1) > 0.01;
  rows.push(row('MCap', `${val(formatUsd(m.marketCapUsd))}${fdvDiffers ? `  ·  FDV ${formatUsd(m.fdvUsd)}` : ''}`));
  const ratio = m.liquidityUsd > 0 && m.marketCapUsd > 0 ? `  ·  ${(m.marketCapUsd / m.liquidityUsd).toFixed(1)}x MCap/Liq` : '';
  rows.push(row('Liq', `${val(formatUsd(m.liquidityUsd))}${ratio}`));
  const v = m.volume;
  if (v && (v.m5 != null || v.h1 != null || v.h6 != null || v.h24 != null)) {
    rows.push(row('Vol', `5m ${formatUsd(v.m5)} · 1h ${formatUsd(v.h1)} · 24h ${formatUsd(v.h24)}`));
  } else if (m.volume24h != null) {
    rows.push(row('Vol', `24h ${formatUsd(m.volume24h)}`));
  }
  const t = m.txns?.h1;
  if (t && t.buys + t.sells > 0) {
    rows.push(row('1H', `🟢 ${formatCount(t.buys)} buys · 🔴 ${formatCount(t.sells)} sells  (${Math.round((t.buys / (t.buys + t.sells)) * 100)}% buys)`));
  }
  const c = m.change;
  if (c && (c.m5 != null || c.h1 != null || c.h6 != null || c.h24 != null)) {
    rows.push(row('Moves', `5m ${shortPct(c.m5)} · 1h ${shortPct(c.h1)} · 6h ${shortPct(c.h6)}`));
  } else if (m.change1h != null) {
    rows.push(row('Moves', `1h ${shortPct(m.change1h)}`));
  }
  const ath = intel?.ath;
  if (ath && ath.athMcapUsd != null) {
    const ago = formatDuration(now - ath.athAt);
    rows.push(row('ATH', `${val(formatUsd(ath.athMcapUsd))}  (${shortPct(ath.fromAthPct)}${ago ? ` · ${ago} ago` : ''})`));
  }
  return ['<b>📊 Stats</b>', ...tree(rows)];
}

// Same rows every time, so the card never changes shape: unknown values show n/a.
function securityBlock(sec, intel) {
  const rows = [];
  rows.push(row('Auth', sec ? `Mint ${sec.mintAuthority ? '⚠️ active' : '✅ off'} · Freeze ${sec.freezeAuthority ? '⚠️ active' : '✅ off'}` : NA));

  const lp = intel?.lpLockedPct;
  rows.push(row('LP', typeof lp === 'number' ? `${val(`${pctText(lp, lp % 1 ? 1 : 0)} locked/burned`)} ${lp >= 90 ? '✅' : lp >= 50 ? '🟡' : '⚠️'}` : NA));

  const dev = intel?.devPct;
  rows.push(row('Dev', typeof dev === 'number'
    ? (dev === 0 ? `${val('holds 0%')} ✅  (sold or moved)` : `${val(`holds ${pctText(dev)}`)} ${lvl(dev, 5, 15)}`)
    : NA));

  const t10 = intel?.top10Pct;
  rows.push(row('Top 10', typeof t10 === 'number'
    ? `${val(pctText(t10))} ${lvl(t10, 30, 50)}  ·  largest ${pctText(intel.top1Pct)} ${lvl(intel.top1Pct, 10, 20)}`
    : NA));
  const top = (intel?.top ?? []).slice(0, 5);
  if (top.length) rows.push(row('TH', top.map((h) => h.pct.toFixed(1)).join(' | ')));

  const ip = intel?.insiderPct;
  if (typeof ip === 'number' || intel?.insiderNetworks) {
    let txt;
    if (typeof ip === 'number' && ip > 0) txt = `${val(pctText(ip))} ${lvl(ip, 10, 20)}${intel.insiderNetworks ? `  (${intel.insiderNetworks} linked group${intel.insiderNetworks > 1 ? 's' : ''})` : ''}`;
    else if (intel.insiderNetworks) txt = `${val(`${intel.insiderNetworks} linked group${intel.insiderNetworks > 1 ? 's' : ''}`)} 🟡${intel.insiderWallets ? `  (${intel.insiderWallets} wallets)` : ''}`;
    else txt = `${val('none detected')} ✅`;
    rows.push(row('Insider', txt));
  } else {
    rows.push(row('Insider', NA));
  }

  rows.push(row('Fresh', typeof intel?.fresh7dPct === 'number'
    ? `1D ${val(pctText(intel.fresh1dPct))} · 7D ${val(pctText(intel.fresh7dPct))}  (top ${intel.walletsChecked})`
    : NA));
  rows.push(row('Holders', typeof intel?.holdersTotal === 'number' ? val(Math.round(intel.holdersTotal).toLocaleString('en-US')) : NA));
  return ['<b>🛡 Security</b>', ...tree(rows)];
}

const RISK_LABEL = { low: '🟢 LOW', medium: '🟡 MEDIUM', high: '🔴 HIGH' };
function riskBlock(risk) {
  if (!risk) return [];
  const lines = [`<b>⚖️ Risk: ${RISK_LABEL[risk.level]}</b>${risk.partial ? '  <i>(on-chain checks missing)</i>' : ''}`];
  for (const f of risk.flags.slice(0, 5)) lines.push(`▫️ ${esc(f)}`);
  if (!risk.flags.length) lines.push('▫️ No red flags found in the data we can see');
  lines.push('<i>Rule-based check on public data. Not advice.</i>');
  return lines;
}

export function buildScanCard({ mint, market, security = null, intel = null, risk = null, callLine = null, loading = false, watched = false, now = Date.now() }) {
  if (!market) {
    const lines = [`🪙 <b>Unknown token</b>${watched ? '  ⭐' : ''}`, `<code>${mint}</code>`, '', 'No market data found yet (very new token, or not on a DEX).'];
    if (!loading && (security || intel)) lines.push('', ...securityBlock(security, intel), '', ...riskBlock(risk));
    if (callLine) lines.push('', callLine);
    return lines.join('\n');
  }
  const age = formatDuration(typeof market.createdAt === 'number' ? now - market.createdAt : NaN);
  const sub = ['Solana', market.dex ? esc(market.dex) : null, age ? `🌱 ${age}` : null, market.boosts > 0 ? `🔥 ${market.boosts}` : null].filter(Boolean).join(' · ');
  const lines = [
    `🪙 <b>${symLabel(market)}</b>${market.name ? ` · ${esc(market.name)}` : ''}${watched ? '  ⭐' : ''}`,
    `└ ${sub}`,
    `<code>${mint}</code>`,
    '',
    ...statsBlock(market, now, intel),
    '',
    ...(loading ? ['⏳ <i>Running safety scan: holders, insiders, LP, dev…</i>'] : [...securityBlock(security, intel), '', ...riskBlock(risk)]),
    '',
    buildInfoLine(market),
  ];
  if (callLine) lines.push('', callLine);
  return lines.join('\n');
}

// ---- group calls ----
const nameOf = (c) => (c?.caller_name ? esc(c.caller_name) : 'someone');

export const multiple = (from, to) => (from > 0 && to > 0 ? to / from : null);
const multText = (x) => (x === null ? '' : `  ·  now ${x >= 10 ? x.toFixed(0) : x.toFixed(2)}x ${x >= 2 ? '🚀' : x < 1 ? '🔻' : ''}`.trimEnd());

// The "First call" line shown at the bottom of a card in a group.
export function buildCallLine(call, priceNow) {
  if (!call) return null;
  return `🔥 First call: <b>${nameOf(call)}</b> @ ${formatUsd(call.mcap_usd)}${multText(multiple(call.price_usd, priceNow))}`;
}

// calls: rows from listChatCalls; prices: Map(mint -> { priceUsd }). Ranked by average multiple.
export function buildLeaderboard(calls, prices) {
  const by = new Map();
  for (const c of calls) {
    const x = multiple(c.price_usd, prices.get(c.mint)?.priceUsd);
    if (x === null) continue;
    const e = by.get(String(c.caller_id)) ?? { callerId: c.caller_id, name: null, calls: 0, hits: 0, best: 0, sum: 0 };
    e.name = e.name ?? c.caller_name; // rows are newest first: keep the latest name
    e.calls += 1; e.sum += x; e.best = Math.max(e.best, x);
    if (x >= 2) e.hits += 1;
    by.set(String(c.caller_id), e);
  }
  return [...by.values()].map((e) => ({ ...e, avg: e.sum / e.calls })).sort((a, b) => b.avg - a.avg);
}

const fx = (x) => (x >= 10 ? x.toFixed(0) : x.toFixed(2));
export function buildLeaderboardText(board, days = 30) {
  if (!board.length) return 'No calls yet in this group. Post a token address and the first person to do it gets the call.';
  const medals = ['🥇', '🥈', '🥉'];
  const lines = [`<b>🏆 Leaderboard</b>  ·  last ${days} days`, ''];
  board.slice(0, 10).forEach((e, i) => {
    lines.push(`${medals[i] ?? `${i + 1}.`} <b>${e.name ? esc(e.name) : 'someone'}</b>  ·  avg ${fx(e.avg)}x  ·  best ${fx(e.best)}x  ·  ${e.hits}/${e.calls} hit 2x`);
  });
  lines.push('', '<i>Multiple = price now vs price when first called here.</i>');
  return lines.join('\n');
}

export function buildUserCallsText(calls, prices, who, now = Date.now()) {
  if (!calls.length) return 'You have no calls in this group yet. Post a token address that nobody has called.';
  const lines = [`<b>📣 Calls by ${esc(who)}</b>`, ''];
  for (const c of calls) {
    const x = multiple(c.price_usd, prices.get(c.mint)?.priceUsd);
    const age = formatDuration(now - new Date(c.created_at).getTime()) ?? '';
    lines.push(`${c.symbol ? `$${esc(c.symbol)}` : `<code>${c.mint.slice(0, 4)}…${c.mint.slice(-4)}</code>`}  @ ${formatUsd(c.mcap_usd)}${multText(x)}  ·  ${age} ago`);
  }
  return lines.join('\n');
}

// First token address found anywhere in a chat message (for groups), else null.
export function extractMint(text) {
  const m = /(?<![1-9A-HJ-NP-Za-km-z])[1-9A-HJ-NP-Za-km-z]{32,44}(?![1-9A-HJ-NP-Za-km-z])/.exec(String(text ?? ''));
  return m ? m[0] : null;
}

export function buildTrendingText(tokens) {
  if (!tokens.length) return 'Nothing trending right now. Try again in a minute.';
  const lines = ['<b>🔥 Trending on Solana</b>', '<i>Most boosted on DexScreener</i>', ''];
  tokens.forEach((t, i) => {
    lines.push(`${i + 1}. ${symLabel(t)}  ·  MCap ${formatUsd(t.marketCapUsd)}  ·  24h ${formatChange(t.change24h)}`);
  });
  lines.push('', 'Tap a token to open its card.');
  return lines.join('\n');
}

// rows: watchlist rows; prices: Map(mint -> market). Shows change since added.
export function buildWatchlistText(rows, prices) {
  if (!rows.length) return 'Your watchlist is empty. Open a token and tap ⭐ Watch, or use /watch <address>.';
  const alertPct = rows[0].alert_pct;
  const lines = ['<b>⭐ Watchlist</b>', ''];
  for (const r of rows) {
    const m = prices.get(r.mint);
    const name = r.symbol ? `$${esc(r.symbol)}` : `<code>${r.mint.slice(0, 4)}…${r.mint.slice(-4)}</code>`;
    lines.push(m?.priceUsd ? `${name}  ${formatPrice(m.priceUsd)}  ·  since added ${formatChange(changePct(r.added_price_usd, m.priceUsd))}` : `${name}  price n/a`);
  }
  lines.push('', `Alerts fire when a token moves ±${alertPct}% from its last alert price. Change it with /alertpct 30.`);
  return lines.join('\n');
}

export function buildAlertText(row, price) {
  const c = changePct(row.base_price_usd, price);
  const name = row.symbol ? `$${esc(row.symbol)}` : `<code>${row.mint.slice(0, 4)}…${row.mint.slice(-4)}</code>`;
  return `🔔 <b>${name}</b> moved ${formatChange(c)}\n${formatPrice(row.base_price_usd)} → ${formatPrice(price)}\n<code>${row.mint}</code>`;
}
