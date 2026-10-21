import test from 'node:test';
import assert from 'node:assert/strict';
import { priceFromCurve, parseMetaLinks, fetchSolUsd } from './curvemarket.js';

test('price and market cap come from the bonding curve reserves', () => {
  // virtual reserves of a fresh pump.fun token: 30 SOL against 1,073,000,000 tokens
  const res = { vTok: 1_073_000_000_000_000n, vSol: 30_000_000_000n, rSol: 0n, complete: false };
  const c = priceFromCurve(res, 150);
  assert.ok(Math.abs(c.priceUsd - (30 / 1_073_000_000) * 150) < 1e-12);
  assert.ok(Math.abs(c.marketCapUsd - c.priceUsd * 1e9) < 1e-3);
  assert.equal(c.dex, 'pump.fun curve');
  assert.equal(priceFromCurve(null, 150), null);
  assert.equal(priceFromCurve(res, null), null);
});
test('links in the metadata file become social buttons', () => {
  const l = parseMetaLinks({ twitter: 'https://x.com/groyper_sol', telegram: '@groypercoin', website: 'https://groyper.fun' });
  assert.deepEqual(l.socials, [{ type: 'twitter', url: 'https://x.com/groyper_sol' }, { type: 'telegram', url: 'https://t.me/groypercoin' }]);
  assert.deepEqual(l.websites, [{ label: 'Web', url: 'https://groyper.fun' }]);
  assert.deepEqual(parseMetaLinks({ twitter: 'javascript:alert(1)', website: 'ftp://x' }), { socials: [], websites: [] });
  assert.deepEqual(parseMetaLinks(null), { socials: [], websites: [] });
});
test('SOL price is read once from the pair lookup', async () => {
  let calls = 0;
  const pairs = async () => { calls++; return new Map([['So11111111111111111111111111111111111111112', { priceUsd: 151.2 }]]); };
  assert.equal(await fetchSolUsd(pairs), 151.2);
  assert.equal(await fetchSolUsd(pairs), 151.2);
  assert.equal(calls, 1);
});
