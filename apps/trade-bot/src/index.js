import { Bot, InlineKeyboard } from 'grammy';
import {
  upsertUser, getTradeWallet, listTradeWallets, saveTradeWallet, setActiveWallet, renameWallet,
  encryptSecret, decryptSecret, normalizeName, isValidName, esc,
} from '@omnibot/shared';
import {
  createWallet, parseImport, secretToBase58, keypairFromBytes, getSolBalance,
  isValidAddress, getMintInfo, getPumpCurve, getPumpInitialRealTokens,
} from './wallet.js';
import { solToLamports, fetchQuote, hasRoute, summarizeQuote } from './jupiter.js';
import { parseTokenInput, fetchTokenMarket, buildTokenCard, liquidityFromCurve, solUsdFromQuote, curveProgress } from './token.js';

if (!process.env.TRADE_BOT_TOKEN) throw new Error('TRADE_BOT_TOKEN is not set');
const bot = new Bot(process.env.TRADE_BOT_TOKEN);

// Users currently being asked to paste a key/seed. In-memory is fine for now.
const awaitingImport = new Set();
// Users currently being asked for a new wallet name: userId -> walletId.
const awaitingRename = new Map();
// Users typing a custom buy amount or slippage: userId -> { kind: 'amount' | 'slippage', mint }.
const awaitingCustom = new Map();

const MAX_WALLETS = 10;
const SCAN_USERNAME = process.env.SCAN_BOT_USERNAME || 'OmniScanBot';
const LAUNCH_USERNAME = process.env.LAUNCH_BOT_USERNAME || 'OmniLaunchBot';

// Telegram monospace text: tap (or click) to copy.
const code = (s) => `<code>${s}</code>`;
const HTML = { parse_mode: 'HTML' };
const short = (a) => `${a.slice(0, 4)}…${a.slice(-4)}`;

const noWalletKeyboard = () =>
  new InlineKeyboard().text('Create wallet', 'create').text('Import wallet', 'import');

const mainKeyboard = () =>
  new InlineKeyboard()
    .text('Balance', 'balance').text('Deposit', 'deposit').row()
    .text('Wallets', 'wallets').text('Export key', 'exportkey').row()
    .url('Omni Scan', `https://t.me/${SCAN_USERNAME}`)
    .url('Omni Launch', `https://t.me/${LAUNCH_USERNAME}`);

bot.use(async (ctx, next) => {
  if (ctx.from) {
    await upsertUser({ id: ctx.from.id, username: ctx.from.username });
    // Running any /command cancels a pending "paste your key" prompt.
    if (ctx.message?.text?.startsWith('/')) {
      awaitingImport.delete(ctx.from.id);
      awaitingRename.delete(ctx.from.id);
      awaitingCustom.delete(ctx.from.id);
    }
  }
  await next();
});

async function showHome(ctx) {
  const w = await getTradeWallet(ctx.from.id);
  if (!w) {
    return ctx.reply(
      'Welcome to Omni Trade Bot.\n\nYou need a wallet to trade. Create a new one or import an existing one.',
      { reply_markup: noWalletKeyboard() }
    );
  }
  return ctx.reply(
    `Omni Trade Bot\n\nActive wallet: ${esc(w.label)}\n${code(w.public_key)} (tap to copy)`,
    { ...HTML, reply_markup: mainKeyboard() }
  );
}

async function showWallets(ctx) {
  const list = await listTradeWallets(ctx.from.id);
  if (list.length === 0) {
    return ctx.reply('No wallets yet.', { reply_markup: noWalletKeyboard() });
  }
  const text =
    'Your wallets (tap a button to switch):\n\n' +
    list.map((w) => `${w.is_active ? '✅' : '▫️'} ${esc(w.label)}\n${code(w.public_key)}`).join('\n\n');
  const kb = new InlineKeyboard();
  for (const w of list) {
    kb.text(`${w.is_active ? '✅ ' : ''}${w.label} · ${short(w.public_key)}`, `sel:${w.id}`).row();
  }
  kb.text('+ Create new', 'create').text('+ Import', 'import').row()
    .text('✏️ Rename wallet', 'renamepick').text('Back', 'home');
  return ctx.reply(text, { ...HTML, reply_markup: kb });
}

async function walletCapReached(ctx) {
  const list = await listTradeWallets(ctx.from.id);
  if (list.length >= MAX_WALLETS) {
    await ctx.reply(`You can have up to ${MAX_WALLETS} wallets.`);
    return true;
  }
  return false;
}

async function doCreate(ctx) {
  if (await walletCapReached(ctx)) return;
  const kp = createWallet();
  const label = await saveTradeWallet({
    telegramId: ctx.from.id,
    publicKey: kp.publicKey.toBase58(),
    encryptedSecret: encryptSecret(Buffer.from(kp.secretKey)),
    source: 'created',
  });
  const msg = await ctx.reply(
    `${esc(label)} created and set as active.\n\nAddress (tap to copy):\n${code(kp.publicKey.toBase58())}\n\nPrivate key (tap to copy, shown once, save it now):\n${code(secretToBase58(kp))}\n\nThis message deletes itself in 60 seconds. Never share the key.`,
    HTML
  );
  setTimeout(() => ctx.api.deleteMessage(msg.chat.id, msg.message_id).catch(() => {}), 60_000);
  return showHome(ctx);
}

async function startImport(ctx) {
  if (await walletCapReached(ctx)) return;
  awaitingRename.delete(ctx.from.id);
  awaitingCustom.delete(ctx.from.id);
  awaitingImport.add(ctx.from.id);
  return ctx.reply('Paste your private key (base58 or JSON array) or 12/24-word seed phrase. Your message will be deleted right away.');
}

async function showRenamePicker(ctx) {
  const list = await listTradeWallets(ctx.from.id);
  if (list.length === 0) return ctx.reply('No wallets yet.', { reply_markup: noWalletKeyboard() });
  const kb = new InlineKeyboard();
  for (const w of list) kb.text(`${w.label} · ${short(w.public_key)}`, `ren:${w.id}`).row();
  kb.text('Back', 'wallets');
  return ctx.reply('Which wallet do you want to rename?', { reply_markup: kb });
}

function startRename(ctx, wallet) {
  awaitingImport.delete(ctx.from.id);
  awaitingCustom.delete(ctx.from.id);
  awaitingRename.set(ctx.from.id, wallet.id);
  return ctx.reply(
    `Send the new name for ${esc(wallet.label)}.\n1-20 characters: letters, numbers, spaces, - _ .\nSend any /command to cancel.`,
    HTML
  );
}

// Returns true when finished (success or wallet gone), false when the user should try again.
async function applyRename(ctx, walletId, raw) {
  const name = normalizeName(raw);
  if (!isValidName(name)) {
    await ctx.reply('Names must be 1-20 characters: letters, numbers, spaces, - _ . only. Try again.');
    return false;
  }
  try {
    if (!(await renameWallet(ctx.from.id, walletId, name))) {
      await ctx.reply('Wallet not found.');
      return true;
    }
  } catch (err) {
    if (err.code === '23505') {
      await ctx.reply('You already have a wallet with that name. Try another.');
      return false;
    }
    throw err;
  }
  await ctx.reply(`Renamed to ${esc(name)}.`, HTML);
  await showWallets(ctx);
  return true;
}

const lastCardAt = new Map(); // userId -> timestamp, simple per-user cooldown
const prefs = new Map(); // userId -> { amount: '0.1', slippageBps: 1000 }, in memory
const symbols = new Map(); // mint -> symbol, remembered from the last card shown
const DEFAULT_PREFS = { amount: '0.1', slippageBps: 1000 };
const AMOUNT_PRESETS = ['0.05', '0.1', '0.2', '0.3', '0.5'];
const SLIPPAGE_PRESETS = [100, 500, 1000]; // basis points: 1%, 5%, 10%
const GAS_BUFFER_SOL = 0.01;

const getPrefs = (userId) => prefs.get(userId) ?? { ...DEFAULT_PREFS };
const setPrefs = (userId, patch) => prefs.set(userId, { ...getPrefs(userId), ...patch });
const pct = (bps) => `${bps / 100}%`;

function tokenKeyboard(mint, p, walletLabel) {
  const customAmount = !AMOUNT_PRESETS.includes(p.amount);
  const kb = new InlineKeyboard()
    .text('← Home', 'home').text('↻ Refresh', `q:${mint}`).row()
    .text('✅ Swap', 'soon:swap').text('Limit order', 'soon:limit').row();
  AMOUNT_PRESETS.forEach((a, i) => {
    kb.text(`${a === p.amount ? '✅ ' : ''}${a} SOL`, `a:${a}:${mint}`);
    if (i === 2) kb.row();
  });
  kb.text(customAmount ? `✅ ${p.amount} SOL ✏️` : '✏️ Custom', `xa:${mint}`).row();
  for (const bps of SLIPPAGE_PRESETS) kb.text(`${bps === p.slippageBps ? '✅ ' : ''}${pct(bps)}`, `s:${bps}:${mint}`);
  kb.text(SLIPPAGE_PRESETS.includes(p.slippageBps) ? '✏️ Slippage' : `✅ ${pct(p.slippageBps)} ✏️`, `xs:${mint}`).row();
  kb.url('📈 Chart', `https://dexscreener.com/solana/${mint}`).url('🔍 Solscan', `https://solscan.io/token/${mint}`).row();
  kb.text(`💼 ${walletLabel ?? 'No wallet'}`, 'wallets').row();
  kb.text(`⚡ BUY ${p.amount} SOL`, `buy:${mint}`);
  return kb;
}

// Pulls the mint info with one retry: the free public RPC sometimes says "busy".
async function getMintInfoRetry(mint) {
  try { return await getMintInfo(mint); } catch (err) {
    if (err.message === 'That address is not a token mint') throw err;
    await new Promise((r) => setTimeout(r, 700));
    return getMintInfo(mint);
  }
}

// Read-only token card: market data + a real Jupiter quote. Nothing is bought or signed.
async function showToken(ctx, mint, amountInput, { edit = false } = {}) {
  if (!isValidAddress(mint)) return ctx.reply('That does not look like a valid token address.');
  const p = getPrefs(ctx.from.id);
  const amount = amountInput ?? p.amount;
  let lamports;
  try { lamports = solToLamports(amount); } catch (e) { return ctx.reply(e.message); }

  if (!edit) {
    const now = Date.now();
    if (now - (lastCardAt.get(ctx.from.id) ?? 0) < 1500) return ctx.reply('Slow down a little, try again in a moment.');
    lastCardAt.set(ctx.from.id, now);
  }
  setPrefs(ctx.from.id, { amount });

  const w = await getTradeWallet(ctx.from.id);
  const [mintR, mktR, balR, orderR, curveR, initR] = await Promise.allSettled([
    getMintInfoRetry(mint),
    fetchTokenMarket(mint),
    w ? getSolBalance(w.public_key) : Promise.resolve(null),
    fetchQuote({ outputMint: mint, lamports, apiKey: process.env.JUPITER_API_KEY }),
    getPumpCurve(mint),
    getPumpInitialRealTokens(),
  ]);
  const curve = curveR.status === 'fulfilled' ? curveR.value : null;
  if (curveR.status === 'rejected') console.error('pump curve error:', curveR.reason?.message);

  if (mintR.status === 'rejected') {
    console.error('mint info error:', mintR.reason?.message);
    const notToken = mintR.reason?.message === 'That address is not a token mint';
    return ctx.reply(notToken
      ? 'That address is not a token mint (it may be a wallet). Paste a token contract address.'
      : 'Could not read that token right now (the Solana RPC is busy). Paste it again in a few seconds.');
  }

  let quote = null;
  let quoteError = null;
  if (orderR.status === 'fulfilled') {
    if (hasRoute(orderR.value)) quote = summarizeQuote(orderR.value, mintR.value.decimals);
    else quoteError = 'no route (no liquidity, or not tradable yet)';
  } else {
    const e = orderR.reason;
    console.error('quote error:', e.status ?? '', e.message);
    quoteError = e.status === 429 ? 'Jupiter is busy, tap Refresh'
      : e.status === 401 || e.status === 403 ? 'Jupiter needs an API key (JUPITER_API_KEY in .env)'
      : e.message;
  }

  let market = mktR.status === 'fulfilled' ? mktR.value : null;
  // Still no liquidity (typical for pump.fun tokens): work it out from the bonding curve on-chain.
  if (market && market.liquidityUsd == null && curve) {
    const solUsd = market.solUsd ?? (orderR.status === 'fulfilled'
      ? solUsdFromQuote({ priceUsd: market.priceUsd, outAmount: orderR.value.outAmount, decimals: mintR.value.decimals, amountSol: amount })
      : null);
    const liq = liquidityFromCurve(curve, solUsd);
    if (liq != null) market = { ...market, liquidityUsd: liq };
  }
  if (market?.symbol) symbols.set(mint, market.symbol);
  const text = buildTokenCard({
    mint,
    market,
    mintInfo: mintR.value,
    wallet: w,
    balance: balR.status === 'fulfilled' ? balR.value : null,
    amount,
    slippageBps: p.slippageBps,
    progress: curveProgress(curve, initR.status === 'fulfilled' ? initR.value : undefined),
    quote,
    quoteError,
  });
  const opts = { ...HTML, link_preview_options: { is_disabled: true }, reply_markup: tokenKeyboard(mint, getPrefs(ctx.from.id), w?.label) };
  if (edit) {
    try { return await ctx.editMessageText(text, opts); }
    catch (err) { if (/not modified/i.test(err.message)) return; throw err; }
  }
  return ctx.reply(text, opts);
}

// Step before any real buy: show exactly what will happen and ask for a second tap.
async function showBuyConfirm(ctx, mint) {
  const w = await getTradeWallet(ctx.from.id);
  if (!w) { await ctx.answerCallbackQuery({ text: 'Create a wallet first (/start).', show_alert: true }); return; }
  const p = getPrefs(ctx.from.id);
  const bal = await getSolBalance(w.public_key);
  if (bal < Number(p.amount) + GAS_BUFFER_SOL) {
    await ctx.answerCallbackQuery({
      text: `Insufficient balance. You have ${bal.toFixed(4)} SOL; need ${p.amount} SOL + gas. Use Deposit to add SOL.`,
      show_alert: true,
    });
    return;
  }
  await ctx.answerCallbackQuery();
  const sym = symbols.get(mint);
  const kb = new InlineKeyboard().text('✅ Confirm buy', `cf:${mint}`).text('✖ Cancel', `q:${mint}`);
  await ctx.editMessageText(
    `<b>Confirm buy</b>\n\n${esc(p.amount)} SOL → ${sym ? '$' + esc(sym) : 'token'}\n${code(mint)}\n\nSlippage: ${pct(p.slippageBps)}\nWallet: ${esc(w.label)} (${bal.toFixed(4)} SOL)\n\nNothing is bought until you tap Confirm.`,
    { ...HTML, link_preview_options: { is_disabled: true }, reply_markup: kb }
  );
}

// Custom amount / slippage typed by the user. Returns true when handled (done or still waiting).
async function handleCustomInput(ctx, pending) {
  const raw = ctx.message.text.trim().replace(/%$/, '');
  if (pending.kind === 'amount') {
    let ok = true;
    try { solToLamports(raw); } catch { ok = false; }
    if (!ok || Number(raw) > 1000) {
      await ctx.reply('Send a SOL amount like 0.35 (or any /command to cancel).');
      return false;
    }
    setPrefs(ctx.from.id, { amount: String(Number(raw)) });
  } else {
    const n = Number(raw);
    if (!/^\d+(\.\d+)?$/.test(raw) || n < 0.1 || n > 50) {
      await ctx.reply('Send a slippage percent between 0.1 and 50, like 3 (or any /command to cancel).');
      return false;
    }
    setPrefs(ctx.from.id, { slippageBps: Math.round(n * 100) });
  }
  await showToken(ctx, pending.mint, undefined);
  return true;
}

async function doExport(ctx) {
  const w = await getTradeWallet(ctx.from.id);
  if (!w) return ctx.reply('No wallet yet.', { reply_markup: noWalletKeyboard() });
  const kp = keypairFromBytes(decryptSecret(w.encrypted_secret));
  const msg = await ctx.reply(
    `${esc(w.label)} private key (tap to copy):\n${code(secretToBase58(kp))}\n\nDeletes in 60 seconds.`,
    HTML
  );
  setTimeout(() => ctx.api.deleteMessage(msg.chat.id, msg.message_id).catch(() => {}), 60_000);
}

async function doBalance(ctx) {
  const w = await getTradeWallet(ctx.from.id);
  if (!w) return ctx.reply('No wallet yet.', { reply_markup: noWalletKeyboard() });
  const sol = await getSolBalance(w.public_key);
  return ctx.reply(`${w.label} balance: ${sol.toFixed(4)} SOL`);
}

async function doDeposit(ctx) {
  const w = await getTradeWallet(ctx.from.id);
  if (!w) return ctx.reply('No wallet yet.', { reply_markup: noWalletKeyboard() });
  return ctx.reply(`Send SOL to ${esc(w.label)} (tap to copy):\n${code(w.public_key)}`, HTML);
}

bot.command('start', showHome);
bot.command('help', (ctx) => ctx.reply(
  'Paste a token address to see its card and a quote.\n\n/wallet /wallets /rename /createwallet /importwallet /balance /deposit /exportkey /scan /launch'
));
bot.command('wallet', showHome);
bot.command('wallets', showWallets);
bot.command('rename', async (ctx) => {
  const w = await getTradeWallet(ctx.from.id);
  if (!w) return ctx.reply('No wallet yet.', { reply_markup: noWalletKeyboard() });
  const arg = ctx.match.trim();
  if (arg) return applyRename(ctx, w.id, arg);
  return startRename(ctx, w);
});
bot.command('quote', (ctx) => {
  const t = parseTokenInput(ctx.match.trim());
  if (!t) return ctx.reply('Just paste a token contract address and I will show you the card and a quote.');
  return showToken(ctx, t.mint, t.amount);
});
bot.command('createwallet', doCreate);
bot.command('importwallet', startImport);
bot.command('balance', doBalance);
bot.command('deposit', doDeposit);
bot.command('exportkey', doExport);
bot.command('scan', (ctx) => ctx.reply(`https://t.me/${SCAN_USERNAME}`));
bot.command('launch', (ctx) => ctx.reply(`https://t.me/${LAUNCH_USERNAME}`));

bot.callbackQuery('home', async (ctx) => { await ctx.answerCallbackQuery(); return showHome(ctx); });
bot.callbackQuery('wallets', async (ctx) => { await ctx.answerCallbackQuery(); return showWallets(ctx); });
bot.callbackQuery('renamepick', async (ctx) => { await ctx.answerCallbackQuery(); return showRenamePicker(ctx); });
bot.callbackQuery(/^ren:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const list = await listTradeWallets(ctx.from.id);
  const w = list.find((x) => x.id === Number(ctx.match[1]));
  if (!w) return ctx.reply('Wallet not found.');
  return startRename(ctx, w);
});
const MINT = '([1-9A-HJ-NP-Za-km-z]{32,44})';
bot.callbackQuery(new RegExp(`^q:${MINT}$`), async (ctx) => {
  await ctx.answerCallbackQuery();
  return showToken(ctx, ctx.match[1], undefined, { edit: true });
});
bot.callbackQuery(new RegExp(`^a:(\\d+(?:\\.\\d+)?):${MINT}$`), async (ctx) => {
  await ctx.answerCallbackQuery();
  setPrefs(ctx.from.id, { amount: ctx.match[1] });
  return showToken(ctx, ctx.match[2], undefined, { edit: true });
});
bot.callbackQuery(new RegExp(`^s:(\\d+):${MINT}$`), async (ctx) => {
  await ctx.answerCallbackQuery();
  const bps = Number(ctx.match[1]);
  if (!SLIPPAGE_PRESETS.includes(bps)) return;
  setPrefs(ctx.from.id, { slippageBps: bps });
  return showToken(ctx, ctx.match[2], undefined, { edit: true });
});
bot.callbackQuery(new RegExp(`^x([as]):${MINT}$`), async (ctx) => {
  await ctx.answerCallbackQuery();
  const kind = ctx.match[1] === 'a' ? 'amount' : 'slippage';
  awaitingImport.delete(ctx.from.id);
  awaitingRename.delete(ctx.from.id);
  awaitingCustom.set(ctx.from.id, { kind, mint: ctx.match[2] });
  return ctx.reply(kind === 'amount'
    ? 'Send the SOL amount you want to buy with, like 0.35. Send any /command to cancel.'
    : 'Send the slippage percent, like 3 (between 0.1 and 50). Send any /command to cancel.');
});
bot.callbackQuery(new RegExp(`^buy:${MINT}$`), (ctx) => showBuyConfirm(ctx, ctx.match[1]));
bot.callbackQuery(new RegExp(`^cf:${MINT}$`), (ctx) =>
  ctx.answerCallbackQuery({
    text: 'Live buying is not switched on yet (coming in the next step). Nothing was bought.',
    show_alert: true,
  })
);
bot.callbackQuery(/^soon:/, (ctx) => ctx.answerCallbackQuery({ text: 'Coming soon.', show_alert: false }));
bot.callbackQuery('create', async (ctx) => { await ctx.answerCallbackQuery(); return doCreate(ctx); });
bot.callbackQuery('import', async (ctx) => { await ctx.answerCallbackQuery(); return startImport(ctx); });
bot.callbackQuery('balance', async (ctx) => { await ctx.answerCallbackQuery(); return doBalance(ctx); });
bot.callbackQuery('deposit', async (ctx) => { await ctx.answerCallbackQuery(); return doDeposit(ctx); });
bot.callbackQuery('exportkey', async (ctx) => { await ctx.answerCallbackQuery(); return doExport(ctx); });
bot.callbackQuery(/^sel:(\d+)$/, async (ctx) => {
  const ok = await setActiveWallet(ctx.from.id, Number(ctx.match[1]));
  await ctx.answerCallbackQuery({ text: ok ? 'Wallet switched' : 'Wallet not found' });
  if (ok) return showHome(ctx);
});

bot.on('message:text', async (ctx) => {
  if (awaitingRename.has(ctx.from.id)) {
    const walletId = awaitingRename.get(ctx.from.id);
    awaitingRename.delete(ctx.from.id);
    const done = await applyRename(ctx, walletId, ctx.message.text);
    if (!done) awaitingRename.set(ctx.from.id, walletId);
    return;
  }
  if (awaitingCustom.has(ctx.from.id)) {
    const pending = awaitingCustom.get(ctx.from.id);
    // A pasted token address means "show me this token": cancel the wait and open it.
    const pasted = parseTokenInput(ctx.message.text);
    if (pasted) {
      awaitingCustom.delete(ctx.from.id);
      return showToken(ctx, pasted.mint, pasted.amount);
    }
    const done = await handleCustomInput(ctx, pending);
    if (done) awaitingCustom.delete(ctx.from.id);
    return;
  }
  if (!awaitingImport.has(ctx.from.id)) {
    const t = parseTokenInput(ctx.message.text);
    if (t) return showToken(ctx, t.mint, t.amount);
    return;
  }
  awaitingImport.delete(ctx.from.id);
  // Delete the message containing the secret immediately.
  await ctx.deleteMessage().catch(() => {});

  let kp;
  try {
    kp = parseImport(ctx.message.text);
  } catch {
    return ctx.reply('Could not read that key or seed phrase. Run /importwallet to try again.');
  }

  try {
    const label = await saveTradeWallet({
      telegramId: ctx.from.id,
      publicKey: kp.publicKey.toBase58(),
      encryptedSecret: encryptSecret(Buffer.from(kp.secretKey)),
      source: 'imported',
    });
    await ctx.reply(
      `${esc(label)} imported and set as active.\n\nAddress (tap to copy):\n${code(kp.publicKey.toBase58())}`,
      HTML
    );
    return showHome(ctx);
  } catch (err) {
    if (err.code === '23505') return ctx.reply('That wallet is already in your list.');
    throw err;
  }
});

bot.catch((err) => console.error('bot error:', err.error?.message ?? err.message)); // never log secrets

bot.start({ onStart: (me) => console.log(`Omni Trade Bot running as @${me.username}`) });
