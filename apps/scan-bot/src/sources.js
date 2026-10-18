// Free data sources for the Scan card (no API keys): RugCheck (holders, insiders, LP lock)
// and GeckoTerminal (price history for ATH). Parsers are pure so they are unit tested with sample payloads.

const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const str = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 100) : null);

// ---------- RugCheck ----------

// Turns a RugCheck /v1/tokens/{mint}/report payload into just what the card needs.
// Defensive on purpose: any field can be missing, and the card simply skips what it cannot read.
export function parseRugCheck(r) {
  if (!r || typeof r !== 'object') return null;
  const holders = Array.isArray(r.topHolders) ? r.topHolders : [];
  const known = r.knownAccounts && typeof r.knownAccounts === 'object' ? r.knownAccounts : {};
  const isPool = (h) => String(known[h.owner ?? h.address]?.type ?? '').toUpperCase() === 'AMM';
  const real = holders.filter((h) => !isPool(h));
  const insiderPct = real.filter((h) => h.insider === true).reduce((a, h) => a + (num(h.pct) ?? 0), 0);

  // LP lock % of the biggest pool (RugCheck lists one entry per market).
  let lpLockedPct = null;
  const markets = Array.isArray(r.markets) ? r.markets.filter((m) => m?.lp && num(m.lp.lpLockedPct) !== null) : [];
  if (markets.length) {
    const size = (m) => (num(m.lp.baseUSD) ?? 0) + (num(m.lp.quoteUSD) ?? 0);
    lpLockedPct = num(markets.reduce((best, m) => (size(m) > size(best) ? m : best), markets[0]).lp.lpLockedPct);
  }

  const risks = (Array.isArray(r.risks) ? r.risks : [])
    .filter((x) => x && (x.level === 'danger' || x.level === 'warn') && x.name)
    .slice(0, 5)
    .map((x) => ({ name: String(x.name), level: x.level }));

  const top = real.slice(0, 10).map((h) => ({ owner: String(h.owner ?? h.address ?? ''), pct: num(h.pct) ?? 0, insider: h.insider === true }));
  const nets = Array.isArray(r.insiderNetworks) ? r.insiderNetworks : [];
  const insiderWallets = nets.reduce((a, n) => a + (num(n?.size) ?? num(n?.activeAccounts) ?? 0), 0);
  // The token's own published info (name, description), as the creator wrote it.
  const fm = r.fileMeta && typeof r.fileMeta === 'object' ? r.fileMeta : {};
  const tm = r.tokenMeta && typeof r.tokenMeta === 'object' ? r.tokenMeta : {};
  const description = typeof fm.description === 'string' ? fm.description.trim() : '';
  return {
    meta: { name: str(fm.name ?? tm.name), symbol: str(fm.symbol ?? tm.symbol), description: description || null },
    detectedAt: typeof r.detectedAt === 'string' && Number.isFinite(Date.parse(r.detectedAt)) ? Date.parse(r.detectedAt) : null,
    totalHolders: num(r.totalHolders),
    top,
    top1Pct: top.length ? Math.round(top[0].pct * 10) / 10 : null,
    top10Pct: top.length ? Math.round(top.reduce((a, h) => a + h.pct, 0) * 10) / 10 : null,
    insiderPct: real.length ? Math.round(insiderPct * 10) / 10 : null,
    insiderNetworks: nets.length,
    insiderWallets,
    lpLockedPct: lpLockedPct === null ? null : Math.min(100, Math.max(0, lpLockedPct)),
    creator: typeof r.creator === 'string' && r.creator ? r.creator : null,
    rugged: r.rugged === true,
    risks,
  };
}

const rugCache = new Map(); // mint -> { at, value }
const RUG_TTL = 120_000;

export async function fetchRugCheck(mint, fetchImpl = fetch) {
  const hit = rugCache.get(mint);
  if (hit && Date.now() - hit.at < RUG_TTL) return hit.value;
  try {
    const res = await fetchImpl(`https://api.rugcheck.xyz/v1/tokens/${mint}/report`, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) throw new Error(`RugCheck returned HTTP ${res.status}`);
    const value = parseRugCheck(await res.json());
    if (value) rugCache.set(mint, { at: Date.now(), value });
    return value;
  } catch (e) {
    console.error('rugcheck error:', e.message);
    return null;
  }
}

// ---------- pump.fun: coins a wallet created (best effort) ----------

// The list endpoint answers with an array of coins. Anything unexpected gives null, and the Dev view
// falls back to reading the wallet's own transactions.
export function parsePumpCreated(body) {
  const list = Array.isArray(body) ? body : Array.isArray(body?.coins) ? body.coins : Array.isArray(body?.data) ? body.data : null;
  if (!list) return null;
  const out = [];
  for (const c of list) {
    if (!c || typeof c.mint !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(c.mint)) continue;
    const ts = Number(c.created_timestamp);
    out.push({
      mint: c.mint,
      symbol: typeof c.symbol === 'string' && c.symbol ? c.symbol.slice(0, 20) : null,
      createdAt: Number.isFinite(ts) && ts > 0 ? (ts < 1e11 ? ts * 1000 : ts) : null,
    });
  }
  return out;
}

export async function fetchPumpCreated(creator, fetchImpl = fetch) {
  try {
    const url = `https://frontend-api-v3.pump.fun/coins/user-created-coins/${creator}?offset=0&limit=50&includeNsfw=true`;
    const res = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(4_000) });
    if (!res.ok) throw new Error(`pump.fun returned HTTP ${res.status}`);
    return parsePumpCreated(await res.json());
  } catch (e) {
    console.error('pump created-coins error:', e.message);
    return null;
  }
}

// ---------- GeckoTerminal (ATH) ----------

// candles: [[unixSeconds, open, high, low, close, volume], ...] in any order.
// Returns { athPrice, athAt (ms) } from the highest "high", or null.
export function parseOhlcv(candles) {
  let best = null;
  for (const c of Array.isArray(candles) ? candles : []) {
    const high = num(c?.[2]);
    const ts = num(c?.[0]);
    if (high === null || ts === null || high <= 0) continue;
    if (!best || high > best.athPrice) best = { athPrice: high, athAt: ts * 1000 };
  }
  return best;
}

// After a 429 we leave GeckoTerminal alone for a minute instead of hammering it.
let geckoPausedUntil = 0;
const athCache = new Map(); // pool -> { at, value }
const ATH_TTL = 300_000;

// Hourly candles (up to ~41 days) for young tokens, daily candles (up to ~2.7 years) for old ones.
export async function fetchAth({ pairAddress, mint, createdAt }, fetchImpl = fetch, now = Date.now()) {
  if (!pairAddress || now < geckoPausedUntil) return null;
  const hit = athCache.get(pairAddress);
  if (hit && now - hit.at < ATH_TTL) return hit.value;
  const young = typeof createdAt === 'number' && now - createdAt < 40 * 86_400_000;
  const url = `https://api.geckoterminal.com/api/v2/networks/solana/pools/${pairAddress}/ohlcv/${young ? 'hour' : 'day'}?aggregate=1&limit=1000&currency=usd&token=${mint}`;
  try {
    const res = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8_000) });
    if (res.status === 429) { geckoPausedUntil = now + 60_000; throw new Error('GeckoTerminal rate limit, pausing 60s'); }
    if (!res.ok) throw new Error(`GeckoTerminal returned HTTP ${res.status}`);
    const body = await res.json();
    const value = parseOhlcv(body?.data?.attributes?.ohlcv_list);
    if (value) athCache.set(pairAddress, { at: now, value });
    return value;
  } catch (e) {
    console.error('ath error:', e.message);
    return null;
  }
}

// ATH expressed the way the card shows it: market cap at the peak, how far below it now, and when.
export function describeAth(ath, market) {
  if (!ath || !(market?.priceUsd > 0)) return null;
  const ratio = market.marketCapUsd > 0 ? market.marketCapUsd / market.priceUsd : null; // supply used by DexScreener
  return {
    athMcapUsd: ratio ? ath.athPrice * ratio : null,
    fromAthPct: (market.priceUsd / ath.athPrice - 1) * 100,
    athAt: ath.athAt,
  };
}
