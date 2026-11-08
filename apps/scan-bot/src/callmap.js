// The group's own call map: one tile per call in the period. The bigger the market cap it reached, the bigger the tile;
// the colour is how the call is doing now (or its best moment, in ATH mode).
import { hierarchy, treemap, treemapSquarify } from 'd3-hierarchy';
import { esc, formatUsd } from '@omnibot/shared';
import { fmtX } from './ux.js';

const plain = (s) => String(s ?? '').replace(/[\p{Extended_Pictographic}‍️]/gu, '').replace(/\s+/g, ' ').trim();

// calls + prices -> one row per call with nowX (current price / call price) and athX (best seen / call price, never below 1).
export function callMapRows(calls, prices) {
  const rows = [];
  for (const c of calls) {
    const entry = Number(c.price_usd);
    if (!(entry > 0)) continue;
    const now = prices.get(c.mint)?.priceUsd ?? null;
    const best = Math.max(Number(c.peak_price_usd) || 0, now || 0);
    const athX = best > 0 ? Math.max(1, best / entry) : 1;
    const nowX = now > 0 ? now / entry : null;
    const entryMcap = Number(c.mcap_usd) || null;
    rows.push({ ...c, nowX, athX, entryMcap, peakMcap: entryMcap ? entryMcap * athX : null });
  }
  return rows;
}

// Colour on a log scale, so 2x and 0.5x look equally strong. Grey = no price.
export function callColor(x, mode = 'now') {
  if (!(x > 0)) return '#3a3f4b';
  const from = [58, 63, 75];
  const l = Math.log2(x);
  let to, k;
  if (mode === 'ath') { to = [18, 184, 82]; k = Math.min(1, l / Math.log2(20)); }
  else if (l >= 0) { to = [18, 184, 82]; k = Math.min(1, l / 3); } // full green at 8x
  else { to = [226, 54, 62]; k = Math.min(1, -l / 2); } // full red at -75%
  k = Math.sqrt(Math.max(0, k));
  const mix = (i) => Math.round(from[i] + (to[i] - from[i]) * k);
  return `rgb(${mix(0)},${mix(1)},${mix(2)})`;
}

const pctOf = (x) => { const p = (x - 1) * 100; return `${p >= 0 ? '+' : ''}${Math.abs(p) >= 100 ? p.toFixed(0) : p.toFixed(1)}%`; };

export function buildCallMapSvg(rows, { mode = 'now', periodLabel = '7D', groupName = null, max = 60, W = 1280, H = 720 } = {}) {
  const top = 56;
  const f = 'font-family="Arial, Helvetica, sans-serif"';
  const shown = [...rows].sort((a, b) => (b.peakMcap ?? 0) - (a.peakMcap ?? 0)).slice(0, max);
  const root = hierarchy({ children: shown.map((r) => ({ ...r, value: Math.sqrt(Math.max(r.peakMcap ?? 0, 5_000)) })) })
    .sum((d) => d.value ?? 0).sort((a, b) => b.value - a.value);
  treemap().tile(treemapSquarify).size([W, H - top]).paddingInner(2).round(true)(root);
  const cells = root.leaves().map((n) => {
    const w = n.x1 - n.x0, h = n.y1 - n.y0, r = n.data;
    const symbol = plain(r.symbol) || String(r.mint).slice(0, 4);
    const x = mode === 'ath' ? r.athX : r.nowX;
    const sub = x == null ? (r.peak_price_usd > 0 ? 'dead' : 'n/a') : mode === 'ath' ? fmtX(r.athX) : pctOf(r.nowX);
    const cx = n.x0 + w / 2, cy = n.y0 + top + h / 2;
    const fs = Math.max(8, Math.min(44, Math.min(w / (symbol.length * 0.8 + 1), h / 2.6)));
    const showSym = w > 26 && h > 16, showSub = showSym && h > 36 && w > 44, showWho = showSub && h > 90 && w > 110;
    const who = plain(r.caller_name).replace(/^@/, '');
    let label = '';
    if (showSym) {
      const y0 = showWho ? cy - fs * 0.4 : showSub ? cy - fs * 0.05 : cy + fs * 0.35;
      label = `<text x="${cx}" y="${y0.toFixed(1)}" text-anchor="middle" ${f} font-size="${fs.toFixed(0)}" font-weight="700" fill="#fff">$${esc(symbol)}</text>`;
      if (showSub) label += `<text x="${cx}" y="${(y0 + fs * 0.9).toFixed(1)}" text-anchor="middle" ${f} font-size="${Math.max(8, fs * 0.55).toFixed(0)}" fill="#fff" fill-opacity="0.95">${esc(sub)}</text>`;
      if (showWho && who) label += `<text x="${cx}" y="${(y0 + fs * 1.6).toFixed(1)}" text-anchor="middle" ${f} font-size="${Math.max(8, fs * 0.38).toFixed(0)}" fill="#fff" fill-opacity="0.75">${esc(who.slice(0, 18))}</text>`;
    }
    return `<rect x="${n.x0}" y="${n.y0 + top}" width="${w}" height="${h}" fill="${callColor(x, mode)}"/>${label}`;
  });
  const title = plain(groupName) ? `Call map · ${plain(groupName)}` : 'Call map';
  const right = `${periodLabel} · ${mode === 'ath' ? 'best since call' : 'now vs call'} · Omni Scan`;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="#0b0f17"/>`,
    `<text x="16" y="38" ${f} font-size="28" font-weight="700" fill="#fff">${esc(title.slice(0, 48))}</text><text x="${W - 16}" y="38" text-anchor="end" ${f} font-size="20" fill="#9ca3af">${esc(right)}</text>`,
    ...cells, '</svg>',
  ].join('');
}

// The caption: the period's numbers in one look.
export function buildCallMapCaption(rows, { periodLabel = '7D', max = 60 } = {}) {
  if (!rows.length) return `🗺 <b>Call map</b> · ${esc(periodLabel)}\n\nNo calls in that time.`;
  const n = rows.length;
  const avg = rows.reduce((s, r) => s + r.athX, 0) / n;
  const hit2 = rows.filter((r) => r.athX >= 2).length / n;
  const priced = rows.filter((r) => r.nowX != null);
  const up = priced.filter((r) => r.nowX > 1.0005).length;
  const best = rows.reduce((a, b) => (b.athX > a.athX ? b : a));
  const lines = [
    `🗺 <b>Call map</b> · ${esc(periodLabel)} · ${n} call${n === 1 ? '' : 's'}${n > max ? ` (biggest ${max} shown)` : ''}`,
    `Avg ATH <b>${fmtX(avg)}</b> · ${Math.round(hit2 * 100)}% hit 2x · ${up}/${priced.length} green now`,
    `Best: <b>$${esc(plain(best.symbol) || String(best.mint).slice(0, 4))}</b> ${fmtX(best.athX)}${best.peakMcap ? ` (${formatUsd(best.peakMcap)})` : ''} by ${esc(plain(best.caller_name).replace(/^@/, '') || 'someone')}`,
  ];
  return lines.join('\n');
}
