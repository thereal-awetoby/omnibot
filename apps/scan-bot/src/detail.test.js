import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createdMintsFromTx, mergeLaunches, buildDevText, valueHoldings, buildHoldersText, buildLoreText, isAddr, walletLink } from './detail.js';

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

test('mergeLaunches hides the current token, fills from market data, sorts newest first', () => {
  const launches = [{ mint: M1, createdAt: 1000, symbol: 'old' }, { mint: M2, createdAt: 5000 }, { mint: 'CUR', createdAt: 9000 }];
  const markets = new Map([[M1, { symbol: 'AAA', marketCapUsd: 250_000 }]]);
  const out = mergeLaunches(launches, markets, 'CUR');
  assert.deepEqual(out.map((l) => l.mint), [M2, M1]);
  assert.equal(out[1].symbol, 'AAA');
  assert.equal(out[1].marketCapUsd, 250_000);
  assert.equal(out[0].marketCapUsd, null);
});

test('buildDevText: wallet, balance, holding, launches summary', () => {
  const launches = [
    { mint: M1, symbol: 'AAA<', createdAt: NOW - 3 * 86_400_000, marketCapUsd: 250_000 },
    { mint: M2, symbol: null, createdAt: NOW - 41 * 86_400_000, marketCapUsd: null },
  ];
  const t = buildDevText({ market: { symbol: 'BDOG' }, creator: DEV, devPct: 0, solBalance: 12.345, launches, source: 'pump', now: NOW });
  assert.match(t, /Dev<\/b> · \$BDOG/);
  assert.match(t, /solscan\.io\/account\/DevWa11et/);
  assert.match(t, /◎ 12\.3 SOL/);
  assert.match(t, /Holds <b>0%<\/b>/);
  assert.match(t, /<b>2<\/b> found · 1 now over \$100K · earliest 41d ago/);
  assert.match(t, /1\. \$AAA&lt; · \$250\.00K · 3d ago/);
  assert.match(t, /2\. <code>EPjF…Dt1v<\/code> · no market data · 41d ago/);
  assert.doesNotMatch(t, /last \d+ transactions/);
  assert.match(buildDevText({ market: null, creator: DEV, launches: [], source: 'rpc', scannedTx: 40, now: NOW }), /None found from this wallet[\s\S]*last 40 transactions/);
  assert.match(buildDevText({ market: null, creator: DEV, launches: null, now: NOW }), /Could not load/);
  assert.match(buildDevText({ market: null, creator: null }), /not known yet/);
  const many = Array.from({ length: 11 }, (_, i) => ({ mint: M1, symbol: `T${i}`, createdAt: NOW - i * 1000, marketCapUsd: 1 }));
  assert.match(buildDevText({ market: null, creator: DEV, launches: many, now: NOW }), /…and 3 more/);
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

test('buildHoldersText: ranks, links, balances, other holdings, linked marker', () => {
  const holders = [
    { owner: DEV, pct: 3.46, linked: true, sol: 12.3, holdings: { top: [{ symbol: 'WIF', usd: 1200 }, { symbol: null, usd: 400 }], count: 4, totalUsd: 2100 } },
    { owner: M1, pct: 2.2, linked: false, sol: 0.5, holdings: { top: [], count: 0, totalUsd: 0 } },
    { owner: M2, pct: 1.1, linked: false, sol: null, holdings: null },
  ];
  const t = buildHoldersText({ market: { symbol: 'BDOG' }, holders });
  assert.match(t, /Top holders<\/b> · \$BDOG/);
  assert.match(t, /1\. <a href="https:\/\/solscan\.io\/account\/DevWa11et[^"]*">DevW…evW1<\/a>  <b>3\.5%<\/b> 🔗/);
  assert.match(t, /◎ 12\.3 SOL · 4 other tokens · ~\$2\.10K/);
  assert.match(t, /\$WIF \$1\.20K · token \$400\.00/);
  assert.match(t, /2\. .*<b>2\.2%<\/b>\n   ◎ 0\.50 SOL · no other tokens/);
  assert.match(t, /3\. .*\n   holdings unavailable/);
  assert.match(t, /🔗 = flagged as linked/);
  assert.match(buildHoldersText({ market: null, holders: [] }), /not available/);
  assert.doesNotMatch(buildHoldersText({ market: null, holders: holders.slice(1) }), /flagged as linked/);
});

test('buildLoreText: escaped description, trimmed, with first-seen time', () => {
  const t = buildLoreText({ market: { symbol: 'BDOG' }, meta: { description: 'A <b>dog</b>   at the\nbarber & more.' }, detectedAt: NOW - 23 * 60_000, now: NOW });
  assert.match(t, /Lore<\/b> · \$BDOG/);
  assert.match(t, /<blockquote>A &lt;b&gt;dog&lt;\/b&gt; at the barber &amp; more\.<\/blockquote>/);
  assert.match(t, /First seen 23m ago/);
  const long = buildLoreText({ market: null, meta: { description: 'x'.repeat(2000) } });
  assert.ok(long.length < 900);
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
