// Gathers everything beyond the basic market numbers, never throwing and never waiting forever.
import { fetchRugCheck, fetchAth, describeAth, fetchHolderCount } from './sources.js';
import { getSecurityRaw, withHolderStats, getDevHolding, getFreshWallets, getEarlyBuyers, getCurveCreator, getCurveState, getHolderCount } from './chain.js';
import { findBundle } from './security.js';

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
// walletsChecked, ath, bundle, top, top10Pct, top1Pct, creator, meta, detectedAt, linked } (any field may be null).
// Every step starts the moment the data it needs is ready (no waiting for unrelated lookups), and each one
// has its own time limit, so a slow source shows n/a instead of holding up the whole card.
export async function gatherIntel(mint, market, pre = startIntel(mint)) {
  const rawP = within(pre.raw, 6_000);
  const rugP = within(pre.rug, 6_000);
  const securityP = rawP.then((raw) => withHolderStats(raw, mint, market?.pairAddress ?? null));
  const athP = market ? within(fetchAth({ pairAddress: market.pairAddress, mint, createdAt: market.createdAt }), 4_000) : Promise.resolve(null);
  // The dev is the creator stored on-chain (pump.fun); RugCheck's creator is only the fallback.
  const creatorP = Promise.all([within(getCurveCreator(mint), 3_000), rugP]).then(([curve, rug]) => curve ?? rug?.creator ?? null);
  const curveP = market?.priceUsd > 0 ? within(getCurveState(mint, market.priceUsd), 3_500) : Promise.resolve(null);
  const holdersP = rugP.then((rug) => (typeof rug?.totalHolders === 'number' ? null : within(fetchHolderCount(mint).then((n) => n ?? getHolderCount(mint)), 5_000)));
  const devP = Promise.all([creatorP, securityP]).then(([creator, sec]) => within(getDevHolding(creator, mint, sec?.supply), 3_500));
  const freshP = securityP.then((sec) => within(getFreshWallets(sec?.top), 3_800));
  const bundleP = Promise.all([rawP, securityP, creatorP])
    .then(([raw, sec, creator]) => within(getEarlyBuyers(raw, sec?.top, creator), 3_800))
    .then((entries) => findBundle(entries));
  const [security, rug, athRaw, devPct, fresh, bundle, creator, curve, holderCount] = await Promise.all([securityP, rugP, athP, devP, freshP, bundleP, creatorP, curveP, holdersP]);
  // Holder concentration: our own RPC numbers first, RugCheck's list when the RPC is busy.
  const haveRpcTop = typeof security?.top10Pct === 'number';
  const intel = {
    top: haveRpcTop ? security.top : rug?.top ?? [],
    top10Pct: haveRpcTop ? security.top10Pct : rug?.top10Pct ?? null,
    top1Pct: haveRpcTop ? security.top1Pct : rug?.top1Pct ?? null,
    // the bonding curve itself holds tokens too, but it is not a holder
    holdersTotal: rug?.totalHolders ?? (typeof holderCount === 'number' ? Math.max(0, holderCount - (curve && !curve.complete ? 1 : 0)) : null),
    curve,
    lpLockedPct: rug?.lpLockedPct ?? null,
    rugged: rug?.rugged ?? false,
    devPct,
    fresh1dPct: fresh?.fresh1dPct ?? null,
    fresh7dPct: fresh?.fresh7dPct ?? null,
    walletsChecked: fresh?.walletsChecked ?? 0,
    ath: describeAth(athRaw, market),
    bundle,
    // for the detail views
    creator,
    rugCreator: rug?.creator ?? null,
    meta: rug?.meta ?? null,
    detectedAt: rug?.detectedAt ?? null,
    linked: (rug?.top ?? []).filter((h) => h.insider).map((h) => h.owner),
  };
  return { security, intel };
}
