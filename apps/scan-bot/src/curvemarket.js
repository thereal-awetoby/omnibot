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
