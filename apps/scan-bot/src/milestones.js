// Multiplier announcements: prices for every live call, the per-group setting, and the caption.
import { esc, formatUsd } from '@omnibot/shared';
import { callerHtml } from './callerlink.js';
import { fmtMult, MILESTONES } from './pnlcard.js';
import { usdFromQuote } from './curvemarket.js';

// ---- Prices for many calls at once ----
// DexScreener in chunks of 30: one failed chunk (rate limit, timeout) only loses those 30, never the whole run.
// Tokens DexScreener has no dollar price for get one from their quote token (new pump.fun tokens quoted in WLFI...),
// and tokens it does not list at all (letsbonk.fun and other launchpads) from Jupiter / GeckoTerminal, a few per run.
const misses = new Map(); // mint -> time of a launchpad lookup that found nothing; not asked again for a while
const MISS_TTL_MS = 5 * 60_000;

export async function livePrices(mints, { fetchPairs, quoteUsd, launchMarket, maxFallback = 15, concurrency = 4, chunk = 30, now = Date.now() } = {}) {
  const wanted = [...new Set(mints)];
  const out = new Map();
  for (let i = 0; i < wanted.length; i += chunk) {
    try {
      for (const [k, v] of await fetchPairs(wanted.slice(i, i + chunk))) out.set(k, v);
    } catch (e) { console.error('call prices error:', e.message); }
  }
  // priced in another token only: dollar price = price in quote x the quote's own dollar price
  for (const [mint, m] of out) {
    if (m.priceUsd > 0 || !(m.priceNative > 0) || !m.quoteAddress || !quoteUsd) continue;
    const u = usdFromQuote(m, await quoteUsd(fetchPairs, m.quoteAddress).catch(() => null));
    if (u) out.set(mint, { ...m, priceUsd: u.priceUsd, marketCapUsd: m.marketCapUsd ?? (/pump/i.test(m.dex ?? '') ? u.marketCapUsd : null) });
  }
  // not on DexScreener at all: a few at a time (these APIs have small free limits), recent answers reused
  if (launchMarket) {
    const missing = [];
    for (const m of wanted) {
      if (out.get(m)?.priceUsd > 0) continue;
      const hit = launchHits.get(m);
      if (hit && now - hit.at < HIT_TTL_MS) { out.set(m, { ...(out.get(m) ?? {}), ...hit.v, mint: m }); continue; }
      if (now - (misses.get(m) ?? 0) > MISS_TTL_MS) missing.push(m);
    }
    await pool(missing.slice(0, maxFallback), concurrency, async (mint) => {
      const l = await launchMarket(mint).catch(() => null);
      if (l?.priceUsd > 0) {
        out.set(mint, { ...(out.get(mint) ?? {}), ...l, mint });
        if (launchHits.size > 1000) launchHits.clear();
        launchHits.set(mint, { at: now, v: l });
      } else { if (misses.size > 2000) misses.clear(); misses.set(mint, now); }
    });
  }
  return out;
}
const launchHits = new Map(); // mint -> { at, v }: a launchpad price found in the last minute
const HIT_TTL_MS = 60_000;

// Runs fn over items, at most `n` at once.
async function pool(items, n, fn) {
  let i = 0;
  const worker = async () => { while (i < items.length) await fn(items[i++]); };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}

// ---- Per-group setting: /milestones on | off | <smallest multiple> ----
// Returns { enabled, minX } or null when the text is not a valid setting.
export function parseMilestoneArg(text) {
  const s = String(text ?? '').trim().toLowerCase().replace(/x$/, '');
  if (!s) return null;
  if (['off', 'stop', 'no', '0', 'disable'].includes(s)) return { enabled: false, minX: null };
  if (['on', 'start', 'yes', 'enable'].includes(s)) return { enabled: true, minX: null };
  const n = Number(s);
  if (!Number.isFinite(n) || n < MILESTONES[0]) return null;
  // the closest milestone at or below the number asked (7 -> 5), so it always matches one that is announced
  let minX = MILESTONES[0];
  for (const m of MILESTONES) if (m <= n) minX = m;
  return { enabled: true, minX };
}

export function buildMilestoneSettingText({ enabled = true, minX = null } = {}) {
  if (!enabled) return '🔕 <b>Multiplier posts are off</b> in this group.\nTurn them back on with /milestones on';
  const from = minX && minX > MILESTONES[0] ? minX : MILESTONES[0];
  const list = MILESTONES.filter((m) => m >= from).slice(0, 6).map((m) => `${m}x`).join(', ');
  return [
    `🚀 <b>Multiplier posts are on</b> from <b>${from}x</b>`,
    `Calls are announced at ${list}…`,
    '',
    'Change it: /milestones 5 (only 5x and up) · /milestones off · /milestones on',
  ].join('\n');
}

// ---- The caption under the card ----
export function fmtTook(ms) {
  if (!(ms > 0)) return null;
  if (ms < 60_000) return 'under a minute';
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60), d = Math.floor(h / 24);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

export function buildMilestoneCaption({ symbol, callerName, callerId = null, sourceUrl = null, milestone, x, entryMcap = null, peakMcap = null, tookMs = null }) {
  const name = symbol ? `$${esc(symbol)}` : 'This token';
  const who = callerName ? (callerHtml(callerName, callerId, { at: String(callerName).startsWith('@'), href: sourceUrl }) || 'someone') : 'someone';
  const big = milestone >= 50 ? '🌕' : milestone >= 10 ? '🔥' : '🚀';
  const took = fmtTook(tookMs);
  const lines = [`${big} <b>${name}</b> hit <b>${fmtMult(Math.max(x ?? milestone, milestone))}</b>${took ? ` in ${took}` : ''}`];
  if (entryMcap > 0 && peakMcap > 0) lines.push(`${formatUsd(entryMcap)} ➜ <b>${formatUsd(peakMcap)}</b>`);
  lines.push(`Called by ${who}`);
  return lines.join('\n');
}
