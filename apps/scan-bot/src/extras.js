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

const SCALE = { '1h': 3, '24h': 8, '7d': 20, '14d': 30, '30d': 40, '1y': 150 };
export function heatColor(pct, period = '24h') {
  if (pct == null) return '#3a3f4b';
  const t = Math.max(-1, Math.min(1, pct / (SCALE[period] ?? 8)));
  const mix = (a, b, k) => Math.round(a + (b - a) * k);
  const base = [44, 48, 58];
  const to = t >= 0 ? [22, 163, 74] : [220, 38, 38];
  const k = Math.min(1, Math.abs(t) * 1.15);
  return `rgb(${mix(base[0], to[0], k)},${mix(base[1], to[1], k)},${mix(base[2], to[2], k)})`;
}
const fmtPct = (p) => (p == null ? 'n/a' : `${p >= 0 ? '+' : ''}${Math.abs(p) >= 100 ? p.toFixed(0) : p.toFixed(1)}%`);

// Treemap: the bigger the market cap, the bigger the square; green up, red down.
export function buildHeatmapSvg(coins, period = '24h', title = 'Crypto heatmap', W = 1280, H = 720) {
  const top = 56;
  const root = hierarchy({ children: coins.map((c) => ({ ...c, value: c.mcap })) }).sum((d) => d.value ?? 0).sort((a, b) => b.value - a.value);
  treemap().tile(treemapSquarify).size([W, H - top]).paddingInner(3).round(true)(root);
  const f = 'font-family="Arial, Helvetica, sans-serif"';
  const cells = root.leaves().map((n) => {
    const w = n.x1 - n.x0, h = n.y1 - n.y0, c = n.data;
    const pct = c.change[period];
    const fs = Math.max(9, Math.min(54, Math.min(w / (c.symbol.length * 0.72), h / 2.4)));
    const show = w > 34 && h > 24;
    const label = show ? `<text x="${n.x0 + w / 2}" y="${n.y0 + h / 2 + (h > 60 ? 0 : fs * 0.35)}" text-anchor="middle" ${f} font-size="${fs.toFixed(0)}" font-weight="700" fill="#fff">${esc(c.symbol)}</text>${h > 60 ? `<text x="${n.x0 + w / 2}" y="${n.y0 + h / 2 + fs * 0.95}" text-anchor="middle" ${f} font-size="${Math.max(9, fs * 0.5).toFixed(0)}" fill="#fff" fill-opacity="0.92">${fmtPct(pct)}</text>` : ''}` : '';
    return `<rect x="${n.x0}" y="${n.y0 + top}" width="${w}" height="${h}" fill="${heatColor(pct, period)}"/>${label.replace(/y="([\d.]+)"/g, (_, y) => `y="${(Number(y) + top).toFixed(1)}"`)}`;
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
  const res = await fetchFn('https://gamma-api.polymarket.com/markets?limit=200&active=true&closed=false&order=volume24hr&ascending=false', { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Polymarket returned HTTP ${res.status}`);
  return parsePolymarket(await res.json(), term);
}
export function buildPolymarketText(list, term) {
  if (!list.length) return `No active Polymarket market found${term ? ` for "${esc(term)}"` : ''}.`;
  const vol = (v) => (v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(0)}K` : `$${v.toFixed(0)}`);
  const lines = [`🎲 <b>Polymarket</b>${term ? ` · ${esc(term)}` : ' · most traded today'}`, ''];
  for (const m of list) {
    const odds = m.outcomes.map((o, i) => `${esc(o)} <b>${Math.round(m.prices[i] * 100)}%</b>`).join('  ·  ');
    lines.push(`<a href="https://polymarket.com/market/${encodeURIComponent(m.slug)}">${esc(m.question)}</a>`, `   ${odds}  ·  ${vol(m.volume24h)} 24h`);
  }
  return lines.join('\n');
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
