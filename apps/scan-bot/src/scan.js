// Pure helpers for the Scan bot: text cards, price-change maths, alert rules. No Telegram, no network.
import { esc, formatUsd, formatPrice } from '@omnibot/shared';
import { callerHtml, isXCaller } from './callerlink.js';

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
// "🔗 Social  X · Telegram · Web": only safe http(s) links, no duplicates, at most 5.
export function buildSocialLine(market) {
  const links = [];
  for (const w of market.websites ?? []) links.push({ label: w.label && w.label.length <= 12 ? w.label : 'Web', url: w.url });
  for (const x of market.socials ?? []) links.push({ label: SOCIAL_NAMES[String(x.type).toLowerCase()] ?? String(x.type ?? 'Link').slice(0, 12), url: x.url });
  const parts = [];
  const seen = new Set();
  for (const l of links) {
    const href = safeUrl(l.url);
    if (!href || seen.has(href)) continue;
    seen.add(href);
    parts.push(`<a href="${href}">${esc(l.label)}</a>`);
    if (parts.length >= 5) break;
  }
  return `🔗 <b>Social</b>  ${parts.length ? parts.join(' · ') : '<i>none listed</i>'}`;
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

const LABEL_W = 9; // longest label is "DEX Paid" (8), so there is always a gap before the value
const lab = (t) => `<code>${t.padEnd(LABEL_W)}</code>`;
const row = (label, value) => `${lab(label)}${value}`;
const val = (t) => `<b>${t}</b>`;
const NA = '<i>n/a</i>';
// A row may span several lines ("\n"): the extra lines hang under it with a │ (or blank on the last row).
const tree = (rows) => rows.map((r, i) => {
  const last = i === rows.length - 1;
  const [first, ...more] = r.split('\n');
  return [`${last ? '└' : '├'} ${first}`, ...more.map((x) => `${last ? ' ' : '│'} ${x}`)].join('\n');
});
const pctText = (n, d = 1) => `${n.toFixed(d)}%`;

// Short rows on purpose: each one fits on a phone screen without wrapping.
function statsBlock(m, now, intel = null) {
  const rows = [];
  const d24 = m.change?.h24 ?? m.change24h;
  rows.push(row('Price', `${val(formatPriceCard(m.priceUsd))}${d24 != null ? `  (${shortPct(d24)})` : ''}`));
  const fdvDiffers = m.fdvUsd != null && m.marketCapUsd != null && Math.abs(m.fdvUsd - m.marketCapUsd) / Math.max(m.marketCapUsd, 1) > 0.01;
  rows.push(row('MCap', `${val(formatUsd(m.marketCapUsd))}${fdvDiffers ? `  ·  FDV ${formatUsd(m.fdvUsd)}` : ''}`));
  rows.push(row('Liq', val(formatUsd(m.liquidityUsd > 0 ? m.liquidityUsd : intel?.curve?.liquidityUsd ?? m.liquidityUsd))));
  // Volume: one window per line, aligned, so it reads as a small table.
  const vol = [];
  if (m.volume?.h1 != null) vol.push(['1h', m.volume.h1]);
  if (m.volume?.h24 != null) vol.push(['24h', m.volume.h24]);
  if (!vol.length && m.volume24h != null) vol.push(['24h', m.volume24h]);
  if (vol.length) rows.push(vol.map(([w, v], i) => `${i === 0 ? lab('Vol') : lab('')}→ ${w.padEnd(3)} ${formatUsd(v)}`).join('\n'));
  const h1 = m.change?.h1 ?? m.change1h;
  const t = m.txns?.h1;
  const hour = [];
  if (h1 != null) hour.push(shortPct(h1));
  if (t && t.buys + t.sells > 0) hour.push(`🟢 ${formatCount(t.buys)} · 🔴 ${formatCount(t.sells)}`);
  if (hour.length) rows.push(row('1H', hour.join(' · ')));
  const ath = intel?.ath;
  if (ath && ath.athMcapUsd != null) {
    const ago = formatDuration(now - ath.athAt);
    rows.push(row('ATH', `${val(formatUsd(ath.athMcapUsd))}  (${shortPct(ath.fromAthPct)})${ago ? ` · ${ago}` : ''}`));
  }
  return ['<b>📊 Stats</b>', ...tree(rows)];
}

// Facts only: numbers and on/off states, no ratings. Same rows every time, unknown values show n/a.
function securityBlock(sec, intel, market) {
  const rows = [];
  rows.push(row('Auth', sec ? `Mint ${sec.mintAuthority ? '⚠️ active' : '✅ off'} · Freeze ${sec.freezeAuthority ? '⚠️ active' : '✅ off'}` : NA));

  const lp = intel?.lpLockedPct;
  const curve = intel?.curve;
  // a token still on the pump.fun curve shows how full the curve is (RugCheck's "100% locked" for a curve is not a real lock)
  if (curve && !curve.complete) rows.push(row('LP', `${val('Bonding curve')} · ${Math.round(curve.progressPct)}% filled`));
  else if (!curve && market?.launchpadPct != null && market?.launchpadDone === false) rows.push(row('LP', `${val('Bonding curve')} · ${Math.max(1, Math.round(market.launchpadPct))}% filled`));
  else rows.push(row('LP', typeof lp === 'number' ? `${val(`${pctText(lp, lp % 1 ? 1 : 0)} locked/burned`)}${lp >= 90 ? ' ✅' : ''}` : NA));

  const dev = intel?.devPct;
  rows.push(row('Dev', typeof dev === 'number' ? (dev === 0 ? `${val('holds 0%')}  (sold or moved)` : val(`holds ${pctText(dev)}`)) : NA));

  const t10 = intel?.top10Pct;
  rows.push(row('Top 10', typeof t10 === 'number' ? `${val(pctText(t10))}  ·  largest ${pctText(intel.top1Pct)}` : NA));
  const top = (intel?.top ?? []).slice(0, 5);
  // Each number opens that holder's wallet page.
  const thNum = (h) => (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(h.owner ?? '') ? `<a href="https://solscan.io/account/${h.owner}">${h.pct.toFixed(1)}</a>` : h.pct.toFixed(1));
  if (top.length) rows.push(row('TH', top.map(thNum).join(' | ')));

  rows.push(row('Fresh', typeof intel?.fresh7dPct === 'number' ? `1D ${val(pctText(intel.fresh1dPct))} · 7D ${val(pctText(intel.fresh7dPct))}` : NA));
  const b = intel?.bundle;
  rows.push(row('Bundlers', !b ? NA : b.count === 0 ? 'none in top holders' : `${val(`${b.count} wallets`)} (${pctText(b.pct)}) · top holders`));
  if (market) rows.push(row('DEX Paid', market.hasProfile ? `${val('yes')} ✅` : 'no'));
  rows.push(row('Holders', typeof intel?.holdersTotal === 'number' ? val(Math.round(intel.holdersTotal).toLocaleString('en-US')) : NA));
  return ['<b>🛡 Security</b>', ...tree(rows)];
}

// The whole card in one go: nothing here says "loading", the bot waits until it has the data.
export function buildScanCard({ mint, market, security = null, intel = null, callLine = null, watched = false, now = Date.now() }) {
  if (!market) {
    const lines = [`🪙 <b>Unknown token</b>${watched ? '  ⭐' : ''}`, `<code>${mint}</code>`, '', 'No market data found yet (very new token, or not on a DEX).'];
    if (security || intel) lines.push('', ...securityBlock(security, intel, null));
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
    ...securityBlock(security, intel, market),
    '',
    buildSocialLine(market),
  ];
  if (callLine) lines.push('', callLine);
  return lines.join('\n');
}

// ---- group calls ----
const nameOf = (c) => (c?.caller_name ? (callerHtml(c.caller_name, c.caller_id, { at: String(c.caller_name).startsWith('@'), href: c.source_url }) || 'someone') : 'someone');

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
    lines.push(`${medals[i] ?? `${i + 1}.`} <b>${e.name ? callerHtml(e.name, e.callerId, { at: String(e.name).startsWith('@') }) : 'someone'}</b>  ·  avg ${fx(e.avg)}x  ·  best ${fx(e.best)}x  ·  ${e.hits}/${e.calls} hit 2x`);
  });
  lines.push('', '<i>Multiple = price now vs price when first called here.</i>');
  return lines.join('\n');
}

// ---- Group leaderboard for any time range (/leaderboard 1h, 20 minutes, 2 weeks, 1 month, all) ----
const UNIT = [
  [/^(m|min|mins|minute|minutes)$/, 60, 'minute'], [/^(h|hr|hrs|hour|hours)$/, 3600, 'hour'],
  [/^(d|day|days)$/, 86400, 'day'], [/^(w|wk|wks|week|weeks)$/, 7 * 86400, 'week'],
  [/^(mo|mos|month|months)$/, 30 * 86400, 'month'], [/^(y|yr|yrs|year|years)$/, 365 * 86400, 'year'],
];
const ALL_SECONDS = 20 * 365 * 86400;
// "1h", "20 minutes", "2w", "1 month", "all" -> { seconds, label }, or null when it is not a period. Empty text = last 24 hours.
export function parsePeriod(text) {
  const t = String(text ?? '').trim().toLowerCase();
  if (!t) return { seconds: 86400, label: '24h' };
  if (t === 'all' || t === 'alltime' || t === 'all time') return { seconds: ALL_SECONDS, label: 'All time' };
  const m = /^(\d{1,4})?\s*([a-z]+)$/.exec(t);
  if (!m) return null;
  const n = m[1] ? Number(m[1]) : 1;
  const u = UNIT.find(([re]) => re.test(m[2]));
  if (!u || n < 1) return null;
  const seconds = Math.min(n * u[1], ALL_SECONDS);
  return { seconds, label: `${n} ${u[2]}${n === 1 ? '' : 's'}` };
}

const median = (arr) => { const a = [...arr].sort((x, y) => x - y); const k = a.length >> 1; return a.length ? (a.length % 2 ? a[k] : (a[k - 1] + a[k]) / 2) : 0; };

// The best moment of every call (how high it went since it was called) and the group totals.
export function buildGroupBoard(calls, prices) {
  const rows = [];
  for (const c of calls) {
    const now = prices.get(c.mint)?.priceUsd;
    const best = Math.max(0, ...[Number(c.peak_price_usd), now].filter((v) => Number.isFinite(v) && v > 0));
    if (!(c.price_usd > 0) || !best) continue;
    const x = Math.max(1, best / c.price_usd);
    rows.push({ ...c, x, peakMcap: c.mcap_usd ? c.mcap_usd * x : null, peakPrice: c.price_usd * x });
  }
  const by = new Map();
  for (const r of rows) {
    const e = by.get(String(r.caller_id)) ?? { callerId: r.caller_id, name: null, calls: 0, hits: 0, sum: 0, best: 0 };
    e.name = e.name ?? r.caller_name; // newest first: the latest name
    e.calls += 1; e.sum += r.x; e.best = Math.max(e.best, r.x); if (r.x >= 2) e.hits += 1;
    by.set(String(r.caller_id), e);
  }
  const xs = rows.map((r) => r.x);
  const n = rows.length;
  return {
    rows,
    stats: n ? {
      calls: n, callers: by.size, avg: xs.reduce((a, b) => a + b, 0) / n, median: median(xs), best: Math.max(...xs),
      hit2: xs.filter((v) => v >= 2).length / n, hit5: xs.filter((v) => v >= 5).length / n,
    } : null,
    callers: [...by.values()].map((e) => ({ ...e, avg: e.sum / e.calls })).sort((a, b) => b.avg - a.avg || b.calls - a.calls),
    top: [...rows].sort((a, b) => b.x - a.x),
  };
}

const fmtX = (x) => (x >= 10 ? x.toFixed(0) : x.toFixed(1)) + 'x';
const pct = (v) => `${Math.round(v * 100)}%`;
export function buildGroupBoardText(board, { label = '24h', groupName = null, now = Date.now() } = {}) {
  const head = `🏆 <b>${groupName ? esc(groupName) : 'Group'}</b>  ·  last ${esc(label)}`;
  if (!board.stats) return `${head}\n\nNo calls in this time. Post a token address and the first person to do it gets the call.`;
  const s = board.stats;
  const medals = ['🥇', '🥈', '🥉'];
  const row = (k, v) => `${k.padEnd(8)}${v}`;
  const stats = [
    row('Period', label), row('Calls', s.calls), row('Callers', s.callers),
    row('Hit 2x', pct(s.hit2)), row('Hit 5x', pct(s.hit5)),
    row('Median', fmtX(s.median)), row('Average', fmtX(s.avg)), row('Best', fmtX(s.best)),
  ].map((l, i, all) => `${i === all.length - 1 ? '└' : '├'} ${l}`);
  const nm = (n, id) => (isXCaller(id) ? callerHtml(n, id, { at: false, max: 18 }) || 'someone' : esc(String(n ?? 'someone').replace(/^@/, '').slice(0, 18)));
  const callers = board.callers.slice(0, 5).map((e, i) =>
    `${medals[i] ?? `${i + 1}.`} ${nm(e.name, e.callerId)}\n   └ avg ${fmtX(e.avg)} · ${e.calls} call${e.calls === 1 ? '' : 's'} · 🎯 ${pct(e.hits / e.calls)}`);
  const best = board.top.slice(0, 10).map((r, i) => {
    const sym = esc(r.symbol ? `$${r.symbol}` : `${r.mint.slice(0, 4)}…`);
    const age = formatDuration(now - new Date(r.created_at).getTime()) ?? '';
    return `${medals[i] ?? `${i + 1}.`} <a href="https://dexscreener.com/solana/${r.mint}"><b>${sym}</b></a>  <code>${formatUsd(r.mcap_usd)} → ${formatUsd(r.peakMcap)}</code>  <b>Δ${fmtX(r.x)}</b>\n   └ ▲ ${age} ↦ ${nm(r.caller_name)}`;
  });
  return [
    head, '',
    '📊 <b>Group Stats</b>', `<pre>${stats.join('\n')}</pre>`, '',
    '👑 <b>Top Callers</b>', `<pre>${callers.join('\n')}</pre>`, '',
    '🔥 <b>Best Calls</b>', `<blockquote>${best.join('\n')}</blockquote>`, '',
    '<i>Multiple = the highest the token reached after the call.</i>',
  ].join('\n');
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
