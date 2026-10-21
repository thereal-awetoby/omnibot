import { hierarchy, treemap, treemapSquarify } from 'd3-hierarchy';
import { esc } from '@omnibot/shared';

// ---------- Market data from CoinGecko (free): heatmap, best / worst ----------
const PERIODS = { '1h': '1h', '24h': '24h', '1d': '24h', '7d': '7d', '1w': '7d', '14d': '14d', '30d': '30d', '1m': '30d', '1y': '1y' };
export const normPeriod = (t, dflt = '24h') => PERIODS[String(t ?? '').toLowerCase()] ?? dflt;

let coinCache = { at: 0, list: null };
export function parseCoins(body) {
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return (Array.isArray(body) ? body : []).filter((c) => c && typeof c.symbol === 'string' && num(c.market_cap) > 0).map((c) => ({
    id: String(c.id), symbol: c.symbol.toUpperCase(), name: String(c.name ?? c.symbol), price: num(c.current_price), mcap: num(c.market_cap),
    change: { '1h': num(c.price_change_percentage_1h_in_currency), '24h': num(c.price_change_percentage_24h_in_currency ?? c.price_change_percentage_24h),
      '7d': num(c.price_change_percentage_7d_in_currency), '14d': num(c.price_change_percentage_14d_in_currency),
      '30d': num(c.price_change_percentage_30d_in_currency), '1y': num(c.price_change_percentage_1y_in_currency) },
  }));
}
// The 250 biggest coins, kept for 60 seconds so repeated commands are instant.
export async function fetchTopCoins({ fetchFn = fetch, now = Date.now() } = {}) {
  if (coinCache.list && now - coinCache.at < 60_000) return coinCache.list;
  const url = 'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=1&price_change_percentage=1h,24h,7d,14d,30d,1y';
  const res = await fetchFn(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`CoinGecko returned HTTP ${res.status}`);
  const list = parseCoins(await res.json());
  if (list.length) coinCache = { at: now, list };
  return list;
}

const SCALE = { '1h': 2, '24h': 5, '7d': 12, '14d': 20, '30d': 30, '1y': 100 };
export function heatColor(pct, period = '24h') {
  if (pct == null) return '#3a3f4b';
  const t = Math.max(-1, Math.min(1, pct / (SCALE[period] ?? 5)));
  const k = Math.sqrt(Math.abs(t)); // small moves already show a clear colour
  const from = [58, 63, 75], to = t >= 0 ? [18, 184, 82] : [226, 54, 62];
  const mix = (i) => Math.round(from[i] + (to[i] - from[i]) * k);
  return `rgb(${mix(0)},${mix(1)},${mix(2)})`;
}
const fmtPct = (p) => (p == null ? 'n/a' : `${p >= 0 ? '+' : ''}${Math.abs(p) >= 100 ? p.toFixed(0) : p.toFixed(1)}%`);

// Treemap: the bigger the market cap, the bigger the square (square-rooted, so Bitcoin does not swallow the screen); green up, red down.
export function buildHeatmapSvg(coins, period = '24h', title = 'Crypto heatmap', W = 1280, H = 720) {
  const top = 56;
  const root = hierarchy({ children: coins.map((c) => ({ ...c, value: Math.sqrt(c.mcap) })) }).sum((d) => d.value ?? 0).sort((a, b) => b.value - a.value);
  treemap().tile(treemapSquarify).size([W, H - top]).paddingInner(2).round(true)(root);
  const f = 'font-family="Arial, Helvetica, sans-serif"';
  const cells = root.leaves().map((n) => {
    const w = n.x1 - n.x0, h = n.y1 - n.y0, c = n.data;
    const pct = c.change[period];
    const cx = n.x0 + w / 2, cy = n.y0 + top + h / 2;
    const fs = Math.max(8, Math.min(46, Math.min(w / (c.symbol.length * 0.8), h / 2.1)));
    const showSym = w > 22 && h > 14;
    const showPct = showSym && h > 34 && w > 40;
    let label = '';
    if (showSym) {
      label = `<text x="${cx}" y="${(showPct ? cy - fs * 0.05 : cy + fs * 0.35).toFixed(1)}" text-anchor="middle" ${f} font-size="${fs.toFixed(0)}" font-weight="700" fill="#fff">${esc(c.symbol)}</text>`;
      if (showPct) label += `<text x="${cx}" y="${(cy + fs * 0.85).toFixed(1)}" text-anchor="middle" ${f} font-size="${Math.max(8, fs * 0.5).toFixed(0)}" fill="#fff" fill-opacity="0.95">${fmtPct(pct)}</text>`;
    }
    return `<rect x="${n.x0}" y="${n.y0 + top}" width="${w}" height="${h}" fill="${heatColor(pct, period)}"/>${label}`;
  });
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="#0b0f17"/>`,
    `<text x="16" y="38" ${f} font-size="28" font-weight="700" fill="#fff">${esc(title)}</text><text x="${W - 16}" y="38" text-anchor="end" ${f} font-size="20" fill="#9ca3af">${esc(period)} change · Omni Scan</text>`,
    ...cells, '</svg>',
  ].join('');
}

// Biggest movers among the 250 largest coins.
export function buildMoversText(coins, period, dir = 'best', n = 10) {
  const rows = coins.filter((c) => c.change[period] != null).sort((a, b) => (dir === 'best' ? b.change[period] - a.change[period] : a.change[period] - b.change[period])).slice(0, n);
  if (!rows.length) return 'No data right now. Try again in a minute.';
  const fp = (p) => (p < 1 ? p.toFixed(4) : p < 100 ? p.toFixed(2) : p.toFixed(0));
  const lines = rows.map((c, i) => `${String(i + 1).padStart(2)}. ${c.symbol.padEnd(7).slice(0, 7)} ${fmtPct(c.change[period]).padStart(8)}  $${fp(c.price ?? 0)}`);
  return `${dir === 'best' ? '🚀 <b>Top gainers</b>' : '🩸 <b>Top losers</b>'} · ${esc(period)} · top 250 coins\n<pre>${lines.join('\n')}</pre>`;
}

// ---------- Polymarket search ----------
const jarr = (v) => { if (Array.isArray(v)) return v; try { const a = JSON.parse(v); return Array.isArray(a) ? a : []; } catch { return []; } };
export function parsePolymarket(body, term = '', limit = 6) {
  const t = String(term).toLowerCase().trim();
  return (Array.isArray(body) ? body : []).map((m) => {
    const outcomes = jarr(m?.outcomes), prices = jarr(m?.outcomePrices).map(Number);
    return { question: String(m?.question ?? ''), slug: String(m?.slug ?? ''), outcomes, prices, volume24h: Number(m?.volume24hr) || 0, endDate: m?.endDate ?? null };
  }).filter((m) => m.question && m.slug && m.outcomes.length && m.prices.length === m.outcomes.length && (!t || m.question.toLowerCase().includes(t))).slice(0, limit);
}
export async function fetchPolymarket(term, { fetchFn = fetch } = {}) {
  const res = await fetchFn('https://gamma-api.polymarket.com/markets?limit=500&active=true&closed=false&order=volume24hr&ascending=false', { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Polymarket returned HTTP ${res.status}`);
  return parsePolymarket(await res.json(), term);
}
export function buildPolymarketText(list, term, now = Date.now()) {
  if (!list.length) return `🎲 <b>Polymarket</b>\n\nNo active market found${term ? ` for "${esc(term)}"` : ''}.`;
  const vol = (v) => (v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(0)}K` : `$${v.toFixed(0)}`);
  const ends = (d) => { const t = d ? new Date(d).getTime() : NaN; if (!Number.isFinite(t) || t < now) return null; const days = Math.floor((t - now) / 864e5); return days >= 1 ? `${days}d` : `${Math.max(1, Math.floor((t - now) / 36e5))}h`; };
  const items = list.map((m, i) => {
    const odds = m.outcomes.slice(0, 3).map((o, k) => `${esc(o)} <b>${Math.round(m.prices[k] * 100)}%</b>`).join('  ·  ');
    const e = ends(m.endDate);
    return `${i + 1}. <a href="https://polymarket.com/market/${encodeURIComponent(m.slug)}">${esc(m.question)}</a>\n   ${odds}\n   Vol ${vol(m.volume24h)} 24h${e ? ` · ends in ${e}` : ''}`;
  });
  return `🎲 <b>Polymarket</b>${term ? ` · ${esc(term)}` : ' · most traded'}\n<blockquote>${items.join('\n\n')}</blockquote>`;
}

// ---------- /v convert ----------
// "100", "1.5m", "2%", "$50" -> { kind: 'amount'|'percent', n }
export function parseAmount(t) {
  const m = /^\$?(\d+(?:[.,]\d+)?)\s*([kmb]|%)?$/i.exec(String(t ?? '').trim());
  if (!m) return null;
  const n = Number(m[1].replace(',', '.'));
  const u = (m[2] ?? '').toLowerCase();
  if (u === '%') return n > 0 && n <= 100 ? { kind: 'percent', n } : null;
  return n > 0 ? { kind: 'amount', n: n * ({ k: 1e3, m: 1e6, b: 1e9 }[u] ?? 1) } : null;
}

// ---------- small utilities ----------
export function parseEpoch(t) {
  const n = Number(String(t ?? '').trim());
  if (!Number.isFinite(n) || n <= 0) return null;
  const ms = n > 1e12 ? n : n * 1000; // seconds or milliseconds
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d;
}
export function csvCell(v) { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }

// ---------- price targets: "2x 3x 5x", "+50%", "-30%", "0.5x" ----------
// Returns multiples of the price now (1 < up, below 1 = down), de-duplicated and sorted; null when something is not understood.
export function parseTargets(text) {
  const parts = String(text ?? '').trim().toLowerCase().split(/[\s,]+/).filter(Boolean);
  if (!parts.length) return [];
  const out = new Set();
  for (const p of parts) {
    let m = /^(\d+(?:\.\d+)?)x$/.exec(p);
    let mult = null;
    if (m) mult = Number(m[1]);
    else if ((m = /^([+-]?)(\d+(?:\.\d+)?)%$/.exec(p))) mult = m[1] === '-' ? 1 - Number(m[2]) / 100 : 1 + Number(m[2]) / 100;
    if (!(mult > 0) || mult === 1 || mult > 10_000) return null;
    out.add(Math.round(mult * 1e6) / 1e6);
  }
  return [...out].sort((a, b) => a - b).slice(0, 12);
}
export const targetLabel = (mult) => (mult >= 1 ? (Number.isInteger(mult) ? `${mult}x` : `${+mult.toFixed(2)}x`) : `-${Math.round((1 - mult) * 100)}%`);
export const targetHit = (basePrice, price, mult) => basePrice > 0 && price > 0 && (mult >= 1 ? price >= basePrice * mult : price <= basePrice * mult);

// ---------- reminders: "10m", "2h30m", "in 2 hours", "1d" ----------
const DUR = { s: 1e3, sec: 1e3, secs: 1e3, second: 1e3, seconds: 1e3, m: 6e4, min: 6e4, mins: 6e4, minute: 6e4, minutes: 6e4, h: 36e5, hr: 36e5, hrs: 36e5, hour: 36e5, hours: 36e5, d: 864e5, day: 864e5, days: 864e5, w: 6048e5, week: 6048e5, weeks: 6048e5 };
// -> { ms, rest } or null. The time comes first: "2h30m buy the dip", "in 10 minutes call mom".
export function parseDelay(text) {
  let t = String(text ?? '').trim().toLowerCase().replace(/^in\s+/, '');
  let ms = 0, found = false;
  const re = /^(\d+(?:\.\d+)?)\s*([a-z]+)\s*/;
  for (;;) {
    const m = re.exec(t);
    if (!m || !(m[2] in DUR)) break;
    ms += Number(m[1]) * DUR[m[2]]; found = true; t = t.slice(m[0].length).replace(/^and\s+/, '');
  }
  if (!found || ms < 1e4 || ms > 365 * 864e5) return null;
  return { ms: Math.round(ms), rest: String(text).trim().slice(String(text).trim().length - t.length).trim() };
}

// ---------- technical read ----------
export function ema(vals, n) {
  if (vals.length < n) return null;
  const k = 2 / (n + 1);
  let e = vals.slice(0, n).reduce((a, b) => a + b, 0) / n;
  for (let i = n; i < vals.length; i++) e = vals[i] * k + e * (1 - k);
  return e;
}
export function rsi(closes, n = 14) {
  if (closes.length < n + 1) return null;
  let g = 0, l = 0;
  for (let i = 1; i <= n; i++) { const d = closes[i] - closes[i - 1]; if (d >= 0) g += d; else l -= d; }
  g /= n; l /= n;
  for (let i = n + 1; i < closes.length; i++) { const d = closes[i] - closes[i - 1]; g = (g * (n - 1) + Math.max(d, 0)) / n; l = (l * (n - 1) + Math.max(-d, 0)) / n; }
  return l === 0 ? 100 : 100 - 100 / (1 + g / l);
}
// MACD histogram (12, 26, 9)
export function macdHist(closes) {
  if (closes.length < 35) return null;
  const k12 = 2 / 13, k26 = 2 / 27;
  let e12 = closes.slice(0, 12).reduce((a, b) => a + b, 0) / 12, e26 = closes.slice(0, 26).reduce((a, b) => a + b, 0) / 26;
  const macd = [];
  for (let i = 0; i < closes.length; i++) {
    if (i >= 12) e12 = closes[i] * k12 + e12 * (1 - k12);
    if (i >= 26) { e26 = closes[i] * k26 + e26 * (1 - k26); macd.push(e12 - e26); }
  }
  const sig = ema(macd, 9);
  return sig === null ? null : macd.at(-1) - sig;
}
// closes oldest -> newest. Needs 35+ candles for a full read.
export function analyzeCloses(closes) {
  const c = closes.filter((v) => Number.isFinite(v) && v > 0);
  if (c.length < 20) return null;
  const r = rsi(c), fast = ema(c, 9), slow = ema(c, Math.min(21, c.length)), h = macdHist(c);
  let score = 0;
  if (fast !== null && slow !== null) score += fast > slow ? 1 : -1;
  if (h !== null) score += h > 0 ? 1 : -1;
  if (r !== null) score += r >= 55 ? 0.5 : r <= 45 ? -0.5 : 0;
  const label = score >= 1.5 ? 'Bullish' : score <= -1.5 ? 'Bearish' : 'Neutral';
  return { rsi: r, trendUp: fast !== null && slow !== null ? fast > slow : null, macdUp: h !== null ? h > 0 : null, score, label };
}
const arrow = (up) => (up === null ? '–' : up ? '▲' : '▼');
export function buildTaText(symbol, rows) {
  const ok = rows.filter((r) => r.a);
  const head = `📊 <b>${symbol ? `$${esc(symbol)}` : 'Token'}</b> · technical read`;
  if (!ok.length) return `${head}\n\nNot enough chart history yet. Try again once the token has more candles.`;
  const lines = ok.map((r) => `${r.tf.padEnd(4)} ${String(r.a.rsi === null ? '–' : Math.round(r.a.rsi)).padStart(3)}   ${arrow(r.a.trendUp)}     ${arrow(r.a.macdUp)}    ${r.a.label}`);
  const avg = ok.reduce((s, r) => s + r.a.score, 0) / ok.length;
  const overall = avg >= 1 ? '🟢 Bullish' : avg <= -1 ? '🔴 Bearish' : '🟡 Neutral';
  const up = ok.filter((r) => r.a.score >= 1.5).length, down = ok.filter((r) => r.a.score <= -1.5).length;
  const rs = ok.find((r) => r.a.rsi !== null && (r.a.rsi >= 70 || r.a.rsi <= 30));
  return [head, '', `<pre>TF   RSI  Trend MACD  Read\n${lines.join('\n')}</pre>`,
    `Overall: <b>${overall}</b>  (${up} bullish · ${down} bearish of ${ok.length})`,
    ...(rs ? [`<i>${rs.tf} RSI is ${rs.a.rsi >= 70 ? 'overbought' : 'oversold'}</i>`] : []),
    '<i>RSI 14 · Trend = EMA 9 vs 21 · MACD 12/26/9</i>'].join('\n');
}
export const TA_FRAMES = [['5m', 'minute', 5], ['15m', 'minute', 15], ['1h', 'hour', 1], ['4h', 'hour', 4], ['1d', 'day', 1]];
// Closing prices of the last ~150 candles, oldest first (GeckoTerminal), or null.
export async function fetchCloses({ pairAddress, mint, frame, aggregate, fetchFn = fetch }) {
  try {
    const res = await fetchFn(`https://api.geckoterminal.com/api/v2/networks/solana/pools/${pairAddress}/ohlcv/${frame}?aggregate=${aggregate}&limit=150&currency=usd&token=${mint}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(7_000) });
    if (!res.ok) return null;
    const list = (await res.json())?.data?.attributes?.ohlcv_list;
    return Array.isArray(list) ? list.map((c) => Number(c[4])).reverse() : null;
  } catch { return null; }
}

// ---------- AI text tools ----------
export function isPublicUrl(u) {
  try {
    const x = new URL(u);
    if (!/^https?:$/.test(x.protocol)) return false;
    const h = x.hostname.toLowerCase();
    if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') || !h.includes('.') && !h.includes(':')) return false;
    if (/^(\d+)\.(\d+)\.\d+\.\d+$/.test(h)) { const [a, b] = h.split('.').map(Number); if (a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return false; }
    if (h.includes(':')) return false;
    return true;
  } catch { return false; }
}
export const stripHtml = (html) => String(html).replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const LANGS = { en: 'English', fr: 'French', es: 'Spanish', de: 'German', pt: 'Portuguese', it: 'Italian', ru: 'Russian', tr: 'Turkish', ar: 'Arabic', hi: 'Hindi', zh: 'Chinese', ja: 'Japanese', ko: 'Korean', yo: 'Yoruba', ig: 'Igbo', ha: 'Hausa', sw: 'Swahili', id: 'Indonesian', vi: 'Vietnamese', nl: 'Dutch', pl: 'Polish', uk: 'Ukrainian' };
// "hello world -fr" -> { text: 'hello world', lang: 'French' }
export function parseTranslate(arg) {
  const m = /\s-([a-z]{2})\s*$/i.exec(String(arg ?? ''));
  const lang = m ? LANGS[m[1].toLowerCase()] : null;
  if (m && !lang) return { text: String(arg).trim(), lang: 'English', bad: m[1] };
  return { text: (m ? String(arg).slice(0, m.index) : String(arg ?? '')).trim(), lang: lang ?? 'English' };
}
