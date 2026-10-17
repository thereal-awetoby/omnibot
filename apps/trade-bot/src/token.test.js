import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTokenInput, formatUsd, formatPrice, fetchMarketData, fetchPumpData, fetchTokenMarket, shortNum, buildTokenCard, parsePumpCurve, liquidityFromCurve, solUsdFromQuote, prettyDex, parsePumpGlobal, curveProgress, progressBar, DEFAULT_INITIAL_REAL_TOKENS } from './token.js';

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

test('buildTokenCard shows market, safety and trade sections, escapes HTML, warns on low balance', () => {
  const text = buildTokenCard({
    mint: MINT,
    market: { name: 'Nas<sau>', symbol: 'NASSAU', priceUsd: 0.00000159, liquidityUsd: 1520, marketCapUsd: 1590, dex: 'pump.fun curve' },
    progress: 0.835,
    mintInfo: { mintAuthority: null, freezeAuthority: null },
    wallet: { label: 'toby test' },
    balance: 0,
    amount: '0.2',
    slippageBps: 1000,
    quote: { out: '123,456', priceImpactPct: -0.5, router: 'iris' },
  });
  assert.match(text, /\$NASSAU/);
  assert.match(text, /Nas&lt;sau&gt;/);
  assert.match(text, /Market/);
  assert.match(text, /Safety/);
  assert.match(text, /renounced ✅/);
  assert.match(text, /Liq {2}\$1\.52K/);
  assert.match(text, /0\.2 SOL → ~123,456 NASSAU/);
  assert.match(text, /Slippage 10%/);
  assert.match(text, /Curve {2}▰▰▰▰▰▰▰▰▱▱ 83\.5%/);
  assert.doesNotMatch(text, /Source/);
  assert.match(text, /Not enough SOL/);
});

test('buildTokenCard copes with no market data and a failed quote', () => {
  const text = buildTokenCard({
    mint: MINT, market: null,
    mintInfo: { mintAuthority: 'abc', freezeAuthority: 'def' },
    wallet: null, balance: null, amount: '0.1', slippageBps: 500, quote: null, quoteError: 'no route',
  });
  assert.match(text, /No market data/);
  assert.match(text, /authority active/);
  assert.match(text, /Freeze {2}⚠️ active/);
  assert.match(text, /Quote unavailable: no route/);
  assert.doesNotMatch(text, /Not enough SOL/);
});

test('shortNum trims long decimals', () => {
  assert.equal(shortNum('3,161,534.990174'), '3,161,534.99');
  assert.equal(shortNum('1,000'), '1,000');
  assert.equal(shortNum('0.000123'), '0.000123');
});

test('fetchPumpData reads a bonding-curve token', async () => {
  const body = {
    mint: MINT, name: 'First Gemma Dolphin', symbol: 'BRUSH', complete: false,
    usd_market_cap: 11070, market_cap: 60, // -> SOL = $184.5
    real_sol_reserves: 10_000_000_000, // 10 SOL in the curve
  };
  const m = await fetchPumpData(MINT, mockFetch(200, body));
  assert.equal(m.symbol, 'BRUSH');
  assert.equal(m.marketCapUsd, 11070);
  assert.equal(m.priceUsd, 11070 / 1e9);
  assert.equal(m.liquidityUsd, 10 * 184.5 * 2);
  // Missing or absurd numbers must not invent a liquidity figure.
  assert.equal((await fetchPumpData(MINT, mockFetch(200, { ...body, real_sol_reserves: 0 }))).liquidityUsd, null);
  assert.equal((await fetchPumpData(MINT, mockFetch(200, { ...body, market_cap: undefined }))).liquidityUsd, null);
  assert.equal(await fetchPumpData(MINT, mockFetch(200, {})), null);
});

test('fetchTokenMarket falls back to pump.fun, and survives both sources failing', async () => {
  const pump = { mint: MINT, name: 'P', symbol: 'PP', usd_market_cap: 5000, complete: false };
  const route = (dexBody, dexOk = true, pumpOk = true) => async (url) => {
    const isDex = url.includes('dexscreener');
    const ok = isDex ? dexOk : pumpOk;
    return { ok, status: ok ? 200 : 500, json: async () => (isDex ? dexBody : pump) };
  };
  assert.equal((await fetchTokenMarket(MINT, route({ pairs: [] }))).symbol, 'PP');
  const dexNoMc = { pairs: [{ chainId: 'solana', baseToken: { address: MINT, name: 'D', symbol: 'DD' }, priceUsd: '0.000002', liquidity: { usd: 900 } }] };
  const merged = await fetchTokenMarket(MINT, route(dexNoMc));
  assert.equal(merged.symbol, 'DD');
  assert.equal(merged.liquidityUsd, 900);
  assert.equal(merged.marketCapUsd, 5000);
  // DexScreener has market cap but no liquidity (the BRUSH case): liquidity comes from pump.fun.
  const dexNoLiq = { pairs: [{ chainId: 'solana', baseToken: { address: MINT, name: 'D', symbol: 'DD' }, priceUsd: '0.000002', marketCap: 7000 }] };
  const pumpWithLiq = { mint: MINT, name: 'P', symbol: 'PP', usd_market_cap: 7000, market_cap: 40, real_sol_reserves: 5_000_000_000, complete: false };
  const fill = await fetchTokenMarket(MINT, async (url) => ({ ok: true, status: 200, json: async () => (url.includes('dexscreener') ? dexNoLiq : pumpWithLiq) }));
  assert.equal(fill.marketCapUsd, 7000);
  assert.equal(fill.liquidityUsd, 5 * 175 * 2);
  assert.equal(await fetchTokenMarket(MINT, route({}, false, false)), null);
});

function curveBuffer({ realSol, complete = false }) {
  const b = Buffer.alloc(81);
  b.writeBigUInt64LE(925_163_590_557_167n, 8); // virtualTokenReserves
  b.writeBigUInt64LE(35_000_000_000n, 16); // virtualSolReserves
  b.writeBigUInt64LE(700_000_000_000_000n, 24); // realTokenReserves
  b.writeBigUInt64LE(realSol, 32); // realSolReserves
  b.writeBigUInt64LE(1_000_000_000_000_000n, 40); // tokenTotalSupply
  b[48] = complete ? 1 : 0;
  return b;
}

test('parsePumpCurve reads reserves and the complete flag from the account bytes', () => {
  const c = parsePumpCurve(curveBuffer({ realSol: 4_793_847_131n }));
  assert.equal(c.realSolLamports, 4_793_847_131n);
  assert.equal(c.complete, false);
  assert.equal(parsePumpCurve(curveBuffer({ realSol: 1n, complete: true })).complete, true);
  assert.equal(parsePumpCurve(Buffer.alloc(10)), null);
  assert.equal(parsePumpCurve(null), null);
});

test('liquidityFromCurve = curve SOL x SOL price x 2, and never invents a number', () => {
  const curve = parsePumpCurve(curveBuffer({ realSol: 10_000_000_000n })); // 10 SOL
  assert.equal(liquidityFromCurve(curve, 180), 10 * 180 * 2);
  assert.equal(liquidityFromCurve(curve, null), null);
  assert.equal(liquidityFromCurve(curve, 5), null); // absurd SOL price
  assert.equal(liquidityFromCurve(parsePumpCurve(curveBuffer({ realSol: 1n, complete: true })), 180), null);
  assert.equal(liquidityFromCurve(null, 180), null);
});

test('solUsdFromQuote derives the SOL price from token price and quote', () => {
  // 0.1 SOL buys 541,477.7 tokens (6 decimals) at $0.0000333 each -> ~$180 per SOL
  const v = solUsdFromQuote({ priceUsd: 0.0000333, outAmount: '541477700000', decimals: 6, amountSol: '0.1' });
  assert.ok(v > 170 && v < 190, String(v));
  assert.equal(solUsdFromQuote({ priceUsd: null, outAmount: '1', decimals: 6, amountSol: '0.1' }), null);
  assert.equal(solUsdFromQuote({ priceUsd: 1e-9, outAmount: '1000000', decimals: 6, amountSol: '0.1' }), null);
});

test('fetchMarketData returns the SOL price when the pair is quoted in SOL, and a friendly source', async () => {
  const body = { pairs: [{
    chainId: 'solana', baseToken: { address: MINT, name: 'N', symbol: 'N' }, quoteToken: { symbol: 'SOL' },
    priceUsd: '0.0000177', priceNative: '0.0000001', marketCap: 17730, dexId: 'pumpfun',
  }] };
  const m = await fetchMarketData(MINT, mockFetch(200, body));
  assert.ok(Math.abs(m.solUsd - 177) < 0.001);
  assert.equal(m.dex, 'pump.fun curve');
  assert.equal(m.liquidityUsd, null);
  assert.equal(prettyDex('pumpswap'), 'PumpSwap');
});

test('curveProgress and progressBar', () => {
  const mk = (realTokens, complete = false) => ({ realTokens, realSolLamports: 0n, complete });
  assert.equal(curveProgress(mk(DEFAULT_INITIAL_REAL_TOKENS)), 0); // nothing bought yet
  assert.equal(curveProgress(mk(DEFAULT_INITIAL_REAL_TOKENS / 2n)), 0.5);
  assert.equal(curveProgress(mk(0n)), 1);
  assert.equal(curveProgress(mk(5n, true)), 1); // graduated
  assert.equal(curveProgress(null), null);
  assert.equal(curveProgress(mk(DEFAULT_INITIAL_REAL_TOKENS * 2n)), 0); // never negative
  assert.equal(curveProgress(mk(100n), 200n), 0.5); // custom initial value
  assert.equal(progressBar(0), '▱▱▱▱▱▱▱▱▱▱');
  assert.equal(progressBar(0.835), '▰▰▰▰▰▰▰▰▱▱');
  assert.equal(progressBar(1), '▰▰▰▰▰▰▰▰▰▰');
});

test('parsePumpGlobal reads the initial real token reserves and rejects nonsense', () => {
  const b = Buffer.alloc(200);
  b.writeBigUInt64LE(793_100_000_000_000n, 89);
  assert.equal(parsePumpGlobal(b), 793_100_000_000_000n);
  assert.equal(parsePumpGlobal(Buffer.alloc(200)), null); // zero is not sane
  assert.equal(parsePumpGlobal(Buffer.alloc(10)), null);
  assert.equal(parsePumpGlobal(null), null);
});

test('buildTokenCard shows graduated tokens and hides the curve for normal tokens', () => {
  const base = { mint: MINT, market: null, mintInfo: { mintAuthority: null, freezeAuthority: null }, wallet: null, balance: null, amount: '0.1', slippageBps: 500, quote: null };
  assert.match(buildTokenCard({ ...base, progress: 1 }), /Curve {2}graduated/);
  assert.doesNotMatch(buildTokenCard({ ...base, progress: null }), /Curve/);
});
