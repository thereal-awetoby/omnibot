import dns from 'node:dns';
import { Bot, InlineKeyboard, InputFile } from 'grammy';
import {
  upsertUser, fetchPairsByTokens, fetchTrending, fetchTokenMarket, esc, formatUsd,
  addWatch, removeWatch, isWatching, listWatches, setAlertPct, listAllWatches, updateWatchBase, removeAllWatches,
  recordFirstCall, getFirstCall, addTargets, listTargets, removeTargets, listActiveTargets, markTargetFired, addReminder, listReminders, removeReminder, dueReminders, markReminderDone, listChatCalls, listUserCalls, listLiveCalls, setCallMilestone, setCallPeak, keepDbWarm,
  MAX_WATCHES,
} from '@omnibot/shared';
import {
  parseMintInput, extractMint, looksLikeMint, parseAlertPct, shouldAlert,
  buildScanCard, buildTrendingText, buildWatchlistText, buildAlertText,
  multiple, buildCallLine, buildLeaderboard, buildLeaderboardText, parsePeriod, buildGroupBoard, buildGroupBoardText, buildUserCallsText, buildSocialLine, formatPriceCard, formatCount, shortPct,
} from './scan.js';
import { startIntel, gatherIntel, within, hedge } from './intel.js';
import { getSolBalance, getSolBalances, getHolderTokens, scanCreatedTokens, getCreatorOnChain, getDeployerOnChain, getHoldingPct, getWalletFunding, scanDevLaunches, getTokenNames, getTokenImage, rpcStats } from './chain.js';
import { loadBubblemap, loadBubbleData } from './bubbleload.js';
import { renderPng, renderRaw } from './bubblemap.js';
import { getArt, getMeme, refillArt, clearOldCache, OWN_DIR, sniffMime } from './memeart.js';
import { buildCandleSvg, defaultTf, parseTf, TFS } from './chartimg.js';
import { shrinkArt, cardToJpeg, rawToJpeg, hasSharp } from './imgfast.js';
import { buildMyCallsText, buildFcText, buildLastText, buildTargetSetText, buildTargetsText, buildTargetHitText, buildReminderSetText, buildRemindersText, buildReminderFiredText, buildConvertText, buildEpochText, buildIdText, buildHelpText, fmtX } from './ux.js';
import { mkdir, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { buildPnlSvg, buildPnlCaption, newMilestone, peakMultiple } from './pnlcard.js';
import { startMiniApp, buildMapPayload } from './miniapp.js';
import { fetchLoreStory, fetchNews, fetchTweetText, getLastLoreError, searchTokens, fetchDexPaid, fetchPriceSeries, buildChartUrl, fetchPeakSince, fetchCandles, generateText } from './sources.js';
import { formatDuration } from './scan.js';
import { parseTargets, targetLabel, targetHit, parseDelay, analyzeCloses, buildTaText, TA_FRAMES, fetchCloses, isPublicUrl, stripHtml, parseTranslate, normPeriod, fetchTopCoins, buildHeatmapSvg, buildMoversText, fetchPolymarket, buildPolymarketText, parseAmount, parseEpoch, csvCell } from './extras.js';
import { buildHoldersText, buildDevText, buildLoreText, valueHoldings, mergeLaunches, isAddr } from './detail.js';

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

const homeKeyboard = () =>
  new InlineKeyboard()
    .text('🔥 Trending', 'trend').text('⭐ Watchlist', 'wl').row()
    .url('Omni Trade', `https://t.me/${TRADE_USERNAME}`).url('Omni Launch', `https://t.me/${LAUNCH_USERNAME}`);

const showHome = (ctx) => ctx.reply(
  'Omni Scan Bot\n\nResearch only: no wallet, no trading here.\nPaste a token address to see its card, or tap below.',
  { reply_markup: homeKeyboard() }
);

// One token's market data: DexScreener first, pump.fun as a fallback for very new tokens.
async function getMarket(mint) {
  let m = null;
  try { m = (await hedge(() => fetchPairsByTokens([mint]), 1_800)).get(mint) ?? null; } catch (e) { console.error('dexscreener error:', e.message); }
  if (m) return m;
  try {
    const f = await fetchTokenMarket(mint);
    if (f) return { mint, ...f, volume24h: null, change1h: null, change24h: null };
  } catch (e) { console.error('fallback market error:', e.message); }
  return null;
}

// Bubblemap: with MINIAPP_URL set, private chats open our interactive map inside Telegram (hover, tap, copy).
// Telegram only allows mini-app buttons in private chats; groups get the picture instead. The Bubblemaps.io link stays as an extra.
const MINIAPP_URL = (process.env.MINIAPP_URL || '').trim().replace(/\/+$/, '');
const miniMapUrl = (mint) => `${MINIAPP_URL}/map?mint=${mint}`;
const bubbleUrl = (mint) => `https://v2.bubblemaps.io/map?address=${mint}`;
const bubbleButton = (kb, mint, group = false) => (MINIAPP_URL && !group ? kb.webApp('🫧 Bubblemap', miniMapUrl(mint)) : kb.text('🫧 Bubblemap', `b:${mint}`));

// Data for the mini app: the same holders, funding groups and layout as the picture.
async function loadMapData(mint) {
  const card = await cachedCard(mint);
  const loaded = await loadBubbleData(mint, card);
  return loaded ? buildMapPayload({ symbol: card.market?.symbol ?? null, name: card.market?.name ?? null, market: card.market ?? null, loaded }) : null;
}

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
      priceUsd: market.priceUsd, mcapUsd: market.marketCapUsd,
    });
    return r.call;
  }
  return getFirstCall(ctx.chat.id, mint);
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

// The bubblemap: one picture of the biggest holders and which of them were funded by the same wallet.
async function sendBubblemap(ctx, mint) {
  if (ctx.callbackQuery) await ctx.answerCallbackQuery().catch(() => {});
  const now = Date.now();
  if (now - (lastDetailAt.get(ctx.from.id) ?? 0) < 1500) return; // ignore rapid repeat taps
  lastDetailAt.set(ctx.from.id, now);
  let result = null;
  try { result = await withTyping(ctx, async () => loadBubblemap(mint, await cachedCard(mint)), 'upload_photo'); }
  catch (e) { console.error('bubblemap error:', e.message); }
  const origin = ctx.callbackQuery?.message?.message_id ?? ctx.message?.message_id;
  const reply = origin ? { reply_parameters: { message_id: origin, allow_sending_without_reply: true } } : {};
  const site = new InlineKeyboard().url('🌐 Bubblemaps.io', bubbleUrl(mint)).text('🗑 Close', 'x');
  const interactive = MINIAPP_URL ? (isGroup(ctx) ? [['url', '🫧 Interactive map', miniMapUrl(mint)]] : [['web', '🫧 Interactive map', miniMapUrl(mint)]]) : [];
  if (!result) return ctx.reply('Could not build the bubblemap right now (holder data was not available). Try again in a moment.', { ...reply, reply_markup: site });
  const kb = new InlineKeyboard();
  for (const [type, label, url] of interactive) { if (type === 'web') kb.webApp(label, url); else kb.url(label, url); kb.row(); }
  kb.text('👥 Top holders', `h:${mint}`).text('👨‍💻 Dev', `d:${mint}`).row().url('🌐 Bubblemaps.io', bubbleUrl(mint)).text('🗑 Close', 'x');
  try {
    return await ctx.replyWithPhoto(new InputFile(result.png, 'bubblemap.png'), { caption: result.caption, parse_mode: 'HTML', reply_markup: kb, ...reply });
  } catch (e) {
    console.error('bubblemap send error:', e.message);
    return ctx.reply('Could not send the bubblemap image. Try again in a moment.', { ...reply, reply_markup: site });
  }
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

async function doWatch(ctx, mint, { edit = false } = {}) {
  const market = await getMarket(mint);
  if (!market?.priceUsd) return ctx.reply('No price found for that token yet, so I cannot watch it.');
  const r = await addWatch({ telegramId: ctx.from.id, mint, symbol: market.symbol, priceUsd: market.priceUsd });
  if (r === 'full') return ctx.reply(`Your watchlist is full (${MAX_WATCHES} tokens). Remove one with /unwatch first.`);
  await ctx.answerCallbackQuery?.({ text: r === 'added' ? 'Added to watchlist' : 'Already on your watchlist' }).catch(() => {});
  if (!edit) await ctx.reply(r === 'added' ? `⭐ Watching ${market.symbol ? '$' + esc(market.symbol) : short(mint)}. I will message you on big moves.` : 'Already on your watchlist.', HTML);
  else await showToken(ctx, mint, { edit: true });
}

async function doUnwatch(ctx, mint, { edit = false } = {}) {
  const removed = await removeWatch(ctx.from.id, mint);
  await ctx.answerCallbackQuery?.({ text: removed ? 'Removed' : 'Not on your watchlist' }).catch(() => {});
  if (!edit) return ctx.reply(removed ? 'Removed from your watchlist.' : 'That token is not on your watchlist.');
  return showToken(ctx, mint, { edit: true });
}

bot.command('start', showHome);
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
bot.command('bm', withMint('/bm', (ctx, mint) => (MINIAPP_URL && !isGroup(ctx)
  ? ctx.reply('Bubblemap: tap to open the interactive map.', { reply_markup: new InlineKeyboard().webApp('🫧 Open Bubblemap', miniMapUrl(mint)).row().text('🖼 Picture instead', `b:${mint}`) })
  : sendBubblemap(ctx, mint))));
bot.command('bubblemap', withMint('/bubblemap', (ctx, mint) => sendBubblemap(ctx, mint)));
bot.command('th', withMint('/th', (ctx, mint) => showDetail(ctx, 'h', mint, () => buildHolders(mint))));
bot.command('dev', withMint('/dev', (ctx, mint) => showDetail(ctx, 'd', mint, () => buildDev(mint))));
bot.command('nar', withMint('/nar', (ctx, mint) => showDetail(ctx, 'l', mint, () => buildLore(mint, ctx.from.id))));
bot.command('lore', withMint('/lore', (ctx, mint) => showDetail(ctx, 'l', mint, () => buildLore(mint, ctx.from.id))));
bot.command('soc', withMint('/soc', async (ctx, mint) => {
  const m = await withTyping(ctx, () => getMarket(mint));
  if (!m) return ctx.reply('No market data found for that token yet.');
  return ctx.reply(`${m.symbol ? '$' + esc(m.symbol) : short(mint)}\n${buildSocialLine(m)}`, HTML);
}));
bot.command('dp', withMint('/dp', async (ctx, mint) => {
  const [m, paid] = await withTyping(ctx, () => Promise.all([getMarket(mint), fetchDexPaid(mint)]));
  if (!m) return ctx.reply('No market data found for that token yet.');
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
  if (!list.length) return ctx.reply('No Solana token found for that name.');
  const kb = new InlineKeyboard();
  list.forEach((t, i) => { kb.text(`${t.symbol ? '$' + t.symbol : short(t.mint)}${t.marketCapUsd ? ' · ' + formatUsd(t.marketCapUsd) : ''}`, `t:${t.mint}`); if (i % 2 === 1) kb.row(); });
  return ctx.reply(`Results for "${esc(q)}": tap one for its card.`, { ...HTML, reply_markup: kb });
});
bot.command('p', withMint('/p', async (ctx, mint) => {
  const m = await withTyping(ctx, () => getMarket(mint));
  if (!m?.priceUsd) return ctx.reply('No price found for that token yet.');
  const d = m.change?.h24 ?? m.change24h;
  return ctx.reply(`${m.symbol ? '$' + esc(m.symbol) : short(mint)}  <b>${formatPriceCard(m.priceUsd)}</b>${d != null ? `  (${shortPct(d)} 24h)` : ''}`, HTML);
}));
bot.command('watch', async (ctx) => {
  const arg = ctx.match.trim();
  if (!arg) return showWatchlist(ctx);
  const mint = parseMintInput(arg);
  if (!mint) return ctx.reply('Usage: /watch <token address>');
  return doWatch(ctx, mint);
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
async function pricesFor(mints) {
  try { return await fetchPairsByTokens([...new Set(mints)]); } catch (e) { console.error('prices error:', e.message); return new Map(); }
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
bot.command(['calls', 'groupme'], async (ctx) => {
  if (!isGroup(ctx)) return ctx.reply('Call tracking works in groups. Post a token address in your group to make a call.');
  const calls = await listUserCalls(ctx.chat.id, ctx.from.id, { limit: 20 });
  const prices = await pricesFor(calls.map((c) => c.mint));
  return ctx.reply(buildMyCallsText(calls, prices, callerName(ctx.from)), { ...HTML, link_preview_options: { is_disabled: true }, reply_markup: new InlineKeyboard().text('🗑', 'x') });
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
  const sent = await ctx.replyWithPhoto(new InputFile(r.png, r.name), { caption: buildPnlCaption({ symbol: call.symbol, callerName: call.caller_name, x: r.x }), parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('🗑', 'x') });
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
  const p = (await pricesFor([mint])).get(mint);
  const best = Math.max(0, Number(c.peak_price_usd) || 0, p?.priceUsd || 0);
  const roi = p?.priceUsd && c.price_usd ? p.priceUsd / c.price_usd : null;
  const athX = best && c.price_usd ? Math.max(1, best / c.price_usd) : null;
  return ctx.reply(buildFcText({ call: c, nowMcap: p?.marketCapUsd ?? null, roi, athX }), { ...HTML, reply_markup: new InlineKeyboard().text('📸 PnL card', `pnl:${mint}`).text('🗑', 'x') });
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
  if (!m?.priceUsd) return ctx.reply('No price found for that token yet.');
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
  if (!m?.priceUsd) return ctx.reply('No price found for that token yet.');
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

bot.on('message:text', async (ctx) => {
  const text = ctx.message.text;
  if (text.startsWith('/')) return;
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
async function checkAlerts() {
  if (checking) return;
  checking = true;
  try {
    const rows = await listAllWatches();
    if (!rows.length) return;
    const prices = await fetchPairsByTokens(rows.map((r) => r.mint));
    for (const r of rows) {
      const price = prices.get(r.mint)?.priceUsd;
      if (!price || !shouldAlert(r.base_price_usd, price, r.alert_pct)) continue;
      try {
        await bot.api.sendMessage(r.telegram_id, buildAlertText(r, price), {
          ...HTML,
          reply_markup: new InlineKeyboard().text('Open card', `t:${r.mint}`).url('⚡ Buy on Omni Trade', tradeLink(r.mint)),
        });
        await updateWatchBase(r.telegram_id, r.mint, price); // next alert measures from here
      } catch (e) {
        if (e.error_code === 403) await removeAllWatches(r.telegram_id); // user blocked the bot
        else console.error('alert send error:', e.message);
      }
      await new Promise((res) => setTimeout(res, 50)); // stay well under Telegram's send limits
    }
  } catch (e) {
    console.error('alert check error:', e.message);
  } finally {
    checking = false;
  }
}

// Posts a card in the group when a call reaches 2x, 3x, 5x, 10x... (each one once).
let checkingCalls = false;
async function checkCalls() {
  if (checkingCalls) return;
  checkingCalls = true;
  try {
    const rows = await listLiveCalls({ days: 7 });
    if (!rows.length) return;
    const prices = await fetchPairsByTokens([...new Set(rows.map((r) => r.mint))]);
    for (const r of rows) {
      const price = prices.get(r.mint)?.priceUsd;
      // announcements follow the HIGHEST price seen, so a quick pump is not missed between two checks
      const peakPrice = Math.max(Number(r.peak_price_usd) || 0, price || 0);
      if (price > (Number(r.peak_price_usd) || 0)) setCallPeak(r.chat_id, r.mint, price).catch(() => {});
      const x = multiple(r.price_usd, peakPrice);
      const m = newMilestone(r.last_x, x);
      if (!m) continue;
      r.peak_price_usd = peakPrice;
      await setCallMilestone(r.chat_id, r.mint, m); // first, so a failed send never repeats
      try {
        const title = (await bot.api.getChat(r.chat_id).catch(() => null))?.title;
        const card = await pnlPng(r, prices, title, { skipHistory: true });
        if (!card) continue;
        await bot.api.sendPhoto(r.chat_id, new InputFile(card.png, card.name), { caption: buildPnlCaption({ symbol: r.symbol, callerName: r.caller_name, x: card.x, milestone: true }), parse_mode: 'HTML' });
      } catch (e) { console.error('multiplier post error:', e.message); }
      await new Promise((res) => setTimeout(res, 100));
    }
  } catch (e) {
    console.error('call check error:', e.message);
  } finally {
    checkingCalls = false;
  }
}

bot.catch((err) => console.error('bot error:', err.error?.message ?? err.message));
bot.start({
  onStart: (me) => {
    console.log(`Omni Scan Bot running as @${me.username}`);
    console.log(me.can_read_all_group_messages
      ? 'Groups: I can read every message (Group Privacy is off).'
      : 'Groups: Group Privacy is ON, so I only see /commands in groups. Turn it off in BotFather, then remove me from the group and add me again.');
    if (MINIAPP_URL) startMiniApp({ port: Number(process.env.MINIAPP_PORT) || 3000, loadData: loadMapData });
    else console.log('Bubblemap mini app: off (set MINIAPP_URL to turn it on). The picture version is used.');
    console.log(`RPC endpoints: ${rpcStats().endpoints.map((e) => e.host).join(', ')}`);
    console.log(`Lore AI: ${[process.env.ANTHROPIC_API_KEY ? 'Claude' : null, process.env.GEMINI_API_KEY ? 'Gemini' : null].filter(Boolean).join(' + ') || 'off (shows the token description and news only)'}`);
    // The menu next to the message box.
    bot.api.setMyCommands([
      { command: 'token', description: 'Token card (paste an address)' },
      { command: 'th', description: 'View the top holders' },
      { command: 'dev', description: 'View deployer & deployed coins' },
      { command: 'nar', description: 'Get the narrative (lore) of a token' },
      { command: 'soc', description: 'Get social media links' },
      { command: 'dp', description: 'Check DEX Paid status' },
      { command: 'p', description: 'Simple price query' },
      { command: 'bm', description: 'View the bubblemap' },
      { command: 'c', description: 'Open a chart' },
      { command: 's', description: 'Search for a token' },
      { command: 'i', description: 'Get top coins' },
      { command: 'trending', description: 'View trending tokens' },
      { command: 'watch', description: 'Your watchlist / watch a token' },
      { command: 'leaderboard', description: 'Group leaderboard (1h, 1 week, all...)' },
      { command: 'calls', description: 'Your calls in this group' },
      { command: 'pnl', description: 'PnL card of a call (groups)' },
      { command: 'meme', description: 'A random crypto meme' },
      { command: 'hm', description: 'Crypto heatmap' },
      { command: 'best', description: 'Top gainers' },
      { command: 'worst', description: 'Top losers' },
      { command: 'fc', description: 'Who called a token first (groups)' },
      { command: 'last', description: 'Last calls in the group' },
      { command: 'ta', description: 'Technical read of a token' },
      { command: 'target', description: 'Alert me at 3x, 4x, -50%...' },
      { command: 'chart', description: 'Candlestick chart (1m 5m 1h...)' },
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
      { command: 'v', description: 'Convert a token amount to USD' },
      { command: 'help', description: 'All commands' },
    ]).catch((e) => console.error('setMyCommands error:', e.message));
    keepDbWarm();
    hasSharp().then((ok) => console.log(CARD_JPG ? (ok ? 'Pictures: JPG mode (small, fast cards)' : 'Pictures: CARD_FORMAT=jpg needs npm install') : 'Pictures: original quality (PNG, picture untouched)'));
    clearOldCache().finally(() => refillArt());
    setInterval(checkAlerts, 60_000);
    setInterval(checkCalls, 90_000);
    setInterval(checkTargets, 45_000);
    setInterval(checkReminders, 20_000);
  },
});
