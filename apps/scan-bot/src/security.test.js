import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeHolderStats, computeFresh, assessRisk } from './security.js';

const acc = (address, amount) => ({ address, amount: String(amount) });

test('computeHolderStats excludes pools, burn and curve, and merges accounts of one owner', () => {
  const largest = [acc('t1', 400), acc('t2', 100), acc('t3', 90), acc('t4', 60), acc('t5', 50), acc('t6', 50), acc('t7', 20)];
  const owners = new Map([
    ['t1', 'POOL'],                                   // liquidity pool: excluded
    ['t2', 'whale'], ['t3', 'whale'],                 // same wallet: merged = 190
    ['t4', '1nc1nerator11111111111111111111111111111111'], // burned: excluded
    ['t5', 'a'], ['t6', 'b'],
    // t7 has no known owner: falls back to the account itself
  ]);
  const s = computeHolderStats(largest, owners, 1000n, new Set(['POOL']));
  assert.equal(s.top1Pct, 19);          // whale 190 / 1000
  assert.equal(s.top5Pct, 31);          // 190 + 50 + 50 + 20 = 310
  assert.equal(s.top10Pct, 31);
  assert.equal(s.holdersCounted, 4);
});

test('computeHolderStats handles empty/zero supply', () => {
  assert.equal(computeHolderStats([], new Map(), 0n), null);
  const s = computeHolderStats([], new Map(), 1000n);
  assert.equal(s.top1Pct, 0);
});

test('assessRisk: clean token is low, dangerous token is high', () => {
  const now = 1_700_000_000_000;
  const good = assessRisk({ security: { mintAuthority: null, freezeAuthority: null, top1Pct: 3, top10Pct: 18 }, market: { liquidityUsd: 90_000, marketCapUsd: 900_000, createdAt: now - 86_400_000 }, now });
  assert.equal(good.level, 'low');
  assert.deepEqual(good.flags, []);
  assert.equal(good.partial, false);

  const bad = assessRisk({ security: { mintAuthority: 'x', freezeAuthority: 'y', top1Pct: 30, top10Pct: 70 }, market: { liquidityUsd: 3000, marketCapUsd: 300_000, createdAt: now - 60_000 }, now });
  assert.equal(bad.level, 'high');
  assert.ok(bad.flags.length >= 6);
});

test('assessRisk: medium band, partial data and unknown fields', () => {
  const now = 1_700_000_000_000;
  const mid = assessRisk({ security: { mintAuthority: null, freezeAuthority: null, top1Pct: 12, top10Pct: 35 }, market: { liquidityUsd: 10_000, marketCapUsd: 100_000, createdAt: now - 86_400_000 }, now });
  assert.equal(mid.level, 'medium'); // 1 + 1 + 1 = 3
  const none = assessRisk({ security: null, market: null, now });
  assert.equal(none.level, 'low');
  assert.equal(none.partial, true);
  const nullHolders = assessRisk({ security: { mintAuthority: null, freezeAuthority: null, top1Pct: null, top10Pct: null }, market: {}, now });
  assert.equal(nullHolders.flags.length, 0);
});

test('computeHolderStats returns the ranked top holders for later wallet checks', () => {
  const s = computeHolderStats([acc('t1', 300), acc('t2', 100), acc('t3', 50)], new Map([['t1', 'w1'], ['t2', 'w2'], ['t3', 'w3']]), 1000n);
  assert.deepEqual(s.top, [{ owner: 'w1', pct: 30 }, { owner: 'w2', pct: 10 }, { owner: 'w3', pct: 5 }]);
});

test('computeFresh sums supply held by new wallets and ignores unknown ages', () => {
  const top = [{ owner: 'a', pct: 10 }, { owner: 'b', pct: 5 }, { owner: 'c', pct: 4 }, { owner: 'd', pct: 3 }];
  const ages = new Map([['a', 0.2], ['b', 3], ['c', 400], ['d', null]]);
  assert.deepEqual(computeFresh(top, ages), { fresh1dPct: 10, fresh7dPct: 15, walletsChecked: 3 });
  assert.equal(computeFresh(top, new Map()), null);
  assert.equal(computeFresh([], new Map()), null);
});

test('assessRisk uses insiders, LP lock, dev holding, fresh wallets and rugged flag', () => {
  const now = 1_700_000_000_000;
  const sec = { mintAuthority: null, freezeAuthority: null, top1Pct: 3, top10Pct: 18 };
  const mk = { liquidityUsd: 90_000, marketCapUsd: 900_000, createdAt: now - 86_400_000 };
  const clean = assessRisk({ security: sec, market: mk, now, intel: { insiderPct: 2, lpLockedPct: 100, devPct: 0, fresh7dPct: 4, rugged: false } });
  assert.equal(clean.level, 'low');
  const bad = assessRisk({ security: sec, market: mk, now, intel: { insiderPct: 35, lpLockedPct: 0, devPct: 20, fresh7dPct: 40, rugged: false } });
  assert.equal(bad.level, 'high'); // 2 + 2 + 2 + 1 = 7
  assert.equal(bad.flags.length, 4);
  const rugged = assessRisk({ security: sec, market: mk, now, intel: { rugged: true } });
  assert.equal(rugged.level, 'high');
  const nulls = assessRisk({ security: sec, market: mk, now, intel: { insiderPct: null, lpLockedPct: null, devPct: null, fresh7dPct: null } });
  assert.equal(nulls.flags.length, 0);
});
