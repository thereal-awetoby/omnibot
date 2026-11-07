import { test } from 'node:test';
import assert from 'node:assert/strict';
import { livePrices, parseMilestoneArg, buildMilestoneSettingText, buildMilestoneCaption, fmtTook } from './milestones.js';
import { newMilestone } from './pnlcard.js';

const mints = (n) => Array.from({ length: n }, (_, i) => `M${String(i).padStart(3, '0')}`);

test('livePrices: one failed DexScreener chunk does not lose the others', async () => {
  const all = mints(70);
  let call = 0;
  const fetchPairs = async (chunk) => {
    if (call++ === 1) throw new Error('HTTP 429');
    return new Map(chunk.map((m) => [m, { mint: m, priceUsd: 1 }]));
  };
  const out = await livePrices(all, { fetchPairs, now: 0 });
  assert.equal(out.size, 40); // chunks of 30: the second one failed, the first and the third (10) came back
  assert.ok(out.has('M000') && out.has('M069') && !out.has('M030'));
});

test('livePrices: a token priced only in its quote token gets a dollar price', async () => {
  const fetchPairs = async () => new Map([['A', { mint: 'A', priceUsd: null, priceNative: 0.002, quoteAddress: 'Q', dex: 'Pumpfun' }]]);
  const out = await livePrices(['A'], { fetchPairs, quoteUsd: async () => 0.5, now: 0 });
  assert.equal(out.get('A').priceUsd, 0.001);
  assert.equal(out.get('A').marketCapUsd, 1_000_000); // pump.fun: 1B supply
});

test('livePrices: tokens DexScreener does not list come from the launchpad lookup, a few per run', async () => {
  const fetchPairs = async () => new Map();
  const asked = [];
  const launchMarket = async (m) => { asked.push(m); return m === 'B' ? { priceUsd: 2, marketCapUsd: 50_000 } : null; };
  const out = await livePrices(['A', 'B', 'C'], { fetchPairs, launchMarket, maxFallback: 2, now: 10_000_000 });
  assert.deepEqual(asked, ['A', 'B']);
  assert.equal(out.get('B').priceUsd, 2);
  assert.ok(!out.has('A'));
  // A found nothing: it is not asked again for a few minutes
  asked.length = 0;
  await livePrices(['A'], { fetchPairs, launchMarket, now: 10_000_000 + 60_000 });
  assert.deepEqual(asked, []);
});

test('parseMilestoneArg', () => {
  assert.deepEqual(parseMilestoneArg('off'), { enabled: false, minX: null });
  assert.deepEqual(parseMilestoneArg('on'), { enabled: true, minX: null });
  assert.deepEqual(parseMilestoneArg('5'), { enabled: true, minX: 5 });
  assert.deepEqual(parseMilestoneArg('10x'), { enabled: true, minX: 10 });
  assert.deepEqual(parseMilestoneArg('7'), { enabled: true, minX: 5 }); // snaps down to a real milestone
  assert.equal(parseMilestoneArg('1'), null);
  assert.equal(parseMilestoneArg('banana'), null);
  assert.equal(parseMilestoneArg(''), null);
});

test('newMilestone respects the group minimum', () => {
  assert.equal(newMilestone(1, 3.5, 5), null); // group set to 5x: no 2x / 3x posts
  assert.equal(newMilestone(1, 6, 5), 5);
  assert.equal(newMilestone(1, 3.5, null), 3);
});

test('setting text', () => {
  assert.match(buildMilestoneSettingText({ enabled: false }), /off/);
  assert.match(buildMilestoneSettingText({ enabled: true, minX: 10 }), /from <b>10x<\/b>/);
  assert.match(buildMilestoneSettingText({ enabled: true }), /from <b>2x<\/b>/);
});

test('fmtTook', () => {
  assert.equal(fmtTook(30_000), 'under a minute');
  assert.equal(fmtTook(14 * 60_000), '14m');
  assert.equal(fmtTook(134 * 60_000), '2h 14m');
  assert.equal(fmtTook(26 * 3600_000), '1d 2h');
  assert.equal(fmtTook(null), null);
});

test('milestone caption: multiple, time, market caps, caller', () => {
  const c = buildMilestoneCaption({ symbol: 'ABC', callerName: '@trader', milestone: 10, x: 12.4, entryMcap: 40_000, peakMcap: 496_000, tookMs: 134 * 60_000 });
  assert.match(c, /🔥 <b>\$ABC<\/b> hit <b>12x<\/b> in 2h 14m/);
  assert.match(c, /➜/);
  assert.match(c, /Called by/);
  assert.match(buildMilestoneCaption({ symbol: 'A', callerName: 'x', milestone: 2, x: 2.1 }), /^🚀/);
  assert.match(buildMilestoneCaption({ symbol: 'A', callerName: 'x', milestone: 50, x: 51 }), /^🌕/);
  assert.match(buildMilestoneCaption({ symbol: '<b>', callerName: 'x', milestone: 2, x: 2 }), /&lt;b&gt;/); // escaped
});
