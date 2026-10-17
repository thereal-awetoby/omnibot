// Pure helpers for the "paste a token address" card. No Telegram, no Solana RPC here,
// so everything in this file is easy to unit test.
import { esc, formatUsd, formatPrice, shortNum } from '@omnibot/shared';
export { formatUsd, formatPrice, fetchMarketData, prettyDex, fetchPumpData, fetchTokenMarket, shortNum } from '@omnibot/shared';

// "<address>" or "<address> 0.5" or "/quote <address> 0.5" (also works when Telegram
// sends a pasted /quote as plain text because it was formatted as monospace).
const INPUT_RE = /^(?:\/quote(?:@\w+)?\s+)?([1-9A-HJ-NP-Za-km-z]{32,44})(?:\s+(\d+(?:\.\d+)?))?$/;

export function parseTokenInput(text) {
  const m = INPUT_RE.exec(String(text ?? '').trim());
  return m ? { mint: m[1], amount: m[2] ?? null } : null;
}

// ---- pump.fun bonding curve, read straight from the chain (no website API needed) ----
export const PUMP_PROGRAM_ID = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

// Account layout (after the 8-byte Anchor header): virtualTokenReserves, virtualSolReserves,
// realTokenReserves, realSolReserves, tokenTotalSupply (u64 each), then complete (bool).
export function parsePumpCurve(data) {
  if (!data || data.length < 49) return null;
  return {
    realTokens: data.readBigUInt64LE(24),
    realSolLamports: data.readBigUInt64LE(32),
    complete: data[48] === 1,
  };
}

// pump.fun's Global config account (same program): holds how many tokens a fresh curve sells.
export const PUMP_GLOBAL_ACCOUNT = '4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf';
// Raw units (6 decimals): 793,100,000 tokens. Used if the Global account can't be read.
export const DEFAULT_INITIAL_REAL_TOKENS = 793_100_000_000_000n;

// Global layout: 8-byte header, bool, authority(32), feeRecipient(32), then u64s:
// initialVirtualTokenReserves @73, initialVirtualSolReserves @81, initialRealTokenReserves @89.
export function parsePumpGlobal(data) {
  if (!data || data.length < 97) return null;
  const v = data.readBigUInt64LE(89);
  return v >= 100_000_000_000_000n && v <= 1_000_000_000_000_000n ? v : null; // sanity range
}

// 0..1 = share of the curve's tokens already bought. 1 once the token graduated.
export function curveProgress(curve, initialRealTokens = DEFAULT_INITIAL_REAL_TOKENS) {
  if (!curve) return null;
  if (curve.complete) return 1;
  const p = 1 - Number(curve.realTokens) / Number(initialRealTokens);
  return Math.min(1, Math.max(0, p));
}

export function progressBar(p, cells = 10) {
  const filled = Math.round(p * cells);
  return '▰'.repeat(filled) + '▱'.repeat(cells - filled);
}

const validSolUsd = (n) => typeof n === 'number' && Number.isFinite(n) && n > 10 && n < 2000;

// Liquidity = SOL held by the curve x SOL price x 2 (DexScreener's convention).
// A finished curve (token migrated) holds nothing; its liquidity lives in the new pool.
export function liquidityFromCurve(curve, solUsd) {
  if (!curve || curve.complete || !validSolUsd(solUsd)) return null;
  return (Number(curve.realSolLamports) / 1e9) * solUsd * 2;
}

// Last resort for the SOL price: derive it from the Jupiter quote (price in USD x tokens per SOL).
export function solUsdFromQuote({ priceUsd, outAmount, decimals, amountSol }) {
  const tokens = Number(outAmount) / 10 ** decimals;
  const sol = Number(amountSol);
  if (!(priceUsd > 0) || !(tokens > 0) || !(sol > 0)) return null;
  const v = (priceUsd * tokens) / sol;
  return validSolUsd(v) ? v : null;
}

// Builds the HTML text of the card: Market / Safety / Your trade.
export function buildTokenCard({ mint, market, mintInfo, wallet, balance, amount, slippageBps, quote, quoteError, progress = null }) {
  const title = market?.symbol
    ? `🪙 <b>$${esc(market.symbol)}</b>${market.name ? ` · ${esc(market.name)}` : ''}`
    : '🪙 <b>Unknown token</b>';
  const lines = [title, `<code>${mint}</code>`, ''];

  lines.push('<b>📊 Market</b>');
  if (market) {
    lines.push(`Price  ${formatPrice(market.priceUsd)}`);
    lines.push(`MCap  ${formatUsd(market.marketCapUsd)}  ·  Liq  ${formatUsd(market.liquidityUsd)}`);
  } else {
    lines.push('No market data found yet (very new token?)');
  }

  if (progress !== null) {
    lines.push(progress >= 1
      ? 'Curve  graduated ✅'
      : `Curve  ${progressBar(progress)} ${(progress * 100).toFixed(1)}%`);
  }

  lines.push('', '<b>🛡 Safety</b>');
  lines.push(`Mint  ${mintInfo.mintAuthority ? '⚠️ authority active' : 'renounced ✅'}  ·  Freeze  ${mintInfo.freezeAuthority ? '⚠️ active' : 'off ✅'}`);

  lines.push('', '<b>💱 Your trade</b>');
  if (quote) {
    const impact = quote.priceImpactPct === null ? 'n/a' : `${quote.priceImpactPct.toFixed(2)}%`;
    const warn = quote.priceImpactPct !== null && Math.abs(quote.priceImpactPct) >= 5 ? ' ⚠️' : '';
    lines.push(`${esc(amount)} SOL → ~${shortNum(quote.out)} ${market?.symbol ? esc(market.symbol) : 'tokens'}`);
    lines.push(`Impact ${impact}${warn}  ·  Slippage ${slippageBps / 100}%  ·  ${esc(quote.router)}`);
  } else {
    lines.push(`Quote unavailable: ${esc(quoteError ?? 'unknown error')}`);
  }

  if (wallet) {
    const bal = typeof balance === 'number' ? `${balance.toFixed(4)} SOL` : 'n/a';
    lines.push(`Wallet  ${esc(wallet.label)}  ·  ${bal}`);
  } else {
    lines.push('No wallet yet. Run /start to create one.');
  }

  if (wallet && typeof balance === 'number' && balance < Number(amount) + 0.01) {
    lines.push('', '🔴 Not enough SOL for this amount + gas. Tap Wallet to deposit.');
  }
  return lines.join('\n');
}
