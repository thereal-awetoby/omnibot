// A candlestick chart picture (SVG, drawn to PNG by the same renderer as the other pictures), in market cap.
const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export const TFS = { '1m': ['minute', 1], '5m': ['minute', 5], '15m': ['minute', 15], '1h': ['hour', 1], '4h': ['hour', 4], '1d': ['day', 1] };
export const TF_SECONDS = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400 };
// A sensible first view for the token's age (ms): fresh tokens in minutes, older ones in hours.
export function defaultTf(ageMs) {
  if (!(ageMs > 0)) return '5m';
  if (ageMs < 3_600_000) return '1m';
  if (ageMs < 2 * 86_400_000) return '5m';
  if (ageMs < 14 * 86_400_000) return '1h';
  return '4h';
}
export function parseTf(args) {
  const tf = (args ?? []).map((a) => String(a).toLowerCase()).find((a) => a in TFS);
  return tf ?? null;
}
// 97500 -> "97.5K", 2800 -> "2.8K", 1.2e6 -> "1.2M"
export function axisNum(v) {
  const a = Math.abs(v);
  if (a >= 1e9) return `${(v / 1e9).toFixed(a >= 1e10 ? 1 : 2)}B`;
  if (a >= 1e6) return `${(v / 1e6).toFixed(a >= 1e7 ? 1 : 2)}M`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(a >= 1e5 ? 0 : 1)}K`;
  return v.toFixed(a >= 100 ? 0 : 1);
}
const cleanSym = (s) => String(s ?? '').replace(/[^\x20-\x7E]/g, '').trim().slice(0, 14);
// A nice step for the price grid
function niceTicks(lo, hi, want = 6) {
  const span = hi - lo || 1;
  const raw = span / want;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(v);
  return out;
}
const pad2 = (n) => String(n).padStart(2, '0');
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function timeLabel(tSec, tf, withDate) {
  const d = new Date(tSec * 1000);
  if (tf === '1d') return `${MON[d.getUTCMonth()]} ${d.getUTCDate()}`;
  return withDate ? `${MON[d.getUTCMonth()]} ${d.getUTCDate()} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}` : `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

// candles: [{t,o,h,l,c,v}] oldest first. scale: market cap per 1 USD of price (null = show price).
// call: { at (ms), name, price } optional: marks the first call.
export function buildCandleSvg({ candles, scale = null, symbol, tf = '5m', call = null, started = false }) {
  const W = 1280, H = 760;
  const L = 28, R = 112, T = 84, B = 66;
  const volTop = 590, volBot = H - B - 4;
  const plotTop = T, plotBot = volTop - 24;
  const k = scale && scale > 0 ? scale : 1;
  const cs = candles.map((c) => ({ ...c, o: c.o * k, h: c.h * k, l: c.l * k, c: c.c * k }));
  const n = cs.length;
  const hi0 = Math.max(...cs.map((c) => c.h)), lo0 = Math.min(...cs.map((c) => c.l));
  const padY = (hi0 - lo0) * 0.12 || hi0 * 0.1;
  const hi = hi0 + padY * 1.6, lo = Math.max(0, lo0 - padY);
  const x0 = L, x1 = W - R;
  const step = (x1 - x0) / n;
  const bw = Math.max(2, Math.min(18, step * 0.68));
  const X = (i) => x0 + step * (i + 0.5);
  const Y = (v) => plotBot - ((v - lo) / (hi - lo)) * (plotBot - plotTop);
  const vmax = Math.max(...cs.map((c) => c.v), 1e-9);
  const up = '#26c281', down = '#ef4a5c';
  const f = 'font-family="Arial, Helvetica, sans-serif"';
  const out = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`);
  out.push(`<rect width="${W}" height="${H}" fill="#0e131b"/>`);
  // grid + price axis
  for (const v of niceTicks(lo, hi)) {
    const y = Y(v);
    if (y < plotTop - 4 || y > plotBot + 4) continue;
    out.push(`<line x1="${x0}" x2="${x1}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" stroke="#1d2530" stroke-width="1"/>`);
    out.push(`<text x="${W - R + 14}" y="${(y + 5).toFixed(1)}" fill="#8b96a5" font-size="17" ${f}>${axisNum(v)}</text>`);
  }
  // time axis
  const spanSec = cs.at(-1).t - cs[0].t;
  const withDate = spanSec > 20 * 3600 && tf !== '1d';
  const ticks = Math.min(7, Math.max(2, Math.floor(n / 8)));
  for (let j = 0; j <= ticks; j++) {
    const i = Math.min(n - 1, Math.round((j / ticks) * (n - 1)));
    const x = X(i);
    out.push(`<line x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${plotTop}" y2="${volBot}" stroke="#161d27" stroke-width="1"/>`);
    out.push(`<text x="${x.toFixed(1)}" y="${H - B + 28}" fill="#8b96a5" font-size="16" text-anchor="${j === 0 ? 'start' : j === ticks ? 'end' : 'middle'}" ${f}>${esc(timeLabel(cs[i].t, tf, withDate))}</text>`);
  }
  out.push(`<text x="${W - R + 14}" y="${H - B + 28}" fill="#5d6877" font-size="14" ${f}>UTC</text>`);
  // volume
  for (let i = 0; i < n; i++) {
    const c = cs[i];
    const h = Math.max(1, (c.v / vmax) * (volBot - volTop));
    out.push(`<rect x="${(X(i) - bw / 2).toFixed(1)}" y="${(volBot - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" fill="${c.c >= c.o ? up : down}" opacity="0.42"/>`);
  }
  // candles
  for (let i = 0; i < n; i++) {
    const c = cs[i];
    const col = c.c >= c.o ? up : down;
    const yo = Y(c.o), yc = Y(c.c);
    const top = Math.min(yo, yc), hgt = Math.max(1.5, Math.abs(yo - yc));
    out.push(`<line x1="${X(i).toFixed(1)}" x2="${X(i).toFixed(1)}" y1="${Y(c.h).toFixed(1)}" y2="${Y(c.l).toFixed(1)}" stroke="${col}" stroke-width="1.6"/>`);
    out.push(`<rect x="${(X(i) - bw / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${bw.toFixed(1)}" height="${hgt.toFixed(1)}" fill="${col}"/>`);
  }
  // ATH marker
  let ai = 0;
  cs.forEach((c, i) => { if (c.h >= cs[ai].h) ai = i; });
  const ax = Math.min(x1 - 60, Math.max(x0 + 60, X(ai)));
  const ay = Y(cs[ai].h);
  const athTxt = `ATH ${axisNum(cs[ai].h)}`;
  const aw = athTxt.length * 11 + 22;
  out.push(`<rect x="${(ax - aw / 2).toFixed(1)}" y="${(ay - 46).toFixed(1)}" width="${aw}" height="28" rx="6" fill="#2a2110" stroke="#f5b942" stroke-width="1.4"/>`);
  out.push(`<text x="${ax.toFixed(1)}" y="${(ay - 26).toFixed(1)}" fill="#f5b942" font-size="17" font-weight="bold" text-anchor="middle" ${f}>${esc(athTxt)}</text>`);
  out.push(`<path d="M${(ax - 6).toFixed(1)} ${(ay - 14).toFixed(1)} L${(ax + 6).toFixed(1)} ${(ay - 14).toFixed(1)} L${ax.toFixed(1)} ${(ay - 5).toFixed(1)} Z" fill="#f5b942"/>`);
  // start marker (only when the chart begins at the token's first candle)
  if (started) {
    const sx = X(0), sy = Y(cs[0].o);
    const st = axisNum(cs[0].o);
    const sw = st.length * 11 + 22;
    out.push(`<rect x="${Math.max(x0, sx - 8).toFixed(1)}" y="${(sy + 18).toFixed(1)}" width="${sw}" height="28" rx="6" fill="#0e2a33" stroke="#4cc3e8" stroke-width="1.4"/>`);
    out.push(`<text x="${(Math.max(x0, sx - 8) + sw / 2).toFixed(1)}" y="${(sy + 38).toFixed(1)}" fill="#4cc3e8" font-size="17" font-weight="bold" text-anchor="middle" ${f}>${esc(st)}</text>`);
    out.push(`<path d="M${(sx - 6).toFixed(1)} ${(sy + 16).toFixed(1)} L${(sx + 6).toFixed(1)} ${(sy + 16).toFixed(1)} L${sx.toFixed(1)} ${(sy + 6).toFixed(1)} Z" fill="#4cc3e8"/>`);
  }
  // first call marker
  if (call?.at) {
    const ts = call.at / 1000;
    let ci = -1;
    for (let i = 0; i < n; i++) if (cs[i].t <= ts) ci = i;
    if (ci >= 0 && ts - cs[ci].t < (TF_SECONDS[tf] ?? 300) * 1.01 + 1) {
      const cx = X(ci);
      const cy = Y(cs[ci].c);
      const lab = `First Call${call.name ? ` · ${cleanSym(call.name).slice(0, 12)}` : ''}`;
      const lw = lab.length * 9.6 + 24;
      const lx = Math.min(x1 - lw, Math.max(x0, cx - lw / 2));
      out.push(`<line x1="${cx.toFixed(1)}" x2="${cx.toFixed(1)}" y1="${(cy + 6).toFixed(1)}" y2="${volTop - 28}" stroke="#a78bfa" stroke-width="1.2" stroke-dasharray="3 4"/>`);
      out.push(`<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="8" fill="#a78bfa" stroke="#0e131b" stroke-width="2"/>`);
      out.push(`<rect x="${lx.toFixed(1)}" y="${volTop - 54}" width="${lw.toFixed(1)}" height="26" rx="6" fill="#241b3d" stroke="#a78bfa" stroke-width="1.2"/>`);
      out.push(`<text x="${(lx + lw / 2).toFixed(1)}" y="${volTop - 36}" fill="#c9b8ff" font-size="15" font-weight="bold" text-anchor="middle" ${f}>${esc(lab)}</text>`);
    }
  }
  // last price line + tag
  const last = cs.at(-1);
  const ly = Y(last.c);
  const lcol = last.c >= cs[0].o ? up : down;
  out.push(`<line x1="${x0}" x2="${x1}" y1="${ly.toFixed(1)}" y2="${ly.toFixed(1)}" stroke="${lcol}" stroke-width="1.3" stroke-dasharray="5 5" opacity="0.9"/>`);
  out.push(`<rect x="${x1 + 6}" y="${(ly - 15).toFixed(1)}" width="${R - 14}" height="30" rx="5" fill="${lcol}"/>`);
  out.push(`<text x="${(x1 + 6 + (R - 14) / 2).toFixed(1)}" y="${(ly + 6).toFixed(1)}" fill="#ffffff" font-size="18" font-weight="bold" text-anchor="middle" ${f}>${axisNum(last.c)}</text>`);
  // title
  const name = cleanSym(symbol) || 'TOKEN';
  const change = ((last.c / cs[0].o) - 1) * 100;
  out.push(`<text x="${L}" y="46" fill="#f2f5f9" font-size="30" font-weight="bold" ${f}>${esc(name)}</text>`);
  out.push(`<text x="${L + name.length * 21 + 18}" y="46" fill="#8b96a5" font-size="20" ${f}>${tf} · ${k !== 1 ? 'Market Cap' : 'Price'}</text>`);
  const chTxt = `O ${axisNum(cs[0].o)}   H ${axisNum(hi0)}   L ${axisNum(lo0)}   C ${axisNum(last.c)}   ${change >= 0 ? '+' : ''}${change.toFixed(change >= 100 ? 0 : 1)}%`;
  out.push(`<text x="${W - 20}" y="44" fill="${change >= 0 ? up : down}" font-size="19" text-anchor="end" ${f}>${esc(chTxt)}</text>`);
  out.push(`<text x="${L}" y="${H - 18}" fill="#4d5867" font-size="17" ${f}>@OmniScanmc_bot</text>`);
  out.push('</svg>');
  return out.join('\n');
}
