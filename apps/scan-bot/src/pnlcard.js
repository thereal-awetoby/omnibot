import { esc, formatUsd } from '@omnibot/shared';

// Multiples that get announced in the group (once each).
export const MILESTONES = [2, 3, 5, 10, 20, 50, 100, 200, 500, 1000];

// The biggest milestone reached that has not been announced yet, or null.
export function newMilestone(lastX, x) {
  if (!(x > 0)) return null;
  let hit = null;
  for (const m of MILESTONES) if (m <= x && m > (lastX || 1)) hit = m;
  return hit;
}

export const fmtMult = (x) => (x >= 10 ? x.toFixed(0) : x.toFixed(2)) + 'x';
const fmtPct = (x) => { const p = Math.max(0, (x - 1) * 100); return `+${p >= 100 ? p.toFixed(0) : p.toFixed(1)}%`; };

// The card is drawn without emoji fonts, so emoji in names are dropped (they would show as empty boxes).
const plain = (s) => String(s ?? '').replace(/[\p{Extended_Pictographic}️‍\u{1F3FB}-\u{1F3FF}\u{1F1E6}-\u{1F1FF}]/gu, '').replace(/\s+/g, ' ').trim();

// The call's best moment: how high the token went after it was called. A token that never went above the call
// price shows 1.00x (the card is a brag card, it never shows the drop).
export function peakMultiple(entryPrice, ...prices) {
  const best = Math.max(0, ...prices.filter((p) => Number.isFinite(p) && p > 0));
  return entryPrice > 0 ? Math.max(1, best / entryPrice) : null;
}

const SOL_MARK = '<polygon points="10,0 64,0 54,13 0,13" fill="url(#sol)"/><polygon points="0,19 54,19 64,32 10,32" fill="url(#sol)"/><polygon points="10,38 64,38 54,51 0,51" fill="url(#sol)"/>';

// One call as a share card (SVG, drawn to PNG by renderPng): the meme sharp on the left, the numbers on the right.
// `art` is an optional { buf, mime } picture. It is also used, blurred, as the backdrop, so a small picture never looks stretched.
export function buildPnlSvg({ symbol, callerName, entryMcap, peakMcap, x, ageText, groupName, art = null }) {
  const col = '#22c55e';
  const sym = symbol ? `$${esc(plain(symbol))}` : 'Token';
  const who = plain(callerName) ? esc(plain(callerName)) : 'someone';
  const f = 'font-family="Arial, Helvetica, sans-serif"';
  const thin = art ? ' stroke="#000" stroke-opacity="0.6" stroke-width="4" paint-order="stroke"' : '';
  const stroke = art ? ' stroke="#000" stroke-opacity="0.55" stroke-width="7" paint-order="stroke"' : '';
  const symSize = sym.length > 11 ? 44 : sym.length > 8 ? 56 : 68;
  const href = art ? `data:${art.mime};base64,${art.buf.toString('base64')}` : null;
  const back = art
    ? [
      `<image xlink:href="${href}" x="-60" y="-60" width="1120" height="683" preserveAspectRatio="xMidYMid slice" filter="url(#blur)"/>`,
      '<rect width="1000" height="563" fill="#000" fill-opacity="0.55"/>',
      '<rect x="36" y="36" width="430" height="491" fill="#000" fill-opacity="0.4"/>',
      `<image xlink:href="${href}" x="36" y="36" width="430" height="491" preserveAspectRatio="xMidYMid meet"/>`,
      '<rect x="36" y="36" width="430" height="491" fill="none" stroke="#ffffff" stroke-opacity="0.35" stroke-width="2"/>',
    ]
    : [
      '<rect width="1000" height="563" fill="url(#bg)"/><rect width="1000" height="563" fill="url(#glow)"/>',
      `<rect x="36" y="36" width="430" height="491" fill="#ffffff" fill-opacity="0.04" stroke="#ffffff" stroke-opacity="0.15" stroke-width="2"/><g transform="translate(110 200) scale(4.2)" opacity="0.9">${SOL_MARK}</g>`,
    ];
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1000" height="563" viewBox="0 0 1000 563">',
    '<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0b1220"/><stop offset="1" stop-color="#111c33"/></linearGradient>',
    `<radialGradient id="glow" cx="0.8" cy="0.1" r="0.7"><stop offset="0" stop-color="${col}" stop-opacity="0.28"/><stop offset="1" stop-color="${col}" stop-opacity="0"/></radialGradient>`,
    '<filter id="blur" x="-5%" y="-5%" width="110%" height="110%"><feGaussianBlur stdDeviation="24"/></filter>',
    '<linearGradient id="sol" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="#9945FF"/><stop offset="1" stop-color="#14F195"/></linearGradient></defs>',
    '<g>',
    ...back,
    `<text x="964" y="62" text-anchor="end" ${f} font-size="28" font-weight="700" fill="#ffffff"${thin}>Omni Scan</text>`,
    `<text x="964" y="90" text-anchor="end" ${f} font-size="20" fill="#e5e7eb"${thin}>${plain(groupName) ? esc(plain(groupName)) : 'Group call'}</text>`,
    `<text x="964" y="170" text-anchor="end" ${f} font-size="${symSize}" font-weight="700" fill="#ffffff"${thin}>${sym}</text>`,
    `<text x="964" y="208" text-anchor="end" ${f} font-size="21" fill="#e5e7eb"${thin}>called by ${who}${ageText ? ` · ${esc(ageText)} ago` : ''}</text>`,
    `<text x="964" y="332" text-anchor="end" ${f} font-size="128" font-weight="700" fill="${col}"${stroke}>${fmtMult(x)}</text>`,
    `<text x="964" y="390" text-anchor="end" ${f} font-size="48" font-weight="700" fill="${col}"${stroke}>${fmtPct(x)}</text>`,
    '<rect x="520" y="412" width="444" height="2" fill="#ffffff" fill-opacity="0.2"/>',
    `<text x="964" y="452" text-anchor="end" ${f} font-size="26"${thin}><tspan fill="#cbd5e1">Called at  </tspan><tspan font-weight="700" fill="#ffffff">${formatUsd(entryMcap)}</tspan></text>`,
    `<text x="964" y="488" text-anchor="end" ${f} font-size="26"${thin}><tspan fill="#cbd5e1">Peak  </tspan><tspan font-weight="700" fill="${col}">${formatUsd(peakMcap)}</tspan></text>`,
    // Chain mark, bottom right.
    `<g transform="translate(838 500) scale(0.5)">${SOL_MARK}</g>`,
    `<text x="964" y="524" text-anchor="end" ${f} font-size="26" font-weight="700" fill="#ffffff"${thin}>Solana</text>`,
    '</g></svg>',
  ].join('');
}

export function buildPnlCaption({ symbol, callerName, x, milestone = false }) {
  const name = symbol ? `$${esc(symbol)}` : 'This token';
  const who = callerName ? esc(callerName) : 'someone';
  return milestone
    ? `🚀 <b>${name}</b> hit <b>${fmtMult(x)}</b> since ${who} called it`
    : `📊 <b>${name}</b> · peaked at <b>${fmtMult(x)}</b> since ${who} called it`;
}
