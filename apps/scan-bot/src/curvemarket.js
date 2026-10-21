// A brand-new pump.fun token that DexScreener and pump.fun's website API cannot give us (price, market cap, links):
// the price comes from the bonding curve itself, the links from the token's own metadata file.
const SOL_MINT = 'So11111111111111111111111111111111111111112';
export const pumpSupply = 1_000_000_000; // every pump.fun token has 1B supply

// res: { vTok, vSol, rSol, complete } straight from the curve account.
export function priceFromCurve(res, solUsd) {
  if (!res || !(solUsd > 0) || !(Number(res.vTok) > 0) || !(Number(res.vSol) > 0)) return null;
  const priceUsd = (Number(res.vSol) / 1e9) / (Number(res.vTok) / 1e6) * solUsd;
  return { priceUsd, marketCapUsd: priceUsd * pumpSupply, dex: res.complete ? 'pump.fun (migrated)' : 'pump.fun curve' };
}

let solCache = { at: 0, v: null };
export async function fetchSolUsd(fetchPairs) {
  if (solCache.v && Date.now() - solCache.at < 60_000) return solCache.v;
  try {
    const p = (await fetchPairs([SOL_MINT])).get(SOL_MINT)?.priceUsd;
    if (p > 10 && p < 5000) { solCache = { at: Date.now(), v: p }; return p; }
  } catch { /* none */ }
  return solCache.v;
}

const handle = (v, base) => {
  const s = String(v ?? '').trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s;
  const h = s.replace(/^@/, '').replace(/^(www\\.)?(x\\.com|twitter\\.com|t\\.me)\//i, '');
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
