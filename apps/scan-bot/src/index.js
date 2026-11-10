import dns from 'node:dns';
import { Bot, InlineKeyboard, InputFile } from 'grammy';
import {
  upsertUser, fetchPairsByTokens, fetchTrending, fetchTokenMarket, esc, formatUsd,
  addWatch, removeWatch, isWatching, listWatches, setAlertPct, setWatchAlertPct, listAllWatches, updateWatchBase, removeAllWatches, markCurveAlerted, setVolBaseline, setWatchOnCurve, countAllWatches,
  recordFirstCall, getFirstCall, addTargets, listTargets, removeTargets, listActiveTargets, markTargetFired, addReminder, listReminders, removeReminder, dueReminders, markReminderDone, listChatCalls, listUserCalls, listLiveCalls, setCallMilestone, setCallPeak, setCallMessage, getMilestoneSetting, setMilestoneSetting, findCallerByName, callerRecord, keepDbWarm, listCallChats, moveChatData, addXFollow, removeXFollow, listXFollows, listAllXFollows, setXCursor, setXPoll, ensureXTables, getWorkerHeartbeat, query, MAX_X_FOLLOWS,
  MAX_WATCHES,
  ensurePaperAccount, getPaperAccount, getStrategy, updateStrategy, listEnabledStrategies, listStrategiesByIds, hasOpenPosition, openPosition, listOpenPositions, listClosedPositions, closePosition, getPaperPosition, getRealizedPnlToday, setPositionMessage, setPositionMilestone,
  closePartialPosition, resetPaperAccount, recordEquitySnapshot, listEquitySnapshots,
} from '@omnibot/shared';
import {
  parseMintInput, extractMint, looksLikeMint, parseAlertPct, shouldAlert,
  buildScanCard, buildTrendingText, buildWatchlistText, buildAlertText, buildCurveGraduationText, buildVolumeSpikeText,
  multiple, buildCallLine, buildLeaderboard, buildLeaderboardText, parsePeriod, buildGroupBoard, buildGroupBoardText, buildUserCallsText, buildSocialLine, formatPriceCard, formatCount, shortPct,
} from './scan.js';
import {
  matchesStrategy, matchesSourceFilter, hasRoom, capSize, withinDailyLimit, MIN_TRADE_USD, pnlPct, shouldClose,
  partialTpHit, partialCloseSize,
  buildAccountText, buildStrategyText, buildPositionsText, buildHistoryText, buildOpenNotice, buildCloseNotice,
  buildAgentCallNotice, buildMilestoneNotice, buildStatsText, buildPartialCloseNotice, buildWhyText,
  buildPositionCard, positionKeyboard,
} from './paper.js';
import { decideWithAgent } from './agent.js';
import { buildPaperPnlSvg, buildPaperPnlCaption } from './pnlcard.js';
import { startIntel, gatherIntel, within, hedge } from './intel.js';
import { getSolBalance, getSolBalances, getHolderTokens, scanCreatedTokens, getTokenMeta, getCreatorOnChain, getDeployerOnChain, getHoldingPct, getWalletFunding, scanDevLaunches, getTokenNames, getTokenImage, rpcStats } from './chain.js';
import { loadBubbleData } from './bubbleload.js';
import { renderPng, renderRaw } from './bubblemap.js';
import { getArt, getMeme, refillArt, clearOldCache, OWN_DIR, sniffMime } from './memeart.js';
import { usdFromQuote, quoteUsd, fetchLaunchMarket } from './curvemarket.js';
import { buildCandleSvg, defaultTf, parseTf, TFS } from './chartimg.js';
import { shrinkArt, cardToJpeg, rawToJpeg, hasSharp } from './imgfast.js';
import { normHandle, extractMints, pickNew, xCallerId, fetchTweets, loadXFeed } from './xfeed.js';
import { buildFollowAddedText, buildFollowingText, buildXCallHeader, buildMyCallsText, buildFcText, buildLastText, buildTargetSetText, buildTargetsText, buildTargetHitText, buildReminderSetText, buildRemindersText, buildReminderFiredText, buildConvertText, buildEpochText, buildIdText, buildHelpText, buildStatusText, fmtX, callMsgLink } from './ux.js';
import { mkdir, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { buildPnlSvg, buildPnlCaption, newMilestone, peakMultiple } from './pnlcard.js';
import { startMiniApp, buildMapPayload } from './miniapp.js';
import { buildDashSearchJson, buildDashTrendingJson, buildDashWatchlistJson, buildDashTokenJson, buildPaperJson } from './dashboard.js';
import { livePrices, parseMilestoneArg, buildMilestoneSettingText, buildMilestoneCaption } from './milestones.js';
import { callMapRows, buildCallMapSvg, buildCallMapCaption } from './callmap.js';
import { fetchLoreStory, fetchNews, fetchTweetText, getLastLoreError, searchTokens, fetchDexPaid, fetchPriceSeries, buildChartUrl, fetchPeakSince, fetchCandles, generateText, rugCheckStatus } from './sources.js';
import { formatDuration } from './scan.js';
import { parseTargets, targetLabel, targetHit, parseDelay, analyzeCloses, buildTaText, TA_FRAMES, fetchCloses, isPublicUrl, stripHtml, parseTranslate, normPeriod, fetchTopCoins, buildHeatmapSvg, buildMoversText, fetchPolymarket, buildPolymarketText, parseAmount, parseEpoch, csvCell } from './extras.js';
import { buildHoldersText, buildDevText, buildLoreText, valueHoldings, mergeLaunches, isAddr } from './detail.js';
import { fetchTrades, aggregateTraders, estimateProfits, buildTopTradersText, buildTopWalletsText, buildWalletText, parseRektWindow, buildRektText, createLiquidationFeed } from './traders.js';

// Windows often tries IPv6 first and waits for it to fail; going straight to IPv4 makes every web request faster
// and fixes many "fetch failed" errors.
dns.setDefaultResultOrder('ipv4first');

if (!process.env.SCAN_BOT_TOKEN) throw new Error('SCAN_BOT_TOKEN is not set');
const bot = new Bot(process.env.SCAN_BOT_TOKEN);

const TRADE_USERNAME = process.env.TRADE_BOT_USERNAME || 'OmniTradeBot';
const LAUNCH_USERNAME = process.env.LAUNCH_BOT_USERNAME || 'OmniLaunchBot';
const HTML = { parse_mode: 'HTML', link_preview_options: { is_disabled: true } };
const tradeLink = (mint) => `https://t.me/${TRADE_USERNAME}?start=buy_${mint}`;
const short = (a) => `${a.slice(0, 4)}…${a.slice(-4)}`;

// The user row is saved once per person per run (and waited for at most 2.5 s), not on every message.
const savedUsers = new Map(); // id -> username last saved
bot.use(async (ctx, next) => {
  const t0 = Date.now();
  const u = ctx.from;
  if (u && savedUsers.get(u.id) !== (u.username ?? '')) {
    const save = upsertUser({ id: u.id, username: u.username }).then(() => savedUsers.set(u.id, u.username ?? ''));
    save.catch((e) => console.error('user save error:', e.message));
    await within(save, 2_500);
  }
  await next();
  const ms = Date.now() - t0;
  if (ms > 4_000) console.log(`slow reply: ${ms}ms (${ctx.message?.text?.slice(0, 20) ?? ctx.callbackQuery?.data?.slice(0, 20) ?? 'update'})`);
});

// Show text by editing the current message (button taps) or sending a new one.
async function render(ctx, text, kb, edit, extra = {}) {
  const opts = { ...HTML, reply_markup: kb, ...extra };
  if (edit) {
    try { return await ctx.editMessageText(text, opts); }
    catch (err) { if (/not modified/i.test(err.message)) return; }
  }
  return ctx.reply(text, opts);
}

// Dashboard Mini App: full-screen home/search/trending/watchlist. Telegram only allows webApp buttons in
// private chats (same restriction as the Bubblemap button), so groups just skip it.
const homeKeyboard = (group = false) => {
  const kb = new InlineKeyboard().text('🔥 Trending', 'trend').text('⭐ Watchlist', 'wl').row();
  if (MINIAPP_URL && !group) kb.webApp('📊 Open dashboard', `${MINIAPP_URL}/app`).row();
  return kb.url('Omni Trade', `https://t.me/${TRADE_USERNAME}`).url('Omni Launch', `https://t.me/${LAUNCH_USERNAME}`);
};

const showHome = (ctx) => ctx.reply(
  'Omni Scan Bot\n\nResearch only: no wallet, no trading here.\nPaste a token address to see its card, or tap below.',
  { reply_markup: homeKeyboard(isGroup(ctx)) }
);

// One token's market data: DexScreener first, pump.fun as a fallback for very new tokens.
async function getMarket(mint) {
  let m = null;
  try { m = (await hedge(() => fetchPairsByTokens([mint]), 1_800)).get(mint) ?? null; } catch (e) { console.error('dexscreener error:', e.message); }
  if (!m) {
    try {
      const f = await fetchTokenMarket(mint);
      if (f) m = { mint, ...f, volume24h: null, change1h: null, change24h: null };
    } catch (e) { console.error('fallback market error:', e.message); }
  }
  // Tokens on other launchpads (letsbonk.fun...): DexScreener has no pair yet, Jupiter / GeckoTerminal already list them.
  if (!m || !m.priceUsd) {
    try {
      const l = await fetchLaunchMarket(mint);
      if (l) m = { ...(m ?? {}), ...l, mint, change1h: l.change1h ?? m?.change1h ?? null, change24h: l.change24h ?? m?.change24h ?? null };
    } catch (e) { console.error('launchpad market error:', e.message); }
  }
  // A new pump.fun token is quoted in another token (WLFI...): DexScreener then gives only the price in that token,
  // so the dollar price is that times the quote token's own dollar price. Never a guess: no quote price, no number.
  if (m && !m.priceUsd && m.priceNative > 0 && m.quoteAddress) {
    try {
      const u = usdFromQuote(m, await quoteUsd(fetchPairsByTokens, m.quoteAddress));
      if (u) m = { ...m, priceUsd: u.priceUsd, marketCapUsd: m.marketCapUsd ?? (m.dex && /pump/i.test(m.dex) ? u.marketCapUsd : null) };
    } catch (e) { console.error('quote price error:', e.message); }
  }
  // Links (X, Telegram, website) and names from the token's own metadata when nothing else listed them.
  if (m && !(m.socials?.length) && !(m.websites?.length)) {
    const meta = await within(getTokenMeta(mint), 3_500);
    if (meta) m = { ...m, name: m.name ?? meta.name, symbol: m.symbol ?? meta.symbol, socials: meta.socials, websites: meta.websites };
  }
  return m;
}

// Bubblemap: tapping the button opens the real, interactive bubblemaps.io graph straight inside Telegram (no
// extra message first). Telegram only allows that popup in private chats, so groups get a normal link instead
// (a hard platform limit, not something this bot can change).
const MINIAPP_URL = (process.env.MINIAPP_URL || '').trim().replace(/\/+$/, '');
const bubbleUrl = (mint) => `https://v2.bubblemaps.io/map?address=${mint}&chain=solana`;
const bubbleButton = (kb, mint, group = false) => (group ? kb.url('🫧 Bubblemap', bubbleUrl(mint)) : kb.webApp('🫧 Bubblemap', bubbleUrl(mint)));

// Data for the mini app: the same holders, funding groups and layout as the picture.
async function loadMapData(mint) {
  const card = await cachedCard(mint);
  const loaded = await loadBubbleData(mint, card);
  return loaded ? buildMapPayload({ symbol: card.market?.symbol ?? null, name: card.market?.name ?? null, market: card.market ?? null, loaded }) : null;
}

// The full dashboard Mini App (Home/search/trending, Watchlist, Token view): live data for the routes
// in miniapp.js, shaped into dashboard JSON by the pure helpers in dashboard.js.
const dash = {
  botToken: process.env.SCAN_BOT_TOKEN,
  search: async (q) => buildDashSearchJson(await searchTokens(q)),
  trending: async () => buildDashTrendingJson(await fetchTrending(10)),
  getToken: async (mint) => buildDashTokenJson(mint, await cachedCard(mint)),
  getWatchlist: async (telegramId) => {
    const rows = await listWatches(telegramId);
    if (!rows.length) return [];
    let prices = new Map();
    try { prices = await fetchPairsByTokens(rows.map((r) => r.mint)); } catch (e) { console.error('dashboard watchlist prices error:', e.message); }
    return buildDashWatchlistJson(rows, prices);
  },
  getPaper: async (telegramId) => {
    if (!paperAccessAllowed(telegramId)) return { restricted: true };
    await ensurePaperAccount(telegramId);
    const [account, strategy, positions, history, equityHistory] = await Promise.all([
      getPaperAccount(telegramId), getStrategy(telegramId), listOpenPositions(telegramId), listClosedPositions(telegramId, { limit: 20 }), listEquitySnapshots(telegramId, { limit: 100 }),
    ]);
    let prices = new Map();
    if (positions.length) { try { prices = await callPrices(positions.map((p) => p.mint)); } catch (e) { console.error('dashboard paper prices error:', e.message); } }
    return buildPaperJson({ account, strategy, positions, prices, history, equityHistory: equityHistory.map((e) => ({ equityUsd: Number(e.equity_usd), recordedAt: e.recorded_at })) });
  },
  updatePaperStrategy: async (telegramId, patch) => {
    if (!paperAccessAllowed(telegramId)) return { restricted: true };
    await ensurePaperAccount(telegramId);
    await updateStrategy(telegramId, cleanStrategyPatch(patch));
    return dash.getPaper(telegramId);
  },
  sharePaperCard: (telegramId, id) => (paperAccessAllowed(telegramId) ? buildAndSharePaperCard(telegramId, id) : { ok: false, error: 'restricted' }),
  addWatch: async (telegramId, mint, customPct, username = null) => {
    // The Mini App talks straight to this server, bypassing the bot middleware that otherwise keeps the
    // users row up to date — watchlist.telegram_id is a foreign key to it, so make sure it exists first.
    await upsertUser({ id: telegramId, username }).catch((e) => console.error('dashboard user save error:', e.message));
    return (await addWatchFull(telegramId, mint, { customPct })).status;
  },
  removeWatch: (telegramId, mint) => removeWatch(telegramId, mint),
};

const cardKeyboard = (mint, watched, group = false) =>
  bubbleButton(new InlineKeyboard()
    .url('⚡ Buy on Omni Trade', tradeLink(mint)).row(), mint, group).row()
    .text('👥 Top holders', `h:${mint}`).text('👨‍💻 Dev', `d:${mint}`).text('📖 Lore', `l:${mint}`).row()
    .text(watched ? '✖ Unwatch' : '⭐ Watch', `${watched ? 'uw' : 'w'}:${mint}`).text('↻ Refresh', `r:${mint}`).row()
    .url('📈 DexScreener', `https://dexscreener.com/solana/${mint}`).url('🔍 Solscan', `https://solscan.io/token/${mint}`).row()
    .url('Birdeye', `https://birdeye.so/token/${mint}?chain=solana`).url('GMGN', `https://gmgn.ai/sol/token/${mint}`).url('RugCheck', `https://rugcheck.xyz/tokens/${mint}`).row()
    .url('𝕏 Search', `https://x.com/search?q=${mint}&f=live`).text('🔥 Trending', 'trend').text('⭐ List', 'wl');

const isGroup = (ctx) => ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup';
const callerName = (from) => (from.username ? `@${from.username}` : from.first_name || 'someone');
const lastGroupCard = new Map(); // chatId -> timestamp, keeps a busy group from flooding the bot

// In a group the first person to post a token gets the call; later posts just show who did.
async function callFor(ctx, mint, market, record) {
  if (record && market?.priceUsd) {
    const r = await recordFirstCall({
      chatId: ctx.chat.id, mint, symbol: market.symbol, callerId: ctx.from.id, callerName: callerName(ctx.from),
      priceUsd: market.priceUsd, mcapUsd: market.marketCapUsd, msgId: ctx.message?.message_id ?? null,
    });
    if (r.first) tryPaperBuy({ mint, symbol: market.symbol, priceUsd: market.priceUsd, mcapUsd: market.marketCapUsd, source: 'group call', sourceId: String(ctx.chat.id) }).catch((e) => console.error('paper buy error:', e.message));
    return r.call;
  }
  return getFirstCall(ctx.chat.id, mint);
}

// Agent/hybrid strategies call out to an LLM per candidate signal. Rate-limited per user, separately from
// the user-initiated /tr /tldr /eli5 limiter below, to protect the Gemini free quota from a busy group.
const agentUse = new Map();
function agentAllowed(id) {
  const now = Date.now();
  const list = (agentUse.get(id) ?? []).filter((t) => now - t < 3_600_000);
  if (list.length >= 20) return false;
  list.push(now); agentUse.set(id, list);
  return true;
}

// Public access controls: reuses the same ADMIN_IDS convention already used elsewhere in this file (e.g.
// /pnlbg) rather than inventing a new env var. PAPER_PUBLIC=1 opens paper trading to everyone regardless of
// ADMIN_IDS. Otherwise, if ADMIN_IDS is set, only those Telegram IDs may use it; if ADMIN_IDS is unset, paper
// trading stays open to everyone (fail-open, so an existing install is never locked out by this feature alone).
function paperAccessAllowed(telegramId) {
  if (process.env.PAPER_PUBLIC === '1') return true;
  const ids = (process.env.ADMIN_IDS ?? '').split(',').map((v) => v.trim()).filter(Boolean);
  if (!ids.length) return true;
  return ids.includes(String(telegramId));
}
const PAPER_RESTRICTED_MSG = 'Paper trading on this bot is currently limited to its operator.';

// Phase 5: a one-time-per-day heads-up when the daily loss stop trips, instead of silently doing nothing on
// every signal — transparency (plan section 7) applies to being paused, not just to why a trade was taken.
const dailyStopNotified = new Map(); // telegram_id -> 'YYYY-MM-DD' already notified today
function notifyDailyStopOnce(telegramId) {
  const today = new Date().toISOString().slice(0, 10);
  if (dailyStopNotified.get(telegramId) === today) return;
  dailyStopNotified.set(telegramId, today);
  bot.api.sendMessage(telegramId,
    '🛑 Paper trading paused for today — your daily loss stop was hit. New trades resume tomorrow (UTC); any open positions still get checked for take-profit/stop-loss.',
    HTML).catch(() => {});
}

// Paper trading: a new, first-anywhere call just appeared. Open a paper position for every user whose strategy
// matches (or, in Agent/Hybrid mode, every user whose AI agent decides to buy or just call it out). Fire-and-
// forget from the caller's point of view — never slows down or fails a real call/card.
//
// Phase 3 (Agent Mode): mode 'rules' is unchanged v1 behavior. 'agent' skips the market-cap filter entirely and
// lets the AI decide from the call context plus the user's own instructions. 'hybrid' applies the market-cap
// filter as a hard pre-filter first, then still asks the AI to decide — rules are the risk guard, the agent
// operates inside them (plan section 3.3).
// Phase 4: the agent's decision can be 'call' — flag the token to the user with no paper trade, no capital risked.
// Phase 5: the daily-loss stop and the per-trade size cap (capSize) are hard limits that now apply in EVERY
// mode, not just Agent/Hybrid — "hard risk limits always apply" (plan section 7) covers rule-based trades too.
async function tryPaperBuy({ mint, symbol, priceUsd, mcapUsd, source = null, sourceId = null }) {
  const strategies = await listEnabledStrategies();
  for (const s of strategies) {
    if (!paperAccessAllowed(s.telegram_id)) continue; // public access controls: operator-only installs stay operator-only
    if (!hasRoom(s)) continue;
    if (await hasOpenPosition(s.telegram_id, mint)) continue; // already holding this one
    if (!matchesSourceFilter(s, sourceId)) continue; // source filter: hard, applies in every mode
    const mode = s.mode ?? 'rules';
    const todayPnl = await getRealizedPnlToday(s.telegram_id).catch(() => 0);
    if (!withinDailyLimit(s, todayPnl, Number(s.balance_usd))) { notifyDailyStopOnce(s.telegram_id); continue; }

    let decisionReason = null, decisionDetail = null, sizePct = null;
    if (mode === 'rules') {
      if (!matchesStrategy(s, { mcapUsd })) continue;
    } else {
      if (mode === 'hybrid' && !matchesStrategy(s, { mcapUsd })) continue; // hard filter before the agent sees it
      if (!process.env.GEMINI_API_KEY || !agentAllowed(s.telegram_id)) continue; // fail closed — never a silent buy
      const decision = await decideWithAgent({
        instructions: s.agent_prompt, strategy: s, call: { mint, symbol, mcapUsd, source },
        apiKey: process.env.GEMINI_API_KEY,
        generateTextImpl: (args) => generateText({ ...args, models: process.env.GEMINI_MODEL ? [process.env.GEMINI_MODEL] : null }),
      }).catch((e) => { console.error('agent decide error:', e.message); return { decision: 'skip', sizePct: null, reason: null, detail: null }; });
      if (decision.decision === 'skip') continue;
      if (decision.decision === 'call') { // a heads-up only — no paper trade, no capital at risk
        bot.api.sendMessage(s.telegram_id, buildAgentCallNotice({ symbol, mint, mcapUsd, reason: decision.reason, source }), HTML).catch(() => {});
        continue;
      }
      decisionReason = decision.reason; decisionDetail = decision.detail ?? null; sizePct = decision.sizePct;
    }
    const size = capSize(s, Number(s.balance_usd), sizePct); // hard per-trade cap in every mode (section 7)
    if (size < MIN_TRADE_USD) continue; // balance too low to bother
    const id = await openPosition({ telegramId: s.telegram_id, mint, symbol, entryPriceUsd: priceUsd, entryMcapUsd: mcapUsd, sizeUsd: size, openMode: mode, decisionReason, decisionDetail, source });
    const sent = await bot.api.sendMessage(s.telegram_id, buildOpenNotice({ symbol, mint, sizeUsd: size, mcapUsd, openMode: mode, decisionReason, source }), HTML).catch(() => null); // user may have blocked the bot
    if (sent?.message_id) setPositionMessage(id, sent.message_id).catch(() => {}); // lets milestone/exit replies thread under this call
  }
}

// Keeps Telegram's "typing…" going while we work, instead of posting a "loading" message.
async function withTyping(ctx, fn, action = 'typing') {
  const send = () => ctx.api.sendChatAction(ctx.chat.id, action).catch(() => {});
  send();
  const t = setInterval(send, 4000);
  try { return await fn(); } finally { clearInterval(t); }
}

// Recently built cards, so the Top holders / Dev / Lore buttons answer instantly.
const cardCache = new Map(); // mint -> { at, market, security, intel }
const CARD_TTL_MS = 10 * 60_000;
const loading = new Map(); // mint -> Promise: simultaneous requests for one token share a single lookup
function loadCard(mint) {
  if (loading.has(mint)) return loading.get(mint);
  const p = (async () => {
    const t0 = Date.now(); const s0 = rpcStats();
    const pre = startIntel(mint); // RPC + RugCheck start now, at the same time as the market lookup
    let market = await getMarket(mint);
    const tMarket = Date.now() - t0;
    // No picture from DexScreener (a brand-new token)? Read it from the token's own metadata, while the rest loads.
    const imgP = market && !market.imageUrl && !market.headerUrl ? within(getTokenImage(mint), 3_000, null) : null;
    const [{ security, intel }, img] = await Promise.all([gatherIntel(mint, market, pre), imgP]);
    if (img) market = { ...market, imageUrl: img };
    const s1 = rpcStats(); // one line per card, handy when something feels slow
    console.log(`card ${short(mint)} ${Date.now() - t0}ms (market ${tMarket}ms), rpc calls ${s1.calls - s0.calls}, retried ${s1.retries - s0.retries}`);
    if (cardCache.size > 200) cardCache.delete(cardCache.keys().next().value);
    const card = { at: Date.now(), market, security, intel };
    cardCache.set(mint, card);
    return card;
  })().finally(() => loading.delete(mint));
  loading.set(mint, p);
  return p;
}
const cachedCard = async (mint) => {
  const c = cardCache.get(mint);
  return c && Date.now() - c.at < CARD_TTL_MS ? c : loadCard(mint);
};

async function showToken(ctx, mint, { edit = false, record = false } = {}) {
  const group = isGroup(ctx);
  // One complete card, sent once it is ready. No placeholder message.
  // A card built in the last 20 seconds is reused (a Refresh always rebuilds it).
  const fresh = !edit && cardCache.get(mint);
  const { market, security, intel } = fresh && Date.now() - fresh.at < 20_000 ? fresh : edit ? await loadCard(mint) : await withTyping(ctx, () => loadCard(mint));
  const [watched, call] = await Promise.all([
    group ? false : within(isWatching(ctx.from.id, mint), 1_500, false), // a group card is shared, so no personal ⭐ state there
    group ? within(callFor(ctx, mint, market, record).catch((e) => { console.error('call error:', e.message); return null; }), 2_500, null) : null,
  ]);
  const callLine = buildCallLine(call, market?.priceUsd);
  const kb = cardKeyboard(mint, watched, group);
  // The token's banner (or logo) shows above the text, like Rick does.
  const previewUrl = market?.headerUrl || market?.imageUrl || null;
  const preview = previewUrl ? { link_preview_options: { url: previewUrl, show_above_text: true, prefer_large_media: true } } : {};
  const reply = group && !edit && ctx.message ? { reply_parameters: { message_id: ctx.message.message_id, allow_sending_without_reply: true } } : {};
  const text = buildScanCard({ mint, market, security, intel, callLine, watched });
  return render(ctx, text, kb, edit, edit ? preview : { ...preview, ...reply });
}

// ---- detail views: Top holders, Dev, Lore. Each answers as a new message under the card. ----
const detailText = new Map(); // `${kind}:${mint}` -> { at, text }
const DETAIL_TTL_MS = 5 * 60_000;
const lastDetailAt = new Map(); // userId -> timestamp
async function showDetail(ctx, kind, mint, build) {
  if (ctx.callbackQuery) await ctx.answerCallbackQuery().catch(() => {});
  const now = Date.now();
  if (now - (lastDetailAt.get(ctx.from.id) ?? 0) < 1500) return; // ignore rapid repeat taps
  lastDetailAt.set(ctx.from.id, now);
  const key = `${kind}:${mint}`;
  let text = detailText.get(key)?.at > now - DETAIL_TTL_MS ? detailText.get(key).text : null;
  let later = null;
  if (!text) {
    try {
      const out = await withTyping(ctx, build);
      text = typeof out === 'string' ? out : out.text;
      later = typeof out === 'string' ? null : out.later;
    } catch (e) { console.error(`${kind} view error:`, e.message); text = 'Could not load that right now. Try again in a moment.'; }
    if (detailText.size > 300) detailText.delete(detailText.keys().next().value);
    detailText.set(key, { at: now, text });
  }
  const origin = ctx.callbackQuery?.message?.message_id ?? ctx.message?.message_id;
  const closeKb = new InlineKeyboard().text('🗑 Close', 'x');
  const sent = await ctx.reply(text, {
    ...HTML,
    reply_markup: closeKb,
    ...(origin ? { reply_parameters: { message_id: origin, allow_sending_without_reply: true } } : {}),
  });
  // A longer job (the Dev scan of a big wallet) finishes after the first answer: the message is updated in place.
  if (later) {
    later.then(async (t) => {
      if (!t) return;
      detailText.set(key, { at: Date.now(), text: t });
      await ctx.api.editMessageText(sent.chat.id, sent.message_id, t, { ...HTML, reply_markup: closeKb }).catch(() => {});
    }).catch((e) => console.error('late update error:', e.message));
  }
  return sent;
}

// Bubblemap: one tap opens the real, interactive bubblemaps.io graph straight inside Telegram. No summary text first.
async function sendBubblemap(ctx, mint) {
  if (ctx.callbackQuery) await ctx.answerCallbackQuery().catch(() => {});
  const now = Date.now();
  if (now - (lastDetailAt.get(ctx.from.id) ?? 0) < 1500) return; // ignore rapid repeat taps
  lastDetailAt.set(ctx.from.id, now);
  const origin = ctx.callbackQuery?.message?.message_id ?? ctx.message?.message_id;
  const reply = origin ? { reply_parameters: { message_id: origin, allow_sending_without_reply: true } } : {};
  const kb = bubbleButton(new InlineKeyboard(), mint, isGroup(ctx)).row().text('🗑 Close', 'x');
  return ctx.reply('🫧 <b>Bubble map</b>', { ...HTML, reply_markup: kb, ...reply });
}

async function buildHolders(mint) {
  const c = await cachedCard(mint);
  const top = (c.intel.top ?? []).filter((h) => isAddr(h.owner)).slice(0, 10);
  if (!top.length) return buildHoldersText({ market: c.market, holders: [] });
  const owners = top.map((h) => h.owner);
  const [sols, tokens] = await Promise.all([getSolBalances(owners), getHolderTokens(owners)]);
  const toPrice = [...new Set([...tokens.values()].flat().map((t) => t.mint))].filter((m) => m !== mint).slice(0, 120);
  let prices = new Map();
  if (toPrice.length) { try { prices = await fetchPairsByTokens(toPrice); } catch (e) { console.error('holder prices error:', e.message); } }
  const linked = new Set(c.intel.linked ?? []);
  const holders = top.map((h) => ({
    owner: h.owner, pct: h.pct, linked: linked.has(h.owner), sol: sols.get(h.owner) ?? null,
    holdings: tokens.has(h.owner) ? valueHoldings(tokens.get(h.owner), prices, mint) : null,
  }));
  return buildHoldersText({ market: c.market, holders });
}

async function buildDev(mint) {
  const c = await cachedCard(mint);
  // The dev is the wallet that deployed the token (paid for its creation). pump.fun's stored "creator" (which
  // RugCheck repeats) can be a different wallet, e.g. when a launch tool or fee sharing is used; it is shown as the fee wallet.
  const stored = c.intel.creator ?? null;
  const deployer = await getDeployerOnChain(mint);
  const creator = deployer ?? stored ?? (await getCreatorOnChain(mint));
  const sh = (a) => (a ? a.slice(0, 6) + '…' + a.slice(-4) : 'none');
  console.log(`dev wallet: ${sh(creator)} (deployer ${sh(deployer)}, stored creator ${sh(stored)}, RugCheck ${sh(c.intel.rugCreator)})`);
  if (!creator) return buildDevText({ market: c.market, creator: null });
  const devPct = !stored || creator === stored ? c.intel.devPct : await getHoldingPct(creator, mint);
  const solBalancePromise = getSolBalance(creator);
  const fundingPromise = within(getWalletFunding(creator), 6_000);
  // The wallet's history is scanned for token creations (all of it when Helius is available). The first answer
  // goes out after a few seconds; if the scan is still going, `later` carries the finished text.
  const scan = scanDevLaunches(creator);
  let snap = null;
  try { snap = await scan.first; } catch (e) { console.error('dev scan error:', e.message); }
  const cur = scan.current?.(); // a repeat tap should see everything the background scan found since
  if (cur && cur.scannedTx > (snap?.scannedTx ?? 0)) snap = cur;
  const [solBalance, funding] = await Promise.all([solBalancePromise, fundingPromise]);
  const make = async (s) => {
    let launches = s ? [...s.launches] : null;
    // This token was made by this wallet, so it always belongs in the list.
    if (!launches?.some((l) => l.mint === mint)) launches = [...(launches ?? []), { mint, createdAt: c.market?.createdAt ?? c.intel.detectedAt ?? null }];
    let markets = new Map();
    try { markets = await fetchPairsByTokens(launches.map((l) => l.mint).slice(0, 30)); } catch (e) { console.error('launch prices error:', e.message); }
    if (c.market) markets.set(mint, c.market);
    // dead launches have no DexScreener listing: read their names from the chain
    const unnamed = launches.filter((l) => !markets.get(l.mint)?.symbol).map((l) => l.mint).slice(0, 60);
    if (unnamed.length) {
      const names = await within(getTokenNames(unnamed), 4_000, new Map());
      launches = launches.map((l) => (names.has(l.mint) ? { ...l, symbol: names.get(l.mint) } : l));
    }
    return buildDevText({
      market: c.market, creator, creatorFees: stored, funding, devPct, solBalance,
      launches: mergeLaunches(launches, markets, mint), source: 'rpc', scannedTx: s?.scannedTx ?? 0, partial: !s,
      scanDone: !!s?.reachedEnd, scanning: !!s && !s.reachedEnd && !s.final,
    });
  };
  const text = await make(snap);
  if (snap?.reachedEnd) return text;
  const later = scan.done.then((f) => (f && (f.scannedTx > (snap?.scannedTx ?? 0) || f.launches.length > (snap?.launches.length ?? 0)) ? make({ ...f, final: true }) : null)).catch(() => null);
  return { text, later };
}

const buildLore = async (mint, userId) => {
  const c = await cachedCard(mint);
  const m = c.market;
  const x = (m?.socials ?? []).find((s) => ['twitter', 'x'].includes(String(s.type).toLowerCase()))?.url ?? null;
  const name = m?.name ?? c.intel.meta?.name ?? null;
  const symbol = m?.symbol ?? c.intel.meta?.symbol ?? null;
  // The linked post and the news search run first (together); the AI then writes the story from everything we found.
  const [postText, headlines] = await Promise.all([x ? fetchTweetText(x) : null, fetchNews({ name, symbol })]);
  const story = await fetchLoreStory(
    {
      mint, name, symbol, description: c.intel.meta?.description ?? null, xUrl: x, postText, imageUrl: m?.imageUrl ?? m?.headerUrl ?? null,
      ageText: typeof m?.createdAt === 'number' ? `${Math.max(1, Math.round((Date.now() - m.createdAt) / 3_600_000))}h` : null,
    },
    {
      anthropicKey: process.env.ANTHROPIC_API_KEY, anthropicModel: process.env.LORE_MODEL || undefined,
      geminiKey: process.env.GEMINI_API_KEY, geminiModels: process.env.GEMINI_MODEL ? [process.env.GEMINI_MODEL] : undefined,
      dailyMax: Number(process.env.LORE_DAILY_MAX) || undefined, perUserMax: Number(process.env.LORE_PER_USER_MAX) || undefined, userId,
    },
  );
  // LORE_DEBUG=1 in .env shows the reason in the chat when the AI could not write a summary.
  const debugNote = process.env.LORE_DEBUG && !story && (process.env.GEMINI_API_KEY || process.env.ANTHROPIC_API_KEY) ? getLastLoreError() : null;
  return buildLoreText({ market: m, narrative: story?.text ?? null, grounded: story?.grounded ?? true, meta: c.intel.meta, headlines, detectedAt: c.intel.detectedAt, debugNote });
};

async function showTrending(ctx, { edit = false } = {}) {
  let tokens;
  try { tokens = await fetchTrending(8); }
  catch (e) { console.error('trending error:', e.message); return ctx.reply('Could not load trending right now. Try again in a minute.'); }
  const kb = new InlineKeyboard();
  tokens.forEach((t, i) => { kb.text(`${i + 1}. ${t.symbol ? '$' + t.symbol : short(t.mint)}`, `t:${t.mint}`); if (i % 2 === 1) kb.row(); });
  if (tokens.length % 2 === 1) kb.row();
  kb.text('↻ Refresh', 'trend').text('⭐ Watchlist', 'wl');
  return render(ctx, buildTrendingText(tokens), kb, edit);
}

async function showWatchlist(ctx, { edit = false } = {}) {
  const rows = await listWatches(ctx.from.id);
  let prices = new Map();
  if (rows.length) {
    try { prices = await fetchPairsByTokens(rows.map((r) => r.mint)); } catch (e) { console.error('watchlist prices error:', e.message); }
  }
  const kb = new InlineKeyboard();
  rows.forEach((r, i) => { kb.text(r.symbol ? `$${r.symbol}` : short(r.mint), `t:${r.mint}`); if (i % 3 === 2) kb.row(); });
  if (rows.length % 3 !== 0) kb.row();
  kb.text('↻ Refresh', 'wl').text('🔥 Trending', 'trend');
  return render(ctx, buildWatchlistText(rows, prices), kb, edit);
}

// Shared by /watch and the dashboard Mini App's "Add to watchlist" button: adds (or updates) a watch and
// the best-effort curve/volume tracking that powers the graduation and volume-spike alerts.
async function addWatchFull(telegramId, mint, { customPct = null } = {}) {
  const market = await getMarket(mint);
  if (!market?.priceUsd) return { status: 'no-price' };
  const r = await addWatch({ telegramId, mint, symbol: market.symbol, priceUsd: market.priceUsd });
  if (r === 'full') return { status: 'full', market };
  if (customPct) await setWatchAlertPct(telegramId, mint, customPct);
  if (r === 'added' && market.dex && /pump\.fun curve/i.test(market.dex)) setWatchOnCurve(telegramId, mint, true).catch(() => {});
  if (r === 'added' && market.volume?.h1 > 0) setVolBaseline(telegramId, mint, market.volume.h1).catch(() => {});
  return { status: r, market };
}

async function doWatch(ctx, mint, { edit = false, customPct = null } = {}) {
  const { status: r, market } = await addWatchFull(ctx.from.id, mint, { customPct });
  if (r === 'no-price') return ctx.reply(`${NO_MARKET} I cannot watch it until it has a price.`);
  if (r === 'full') return ctx.reply(`Your watchlist is full (${MAX_WATCHES} tokens). Remove one with /unwatch first.`);
  const pctLabel = customPct ? ` at ±${customPct}%` : '';
  await ctx.answerCallbackQuery?.({ text: r === 'added' ? 'Added to watchlist' : 'Already on your watchlist' }).catch(() => {});
  if (!edit) await ctx.reply(r === 'added' ? `⭐ Watching ${market.symbol ? '$' + esc(market.symbol) : short(mint)}${pctLabel}. I will message you on big moves.` : `Already on your watchlist.${customPct ? ` Threshold updated to ±${customPct}%.` : ''}`, HTML);
  else await showToken(ctx, mint, { edit: true });
}

async function doUnwatch(ctx, mint, { edit = false } = {}) {
  const removed = await removeWatch(ctx.from.id, mint);
  await ctx.answerCallbackQuery?.({ text: removed ? 'Removed' : 'Not on your watchlist' }).catch(() => {});
  if (!edit) return ctx.reply(removed ? 'Removed from your watchlist.' : 'That token is not on your watchlist.');
  return showToken(ctx, mint, { edit: true });
}

bot.command('start', showHome);
bot.command(['dashboard', 'app'], (ctx) => {
  if (!MINIAPP_URL) return ctx.reply('The dashboard is not turned on for this bot yet.');
  if (isGroup(ctx)) return ctx.reply('Open the dashboard in a private chat with me — Telegram only allows full-screen apps there.');
  return ctx.reply('📊 Your Omni Scan dashboard: search, trending tokens and your watchlist in one place.', { reply_markup: new InlineKeyboard().webApp('Open dashboard', `${MINIAPP_URL}/app`) });
});
bot.command('help', (ctx) => ctx.reply(buildHelpText(), { ...HTML, reply_markup: new InlineKeyboard().text('🗑', 'x') }));
bot.command('token', async (ctx) => {
  const mint = parseMintInput(ctx.match.trim());
  if (!mint) return ctx.reply('Usage: /token <token address>');
  return showToken(ctx, mint);
});
const chartButtons = (mint) => new InlineKeyboard()
  .url('📈 DexScreener', `https://dexscreener.com/solana/${mint}`).url('Birdeye', `https://birdeye.so/token/${mint}?chain=solana`).row()
  .url('GMGN', `https://gmgn.ai/sol/token/${mint}`).url('🔍 Solscan', `https://solscan.io/token/${mint}`);

// A picture of the last 3 days of price, with the chart links underneath. Falls back to links alone.
async function sendChart(ctx, mint) {
  const m = await withTyping(ctx, () => getMarket(mint));
  const pts = m ? await withTyping(ctx, () => fetchPriceSeries({ pairAddress: m.pairAddress, mint })) : null;
  const kb = chartButtons(mint);
  if (pts) {
    const d = m.change?.h24 ?? m.change24h;
    const caption = `${m.symbol ? '$' + esc(m.symbol) : short(mint)}  <b>${formatPriceCard(m.priceUsd)}</b>${d != null ? `  (${shortPct(d)} 24h)` : ''}\n<i>Price, last ${Math.round((pts.at(-1).t - pts[0].t) / 3600) + 1}h</i>`;
    try {
      return await ctx.replyWithPhoto(buildChartUrl(pts, `${m.symbol ? '$' + m.symbol : short(mint)} · USD`), { caption, parse_mode: 'HTML', reply_markup: kb });
    } catch (e) { console.error('chart photo error:', e.message); }
  }
  return ctx.reply('Open the live chart:', { reply_markup: kb });
}
bot.command('trending', (ctx) => showTrending(ctx));

// Quick commands (the bot's menu). Each takes an address, or works on the message you reply to.
function mintFromCommand(ctx) {
  return parseMintInput(ctx.match.trim()) ?? extractMint(ctx.message?.reply_to_message?.text ?? '');
}
const withMint = (usage, fn) => async (ctx) => {
  const mint = mintFromCommand(ctx);
  if (!mint) return ctx.reply(`Usage: ${usage} <token address>\nOr reply to a message that has the address.`);
  return fn(ctx, mint);
};
bot.command('bm', withMint('/bm', (ctx, mint) => sendBubblemap(ctx, mint))); // short alias
bot.command('bubblemap', withMint('/bubblemap', (ctx, mint) => sendBubblemap(ctx, mint)));
bot.command('th', withMint('/th', (ctx, mint) => showDetail(ctx, 'h', mint, () => buildHolders(mint))));
bot.command('dev', withMint('/dev', (ctx, mint) => showDetail(ctx, 'd', mint, () => buildDev(mint))));
bot.command('nar', withMint('/nar', (ctx, mint) => showDetail(ctx, 'l', mint, () => buildLore(mint, ctx.from.id))));
bot.command('lore', withMint('/lore', (ctx, mint) => showDetail(ctx, 'l', mint, () => buildLore(mint, ctx.from.id))));
const NO_MARKET = 'No market data found for that token yet. It may be brand new, already dead, or not a Solana token — double check the address with /token.';
bot.command('soc', withMint('/soc', async (ctx, mint) => {
  const m = await withTyping(ctx, () => getMarket(mint));
  if (!m) return ctx.reply(NO_MARKET);
  return ctx.reply(`${m.symbol ? '$' + esc(m.symbol) : short(mint)}\n${buildSocialLine(m)}`, HTML);
}));
bot.command('dp', withMint('/dp', async (ctx, mint) => {
  const [m, paid] = await withTyping(ctx, () => Promise.all([getMarket(mint), fetchDexPaid(mint)]));
  if (!m) return ctx.reply(NO_MARKET);
  const sym = m.symbol ? '$' + esc(m.symbol) : short(mint);
  const yes = Boolean(paid) || Boolean(m.hasProfile);
  const ago = paid?.paidAt ? formatDuration(Date.now() - paid.paidAt) : null;
  const caption = yes
    ? `✅ <b>DexPaid</b>${ago ? ` · ${ago} ago` : ''} · ${sym}\n${buildSocialLine(m)}`
    : `❌ <b>Not DexPaid</b> · ${sym}`;
  const image = m.headerUrl || m.imageUrl;
  const kb = new InlineKeyboard().url('📈 DexScreener', `https://dexscreener.com/solana/${mint}`);
  if (image) {
    try { return await ctx.replyWithPhoto(image, { caption, parse_mode: 'HTML', reply_markup: kb }); }
    catch (e) { console.error('dp photo error:', e.message); }
  }
  return ctx.reply(caption, { ...HTML, reply_markup: kb });
}));
bot.command('s', async (ctx) => {
  const q = ctx.match.trim();
  if (!q) return ctx.reply('Usage: /s <name or symbol>\nExample: /s barber dog');
  const mint = parseMintInput(q);
  if (mint) return showToken(ctx, mint);
  let list;
  try { list = await withTyping(ctx, () => searchTokens(q)); }
  catch (e) { console.error('search error:', e.message); return ctx.reply('Search is not working right now. Try again in a minute.'); }
  if (!list.length) return ctx.reply(`No Solana token found for "${esc(q)}". Try a shorter or different name, or paste the token address directly.`, HTML);
  const kb = new InlineKeyboard();
  list.forEach((t, i) => { kb.text(`${t.symbol ? '$' + t.symbol : short(t.mint)}${t.marketCapUsd ? ' · ' + formatUsd(t.marketCapUsd) : ''}`, `t:${t.mint}`); if (i % 2 === 1) kb.row(); });
  return ctx.reply(`Results for "${esc(q)}": tap one for its card.`, { ...HTML, reply_markup: kb });
});
bot.command('p', withMint('/p', async (ctx, mint) => {
  const m = await withTyping(ctx, () => getMarket(mint));
  if (!m?.priceUsd) return ctx.reply(NO_MARKET);
  const d = m.change?.h24 ?? m.change24h;
  return ctx.reply(`${m.symbol ? '$' + esc(m.symbol) : short(mint)}  <b>${formatPriceCard(m.priceUsd)}</b>${d != null ? `  (${shortPct(d)} 24h)` : ''}`, HTML);
}));
bot.command('watch', async (ctx) => {
  const arg = ctx.match.trim();
  if (!arg) return showWatchlist(ctx);
  // /watch <address> 30 — optional per-token threshold
  const parts = arg.split(/\s+/);
  const mint = parseMintInput(parts[0]);
  if (!mint) return ctx.reply('Usage: /watch <token address> [alert %]\nExample: /watch So111… 30');
  const customPct = parts[1] ? parseAlertPct(parts[1]) : null;
  return doWatch(ctx, mint, { customPct });
});
bot.command('unwatch', async (ctx) => {
  const mint = parseMintInput(ctx.match.trim());
  if (!mint) return ctx.reply('Usage: /unwatch <token address>');
  return doUnwatch(ctx, mint);
});
bot.command('alerts', (ctx) => showWatchlist(ctx));
bot.command('alertpct', async (ctx) => {
  const pct = parseAlertPct(ctx.match);
  if (pct === null) return ctx.reply('Usage: /alertpct <number from 1 to 1000>\nExample: /alertpct 30 alerts you when a token moves 30% up or down.');
  await setAlertPct(ctx.from.id, pct);
  return ctx.reply(`Alert size set to ±${pct}% for your current watchlist and new watches.`);
});
// Prices for the call views (/calls, /fc, /last, /lb, /pnl, /callmap): DexScreener, then the quote token and the launchpads,
// so curve and letsbonk calls show numbers instead of n/a. Fewer launchpad lookups than the background check, to stay quick.
async function pricesFor(mints) {
  try { return await livePrices(mints, { fetchPairs: fetchPairsByTokens, quoteUsd, launchMarket: (m) => within(fetchLaunchMarket(m), 4_000, null), maxFallback: 8 }); }
  catch (e) { console.error('prices error:', e.message); return new Map(); }
}
const LB_BUTTONS = [['1H', 3600], ['1D', 86400], ['1W', 7 * 86400], ['2W', 14 * 86400], ['1M', 30 * 86400], ['All', 'all']];
const lbKeyboard = (active) => {
  const kb = new InlineKeyboard();
  for (const [name, secs] of LB_BUTTONS) kb.text(String(secs) === String(active) ? `• ${name}` : name, `lb:${secs}`);
  return kb;
};
async function groupBoardText(chat, period) {
  const calls = await listChatCalls(chat.id, { seconds: period.seconds, limit: 400 });
  const prices = calls.length ? await pricesFor(calls.map((c) => c.mint)) : new Map();
  const board = buildGroupBoard(calls, prices);
  // remember new highs so the next board is right even when the chart has no history
  for (const r of board.top.slice(0, 40)) if (r.x > 1 && r.peakPrice > (Number(r.peak_price_usd) || 0) * 1.0001) setCallPeak(chat.id, r.mint, r.peakPrice).catch(() => {});
  return buildGroupBoardText(board, { label: period.label, groupName: plainName(chat.title) });
}
const plainName = (s) => String(s ?? '').replace(/[\p{Extended_Pictographic}\u200d\ufe0f]/gu, '').replace(/\s+/g, ' ').trim() || null;
bot.command(['leaderboard', 'lb'], async (ctx) => {
  if (!isGroup(ctx)) return ctx.reply('Leaderboards work in groups. Add me to your group and post token addresses there.');
  const period = parsePeriod(ctx.match);
  if (!period) return ctx.reply('Try: /leaderboard 1h, /leaderboard 20 minutes, /leaderboard 1 week, /leaderboard 2 weeks, /leaderboard 1 month or /leaderboard all');
  const text = await groupBoardText(ctx.chat, period);
  return ctx.reply(text, { ...HTML, link_preview_options: { is_disabled: true }, reply_markup: lbKeyboard(period.label === 'All time' ? 'all' : period.seconds) });
});
bot.callbackQuery(/^lb:(\d+|all)$/, async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  if (!isGroup(ctx)) return;
  const secs = ctx.match[1] === 'all' ? 'all' : Number(ctx.match[1]);
  const labels = { 3600: '1 hour', 86400: '24h', 604800: '1 week', 1209600: '2 weeks', 2592000: '1 month', all: 'All time' };
  if (!labels[secs]) return;
  const period = { seconds: secs === 'all' ? 20 * 365 * 86400 : secs, label: labels[secs] };
  const text = await groupBoardText(ctx.chat, period);
  return ctx.editMessageText(text, { ...HTML, link_preview_options: { is_disabled: true }, reply_markup: lbKeyboard(secs) }).catch(() => {});
});
// /calls: your calls here. /calls @name, or /calls as a reply to someone's message: that member's calls.
async function callsTarget(ctx) {
  const replied = ctx.message?.reply_to_message?.from;
  if (replied && !replied.is_bot && replied.id !== ctx.from.id) return { id: replied.id, name: callerName(replied), mine: false };
  const arg = (ctx.match ?? '').trim().split(/\s+/)[0];
  if (arg) {
    const found = await findCallerByName(ctx.chat.id, arg);
    return found ? { id: found.caller_id, name: found.caller_name, mine: false } : { missing: arg };
  }
  return { id: ctx.from.id, name: callerName(ctx.from), mine: true };
}
bot.command(['calls', 'groupme'], async (ctx) => {
  if (!isGroup(ctx)) return ctx.reply('Call tracking works in groups. Post a token address in your group to make a call.');
  const who = await callsTarget(ctx);
  if (who.missing) return ctx.reply(`No calls from ${esc(who.missing)} in this group. Use their @username as it shows on their calls, or reply to one of their messages with /calls.`, HTML);
  const calls = await listUserCalls(ctx.chat.id, who.id, { limit: 20 });
  const prices = await withTyping(ctx, () => pricesFor(calls.map((c) => c.mint)));
  return ctx.reply(buildMyCallsText(calls, prices, who.name, Date.now(), { mine: who.mine }), { ...HTML, link_preview_options: { is_disabled: true }, reply_markup: new InlineKeyboard().text('🗑', 'x') });
});
// A call as a share card: /pnl (your latest call here) or /pnl <address> (whoever called it first).
// CARD_FORMAT=jpg in .env makes cards smaller and faster to send (slightly softer). The default is the original: the picture untouched, the card saved as a lossless PNG.
const CARD_JPG = String(process.env.CARD_FORMAT || '').toLowerCase().startsWith('jp');
const CARD_W = Math.min(1920, Math.max(640, Number(process.env.CARD_WIDTH) || 1280)); // lower it (for example 1000) in .env if drawing is slow on your computer
async function pnlPng(call, prices, groupName, { skipHistory = false } = {}) {
  const p = prices.get(call.mint);
  const now = p?.priceUsd ?? null;
  const calledAt = new Date(call.created_at).getTime();
  // How high did it go after the call? The price seen by the bot, plus the chart candles since the call (when the call is not brand new).
  const t0 = Date.now();
  // the chart history and the picture are prepared at the same time
  const wantHistory = !skipHistory && p?.pairAddress && Date.now() - calledAt > 180_000;
  const [history, art] = await Promise.all([
    wantHistory ? within(fetchPeakSince({ pairAddress: p.pairAddress, mint: call.mint, since: calledAt }), 3_500) : null,
    getArt().then((a) => (CARD_JPG ? shrinkArt(a) : a)).catch(() => null), // instant: your folder or a saved meme, never waits for the internet
  ]);
  const stored = Number(call.peak_price_usd) || null;
  const x = peakMultiple(call.price_usd, stored, now, history);
  if (x === null) return null;
  const peakPrice = call.price_usd * x;
  if (peakPrice > (stored ?? 0) * 1.0001 && x > 1) setCallPeak(call.chat_id, call.mint, peakPrice).catch(() => {});
  const peakMcap = call.mcap_usd ? call.mcap_usd * x : (p?.marketCapUsd && now ? p.marketCapUsd * (peakPrice / now) : null);
  const ageText = formatDuration(Date.now() - calledAt);
  const tHist = Date.now() - t0;
  const t1 = Date.now();
  // Telegram shrinks photos to 1280 px anyway, so a bigger card only makes the upload slower.
  const svg = buildPnlSvg({ symbol: call.symbol, callerName: call.caller_name, entryMcap: call.mcap_usd, peakMcap, x, ageText, groupName, art });
  let out = null, tm = '';
  if (CARD_JPG && await hasSharp()) {
    try {
      const raw = await renderRaw(svg, CARD_W);
      const t2 = Date.now();
      const jpg = await rawToJpeg(raw);
      if (jpg) { out = { buf: jpg, name: 'pnl.jpg' }; tm = `setup ${raw.ms.setup}ms, draw ${raw.ms.draw}ms, encode ${Date.now() - t2}ms`; }
    } catch (e) { console.error('card draw error:', e.message); }
  }
  if (!out) {
    const png = await renderPng(svg, CARD_W, { fast: true });
    out = CARD_JPG ? await cardToJpeg(png) : { buf: png, name: 'pnl.png' };
    tm = `draw ${Date.now() - t1}ms`;
  }
  console.log(`pnl card: prepare ${tHist}ms, ${tm}, ${Math.round(out.buf.length / 1024)} KB ${out.name.split('.')[1]}`);
  return { png: out.buf, name: out.name, x };
}
async function replyPnl(ctx, call) {
  ctx.replyWithChatAction('upload_photo').catch(() => {}); // shows "sending a photo" at once
  const tB = Date.now();
  const prices = await pricesFor([call.mint]);
  const tPrice = Date.now() - tB;
  const r = await pnlPng(call, prices, ctx.chat.title);
  if (!r) return ctx.reply('No price found for that token right now.');
  const tC = Date.now();
  const sent = await ctx.replyWithPhoto(new InputFile(r.png, r.name), { caption: buildPnlCaption({ symbol: call.symbol, callerName: call.caller_name, callerId: call.caller_id, sourceUrl: call.source_url, x: r.x }), parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('🗑', 'x') });
  console.log(`/pnl: price ${tPrice}ms, upload ${Date.now() - tC}ms`);
  return sent;
}
bot.command('pnl', async (ctx) => {
  if (!isGroup(ctx)) return ctx.reply('PnL cards work in groups. Post a token address in your group to make a call, then send /pnl there.');
  const mint = parseMintInput(ctx.match);
  const call = mint ? await getFirstCall(ctx.chat.id, mint) : (await listUserCalls(ctx.chat.id, ctx.from.id, { limit: 1 }))[0];
  if (!call) return ctx.reply(mint ? 'I have no call for that token in this group. I only count tokens posted here after I joined, so post the address once and I will track it from then.' : 'You have no calls in this group yet. Post a token address that nobody has called.');
  return replyPnl(ctx, { ...call, chat_id: call.chat_id ?? ctx.chat.id });
});
bot.command('meme', async (ctx) => {
  const art = await getMeme().catch(() => null); // real memes only, never the pictures in your PnL backgrounds folder
  if (!art) return ctx.reply('No meme right now, try again in a moment.');
  const extra = art.title ? { caption: esc(art.title), parse_mode: 'HTML' } : {};
  return ctx.replyWithPhoto(new InputFile(art.buf, art.mime === 'image/png' ? 'meme.png' : 'meme.jpg'), extra);
});

// ---- Extra commands: group tools, market, converters, small utilities ----
const MINT_RE = '([1-9A-HJ-NP-Za-km-z]{32,44})';
const KB_DEL = new InlineKeyboard().text('🗑', 'x');
const firstMint = (ctx) => parseMintInput((ctx.match ?? '').trim()) ?? extractMint(ctx.message?.reply_to_message?.text ?? ctx.message?.reply_to_message?.caption ?? '');
bot.command('fc', async (ctx) => {
  if (!isGroup(ctx)) return ctx.reply('This works in groups: it shows who called a token first.');
  const mint = firstMint(ctx);
  if (!mint) return ctx.reply('Usage: /fc <token address>, or reply to a message that has one.');
  const c = await getFirstCall(ctx.chat.id, mint);
  if (!c) return ctx.reply('Nobody has called that token in this group yet (I only count tokens posted here after I joined).');
  const [prices, record] = await Promise.all([pricesFor([mint]), callerRecord(ctx.chat.id, c.caller_id).catch(() => null)]);
  const p = prices.get(mint);
  const best = Math.max(0, Number(c.peak_price_usd) || 0, p?.priceUsd || 0);
  const roi = p?.priceUsd && c.price_usd ? p.priceUsd / c.price_usd : null;
  const athX = best && c.price_usd ? Math.max(1, best / c.price_usd) : null;
  if (p?.priceUsd > (Number(c.peak_price_usd) || 0)) setCallPeak(ctx.chat.id, mint, p.priceUsd).catch(() => {});
  const link = c.source_url ?? callMsgLink(ctx.chat.id, c.call_msg_id, ctx.chat.username);
  return ctx.reply(buildFcText({ call: c, nowMcap: p?.marketCapUsd ?? null, roi, athX, record, link }), { ...HTML, link_preview_options: { is_disabled: true }, reply_markup: new InlineKeyboard().text('📸 PnL card', `pnl:${mint}`).text('📊 Card', `t:${mint}`).text('🗑', 'x') });
});
bot.callbackQuery(new RegExp(`^pnl:${MINT_RE}$`), async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  if (!isGroup(ctx)) return;
  const call = await getFirstCall(ctx.chat.id, ctx.match[1]);
  if (!call) return;
  return replyPnl(ctx, { ...call, chat_id: call.chat_id ?? ctx.chat.id });
});
bot.command('last', async (ctx) => {
  if (!isGroup(ctx)) return ctx.reply('This works in groups.');
  const calls = await listChatCalls(ctx.chat.id, { seconds: 20 * 365 * 86400, limit: 10 });
  if (!calls.length) return ctx.reply(buildLastText([]), HTML);
  const board = buildGroupBoard(calls, await pricesFor(calls.map((c) => c.mint)));
  const rows = [...board.rows].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  return ctx.reply(buildLastText(rows), { ...HTML, reply_markup: KB_DEL });
});
bot.command('elb', async (ctx) => {
  if (!isGroup(ctx)) return ctx.reply('This works in groups.');
  const period = parsePeriod(ctx.match) ?? { seconds: 30 * 86400, label: '1 month' };
  const calls = await listChatCalls(ctx.chat.id, { seconds: period.seconds, limit: 1000 });
  if (!calls.length) return ctx.reply('No calls in that time.');
  const prices = await pricesFor(calls.map((c) => c.mint));
  const board = buildGroupBoard(calls, prices);
  const rows = [['token', 'mint', 'caller', 'called_at', 'mcap_at_call', 'peak_mcap', 'multiple'], ...board.top.map((r) => [r.symbol ?? '', r.mint, r.caller_name ?? '', new Date(r.created_at).toISOString(), Math.round(r.mcap_usd ?? 0), Math.round(r.peakMcap ?? 0), r.x.toFixed(2)])];
  const csv = '\ufeff' + rows.map((r) => r.map(csvCell).join(',')).join('\n');
  return ctx.replyWithDocument(new InputFile(Buffer.from(csv, 'utf8'), 'leaderboard.csv'), { caption: `Leaderboard export · ${period.label}` });
});

// Heatmap with buttons: period and number of coins change the same picture.
const HM_PERIODS = [['1H', '1h'], ['24H', '24h'], ['7D', '7d'], ['30D', '30d']];
const HM_COUNTS = [30, 50, 100];
const hmKeyboard = (period, count) => {
  const kb = new InlineKeyboard();
  for (const [label, p] of HM_PERIODS) kb.text(p === period ? `• ${label}` : label, `hm:${p}:${count}`);
  kb.row();
  for (const n of HM_COUNTS) kb.text(n === count ? `• Top ${n}` : `Top ${n}`, `hm:${period}:${n}`);
  return kb.row().text('🗑', 'x');
};
async function heatmapPhoto(period, count) {
  const coins = await fetchTopCoins();
  if (!coins.length) return null;
  const shown = Math.min(count, coins.length);
  const png = await renderPng(buildHeatmapSvg(coins.slice(0, shown), period, `Crypto heatmap · top ${shown}`), 1280, { fast: true });
  const { buf, name } = await cardToJpeg(png, 88);
  return { buf, name, caption: `🗺 <b>Crypto heatmap</b> · top ${shown} by market cap · ${period} change` };
}
bot.command('hm', async (ctx) => {
  const args = (ctx.match ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const period = normPeriod(args.find((a) => /^(1h|24h|1d|7d|1w|14d|30d|1m|1y)$/.test(a)));
  const count = Math.max(10, Math.min(150, Number(args.find((a) => /^\d+$/.test(a))) || 50));
  let r;
  try { r = await withTyping(ctx, () => heatmapPhoto(period, count)); } catch (e) { console.error('heatmap error:', e.message); return ctx.reply('The heatmap data is not reachable right now. Try again in a minute.'); }
  if (!r) return ctx.reply('No market data right now.');
  return ctx.replyWithPhoto(new InputFile(r.buf, r.name), { caption: r.caption, parse_mode: 'HTML', reply_markup: hmKeyboard(period, count) });
});
bot.callbackQuery(/^hm:(1h|24h|7d|30d):(\d{2,3})$/, async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  const period = ctx.match[1], count = Number(ctx.match[2]);
  try {
    const r = await heatmapPhoto(period, count);
    if (!r) return;
    await ctx.editMessageMedia({ type: 'photo', media: new InputFile(r.buf, r.name), caption: r.caption, parse_mode: 'HTML' }, { reply_markup: hmKeyboard(period, count) });
  } catch (e) { if (!/not modified/i.test(e.message)) console.error('heatmap button error:', e.message); }
});
// The group's own call map: /callmap [24h|7d|30d] [ath]. Buttons switch the period and Now / ATH colours.
const CM_PERIODS = [['24H', 86400], ['7D', 7 * 86400], ['30D', 30 * 86400]];
const cmKeyboard = (secs, mode) => {
  const kb = new InlineKeyboard();
  for (const [label, s] of CM_PERIODS) kb.text(s === secs ? `• ${label}` : label, `cm:${s}:${mode}`);
  kb.row().text(mode === 'now' ? '• Now' : 'Now', `cm:${secs}:now`).text(mode === 'ath' ? '• ATH' : 'ATH', `cm:${secs}:ath`);
  return kb.row().text('🗑', 'x');
};
async function callMapPhoto(chat, secs, mode) {
  const label = CM_PERIODS.find(([, s]) => s === secs)?.[0] ?? '7D';
  const calls = await listChatCalls(chat.id, { seconds: secs, limit: 400 });
  if (!calls.length) return { empty: `🗺 <b>Call map</b> · ${label}\n\nNo calls in this group in that time. Post a token address to make one.` };
  const rows = callMapRows(calls, await livePrices(calls.map((c) => c.mint), { fetchPairs: fetchPairsByTokens, quoteUsd, launchMarket: (m) => within(fetchLaunchMarket(m), 4_000, null), maxFallback: 25 }).catch((e) => { console.error('callmap prices:', e.message); return new Map(); }));
  for (const r of rows) if (r.nowX > 1 && r.nowX > r.athX - 1e-9 && r.nowX * r.price_usd > (Number(r.peak_price_usd) || 0) * 1.0001) setCallPeak(chat.id, r.mint, r.nowX * r.price_usd).catch(() => {});
  const png = await renderPng(buildCallMapSvg(rows, { mode, periodLabel: label, groupName: chat.title }), 1280, { fast: true });
  const { buf, name } = await cardToJpeg(png, 88);
  return { buf, name, caption: buildCallMapCaption(rows, { periodLabel: label }) };
}
bot.command(['callmap', 'chm', 'callheat', 'groupmap'], async (ctx) => {
  if (!isGroup(ctx)) return ctx.reply('The call map shows a group\'s own calls: use /callmap in your group.');
  const args = (ctx.match ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const p = args.map((a) => normPeriod(a, null)).find((v) => ['24h', '7d', '30d'].includes(v));
  const secs = p === '24h' ? 86400 : p === '30d' ? 30 * 86400 : 7 * 86400;
  const mode = args.includes('ath') ? 'ath' : 'now';
  let r;
  try { r = await withTyping(ctx, () => callMapPhoto(ctx.chat, secs, mode), 'upload_photo'); } catch (e) { console.error('call map error:', e.message); return ctx.reply('Could not draw the call map right now. Try again in a minute.'); }
  if (r.empty) return ctx.reply(r.empty, { ...HTML, reply_markup: cmKeyboard(secs, mode) });
  return ctx.replyWithPhoto(new InputFile(r.buf, r.name), { caption: r.caption, parse_mode: 'HTML', reply_markup: cmKeyboard(secs, mode) });
});
bot.callbackQuery(/^cm:(\d+):(now|ath)$/, async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  if (!isGroup(ctx)) return;
  const secs = Number(ctx.match[1]), mode = ctx.match[2];
  if (!CM_PERIODS.some(([, s]) => s === secs)) return;
  try {
    const r = await callMapPhoto(ctx.chat, secs, mode);
    if (r.empty) {
      if (ctx.callbackQuery.message?.photo) return ctx.reply(r.empty, { ...HTML, reply_markup: cmKeyboard(secs, mode) });
      return ctx.editMessageText(r.empty, { ...HTML, reply_markup: cmKeyboard(secs, mode) });
    }
    if (!ctx.callbackQuery.message?.photo) return ctx.replyWithPhoto(new InputFile(r.buf, r.name), { caption: r.caption, parse_mode: 'HTML', reply_markup: cmKeyboard(secs, mode) });
    await ctx.editMessageMedia({ type: 'photo', media: new InputFile(r.buf, r.name), caption: r.caption, parse_mode: 'HTML' }, { reply_markup: cmKeyboard(secs, mode) });
  } catch (e) { if (!/not modified/i.test(e.message)) console.error('call map button error:', e.message); }
});
// Candlestick chart in market cap (like Rick and Phanes): /chart <address> [1m 5m 15m 1h 4h 1d]. Falls back to the old line chart.
const TF_ROW = ['1m', '5m', '15m', '1h', '4h', '1d'];
const CANDLES_SHOWN = 120;
const chartKeyboard = (mint, tf) => {
  const kb = new InlineKeyboard();
  TF_ROW.forEach((t) => kb.text(t === tf ? `• ${t}` : t, `ch:${t}:${mint}`));
  return kb.row().url('DexScreener', `https://dexscreener.com/solana/${mint}`).url('Birdeye', `https://birdeye.so/token/${mint}?chain=solana`)
    .row().url('GMGN', `https://gmgn.ai/sol/token/${mint}`).url('Solscan', `https://solscan.io/token/${mint}`).row().text('🗑', 'x');
};
async function chartPhoto(mint, tf, chat) {
  const m = await getMarket(mint);
  if (!m?.pairAddress) return null;
  const use = tf ?? defaultTf(typeof m.createdAt === 'number' ? Date.now() - m.createdAt : null);
  const [frame, aggregate] = TFS[use];
  const [candles, first] = await Promise.all([
    fetchCandles({ pairAddress: m.pairAddress, mint, frame, aggregate, limit: CANDLES_SHOWN }),
    chat && (chat.type === 'group' || chat.type === 'supergroup') ? getFirstCall(chat.id, mint).catch(() => null) : null,
  ]);
  if (!candles) return null;
  const scale = m.marketCapUsd > 0 && m.priceUsd > 0 ? m.marketCapUsd / m.priceUsd : null;
  const call = first ? { at: new Date(first.created_at).getTime(), name: String(first.caller_name ?? '').replace(/^@/, '') } : null;
  const svg = buildCandleSvg({ candles, scale, symbol: m.symbol ?? '', tf: use, call, started: candles.length < CANDLES_SHOWN });
  const png = await renderPng(svg, 1280, { fast: true });
  const { buf, name } = await cardToJpeg(png, 93);
  const k = scale ?? 1;
  const ath = Math.max(...candles.map((c) => c.h)) * k;
  const label = m.symbol ? '$' + esc(m.symbol) : short(mint);
  const caption = `📈 <b>${label}</b> · ${use}${scale ? ` · MC ${formatUsd(m.marketCapUsd)} · ATH ${formatUsd(ath)}` : ''}${first ? `\n🥇 First call: ${esc(String(first.caller_name ?? 'someone'))}${first.mcap_usd ? ` @ ${formatUsd(first.mcap_usd)}` : ''}` : ''}`;
  return { buf, name, caption, tf: use };
}
bot.command(['chart', 'c'], async (ctx) => {
  const args = (ctx.match ?? '').trim().split(/\s+/).filter(Boolean);
  const tf = parseTf(args);
  const rest = args.filter((a) => !(a.toLowerCase() in TFS)).join(' ');
  const mint = parseMintInput(rest) ?? extractMint(ctx.message?.reply_to_message?.text ?? ctx.message?.reply_to_message?.caption ?? '');
  if (!mint) return ctx.reply('Usage: /chart <token address> [1m 5m 15m 1h 4h 1d]\nOr reply to a message that has the address.');
  let r = null;
  try { r = await withTyping(ctx, () => chartPhoto(mint, tf, ctx.chat), 'upload_photo'); } catch (e) { console.error('chart error:', e.message); }
  if (!r) return sendChart(ctx, mint);
  return ctx.replyWithPhoto(new InputFile(r.buf, r.name), { caption: r.caption, parse_mode: 'HTML', reply_markup: chartKeyboard(mint, r.tf) });
});
bot.callbackQuery(/^ch:(1m|5m|15m|1h|4h|1d):([1-9A-HJ-NP-Za-km-z]{32,44})$/, async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  try {
    const r = await chartPhoto(ctx.match[2], ctx.match[1], ctx.chat);
    if (!r) return;
    await ctx.editMessageMedia({ type: 'photo', media: new InputFile(r.buf, r.name), caption: r.caption, parse_mode: 'HTML' }, { reply_markup: chartKeyboard(ctx.match[2], r.tf) });
  } catch (e) { if (!/not modified/i.test(e.message)) console.error('chart button error:', e.message); }
});
const movers = (dir) => async (ctx) => {
  const args = (ctx.match ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const period = normPeriod(args.find((a) => /^(1h|24h|1d|7d|1w|14d|30d|1m|1y)$/.test(a)));
  let coins;
  try { coins = await withTyping(ctx, () => fetchTopCoins()); } catch (e) { console.error('movers error:', e.message); return ctx.reply('Market data is not reachable right now. Try again in a minute.'); }
  return ctx.reply(buildMoversText(coins, period, dir), { ...HTML, reply_markup: KB_DEL });
};
bot.command('best', movers('best'));
bot.command('worst', movers('worst'));
bot.command('poly', async (ctx) => {
  const term = (ctx.match ?? '').trim();
  let list;
  try { list = await withTyping(ctx, () => fetchPolymarket(term)); } catch (e) { console.error('polymarket error:', e.message); return ctx.reply('Polymarket is not reachable right now. Try again in a minute.'); }
  return ctx.reply(buildPolymarketText(list, term), { ...HTML, reply_markup: KB_DEL });
});
// ---- /tt top traders, /tw top wallets (from recent trades), /ws wallet stats, /rekt liquidations ----
const liqFeed = createLiquidationFeed();
async function recentTrades(ctx, mint) {
  const m = await getMarket(mint);
  if (!m?.pairAddress) { await ctx.reply('No trading pool found for that token yet.'); return null; }
  try { return { m, trades: await fetchTrades(m.pairAddress, mint) }; }
  catch (e) { console.error('trades error:', e.message); await ctx.reply('Recent trades are not available right now. Try again in a minute.'); return null; }
}
bot.command('tt', withMint('/tt', async (ctx, mint) => {
  const r = await withTyping(ctx, () => recentTrades(ctx, mint));
  if (!r) return;
  return ctx.reply(buildTopTradersText({ market: r.m, trades: r.trades, rows: aggregateTraders(r.trades) }), { ...HTML, reply_markup: KB_DEL });
}));
bot.command('tw', withMint('/tw', async (ctx, mint) => {
  const r = await withTyping(ctx, () => recentTrades(ctx, mint));
  if (!r) return;
  return ctx.reply(buildTopWalletsText({ market: r.m, trades: r.trades, profits: estimateProfits(aggregateTraders(r.trades), r.m.priceUsd) }), { ...HTML, reply_markup: KB_DEL });
}));
bot.command('ws', async (ctx) => {
  const addr = parseMintInput((ctx.match ?? '').trim().split(/\s+/)[0]) ?? extractMint(ctx.message?.reply_to_message?.text ?? '');
  if (!addr || !isAddr(addr)) return ctx.reply('Usage: /ws <wallet address>\nOr reply to a message that has the address.');
  const text = await withTyping(ctx, async () => {
    const [sol, tokenMap, funding, solMarket] = await Promise.all([
      getSolBalance(addr).catch(() => null),
      getHolderTokens([addr]).catch(() => new Map()),
      getWalletFunding(addr).catch(() => null),
      fetchPairsByTokens(['So11111111111111111111111111111111111111112']).catch(() => new Map()),
    ]);
    const list = tokenMap.get(addr);
    let holdings = null;
    if (list) {
      let prices = new Map();
      const mints = list.map((t) => t.mint).slice(0, 120);
      if (mints.length) { try { prices = await fetchPairsByTokens(mints); } catch (e) { console.error('wallet prices error:', e.message); } }
      holdings = valueHoldings(list, prices, null);
    }
    return buildWalletText({ address: addr, sol, solUsd: solMarket.get('So11111111111111111111111111111111111111112')?.priceUsd ?? null, holdings, funding });
  });
  return ctx.reply(text, { ...HTML, reply_markup: KB_DEL });
});
bot.command('rekt', (ctx) => {
  const key = parseRektWindow(ctx.match);
  return ctx.reply(buildRektText({ summary: liqFeed.summary(key), windowLabel: key, coveredMs: liqFeed.coveredMs() }), { ...HTML, reply_markup: KB_DEL });
});
bot.command('v', async (ctx) => {
  const [a, ...rest] = (ctx.match ?? '').trim().split(/\s+/);
  const amt = parseAmount(a);
  const q = rest.join(' ').trim();
  if (!amt || !q) return ctx.reply('Usage: <code>/v 1m bonk</code>  or  <code>/v 2% &lt;address&gt;</code>', HTML);
  let mint = parseMintInput(q);
  if (!mint) {
    try { mint = (await withTyping(ctx, () => searchTokens(q)))[0]?.mint ?? null; } catch { mint = null; }
    if (!mint) return ctx.reply('I could not find that token.');
  }
  const m = await getMarket(mint);
  if (!m?.priceUsd) return ctx.reply(NO_MARKET);
  const tk = m.symbol ? `$${m.symbol}` : short(mint);
  if (amt.kind === 'amount') return ctx.reply(buildConvertText({ label: `${formatCount(amt.n)} ${tk}`, value: formatUsd(amt.n * m.priceUsd), price: formatPriceCard(m.priceUsd), mcap: formatUsd(m.marketCapUsd) }), { ...HTML, reply_markup: KB_DEL });
  if (!m.marketCapUsd) return ctx.reply('No market cap for that token, so I cannot work out a share of the supply.');
  return ctx.reply(buildConvertText({ label: `${amt.n}% of ${tk}`, value: formatUsd(m.marketCapUsd * amt.n / 100), tokens: formatCount((m.marketCapUsd / m.priceUsd) * (amt.n / 100)), price: formatPriceCard(m.priceUsd), mcap: formatUsd(m.marketCapUsd) }), { ...HTML, reply_markup: KB_DEL });
});
async function replyId(ctx, title, id) {
  const sent = await ctx.reply(buildIdText(title, id), { ...HTML, reply_markup: KB_DEL });
  setTimeout(() => ctx.api.deleteMessage(sent.chat.id, sent.message_id).catch(() => {}), 60_000).unref?.();
}
bot.command('userid', (ctx) => replyId(ctx, 'Your ID', ctx.from.id));
bot.command('chatid', (ctx) => replyId(ctx, 'Chat ID', ctx.chat.id));
bot.command('flip', (ctx) => ctx.reply(Math.random() < 0.5 ? '🪙 <b>Heads</b>' : '🪙 <b>Tails</b>', HTML));
bot.command('epoch', (ctx) => {
  const d = parseEpoch(ctx.match);
  if (!d) return ctx.reply('Usage: <code>/epoch 1700000000</code>', HTML);
  return ctx.reply(buildEpochText(d), { ...HTML, reply_markup: KB_DEL });
});

// ---- Price targets (3x, 4x, -50%...) ----
const targetValue = (base, mult, mcap) => (mcap ? formatUsd(mcap * mult) : formatPriceCard(base * mult));
bot.command(['target', 'alertx'], async (ctx) => {
  const args = (ctx.match ?? '').trim().split(/\s+/).filter(Boolean);
  const first = args[0] ? parseMintInput(args[0]) : null;
  const mint = first ?? extractMint(ctx.message?.reply_to_message?.text ?? ctx.message?.reply_to_message?.caption ?? '');
  const rest = first ? args.slice(1) : args;
  if (!mint) return ctx.reply('Usage: <code>/target &lt;address&gt; 3x 4x 10x</code>\nPercents work too: <code>+50% -30%</code>. No multiples = 2x 3x 5x. You can also reply to a message that has the address.', HTML);
  const mults = rest.length ? parseTargets(rest.join(' ')) : [2, 3, 5];
  if (!mults) return ctx.reply('I did not understand those targets. Examples: 3x  4.5x  +50%  -30%');
  const m = await withTyping(ctx, () => getMarket(mint));
  if (!m?.priceUsd) return ctx.reply(NO_MARKET);
  const added = await addTargets({ telegramId: ctx.from.id, mint, symbol: m.symbol, basePrice: m.priceUsd, mults });
  return ctx.reply(buildTargetSetText({
    symbol: m.symbol ? `$${m.symbol}` : short(mint), nowLabel: m.marketCapUsd ? formatUsd(m.marketCapUsd) : formatPriceCard(m.priceUsd),
    targets: mults.map((x) => ({ label: targetLabel(x), value: targetValue(m.priceUsd, x, m.marketCapUsd) })), inGroup: isGroup(ctx), botUser: ctx.me?.username, refreshed: !added,
  }), { ...HTML, reply_markup: new InlineKeyboard().text('📋 My alerts', 'tg:list').text('🗑', 'x') });
});
const targetsPayload = async (telegramId) => {
  const rows = await listTargets(telegramId);
  const by = new Map();
  for (const r of rows) { const e = by.get(r.mint) ?? { r, list: [] }; e.list.push(r); by.set(r.mint, e); }
  const groups = [...by.values()].map(({ r, list }) => ({ symbol: r.symbol ? `$${r.symbol}` : short(r.mint), from: formatPriceCard(r.base_price_usd), targets: list.map((t) => ({ label: targetLabel(t.mult), value: formatPriceCard(t.base_price_usd * t.mult) })) }));
  return { text: buildTargetsText(groups), has: rows.length > 0 };
};
bot.command('targets', async (ctx) => {
  const { text, has } = await targetsPayload(ctx.from.id);
  return ctx.reply(text, { ...HTML, reply_markup: has ? new InlineKeyboard().text('Clear all', 'tg:clear').text('🗑', 'x') : KB_DEL });
});
bot.callbackQuery('tg:list', async (ctx) => { await ctx.answerCallbackQuery().catch(() => {}); const { text } = await targetsPayload(ctx.from.id); return ctx.reply(text, { ...HTML, reply_markup: KB_DEL }); });
bot.callbackQuery('tg:clear', async (ctx) => {
  await ctx.answerCallbackQuery({ text: `Removed ${await removeTargets(ctx.from.id)} alert(s)` }).catch(() => {});
  return ctx.editMessageText(buildTargetsText([]), { ...HTML, reply_markup: KB_DEL }).catch(() => {});
});
bot.command('untarget', async (ctx) => {
  const a = (ctx.match ?? '').trim();
  if (a.toLowerCase() === 'all') return ctx.reply(`Removed ${await removeTargets(ctx.from.id)} alert(s).`);
  const mint = parseMintInput(a) ?? extractMint(ctx.message?.reply_to_message?.text ?? '');
  if (!mint) return ctx.reply('Usage: <code>/untarget &lt;address&gt;</code>  or  <code>/untarget all</code>', HTML);
  return ctx.reply(`Removed ${await removeTargets(ctx.from.id, mint)} alert(s).`);
});
let checkingTargets = false;
async function checkTargets() {
  if (checkingTargets) return;
  checkingTargets = true;
  try {
    const rows = await listActiveTargets();
    if (!rows.length) return;
    const prices = await fetchPairsByTokens([...new Set(rows.map((r) => r.mint))]);
    for (const r of rows) {
      const p = prices.get(r.mint);
      if (!p?.priceUsd || !targetHit(r.base_price_usd, p.priceUsd, r.mult)) continue;
      const x = p.priceUsd / r.base_price_usd;
      try {
        await bot.api.sendMessage(r.telegram_id, buildTargetHitText({ symbol: r.symbol ? `$${r.symbol}` : short(r.mint), label: targetLabel(r.mult), nowLabel: p.marketCapUsd ? formatUsd(p.marketCapUsd) : formatPriceCard(p.priceUsd), since: x >= 1 ? fmtX(x) : shortPct((x - 1) * 100) }), {
          ...HTML, reply_markup: new InlineKeyboard().text('Open card', `t:${r.mint}`).url('⚡ Buy on Omni Trade', tradeLink(r.mint)),
        });
        await markTargetFired(r.id);
      } catch (e) {
        if (e.error_code === 403) { await removeTargets(r.telegram_id); } else console.error('target send error:', e.message);
      }
      await new Promise((res) => setTimeout(res, 50));
    }
  } catch (e) { console.error('target check error:', e.message); } finally { checkingTargets = false; }
}

// ---- Reminders (in groups the reminder is pinned, like Rick) ----
const fmtWhen = (d) => `${new Date(d).toISOString().replace('T', ' ').slice(0, 16)} UTC`;
async function makeReminder(ctx, { here }) {
  const arg = (ctx.match ?? '').trim();
  const d = parseDelay(arg);
  if (!d) return ctx.reply(`Usage: <code>${here ? '/remind' : '/remindme'} 30m check the chart</code>\nTimes: <code>10m</code>  <code>2h30m</code>  <code>1d</code>  <code>in 2 hours</code>`, HTML);
  const reply = ctx.message?.reply_to_message;
  const body = (d.rest || reply?.text || reply?.caption || 'Reminder').slice(0, 300);
  const id = await addReminder({ telegramId: ctx.from.id, chatId: here ? ctx.chat.id : ctx.from.id, fireAt: new Date(Date.now() + d.ms), body, who: callerName(ctx.from) });
  if (id === null) return ctx.reply('You have too many active reminders (25). Remove one with /listreminders.');
  return ctx.reply(buildReminderSetText({ id, delay: formatDuration(d.ms), at: fmtWhen(Date.now() + d.ms), body, here }), { ...HTML, reply_markup: new InlineKeyboard().text('Cancel', `rm:${id}`).text('🗑', 'x') });
}
bot.command('remindme', (ctx) => makeReminder(ctx, { here: false }));
bot.command('remind', (ctx) => makeReminder(ctx, { here: true }));
bot.command('listreminders', async (ctx) => {
  const rows = await listReminders(ctx.from.id);
  const kb = new InlineKeyboard();
  rows.slice(0, 8).forEach((r, i) => { kb.text(`Cancel ${r.id}`, `rm:${r.id}`); if (i % 3 === 2) kb.row(); });
  return ctx.reply(buildRemindersText(rows, fmtWhen), { ...HTML, reply_markup: rows.length ? kb.row().text('🗑', 'x') : KB_DEL });
});
bot.callbackQuery(/^rm:(\d+)$/, async (ctx) => {
  const ok = await removeReminder(Number(ctx.match[1]), ctx.from.id);
  await ctx.answerCallbackQuery({ text: ok ? 'Reminder cancelled' : 'Already gone' }).catch(() => {});
  if (ok) await ctx.editMessageText('⏰ Reminder cancelled.', HTML).catch(() => {});
});
bot.command('nevermind', async (ctx) => {
  const id = Number((ctx.match ?? '').trim());
  if (!Number.isInteger(id) || id <= 0) return ctx.reply('Usage: <code>/nevermind &lt;reminder id&gt;</code>  (see /listreminders)', HTML);
  return ctx.reply((await removeReminder(id, ctx.from.id)) ? 'Reminder cancelled.' : 'I could not find that reminder.');
});
let checkingReminders = false;
async function checkReminders() {
  if (checkingReminders) return;
  checkingReminders = true;
  try {
    for (const r of await dueReminders()) {
      try {
        const group = Number(r.chat_id) !== Number(r.telegram_id);
        const sent = await bot.api.sendMessage(r.chat_id, buildReminderFiredText({ body: r.body, who: r.who, group }), HTML);
        if (group) await bot.api.pinChatMessage(r.chat_id, sent.message_id).catch(() => {}); // needs the admin right to pin; skipped quietly without it
      } catch (e) { console.error('reminder send error:', e.message); }
      await markReminderDone(r.id).catch(() => {});
    }
  } catch (e) { console.error('reminder check error:', e.message); } finally { checkingReminders = false; }
}

// ---- Your own PnL pictures: an admin replies to a photo with /pnlbg and it joins the folder ----
bot.command('pnlbg', async (ctx) => {
  const admins = (process.env.ADMIN_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!admins.includes(String(ctx.from.id))) return ctx.reply('Only the bot owner can add PnL pictures.');
  const photo = ctx.message?.reply_to_message?.photo?.at(-1) ?? ctx.message?.reply_to_message?.document;
  if (!photo) return ctx.reply('Reply to a photo (send it as a photo or a file) with /pnlbg and I will add it to the PnL pictures.');
  try {
    const file = await ctx.api.getFile(photo.file_id);
    const res = await fetch(`https://api.telegram.org/file/bot${process.env.SCAN_BOT_TOKEN ?? bot.token}/${file.file_path}`, { signal: AbortSignal.timeout(20_000) });
    const buf = Buffer.from(await res.arrayBuffer());
    if (!sniffMime(buf)) return ctx.reply('That file is not a jpg, png or webp picture.');
    await mkdir(OWN_DIR, { recursive: true });
    await writeFile(join(OWN_DIR, `tg-${Date.now()}.${sniffMime(buf) === 'image/png' ? 'png' : sniffMime(buf) === 'image/webp' ? 'webp' : 'jpg'}`), buf);
    return ctx.reply(`✅ Added. Your folder now has ${(await readdir(OWN_DIR)).filter((f) => /\.(jpe?g|png|webp)$/i.test(f)).length} pictures.`);
  } catch (e) { console.error('pnlbg error:', e.message); return ctx.reply('I could not save that picture.'); }
});

// ---- /ta technical read ----
bot.command('ta', withMint('/ta', async (ctx, mint) => {
  const m = await withTyping(ctx, () => getMarket(mint));
  if (!m?.pairAddress) return ctx.reply('I could not find a trading pair for that token.');
  const rows = await withTyping(ctx, () => Promise.all(TA_FRAMES.map(async ([tf, frame, aggregate]) => ({ tf, a: analyzeCloses((await fetchCloses({ pairAddress: m.pairAddress, mint, frame, aggregate })) ?? []) }))));
  return ctx.reply(buildTaText(m.symbol, rows), { ...HTML, reply_markup: chartButtons(mint) });
}));

// ---- AI helpers: /tr /tldr /eli5 (Gemini). A few per hour for each person, to protect the free quota. ----
const aiUse = new Map();
function aiAllowed(id) {
  const now = Date.now();
  const list = (aiUse.get(id) ?? []).filter((t) => now - t < 3_600_000);
  if (list.length >= 12) return false;
  list.push(now); aiUse.set(id, list);
  return true;
}
const AI_SYS = 'You are a concise assistant inside a Telegram crypto bot. Plain text only, no markdown symbols, no lists unless asked. Keep it short.';
async function runAi(ctx, { system, prompt }) {
  if (!process.env.GEMINI_API_KEY) return ctx.reply('The AI tools need a Gemini key in the bot settings.');
  if (!aiAllowed(ctx.from.id)) return ctx.reply('You used the AI tools a lot this hour. Try again a bit later.');
  const out = await withTyping(ctx, () => generateText({ system, prompt, apiKey: process.env.GEMINI_API_KEY, models: process.env.GEMINI_MODEL ? [process.env.GEMINI_MODEL] : null }));
  if (!out) return ctx.reply('The AI did not answer. Try again in a moment.');
  return ctx.reply(esc(out.replace(/[*_`#]/g, '')).slice(0, 3800), HTML);
}
const quoted = (ctx) => ctx.message?.reply_to_message?.text ?? ctx.message?.reply_to_message?.caption ?? '';
bot.command('tr', async (ctx) => {
  const { text: argText, lang, bad } = parseTranslate(ctx.match);
  if (bad) return ctx.reply(`I do not know the language code "${esc(bad)}". Examples: -fr -es -de -pt -yo -ha -ig`, HTML);
  const text = argText || quoted(ctx);
  if (!text) return ctx.reply('Usage: /tr <text> [-fr]  or reply to a message with /tr');
  return runAi(ctx, { system: AI_SYS, prompt: `Translate to ${lang}. Reply with the translation only.\n\n${text.slice(0, 3000)}` });
});
bot.command('eli5', async (ctx) => {
  const text = (ctx.match ?? '').trim() || quoted(ctx);
  if (!text) return ctx.reply('Usage: /eli5 <topic or text>  or reply to a message with /eli5');
  return runAi(ctx, { system: AI_SYS, prompt: `Explain like I am 5, in 3 or 4 short sentences:\n\n${text.slice(0, 3000)}` });
});
bot.command(['tldr', 'sum'], async (ctx) => {
  let text = (ctx.match ?? '').trim() || quoted(ctx);
  const url = /https?:\/\/\S+/.exec(text)?.[0];
  if (!text) return ctx.reply('Usage: /tldr <text or link>  or reply to a message with /tldr');
  if (url) {
    if (!isPublicUrl(url)) return ctx.reply('I can only read public web pages.');
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8_000), headers: { 'user-agent': 'Mozilla/5.0 OmniScan' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      text = stripHtml((await res.text()).slice(0, 400_000)).slice(0, 12_000);
      if (text.length < 200) return ctx.reply('I could not read text from that page.');
    } catch (e) { return ctx.reply('I could not open that link.'); }
  }
  return runAi(ctx, { system: AI_SYS, prompt: `Summarize in 3 to 5 short bullet-style sentences (use plain lines starting with a dash):\n\n${text.slice(0, 12_000)}` });
});
// ---- Paper trading (personal, DM-only): a virtual balance and one rule-based strategy per user ----
const paperEdit = new Map(); // telegram_id -> field name awaiting a typed value
const STRATEGY_PROMPT = {
  min_mcap_usd: 'Minimum market cap in $ to paper-buy (e.g. 10000), or "any" for no minimum.',
  max_mcap_usd: 'Maximum market cap in $ to paper-buy (e.g. 100000), or "any" for no maximum.',
  alloc_pct: 'Size per trade, as % of your paper balance (e.g. 5).',
  tp_pct: 'Take-profit, as % gain (e.g. 100 closes a trade at +100%, a 2x).',
  sl_pct: 'Stop-loss, as % loss (e.g. 40 closes a trade at -40%).',
  max_open: 'Max number of paper positions open at once (e.g. 3).',
  max_position_usd: 'Hard cap per trade in $, on top of Size % (e.g. 50), or "any" for no extra cap.',
  daily_loss_limit_pct: 'Stop opening new trades for the rest of the day once realized losses hit this % of your equity (e.g. 20), or "any" for no daily stop.',
  agent_prompt: 'Type the instructions you want the AI agent to follow (e.g. "Only tokens under 20k mcap from these accounts, use your judgment on momentum"), or "clear" to remove them.',
  source_filter: 'Only paper-buy calls from these sources: a comma-separated list of group chat IDs and/or X handles (e.g. "-100123456,elonmusk"), or "clear" for any source.',
  alloc_usd: 'Fixed $ amount per trade (used instead of Size %), e.g. 25. Type "clear" to go back to % sizing.',
  partial_tp_pct: 'Take a partial profit once a trade is up this % (e.g. 50), or "clear" to turn off partial take-profit.',
  partial_tp_close_pct: 'What % of the position to close at that partial take-profit tier (e.g. 50 for half), or "clear".',
};
// Phase 3: Agent Mode. Rules = the original v1 behavior. Agent = the AI decides every buy/skip, market-cap
// range ignored. Hybrid = market-cap range is a hard filter, the AI decides among what passes it.
const MODE_NEXT = { rules: 'hybrid', hybrid: 'agent', agent: 'rules' };
const MODE_BTN_LABEL = { rules: '📏 Mode: Rules', hybrid: '🤝 Mode: Hybrid', agent: '🤖 Mode: Agent' };
const SIZE_MODE_NEXT = { pct: 'fixed', fixed: 'pct' };
const strategyKb = (s) => {
  const mode = s.mode ?? 'rules';
  const sizeMode = s.size_mode ?? 'pct';
  const kb = new InlineKeyboard()
    .text(s.enabled ? '⚪ Turn off' : '🟢 Turn on', 'pe:tog').text(MODE_BTN_LABEL[mode] ?? mode, 'pe:mode').row()
    .text('Min MC', 'pe:min_mcap_usd').text('Max MC', 'pe:max_mcap_usd').row()
    .text(sizeMode === 'fixed' ? '💲 Fixed $' : 'Size %', sizeMode === 'fixed' ? 'pe:alloc_usd' : 'pe:alloc_pct')
    .text(sizeMode === 'fixed' ? '% Switch to %' : '💲 Switch to $', 'pe:sizemode')
    .text('Take-profit %', 'pe:tp_pct').row()
    .text('Stop-loss %', 'pe:sl_pct').text('Max open', 'pe:max_open').text('Max $/trade', 'pe:max_position_usd').row()
    .text('Daily stop %', 'pe:daily_loss_limit_pct').text('Sources', 'pe:source_filter').row()
    .text('Partial TP %', 'pe:partial_tp_pct').text('Partial close %', 'pe:partial_tp_close_pct').row();
  if (mode !== 'rules') kb.text('🤖 Edit instructions', 'pe:agent_prompt').row();
  return kb.text('🗑 Close', 'x');
};

async function showStrategy(ctx) {
  await ensurePaperAccount(ctx.from.id);
  const s = await getStrategy(ctx.from.id);
  return ctx.reply(buildStrategyText(s), { ...HTML, reply_markup: strategyKb(s) });
}

// Only well-formed numbers in sane ranges make it through — a bad or missing field is left untouched
// rather than guessed, same as every other write in this bot.
function cleanStrategyPatch(body) {
  const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : v === null ? null : undefined);
  const clamp = (v, lo, hi) => (v == null ? v : Math.max(lo, Math.min(hi, v)));
  const out = {};
  if (typeof body?.enabled === 'boolean') out.enabled = body.enabled;
  if (n(body?.minMcapUsd) !== undefined) out.min_mcap_usd = clamp(n(body.minMcapUsd), 0, 1e12);
  if (n(body?.maxMcapUsd) !== undefined) out.max_mcap_usd = clamp(n(body.maxMcapUsd), 0, 1e12);
  if (n(body?.allocPct) !== undefined && n(body.allocPct) != null) out.alloc_pct = clamp(n(body.allocPct), 1, 100);
  if (n(body?.tpPct) !== undefined) out.tp_pct = n(body.tpPct) == null ? 100 : clamp(n(body.tpPct), 1, 100_000);
  if (n(body?.slPct) !== undefined) out.sl_pct = n(body.slPct) == null ? 40 : clamp(n(body.slPct), 1, 100);
  if (n(body?.maxOpen) !== undefined && n(body.maxOpen) != null) out.max_open = Math.max(1, Math.min(50, Math.round(n(body.maxOpen))));
  if (out.min_mcap_usd != null && out.max_mcap_usd != null && out.min_mcap_usd >= out.max_mcap_usd) delete out.max_mcap_usd;
  // Phase 3: Agent Mode fields.
  if (typeof body?.mode === 'string' && ['rules', 'agent', 'hybrid'].includes(body.mode)) out.mode = body.mode;
  if (typeof body?.agentPrompt === 'string' || body?.agentPrompt === null) out.agent_prompt = body.agentPrompt ? String(body.agentPrompt).slice(0, 2000) : null;
  if (n(body?.maxPositionUsd) !== undefined) out.max_position_usd = clamp(n(body.maxPositionUsd), 0, 1e9);
  if (n(body?.dailyLossLimitPct) !== undefined) out.daily_loss_limit_pct = clamp(n(body.dailyLossLimitPct), 1, 100);
  // Post-plan polish: source filter, fixed-$ sizing, a single partial take-profit tier.
  if (typeof body?.sourceFilter === 'string' || body?.sourceFilter === null) out.source_filter = body.sourceFilter ? String(body.sourceFilter).slice(0, 500) : null;
  if (typeof body?.sizeMode === 'string' && ['pct', 'fixed'].includes(body.sizeMode)) out.size_mode = body.sizeMode;
  if (n(body?.allocUsd) !== undefined) out.alloc_usd = clamp(n(body.allocUsd), 0, 1e9);
  if (n(body?.partialTpPct) !== undefined) out.partial_tp_pct = clamp(n(body.partialTpPct), 1, 100_000);
  if (n(body?.partialTpClosePct) !== undefined) out.partial_tp_close_pct = clamp(n(body.partialTpClosePct), 1, 100);
  return out;
}

// Builds a share-ready PNG recap of one paper trade (open or closed) and sends it. Used by the share buttons
// (via buildAndSharePaperCard below), the Mini App's Paper tab, and — threaded under the original open notice —
// automatically when a position closes (Phase 4). replyToMessageId threads the photo under that message.
async function sendPaperPnlCard(telegramId, p, { replyToMessageId = null } = {}) {
  try {
    if (!p) return { ok: false, error: 'not found' };
    const entryMcap = Number(p.entry_mcap_usd) || null;
    const entryPrice = Number(p.entry_price_usd);
    let nowMcap, pct, status, ageText;
    if (p.status === 'open') {
      const price = (await callPrices([p.mint])).get(p.mint)?.priceUsd ?? null;
      pct = pnlPct(entryPrice, price);
      nowMcap = price != null && entryMcap != null ? entryMcap * (price / entryPrice) : null;
      status = 'open';
      ageText = `${formatDuration(Date.now() - new Date(p.opened_at).getTime())} open`;
    } else {
      pct = Number(p.pnl_pct);
      nowMcap = p.exit_mcap_usd != null ? Number(p.exit_mcap_usd) : (entryMcap != null && p.exit_price_usd ? entryMcap * (Number(p.exit_price_usd) / entryPrice) : null);
      status = p.close_reason;
      ageText = `closed ${formatDuration(Date.now() - new Date(p.closed_at ?? Date.now()).getTime())} ago`;
    }
    if (pct == null || !Number.isFinite(pct)) return { ok: false, error: 'no price available for this trade right now' };
    const svg = buildPaperPnlSvg({ symbol: p.symbol, entryMcap, nowMcap, pct, status, ageText, sizeUsd: Number(p.size_usd), source: p.signal_source ?? null });
    const png = await renderPng(svg, CARD_W, { fast: true });
    const opts = { caption: buildPaperPnlCaption({ symbol: p.symbol, status, pct, source: p.signal_source ?? null }), parse_mode: 'HTML' };
    if (replyToMessageId) opts.reply_parameters = { message_id: replyToMessageId };
    await bot.api.sendPhoto(telegramId, new InputFile(png, 'paper-pnl.png'), opts);
    return { ok: true };
  } catch (e) {
    console.error('paper card error:', e.message);
    return { ok: false, error: 'could not build that card right now' };
  }
}

async function buildAndSharePaperCard(telegramId, id) {
  const p = await getPaperPosition(telegramId, id).catch(() => null);
  if (!p) return { ok: false, error: 'not found' };
  return sendPaperPnlCard(telegramId, p);
}

// Phase 4: when a position closes, its exit card lands as a reply in the same thread as the original call/open
// notice — one tap from your entry message to the result. Falls back to the plain close notice when there is
// no thread to reply to, or the card itself fails.
async function notifyPaperClose(telegramId, closedRow) {
  const replyTo = closedRow.open_msg_id ? Number(closedRow.open_msg_id) : null;
  if (replyTo) {
    const r = await sendPaperPnlCard(telegramId, closedRow, { replyToMessageId: replyTo });
    if (r.ok) return;
  }
  const opts = replyTo ? { ...HTML, reply_parameters: { message_id: replyTo } } : HTML;
  bot.api.sendMessage(telegramId, buildCloseNotice({ symbol: closedRow.symbol, mint: closedRow.mint, reason: closedRow.close_reason, pnlUsd: Number(closedRow.pnl_usd), pnlPct: Number(closedRow.pnl_pct) }), opts).catch(() => {});
}

// Up to 8 Share buttons, two per row, plus Close — one per closed trade shown in the history text.
const historyKeyboard = (rows) => {
  const kb = new InlineKeyboard();
  rows.slice(0, 8).forEach((r, i) => {
    kb.text(`📤 ${r.symbol ? '$' + r.symbol.slice(0, 10) : 'Share'}`, `pc:${r.id}`);
    if (i % 2 === 1) kb.row();
  });
  return kb.row().text('🗑', 'x');
};

bot.command('paper', async (ctx) => {
  if (isGroup(ctx)) return ctx.reply('Paper trading is personal — DM the bot instead.');
  if (!paperAccessAllowed(ctx.from.id)) return ctx.reply(PAPER_RESTRICTED_MSG);
  await ensurePaperAccount(ctx.from.id);
  const [account, strategy, open, equityHistory] = await Promise.all([
    getPaperAccount(ctx.from.id), getStrategy(ctx.from.id), listOpenPositions(ctx.from.id), listEquitySnapshots(ctx.from.id, { limit: 30 }),
  ]);
  const investedUsd = open.reduce((a, p) => a + Number(p.size_usd), 0);
  return ctx.reply(buildAccountText({ account, strategy, openCount: open.length, investedUsd, equityHistory: equityHistory.map((e) => Number(e.equity_usd)) }), {
    ...HTML, reply_markup: new InlineKeyboard().text('⚙️ Strategy', 'pe:show').text('📈 Positions', 'pe:pos').row().text('📜 History', 'pe:hist'),
  });
});
bot.command('strategy', async (ctx) => {
  if (isGroup(ctx)) return ctx.reply('Paper trading is personal — DM the bot instead.');
  if (!paperAccessAllowed(ctx.from.id)) return ctx.reply(PAPER_RESTRICTED_MSG);
  return showStrategy(ctx);
});
// Better position view: one card per open position, with Refresh / Share PnL / partial-close buttons.
bot.command('pos', async (ctx) => {
  if (isGroup(ctx)) return ctx.reply('Paper trading is personal — DM the bot instead.');
  const open = await listOpenPositions(ctx.from.id);
  if (!open.length) return ctx.reply('No open paper positions.');
  const prices = await callPrices(open.map((p) => p.mint)).catch(() => new Map());
  for (const p of open) {
    const price = prices.get(p.mint)?.priceUsd;
    await ctx.reply(buildPositionCard(p, price), { ...HTML, reply_markup: positionKeyboard(p.id) });
  }
});

bot.callbackQuery(/^pp:(refresh|share|close):(\d+)(?::(\d+))?$/, async (ctx) => {
  const [, action, idStr, pctStr] = ctx.match;
  const id = Number(idStr);
  // getPaperPosition is owner-scoped: nobody can refresh/share/close someone else's position from an old card.
  const pos = await getPaperPosition(ctx.from.id, id);
  if (!pos || pos.status !== 'open') return ctx.answerCallbackQuery({ text: 'Position not found or already closed' });

  if (action === 'refresh') {
    const prices = await callPrices([pos.mint]).catch(() => new Map());
    const price = prices.get(pos.mint)?.priceUsd;
    await ctx.editMessageText(buildPositionCard(pos, price), { ...HTML, reply_markup: positionKeyboard(id) }).catch(() => {});
    return ctx.answerCallbackQuery({ text: 'Refreshed' });
  }

  if (action === 'share') {
    const r = await buildAndSharePaperCard(ctx.from.id, id);
    return ctx.answerCallbackQuery({ text: r.ok ? 'PnL card sent' : 'Could not build that card right now' });
  }

  // close: 100% is a full manual close; 25%/50% peel off a slice via the same partial-close accounting the
  // partial-TP tier uses (which also means a manual partial consumes that one-time partial slot).
  const pctClose = Number(pctStr) || 100;
  const prices = await callPrices([pos.mint]).catch(() => new Map());
  const price = prices.get(pos.mint)?.priceUsd ?? null;
  const pnl = pnlPct(Number(pos.entry_price_usd), price);
  if (pnl == null) return ctx.answerCallbackQuery({ text: 'No price available right now — try again shortly' });
  const sizeUsd = Number(pos.size_usd);
  let ownerId = null, closeUsd = 0;
  if (pctClose >= 100) {
    closeUsd = sizeUsd;
    const payoutUsd = Math.max(0, sizeUsd * (1 + pnl / 100));
    ownerId = await closePosition(id, { exitPriceUsd: price, exitMcapUsd: prices.get(pos.mint)?.marketCapUsd ?? null, reason: 'manual', payoutUsd, pnlUsd: payoutUsd - sizeUsd, pnlPct: pnl });
  } else {
    closeUsd = Math.floor(sizeUsd * (pctClose / 100) * 100) / 100;
    if (closeUsd <= 0) return ctx.answerCallbackQuery({ text: 'That slice is too small to close' });
    const payoutUsd = Math.max(0, closeUsd * (1 + pnl / 100));
    ownerId = await closePartialPosition(id, { portionSizeUsd: closeUsd, payoutUsd, pnlUsd: payoutUsd - closeUsd });
  }
  if (!ownerId) return ctx.answerCallbackQuery({ text: 'Position not found or already closed' });
  snapshotEquity(ownerId).catch((e) => console.error('equity snapshot error:', e.message));
  await ctx.editMessageText(`Closed ${pctClose}% of ${pos.symbol || 'position'} (~$${closeUsd.toFixed(2)})`, HTML).catch(() => {});
  return ctx.answerCallbackQuery({ text: `Closed ${pctClose}%` });
});

bot.command('positions', async (ctx) => {
  if (isGroup(ctx)) return ctx.reply('Paper trading is personal — DM the bot instead.');
  const rows = await listOpenPositions(ctx.from.id);
  const prices = rows.length ? await callPrices(rows.map((r) => r.mint)) : new Map();
  return ctx.reply(buildPositionsText(rows, prices), HTML);
});
bot.command('paperhistory', async (ctx) => {
  if (isGroup(ctx)) return ctx.reply('Paper trading is personal — DM the bot instead.');
  const rows = await listClosedPositions(ctx.from.id);
  return ctx.reply(buildHistoryText(rows), { ...HTML, reply_markup: historyKeyboard(rows) });
});

// A shareable performance summary — win rate, realized PnL, best trade. Pulled from a wide history so the
// numbers cover the whole record, not just the recent handful the inline-buttons can share.
bot.command('paperstats', async (ctx) => {
  if (isGroup(ctx)) return ctx.reply('Paper trading is personal — DM the bot instead.');
  const [rows, equityHistory] = await Promise.all([listClosedPositions(ctx.from.id, { limit: 500 }), listEquitySnapshots(ctx.from.id, { limit: 50 })]);
  return ctx.reply(buildStatsText(rows, equityHistory.map((e) => Number(e.equity_usd))), HTML);
});
// /paperwhy <id>: the agent's fuller reasoning for one trade (deeper logging) — kept out of the main
// open/close notices so those stay uncluttered, available on request for review.
bot.command('paperwhy', async (ctx) => {
  if (isGroup(ctx)) return ctx.reply('Paper trading is personal — DM the bot instead.');
  const id = Number((ctx.match ?? '').trim());
  if (!Number.isFinite(id)) return ctx.reply('Usage: /paperwhy <trade id> — the id shown in /positions or /paperhistory.');
  const p = await getPaperPosition(ctx.from.id, id);
  return ctx.reply(buildWhyText(p), HTML);
});
// Self-service controls over one's own account — these act on the caller's own account, never anyone else's.
bot.command('paperpause', async (ctx) => {
  if (isGroup(ctx)) return ctx.reply('Paper trading is personal — DM the bot instead.');
  const s = await updateStrategy(ctx.from.id, { enabled: false });
  return ctx.reply(buildStrategyText(s), { ...HTML, reply_markup: strategyKb(s) });
});
bot.command('paperresume', async (ctx) => {
  if (isGroup(ctx)) return ctx.reply('Paper trading is personal — DM the bot instead.');
  if (!paperAccessAllowed(ctx.from.id)) return ctx.reply(PAPER_RESTRICTED_MSG);
  const s = await updateStrategy(ctx.from.id, { enabled: true });
  return ctx.reply(buildStrategyText(s), { ...HTML, reply_markup: strategyKb(s) });
});
bot.command('paperclose', async (ctx) => {
  if (isGroup(ctx)) return ctx.reply('Paper trading is personal — DM the bot instead.');
  const id = Number((ctx.match ?? '').trim());
  if (!Number.isFinite(id)) return ctx.reply('Usage: /paperclose <trade id> — closes that open position right now, at the current price.');
  const p = await getPaperPosition(ctx.from.id, id);
  if (!p || p.status !== 'open') return ctx.reply('No open position with that id.');
  const price = (await callPrices([p.mint])).get(p.mint)?.priceUsd ?? null;
  const pct = pnlPct(Number(p.entry_price_usd), price);
  if (pct == null) return ctx.reply('No price available for that token right now — try again shortly.');
  const sizeUsd = Number(p.size_usd);
  const payoutUsd = Math.max(0, sizeUsd * (1 + pct / 100));
  const pnlUsd = payoutUsd - sizeUsd;
  const telegramId = await closePosition(id, { exitPriceUsd: price, exitMcapUsd: null, reason: 'manual', payoutUsd, pnlUsd, pnlPct: pct });
  if (!telegramId) return ctx.reply('That position is already closed.');
  snapshotEquity(telegramId).catch((e) => console.error('equity snapshot error:', e.message));
  return ctx.reply(buildCloseNotice({ symbol: p.symbol, mint: p.mint, reason: 'manual', pnlUsd, pnlPct: pct }), HTML);
});
bot.command('paperreset', async (ctx) => {
  if (isGroup(ctx)) return ctx.reply('Paper trading is personal — DM the bot instead.');
  const arg = (ctx.match ?? '').trim().toLowerCase();
  if (arg !== 'confirm') return ctx.reply('This wipes your open positions, equity history, and balance back to the starting amount. This cannot be undone.\nTo confirm: /paperreset confirm');
  await resetPaperAccount(ctx.from.id);
  return ctx.reply('Your paper account has been reset.');
});

// Auto-enable agent mode for the owner on first use (no manual strategy needed). Runs once at startup;
// a no-op unless OWNER_TELEGRAM_ID is set. Note: tp_pct/sl_pct are intentionally left at their schema
// defaults (100/40) — those columns are NOT NULL, so the supplied patch's null values would have failed
// the whole strategy UPDATE and silently applied nothing.
const OWNER_TELEGRAM_ID = process.env.OWNER_TELEGRAM_ID;
async function ensureOwnerAgentMode() {
  if (!OWNER_TELEGRAM_ID) return;
  try {
    const existing = await getStrategy(OWNER_TELEGRAM_ID);
    if (!existing || existing.mode !== 'agent' || !existing.enabled) {
      await upsertUser({ id: OWNER_TELEGRAM_ID, username: null }); // paper tables FK to users — make sure the row exists
      await ensurePaperAccount(OWNER_TELEGRAM_ID);
      await updateStrategy(OWNER_TELEGRAM_ID, {
        enabled: true,
        mode: 'agent',
        agent_prompt: 'You are an autonomous meme coin paper trader. Look at new calls and decide whether to buy, call, or skip based on narrative, momentum, and risk. Prefer low market cap tokens under 30k. Use small sizes. Be selective. No real money.',
        min_mcap_usd: null,
        max_mcap_usd: null,
        alloc_pct: 5,
        max_open: 5,
      });
      console.log('Owner agent mode auto-enabled');
    }
  } catch (e) {
    console.error('ensureOwnerAgentMode error:', e.message);
  }
}

bot.callbackQuery('pe:show', async (ctx) => { await ctx.answerCallbackQuery(); return showStrategy(ctx); });
bot.callbackQuery('pe:pos', async (ctx) => {
  await ctx.answerCallbackQuery();
  const rows = await listOpenPositions(ctx.from.id);
  const prices = rows.length ? await callPrices(rows.map((r) => r.mint)) : new Map();
  return ctx.reply(buildPositionsText(rows, prices), HTML);
});
bot.callbackQuery('pe:hist', async (ctx) => {
  await ctx.answerCallbackQuery();
  const rows = await listClosedPositions(ctx.from.id);
  return ctx.reply(buildHistoryText(rows), { ...HTML, reply_markup: historyKeyboard(rows) });
});
bot.callbackQuery(/^pc:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery({ text: 'Sending card…' });
  const r = await buildAndSharePaperCard(ctx.from.id, Number(ctx.match[1]));
  if (!r.ok) await ctx.reply(`Could not build that card (${r.error}).`).catch(() => {});
});
bot.callbackQuery('pe:tog', async (ctx) => {
  const s = await getStrategy(ctx.from.id);
  const updated = await updateStrategy(ctx.from.id, { enabled: !s.enabled });
  await ctx.answerCallbackQuery({ text: updated.enabled ? 'Strategy on' : 'Strategy off' });
  return ctx.editMessageText(buildStrategyText(updated), { ...HTML, reply_markup: strategyKb(updated) }).catch(() => {});
});
bot.callbackQuery('pe:mode', async (ctx) => {
  const s = await getStrategy(ctx.from.id);
  const next = MODE_NEXT[s.mode ?? 'rules'] ?? 'rules';
  const updated = await updateStrategy(ctx.from.id, { mode: next });
  await ctx.answerCallbackQuery({ text: `Mode: ${next}` });
  return ctx.editMessageText(buildStrategyText(updated), { ...HTML, reply_markup: strategyKb(updated) }).catch(() => {});
});
bot.callbackQuery('pe:sizemode', async (ctx) => {
  const s = await getStrategy(ctx.from.id);
  const next = SIZE_MODE_NEXT[s.size_mode ?? 'pct'] ?? 'pct';
  const updated = await updateStrategy(ctx.from.id, { size_mode: next });
  await ctx.answerCallbackQuery({ text: next === 'fixed' ? 'Fixed $ sizing' : '% sizing' });
  return ctx.editMessageText(buildStrategyText(updated), { ...HTML, reply_markup: strategyKb(updated) }).catch(() => {});
});
bot.callbackQuery(/^pe:(min_mcap_usd|max_mcap_usd|alloc_pct|alloc_usd|tp_pct|sl_pct|max_open|max_position_usd|daily_loss_limit_pct|agent_prompt|source_filter|partial_tp_pct|partial_tp_close_pct)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  paperEdit.set(ctx.from.id, ctx.match[1]);
  return ctx.reply(STRATEGY_PROMPT[ctx.match[1]]);
});

bot.command('trade', (ctx) => ctx.reply(`https://t.me/${TRADE_USERNAME}`));
bot.command('launch', (ctx) => ctx.reply(`https://t.me/${LAUNCH_USERNAME}`));
bot.command('scan', showTrending);

const MINT = '([1-9A-HJ-NP-Za-km-z]{32,44})';
bot.callbackQuery('trend', async (ctx) => { await ctx.answerCallbackQuery(); return showTrending(ctx, { edit: true }); });
bot.callbackQuery('wl', async (ctx) => { await ctx.answerCallbackQuery(); return showWatchlist(ctx, { edit: true }); });
bot.callbackQuery(new RegExp(`^t:${MINT}$`), async (ctx) => { await ctx.answerCallbackQuery(); return showToken(ctx, ctx.match[1]); });
bot.callbackQuery(new RegExp(`^r:${MINT}$`), async (ctx) => { await ctx.answerCallbackQuery(); return showToken(ctx, ctx.match[1], { edit: true }); });
bot.callbackQuery(new RegExp(`^b:${MINT}$`), (ctx) => sendBubblemap(ctx, ctx.match[1]));
bot.callbackQuery(new RegExp(`^h:${MINT}$`), (ctx) => showDetail(ctx, 'h', ctx.match[1], () => buildHolders(ctx.match[1])));
bot.callbackQuery(new RegExp(`^d:${MINT}$`), (ctx) => showDetail(ctx, 'd', ctx.match[1], () => buildDev(ctx.match[1])));
bot.callbackQuery(new RegExp(`^l:${MINT}$`), (ctx) => showDetail(ctx, 'l', ctx.match[1], () => buildLore(ctx.match[1], ctx.from.id)));
bot.callbackQuery('x', async (ctx) => { await ctx.answerCallbackQuery().catch(() => {}); await ctx.deleteMessage().catch(() => {}); });
bot.callbackQuery(new RegExp(`^w:${MINT}$`), (ctx) => doWatch(ctx, ctx.match[1], { edit: true }));
bot.callbackQuery(new RegExp(`^uw:${MINT}$`), (ctx) => doUnwatch(ctx, ctx.match[1], { edit: true }));

bot.on('message:text', async (ctx, next) => {
  const text = ctx.message.text;
  if (text.startsWith('/')) return next();
  if (!isGroup(ctx) && paperEdit.has(ctx.from.id)) {
    const field = paperEdit.get(ctx.from.id);
    paperEdit.delete(ctx.from.id);
    if (field === 'agent_prompt') {
      const trimmed = text.trim();
      const s = await updateStrategy(ctx.from.id, { agent_prompt: /^(clear|none|any)$/i.test(trimmed) ? null : trimmed.slice(0, 2000) });
      return ctx.reply(buildStrategyText(s), { ...HTML, reply_markup: strategyKb(s) });
    }
    if (field === 'source_filter') {
      const trimmed = text.trim();
      const s = await updateStrategy(ctx.from.id, { source_filter: /^(clear|none|any)$/i.test(trimmed) ? null : trimmed.slice(0, 500) });
      return ctx.reply(buildStrategyText(s), { ...HTML, reply_markup: strategyKb(s) });
    }
    const raw = text.trim().toLowerCase();
    if ((field === 'min_mcap_usd' || field === 'max_mcap_usd' || field === 'max_position_usd' || field === 'daily_loss_limit_pct' || field === 'alloc_usd' || field === 'partial_tp_pct' || field === 'partial_tp_close_pct') && (raw === 'any' || raw === 'none' || raw === 'clear')) {
      const s = await updateStrategy(ctx.from.id, { [field]: null });
      return ctx.reply(buildStrategyText(s), { ...HTML, reply_markup: strategyKb(s) });
    }
    const n = Number(raw.replace(/[,$%]/g, ''));
    if (!Number.isFinite(n) || n < 0) return ctx.reply('That is not a number I can use. Try again: ' + STRATEGY_PROMPT[field]);
    const s = await updateStrategy(ctx.from.id, { [field]: field === 'max_open' ? Math.max(1, Math.round(n)) : n });
    return ctx.reply(buildStrategyText(s), { ...HTML, reply_markup: strategyKb(s) });
  }
  if (isGroup(ctx)) {
    const mint = extractMint(text);
    if (!mint) return;
    console.log(`group ${ctx.chat.id}: address ${short(mint)} from ${callerName(ctx.from)}`);
    const now = Date.now();
    if (now - (lastGroupCard.get(ctx.chat.id) ?? 0) < 1000) return;
    lastGroupCard.set(ctx.chat.id, now);
    return showToken(ctx, mint, { record: true });
  }
  const mint = parseMintInput(text);
  if (mint) return showToken(ctx, mint);
  if (looksLikeMint(text.trim().split(/\s+/)[0] ?? '')) return ctx.reply('Paste just the token address.');
});

// ---- background price alerts: one check every minute ----
let checking = false;
const VOL_SPIKE_MULT = 5; // h1 volume > 5x baseline = spike alert
async function checkAlerts() {
  if (checking) return;
  checking = true;
  try {
    const rows = await listAllWatches();
    if (!rows.length) return;
    const prices = await fetchPairsByTokens(rows.map((r) => r.mint));
    for (const r of rows) {
      const pair = prices.get(r.mint);
      const price = pair?.priceUsd;
      if (!price || (pair.liquidityUsd != null && pair.liquidityUsd < 500)) continue;

      const alerts = [];

      // 1) Price movement alert
      if (shouldAlert(r.base_price_usd, price, r.alert_pct)) {
        alerts.push(buildAlertText(r, price));
      }

      // 2) Bonding curve graduation alert
      if (r.on_curve && !r.curve_alerted && pair.dex && !/pump\.fun curve/i.test(pair.dex)) {
        alerts.push(buildCurveGraduationText(r, pair.dex));
        markCurveAlerted(r.telegram_id, r.mint).catch(() => {});
      }

      // 3) Volume spike alert
      if (r.vol_baseline > 0 && pair.volume?.h1 > 0 && pair.volume.h1 >= r.vol_baseline * VOL_SPIKE_MULT) {
        alerts.push(buildVolumeSpikeText(r, pair.volume.h1, r.vol_baseline));
        // Update baseline so we don't re-alert next cycle
        setVolBaseline(r.telegram_id, r.mint, pair.volume.h1).catch(() => {});
      } else if (pair.volume?.h1 > 0 && !r.vol_baseline) {
        // Seed baseline for existing watches that don't have one
        setVolBaseline(r.telegram_id, r.mint, pair.volume.h1).catch(() => {});
      }

      if (!alerts.length) continue;

      for (const text of alerts) {
        try {
          await bot.api.sendMessage(r.telegram_id, text, {
            ...HTML,
            reply_markup: new InlineKeyboard().text('Open card', `t:${r.mint}`).url('⚡ Buy on Omni Trade', tradeLink(r.mint)),
          });
        } catch (e) {
          if (e.error_code === 403) { await removeAllWatches(r.telegram_id); break; }
          else console.error('alert send error:', e.message);
        }
        await new Promise((res) => setTimeout(res, 50)); // stay well under Telegram's send limits
      }
      // Update price base if a price alert fired
      if (shouldAlert(r.base_price_usd, price, r.alert_pct)) {
        await updateWatchBase(r.telegram_id, r.mint, price);
      }
    }
  } catch (e) {
    console.error('alert check error:', e.message);
  } finally {
    checking = false;
  }
}

// Posts a card in the group when a call reaches 2x, 3x, 5x, 10x... (each one once), as a reply to the message that
// made the call. Groups choose with /milestones (off, or start at a bigger multiple).
const CALL_TRACK_DAYS = Number(process.env.CALL_TRACK_DAYS) || 7;
const callPrices = (mints) => livePrices(mints, { fetchPairs: fetchPairsByTokens, quoteUsd, launchMarket: fetchLaunchMarket });
const deadChats = new Map(); // chatId -> time the bot was found removed; skipped for a while instead of erroring every run
let checkingCalls = false;
async function checkCalls() {
  if (checkingCalls) return;
  checkingCalls = true;
  const t0 = Date.now();
  let posted = 0;
  try {
    const rows = (await listLiveCalls({ days: CALL_TRACK_DAYS })).filter((r) => Date.now() - (deadChats.get(String(r.chat_id)) ?? 0) > 6 * 3600_000);
    if (!rows.length) return;
    const prices = await callPrices(rows.map((r) => r.mint));
    for (const r of rows) {
      const price = prices.get(r.mint)?.priceUsd;
      // announcements follow the HIGHEST price seen, so a quick pump is not missed between two checks
      const peakPrice = Math.max(Number(r.peak_price_usd) || 0, price || 0);
      if (price > (Number(r.peak_price_usd) || 0)) setCallPeak(r.chat_id, r.mint, price).catch(() => {});
      const x = multiple(r.price_usd, peakPrice);
      const m = newMilestone(r.last_x, x, r.min_x);
      if (!m) continue;
      r.peak_price_usd = peakPrice;
      await setCallMilestone(r.chat_id, r.mint, m); // first, so a failed send never repeats
      try {
        const title = (await bot.api.getChat(r.chat_id).catch(() => null))?.title;
        const card = await pnlPng(r, prices, title, { skipHistory: true });
        if (!card) continue;
        const caption = buildMilestoneCaption({
          symbol: r.symbol, callerName: r.caller_name, callerId: r.caller_id, sourceUrl: r.source_url, milestone: m, x: card.x,
          entryMcap: Number(r.mcap_usd) || null, peakMcap: r.mcap_usd ? r.mcap_usd * card.x : null,
          tookMs: Date.now() - new Date(r.created_at).getTime(),
        });
        await bot.api.sendPhoto(r.chat_id, new InputFile(card.png, card.name), {
          caption, parse_mode: 'HTML',
          reply_markup: new InlineKeyboard().text('📊 Card', `t:${r.mint}`).url('⚡ Buy', tradeLink(r.mint)),
          ...(r.call_msg_id ? { reply_parameters: { message_id: Number(r.call_msg_id), allow_sending_without_reply: true } } : {}),
        });
        posted++;
      } catch (e) {
        // removed from the group, or the group is gone: stop trying there for a while
        if (e.error_code === 403 || /chat not found|upgraded to a supergroup/i.test(e.description ?? e.message)) deadChats.set(String(r.chat_id), Date.now());
        console.error('multiplier post error:', e.description ?? e.message);
      }
      await new Promise((res) => setTimeout(res, 100));
    }
    const priced = rows.filter((r) => prices.get(r.mint)?.priceUsd > 0).length;
    if (posted || priced < rows.length) console.log(`calls check: ${rows.length} live, ${priced} priced, ${posted} posted, ${Date.now() - t0}ms`);
  } catch (e) {
    console.error('call check error:', e.message);
  } finally {
    checkingCalls = false;
  }
}

// Equity curve: equity = cash balance + the size of still-open positions (same figure /paper's "Equity" line
// already shows) — a snapshot taken right after something happens to a user's account, not on a timer.
async function snapshotEquity(telegramId) {
  const [account, open] = await Promise.all([getPaperAccount(telegramId), listOpenPositions(telegramId)]);
  if (!account) return;
  const investedUsd = open.reduce((a, p) => a + Number(p.size_usd), 0);
  await recordEquitySnapshot(telegramId, Number(account.balance_usd) + investedUsd);
}

// Paper trading: checks every open position's current price against its owner's take-profit / stop-loss and closes it, crediting the balance back.
let checkingPaper = false;
async function checkPaperPositions() {
  if (checkingPaper) return;
  checkingPaper = true;
  try {
    const rows = await listOpenPositions();
    if (!rows.length) return;
    const [prices, strategies] = await Promise.all([callPrices(rows.map((r) => r.mint)), listStrategiesByIds(rows.map((r) => r.telegram_id))]);
    let closed = 0;
    const touchedUsers = new Set();
    for (const r of rows) {
      const strategy = strategies.get(String(r.telegram_id));
      if (!strategy) continue; // shouldn't happen: every account gets a strategy row on creation
      const price = prices.get(r.mint)?.priceUsd ?? null;
      const pct = pnlPct(Number(r.entry_price_usd), price);
      const reason = shouldClose(strategy, pct);
      if (!reason) {
        // Partial take-profit: a single configurable tier peels off part of the position without closing it.
        if (pct != null && partialTpHit(strategy, pct, r.partial_closed)) {
          const sizeNowUsd = Number(r.size_usd);
          const portionUsd = partialCloseSize(strategy, sizeNowUsd);
          if (portionUsd > 0) {
            const partPayoutUsd = Math.max(0, portionUsd * (1 + pct / 100));
            const partPnlUsd = partPayoutUsd - portionUsd;
            const ownerId = await closePartialPosition(r.id, { portionSizeUsd: portionUsd, payoutUsd: partPayoutUsd, pnlUsd: partPnlUsd });
            if (ownerId) {
              touchedUsers.add(ownerId);
              bot.api.sendMessage(ownerId, buildPartialCloseNotice({ symbol: r.symbol, mint: r.mint, closedUsd: portionUsd, remainingUsd: sizeNowUsd - portionUsd, pnlUsd: partPnlUsd, pnlPct: pct }), {
                ...HTML, ...(r.open_msg_id ? { reply_parameters: { message_id: Number(r.open_msg_id), allow_sending_without_reply: true } } : {}),
              }).catch(() => {});
            }
          }
        }
        // Phase 4: announce each new multiple once, as a reply under the original open/call message — the
        // same threading a real group call's multiplier posts use.
        const entry = Number(r.entry_price_usd);
        const x = entry > 0 && price != null ? price / entry : null;
        const ms = x != null ? newMilestone(Number(r.last_milestone_x) || 1, x) : null;
        if (ms && r.open_msg_id) {
          await setPositionMilestone(r.id, ms).catch(() => {});
          bot.api.sendMessage(r.telegram_id, buildMilestoneNotice({ symbol: r.symbol, mint: r.mint, x: ms }),
            { ...HTML, reply_parameters: { message_id: Number(r.open_msg_id) } }).catch(() => {});
        }
        continue;
      }
      const sizeUsd = Number(r.size_usd);
      const payoutUsd = Math.max(0, sizeUsd * (1 + pct / 100));
      const pnlUsd = payoutUsd - sizeUsd;
      const exitMcapUsd = prices.get(r.mint)?.marketCapUsd ?? null;
      const telegramId = await closePosition(r.id, { exitPriceUsd: price, exitMcapUsd, reason, payoutUsd, pnlUsd, pnlPct: pct });
      if (!telegramId) continue; // already closed elsewhere
      closed++;
      touchedUsers.add(telegramId);
      await notifyPaperClose(telegramId, { ...r, status: 'closed', close_reason: reason, exit_price_usd: price, exit_mcap_usd: exitMcapUsd, pnl_usd: pnlUsd, pnl_pct: pct, closed_at: new Date() });
    }
    // Equity curve: an event-based snapshot per user touched this tick (full or partial close).
    for (const telegramId of touchedUsers) {
      snapshotEquity(telegramId).catch((e) => console.error('equity snapshot error:', e.message));
    }
    if (closed) console.log(`paper check: ${rows.length} open, ${closed} closed`);
  } catch (e) {
    console.error('paper check error:', e.message);
  } finally {
    checkingPaper = false;
  }
}

// /milestones: show or change this group's multiplier posts (admins change, everyone can look).
bot.command(['milestones', 'multipliers', 'mx'], async (ctx) => {
  if (!isGroup(ctx)) return ctx.reply('Multiplier posts are for groups: when a call in the group reaches 2x, 5x, 10x… I post a card there.');
  const arg = (ctx.match ?? '').trim();
  if (!arg) return ctx.reply(buildMilestoneSettingText(await getMilestoneSetting(ctx.chat.id)), { ...HTML, reply_markup: KB_DEL });
  const want = parseMilestoneArg(arg);
  if (!want) return ctx.reply('Try: /milestones off, /milestones on, or /milestones 5 (only 5x and bigger).');
  if (!(await canManageGroup(ctx))) return ctx.reply('Only group admins can change the multiplier posts.');
  const now = await setMilestoneSetting(ctx.chat.id, { enabled: want.enabled, minX: want.minX ?? undefined });
  return ctx.reply(buildMilestoneSettingText(now), { ...HTML, reply_markup: KB_DEL });
});


// ---- Followed X accounts: a token address they post becomes a call in the group ----
const X_EVERY_MS = (Number(process.env.X_POLL_SECONDS) || 10) * 1000;
const xBackoff = new Map(); // handle -> { fails, until }
const xLogged = new Map();
async function canManageGroup(ctx) {
  const ids = (process.env.ADMIN_IDS ?? '').split(',').map((v) => v.trim()).filter(Boolean);
  if (ids.includes(String(ctx.from?.id))) return true;
  try { const m = await ctx.getChatMember(ctx.from.id); return m.status === 'creator' || m.status === 'administrator'; } catch { return false; }
}
bot.command(['follow', 'addx', 'xfollow'], async (ctx) => {
  if (!isGroup(ctx)) return ctx.reply('Following X accounts works in groups: add me to your group and send /follow @handle there.');
  if (!(await canManageGroup(ctx))) return ctx.reply('Only group admins can change the followed accounts.');
  const handle = normHandle(ctx.match);
  if (!handle) return ctx.reply('Usage: /follow @handle\nAny token address that account posts is called in this group.');
  const r = await addXFollow({ chatId: ctx.chat.id, handle, addedBy: ctx.from.id, addedByName: callerName(ctx.from) });
  if (r === 'full') return ctx.reply(`This group already follows ${MAX_X_FOLLOWS} accounts. Remove one with /unfollow @handle first.`);
  if (r === 'exists') return ctx.reply(`Already following @${handle}. Use /following to see the status.`);
  // read it once now, so the answer says whether it works; posts up to now never become calls
  const t = await withTyping(ctx, () => fetchTweets(handle, { workerFn: xWorkerFeed }));
  if (t.error) {
    await setXPoll({ handle, ok: false, error: t.error }).catch(() => {});
    console.error(`x follow @${handle}: ${t.error}`);
    return ctx.reply(buildFollowAddedText({ handle, error: t.error }), HTML);
  }
  const { cursor } = pickNew(t.tweets, null);
  if (cursor) await setXCursor(ctx.chat.id, handle, cursor).catch(() => {});
  const newest = [...t.tweets].sort((a, b) => (BigInt(a.id) > BigInt(b.id) ? -1 : 1))[0];
  await setXPoll({ handle, ok: true, via: t.via, newestId: newest?.id ?? null, newestAt: newest?.createdAt ? new Date(newest.createdAt) : null }).catch(() => {});
  return ctx.reply(buildFollowAddedText({ handle, latestAgoMs: newest?.createdAt ? Date.now() - newest.createdAt : null }), HTML);
});
bot.command(['unfollow', 'unx', 'xunfollow'], async (ctx) => {
  if (!isGroup(ctx)) return ctx.reply('This works in groups.');
  if (!(await canManageGroup(ctx))) return ctx.reply('Only group admins can change the followed accounts.');
  const handle = normHandle(ctx.match);
  if (!handle) return ctx.reply('Usage: /unfollow @handle');
  return ctx.reply((await removeXFollow(ctx.chat.id, handle)) ? `Stopped following @${handle}.` : `This group does not follow @${handle}.`);
});
bot.command(['following', 'xlist'], async (ctx) => {
  if (!isGroup(ctx)) return ctx.reply('This works in groups.');
  const [rows, heartbeat] = await Promise.all([listXFollows(ctx.chat.id), getWorkerHeartbeat().catch(() => null)]);
  return ctx.reply(buildFollowingText(rows, Date.now(), heartbeat), { ...HTML, reply_markup: KB_DEL });
});

// A token address found in a followed account's post: price it first (no price, no call: it may not be a token at all),
// then record the call and post the card, exactly like a member posting the address.
async function xCall(chatId, handle, tweet, mint) {
  const card = await cachedCard(mint);
  const m = card.market;
  if (!m?.priceUsd) return;
  await upsertUser({ id: xCallerId(handle), username: handle }); // calls.caller_id must point at a users row
  const r = await recordFirstCall({ chatId, mint, symbol: m.symbol, callerId: xCallerId(handle), callerName: `@${handle}`, priceUsd: m.priceUsd, mcapUsd: m.marketCapUsd, sourceUrl: `https://x.com/${handle}/status/${tweet.id}` });
  if (!r.first) return; // someone already called it in this group
  tryPaperBuy({ mint, symbol: m.symbol, priceUsd: m.priceUsd, mcapUsd: m.marketCapUsd, source: 'X follow', sourceId: handle }).catch((e) => console.error('paper buy error:', e.message));
  const text = `${buildXCallHeader(handle, tweet.id)}\n\n${buildScanCard({ mint, market: m, security: card.security, intel: card.intel, callLine: buildCallLine(r.call, m.priceUsd), watched: false })}`;
  const url = m.headerUrl || m.imageUrl || null;
  const sent = await bot.api.sendMessage(chatId, text, { ...HTML, reply_markup: cardKeyboard(mint, false, true), ...(url ? { link_preview_options: { url, show_above_text: true, prefer_large_media: true } } : {}) });
  if (sent?.message_id) setCallMessage(chatId, mint, sent.message_id).catch(() => {}); // the multiplier posts reply to this card
  console.log(`x call: @${handle} -> ${short(mint)} in ${chatId}`);
}
async function pollHandle(h) {
  const r = await fetchTweets(h.handle, { workerFn: xWorkerFeed });
  if (r.error) {
    const b = xBackoff.get(h.handle) ?? { fails: 0 };
    b.fails += 1; b.until = Date.now() + Math.min(15 * 60_000, 60_000 * 2 ** Math.min(b.fails, 4));
    xBackoff.set(h.handle, b);
    await setXPoll({ handle: h.handle, ok: false, error: r.error }).catch(() => {});
    if (Date.now() - (xLogged.get(h.handle) ?? 0) > 600_000) { xLogged.set(h.handle, Date.now()); console.error(`x feed @${h.handle}: ${r.error}`); }
    return;
  }
  xBackoff.delete(h.handle);
  const newest = [...r.tweets].sort((a, b) => (BigInt(a.id) > BigInt(b.id) ? -1 : 1))[0];
  await setXPoll({ handle: h.handle, ok: true, via: r.via, newestId: newest?.id ?? null, newestAt: newest?.createdAt ? new Date(newest.createdAt) : null }).catch(() => {});
  for (const c of h.chats) {
    const { fresh, cursor } = pickNew(r.tweets, c.last_tweet_id);
    if (cursor && cursor !== c.last_tweet_id) await setXCursor(c.chat_id, h.handle, cursor).catch(() => {}); // first, so a failed post is never repeated
    for (const tw of fresh) {
      for (const mint of extractMints(tw.text, tw.urls).slice(0, 3)) {
        try { await xCall(c.chat_id, h.handle, tw, mint); } catch (e) { console.error(`x call error @${h.handle}:`, e.message); }
      }
    }
  }
}
const xWorkerFeed = (handle) => loadXFeed(handle, { q: query });
let checkingX = false;
async function checkXFeeds() {
  if (checkingX) return;
  checkingX = true;
  try {
    const now = Date.now();
    const due = (await listAllXFollows())
      .filter((h) => (!h.polled_at || now - new Date(h.polled_at).getTime() >= X_EVERY_MS) && (xBackoff.get(h.handle)?.until ?? 0) < now)
      .sort((a, b) => (new Date(a.polled_at ?? 0).getTime() - new Date(b.polled_at ?? 0).getTime()));
    // Poll all due handles concurrently — each is just a DB read + optional Telegram sends.
    // Bounded to 6 at a time to avoid slamming Telegram with too many cards at once.
    const MAX_CONCURRENT = 6;
    for (let i = 0; i < due.length; i += MAX_CONCURRENT) {
      await Promise.all(due.slice(i, i + MAX_CONCURRENT).map((h) => pollHandle(h).catch((e) => console.error(`x poll @${h.handle}:`, e.message))));
    }
  } catch (e) { console.error('x check error:', e.message); }
  finally { checkingX = false; }
}


// ---- A group turned into a supergroup (new chat id): its saved calls must follow ----
async function moveGroupData(oldId, newId, why) {
  try {
    const r = await moveChatData(oldId, newId);
    console.log(`chat moved ${oldId} -> ${newId} (${why}): ${r.calls} calls, ${r.duplicates} duplicates, ${r.reminders} reminders, ${r.follows} followed accounts`);
    return r;
  } catch (e) { console.error('chat move error:', e.message); return null; }
}
bot.on('message:migrate_to_chat_id', (ctx) => moveGroupData(ctx.chat.id, ctx.message.migrate_to_chat_id, 'Telegram upgrade'));
bot.on('message:migrate_from_chat_id', (ctx) => moveGroupData(ctx.message.migrate_from_chat_id, ctx.chat.id, 'Telegram upgrade'));
// Owner tool: /status shows system health — DB, RPC endpoints, RugCheck, X reader worker, uptime.
function isAdmin(ctx) {
  const ids = (process.env.ADMIN_IDS ?? '').split(',').map((v) => v.trim()).filter(Boolean);
  return ids.includes(String(ctx.from?.id));
}
bot.command('status', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply(`Only the bot owner can use this. Add your Telegram ID (${ctx.from?.id}) to ADMIN_IDS in the .env file and restart the bot.`);
  const t0 = Date.now();
  let db = { ok: false, error: 'not checked' };
  try { await query('SELECT 1'); db = { ok: true, ms: Date.now() - t0 }; } catch (e) { db = { ok: false, error: e.message }; }
  const [worker, watchCount] = await Promise.all([
    getWorkerHeartbeat().catch(() => null),
    countAllWatches().catch(() => null),
  ]);
  const text = buildStatusText({ rpc: rpcStats(), worker, rug: rugCheckStatus(), db, uptimeSec: process.uptime(), watchCount });
  return ctx.reply(text, HTML);
});
// Owner tool: /movecalls lists the chats that have saved calls; /movecalls <old chat id> (sent in the group) brings them here.
bot.command('movecalls', async (ctx) => {
  try { return await runMoveCalls(ctx); } catch (e) { console.error('movecalls error:', e.message); return ctx.reply(`⚠️ I cannot reach the database right now (${String(e.message).slice(0, 80)}). Nothing was changed. Check the internet connection of the computer running the bot, then try again.`); }
});
async function runMoveCalls(ctx) {
  const ids = (process.env.ADMIN_IDS ?? '').split(',').map((v) => v.trim()).filter(Boolean);
  if (!ids.includes(String(ctx.from?.id))) return ctx.reply(`Only the bot owner can use this. Add your Telegram ID (${ctx.from?.id}) to ADMIN_IDS in the .env file and restart the bot.`);
  const arg = (ctx.match ?? '').trim();
  if (!arg) {
    const rows = await listCallChats();
    if (!rows.length) return ctx.reply('No saved calls at all.');
    const lines = [];
    for (const r of rows) {
      const title = (await ctx.api.getChat(r.chat_id).catch(() => null))?.title;
      lines.push(`<code>${r.chat_id}</code> · ${r.n} call${r.n === 1 ? '' : 's'} · last ${formatDuration(Date.now() - new Date(r.last).getTime())} ago${String(r.chat_id) === String(ctx.chat.id) ? ' · <b>this chat</b>' : ''}${title ? ` · ${esc(title)}` : ' · <i>old or unreachable</i>'}`);
    }
    return ctx.reply(`📦 <b>Chats with saved calls</b>\n${lines.join('\n')}\n\nTo bring the calls of an old chat into a group, send this in that group:\n<code>/movecalls &lt;old chat id&gt;</code>`, HTML);
  }
  if (!isGroup(ctx)) return ctx.reply('Send /movecalls <old chat id> inside the group that should receive the calls.');
  if (!/^-?\d{5,}$/.test(arg)) return ctx.reply('That does not look like a chat id. Send /movecalls on its own to see the list.');
  if (String(arg) === String(ctx.chat.id)) return ctx.reply('That is this chat already.');
  const r = await moveGroupData(arg, ctx.chat.id, 'owner command');
  if (!r) return ctx.reply('The move failed. Nothing was changed. Check the bot window for the error.');
  return ctx.reply(`✅ <b>Calls restored</b>\n<pre>${esc(`├ Calls moved    ${r.calls}\n├ Duplicates     ${r.duplicates} (the earlier call was kept)\n├ Reminders      ${r.reminders}\n└ Followed X     ${r.follows}`)}</pre>Try /calls or /lb now.`, HTML);
}

bot.catch((err) => console.error('bot error:', err.error?.message ?? err.message));
bot.start({
  onStart: async (me) => {
    await ensureOwnerAgentMode();
    console.log(`Omni Scan Bot running as @${me.username}`);
    console.log(me.can_read_all_group_messages
      ? 'Groups: I can read every message (Group Privacy is off).'
      : 'Groups: Group Privacy is ON, so I only see /commands in groups. Turn it off in BotFather, then remove me from the group and add me again.');
    if (MINIAPP_URL) startMiniApp({ port: Number(process.env.MINIAPP_PORT) || 3000, loadData: loadMapData, dash });
    else console.log('Bubblemap mini app: off (set MINIAPP_URL to turn it on). The picture version is used.');
    console.log(`RPC endpoints: ${rpcStats().endpoints.map((e) => e.host).join(', ')}`);
    console.log(`Lore AI: ${[process.env.ANTHROPIC_API_KEY ? 'Claude' : null, process.env.GEMINI_API_KEY ? 'Gemini' : null].filter(Boolean).join(' + ') || 'off (shows the token description and news only)'}`);
    // The menu next to the message box.
    liqFeed.start();
    bot.api.setMyCommands([
      { command: 'token', description: 'Token card (paste an address)' },
      { command: 'th', description: 'View the top holders' },
      { command: 'dev', description: 'View deployer & deployed coins' },
      { command: 'nar', description: 'Get the narrative (lore) of a token' },
      { command: 'soc', description: 'Get social media links' },
      { command: 'dp', description: 'Check DEX Paid status' },
      { command: 'p', description: 'Simple price query' },
      { command: 'bm', description: 'View the bubblemap' },
      { command: 'paper', description: 'Paper trading: balance & positions' },
      { command: 'strategy', description: 'Paper trading: edit your rules' },
      { command: 'positions', description: 'Paper trading: open positions' },
      { command: 'paperhistory', description: 'Paper trading: closed trades' },
      { command: 'paperstats', description: 'Paper trading: your stats' },
      { command: 'c', description: 'Open a chart' },
      { command: 's', description: 'Search for a token' },
      { command: 'i', description: 'Get top coins' },
      { command: 'trending', description: 'View trending tokens' },
      { command: 'dashboard', description: 'Full-screen app: search, trending, watchlist' },
      { command: 'watch', description: 'Your watchlist / watch a token' },
      { command: 'leaderboard', description: 'Group leaderboard (1h, 1 week, all...)' },
      { command: 'calls', description: 'Your calls in this group' },
      { command: 'pnl', description: 'PnL card of a call (groups)' },
      { command: 'milestones', description: 'Multiplier posts: on, off or from 5x (groups)' },
      { command: 'callmap', description: "Heatmap of this group's calls (groups)" },
      { command: 'meme', description: 'A random crypto meme' },
      { command: 'hm', description: 'Crypto heatmap' },
      { command: 'best', description: 'Top gainers' },
      { command: 'worst', description: 'Top losers' },
      { command: 'fc', description: 'Who called a token first (groups)' },
      { command: 'last', description: 'Last calls in the group' },
      { command: 'ta', description: 'Technical read of a token' },
      { command: 'target', description: 'Alert me at 3x, 4x, -50%...' },
      { command: 'chart', description: 'Candlestick chart (1m 5m 1h...)' },
      { command: 'follow', description: 'Call tokens an X account posts' },
      { command: 'unfollow', description: 'Stop following an X account' },
      { command: 'following', description: 'Followed X accounts' },
      { command: 'targets', description: 'Your price alerts' },
      { command: 'untarget', description: 'Remove price alerts' },
      { command: 'remindme', description: 'Reminder to you (private)' },
      { command: 'remind', description: 'Reminder for this chat (pinned)' },
      { command: 'listreminders', description: 'Your reminders' },
      { command: 'nevermind', description: 'Cancel a reminder' },
      { command: 'elb', description: 'Export the leaderboard (groups)' },
      { command: 'tr', description: 'Translate text (-fr, -es...)' },
      { command: 'tldr', description: 'Summarize text or a link' },
      { command: 'eli5', description: 'Explain simply' },
      { command: 'epoch', description: 'Unix time to a date' },
      { command: 'userid', description: 'Your Telegram ID' },
      { command: 'chatid', description: 'This chat ID' },
      { command: 'flip', description: 'Flip a coin' },
      { command: 'poly', description: 'Search Polymarket' },
      { command: 'tt', description: 'Top traders of a token' },
      { command: 'tw', description: 'Top wallets of a token' },
      { command: 'ws', description: 'Wallet stats' },
      { command: 'rekt', description: 'Liquidations (1h 4h 12h 24h)' },
      { command: 'v', description: 'Convert a token amount to USD' },
      { command: 'help', description: 'All commands' },
    ]).catch((e) => console.error('setMyCommands error:', e.message));
    keepDbWarm();
    hasSharp().then((ok) => console.log(CARD_JPG ? (ok ? 'Pictures: JPG mode (small, fast cards)' : 'Pictures: CARD_FORMAT=jpg needs npm install') : 'Pictures: original quality (PNG, picture untouched)'));
    clearOldCache().finally(() => refillArt());
    setInterval(checkAlerts, 60_000);
    setInterval(checkCalls, 90_000);
    setInterval(checkPaperPositions, 60_000);
    setInterval(checkTargets, 45_000);
    setInterval(checkReminders, 20_000);
    ensureXTables().then(() => setInterval(checkXFeeds, 10_000)).catch((e) => console.error('x tables error:', e.message));
  },
});
