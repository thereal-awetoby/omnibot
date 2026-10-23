import { Bot, InlineKeyboard } from 'grammy';
import {
  upsertUser, getLaunchWallet, saveLaunchWallet, createLaunch, finishLaunch, listLaunches,
  encryptSecret, decryptSecret, esc,
} from '@omnibot/shared';
import {
  connection, createWallet, parseImport, secretToBase58, keypairFromBytes, getSolBalance, signCreateTx, newMintKeypair,
} from './wallet.js';
import { uploadMetadata, fetchCreateTx, sendAndConfirm } from './pump.js';
import {
  parseName, parseSymbol, parseDescription, parseSocial, parseDevBuy, checkImage,
  lamportsToSol, neededLamports, fmtSol, CREATE_COST_SOL, MAX_IMAGE_BYTES,
} from './wizard.js';

if (!process.env.LAUNCH_BOT_TOKEN) throw new Error('LAUNCH_BOT_TOKEN is not set');
const bot = new Bot(process.env.LAUNCH_BOT_TOKEN);

const SCAN_USERNAME = process.env.SCAN_BOT_USERNAME || 'OmniScanBot';
const TRADE_USERNAME = process.env.TRADE_BOT_USERNAME || 'OmniTradeBot';
const code = (s) => `<code>${s}</code>`;
const HTML = { parse_mode: 'HTML', link_preview_options: { is_disabled: true } };

const awaitingImport = new Set();
// userId -> { step, d: {name, symbol, description, twitter, telegram, website, devBuyLamports}, image: {bytes, mime} }
const wizards = new Map();
const launching = new Set(); // users with a launch in progress (stops double taps)

const OPTIONAL = { twitter: 'X (Twitter) link or @name', telegram: 'Telegram group/channel link', website: 'website link' };
const NEXT = { name: 'symbol', symbol: 'description', description: 'image', image: 'twitter', twitter: 'telegram', telegram: 'website', website: 'devbuy' };

const cancelKb = () => new InlineKeyboard().text('Cancel', 'cancel');
const skipKb = () => new InlineKeyboard().text('Skip', 'skip').text('Cancel', 'cancel');
const noWalletKb = () => new InlineKeyboard().text('Create wallet', 'create').text('Import wallet', 'import');
const mainKb = () =>
  new InlineKeyboard()
    .text('Create token', 'newtoken').text('My launches', 'launches').row()
    .text('Wallet', 'wallet').text('Export key', 'exportkey').row()
    .url('Omni Scan', `https://t.me/${SCAN_USERNAME}`).url('Omni Trade', `https://t.me/${TRADE_USERNAME}`);

bot.use(async (ctx, next) => {
  if (ctx.from) {
    await upsertUser({ id: ctx.from.id, username: ctx.from.username });
    if (ctx.message?.text?.startsWith('/')) {
      awaitingImport.delete(ctx.from.id);
      wizards.delete(ctx.from.id);
    }
  }
  await next();
});

const autoDelete = (ctx, msg, ms = 60_000) =>
  setTimeout(() => ctx.api.deleteMessage(msg.chat.id, msg.message_id).catch(() => {}), ms);

async function showHome(ctx) {
  const w = await getLaunchWallet(ctx.from.id);
  if (!w) {
    return ctx.reply(
      'Welcome to Omni Launch Bot.\n\nCreate your own token on pump.fun right from Telegram. First you need a launch wallet: create a new one or import one you already have.',
      { reply_markup: noWalletKb() });
  }
  return ctx.reply(
    `Omni Launch Bot\n\nLaunch wallet (tap to copy):\n${code(w.public_key)}\n\nTap Create token to start.`,
    { ...HTML, reply_markup: mainKb() });
}

async function doCreateWallet(ctx) {
  if (await getLaunchWallet(ctx.from.id)) return ctx.reply('You already have a launch wallet. Use /wallet to see it.');
  const kp = createWallet();
  try {
    await saveLaunchWallet({
      telegramId: ctx.from.id, publicKey: kp.publicKey.toBase58(),
      encryptedSecret: encryptSecret(Buffer.from(kp.secretKey)), source: 'created',
    });
  } catch (e) {
    if (e.code === '23505') return ctx.reply('You already have a launch wallet. Use /wallet to see it.');
    throw e;
  }
  const msg = await ctx.reply(
    `Launch wallet created.\n\nAddress (tap to copy):\n${code(kp.publicKey.toBase58())}\n\n` +
    `Private key. Save it somewhere safe NOW, this message deletes itself in 60 seconds:\n${code(secretToBase58(kp))}\n\n` +
    'Never share the key with anyone. Send SOL to the address above to fund your launches.',
    HTML);
  autoDelete(ctx, msg);
  return showHome(ctx);
}

async function doWallet(ctx) {
  const w = await getLaunchWallet(ctx.from.id);
  if (!w) return ctx.reply('No launch wallet yet.', { reply_markup: noWalletKb() });
  let bal = '?';
  try { bal = fmtSol(await getSolBalance(w.public_key)); } catch { /* RPC hiccup */ }
  return ctx.reply(
    `Launch wallet\n\nAddress (tap to copy):\n${code(w.public_key)}\n\nBalance: ${bal} SOL\n\n` +
    `A launch needs about ${CREATE_COST_SOL} SOL for network costs, plus the first buy you choose.`,
    { ...HTML, reply_markup: mainKb() });
}

async function doExport(ctx) {
  const w = await getLaunchWallet(ctx.from.id);
  if (!w) return ctx.reply('No launch wallet yet.', { reply_markup: noWalletKb() });
  const kp = keypairFromBytes(decryptSecret(w.encrypted_secret));
  const msg = await ctx.reply(
    `Private key for ${code(w.public_key)}\n\n${code(secretToBase58(kp))}\n\nThis message deletes itself in 60 seconds. Never share it.`, HTML);
  autoDelete(ctx, msg);
}

async function startImport(ctx) {
  if (await getLaunchWallet(ctx.from.id)) return ctx.reply('You already have a launch wallet. Use /wallet to see it.');
  awaitingImport.add(ctx.from.id);
  return ctx.reply('Paste your private key (base58 or JSON array) or your 12/24-word seed phrase.\n\nI delete your message right after reading it. Send /start to cancel.');
}

// ---------- wizard ----------

const PROMPTS = {
  name: () => ['Step 1/8: What is the token name? (up to 32 characters)', cancelKb()],
  symbol: () => ['Step 2/8: What is the ticker? Letters or numbers, up to 10 (example: OMNI)', cancelKb()],
  description: () => ['Step 3/8: Write a short description (up to 500 characters).', cancelKb()],
  image: () => [`Step 4/8: Send the logo as a picture (JPG, PNG, GIF or WEBP, up to ${MAX_IMAGE_BYTES / 1024 / 1024} MB). A square image looks best.`, cancelKb()],
  twitter: () => [`Step 5/8: ${OPTIONAL.twitter}? Or tap Skip.`, skipKb()],
  telegram: () => [`Step 6/8: ${OPTIONAL.telegram}? Or tap Skip.`, skipKb()],
  website: () => [`Step 7/8: ${OPTIONAL.website}? Or tap Skip.`, skipKb()],
  devbuy: () => [
    `Step 8/8: How much SOL do you want to buy of your own token in the same transaction (your first buy)? Send an amount like 0.5, or 0 for none.\n\nThis is a normal buy from your own wallet, shown openly on pump.fun like any other.`,
    new InlineKeyboard().text('0', 'dev:0').text('0.1', 'dev:0.1').text('0.5', 'dev:0.5').text('1', 'dev:1').row().text('Cancel', 'cancel'),
  ],
};

async function ask(ctx, step) {
  const w = wizards.get(ctx.from.id);
  w.step = step;
  const [text, kb] = PROMPTS[step]();
  return ctx.reply(text, { reply_markup: kb });
}

async function startWizard(ctx) {
  const w = await getLaunchWallet(ctx.from.id);
  if (!w) return ctx.reply('You need a launch wallet first.', { reply_markup: noWalletKb() });
  if (launching.has(ctx.from.id)) return ctx.reply('A launch is already in progress. Wait for it to finish.');
  wizards.set(ctx.from.id, { step: 'name', d: {}, image: null });
  return ask(ctx, 'name');
}

function summaryText(w) {
  const d = w.d;
  const dev = lamportsToSol(d.devBuyLamports);
  return (
    `<b>Check your token</b>\n\n` +
    `Name: ${esc(d.name)}\nTicker: $${esc(d.symbol)}\n` +
    `Description: ${esc(d.description)}\n` +
    `X: ${d.twitter ? esc(d.twitter) : '-'}\nTelegram: ${d.telegram ? esc(d.telegram) : '-'}\nWebsite: ${d.website ? esc(d.website) : '-'}\n` +
    `First buy: ${dev > 0 ? fmtSol(dev) + ' SOL' : 'none'}\n\n` +
    `Total from your wallet: about ${fmtSol(lamportsToSol(neededLamports(d.devBuyLamports)))} SOL ` +
    `(about ${CREATE_COST_SOL} SOL network costs${dev > 0 ? ' + your first buy' : ''}). Network costs that are not used stay in your wallet.\n\n` +
    `Launching is final. The token will be created on pump.fun from your wallet.`
  );
}

async function showSummary(ctx) {
  const w = wizards.get(ctx.from.id);
  w.step = 'confirm';
  return ctx.reply(summaryText(w), {
    ...HTML,
    reply_markup: new InlineKeyboard().text('Launch now', 'go').text('Cancel', 'cancel'),
  });
}

async function advance(ctx, from) {
  const next = NEXT[from];
  if (next) return ask(ctx, next);
  return showSummary(ctx);
}

async function handleWizardText(ctx, w) {
  const t = ctx.message.text;
  const bad = (r) => ctx.reply(r.error, { reply_markup: w.step === 'name' || w.step === 'symbol' || w.step === 'description' ? cancelKb() : skipKb() });
  switch (w.step) {
    case 'name': { const r = parseName(t); if (!r.ok) return bad(r); w.d.name = r.value; return advance(ctx, 'name'); }
    case 'symbol': { const r = parseSymbol(t); if (!r.ok) return bad(r); w.d.symbol = r.value; return advance(ctx, 'symbol'); }
    case 'description': { const r = parseDescription(t); if (!r.ok) return bad(r); w.d.description = r.value; return advance(ctx, 'description'); }
    case 'image': return ctx.reply('Please send the logo as a picture, not text.', { reply_markup: cancelKb() });
    case 'twitter': case 'telegram': case 'website': {
      const r = parseSocial(w.step, t); if (!r.ok) return bad(r);
      w.d[w.step] = r.value; return advance(ctx, w.step);
    }
    case 'devbuy': {
      const r = parseDevBuy(t);
      if (!r.ok) return ctx.reply(r.error, { reply_markup: cancelKb() });
      w.d.devBuyLamports = r.value; return showSummary(ctx);
    }
    default: return ctx.reply('Tap a button above, or /start to begin again.');
  }
}

async function downloadFile(ctx, fileId) {
  const f = await ctx.api.getFile(fileId);
  if (!f.file_path) throw new Error('no path');
  const res = await fetch(`https://api.telegram.org/file/bot${process.env.LAUNCH_BOT_TOKEN}/${f.file_path}`);
  if (!res.ok) throw new Error('download failed');
  return new Uint8Array(await res.arrayBuffer());
}

async function handleImage(ctx, w, fileId, mime, size) {
  const chk = checkImage({ mime, size });
  if (!chk.ok) return ctx.reply(chk.error, { reply_markup: cancelKb() });
  try {
    const bytes = await downloadFile(ctx, fileId);
    if (bytes.length > MAX_IMAGE_BYTES) return ctx.reply('That image is too big (5 MB max).', { reply_markup: cancelKb() });
    w.image = { bytes, mime };
  } catch {
    return ctx.reply('I could not download that picture. Please send it again.', { reply_markup: cancelKb() });
  }
  return advance(ctx, 'image');
}

// ---------- launch ----------

async function doLaunch(ctx) {
  const uid = ctx.from.id;
  const w = wizards.get(uid);
  if (!w || w.step !== 'confirm') return ctx.reply('Nothing to launch. Tap Create token to start.');
  if (launching.has(uid)) return;
  launching.add(uid);
  const d = w.d;
  let launchId = null;
  try {
    const wallet = await getLaunchWallet(uid);
    if (!wallet) return ctx.reply('You need a launch wallet first.', { reply_markup: noWalletKb() });
    const need = neededLamports(d.devBuyLamports);
    const have = Math.round((await getSolBalance(wallet.public_key)) * 1e9);
    if (have < need) {
      await ctx.reply(
        `Not enough SOL. You need about ${fmtSol(lamportsToSol(need))} SOL but the wallet has ${fmtSol(lamportsToSol(have))} SOL.\n\nSend SOL to:\n${code(wallet.public_key)}\n\nthen tap Launch now again.`,
        HTML);
      return showSummary(ctx);
    }
    wizards.delete(uid); // a second tap on "Launch now" can no longer start another launch
    launchId = await createLaunch({ telegramId: uid, ...d });
    const status = await ctx.reply('Launching... uploading your logo and details.');
    const edit = (text) => ctx.api.editMessageText(status.chat.id, status.message_id, text).catch(() => {});

    const uri = await uploadMetadata({
      imageBytes: w.image.bytes, mime: w.image.mime, name: d.name, symbol: d.symbol,
      description: d.description, twitter: d.twitter, telegram: d.telegram, website: d.website,
    });
    await edit('Launching... creating the token on pump.fun.');

    const mint = newMintKeypair();
    const creator = keypairFromBytes(decryptSecret(wallet.encrypted_secret));
    const txBytes = await fetchCreateTx({
      publicKey: creator.publicKey.toBase58(), mintPublicKey: mint.publicKey.toBase58(),
      name: d.name, symbol: d.symbol, uri, devBuySol: lamportsToSol(d.devBuyLamports),
    });
    const raw = signCreateTx(txBytes, [mint, creator]);
    const mintAddr = mint.publicKey.toBase58();
    const r = await sendAndConfirm(connection, raw);

    if (r.status === 'success') {
      await finishLaunch(launchId, { status: 'success', mint: mintAddr, signature: r.signature, metadataUri: uri });
      await edit('Your token is live.');
      return ctx.reply(
        `<b>${esc(d.name)}</b> ($${esc(d.symbol)}) is live on pump.fun.\n\n` +
        `Contract address (tap to copy):\n${code(mintAddr)}\n\n` +
        `<a href="https://pump.fun/coin/${mintAddr}">Open on pump.fun</a>\n<a href="https://solscan.io/tx/${r.signature}">Transaction</a>\n\n` +
        `Paste the address in Omni Scan to see its scan card.`,
        { ...HTML, reply_markup: mainKb() });
    }
    if (r.status === 'unknown') {
      await finishLaunch(launchId, { status: 'unknown', mint: mintAddr, signature: r.signature, metadataUri: uri, error: 'Sent but not confirmed in time' });
      await edit('Sent, but I could not confirm it yet.');
      return ctx.reply(
        `The transaction was sent but I could not confirm it in time. It may still land.\n\nCheck here before trying again:\n<a href="https://solscan.io/tx/${r.signature}">Transaction</a>\nToken address: ${code(mintAddr)}`,
        { ...HTML, reply_markup: mainKb() });
    }
    await finishLaunch(launchId, { status: 'failed', metadataUri: uri, error: r.error });
    await edit('Launch failed.');
    return ctx.reply(`Launch failed: ${esc(r.error)}\n\nNothing was created and no SOL was spent on a token. You can try again.`, { ...HTML, reply_markup: mainKb() });
  } catch (err) {
    console.error('launch error:', err.message); // never log secrets
    if (launchId) await finishLaunch(launchId, { status: 'failed', error: String(err.message).slice(0, 200) }).catch(() => {});
    return ctx.reply(`Launch failed: ${esc(err.message)}\n\nTap Create token to try again.`, { ...HTML, reply_markup: mainKb() });
  } finally {
    launching.delete(uid);
  }
}

async function doLaunches(ctx) {
  const list = await listLaunches(ctx.from.id);
  if (list.length === 0) return ctx.reply('No launches yet. Tap Create token to make your first.', { reply_markup: mainKb() });
  const icon = { success: '✅', failed: '❌', unknown: '⏳', pending: '⏳' };
  const text = 'Your launches\n\n' + list.map((l) =>
    `${icon[l.status] ?? '▫️'} <b>${esc(l.name)}</b> ($${esc(l.symbol)})\n` +
    (l.mint ? `${code(l.mint)}\n` : '') +
    (l.signature ? `<a href="https://solscan.io/tx/${l.signature}">Transaction</a>` : (l.status === 'failed' ? 'Did not land' : 'Pending'))
  ).join('\n\n');
  return ctx.reply(text, { ...HTML, reply_markup: mainKb() });
}

// ---------- routes ----------

bot.command('start', showHome);
bot.command('help', (ctx) => ctx.reply(
  'Omni Launch Bot\n\n/create - make a new token on pump.fun\n/launches - your previous launches\n/wallet - launch wallet and balance\n/createwallet /importwallet\n/exportkey - show your private key\n/scan - Omni Scan\n/trade - Omni Trade'));
bot.command('create', startWizard);
bot.command('launches', doLaunches);
bot.command('wallet', doWallet);
bot.command('createwallet', doCreateWallet);
bot.command('importwallet', startImport);
bot.command('exportkey', doExport);
bot.command('scan', (ctx) => ctx.reply('Omni Scan:', { reply_markup: new InlineKeyboard().url('Open Omni Scan', `https://t.me/${SCAN_USERNAME}`) }));
bot.command('trade', (ctx) => ctx.reply('Omni Trade:', { reply_markup: new InlineKeyboard().url('Open Omni Trade', `https://t.me/${TRADE_USERNAME}`) }));

bot.callbackQuery('create', async (ctx) => { await ctx.answerCallbackQuery(); return doCreateWallet(ctx); });
bot.callbackQuery('import', async (ctx) => { await ctx.answerCallbackQuery(); return startImport(ctx); });
bot.callbackQuery('wallet', async (ctx) => { await ctx.answerCallbackQuery(); return doWallet(ctx); });
bot.callbackQuery('exportkey', async (ctx) => { await ctx.answerCallbackQuery(); return doExport(ctx); });
bot.callbackQuery('launches', async (ctx) => { await ctx.answerCallbackQuery(); return doLaunches(ctx); });
bot.callbackQuery('newtoken', async (ctx) => { await ctx.answerCallbackQuery(); return startWizard(ctx); });
bot.callbackQuery('cancel', async (ctx) => {
  wizards.delete(ctx.from.id);
  await ctx.answerCallbackQuery({ text: 'Cancelled' });
  await ctx.deleteMessage().catch(() => {});
  return ctx.reply('Cancelled.', { reply_markup: mainKb() });
});
bot.callbackQuery('skip', async (ctx) => {
  await ctx.answerCallbackQuery();
  const w = wizards.get(ctx.from.id);
  if (!w || !OPTIONAL[w.step]) return;
  const step = w.step;
  w.d[step] = null;
  return advance(ctx, step);
});
bot.callbackQuery(/^dev:([\d.]+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const w = wizards.get(ctx.from.id);
  if (!w || w.step !== 'devbuy') return;
  const r = parseDevBuy(ctx.match[1]);
  w.d.devBuyLamports = r.value;
  return showSummary(ctx);
});
bot.callbackQuery('go', async (ctx) => {
  await ctx.answerCallbackQuery({ text: 'Launching...' });
  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {}); // remove the button
  return doLaunch(ctx);
});

bot.on('message:photo', async (ctx) => {
  const w = wizards.get(ctx.from.id);
  if (!w || w.step !== 'image') return;
  const p = ctx.message.photo.at(-1);
  return handleImage(ctx, w, p.file_id, 'image/jpeg', p.file_size);
});
bot.on('message:document', async (ctx) => {
  const w = wizards.get(ctx.from.id);
  if (!w || w.step !== 'image') return;
  const doc = ctx.message.document;
  return handleImage(ctx, w, doc.file_id, doc.mime_type, doc.file_size);
});

bot.on('message:text', async (ctx, next) => {
  const text = ctx.message.text;
  if (text.startsWith('/')) return next();
  if (awaitingImport.has(ctx.from.id)) {
    awaitingImport.delete(ctx.from.id);
    await ctx.deleteMessage().catch(() => {}); // remove the key from the chat
    let kp;
    try { kp = parseImport(text); } catch { return ctx.reply('That did not work. Check the key or seed phrase and tap Import wallet again.', { reply_markup: noWalletKb() }); }
    try {
      await saveLaunchWallet({
        telegramId: ctx.from.id, publicKey: kp.publicKey.toBase58(),
        encryptedSecret: encryptSecret(Buffer.from(kp.secretKey)), source: 'imported',
      });
    } catch (e) {
      if (e.code === '23505') return ctx.reply('You already have a launch wallet.');
      throw e;
    }
    await ctx.reply(`Wallet imported.\n\nAddress (tap to copy):\n${code(kp.publicKey.toBase58())}`, HTML);
    return showHome(ctx);
  }
  const w = wizards.get(ctx.from.id);
  if (w) return handleWizardText(ctx, w);
  return next();
});

bot.catch((err) => console.error('bot error:', err.error?.message ?? err.message)); // never log secrets

bot.start({ onStart: (me) => console.log(`Omni Launch Bot running as @${me.username}`) });
