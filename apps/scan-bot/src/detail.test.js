import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createdMintsFromTx, mergeLaunches, buildDevText, valueHoldings, buildHoldersText, buildLoreText, isAddr, walletLink, usdShort } from './detail.js';

const DEV = 'DevWa11etDevWa11etDevWa11etDevWa11etDevW1';
const M1 = 'So11111111111111111111111111111111111111112';
const M2 = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const NOW = 1_800_000_000_000;

// A parsed transaction like web3.js returns (pubkeys can be objects with toString, or plain strings).
const key = (k, signer = false) => ({ pubkey: { toString: () => k }, signer });
const tx = (payer, { err = null, top = [], inner = [] } = {}) => ({
  blockTime: 1_700_000_000,
  meta: { err, innerInstructions: [{ index: 0, instructions: inner }] },
  transaction: { message: { accountKeys: [key(payer, true), key('X')], instructions: top } },
});
const initMint = (mint, type = 'initializeMint2') => ({ program: 'spl-token', parsed: { type, info: { mint } } });

test('createdMintsFromTx finds mints created by the wallet, in inner and top-level instructions', () => {
  assert.deepEqual(createdMintsFromTx(tx(DEV, { inner: [initMint(M1)] }), DEV), [M1]);
  assert.deepEqual(createdMintsFromTx(tx(DEV, { top: [initMint(M2, 'initializeMint')], inner: [initMint(M1)] }), DEV).sort(), [M1, M2].sort());
  assert.deepEqual(createdMintsFromTx(tx(DEV, { inner: [initMint(M1), initMint(M1)] }), DEV), [M1]); // deduped
});

test('createdMintsFromTx ignores failed transactions, other payers and non-mint steps', () => {
  assert.deepEqual(createdMintsFromTx(tx(DEV, { err: { InstructionError: [0, 'x'] }, inner: [initMint(M1)] }), DEV), []);
  assert.deepEqual(createdMintsFromTx(tx('SOMEONE_ELSE', { inner: [initMint(M1)] }), DEV), []);
  assert.deepEqual(createdMintsFromTx(tx(DEV, { inner: [{ parsed: { type: 'transfer', info: { mint: M1 } } }, { data: 'raw' }] }), DEV), []);
  assert.deepEqual(createdMintsFromTx(null, DEV), []);
  assert.deepEqual(createdMintsFromTx({}, DEV), []);
  // plain-string account keys work too
  const plain = tx(DEV, { inner: [initMint(M1)] });
  plain.transaction.message.accountKeys = [DEV, 'X'];
  assert.deepEqual(createdMintsFromTx(plain, DEV), [M1]);
});

test('mergeLaunches dedupes, flags the current token, fills from market data, sorts newest first', () => {
  const launches = [{ mint: M1, createdAt: 1000, symbol: 'old' }, { mint: M2, createdAt: 5000 }, { mint: 'CUR', createdAt: 9000 }, { mint: M2, createdAt: 5000 }];
  const markets = new Map([[M1, { symbol: 'AAA', marketCapUsd: 250_000 }]]);
  const out = mergeLaunches(launches, markets, 'CUR');
  assert.deepEqual(out.map((l) => l.mint), ['CUR', M2, M1]);
  assert.deepEqual(out.map((l) => l.current), [true, false, false]);
  assert.equal(out[2].symbol, 'AAA');
  assert.equal(out[2].marketCapUsd, 250_000);
  assert.equal(out[1].marketCapUsd, null);
});

test('buildDevText: wallet, deploys/day, recent and top launches, copyable address', () => {
  const D = 86_400_000;
  const launches = [
    { mint: 'CUR', symbol: 'BDOG', createdAt: NOW - 18 * 3_600_000, marketCapUsd: 18_690, current: true },
    { mint: M1, symbol: 'ACAT<', createdAt: NOW - 2 * D, marketCapUsd: 2_900 },
    { mint: M2, symbol: null, createdAt: NOW - 10 * D, marketCapUsd: 775_000 },
  ];
  const t = buildDevText({ market: { symbol: 'BDOG' }, creator: DEV, devPct: 0, solBalance: 12.345, launches, source: 'pump', now: NOW });
  assert.match(t, /^👨‍💻 <a href="https:\/\/solscan\.io\/account\/DevWa11et[^"]*">DevW…evW1<\/a>\n/);
  assert.match(t, /├ Deploys\/day: <b>0\.3<\/b>\n├ Balance: ◎ 12\.3 SOL\n└ Holds <b>0%<\/b> of \$BDOG/);
  assert.match(t, /🔄 <b>Recent launches<\/b> \[3\]/);
  assert.match(t, /<b>BDOG<\/b> @ \$18\.69K  ◀ this token/);
  assert.match(t, /<b>ACAT&lt;<\/b> @ \$2\.90K/);
  assert.match(t, /🚀 <b>Top launches<\/b>[\s\S]*<b>EPjF…Dt1v<\/b> @ \$775\.00K/);
  assert.match(t, /<code>DevWa11etDevWa11etDevWa11etDevWa11etDevW1<\/code>/);
  assert.doesNotMatch(t, /last \d+ transactions/);
  assert.match(buildDevText({ market: null, creator: DEV, launches: [], source: 'rpc', scannedTx: 120, now: NOW }), /None found from this wallet[\s\S]*last 120 transactions/);
  assert.match(buildDevText({ market: null, creator: DEV, launches: null, now: NOW }), /Could not load/);
  assert.match(buildDevText({ market: null, creator: null }), /not known yet/);
  const many = Array.from({ length: 50 }, (_, i) => ({ mint: M1, symbol: `T${i}`, createdAt: NOW - (i + 1) * D, marketCapUsd: 1000 + i }));
  const big = buildDevText({ market: null, creator: DEV, launches: many, source: 'pump', now: NOW });
  assert.match(big, /Recent launches<\/b> \[50\+\]/);
  assert.match(big, /Deploys\/day: <b>1\.0<\/b>/);
  assert.equal((big.match(/<b>T\d+<\/b>/g) ?? []).length, 10); // 5 recent + 5 top
});

test('valueHoldings values only real pairs, skips the current token and shows the top three', () => {
  const prices = new Map([
    ['A', { symbol: 'AAA', priceUsd: 2, liquidityUsd: 50_000 }],
    ['B', { symbol: 'BBB', priceUsd: 1, liquidityUsd: 50_000 }],
    ['C', { symbol: 'CCC', priceUsd: 0.1, liquidityUsd: 50_000 }],
    ['D', { symbol: 'DDD', priceUsd: 10, liquidityUsd: 50_000 }],
    ['THIN', { symbol: 'FAKE', priceUsd: 1_000_000, liquidityUsd: 200 }],
  ]);
  const tokens = [{ mint: 'A', amount: 100 }, { mint: 'B', amount: 100 }, { mint: 'C', amount: 100 }, { mint: 'D', amount: 5 }, { mint: 'THIN', amount: 1e6 }, { mint: 'NOPRICE', amount: 7 }, { mint: 'CUR', amount: 9 }, { mint: 'ZERO', amount: 0 }];
  const v = valueHoldings(tokens, prices, 'CUR');
  assert.deepEqual(v.top.map((t) => t.symbol), ['AAA', 'BBB', 'DDD'].sort((a, b) => ({ AAA: 200, BBB: 100, DDD: 50 })[b] - ({ AAA: 200, BBB: 100, DDD: 50 })[a]));
  assert.equal(v.totalUsd, 200 + 100 + 10 + 50);
  assert.equal(v.count, 6); // A B C D + THIN + NOPRICE (CUR and ZERO skipped)
  assert.deepEqual(valueHoldings(null, prices, 'CUR'), { top: [], count: 0, totalUsd: 0 });
});

test('buildHoldersText: one small block per wallet, share on top, details underneath', () => {
  const holders = [
    { owner: DEV, pct: 3.46, linked: true, sol: 12.3, holdings: { top: [{ symbol: 'WIF', usd: 1200 }, { symbol: null, usd: 400 }, { symbol: 'X', usd: 5 }], count: 1400, totalUsd: 14_800 } },
    { owner: M1, pct: 2.2, linked: false, sol: 0.5, holdings: { top: [], count: 0, totalUsd: 0 } },
    { owner: M2, pct: 1.1, linked: false, sol: null, holdings: null },
  ];
  const t = buildHoldersText({ market: { symbol: 'BDOG' }, holders });
  assert.match(t, /Top holders<\/b> · \$BDOG/);
  assert.match(t, /<b>1\.<\/b> <a href="https:\/\/solscan\.io\/account\/DevWa11et[^"]*">DevW…evW1<\/a> · <b>3\.5%<\/b> 🔗\n├ ◎ 12\.3 SOL\n├ 1\.4K other tokens · ~\$14\.80K\n└ \$WIF \$1\.20K · token \$400\n/);
  assert.match(t, /<b>2\.<\/b> .* · <b>2\.2%<\/b>\n├ ◎ 0\.50 SOL\n└ No other tokens\n/);
  assert.match(t, /<b>3\.<\/b> .* · <b>1\.1%<\/b>\n└ Other tokens: unavailable/);
  assert.doesNotMatch(t, /\$X /); // only the top two are listed
  assert.match(t, /🔗 = flagged as linked/);
  assert.match(buildHoldersText({ market: null, holders: [] }), /not available/);
  assert.doesNotMatch(buildHoldersText({ market: null, holders: holders.slice(1) }), /flagged as linked/);
});

test('usdShort', () => {
  assert.equal(usdShort(14_800), '$14.80K');
  assert.equal(usdShort(377.3), '$377');
  assert.equal(usdShort(0.004), '$0.00');
  assert.equal(usdShort(NaN), 'n/a');
});

test('buildLoreText: AI story first, creator description as fallback, then a plain note', () => {
  const ai = buildLoreText({ market: { symbol: 'BDOG' }, narrative: 'A <b>dog</b> at the barber & more.', meta: { description: 'creator text' }, detectedAt: NOW - 23 * 60_000, now: NOW });
  assert.match(ai, /Lore<\/b> · \$BDOG/);
  assert.match(ai, /<blockquote>A &lt;b&gt;dog&lt;\/b&gt; at the barber &amp; more\.<\/blockquote>/);
  assert.match(ai, /Written by AI/);
  assert.doesNotMatch(ai, /creator text/);
  assert.match(ai, /First seen 23m ago/);
  const own = buildLoreText({ market: null, meta: { description: 'A dog   at\nthe barber' } });
  assert.match(own, /<blockquote>A dog at the barber<\/blockquote>/);
  assert.match(own, /Written by the token's creator/);
  const long = buildLoreText({ market: null, narrative: 'x'.repeat(2000) });
  assert.ok(long.length < 1000);
  assert.match(long, /…<\/blockquote>/);
  assert.match(buildLoreText({ market: null, meta: null }), /did not publish a description/);
});

test('address helpers', () => {
  assert.equal(isAddr(M1), true);
  assert.equal(isAddr('short'), false);
  assert.equal(isAddr(null), false);
  assert.match(walletLink('not an address <b>'), /^not an addre$/);
  assert.doesNotMatch(walletLink('<script>'), /<script>/);
});

test('Dev view with only this token still shows data and explains the gap', () => {
  const W = 'G6NnKQTgN7Dmo9yrJXwoqiDm35FznQmQ1qXVFAXPpump';
  const launches = mergeLaunches([{ mint: W, createdAt: 1_700_000_000_000 - 3_600_000 }], new Map([[W, { symbol: 'BDOG', marketCapUsd: 18_690 }]]), W);
  const text = buildDevText({ market: { symbol: 'BDOG' }, creator: W, devPct: 0, solBalance: 1.5, launches, source: 'rpc', scannedTx: 0, partial: true, now: 1_700_000_000_000 });
  assert.match(text, /Recent launches/);
  assert.match(text, /BDOG<\/b> @ \$18\.69K  ◀ this token/);
  assert.match(text, /older launches may be missing/);
});

test('buildLoreText: honest labels for searched vs listing-only AI, and news headlines', () => {
  const NOW2 = Date.parse('2026-10-18T12:00:00Z');
  const searched = buildLoreText({ market: { symbol: 'BDOG' }, narrative: 'A dog at the barber.', grounded: true, now: NOW2 });
  assert.match(searched, /Written by AI from a web search/);
  const listing = buildLoreText({ market: { symbol: 'BDOG' }, narrative: 'A dog at the barber.', grounded: false, now: NOW2 });
  assert.match(listing, /own listing and linked post, no web search/);
  const news = buildLoreText({ market: { symbol: 'BDOG' }, meta: null, now: NOW2, headlines: [{ title: 'Barber Dog <memecoin> goes viral', url: 'https://n.com/a?x=1&y=2', source: 'CoinDesk', at: NOW2 - 3 * 3_600_000 }] });
  assert.match(news, /In the news/);
  assert.match(news, /<a href="https:\/\/n\.com\/a\?x=1&amp;y=2">Barber Dog &lt;memecoin&gt; goes viral<\/a> <i>\(CoinDesk, 3h ago\)<\/i>/);
  assert.doesNotMatch(news, /did not publish/); // headlines count as something to show
});

test('buildLoreText: debug note explains why there is no AI summary (owner only, escaped)', () => {
  const t = buildLoreText({ market: null, meta: null, debugNote: 'Gemini returned HTTP 403: <API key not valid>' });
  assert.match(t, /AI summary unavailable: Gemini returned HTTP 403: &lt;API key not valid&gt;/);
  assert.doesNotMatch(buildLoreText({ market: null, meta: null }), /unavailable/);
});
