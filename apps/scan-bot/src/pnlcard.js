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
const fmtPct = (x) => { const p = (x - 1) * 100; return `${p >= 0 ? '+' : '-'}${Math.abs(p) >= 100 ? Math.abs(p).toFixed(0) : Math.abs(p).toFixed(1)}%`; };

// The card is drawn without emoji fonts, so emoji in names are dropped (they would show as empty boxes).
const plain = (s) => String(s ?? '').replace(/[\p{Extended_Pictographic}\uFE0F\u200D\u{1F3FB}-\u{1F3FF}\u{1F1E6}-\u{1F1FF}]/gu, '').replace(/\s+/g, ' ').trim();

// One call as a share card (SVG, drawn to PNG by renderPng).
// `art` is an optional { buf, mime } picture used as the background (cropped to 16:9).
export function buildPnlSvg({ symbol, callerName, entryMcap, nowMcap, x, ageText, groupName, art = null }) {
  const up = x >= 1;
  const col = up ? '#22c55e' : '#ef4444';
  const name = symbol ? `$${esc(symbol)}` : 'Token';
  const who = plain(callerName) ? esc(plain(callerName)) : 'someone';
  const f = 'font-family="Arial, Helvetica, sans-serif"';
  const bgLayer = art
    ? [
      `<image xlink:href="data:${art.mime};base64,${art.buf.toString('base64')}" x="0" y="0" width="1000" height="563" preserveAspectRatio="xMidYMid slice"/>`,
      '<rect width="1000" height="563" fill="url(#shade)"/><rect y="330" width="1000" height="233" fill="url(#shadeb)"/>',
    ]
    : ['<rect width="1000" height="563" fill="url(#bg)"/><rect width="1000" height="563" fill="url(#glow)"/>'];
  const thin = art ? ' stroke="#000" stroke-opacity="0.6" stroke-width="4" paint-order="stroke"' : '';
  const stroke = art ? ' stroke="#000" stroke-opacity="0.55" stroke-width="7" paint-order="stroke"' : '';
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1000" height="563" viewBox="0 0 1000 563">',
    '<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0b1220"/><stop offset="1" stop-color="#111c33"/></linearGradient>',
    `<radialGradient id="glow" cx="0.8" cy="0.1" r="0.7"><stop offset="0" stop-color="${col}" stop-opacity="0.28"/><stop offset="1" stop-color="${col}" stop-opacity="0"/></radialGradient>`,
    '<linearGradient id="shade" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#000" stop-opacity="0.78"/><stop offset="0.6" stop-color="#000" stop-opacity="0.4"/><stop offset="1" stop-color="#000" stop-opacity="0.1"/></linearGradient>',
    '<linearGradient id="shadeb" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.8"/></linearGradient>',
    '<linearGradient id="sol" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="#9945FF"/><stop offset="1" stop-color="#14F195"/></linearGradient></defs>',
    '<g>',
    ...bgLayer,
    `<text x="50" y="80" ${f} font-size="30" font-weight="700" fill="#e5e7eb">Omni Scan</text>`,
    `<text x="950" y="80" text-anchor="end" ${f} font-size="24" fill="#e5e7eb"${thin}>${plain(groupName) ? esc(plain(groupName)) : 'Group call'}</text>`,
    `<text x="50" y="190" ${f} font-size="64" font-weight="700" fill="#ffffff">${name}</text>`,
    `<text x="50" y="240" ${f} font-size="26" fill="#e5e7eb"${thin}>called by ${who}${ageText ? ` · ${esc(ageText)} ago` : ''}</text>`,
    `<text x="50" y="410" ${f} font-size="150" font-weight="700" fill="${col}"${stroke}>${fmtMult(x)}</text>`,
    `<text x="950" y="410" text-anchor="end" ${f} font-size="64" font-weight="700" fill="${col}"${stroke}>${fmtPct(x)}</text>`,
    '<rect x="50" y="450" width="900" height="2" fill="#1f2a44"/>',
    `<text x="50" y="505" ${f} font-size="24" fill="#e5e7eb"${thin}>Called at</text><text x="200" y="505" ${f} font-size="30" font-weight="700" fill="#e5e7eb">${formatUsd(entryMcap)}</text>`,
    `<text x="520" y="505" ${f} font-size="24" fill="#e5e7eb"${thin}>Now</text><text x="590" y="505" ${f} font-size="30" font-weight="700" fill="#e5e7eb">${formatUsd(nowMcap)}</text>`,
    // Chain mark, bottom right.
    '<g transform="translate(772 484)"><polygon points="10,0 64,0 54,13 0,13" fill="url(#sol)"/><polygon points="0,19 54,19 64,32 10,32" fill="url(#sol)"/><polygon points="10,38 64,38 54,51 0,51" fill="url(#sol)"/>',
    `<text x="80" y="36" ${f} font-size="30" font-weight="700" fill="#ffffff"${thin}>Solana</text></g>`,
    '</g></svg>',
  ].join('');
}

export function buildPnlCaption({ symbol, callerName, x, milestone = false }) {
  const name = symbol ? `$${esc(symbol)}` : 'This token';
  const who = callerName ? esc(callerName) : 'someone';
  return milestone
    ? `🚀 <b>${name}</b> hit <b>${fmtMult(x)}</b> since ${who} called it`
    : `📊 <b>${name}</b> · ${fmtMult(x)} since ${who} called it`;
}
