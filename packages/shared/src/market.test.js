import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchPairsByTokens, fetchTrending } from './market.js';

const pair = (addr, liq, extra = {}) => ({
  chainId: 'solana', dexId: 'raydium', baseToken: { address: addr, name: `N${addr}`, symbol: `S${addr}` },
  priceUsd: '0.5', liquidity: { usd: liq }, marketCap: 1000, volume: { h24: 99 }, priceChange: { h1: 1, h24: -2 }, ...extra,
});
const json = (body, status = 200) => ({ ok: status === 200, status, json: async () => body });

test('fetchPairsByTokens picks the most liquid pair, ignores other chains and tokens, batches by 30', async () => {
  const urls = [];
  const impl = async (u) => { urls.push(u); return json([pair('A', 10), pair('A', 500), pair('B', 5, { chainId: 'ethereum' }), pair('Z', 5)]); };
  const out = await fetchPairsByTokens(['A', 'B'], impl);
  assert.equal(out.size, 1);
  assert.equal(out.get('A').liquidityUsd, 500);
  assert.equal(out.get('A').change24h, -2);
  assert.equal(out.get('A').dex, 'Raydium');
  assert.equal(urls.length, 1);
  assert.match(urls[0], /tokens\/v1\/solana\/A,B$/);

  const many = Array.from({ length: 65 }, (_, i) => `M${i}`);
  const urls2 = [];
  await fetchPairsByTokens(many, async (u) => { urls2.push(u); return json([]); });
  assert.equal(urls2.length, 3);
});

test('fetchPairsByTokens also reads the older { pairs } shape and throws on HTTP errors', async () => {
  const out = await fetchPairsByTokens(['A'], async () => json({ pairs: [pair('A', 1)] }));
  assert.equal(out.get('A').symbol, 'SA');
  await assert.rejects(fetchPairsByTokens(['A'], async () => json(null, 429)), /429/);
});

test('fetchTrending keeps boost order, solana only, and drops tokens with no data', async () => {
  const impl = async (u) => {
    if (u.includes('token-boosts/top')) return json([
      { chainId: 'solana', tokenAddress: 'A' }, { chainId: 'base', tokenAddress: 'X' },
      { chainId: 'solana', tokenAddress: 'B' }, { chainId: 'solana', tokenAddress: 'A' }, { chainId: 'solana', tokenAddress: 'C' },
    ]);
    return json([pair('C', 1), pair('A', 1)]); // B has no pairs
  };
  const out = await fetchTrending(8, impl);
  assert.deepEqual(out.map((t) => t.mint), ['A', 'C']);
  assert.deepEqual(await fetchTrending(8, async () => json([])), []);
  assert.equal((await fetchTrending(1, impl)).length, 1);
});

test('fetchPairsByTokens exposes age, txns, volume windows, socials and profile flag', async () => {
  const p = pair('A', 100, {
    pairAddress: 'PAIR1', pairCreatedAt: 1_700_000_000_000, fdv: 5000,
    txns: { h1: { buys: 30, sells: 10 }, h24: { buys: 300, sells: 200 } },
    volume: { m5: 1, h1: 2, h6: 3, h24: 4 }, priceChange: { m5: 0.5, h1: 1, h6: 2, h24: 3 },
    boosts: { active: 3 },
    info: { imageUrl: 'https://x/i.png', header: 'https://x/h.png', websites: [{ label: 'Website', url: 'https://a.io' }, { label: 'bad' }], socials: [{ type: 'twitter', url: 'https://x.com/a' }] },
  });
  const m = (await fetchPairsByTokens(['A'], async () => json([p]))).get('A');
  assert.equal(m.pairAddress, 'PAIR1');
  assert.equal(m.createdAt, 1_700_000_000_000);
  assert.deepEqual(m.txns.h1, { buys: 30, sells: 10 });
  assert.equal(m.txns.m5, null);
  assert.deepEqual(m.volume, { m5: 1, h1: 2, h6: 3, h24: 4 });
  assert.equal(m.change.h6, 2);
  assert.equal(m.boosts, 3);
  assert.equal(m.hasProfile, true);
  assert.equal(m.headerUrl, 'https://x/h.png');
  assert.equal(m.websites.length, 1);
  assert.equal(m.socials[0].type, 'twitter');
  const bare = (await fetchPairsByTokens(['A'], async () => json([pair('A', 1)]))).get('A');
  assert.equal(bare.hasProfile, false);
  assert.deepEqual(bare.websites, []);
});
