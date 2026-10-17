// Gathers everything beyond the basic market numbers, in two parallel stages, never throwing.
import { fetchRugCheck, fetchAth, describeAth } from './sources.js';
import { getSecurity, getDevHolding, getFreshWallets } from './chain.js';

// Returns { security, intel } where intel = { holdersTotal, insiderPct, insiderNetworks, lpLockedPct,
// rugged, rugRisks, devPct, fresh1dPct, fresh7dPct, walletsChecked, ath } (any field may be null).
export async function gatherIntel(mint, market) {
  // Stage 1: three independent lookups at once.
  const [security, rug, athRaw] = await Promise.all([
    getSecurity(mint, { pairAddress: market?.pairAddress ?? null }),
    fetchRugCheck(mint),
    market ? fetchAth({ pairAddress: market.pairAddress, mint, createdAt: market.createdAt }) : null,
  ]);
  // Stage 2: needs the creator (RugCheck) and the top holders / supply (RPC).
  const [devPct, fresh] = await Promise.all([
    getDevHolding(rug?.creator, mint, security?.supply),
    getFreshWallets(security?.top),
  ]);
  // Holder concentration: our own RPC numbers first, RugCheck's list when the RPC is busy.
  const haveRpcTop = typeof security?.top10Pct === 'number';
  const intel = {
    top: haveRpcTop ? security.top : rug?.top ?? [],
    top10Pct: haveRpcTop ? security.top10Pct : rug?.top10Pct ?? null,
    top1Pct: haveRpcTop ? security.top1Pct : rug?.top1Pct ?? null,
    topSource: haveRpcTop ? 'rpc' : rug?.top?.length ? 'rugcheck' : null,
    holdersTotal: rug?.totalHolders ?? null,
    insiderPct: rug?.insiderPct ?? null,
    insiderNetworks: rug?.insiderNetworks ?? 0,
    insiderWallets: rug?.insiderWallets ?? 0,
    lpLockedPct: rug?.lpLockedPct ?? null,
    rugged: rug?.rugged ?? false,
    rugRisks: rug?.risks ?? [],
    devPct,
    fresh1dPct: fresh?.fresh1dPct ?? null,
    fresh7dPct: fresh?.fresh7dPct ?? null,
    walletsChecked: fresh?.walletsChecked ?? 0,
    ath: describeAth(athRaw, market),
    sources: { rug: Boolean(rug), ath: Boolean(athRaw), rpc: Boolean(security) },
  };
  return { security, intel };
}
