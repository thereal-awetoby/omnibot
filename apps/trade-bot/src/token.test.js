import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTokenInput, formatUsd, formatPrice, fetchMarketData, buildTokenCard } from './token.js';

const MINT = 'HF7R3k8129c2Ya4FEwPcqyLXXoHx7hwWGGsM8sAkpump';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

test('parseTokenInput accepts a bare address, an amount, and /quote forms', () => {
  assert.deepEqual(parseTokenInput(MINT), { mint: MINT, amount: null });
  assert.deepEqual(parseTokenInput(`  ${USDC} 0.5 `), { mint: USDC, amount: '0.5' });
  assert.deepEqual(parseTokenInput(`/quote ${USDC} 0.1`), { mint: USDC, amount: '0.1' });
  assert.deepEqual(parseTokenInput(`/quote@OmniTrademc_bot ${USDC}`), { mint: USDC, amount: null });
});

test('parseTokenInput ignores normal chat', () => {
  for (const bad of ['hello', '/quote hello', '', null, 'buy this ' + USDC, USDC + ' abc', '0OIl' + USDC]) {
    assert.equal(parseTokenInput(bad), null, String(bad));
  }
});

test('formatUsd', () => {
  assert.equal(formatUsd(1520), '$1.52K');
  assert.equal(formatUsd(1_590_000), '$1.59M');
  assert.equal(formatUsd(2_500_000_000), '$2.50B');
  assert.equal(formatUsd(12.3), '$12.30');
  assert.equal(formatUsd(null), 'n/a');
});

test('formatPrice', () => {
  assert.equal(formatPrice(0.00000159), '$0.0(5)159');
  assert.equal(formatPrice(0.000012345), '$0.0(4)1234');
  assert.equal(formatPrice(0.0123), '$0.0123');
  assert.equal(formatPrice(1.2345), '$1.23');
  assert.equal(formatPrice(0), 'n/a');
});

function mockFetch(status, body) {
  return async () => ({ ok: status === 200, status, json: async () => body });
}

test('fetchMarketData picks the most liquid Solana pair for this token', async () => {
  const body = { pairs: [
    { chainId: 'solana', baseToken: { address: MINT, name: 'Nassau', symbol: 'NASSAU' }, priceUsd: '0.000001', liquidity: { usd: 100 }, marketCap: 500, dexId: 'small' },
    { chainId: 'solana', baseToken: { address: MINT, name: 'Nassau', symbol: 'NASSAU' }, priceUsd: '0.0000016', liquidity: { usd: 1520 }, marketCap: 1590, dexId: 'big' },
    { chainId: 'ethereum', baseToken: { address: MINT, name: 'X', symbol: 'X' }, liquidity: { usd: 99999 } },
    { chainId: 'solana', baseToken: { address: 'OTHER', name: 'Y', symbol: 'Y' }, liquidity: { usd: 99999 } },
  ] };
  const m = await fetchMarketData(MINT, mockFetch(200, body));
  assert.equal(m.dex, 'big');
  assert.equal(m.symbol, 'NASSAU');
  assert.equal(m.liquidityUsd, 1520);
});

test('fetchMarketData returns null when there are no pairs, throws on HTTP error', async () => {
  assert.equal(await fetchMarketData(MINT, mockFetch(200, { pairs: null })), null);
  await assert.rejects(() => fetchMarketData(MINT, mockFetch(500, {})), /HTTP 500/);
});

test('buildTokenCard shows everything, escapes HTML, warns on low balance', () => {
  const text = buildTokenCard({
    mint: MINT,
    market: { name: 'Nas<sau>', symbol: 'NASSAU', priceUsd: 0.00000159, liquidityUsd: 1520, marketCapUsd: 1590 },
    mintInfo: { mintAuthority: null, freezeAuthority: null },
    wallet: { label: 'toby test' },
    balance: 0,
    amount: '0.2',
    quote: { out: '123,456', priceImpactPct: -0.5, router: 'iris' },
  });
  assert.match(text, /\$NASSAU/);
  assert.match(text, /Nas&lt;sau&gt;/);
  assert.match(text, /Renounced ✅/);
  assert.match(text, /LIQ: \$1\.52K/);
  assert.match(text, /0\.2 SOL → ~123,456 NASSAU/);
  assert.match(text, /Insufficient balance/);
});

test('buildTokenCard copes with no market data and a failed quote', () => {
  const text = buildTokenCard({
    mint: MINT, market: null,
    mintInfo: { mintAuthority: 'abc', freezeAuthority: 'def' },
    wallet: null, balance: null, amount: '0.1', quote: null, quoteError: 'no route',
  });
  assert.match(text, /no market data/);
  assert.match(text, /NOT renounced/);
  assert.match(text, /Freeze authority is active/);
  assert.match(text, /Quote unavailable: no route/);
  assert.doesNotMatch(text, /Insufficient/);
});
