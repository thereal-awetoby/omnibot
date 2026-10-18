import { Bot, InlineKeyboard } from 'grammy';
import {
  upsertUser, fetchPairsByTokens, fetchTrending, fetchTokenMarket, esc,
  addWatch, removeWatch, isWatching, listWatches, setAlertPct, listAllWatches, updateWatchBase, removeAllWatches,
  recordFirstCall, getFirstCall, listChatCalls, listUserCalls,
  MAX_WATCHES,
} from '@omnibot/shared';
import {
  parseMintInput, extractMint, looksLikeMint, parseAlertPct, shouldAlert,
  buildScanCard, buildTrendingText, buildWatchlistText, buildAlertText,
  buildCallLine, buildLeaderboard, buildLeaderboardText, buildUserCallsText,
} from './scan.js';
import { startIntel, gatherIntel } from './intel.js';
import { getSolBalance, getSolBalances, getHolderTokens, scanCreatedTokens } from './chain.js';
import { fetchPumpCreated } from './sources.js';
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

const cardKeyboard = (mint, watched) =>
  new InlineKeyboard()
    .url('⚡ Buy on Omni Trade', tradeLink(mint)).row()
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
async function withTyping(ctx, fn) {
  const send = () => ctx.api.sendChatAction(ctx.chat.id, 'typing').catch(() => {});
  send();
  const t = setInterval(send, 4000);
  try { return await fn(); } finally { clearInterval(t); }
}

// Recently built cards, so the Top holders / Dev / Lore buttons answer instantly.
const cardCache = new Map(); // mint -> { at, market, security, intel }
const CARD_TTL_MS = 10 * 60_000;
async function loadCard(mint) {
  const pre = startIntel(mint); // RPC + RugCheck start now, at the same time as the market lookup
  const market = await getMarket(mint);
  const { security, intel } = await gatherIntel(mint, market, pre);
  if (cardCache.size > 200) cardCache.delete(cardCache.keys().next().value);
  const card = { at: Date.now(), market, security, intel };
  cardCache.set(mint, card);
  return card;
}
const cachedCard = async (mint) => {
  const c = cardCache.get(mint);
  return c && Date.now() - c.at < CARD_TTL_MS ? c : loadCard(mint);
};

async function showToken(ctx, mint, { edit = false, record = false } = {}) {
  const group = isGroup(ctx);
  // One complete card, sent once it is ready. No placeholder message.
  const { market, security, intel } = edit ? await loadCard(mint) : await withTyping(ctx, () => loadCard(mint));
  const [watched, call] = await Promise.all([
    group ? false : isWatching(ctx.from.id, mint), // a group card is shared, so no personal ⭐ state there
    group ? callFor(ctx, mint, market, record).catch((e) => { console.error('call error:', e.message); return null; }) : null,
  ]);
  const callLine = buildCallLine(call, market?.priceUsd);
  const kb = cardKeyboard(mint, watched);
  // The token's banner (or logo) shows above the text, like Rick does.
  const previewUrl = market?.headerUrl || market?.imageUrl || null;
  const preview = previewUrl ? { link_preview_options: { url: previewUrl, show_above_text: true, prefer_large_media: true } } : {};
  const reply = group && !edit && ctx.message ? { reply_parameters: { message_id: ctx.message.message_id, allow_sending_without_reply: true } } : {};
  const text = buildScanCard({ mint, market, security, intel, callLine, watched });
  return render(ctx, text, kb, edit, edit ? preview : { ...preview, ...reply });
}

// ---- detail views: Top holders, Dev, Lore. Each answers as a new message under the card. ----
const detailText = new Map(); // `${kind}:${mint}` -> { at, text }
const DETAIL_TTL_MS = 2 * 60_000;
const lastDetailAt = new Map(); // userId -> timestamp
async function showDetail(ctx, kind, mint, build) {
  await ctx.answerCallbackQuery().catch(() => {});
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
  const origin = ctx.callbackQuery?.message?.message_id;
  return ctx.reply(text, {
    ...HTML,
    reply_markup: new InlineKeyboard().text('🗑 Close', 'x'),
    ...(origin ? { reply_parameters: { message_id: origin, allow_sending_without_reply: true } } : {}),
  });
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
  const creator = c.intel.creator;
  if (!creator) return buildDevText({ market: c.market, creator: null });
  const [solBalance, pumpList] = await Promise.all([getSolBalance(creator), fetchPumpCreated(creator)]);
  let launches = pumpList;
  let source = pumpList ? 'pump' : null;
  let scannedTx = 0;
  if (!pumpList) {
    try { const r = await scanCreatedTokens(creator); launches = r.launches; scannedTx = r.scannedTx; source = 'rpc'; }
    catch (e) { console.error('dev scan error:', e.message); launches = null; }
  }
  let markets = new Map();
  if (launches?.length) { try { markets = await fetchPairsByTokens(launches.map((l) => l.mint).slice(0, 30)); } catch (e) { console.error('launch prices error:', e.message); } }
  return buildDevText({
    market: c.market, creator, devPct: c.intel.devPct, solBalance,
    launches: launches ? mergeLaunches(launches, markets, mint) : null, source, scannedTx,
  });
}

const buildLore = async (mint) => {
  const c = await cachedCard(mint);
  return buildLoreText({ market: c.market, meta: c.intel.meta, detectedAt: c.intel.detectedAt });
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
  'Paste a token address to see its card: stats, safety checks and holder info.\n\nIn a group, the first person to post a token gets the call.\n/leaderboard  /calls  (groups)\n\n/token <address>\n/chart <address>\n/trending\n/watch <address>  (no address: show watchlist)\n/unwatch <address>\n/alerts  (your watchlist)\n/alertpct <number>  (alert size, default 25)\n/trade  /launch'
));
bot.command('token', async (ctx) => {
  const mint = parseMintInput(ctx.match.trim());
  if (!mint) return ctx.reply('Usage: /token <token address>');
  return showToken(ctx, mint);
});
bot.command('chart', async (ctx) => {
  const mint = parseMintInput(ctx.match.trim());
  if (!mint) return ctx.reply('Usage: /chart <token address>');
  return ctx.reply('Open the live chart:', {
    reply_markup: new InlineKeyboard().url('📈 DexScreener', `https://dexscreener.com/solana/${mint}`).url('🔍 Solscan', `https://solscan.io/token/${mint}`),
  });
});
bot.command('trending', (ctx) => showTrending(ctx));
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
bot.callbackQuery(new RegExp(`^h:${MINT}$`), (ctx) => showDetail(ctx, 'h', ctx.match[1], () => buildHolders(ctx.match[1])));
bot.callbackQuery(new RegExp(`^d:${MINT}$`), (ctx) => showDetail(ctx, 'd', ctx.match[1], () => buildDev(ctx.match[1])));
bot.callbackQuery(new RegExp(`^l:${MINT}$`), (ctx) => showDetail(ctx, 'l', ctx.match[1], () => buildLore(ctx.match[1])));
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
    setInterval(checkAlerts, 60_000);
  },
});
