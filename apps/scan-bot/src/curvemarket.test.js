import test from 'node:test';
import assert from 'node:assert/strict';
import { usdFromQuote, quoteUsd, parseMetaLinks } from './curvemarket.js';

test('dollar price = price in the quote token x the quote token price (no guessing)', () => {
  const u = usdFromQuote({ priceNative: 0.00005748 }, 0.0565);
  assert.ok(Math.abs(u.priceUsd - 3.2476e-6) < 1e-9);
  assert.ok(Math.abs(u.marketCapUsd - 3247.6) < 1);
  assert.equal(usdFromQuote({ priceNative: 0.00005748 }, null), null);
  assert.equal(usdFromQuote({ priceNative: null }, 0.05), null);
  assert.equal(usdFromQuote(null, 0.05), null);
});
test('quote token price is looked up once and remembered', async () => {
  let calls = 0;
  const pairs = async () => { calls++; return new Map([['WLFIMINT', { priceUsd: 0.0565 }]]); };
  assert.equal(await quoteUsd(pairs, 'WLFIMINT'), 0.0565);
  assert.equal(await quoteUsd(pairs, 'WLFIMINT'), 0.0565);
  assert.equal(calls, 1);
  assert.equal(await quoteUsd(async () => new Map(), 'UNKNOWN'), null);
  assert.equal(await quoteUsd(pairs, null), null);
});
test('links in the metadata file become social buttons', () => {
  const l = parseMetaLinks({ twitter: 'https://x.com/groyper_sol', telegram: '@groypercoin', website: 'https://groyper.fun' });
  assert.deepEqual(l.socials, [{ type: 'twitter', url: 'https://x.com/groyper_sol' }, { type: 'telegram', url: 'https://t.me/groypercoin' }]);
  assert.deepEqual(l.websites, [{ label: 'Web', url: 'https://groyper.fun' }]);
  assert.deepEqual(parseMetaLinks({ twitter: 'javascript:alert(1)', website: 'ftp://x' }), { socials: [], websites: [] });
});
