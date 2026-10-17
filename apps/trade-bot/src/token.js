// Pure helpers for the "paste a token address" card. No Telegram, no Solana RPC here,
// so everything in this file is easy to unit test.
import { esc } from '@omnibot/shared';

// "<address>" or "<address> 0.5" or "/quote <address> 0.5" (also works when Telegram
// sends a pasted /quote as plain text because it was formatted as monospace).
const INPUT_RE = /^(?:\/quote(?:@\w+)?\s+)?([1-9A-HJ-NP-Za-km-z]{32,44})(?:\s+(\d+(?:\.\d+)?))?$/;

export function parseTokenInput(text) {
  const m = INPUT_RE.exec(String(text ?? '').trim());
  return m ? { mint: m[1], amount: m[2] ?? null } : null;
}

export function formatUsd(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return 'n/a';
  const abs = Math.abs(n);
  if (abs >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `$${(n / 1e3).toFixed(2)}K`;
  return `$${n.toFixed(2)}`;
}

// Tiny prices use the "0.0(5)1590" style: 5 zeros after the decimal point, then digits.
export function formatPrice(p) {
  const n = Number(p);
  if (!Number.isFinite(n) || n <= 0) return 'n/a';
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(4)}`;
  const decimals = n.toFixed(20).split('.')[1];
  const zeros = decimals.match(/^0*/)[0].length;
  const digits = decimals.slice(zeros, zeros + 4).replace(/0+$/, '') || '0';
  return zeros >= 4 ? `$0.0(${zeros})${digits}` : `$0.${'0'.repeat(zeros)}${digits}`;
}

// DexScreener: free, no key. Picks the Solana pair with the most liquidity for this token.
export async function fetchMarketData(mint, fetchImpl = fetch) {
  const res = await fetchImpl(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, {
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) throw new Error(`DexScreener returned HTTP ${res.status}`);
  const body = await res.json();
  const pairs = (body?.pairs ?? []).filter(
    (p) => p.chainId === 'solana' && p.baseToken?.address === mint
  );
  if (pairs.length === 0) return null;
  pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
  const p = pairs[0];
  return {
    name: p.baseToken.name,
    symbol: p.baseToken.symbol,
    priceUsd: p.priceUsd ? Number(p.priceUsd) : null,
    liquidityUsd: p.liquidity?.usd ?? null,
    marketCapUsd: p.marketCap ?? p.fdv ?? null,
    dex: p.dexId ?? null,
  };
}

// pump.fun knows tokens that are still on the bonding curve (not migrated yet), which
// DexScreener often lacks. Best effort: any failure just means "no data from here".
export async function fetchPumpData(mint, fetchImpl = fetch) {
  const res = await fetchImpl(`https://frontend-api-v3.pump.fun/coins/${mint}`, {
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) throw new Error(`pump.fun returned HTTP ${res.status}`);
  const c = await res.json();
  if (!c?.mint || typeof c.usd_market_cap !== 'number') return null;

  // SOL price in USD, derived from pump.fun's own two market-cap numbers (SOL and USD).
  const solUsd = typeof c.market_cap === 'number' && c.market_cap > 0 ? c.usd_market_cap / c.market_cap : null;
  // Liquidity = SOL sitting in the bonding curve (lamports) x 2, the same convention DexScreener uses.
  let liquidityUsd = null;
  if (solUsd && solUsd > 10 && solUsd < 2000 && Number(c.real_sol_reserves) > 0) {
    liquidityUsd = (Number(c.real_sol_reserves) / 1e9) * solUsd * 2;
  }
  return {
    name: c.name,
    symbol: c.symbol,
    priceUsd: c.usd_market_cap / 1e9, // pump.fun tokens have a fixed 1B supply
    liquidityUsd,
    marketCapUsd: c.usd_market_cap,
    dex: c.complete ? 'pump.fun (migrated)' : 'pump.fun curve',
  };
}

// DexScreener first; if it has nothing (or no market cap), fill the gaps from pump.fun.
export async function fetchTokenMarket(mint, fetchImpl = fetch) {
  let dex = null;
  try { dex = await fetchMarketData(mint, fetchImpl); } catch (e) { console.error('dexscreener error:', e.message); }
  if (dex && dex.marketCapUsd != null && dex.liquidityUsd != null) return dex;
  let pump = null;
  try { pump = await fetchPumpData(mint, fetchImpl); } catch (e) { console.error('pump.fun error:', e.message); }
  if (!dex) return pump;
  if (!pump) return dex;
  return {
    ...dex,
    marketCapUsd: dex.marketCapUsd ?? pump.marketCapUsd,
    liquidityUsd: dex.liquidityUsd ?? pump.liquidityUsd,
    priceUsd: dex.priceUsd ?? pump.priceUsd,
  };
}

// "3,161,534.990174" -> "3,161,534.99"; tiny amounts keep their precision.
export function shortNum(s) {
  const str = String(s);
  const [whole, frac = ''] = str.split('.');
  if (whole !== '0') return frac ? `${whole}.${frac.slice(0, 2)}`.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1') : whole;
  return str;
}

// Builds the HTML text of the card: Market / Safety / Your trade.
export function buildTokenCard({ mint, market, mintInfo, wallet, balance, amount, slippageBps, quote, quoteError }) {
  const title = market?.symbol
    ? `🪙 <b>$${esc(market.symbol)}</b>${market.name ? ` · ${esc(market.name)}` : ''}`
    : '🪙 <b>Unknown token</b>';
  const lines = [title, `<code>${mint}</code>`, ''];

  lines.push('<b>📊 Market</b>');
  if (market) {
    lines.push(`Price  ${formatPrice(market.priceUsd)}`);
    lines.push(`MCap  ${formatUsd(market.marketCapUsd)}  ·  Liq  ${formatUsd(market.liquidityUsd)}`);
    if (market.dex) lines.push(`Source  ${esc(market.dex)}`);
  } else {
    lines.push('No market data found yet (very new token?)');
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
