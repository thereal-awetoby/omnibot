// Market-data helpers shared by every Omni bot (DexScreener + pump.fun). No Telegram, no Solana RPC.

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
    dex: prettyDex(p.dexId),
    solUsd: solPriceFrom(p),
  };
}

const DEX_NAMES = { pumpfun: 'pump.fun curve', pumpswap: 'PumpSwap', raydium: 'Raydium', orca: 'Orca', meteora: 'Meteora' };
export const prettyDex = (id) => (id ? DEX_NAMES[id] ?? id : null);

// If the pair is quoted in SOL, priceUsd / priceNative is the SOL price in USD.
function solPriceFrom(pair) {
  const sym = pair.quoteToken?.symbol;
  const usd = Number(pair.priceUsd);
  const native = Number(pair.priceNative);
  if ((sym === 'SOL' || sym === 'WSOL') && usd > 0 && native > 0) return usd / native;
  return null;
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


// ---- batch lookups used by the Scan bot (up to 30 tokens per DexScreener call) ----

const txPair = (t) => (t ? { buys: Number(t.buys) || 0, sells: Number(t.sells) || 0 } : null);
const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

// One normalized record per token: the Solana pair with the most liquidity.
// Returns Map(mint -> { mint, name, symbol, priceUsd, liquidityUsd, marketCapUsd, volume24h, change1h, change24h, dex }).
export async function fetchPairsByTokens(mints, fetchImpl = fetch) {
  const wanted = [...new Set(mints)];
  const best = new Map();
  for (let i = 0; i < wanted.length; i += 30) {
    const chunk = wanted.slice(i, i + 30);
    const res = await fetchImpl(`https://api.dexscreener.com/tokens/v1/solana/${chunk.join(',')}`, {
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) throw new Error(`DexScreener returned HTTP ${res.status}`);
    const body = await res.json();
    const pairs = Array.isArray(body) ? body : body?.pairs ?? [];
    for (const p of pairs) {
      const mint = p.baseToken?.address;
      if (p.chainId !== 'solana' || !chunk.includes(mint)) continue;
      const cur = best.get(mint);
      if (!cur || (p.liquidity?.usd ?? 0) > (cur.liquidity?.usd ?? 0)) best.set(mint, p);
    }
  }
  const out = new Map();
  for (const [mint, p] of best) {
    out.set(mint, {
      mint,
      name: p.baseToken.name,
      symbol: p.baseToken.symbol,
      priceUsd: num(p.priceUsd),
      // pump.fun tokens are now quoted in another token (for example WLFI): DexScreener may then give only the price in that token
      priceNative: num(p.priceNative),
      quoteAddress: typeof p.quoteToken?.address === 'string' ? p.quoteToken.address : null,
      quoteSymbol: typeof p.quoteToken?.symbol === 'string' ? p.quoteToken.symbol : null,
      liquidityUsd: num(p.liquidity?.usd),
      marketCapUsd: num(p.marketCap ?? p.fdv),
      volume24h: num(p.volume?.h24),
      change1h: num(p.priceChange?.h1),
      change24h: num(p.priceChange?.h24),
      dex: prettyDex(p.dexId),
      // richer fields for the Scan card
      pairAddress: p.pairAddress ?? null,
      createdAt: num(p.pairCreatedAt),
      fdvUsd: num(p.fdv),
      volume: { m5: num(p.volume?.m5), h1: num(p.volume?.h1), h6: num(p.volume?.h6), h24: num(p.volume?.h24) },
      change: { m5: num(p.priceChange?.m5), h1: num(p.priceChange?.h1), h6: num(p.priceChange?.h6), h24: num(p.priceChange?.h24) },
      txns: {
        m5: txPair(p.txns?.m5), h1: txPair(p.txns?.h1), h6: txPair(p.txns?.h6), h24: txPair(p.txns?.h24),
      },
      boosts: num(p.boosts?.active) ?? 0,
      hasProfile: Boolean(p.info),
      imageUrl: typeof p.info?.imageUrl === 'string' ? p.info.imageUrl : null,
      headerUrl: typeof p.info?.header === 'string' ? p.info.header : null,
      websites: Array.isArray(p.info?.websites) ? p.info.websites.filter((w) => typeof w?.url === 'string') : [],
      socials: Array.isArray(p.info?.socials) ? p.info.socials.filter((x) => typeof x?.url === 'string') : [],
    });
  }
  return out;
}

// "Trending" = Solana tokens with the most active DexScreener boosts (their closest public signal).
export async function fetchTrending(limit = 8, fetchImpl = fetch) {
  const res = await fetchImpl('https://api.dexscreener.com/token-boosts/top/v1', { signal: AbortSignal.timeout(8_000) });
  if (!res.ok) throw new Error(`DexScreener returned HTTP ${res.status}`);
  const body = await res.json();
  const mints = [...new Set((Array.isArray(body) ? body : []).filter((b) => b.chainId === 'solana').map((b) => b.tokenAddress))].slice(0, 30);
  if (mints.length === 0) return [];
  const data = await fetchPairsByTokens(mints, fetchImpl);
  return mints.map((m) => data.get(m)).filter(Boolean).slice(0, limit);
}
