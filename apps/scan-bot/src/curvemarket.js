// A brand-new pump.fun token is quoted in another token (WLFI, SOL...), and DexScreener may give only the price in that
// token. The dollar price is then price-in-quote x the quote token's own dollar price. Nothing is guessed: if the quote
// token has no dollar price, the card keeps showing n/a.
export const pumpSupply = 1_000_000_000; // every pump.fun token has 1B supply

const quoteCache = new Map(); // quote mint -> { at, v }
export async function quoteUsd(fetchPairs, quoteAddress) {
  if (!quoteAddress) return null;
  const hit = quoteCache.get(quoteAddress);
  if (hit && Date.now() - hit.at < 60_000) return hit.v;
  let v = null;
  try {
    const p = (await fetchPairs([quoteAddress])).get(quoteAddress)?.priceUsd;
    if (p > 0) v = p;
  } catch { /* none */ }
  if (v) { if (quoteCache.size > 50) quoteCache.clear(); quoteCache.set(quoteAddress, { at: Date.now(), v }); }
  return v ?? (hit?.v ?? null);
}

// m: a market record with priceNative and the quote token. Returns { priceUsd, marketCapUsd } or null.
export function usdFromQuote(m, quotePriceUsd) {
  if (!(m?.priceNative > 0) || !(quotePriceUsd > 0)) return null;
  const priceUsd = m.priceNative * quotePriceUsd;
  return { priceUsd, marketCapUsd: priceUsd * pumpSupply };
}

const handle = (v, base) => {
  const s = String(v ?? '').trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s;
  const h = s.replace(/^@/, '').replace(/^(www\.)?(x\.com|twitter\.com|t\.me)\//i, '');
  return /^[A-Za-z0-9_]{3,40}$/.test(h) ? `${base}${h}` : null;
};
// The token's metadata json (pump.fun writes twitter / telegram / website into it) -> { socials, websites }.
export function parseMetaLinks(meta) {
  const socials = [], websites = [];
  const tw = handle(meta?.twitter, 'https://x.com/');
  const tg = handle(meta?.telegram, 'https://t.me/');
  const web = typeof meta?.website === 'string' && /^https?:\/\//i.test(meta.website.trim()) ? meta.website.trim() : null;
  if (tw) socials.push({ type: 'twitter', url: tw });
  if (tg) socials.push({ type: 'telegram', url: tg });
  if (web) websites.push({ label: 'Web', url: web });
  return { socials, websites };
}

// ---- Tokens on other launchpads (letsbonk.fun / Raydium LaunchLab...): DexScreener has no pair yet, but
// Jupiter and GeckoTerminal already list them. Used only when DexScreener has nothing. Missing numbers stay null.
const num = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };
export function parseJupiterToken(json, mint) {
  const t = (Array.isArray(json) ? json : []).find((x) => x?.id === mint);
  if (!t) return null;
  return {
    name: t.name ?? null, symbol: t.symbol ?? null, imageUrl: t.icon ?? null,
    priceUsd: num(t.usdPrice), marketCapUsd: num(t.mcap), fdvUsd: num(t.fdv), liquidityUsd: num(t.liquidity),
    launchpad: t.launchpad ?? null,
    change1h: Number.isFinite(t.stats1h?.priceChange) ? t.stats1h.priceChange : null,
    change24h: Number.isFinite(t.stats24h?.priceChange) ? t.stats24h.priceChange : null,
    volume24h: t.stats24h && (num(t.stats24h.buyVolume) || num(t.stats24h.sellVolume)) ? (num(t.stats24h.buyVolume) ?? 0) + (num(t.stats24h.sellVolume) ?? 0) : null,
  };
}
export function parseGeckoToken(json) {
  const a = json?.data?.attributes;
  if (!a) return null;
  const lp = a.launchpad_details;
  return {
    name: a.name ?? null, symbol: a.symbol ?? null, imageUrl: a.image_url ?? null,
    priceUsd: num(a.price_usd), marketCapUsd: num(a.market_cap_usd), fdvUsd: num(a.fdv_usd),
    liquidityUsd: num(a.total_reserve_in_usd), volume24h: num(a.volume_usd?.h24),
    launchpadPct: lp && Number.isFinite(lp.graduation_percentage) ? lp.graduation_percentage : null,
    launchpadDone: lp ? lp.completed === true : null,
  };
}
export async function fetchLaunchMarket(mint, fetchFn = fetch) {
  const get = async (url) => { const r = await fetchFn(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(6_000) }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); };
  const [j, g] = await Promise.allSettled([
    get(`https://lite-api.jup.ag/tokens/v2/search?query=${mint}`),
    get(`https://api.geckoterminal.com/api/v2/networks/solana/tokens/${mint}`),
  ]);
  const a = j.status === 'fulfilled' ? parseJupiterToken(j.value, mint) : null;
  const b = g.status === 'fulfilled' ? parseGeckoToken(g.value) : null;
  if (!a && !b) return null;
  const pick = (k) => a?.[k] ?? b?.[k] ?? null;
  const priceUsd = pick('priceUsd');
  if (!priceUsd) return null;
  const marketCapUsd = pick('marketCapUsd') ?? pick('fdvUsd');
  return {
    mint, name: pick('name'), symbol: pick('symbol'), imageUrl: pick('imageUrl'),
    priceUsd, marketCapUsd, fdvUsd: pick('fdvUsd'), liquidityUsd: pick('liquidityUsd'),
    volume24h: pick('volume24h'), change1h: a?.change1h ?? null, change24h: a?.change24h ?? null,
    dex: a?.launchpad ?? 'launchpad', launchpadPct: b?.launchpadPct ?? null, launchpadDone: b?.launchpadDone ?? null,
  };
}
