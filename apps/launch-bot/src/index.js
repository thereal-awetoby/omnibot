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

const noWalletKb = () => new InlineKeyboard().text('Create wallet', 'create').text('Import wallet', 'import');
const mainKb = () =>
  new InlineKeyboard()
    .text('🚀 Create token', 'newtoken').row()
    .text('📂 My launches', 'launches').text('💼 Wallet', 'wallet').row()
    .text('🔑 Export key', 'exportkey').text('❓ Help', 'help').row()
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

const HELP = '<b>Omni Launch commands</b>\n\n/create - make a new token on pump.fun\n/launches - your previous launches\n/wallet - launch wallet and balance\n/createwallet - make a launch wallet\n/importwallet - use a wallet you already have\n/exportkey - show your private key\n/scan - open Omni Scan\n/trade - open Omni Trade\n\nTip: tap an address to copy it.';

const quote = (inner) => `<blockquote>${inner}</blockquote>`;

// Wallet + balance block shared by the home screen and /wallet.
async function walletBlock(w) {
  let bal = null;
  try { bal = await getSolBalance(w.public_key); } catch { /* RPC hiccup */ }
  const status = bal === null ? '' : bal >= CREATE_COST_SOL ? '\n✅ <i>Ready to launch</i>' : `\n⚠️ <i>Add at least ${CREATE_COST_SOL} SOL to launch a token</i>`;
  return (
    `💼 <b>Wallet</b>\n${quote(code(w.public_key))}\n` +
    `💰 <b>Balance</b>\n${quote(`<b>${bal === null ? '?' : fmtSol(bal)} SOL</b>`)}${status}`
  );
}

async function showHome(ctx) {
  const w = await getLaunchWallet(ctx.from.id);
  if (!w) {
    return ctx.reply(
      '🚀 <b>OMNI LAUNCH</b>\n<i>Launch a token on pump.fun in about a minute.</i>\n\n' +
      '💼 <b>Step 1: get a launch wallet</b>\n' + quote('Create a new one, or import one you already have.'),
      { ...HTML, reply_markup: noWalletKb() });
  }
  return ctx.reply(
    '🚀 <b>OMNI LAUNCH</b>\n<i>Launch a token on pump.fun in about a minute.</i>\n\n' +
    (await walletBlock(w)) + '\n\nTap <b>Create token</b> to start.',
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
    `✅ <b>Launch wallet created</b>\n\n💼 <b>Address</b> (tap to copy)\n${quote(code(kp.publicKey.toBase58()))}\n` +
    `🔑 <b>Private key</b>\n${quote(code(secretToBase58(kp)))}\n` +
    '⚠️ <b>Save the key somewhere safe NOW.</b> This message deletes itself in 60 seconds. Never share the key with anyone.\n\nSend SOL to the address above to fund your launches.',
    HTML);
  autoDelete(ctx, msg);
  return showHome(ctx);
}

async function doWallet(ctx) {
  const w = await getLaunchWallet(ctx.from.id);
  if (!w) return ctx.reply('No launch wallet yet.', { reply_markup: noWalletKb() });
  return ctx.reply(
    (await walletBlock(w)) + `\n\n<i>A launch needs about ${CREATE_COST_SOL} SOL for network costs, plus the first buy you choose. Tap the address to copy it, then send SOL to it.</i>`,
    { ...HTML, reply_markup: mainKb() });
}

async function doExport(ctx) {
  const w = await getLaunchWallet(ctx.from.id);
  if (!w) return ctx.reply('No launch wallet yet.', { reply_markup: noWalletKb() });
  const kp = keypairFromBytes(decryptSecret(w.encrypted_secret));
  const msg = await ctx.reply(
    `🔑 <b>Private key</b>\n${quote(code(secretToBase58(kp)))}\n💼 <b>Wallet</b>\n${quote(code(w.public_key))}\n⚠️ This message deletes itself in 60 seconds. Never share the key.`, HTML);
  autoDelete(ctx, msg);
}

async function startImport(ctx) {
  if (await getLaunchWallet(ctx.from.id)) return ctx.reply('You already have a launch wallet. Use /wallet to see it.');
  awaitingImport.add(ctx.from.id);
  return ctx.reply('Paste your private key (base58 or JSON array) or your 12/24-word seed phrase.\n\nI delete your message right after reading it. Send /start to cancel.');
}

// ---------- wizard ----------
// One message is edited in place for the whole flow, and your answers are deleted from the chat, so it stays clean.

const STEPS = ['name', 'symbol', 'description', 'image', 'twitter', 'telegram', 'website', 'devbuy'];
const LABEL = { name: 'Name', symbol: 'Ticker', description: 'Description', image: 'Logo', twitter: 'X', telegram: 'Telegram', website: 'Website', devbuy: 'First buy' };
const ASK = {
  name: 'What is your token called?\nUp to 32 characters.',
  symbol: 'What is the ticker?\nLetters or numbers, up to 10. Example: OMNI',
  description: 'Write a short description.\nUp to 500 characters.',
  image: `Send the logo as a picture.\nJPG, PNG, GIF or WEBP, up to ${MAX_IMAGE_BYTES / 1024 / 1024} MB. Square looks best.`,
  twitter: 'Your X (Twitter) link or @name.\nOptional.',
  telegram: 'Your Telegram group or channel link.\nOptional.',
  website: 'Your website link.\nOptional.',
  devbuy: 'How much SOL do you want to buy of your own token in the same transaction?\nPick a button or type an amount like 0.5. It is a normal buy from your wallet, visible on pump.fun like any other.',
};
const bar = (i) => '▰'.repeat(i + 1) + '▱'.repeat(STEPS.length - i - 1);

function collected(w) {
  const d = w.d;
  const rows = [];
  if (d.name) rows.push(`Name: ${esc(d.name)}`);
  if (d.symbol) rows.push(`Ticker: $${esc(d.symbol)}`);
  if (d.description) rows.push(`About: ${esc(d.description.length > 60 ? d.description.slice(0, 57) + '...' : d.description)}`);
  if (w.image) rows.push('Logo: ✅');
  return rows.join('\n');
}

function stepText(w, step, err) {
  const i = STEPS.indexOf(step);
  const done = collected(w);
  return (
    `<b>🚀 New token</b>\n${bar(i)}  ${i + 1}/${STEPS.length}\n\n` +
    (done ? `${done}\n\n` : '') +
    (err ? `⚠️ ${esc(err)}\n\n` : '') +
    `<b>${LABEL[step]}</b>\n${esc(ASK[step])}`
  );
}

function stepKb(w, step) {
  const kb = new InlineKeyboard();
  if (step === 'devbuy') kb.text('0', 'dev:0').text('0.1', 'dev:0.1').text('0.5', 'dev:0.5').text('1', 'dev:1').row();
  const i = STEPS.indexOf(step);
  if (w.editing) kb.text('⬅️ Back to summary', 'summary');
  else if (i > 0) kb.text('⬅️ Back', 'back');
  if (OPTIONAL[step]) kb.text('Skip', 'skip');
  return kb.text('✖️ Cancel', 'cancel');
}

// Edits the wizard message in place; sends a new one if that is not possible.
async function show(ctx, w, text, kb) {
  const other = { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: kb };
  if (w.msgId) {
    try { await ctx.api.editMessageText(ctx.chat.id, w.msgId, text, other); return; }
    catch (e) { if (/not modified/i.test(e.message)) return; }
  }
  const m = await ctx.reply(text, other);
  w.msgId = m.message_id;
}

async function ask(ctx, w, step, err) {
  w.step = step;
  return show(ctx, w, stepText(w, step, err), stepKb(w, step));
}

async function startWizard(ctx) {
  const wal = await getLaunchWallet(ctx.from.id);
  if (!wal) return ctx.reply('You need a launch wallet first.', { reply_markup: noWalletKb() });
  if (launching.has(ctx.from.id)) return ctx.reply('A launch is already in progress. Wait for it to finish.');
  const w = { step: 'name', d: {}, image: null, msgId: null, editing: false };
  wizards.set(ctx.from.id, w);
  return ask(ctx, w, 'name');
}

function summaryText(w) {
  const d = w.d;
  const dev = lamportsToSol(d.devBuyLamports);
  return (
    `<b>✅ Ready to launch?</b>\n\n` +
    `<b>${esc(d.name)}</b>  ($${esc(d.symbol)})\n${quote(esc(d.description))}\n` +
    `Logo: ✅\nX: ${d.twitter ? esc(d.twitter) : '-'}\nTelegram: ${d.telegram ? esc(d.telegram) : '-'}\nWebsite: ${d.website ? esc(d.website) : '-'}\n\n` +
    `First buy: ${dev > 0 ? fmtSol(dev) + ' SOL' : 'none'}\n` +
    `From your wallet: about ${fmtSol(lamportsToSol(neededLamports(d.devBuyLamports)))} SOL (${CREATE_COST_SOL} network costs${dev > 0 ? ' + first buy' : ''}). Unused network costs stay in your wallet.\n\n` +
    `Launching is final. Tap a button below to change anything first.`
  );
}

const summaryKb = () =>
  new InlineKeyboard()
    .text('🚀 Launch now', 'go').row()
    .text('Name', 'edit:name').text('Ticker', 'edit:symbol').text('About', 'edit:description').row()
    .text('Logo', 'edit:image').text('X', 'edit:twitter').text('Telegram', 'edit:telegram').row()
    .text('Website', 'edit:website').text('First buy', 'edit:devbuy').row()
    .text('✖️ Cancel', 'cancel');

async function showSummary(ctx, w) {
  w.step = 'confirm';
  w.editing = false;
  return show(ctx, w, summaryText(w), summaryKb());
}

async function advance(ctx, w, from) {
  if (w.editing) return showSummary(ctx, w);
  const next = NEXT[from];
  return next ? ask(ctx, w, next) : showSummary(ctx, w);
}

async function handleWizardText(ctx, w) {
  const t = ctx.message.text;
  await ctx.deleteMessage().catch(() => {}); // keep the chat tidy
  const fail = (r) => ask(ctx, w, w.step, r.error);
  switch (w.step) {
    case 'name': { const r = parseName(t); if (!r.ok) return fail(r); w.d.name = r.value; return advance(ctx, w, 'name'); }
    case 'symbol': { const r = parseSymbol(t); if (!r.ok) return fail(r); w.d.symbol = r.value; return advance(ctx, w, 'symbol'); }
    case 'description': { const r = parseDescription(t); if (!r.ok) return fail(r); w.d.description = r.value; return advance(ctx, w, 'description'); }
    case 'image': return ask(ctx, w, 'image', 'Please send a picture, not text.');
    case 'twitter': case 'telegram': case 'website': {
      const r = parseSocial(w.step, t); if (!r.ok) return fail(r);
      w.d[w.step] = r.value; return advance(ctx, w, w.step);
    }
    case 'devbuy': {
      const r = parseDevBuy(t); if (!r.ok) return fail(r);
      w.d.devBuyLamports = r.value; return showSummary(ctx, w);
    }
    default: return;
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
  await ctx.deleteMessage().catch(() => {});
  const chk = checkImage({ mime, size });
  if (!chk.ok) return ask(ctx, w, 'image', chk.error);
  try {
    const bytes = await downloadFile(ctx, fileId);
    if (bytes.length > MAX_IMAGE_BYTES) return ask(ctx, w, 'image', 'That image is too big (5 MB max).');
    w.image = { bytes, mime };
  } catch {
    return ask(ctx, w, 'image', 'I could not download that picture. Please send it again.');
  }
  return advance(ctx, w, 'image');
}

// ---------- launch ----------

const PROGRESS = ['Upload logo and details', 'Create the token on pump.fun', 'Confirm on Solana'];
const progressText = (d, at) =>
  `<b>🚀 Launching ${esc(d.name)} ($${esc(d.symbol)})</b>\n\n` +
  PROGRESS.map((p, i) => `${i < at ? '✅' : i === at ? '⏳' : '▫️'} ${p}`).join('\n') +
  '\n\nThis takes under a minute. Please wait.';

const doneKb = (mint, sig) => {
  const kb = new InlineKeyboard();
  if (mint) kb.url('pump.fun', `https://pump.fun/coin/${mint}`);
  if (sig) kb.url('Transaction', `https://solscan.io/tx/${sig}`);
  return kb.row().text('🚀 Create another', 'newtoken').text('📂 My launches', 'launches').row()
    .url('Omni Scan', `https://t.me/${SCAN_USERNAME}`).url('Omni Trade', `https://t.me/${TRADE_USERNAME}`);
};

async function doLaunch(ctx) {
  const uid = ctx.from.id;
  if (launching.has(uid)) return; // double tap: ignore
  const w = wizards.get(uid);
  if (!w || w.step !== 'confirm') return ctx.reply('Nothing to launch. Tap Create token to start.');
  launching.add(uid);
  const d = w.d;
  let launchId = null;
  const set = (text, kb) => show(ctx, w, text, kb ?? new InlineKeyboard());
  try {
    const wallet = await getLaunchWallet(uid);
    if (!wallet) return ctx.reply('You need a launch wallet first.', { reply_markup: noWalletKb() });
    const need = neededLamports(d.devBuyLamports);
    const have = Math.round((await getSolBalance(wallet.public_key)) * 1e9);
    if (have < need) {
      return show(ctx, w,
        `⚠️ Not enough SOL.\n\nYou need about ${fmtSol(lamportsToSol(need))} SOL but the wallet has ${fmtSol(lamportsToSol(have))} SOL.\n\nSend SOL to (tap to copy):\n${code(wallet.public_key)}\n\nThen tap Launch now again.\n\n` + summaryText(w),
        summaryKb());
    }
    wizards.delete(uid); // a second tap on "Launch now" can no longer start another launch
    launchId = await createLaunch({ telegramId: uid, ...d });
    await set(progressText(d, 0));

    const uri = await uploadMetadata({
      imageBytes: w.image.bytes, mime: w.image.mime, name: d.name, symbol: d.symbol,
      description: d.description, twitter: d.twitter, telegram: d.telegram, website: d.website,
    });
    await set(progressText(d, 1));

    const mint = newMintKeypair();
    const creator = keypairFromBytes(decryptSecret(wallet.encrypted_secret));
    const txBytes = await fetchCreateTx({
      publicKey: creator.publicKey.toBase58(), mintPublicKey: mint.publicKey.toBase58(),
      name: d.name, symbol: d.symbol, uri, devBuySol: lamportsToSol(d.devBuyLamports),
    });
    const raw = signCreateTx(txBytes, [mint, creator]);
    const mintAddr = mint.publicKey.toBase58();
    await set(progressText(d, 2));
    const r = await sendAndConfirm(connection, raw);

    if (r.status === 'success') {
      await finishLaunch(launchId, { status: 'success', mint: mintAddr, signature: r.signature, metadataUri: uri });
      return set(
        `🎉 <b>${esc(d.name)} ($${esc(d.symbol)}) is live!</b>\n\n📋 <b>Contract address</b> (tap to copy)\n${quote(code(mintAddr))}\n<i>Paste the address in Omni Scan to see its scan card.</i>`,
        doneKb(mintAddr, r.signature));
    }
    if (r.status === 'unknown') {
      await finishLaunch(launchId, { status: 'unknown', mint: mintAddr, signature: r.signature, metadataUri: uri, error: 'Sent but not confirmed in time' });
      return set(
        `<b>⏳ Sent, not confirmed yet</b>\n\nIt may still land. Check the transaction before trying again.\n\n📋 <b>Token address</b>\n${quote(code(mintAddr))}`,
        doneKb(null, r.signature));
    }
    await finishLaunch(launchId, { status: 'failed', metadataUri: uri, error: r.error });
    return set(`<b>❌ Launch failed</b>\n\n${esc(r.error)}\n\nNothing was created. You can try again.`, doneKb(null, null));
  } catch (err) {
    console.error('launch error:', err.message); // never log secrets
    if (launchId) await finishLaunch(launchId, { status: 'failed', error: String(err.message).slice(0, 200) }).catch(() => {});
    return set(`<b>❌ Launch failed</b>\n\n${esc(err.message)}\n\nTap Create another to try again.`, doneKb(null, null));
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
bot.command('help', (ctx) => ctx.reply(HELP, HTML));
bot.command('create', startWizard);
bot.command('launches', doLaunches);
bot.command('wallet', doWallet);
bot.command('createwallet', doCreateWallet);
bot.command('importwallet', startImport);
bot.command('exportkey', doExport);
bot.command('scan', (ctx) => ctx.reply('Omni Scan:', { reply_markup: new InlineKeyboard().url('Open Omni Scan', `https://t.me/${SCAN_USERNAME}`) }));
bot.command('trade', (ctx) => ctx.reply('Omni Trade:', { reply_markup: new InlineKeyboard().url('Open Omni Trade', `https://t.me/${TRADE_USERNAME}`) }));

bot.callbackQuery('help', async (ctx) => { await ctx.answerCallbackQuery(); return ctx.reply(HELP, HTML); });
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
  return showHome(ctx);
});
bot.callbackQuery('skip', async (ctx) => {
  await ctx.answerCallbackQuery();
  const w = wizards.get(ctx.from.id);
  if (!w || !OPTIONAL[w.step]) return;
  const step = w.step;
  w.d[step] = null;
  return advance(ctx, w, step);
});
bot.callbackQuery('back', async (ctx) => {
  await ctx.answerCallbackQuery();
  const w = wizards.get(ctx.from.id);
  if (!w) return;
  const i = STEPS.indexOf(w.step);
  if (i > 0) return ask(ctx, w, STEPS[i - 1]);
});
bot.callbackQuery('summary', async (ctx) => {
  await ctx.answerCallbackQuery();
  const w = wizards.get(ctx.from.id);
  if (w && w.d.name) return showSummary(ctx, w);
});
bot.callbackQuery(/^edit:(\w+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const w = wizards.get(ctx.from.id);
  const step = ctx.match[1];
  if (!w || !STEPS.includes(step)) return;
  w.editing = true;
  return ask(ctx, w, step);
});
bot.callbackQuery(/^dev:([\d.]+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const w = wizards.get(ctx.from.id);
  if (!w || w.step !== 'devbuy') return;
  w.d.devBuyLamports = parseDevBuy(ctx.match[1]).value;
  return showSummary(ctx, w);
});
bot.callbackQuery('go', async (ctx) => {
  await ctx.answerCallbackQuery({ text: 'Launching...' });
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
  if (w && w.step !== 'confirm') return handleWizardText(ctx, w);
  return next();
});

bot.catch((err) => console.error('bot error:', err.error?.message ?? err.message)); // never log secrets

bot.start({
  onStart: async (me) => {
    console.log(`Omni Launch Bot running as @${me.username}`);
    await bot.api.setMyCommands([
      { command: 'create', description: 'Create a new token' },
      { command: 'launches', description: 'My launches' },
      { command: 'wallet', description: 'Launch wallet and balance' },
      { command: 'help', description: 'Help' },
      { command: 'start', description: 'Home' },
    ]).catch(() => {});
  },
});
