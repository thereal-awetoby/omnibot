// Jupiter Swap API v2 helpers. Read-only quotes for now (no taker = no transaction).
// Docs: https://developers.jup.ag/docs/swap/order-and-execute
// No dependencies, so these are easy to unit test.

export const SOL_MINT = 'So11111111111111111111111111111111111111112';
const BASE_URL = 'https://api.jup.ag/swap/v2';

// "0.1" -> 100000000n. Max 9 decimals, must be > 0. Uses BigInt (no float rounding).
export function solToLamports(input) {
  const s = String(input).trim();
  if (!/^\d+(\.\d{1,9})?$/.test(s)) throw new Error('Enter a SOL amount like 0.1');
  const [whole, frac = ''] = s.split('.');
  const lamports = BigInt(whole) * 1_000_000_000n + BigInt(frac.padEnd(9, '0'));
  if (lamports <= 0n) throw new Error('Amount must be greater than 0');
  return lamports;
}

// Raw integer amount (string/BigInt) + token decimals -> readable string.
export function formatUnits(raw, decimals, maxFrac = 6) {
  const n = BigInt(raw);
  const base = 10n ** BigInt(decimals);
  const whole = (n / base).toLocaleString('en-US');
  const frac = (n % base).toString().padStart(decimals, '0').slice(0, maxFrac).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

// GET /order without `taker`: returns a price quote and no transaction.
export async function fetchQuote({ outputMint, lamports, apiKey, fetchImpl = fetch }) {
  const params = new URLSearchParams({
    inputMint: SOL_MINT,
    outputMint,
    amount: lamports.toString(),
  });
  const res = await fetchImpl(`${BASE_URL}/order?${params}`, {
    headers: apiKey ? { 'x-api-key': apiKey } : {},
    signal: AbortSignal.timeout(10_000),
  });
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON error body */ }
  if (!res.ok) {
    const err = new Error(body?.error || `Jupiter returned HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

export function hasRoute(order) {
  try { return BigInt(order?.outAmount ?? '0') > 0n; } catch { return false; }
}

export function summarizeQuote(order, decimals) {
  return {
    out: formatUnits(order.outAmount, decimals),
    minOut: order.otherAmountThreshold ? formatUnits(order.otherAmountThreshold, decimals) : null,
    // Jupiter returns percentage points, e.g. -0.1 means -0.1%.
    priceImpactPct: typeof order.priceImpact === 'number' ? order.priceImpact : null,
    slippageBps: order.slippageBps ?? null,
    router: String(order.router ?? 'unknown'),
    feeBps: order.feeBps ?? null,
  };
}

// ---- real swaps: /order WITH a taker returns an unsigned transaction, /execute lands it ----

// Same as fetchQuote but any direction, and with `taker` it includes the transaction to sign.
export async function fetchOrder({ inputMint, outputMint, amount, taker, slippageBps, apiKey, fetchImpl = fetch }) {
  const params = new URLSearchParams({ inputMint, outputMint, amount: amount.toString() });
  if (taker) params.set('taker', taker);
  if (slippageBps != null) params.set('slippageBps', String(slippageBps));
  const res = await fetchImpl(`${BASE_URL}/order?${params}`, {
    headers: apiKey ? { 'x-api-key': apiKey } : {},
    signal: AbortSignal.timeout(10_000),
  });
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON error body */ }
  if (!res.ok) {
    const err = new Error(body?.error || `Jupiter returned HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

// POST /execute: Jupiter lands the signed transaction for us and reports the result.
// Throws an error with `.unknown = true` when we could not learn the outcome (timeout, network):
// in that case the transaction MAY have landed, so callers must not assume it failed.
export async function executeOrder({ signedTransaction, requestId, apiKey, fetchImpl = fetch }) {
  let res;
  try {
    res = await fetchImpl(`${BASE_URL}/execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(apiKey ? { 'x-api-key': apiKey } : {}) },
      body: JSON.stringify({ signedTransaction, requestId }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (e) {
    const err = new Error(`Could not confirm the result (${e.message})`);
    err.unknown = true;
    throw err;
  }
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON body */ }
  if (!res.ok && !body) {
    const err = new Error(`Jupiter returned HTTP ${res.status}`);
    err.unknown = res.status >= 500;
    throw err;
  }
  return body ?? {};
}

const isIntString = (v) => typeof v === 'string' && /^\d+$/.test(v) || typeof v === 'number' && Number.isInteger(v) && v >= 0;

// Pulls the amounts that actually moved out of an /execute result.
// Prefers the "total" figures (what really left/entered the wallet), then the route figures,
// then the quoted numbers from /order. Returns BigInts, or null for anything we cannot read.
export function tradeAmounts(result, order, side) {
  const pick = (...vals) => { for (const v of vals) if (isIntString(v)) return BigInt(v); return null; };
  const inAmt = pick(result?.totalInputAmount, result?.inputAmountResult, order?.inAmount);
  const outAmt = pick(result?.totalOutputAmount, result?.outputAmountResult, order?.outAmount);
  // buy: input is SOL, output is tokens. sell: input is tokens, output is SOL.
  return side === 'buy'
    ? { solLamports: inAmt, tokenRaw: outAmt }
    : { solLamports: outAmt, tokenRaw: inAmt };
}

export const executeSucceeded = (result) => result?.status === 'Success' && typeof result?.signature === 'string';

// Friendly text for /execute failure codes (see Jupiter docs).
export function explainExecuteFailure(result) {
  const code = result?.code;
  const map = {
    '-1': 'The quote expired before it could be sent. Try again.',
    '-2': 'The transaction was rejected (invalid signature). Try again.',
    '-2000': 'The transaction failed to land on-chain. Nothing was spent. Try again, maybe with higher slippage.',
    '-2003': 'The quote expired. Try again.',
    '-2004': 'The swap was rejected by the market maker. Try again.',
  };
  return map[String(code)] ?? result?.error ?? (code != null ? `Swap failed (code ${code}).` : 'Swap failed.');
}
