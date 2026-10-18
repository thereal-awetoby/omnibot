import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeHolderStats, computeFresh, findBundle } from './security.js';

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

test('findBundle groups holders who first got the token in the same block as the earliest buyer', () => {
  const e = (owner, pct, firstSlot) => ({ owner, pct, firstSlot });
  assert.deepEqual(findBundle([e('a', 3, 100), e('b', 2.5, 100), e('c', 1.2, 101), e('d', 4, 500)]), { count: 3, pct: 6.7, slot: 100 });
  assert.deepEqual(findBundle([e('a', 3, 100), e('b', 2.5, 300), e('c', 1.2, 900)]), { count: 0, pct: 0, slot: null });
  assert.equal(findBundle([e('a', 3, 100)]), null); // too little to tell
  assert.equal(findBundle([e('a', 3, null), e('b', 2, undefined)]), null);
  assert.equal(findBundle(null), null);
  assert.deepEqual(findBundle([e('a', 1, 10), e('b', 1, 12)], 2), { count: 2, pct: 2, slot: 10 }); // wider window
});
