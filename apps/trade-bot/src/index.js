import { Bot, InlineKeyboard } from 'grammy';
import {
  upsertUser, getTradeWallet, saveTradeWallet, encryptSecret, decryptSecret,
} from '@omnibot/shared';
import {
  createWallet, parseImport, secretToBase58, keypairFromBytes, getSolBalance,
} from './wallet.js';

if (!process.env.TRADE_BOT_TOKEN) throw new Error('TRADE_BOT_TOKEN is not set');
const bot = new Bot(process.env.TRADE_BOT_TOKEN);

// Users currently being asked to paste a key/seed. In-memory is fine for Phase 0.
const awaitingImport = new Set();

const SCAN_USERNAME = process.env.SCAN_BOT_USERNAME || 'OmniScanBot';
const LAUNCH_USERNAME = process.env.LAUNCH_BOT_USERNAME || 'OmniLaunchBot';

const noWalletKeyboard = () =>
  new InlineKeyboard().text('Create wallet', 'create').text('Import wallet', 'import');

const mainKeyboard = () =>
  new InlineKeyboard()
    .text('Balance', 'balance').text('Deposit', 'deposit').row()
    .text('Export key', 'exportkey').row()
    .url('Omni Scan', `https://t.me/${SCAN_USERNAME}`)
    .url('Omni Launch', `https://t.me/${LAUNCH_USERNAME}`);

bot.use(async (ctx, next) => {
  if (ctx.from) await upsertUser({ id: ctx.from.id, username: ctx.from.username });
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
  return ctx.reply(`Omni Trade Bot\n\nWallet:\n${w.public_key}`, { reply_markup: mainKeyboard() });
}

async function doCreate(ctx) {
  if (await getTradeWallet(ctx.from.id)) return ctx.reply('You already have a wallet. Use /wallet.');
  const kp = createWallet();
  await saveTradeWallet({
    telegramId: ctx.from.id,
    publicKey: kp.publicKey.toBase58(),
    encryptedSecret: encryptSecret(Buffer.from(kp.secretKey)),
    source: 'created',
  });
  const msg = await ctx.reply(
    `Wallet created.\n\nAddress:\n${kp.publicKey.toBase58()}\n\nPrivate key (shown once, save it now):\n${secretToBase58(kp)}\n\nThis message deletes itself in 60 seconds. Never share the key.`
  );
  setTimeout(() => ctx.api.deleteMessage(msg.chat.id, msg.message_id).catch(() => {}), 60_000);
  return showHome(ctx);
}

async function startImport(ctx) {
  if (await getTradeWallet(ctx.from.id)) return ctx.reply('You already have a wallet. Use /wallet.');
  awaitingImport.add(ctx.from.id);
  return ctx.reply('Paste your private key (base58 or JSON array) or 12/24-word seed phrase. Your message will be deleted right away.');
}

async function doExport(ctx) {
  const w = await getTradeWallet(ctx.from.id);
  if (!w) return ctx.reply('No wallet yet.', { reply_markup: noWalletKeyboard() });
  const kp = keypairFromBytes(decryptSecret(w.encrypted_secret));
  const msg = await ctx.reply(`Private key:\n${secretToBase58(kp)}\n\nDeletes in 60 seconds.`);
  setTimeout(() => ctx.api.deleteMessage(msg.chat.id, msg.message_id).catch(() => {}), 60_000);
}

async function doBalance(ctx) {
  const w = await getTradeWallet(ctx.from.id);
  if (!w) return ctx.reply('No wallet yet.', { reply_markup: noWalletKeyboard() });
  const sol = await getSolBalance(w.public_key);
  return ctx.reply(`Balance: ${sol.toFixed(4)} SOL`);
}

async function doDeposit(ctx) {
  const w = await getTradeWallet(ctx.from.id);
  if (!w) return ctx.reply('No wallet yet.', { reply_markup: noWalletKeyboard() });
  return ctx.reply(`Send SOL to:\n${w.public_key}`);
}

bot.command('start', showHome);
bot.command('help', (ctx) => ctx.reply(
  '/wallet /createwallet /importwallet /balance /deposit /exportkey /scan /launch'
));
bot.command('wallet', showHome);
bot.command('createwallet', doCreate);
bot.command('importwallet', startImport);
bot.command('balance', doBalance);
bot.command('deposit', doDeposit);
bot.command('exportkey', doExport);
bot.command('scan', (ctx) => ctx.reply(`https://t.me/${SCAN_USERNAME}`));
bot.command('launch', (ctx) => ctx.reply(`https://t.me/${LAUNCH_USERNAME}`));

bot.callbackQuery('create', async (ctx) => { await ctx.answerCallbackQuery(); return doCreate(ctx); });
bot.callbackQuery('import', async (ctx) => { await ctx.answerCallbackQuery(); return startImport(ctx); });
bot.callbackQuery('balance', async (ctx) => { await ctx.answerCallbackQuery(); return doBalance(ctx); });
bot.callbackQuery('deposit', async (ctx) => { await ctx.answerCallbackQuery(); return doDeposit(ctx); });
bot.callbackQuery('exportkey', async (ctx) => { await ctx.answerCallbackQuery(); return doExport(ctx); });

bot.on('message:text', async (ctx) => {
  if (!awaitingImport.has(ctx.from.id)) return;
  awaitingImport.delete(ctx.from.id);
  // Delete the message containing the secret immediately.
  await ctx.deleteMessage().catch(() => {});
  try {
    const kp = parseImport(ctx.message.text);
    await saveTradeWallet({
      telegramId: ctx.from.id,
      publicKey: kp.publicKey.toBase58(),
      encryptedSecret: encryptSecret(Buffer.from(kp.secretKey)),
      source: 'imported',
    });
    await ctx.reply(`Wallet imported.\n\nAddress:\n${kp.publicKey.toBase58()}`);
    return showHome(ctx);
  } catch {
    return ctx.reply('Could not read that key or seed phrase. Run /importwallet to try again.');
  }
});

bot.catch((err) => console.error('bot error:', err.error?.message ?? err.message)); // never log secrets

bot.start({ onStart: (me) => console.log(`Omni Trade Bot running as @${me.username}`) });
