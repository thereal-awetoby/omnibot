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
