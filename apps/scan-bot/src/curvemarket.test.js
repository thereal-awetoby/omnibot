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

import { parseJupiterToken, parseGeckoToken, fetchLaunchMarket } from './curvemarket.js';
test('launchpad token: Jupiter + GeckoTerminal are merged, curve percent kept', async () => {
  const mint = 'MINTbonk';
  const jup = [{ id: mint, name: 'pempfun', symbol: 'pempfun', icon: 'i.png', usdPrice: 0.00000306, mcap: 3060, fdv: 3060, liquidity: 84, launchpad: 'letsbonk.fun', stats1h: { priceChange: -13.6 } }];
  const gk = { data: { attributes: { name: 'pempfun', price_usd: '0.0000031', fdv_usd: '3150', total_reserve_in_usd: '2975', volume_usd: { h24: '14019' }, launchpad_details: { graduation_percentage: 1.36, completed: false } } } };
  const fetchFn = async (url) => ({ ok: true, status: 200, json: async () => (url.includes('jup.ag') ? jup : gk) });
  const m = await fetchLaunchMarket(mint, fetchFn);
  assert.equal(m.priceUsd, 0.00000306); assert.equal(m.marketCapUsd, 3060); assert.equal(m.liquidityUsd, 84);
  assert.equal(m.launchpadPct, 1.36); assert.equal(m.dex, 'letsbonk.fun'); assert.equal(m.volume24h, 14019);
  assert.equal(parseJupiterToken([], mint), null); assert.equal(parseGeckoToken({}), null);
  assert.equal(await fetchLaunchMarket(mint, async () => ({ ok: false, status: 500 })), null);
});
