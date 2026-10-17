import { test } from 'node:test';
import assert from 'node:assert/strict';
import { solToLamports, formatUnits, fetchQuote, hasRoute, summarizeQuote, SOL_MINT } from './jupiter.js';

test('solToLamports converts exactly', () => {
  assert.equal(solToLamports('1'), 1_000_000_000n);
  assert.equal(solToLamports('0.1'), 100_000_000n);
  assert.equal(solToLamports('0.000000001'), 1n);
  assert.equal(solToLamports(' 2.5 '), 2_500_000_000n);
});

test('solToLamports rejects bad input', () => {
  for (const bad of ['', 'abc', '-1', '0', '0.0', '1.0000000001', '1e3', '1,5', '.5']) {
    assert.throws(() => solToLamports(bad), undefined, bad);
  }
});

test('formatUnits', () => {
  assert.equal(formatUnits('1500000', 6), '1.5');
  assert.equal(formatUnits('1000000', 6), '1');
  assert.equal(formatUnits('123456789012', 6), '123,456.789012');
  assert.equal(formatUnits('1', 9), '0'); // below display precision
  assert.equal(formatUnits('42', 0), '42');
  assert.equal(formatUnits('2500000000', 9), '2.5');
});

function mockFetch(status, body, seen = {}) {
  return async (url, opts) => {
    seen.url = url;
    seen.opts = opts;
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
}

test('fetchQuote builds a read-only request (no taker) and sends the key only when set', async () => {
  const seen = {};
  const order = { outAmount: '5' };
  const out = await fetchQuote({ outputMint: 'MINT', lamports: 100n, fetchImpl: mockFetch(200, order, seen) });
  assert.deepEqual(out, order);
  const u = new URL(seen.url);
  assert.equal(u.origin + u.pathname, 'https://api.jup.ag/swap/v2/order');
  assert.equal(u.searchParams.get('inputMint'), SOL_MINT);
  assert.equal(u.searchParams.get('outputMint'), 'MINT');
  assert.equal(u.searchParams.get('amount'), '100');
  assert.equal(u.searchParams.has('taker'), false);
  assert.deepEqual(seen.opts.headers, {});

  const seen2 = {};
  await fetchQuote({ outputMint: 'M', lamports: 1n, apiKey: 'k', fetchImpl: mockFetch(200, {}, seen2) });
  assert.equal(seen2.opts.headers['x-api-key'], 'k');
});

test('fetchQuote turns API errors into Errors with status', async () => {
  await assert.rejects(
    fetchQuote({ outputMint: 'M', lamports: 1n, fetchImpl: mockFetch(400, { error: 'bad mint' }) }),
    (e) => e.status === 400 && e.message === 'bad mint'
  );
  await assert.rejects(
    fetchQuote({ outputMint: 'M', lamports: 1n, fetchImpl: mockFetch(429, null) }),
    (e) => e.status === 429 && /429/.test(e.message)
  );
});

test('hasRoute and summarizeQuote', () => {
  assert.equal(hasRoute({ outAmount: '0' }), false);
  assert.equal(hasRoute({}), false);
  assert.equal(hasRoute(null), false);
  assert.equal(hasRoute({ outAmount: 'abc' }), false);
  assert.equal(hasRoute({ outAmount: '10' }), true);

  const s = summarizeQuote(
    { outAmount: '2500000', otherAmountThreshold: '2400000', priceImpact: -0.35, slippageBps: 50, router: 'metis', feeBps: 10 },
    6
  );
  assert.deepEqual(s, { out: '2.5', minOut: '2.4', priceImpactPct: -0.35, slippageBps: 50, router: 'metis', feeBps: 10 });
});
