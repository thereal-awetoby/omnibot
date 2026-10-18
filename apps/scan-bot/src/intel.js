// Gathers everything beyond the basic market numbers, never throwing and never waiting forever.
import { fetchRugCheck, fetchAth, describeAth } from './sources.js';
import { getSecurityRaw, withHolderStats, getDevHolding, getFreshWallets } from './chain.js';

// Resolves to `fallback` if the promise is still pending after `ms`, or if it fails.
export const within = (p, ms, fallback = null) => new Promise((resolve) => {
  const t = setTimeout(() => resolve(fallback), ms);
  Promise.resolve(p).then((v) => { clearTimeout(t); resolve(v); }, () => { clearTimeout(t); resolve(fallback); });
});

// Start the lookups that do not need the market data. Call this at the same time as the market fetch,
// so the slow RPC and RugCheck calls overlap with it instead of waiting in line.
export function startIntel(mint) {
  return { raw: getSecurityRaw(mint), rug: fetchRugCheck(mint) };
}

// Returns { security, intel } where intel = { holdersTotal, lpLockedPct, rugged, devPct, fresh1dPct, fresh7dPct,
// walletsChecked, ath, top, top10Pct, top1Pct, creator, meta, detectedAt, linked } (any field may be null).
export async function gatherIntel(mint, market, pre = startIntel(mint)) {
  // Stage 1: the lookups already running, plus the price history.
  const [raw, rug, athRaw] = await Promise.all([
    within(pre.raw, 6_000),
    within(pre.rug, 6_000),
    market ? within(fetchAth({ pairAddress: market.pairAddress, mint, createdAt: market.createdAt }), 5_000) : null,
  ]);
  const security = withHolderStats(raw, mint, market?.pairAddress ?? null);
  // Stage 2: needs the creator (RugCheck) and the top holders / supply (RPC).
  const [devPct, fresh] = await Promise.all([
    within(getDevHolding(rug?.creator, mint, security?.supply), 3_500),
    within(getFreshWallets(security?.top), 4_000),
  ]);
  // Holder concentration: our own RPC numbers first, RugCheck's list when the RPC is busy.
  const haveRpcTop = typeof security?.top10Pct === 'number';
  const intel = {
    top: haveRpcTop ? security.top : rug?.top ?? [],
    top10Pct: haveRpcTop ? security.top10Pct : rug?.top10Pct ?? null,
    top1Pct: haveRpcTop ? security.top1Pct : rug?.top1Pct ?? null,
    holdersTotal: rug?.totalHolders ?? null,
    lpLockedPct: rug?.lpLockedPct ?? null,
    rugged: rug?.rugged ?? false,
    devPct,
    fresh1dPct: fresh?.fresh1dPct ?? null,
    fresh7dPct: fresh?.fresh7dPct ?? null,
    walletsChecked: fresh?.walletsChecked ?? 0,
    ath: describeAth(athRaw, market),
    // for the detail views
    creator: rug?.creator ?? null,
    meta: rug?.meta ?? null,
    detectedAt: rug?.detectedAt ?? null,
    linked: (rug?.top ?? []).filter((h) => h.insider).map((h) => h.owner),
  };
  return { security, intel };
}
