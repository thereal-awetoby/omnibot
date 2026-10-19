import { Bot, InlineKeyboard, InputFile } from 'grammy';
import {
  upsertUser, fetchPairsByTokens, fetchTrending, fetchTokenMarket, esc, formatUsd,
  addWatch, removeWatch, isWatching, listWatches, setAlertPct, listAllWatches, updateWatchBase, removeAllWatches,
  recordFirstCall, getFirstCall, listChatCalls, listUserCalls,
  MAX_WATCHES,
} from '@omnibot/shared';
import {
  parseMintInput, extractMint, looksLikeMint, parseAlertPct, shouldAlert,
  buildScanCard, buildTrendingText, buildWatchlistText, buildAlertText,
  buildCallLine, buildLeaderboard, buildLeaderboardText, buildUserCallsText, buildSocialLine, formatPriceCard, shortPct,
} from './scan.js';
import { startIntel, gatherIntel, within } from './intel.js';
import { getSolBalance, getSolBalances, getHolderTokens, scanCreatedTokens, getCreatorOnChain, getDeployerOnChain, getHoldingPct, getWalletFunding, rpcStats } from './chain.js';
import { loadBubblemap, loadBubbleData } from './bubbleload.js';
import { startMiniApp, buildMapPayload } from './miniapp.js';
import { fetchLoreStory, fetchNews, fetchTweetText, getLastLoreError, searchTokens, fetchDexPaid, fetchPriceSeries, buildChartUrl } from './sources.js';
import { formatDuration } from './scan.js';
import { buildHoldersText, buildDevText, buildLoreText, valueHoldings, mergeLaunches, isAddr } from './detail.js';

if (!process.env.SCAN_BOT_TOKEN) throw new Error('SCAN_BOT_TOKEN is not set');
const bot = new Bot(process.env.SCAN_BOT_TOKEN);

const TRADE_USERNAME = process.env.TRADE_BOT_USERNAME || 'OmniTradeBot';
const LAUNCH_USERNAME = process.env.LAUNCH_BOT_USERNAME || 'OmniLaunchBot';
const HTML = { parse_mode: 'HTML', link_preview_options: { is_disabled: true } };
const tradeLink = (mint) => `https://t.me/${TRADE_USERNAME}?start=buy_${mint}`;
const short = (a) => `${a.slice(0, 4)}…${a.slice(-4)}`;

bot.use(async (ctx, next) => {
  if (ctx.from) await upsertUser({ id: ctx.from.id, username: ctx.from.username });
  await next();
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
  try { m = (await fetchPairsByTokens([mint])).get(mint) ?? null; } catch (e) { console.error('dexscreener error:', e.message); }
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
    const market = await getMarket(mint);
    const { security, intel } = await gatherIntel(mint, market, pre);
    const s1 = rpcStats(); // one line per card, handy when something feels slow
    console.log(`card ${short(mint)} ${Date.now() - t0}ms, rpc calls ${s1.calls - s0.calls}, retried ${s1.retries - s0.retries}`);
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
    group ? false : isWatching(ctx.from.id, mint), // a group card is shared, so no personal ⭐ state there
    group ? callFor(ctx, mint, market, record).catch((e) => { console.error('call error:', e.message); return null; }) : null,
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
  if (!text) {
    try { text = await withTyping(ctx, build); } catch (e) { console.error(`${kind} view error:`, e.message); text = 'Could not load that right now. Try again in a moment.'; }
    if (detailText.size > 300) detailText.delete(detailText.keys().next().value);
    detailText.set(key, { at: now, text });
  }
  const origin = ctx.callbackQuery?.message?.message_id ?? ctx.message?.message_id;
  return ctx.reply(text, {
    ...HTML,
    reply_markup: new InlineKeyboard().text('🗑 Close', 'x'),
    ...(origin ? { reply_parameters: { message_id: origin, allow_sending_without_reply: true } } : {}),
  });
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
  // pump.fun's public list is gone, so read the wallet's own transactions (fast on a Helius RPC).
  const solBalancePromise = getSolBalance(creator);
  const fundingPromise = within(getWalletFunding(creator), 6_000);
  let launches = null;
  let scannedTx = 0;
  try { const r = await scanCreatedTokens(creator); launches = r.launches; scannedTx = r.scannedTx; }
  catch (e) { console.error('dev scan error:', e.message); }
  const source = 'rpc';
  const solBalance = await solBalancePromise;
  const funding = await fundingPromise;
  // This token was made by this wallet, so it always belongs in the list.
  if (!launches?.some((l) => l.mint === mint)) {
    launches = [...(launches ?? []), { mint, createdAt: c.market?.createdAt ?? c.intel.detectedAt ?? null }];
  }
  let markets = new Map();
  try { markets = await fetchPairsByTokens(launches.map((l) => l.mint).slice(0, 30)); } catch (e) { console.error('launch prices error:', e.message); }
  if (c.market) markets.set(mint, c.market);
  return buildDevText({
    market: c.market, creator, creatorFees: stored, funding, devPct, solBalance,
    launches: mergeLaunches(launches, markets, mint), source, scannedTx, partial: true,
  });
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
bot.command('help', (ctx) => ctx.reply(
  'Paste a token address to see its card: stats, safety checks and holder info.\n\nIn a group, the first person to post a token gets the call.\n/leaderboard  /calls  (groups)\n\n/token <address>\n/th <address>  top holders\n/dev <address>  deployer and launches\n/nar <address>  lore (the story)\n/soc <address>  social links\n/dp <address>  DEX Paid\n/p <address>  price\n/bm <address>  bubblemap\n/c <address>  chart\n/s <name>  search a token\n/i  top coins\n/trending\n/watch <address>  (no address: show watchlist)\n/unwatch <address>\n/alerts  (your watchlist)\n/alertpct <number>  (alert size, default 25)\n/trade  /launch'
));
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
bot.command('chart', async (ctx) => {
  const mint = parseMintInput(ctx.match.trim());
  if (!mint) return ctx.reply('Usage: /chart <token address>');
  return sendChart(ctx, mint);
});
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
bot.command('leaderboard', async (ctx) => {
  if (!isGroup(ctx)) return ctx.reply('Leaderboards work in groups. Add me to your group and post token addresses there.');
  const calls = await listChatCalls(ctx.chat.id, { days: 30 });
  const prices = await pricesFor(calls.map((c) => c.mint));
  return ctx.reply(buildLeaderboardText(buildLeaderboard(calls, prices), 30), HTML);
});
bot.command('calls', async (ctx) => {
  if (!isGroup(ctx)) return ctx.reply('Call tracking works in groups. Post a token address in your group to make a call.');
  const calls = await listUserCalls(ctx.chat.id, ctx.from.id, { limit: 10 });
  const prices = await pricesFor(calls.map((c) => c.mint));
  return ctx.reply(buildUserCallsText(calls, prices, callerName(ctx.from)), HTML);
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

bot.catch((err) => console.error('bot error:', err.error?.message ?? err.message));
bot.start({
  onStart: (me) => {
    console.log(`Omni Scan Bot running as @${me.username}`);
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
      { command: 'leaderboard', description: 'Group call leaderboard' },
      { command: 'calls', description: 'Your calls in this group' },
      { command: 'help', description: 'All commands' },
    ]).catch((e) => console.error('setMyCommands error:', e.message));
    setInterval(checkAlerts, 60_000);
  },
});
