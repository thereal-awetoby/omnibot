import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRugCheck, fetchRugCheck, parseOhlcv, fetchAth, describeAth, parsePumpCreated, fetchPumpCreated } from './sources.js';

const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

const report = {
  totalHolders: 1812, creator: 'DEV', rugged: false,
  topHolders: [
    { owner: 'POOL', pct: 40, insider: false }, { owner: 'a', pct: 8, insider: true }, { owner: 'b', pct: 5.5, insider: true }, { owner: 'c', pct: 3, insider: false },
  ],
  knownAccounts: { POOL: { name: 'Raydium', type: 'AMM' } },
  insiderNetworks: [{ id: 1, size: 4 }, { id: 2, activeAccounts: 3 }],
  markets: [
    { lp: { lpLockedPct: 0, baseUSD: 10, quoteUSD: 10 } },
    { lp: { lpLockedPct: 100, baseUSD: 5000, quoteUSD: 5000 } },
  ],
  risks: [{ name: 'Low Liquidity', level: 'warn' }, { name: 'ok thing', level: 'info' }, { name: 'Mint Authority still enabled', level: 'danger' }],
};

test('parseRugCheck keeps what the card needs and skips pools when summing insiders', () => {
  const r = parseRugCheck(report);
  assert.equal(r.totalHolders, 1812);
  assert.equal(r.insiderPct, 13.5);
  assert.equal(r.insiderNetworks, 2);
  assert.equal(r.insiderWallets, 7);
  assert.deepEqual(r.top.map((h) => h.owner), ['a', 'b', 'c']); // pool removed
  assert.equal(r.top1Pct, 8);
  assert.equal(r.top10Pct, 16.5);
  assert.equal(r.lpLockedPct, 100); // the biggest pool wins, not the first
  assert.equal(r.creator, 'DEV');
  assert.equal(r.rugged, false);
  assert.deepEqual(r.risks.map((x) => x.name), ['Low Liquidity', 'Mint Authority still enabled']);
});

test('parseRugCheck survives empty and odd payloads', () => {
  assert.equal(parseRugCheck(null), null);
  const r = parseRugCheck({});
  assert.equal(r.totalHolders, null);
  assert.equal(r.insiderPct, null);
  assert.equal(r.lpLockedPct, null);
  assert.equal(r.creator, null);
  assert.deepEqual(r.risks, []);
  assert.equal(parseRugCheck({ rugged: true }).rugged, true);
  assert.equal(parseRugCheck({ markets: [{ lp: { lpLockedPct: 250 } }] }).lpLockedPct, 100);
});

test('fetchRugCheck calls the keyless endpoint, caches, and returns null on errors', async () => {
  let calls = 0; let url;
  const impl = async (u) => { calls += 1; url = u; return json(report); };
  const a = await fetchRugCheck('MINT_RUG_1', impl);
  const b = await fetchRugCheck('MINT_RUG_1', impl);
  assert.equal(url, 'https://api.rugcheck.xyz/v1/tokens/MINT_RUG_1/report');
  assert.equal(calls, 1);
  assert.equal(a.totalHolders, b.totalHolders);
  assert.equal(await fetchRugCheck('MINT_RUG_2', async () => json({}, 500)), null);
  assert.equal(await fetchRugCheck('MINT_RUG_3', async () => { throw new Error('offline'); }), null);
});

test('parseOhlcv finds the highest high and its time', () => {
  const candles = [[1000, 1, 2, 0.5, 1.5, 10], [2000, 1.5, 9, 1, 3, 10], [3000, 3, 4, 2, 2.5, 10], [4000, 1, 'x', 1, 1, 1]];
  assert.deepEqual(parseOhlcv(candles), { athPrice: 9, athAt: 2_000_000 });
  assert.equal(parseOhlcv([]), null);
  assert.equal(parseOhlcv(null), null);
});

test('describeAth converts to market cap and distance from ATH', () => {
  const market = { priceUsd: 0.5, marketCapUsd: 500_000 }; // supply = 1,000,000
  const d = describeAth({ athPrice: 1, athAt: 5 }, market);
  assert.equal(d.athMcapUsd, 1_000_000);
  assert.equal(d.fromAthPct, -50);
  assert.equal(describeAth(null, market), null);
  assert.equal(describeAth({ athPrice: 1, athAt: 5 }, { priceUsd: 0, marketCapUsd: 1 }), null);
});

test('fetchAth picks hourly for young pools, daily for old, caches, and pauses after a 429', async () => {
  const now = 1_800_000_000_000;
  const urls = [];
  const ok = async (u) => { urls.push(u); return json({ data: { attributes: { ohlcv_list: [[10, 1, 7, 1, 1, 1]] } } }); };
  const young = await fetchAth({ pairAddress: 'POOL_Y', mint: 'M', createdAt: now - 3_600_000 }, ok, now);
  assert.deepEqual(young, { athPrice: 7, athAt: 10_000 });
  assert.match(urls[0], /pools\/POOL_Y\/ohlcv\/hour\?aggregate=1&limit=1000/);
  assert.match(urls[0], /token=M$/);
  await fetchAth({ pairAddress: 'POOL_O', mint: 'M', createdAt: now - 90 * 86_400_000 }, ok, now);
  assert.match(urls[1], /ohlcv\/day/);
  await fetchAth({ pairAddress: 'POOL_Y', mint: 'M', createdAt: now - 3_600_000 }, ok, now); // cached
  assert.equal(urls.length, 2);
  assert.equal(await fetchAth({ pairAddress: 'P3', mint: 'M' }, async () => json({}, 429), now), null);
  assert.equal(await fetchAth({ pairAddress: 'P4', mint: 'M' }, ok, now + 1000), null); // paused
  assert.equal(urls.length, 2);
  assert.equal(await fetchAth({ pairAddress: null, mint: 'M' }, ok, now + 120_000), null);
});

test('parseRugCheck keeps the insider flag per holder, the creator info and the token description', () => {
  const r = parseRugCheck({
    ...report, detectedAt: '2026-10-17T10:00:00Z',
    fileMeta: { name: 'Barber Dog', symbol: 'BDOG', description: '  A dog at the barber.  ' },
  });
  assert.deepEqual(r.top.map((h) => h.insider), [true, true, false]);
  assert.deepEqual(r.meta, { name: 'Barber Dog', symbol: 'BDOG', description: 'A dog at the barber.' });
  assert.equal(r.detectedAt, Date.parse('2026-10-17T10:00:00Z'));
  const none = parseRugCheck({});
  assert.deepEqual(none.meta, { name: null, symbol: null, description: null });
  assert.equal(none.detectedAt, null);
  assert.equal(parseRugCheck({ fileMeta: { description: 42 }, detectedAt: 'nope' }).meta.description, null);
});

const A1 = 'So11111111111111111111111111111111111111112';
test('parsePumpCreated reads coins from a few shapes and drops junk', () => {
  const coins = [{ mint: A1, symbol: 'AAA', created_timestamp: 1_700_000_000_000 }, { mint: 'bad' }, null, { mint: A1, created_timestamp: 1_700_000_000 }];
  for (const body of [coins, { coins }, { data: coins }]) {
    const out = parsePumpCreated(body);
    assert.equal(out.length, 2);
    assert.deepEqual(out[0], { mint: A1, symbol: 'AAA', createdAt: 1_700_000_000_000 });
    assert.equal(out[1].createdAt, 1_700_000_000_000); // seconds are converted to ms
    assert.equal(out[1].symbol, null);
  }
  assert.equal(parsePumpCreated({ message: 'nope' }), null);
  assert.equal(parsePumpCreated(null), null);
});

test('fetchPumpCreated asks the creator endpoint and returns null when it fails', async () => {
  let url;
  const out = await fetchPumpCreated('CREATOR1', async (u) => { url = u; return json([{ mint: A1 }]); });
  assert.match(url, /^https:\/\/frontend-api-v3\.pump\.fun\/coins\/user-created-coins\/CREATOR1\?/);
  assert.equal(out.length, 1);
  assert.equal(await fetchPumpCreated('C', async () => json({}, 404)), null);
  assert.equal(await fetchPumpCreated('C', async () => { throw new Error('offline'); }), null);
});
