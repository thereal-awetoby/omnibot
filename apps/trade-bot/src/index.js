import { Bot, InlineKeyboard } from 'grammy';
import {
  upsertUser, getTradeWallet, listTradeWallets, saveTradeWallet, setActiveWallet, renameWallet,
  createTrade, finishTrade, listTrades, countTrades, listSuccessfulTrades,
  encryptSecret, decryptSecret, normalizeName, isValidName, esc,
} from '@omnibot/shared';
import {
  createWallet, parseImport, secretToBase58, keypairFromBytes, getSolBalance,
  isValidAddress, getMintInfo, getPumpCurve, getPumpInitialRealTokens, getTokenBalances,
} from './wallet.js';
import { solToLamports, fetchQuote, fetchOrder, hasRoute, summarizeQuote, formatUnits, SOL_MINT } from './jupiter.js';
import { prepareSwap, sendSwap } from './swap.js';
import { computePositions, capToBalance, parseSellAmount, formatSol, pnlPct, formatAge } from './positions.js';
import { parseTokenInput, fetchTokenMarket, buildTokenCard, liquidityFromCurve, solUsdFromQuote, curveProgress, shortNum } from './token.js';

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
    .text('Positions', 'pos').text('History', 'hist').row()
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
    .text('💰 Sell', `sm:${mint}`).text('Limit order', 'soon:limit').row();
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

// ---------------- live trading: buy, sell, positions, history ----------------

const inFlight = new Set(); // userIds with a trade being sent right now (blocks double taps)
const pendingSells = new Map(); // userId -> { mint, amountText, expires }
const SELL_GAS_SOL = 0.003;
const PAGE = 8;
const solscanTx = (sig) => `https://solscan.io/tx/${sig}`;
const symOf = (mint, symbol) => (symbol ? `$${esc(symbol)}` : `<code>${short(mint)}</code>`);
const noPreview = { link_preview_options: { is_disabled: true } };

// Edit the current message (button taps) or send a new one.
async function render(ctx, text, kb, edit) {
  const opts = { ...HTML, ...noPreview, reply_markup: kb };
  if (edit) {
    try { return await ctx.editMessageText(text, opts); }
    catch (err) { if (/not modified/i.test(err.message)) return; /* message gone: fall through */ }
  }
  return ctx.reply(text, opts);
}

const afterTradeKeyboard = (mint) =>
  new InlineKeyboard().text('📊 Positions', 'pos').text('🪙 Token', `q:${mint}`).row().text('💰 Sell', `sm:${mint}`).text('Home', 'home');

// Runs `fn` as the user's one active trade. Returns false (and tells them) if one is already running.
async function withTradeLock(ctx, fn) {
  const id = ctx.from.id;
  if (inFlight.has(id)) {
    await ctx.answerCallbackQuery({ text: 'A trade is already being sent. Wait for it to finish.', show_alert: true }).catch(() => {});
    return;
  }
  inFlight.add(id);
  try { await fn(); }
  finally { inFlight.delete(id); }
}

async function recordFinish(tradeId, patch) {
  try { await finishTrade(tradeId, patch); }
  catch (e) { console.error(`could not update trade ${tradeId} (${patch.status} ${patch.signature ?? ''}):`, e.message); }
}

function outcomeText({ verb, r, w, headline }) {
  if (r.status === 'success') return `${headline}\n\n<a href="${solscanTx(r.signature)}">View transaction</a>`;
  if (r.status === 'failed') return `❌ <b>${verb} failed</b>\n${esc(r.error)}\n\nIt did not go through.`;
  return `⚠️ <b>Could not confirm the ${verb.toLowerCase()}</b>\n${esc(r.error)}\n\nIt may have gone through. Check <a href="https://solscan.io/account/${w.public_key}">your wallet</a> or Positions before trying again.`;
}

async function executeBuy(ctx, mint) {
  return withTradeLock(ctx, async () => {
    const userId = ctx.from.id;
    const w = await getTradeWallet(userId);
    if (!w) return ctx.answerCallbackQuery({ text: 'Create a wallet first (/start).', show_alert: true });
    await ctx.answerCallbackQuery();
    const p = getPrefs(userId);
    try {
      const lamports = solToLamports(p.amount);
      const bal = await getSolBalance(w.public_key);
      if (bal < Number(p.amount) + GAS_BUFFER_SOL) {
        return render(ctx, `🔴 Not enough SOL. You have ${bal.toFixed(4)}, need ${esc(p.amount)} + gas. Use Deposit to add SOL.`, new InlineKeyboard().text('Back', `q:${mint}`), true);
      }
      await render(ctx, '⏳ Buying…', undefined, true);
      const mintInfo = await getMintInfoRetry(mint);
      const keypair = keypairFromBytes(decryptSecret(w.encrypted_secret));
      let order;
      try {
        order = await prepareSwap({ keypair, inputMint: SOL_MINT, outputMint: mint, amount: lamports, slippageBps: p.slippageBps, apiKey: process.env.JUPITER_API_KEY });
      } catch (e) {
        return render(ctx, `❌ <b>Buy failed</b>\n${esc(e.message)}\n\nNothing was bought.`, new InlineKeyboard().text('Back', `q:${mint}`), true);
      }
      const symbol = symbols.get(mint) ?? null;
      // Record BEFORE sending so a crash can never leave an untracked trade.
      const tradeId = await createTrade({
        telegramId: userId, walletId: w.id, side: 'buy', mint, symbol, decimals: mintInfo.decimals,
        slippageBps: p.slippageBps, solLamports: lamports, tokenRaw: BigInt(order.outAmount ?? '0'),
      });
      const r = await sendSwap({ order, keypair, side: 'buy', apiKey: process.env.JUPITER_API_KEY });
      const sol = r.amounts?.solLamports ?? lamports;
      const tok = r.amounts?.tokenRaw ?? BigInt(order.outAmount ?? '0');
      await recordFinish(tradeId, r.status === 'success'
        ? { status: 'success', signature: r.signature, solLamports: sol, tokenRaw: tok }
        : { status: r.status, signature: r.signature, error: r.error });
      const headline = `✅ <b>Bought ${symOf(mint, symbol)}</b>\n${formatSol(sol)} SOL → ${shortNum(formatUnits(tok, mintInfo.decimals))} ${symbol ? esc(symbol) : 'tokens'}`;
      return render(ctx, outcomeText({ verb: 'Buy', r, w, headline }), r.status === 'success' ? afterTradeKeyboard(mint) : new InlineKeyboard().text('Back', `q:${mint}`).text('Positions', 'pos'), true);
    } catch (err) {
      console.error('buy error:', err.message);
      return render(ctx, 'Something went wrong before the buy was sent. Nothing was bought. Try again.', new InlineKeyboard().text('Back', `q:${mint}`), true).catch(() => {});
    }
  });
}

// ---- selling ----

async function symbolFor(mint) {
  if (symbols.has(mint)) return symbols.get(mint);
  try { const m = await fetchTokenMarket(mint); if (m?.symbol) { symbols.set(mint, m.symbol); return m.symbol; } } catch { /* optional */ }
  return null;
}

// Sell-side price check: what the tokens would fetch right now (no taker, nothing is signed).
async function sellQuote(mint, raw) {
  const o = await fetchOrder({ inputMint: mint, outputMint: SOL_MINT, amount: raw, apiKey: process.env.JUPITER_API_KEY });
  return hasRoute(o) ? o : null;
}

async function showSellMenu(ctx, mint, { edit = false } = {}) {
  const w = await getTradeWallet(ctx.from.id);
  if (!w) return ctx.reply('Create a wallet first (/start).', { reply_markup: noWalletKeyboard() });
  let mintInfo, balances;
  try { [mintInfo, balances] = await Promise.all([getMintInfoRetry(mint), getTokenBalances(w.public_key)]); }
  catch (e) { console.error('sell menu error:', e.message); return ctx.reply('Could not read your balance right now (the Solana RPC is busy). Try again in a few seconds.'); }
  const bal = balances.get(mint) ?? 0n;
  const symbol = await symbolFor(mint);
  const back = new InlineKeyboard().text('Back', `q:${mint}`).text('Positions', 'pos');
  if (bal <= 0n) return render(ctx, `You hold no ${symOf(mint, symbol)} in ${esc(w.label)}.`, back, edit);
  let worth = 'n/a';
  try { const o = await sellQuote(mint, bal); if (o) worth = `~${formatSol(BigInt(o.outAmount))} SOL`; } catch { /* price is optional here */ }
  const kb = new InlineKeyboard();
  for (const pc of [25, 50, 75, 100]) kb.text(`${pc}%`, `sc:${pc}:${mint}`);
  kb.row().text('Back', `q:${mint}`).text('Positions', 'pos');
  return render(ctx, `<b>Sell ${symOf(mint, symbol)}</b>\n<code>${mint}</code>\n\nHolding: ${shortNum(formatUnits(bal, mintInfo.decimals))}  (${worth})\nWallet: ${esc(w.label)}\n\nPick how much to sell. Nothing is sold until you confirm.\nOr use /sell &lt;address&gt; &lt;amount or %&gt;.`, kb, edit);
}

// Step before any real sell: show exactly what will happen, ask for a second tap.
async function askSellConfirm(ctx, mint, amountText, { edit = false } = {}) {
  const w = await getTradeWallet(ctx.from.id);
  if (!w) return ctx.reply('Create a wallet first (/start).', { reply_markup: noWalletKeyboard() });
  const p = getPrefs(ctx.from.id);
  try {
    const [mintInfo, balances] = await Promise.all([getMintInfoRetry(mint), getTokenBalances(w.public_key)]);
    const raw = parseSellAmount(amountText, balances.get(mint) ?? 0n, mintInfo.decimals);
    const symbol = await symbolFor(mint);
    const o = await sellQuote(mint, raw);
    if (!o) return render(ctx, `No route to sell ${symOf(mint, symbol)} right now (no liquidity).`, new InlineKeyboard().text('Back', `sm:${mint}`), edit);
    const q = summarizeQuote(o, 9);
    pendingSells.set(ctx.from.id, { mint, amountText, expires: Date.now() + 120_000 });
    const impact = q.priceImpactPct === null ? 'n/a' : `${q.priceImpactPct.toFixed(2)}%${Math.abs(q.priceImpactPct) >= 5 ? ' ⚠️' : ''}`;
    const kb = new InlineKeyboard().text('✅ Confirm sell', `sx:${mint}`).text('✖ Cancel', `sm:${mint}`);
    return render(ctx, `<b>Confirm sell</b>\n\n${shortNum(formatUnits(raw, mintInfo.decimals))} ${symbol ? esc(symbol) : 'tokens'} (${esc(amountText)}) → ~${formatSol(BigInt(o.outAmount))} SOL\n<code>${mint}</code>\n\nImpact ${impact}  ·  Slippage ${pct(p.slippageBps)}\nWallet: ${esc(w.label)}\n\nNothing is sold until you tap Confirm. Quote valid for 2 minutes.`, kb, edit);
  } catch (e) {
    if (/hold|amount|percent|small|more than/i.test(e.message)) return ctx.reply(e.message);
    console.error('sell confirm error:', e.message);
    return ctx.reply('Could not prepare that sell right now. Try again in a few seconds.');
  }
}

async function executeSell(ctx, mint) {
  return withTradeLock(ctx, async () => {
    const userId = ctx.from.id;
    const pend = pendingSells.get(userId);
    pendingSells.delete(userId); // one confirmation = one sell
    if (!pend || pend.mint !== mint || pend.expires < Date.now()) {
      return ctx.answerCallbackQuery({ text: 'That confirmation expired. Open Sell again.', show_alert: true });
    }
    const w = await getTradeWallet(userId);
    if (!w) return ctx.answerCallbackQuery({ text: 'Create a wallet first (/start).', show_alert: true });
    await ctx.answerCallbackQuery();
    const p = getPrefs(userId);
    const back = new InlineKeyboard().text('Back', `sm:${mint}`).text('Positions', 'pos');
    try {
      await render(ctx, '⏳ Selling…', undefined, true);
      const [mintInfo, balances, solBal] = await Promise.all([getMintInfoRetry(mint), getTokenBalances(w.public_key), getSolBalance(w.public_key)]);
      if (solBal < SELL_GAS_SOL) return render(ctx, `🔴 Not enough SOL for network fees (have ${solBal.toFixed(4)}). Deposit a little SOL first.`, back, true);
      let raw;
      try { raw = parseSellAmount(pend.amountText, balances.get(mint) ?? 0n, mintInfo.decimals); }
      catch (e) { return render(ctx, `❌ ${esc(e.message)}`, back, true); }
      const keypair = keypairFromBytes(decryptSecret(w.encrypted_secret));
      let order;
      try {
        order = await prepareSwap({ keypair, inputMint: mint, outputMint: SOL_MINT, amount: raw, slippageBps: p.slippageBps, apiKey: process.env.JUPITER_API_KEY });
      } catch (e) {
        return render(ctx, `❌ <b>Sell failed</b>\n${esc(e.message)}\n\nNothing was sold.`, back, true);
      }
      const symbol = await symbolFor(mint);
      const before = computePositions(await listSuccessfulTrades(userId, w.id)).get(mint)?.realized ?? 0n;
      const tradeId = await createTrade({
        telegramId: userId, walletId: w.id, side: 'sell', mint, symbol, decimals: mintInfo.decimals,
        slippageBps: p.slippageBps, solLamports: BigInt(order.outAmount ?? '0'), tokenRaw: raw,
      });
      const r = await sendSwap({ order, keypair, side: 'sell', apiKey: process.env.JUPITER_API_KEY });
      const sol = r.amounts?.solLamports ?? BigInt(order.outAmount ?? '0');
      const tok = r.amounts?.tokenRaw ?? raw;
      await recordFinish(tradeId, r.status === 'success'
        ? { status: 'success', signature: r.signature, solLamports: sol, tokenRaw: tok }
        : { status: r.status, signature: r.signature, error: r.error });
      let headline = `✅ <b>Sold ${symOf(mint, symbol)}</b>\n${shortNum(formatUnits(tok, mintInfo.decimals))} ${symbol ? esc(symbol) : 'tokens'} → ${formatSol(sol)} SOL`;
      if (r.status === 'success') {
        try {
          const after = computePositions(await listSuccessfulTrades(userId, w.id)).get(mint)?.realized ?? 0n;
          const pnl = after - before;
          const cost = sol - pnl; // cost basis of the part that was sold
          const pc = pnlPct(pnl, cost);
          headline += `\nRealized: ${formatSol(pnl, { withPlus: true })} SOL${pc === null ? '' : ` (${pc >= 0 ? '+' : ''}${pc.toFixed(1)}%)`}`;
        } catch { /* PnL line is optional */ }
      }
      return render(ctx, outcomeText({ verb: 'Sell', r, w, headline }), r.status === 'success' ? afterTradeKeyboard(mint) : back, true);
    } catch (err) {
      console.error('sell error:', err.message);
      return render(ctx, 'Something went wrong before the sell was sent. Nothing was sold. Try again.', back, true).catch(() => {});
    }
  });
}

// ---- positions & history ----

async function showPositions(ctx, { edit = false } = {}) {
  const w = await getTradeWallet(ctx.from.id);
  if (!w) return ctx.reply('No wallet yet.', { reply_markup: noWalletKeyboard() });
  const all = computePositions(await listSuccessfulTrades(ctx.from.id, w.id));
  const realizedTotal = [...all.values()].reduce((a, x) => a + x.realized, 0n);
  let open = [...all.values()].filter((x) => x.tokens > 0n);

  let balances = null;
  if (open.length) {
    try { balances = await getTokenBalances(w.public_key); } catch (e) { console.error('balances error:', e.message); }
  }
  if (balances) open = open.map((x) => capToBalance(x, balances.get(x.mint) ?? 0n)).filter((x) => x.tokens > 0n);
  open.sort((a, b) => (b.cost > a.cost ? 1 : b.cost < a.cost ? -1 : 0));
  const shown = open.slice(0, PAGE);

  const quotes = await Promise.allSettled(shown.map((x) => sellQuote(x.mint, x.tokens)));
  const lines = [`<b>📊 Positions</b>  ·  ${esc(w.label)}`, ''];
  let totalCost = 0n, totalValue = 0n;
  const kb = new InlineKeyboard();
  shown.forEach((x, i) => {
    const q = quotes[i].status === 'fulfilled' ? quotes[i].value : null;
    const name = symOf(x.mint, x.symbol);
    lines.push(`${name}  ·  ${shortNum(formatUnits(x.tokens, x.decimals))}`);
    if (q) {
      const value = BigInt(q.outAmount);
      const pnl = value - x.cost;
      const pc = pnlPct(pnl, x.cost);
      totalCost += x.cost; totalValue += value;
      lines.push(`  Cost ${formatSol(x.cost)} SOL  →  now ~${formatSol(value)} SOL  (${formatSol(pnl, { withPlus: true })}${pc === null ? '' : `, ${pc >= 0 ? '+' : ''}${pc.toFixed(1)}%`})`);
    } else {
      lines.push(`  Cost ${formatSol(x.cost)} SOL  ·  current value n/a`);
    }
    kb.text(`💰 Sell ${x.symbol ? '$' + x.symbol : short(x.mint)}`, `sm:${x.mint}`);
    if (i % 2 === 1) kb.row();
  });
  if (shown.length % 2 === 1) kb.row();
  if (shown.length === 0) lines.push('No open positions yet. Paste a token address to buy one.');
  else {
    const un = totalValue - totalCost;
    lines.push('', `Unrealized: ${formatSol(un, { withPlus: true })} SOL (priced where a sell quote was available)`);
  }
  if (open.length > shown.length) lines.push(`…and ${open.length - shown.length} more.`);
  lines.push(`Realized (all trades): ${formatSol(realizedTotal, { withPlus: true })} SOL`);
  lines.push('', 'Cost basis counts only trades made through this bot. Network fees are not included.');
  kb.text('↻ Refresh', 'pos').text('History', 'hist').row().text('Home', 'home');
  return render(ctx, lines.join('\n'), kb, edit);
}

async function showHistory(ctx, offset = 0, { edit = false } = {}) {
  const w = await getTradeWallet(ctx.from.id);
  if (!w) return ctx.reply('No wallet yet.', { reply_markup: noWalletKeyboard() });
  const [rows, total] = await Promise.all([listTrades(ctx.from.id, w.id, { limit: PAGE, offset }), countTrades(ctx.from.id, w.id)]);
  const lines = [`<b>🧾 History</b>  ·  ${esc(w.label)}`, ''];
  if (rows.length === 0) lines.push('No trades yet.');
  for (const t of rows) {
    const name = symOf(t.mint, t.symbol);
    const tokens = `${shortNum(formatUnits(t.token_raw, t.decimals, 2))}`;
    const link = t.signature ? ` · <a href="${solscanTx(t.signature)}">tx</a>` : '';
    const when = formatAge(t.created_at);
    if (t.status === 'success') {
      const icon = t.side === 'buy' ? '🟢 Buy' : '🔴 Sell';
      lines.push(t.side === 'buy'
        ? `${icon} ${name}  ${formatSol(t.sol_lamports)} SOL → ${tokens}  ·  ${when}${link}`
        : `${icon} ${name}  ${tokens} → ${formatSol(t.sol_lamports)} SOL  ·  ${when}${link}`);
    } else if (t.status === 'failed') {
      lines.push(`❌ ${t.side === 'buy' ? 'Buy' : 'Sell'} ${name} failed  ·  ${when}`);
    } else if (t.status === 'unknown') {
      lines.push(`⚠️ ${t.side === 'buy' ? 'Buy' : 'Sell'} ${name} unconfirmed (check wallet)  ·  ${when}${link}`);
    } else {
      lines.push(`⏳ ${t.side === 'buy' ? 'Buy' : 'Sell'} ${name} pending  ·  ${when}`);
    }
  }
  const kb = new InlineKeyboard();
  if (offset > 0) kb.text('← Newer', `h:${Math.max(0, offset - PAGE)}`);
  if (offset + PAGE < total) kb.text('Older →', `h:${offset + PAGE}`);
  if (offset > 0 || offset + PAGE < total) kb.row();
  kb.text('Positions', 'pos').text('Home', 'home');
  return render(ctx, lines.join('\n'), kb, edit);
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

// Deep link from the Scan bot: t.me/<trade bot>?start=buy_<mint> opens that token's card.
bot.command('start', async (ctx) => {
  const m = /^buy_([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(ctx.match.trim());
  if (m) return showToken(ctx, m[1]);
  return showHome(ctx);
});
bot.command('help', (ctx) => ctx.reply(
  'Paste a token address to see its card, a quote, and buy.\n\n/sell <address> <amount or %>  (or tap Sell on a card)\n/positions /portfolio /history\n/wallet /wallets /rename /createwallet /importwallet /balance /deposit /exportkey /scan /launch'
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
bot.command('sell', async (ctx) => {
  const [mint, amount] = ctx.match.trim().split(/\s+/);
  if (!mint || !isValidAddress(mint)) return ctx.reply('Usage: /sell <token address> <amount or %>\nExample: /sell <address> 50%');
  if (!amount) return showSellMenu(ctx, mint);
  return askSellConfirm(ctx, mint, amount);
});
bot.command('positions', (ctx) => showPositions(ctx));
bot.command('portfolio', (ctx) => showPositions(ctx));
bot.command('history', (ctx) => showHistory(ctx));
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
bot.callbackQuery(new RegExp(`^cf:${MINT}$`), (ctx) => executeBuy(ctx, ctx.match[1]));
bot.callbackQuery(new RegExp(`^sm:${MINT}$`), async (ctx) => { await ctx.answerCallbackQuery(); return showSellMenu(ctx, ctx.match[1], { edit: true }); });
bot.callbackQuery(new RegExp(`^sc:(\\d{1,3}):${MINT}$`), async (ctx) => {
  await ctx.answerCallbackQuery();
  return askSellConfirm(ctx, ctx.match[2], `${ctx.match[1]}%`, { edit: true });
});
bot.callbackQuery(new RegExp(`^sx:${MINT}$`), (ctx) => executeSell(ctx, ctx.match[1]));
bot.callbackQuery('pos', async (ctx) => { await ctx.answerCallbackQuery(); return showPositions(ctx, { edit: true }); });
bot.callbackQuery('hist', async (ctx) => { await ctx.answerCallbackQuery(); return showHistory(ctx, 0, { edit: true }); });
bot.callbackQuery(/^h:(\d+)$/, async (ctx) => { await ctx.answerCallbackQuery(); return showHistory(ctx, Number(ctx.match[1]), { edit: true }); });
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
