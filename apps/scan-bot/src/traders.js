// New Scan commands that need no paid data: /tt top traders, /tw top wallets, /ws wallet stats, /rekt liquidations.
// Parsers and text builders are pure (unit tested with sample payloads); the fetchers are thin and never throw
// past their caller's try/catch. Facts only: numbers from public data, no opinions.
import { esc, formatUsd } from '@omnibot/shared';
import { formatDuration } from './scan.js';
import { tree } from './ux.js';

const short = (a) => `${a.slice(0, 4)}…${a.slice(-4)}`;
const ADDR = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const wallet = (a) => (ADDR.test(String(a)) ? `<a href="https://solscan.io/account/${a}">${short(a)}</a>` : esc(String(a).slice(0, 12)));
const sym = (m) => (m?.symbol ? `$${esc(m.symbol)}` : 'this token');
const signed = (n) => `${n >= 0 ? '+' : '−'}${formatUsd(Math.abs(n))}`;
const pre = (rows) => `<pre>${esc(tree(rows))}</pre>`;

// ---------- recent trades (GeckoTerminal, free) ----------

// body: GeckoTerminal /pools/{pool}/trades. -> [{ wallet, side: 'buy' | 'sell', usd, tokens, at (ms) }] newest first.
// "buy" = our token was bought. Direction comes from the token addresses, with the API's own `kind` as the fallback.
export function parseTrades(body, mint) {
  const out = [];
  for (const t of Array.isArray(body?.data) ? body.data : []) {
    const a = t?.attributes;
    if (!a?.tx_from_address) continue;
    const usd = Number(a.volume_in_usd);
    let side = null;
    if (a.to_token_address === mint) side = 'buy';
    else if (a.from_token_address === mint) side = 'sell';
    else if (a.kind === 'buy' || a.kind === 'sell') side = a.kind;
    const tokens = Number(side === 'buy' ? a.to_token_amount : a.from_token_amount);
    const at = Date.parse(a.block_timestamp);
    if (!side || !(usd >= 0) || !Number.isFinite(usd) || !Number.isFinite(tokens) || !Number.isFinite(at)) continue;
    out.push({ wallet: a.tx_from_address, side, usd, tokens, at });
  }
  return out.sort((x, y) => y.at - x.at);
}

// One row per wallet: how much it bought and sold in the window.
export function aggregateTraders(trades) {
  const by = new Map();
  for (const t of trades) {
    const r = by.get(t.wallet) ?? { wallet: t.wallet, buyUsd: 0, sellUsd: 0, buyTokens: 0, sellTokens: 0, buys: 0, sells: 0 };
    if (t.side === 'buy') { r.buyUsd += t.usd; r.buyTokens += t.tokens; r.buys += 1; } else { r.sellUsd += t.usd; r.sellTokens += t.tokens; r.sells += 1; }
    by.set(t.wallet, r);
  }
  return [...by.values()].map((r) => ({ ...r, volume: r.buyUsd + r.sellUsd }));
}

export const topByVolume = (rows, n = 8) => [...rows].sort((a, b) => b.volume - a.volume).slice(0, n);

// Wallets that BOUGHT in this window (they did not sell more than they bought, so their cost is known):
// profit = sales + value still held at today's price - what they paid. Wallets that sold older holdings are left out.
export function estimateProfits(rows, priceUsd) {
  const out = [];
  for (const r of rows) {
    if (!(r.buyUsd > 0) || !(r.buyTokens > 0) || r.sellTokens > r.buyTokens * 1.02) continue;
    const held = Math.max(r.buyTokens - r.sellTokens, 0);
    const heldUsd = priceUsd > 0 ? held * priceUsd : 0;
    const pnl = r.sellUsd + heldUsd - r.buyUsd;
    out.push({ ...r, held, heldUsd, pnl, x: (r.sellUsd + heldUsd) / r.buyUsd });
  }
  return out.sort((a, b) => b.pnl - a.pnl);
}

const windowText = (trades, now) => {
  if (!trades.length) return 'no trades';
  const span = Math.max(trades[0].at - trades.at(-1).at, 60_000);
  return `${trades.length} trades · ${formatDuration(span) ?? '1m'}`;
};

export function buildTopTradersText({ market, trades, rows, now = Date.now() }) {
  const head = `🏆 <b>Top traders</b> · ${sym(market)}`;
  if (!trades.length) return `${head}\n\nNo recent trades found for this token yet.`;
  const buyers = rows.filter((r) => r.buys > 0);
  const sellers = rows.filter((r) => r.sells > 0);
  const stats = pre([
    ['Window', windowText(trades, now)],
    ['Buyers', `${buyers.length} wallets · ${formatUsd(buyers.reduce((s, r) => s + r.buyUsd, 0))}`],
    ['Sellers', `${sellers.length} wallets · ${formatUsd(sellers.reduce((s, r) => s + r.sellUsd, 0))}`],
  ]);
  const list = topByVolume(rows).map((r, i) => {
    const net = r.buyUsd - r.sellUsd;
    return `${i + 1}. ${wallet(r.wallet)} · <b>${formatUsd(r.volume)}</b>\n   🟢 ${formatUsd(r.buyUsd)} (${r.buys}) · 🔴 ${formatUsd(r.sellUsd)} (${r.sells}) · net ${signed(net)}`;
  });
  return `${head}\n${stats}\n<blockquote>${list.join('\n')}</blockquote>\n<i>Ranked by traded volume in the window above.</i>`;
}

export function buildTopWalletsText({ market, trades, profits, now = Date.now() }) {
  const head = `💎 <b>Top wallets</b> · ${sym(market)}`;
  if (!trades.length) return `${head}\n\nNo recent trades found for this token yet.`;
  if (!profits.length) return `${head}\n${pre([['Window', windowText(trades, now)]])}\nNo wallet in this window bought and has a known cost yet.`;
  const list = profits.slice(0, 8).map((r, i) => {
    const x = r.x >= 10 ? r.x.toFixed(0) : r.x.toFixed(2);
    return `${i + 1}. ${wallet(r.wallet)} · <b>${signed(r.pnl)}</b> (${x}x)\n   in ${formatUsd(r.buyUsd)} · out ${formatUsd(r.sellUsd)} · holds ${formatUsd(r.heldUsd)}`;
  });
  return `${head}\n${pre([['Window', windowText(trades, now)], ['Wallets', `${profits.length} bought in this window`]])}\n<blockquote>${list.join('\n')}</blockquote>\n<i>Profit = sold + still held at today's price − cost. Only wallets that bought inside the window; earlier holders are not counted.</i>`;
}

// ---------- GeckoTerminal trades fetch (cached, pauses after a 429) ----------
let tradesPausedUntil = 0;
const tradesCache = new Map(); // pool -> { at, trades }
export async function fetchTrades(pool, mint, { fetchImpl = fetch, now = Date.now() } = {}) {
  const hit = tradesCache.get(pool);
  if (hit && now - hit.at < 45_000) return hit.trades;
  if (now < tradesPausedUntil) throw new Error('GeckoTerminal is rate limiting, try again in a minute');
  const res = await fetchImpl(`https://api.geckoterminal.com/api/v2/networks/solana/pools/${pool}/trades`, {
    headers: { accept: 'application/json;version=20230302' }, signal: AbortSignal.timeout(8_000),
  });
  if (res.status === 429) { tradesPausedUntil = now + 60_000; throw new Error('GeckoTerminal is rate limiting, try again in a minute'); }
  if (!res.ok) throw new Error(`GeckoTerminal returned HTTP ${res.status}`);
  const trades = parseTrades(await res.json(), mint);
  if (tradesCache.size > 100) tradesCache.clear();
  tradesCache.set(pool, { at: now, trades });
  return trades;
}

// ---------- /ws wallet stats ----------
// holdings: { top: [{ symbol, usd }], count, totalUsd } (from valueHoldings), funding: { funder, sol, at } | null.
export function buildWalletText({ address, sol, solUsd, holdings, funding, now = Date.now() }) {
  const rows = [];
  if (typeof sol === 'number') rows.push(['SOL', `${sol.toFixed(sol >= 10 ? 2 : 3)}${solUsd > 0 ? `  (~${formatUsd(sol * solUsd)})` : ''}`]);
  if (holdings) {
    rows.push(['Tokens', String(holdings.count)]);
    if (holdings.totalUsd > 0) rows.push(['Value', `~${formatUsd(holdings.totalUsd)}  (priced tokens)`]);
    if (typeof sol === 'number' && solUsd > 0) rows.push(['Total', `~${formatUsd(holdings.totalUsd + sol * solUsd)}`]);
  }
  if (funding?.at) rows.push(['Age', `first funded ${formatDuration(now - funding.at) ?? 'just now'} ago`]);
  const lines = [`👛 <b>Wallet</b> · ${wallet(address)}`];
  if (!rows.length) { lines.push('', 'Could not read this wallet right now. Try again in a moment.'); return lines.join('\n'); }
  lines.push(pre(rows));
  if (funding?.funder) lines.push(`Funded by ${wallet(funding.funder)}${funding.sol ? ` · ${funding.sol >= 1 ? funding.sol.toFixed(2) : funding.sol.toFixed(3)} SOL` : ''}`);
  if (holdings?.top.length) lines.push(`<blockquote>${holdings.top.map((t, i) => `${i + 1}. ${t.symbol ? `$${esc(t.symbol)}` : 'token'} · ${formatUsd(t.usd)}`).join('\n')}</blockquote>`);
  return lines.join('\n');
}

// ---------- /rekt liquidations (Binance USDⓈ-M futures public stream) ----------

// One stream message -> { sym, side: 'long' | 'short', usd, at } | null. A forced SELL closes a long, a forced BUY closes a short.
export function parseForceOrder(msg) {
  const o = msg?.o;
  if (msg?.e !== 'forceOrder' || !o?.s) return null;
  const usd = Number(o.ap || o.p) * Number(o.z || o.q);
  if (!Number.isFinite(usd) || usd <= 0) return null;
  const sym = String(o.s).replace(/(USDT|USDC|BUSD)$/, '');
  return { sym, side: o.S === 'SELL' ? 'long' : 'short', usd, at: Number(o.T ?? msg.E) || Date.now() };
}

export const REKT_WINDOWS = { '1h': 3_600_000, '4h': 14_400_000, '12h': 43_200_000, '24h': 86_400_000 };
export const parseRektWindow = (t) => (REKT_WINDOWS[String(t ?? '').trim().toLowerCase()] ? String(t).trim().toLowerCase() : '4h');

// events: [{ sym, side, usd, at }] -> totals, per-coin list and the single biggest liquidation inside the window.
export function summarizeLiquidations(events, windowMs, now = Date.now()) {
  const inWin = events.filter((e) => now - e.at <= windowMs);
  const by = new Map();
  let long = 0, short = 0, biggest = null;
  for (const e of inWin) {
    const c = by.get(e.sym) ?? { sym: e.sym, long: 0, short: 0 };
    c[e.side] += e.usd;
    by.set(e.sym, c);
    if (e.side === 'long') long += e.usd; else short += e.usd;
    if (!biggest || e.usd > biggest.usd) biggest = e;
  }
  const coins = [...by.values()].map((c) => ({ ...c, total: c.long + c.short })).sort((a, b) => b.total - a.total);
  return { count: inWin.length, total: long + short, long, short, coins, biggest };
}

export function buildRektText({ summary, windowLabel, coveredMs }) {
  const head = `💥 <b>Liquidations</b> · last ${windowLabel}`;
  if (!summary.count) return `${head}\n\nNo liquidations recorded in this window yet. The bot started listening ${formatDuration(coveredMs) ?? 'just now'} ago.`;
  const pct = (v) => `${Math.round((v / summary.total) * 100)}%`;
  const stats = pre([
    ['Total', `${formatUsd(summary.total)}  (${summary.count.toLocaleString('en-US')})`],
    ['Longs', `${formatUsd(summary.long)}  ${pct(summary.long)}`],
    ['Shorts', `${formatUsd(summary.short)}  ${pct(summary.short)}`],
    ['Biggest', `${formatUsd(summary.biggest.usd)}  ${summary.biggest.sym} ${summary.biggest.side}`],
  ]);
  const list = summary.coins.slice(0, 8).map((c, i) => `${i + 1}. <b>${esc(c.sym)}</b> · ${formatUsd(c.total)}  (🔴 long ${Math.round((c.long / c.total) * 100)}% · 🟢 short ${Math.round((c.short / c.total) * 100)}%)`);
  const note = coveredMs < REKT_WINDOWS[windowLabel] ? `Counted since this bot started listening, ${formatDuration(coveredMs) ?? 'just now'} ago.` : 'Binance USDⓈ-M futures.';
  return `${head}\n${stats}\n<blockquote>${list.join('\n')}</blockquote>\n<i>${note}</i>`;
}

// Keeps the last 24 hours of liquidations in memory. Uses Node's built-in WebSocket and reconnects by itself.
export function createLiquidationFeed({ WebSocketImpl = globalThis.WebSocket, url = 'wss://fstream.binance.com/ws/!forceOrder@arr', now = () => Date.now() } = {}) {
  let events = [];
  let startedAt = null;
  let retry = 0;
  let timer = null;
  let ws = null;
  const prune = () => { const cut = now() - REKT_WINDOWS['24h']; if (events.length && events[0].at < cut) events = events.filter((e) => e.at >= cut); };
  const add = (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    const e = parseForceOrder(msg);
    if (e) { events.push(e); if (events.length > 200_000) events = events.slice(-100_000); }
  };
  const connect = () => {
    if (!WebSocketImpl) { console.error('liquidations: this Node has no WebSocket, /rekt is off'); return; }
    try { ws = new WebSocketImpl(url); } catch (e) { console.error('liquidations connect error:', e.message); schedule(); return; }
    ws.onopen = () => { retry = 0; startedAt ??= now(); };
    ws.onmessage = (m) => add(typeof m.data === 'string' ? m.data : String(m.data));
    ws.onerror = () => {};
    ws.onclose = schedule;
  };
  const schedule = () => { clearTimeout(timer); retry += 1; timer = setTimeout(connect, Math.min(60_000, 2_000 * retry)); timer.unref?.(); };
  return {
    start() { connect(); setInterval(prune, 600_000).unref?.(); },
    stop() { clearTimeout(timer); try { ws?.close(); } catch { /* already closed */ } },
    add, // exposed for tests
    events: () => events,
    coveredMs: () => (startedAt ? now() - startedAt : 0),
    summary: (windowKey = '4h') => summarizeLiquidations(events, REKT_WINDOWS[windowKey] ?? REKT_WINDOWS['4h'], now()),
  };
}
