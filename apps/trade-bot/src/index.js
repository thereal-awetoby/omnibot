import { Bot, InlineKeyboard } from 'grammy';
import {
  upsertUser, getTradeWallet, listTradeWallets, saveTradeWallet, setActiveWallet, renameWallet,
  encryptSecret, decryptSecret, normalizeName, isValidName, esc,
} from '@omnibot/shared';
import {
  createWallet, parseImport, secretToBase58, keypairFromBytes, getSolBalance,
} from './wallet.js';

if (!process.env.TRADE_BOT_TOKEN) throw new Error('TRADE_BOT_TOKEN is not set');
const bot = new Bot(process.env.TRADE_BOT_TOKEN);

// Users currently being asked to paste a key/seed. In-memory is fine for now.
const awaitingImport = new Set();
// Users currently being asked for a new wallet name: userId -> walletId.
const awaitingRename = new Map();

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
  '/wallet /wallets /rename /createwallet /importwallet /balance /deposit /exportkey /scan /launch'
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
  if (!awaitingImport.has(ctx.from.id)) return;
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
