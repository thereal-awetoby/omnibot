// Pure safety maths for the Scan card: holder concentration and a transparent risk rating.
// No network, no Solana library, so it is fully unit tested.

// Wallets that are not "real holders": burn addresses and well-known pool authorities.
export const BURN_OWNERS = new Set(['1nc1nerator11111111111111111111111111111111', '11111111111111111111111111111111']);
export const POOL_AUTHORITIES = new Set([
  '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1', // Raydium AMM authority
  'GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL', // Raydium CPMM authority
]);

// largest: [{ address, amount }] token accounts, biggest first (amount = raw units, string or BigInt).
// owners: Map(tokenAccountAddress -> owner wallet). exclude: Set of owner wallets to ignore (pools, curve, burn).
// Returns percentages of total supply for the top holders, EXCLUDING liquidity/burn accounts.
export function computeHolderStats(largest, owners, supply, exclude = new Set()) {
  const total = BigInt(supply);
  if (total <= 0n) return null;
  // Merge accounts that share an owner (one wallet can hold several token accounts).
  const byOwner = new Map();
  for (const a of largest) {
    const owner = owners.get(a.address) ?? a.address;
    if (exclude.has(owner) || BURN_OWNERS.has(owner) || POOL_AUTHORITIES.has(owner)) continue;
    byOwner.set(owner, (byOwner.get(owner) ?? 0n) + BigInt(a.amount));
  }
  const ranked = [...byOwner.entries()].sort((x, y) => (y[1] > x[1] ? 1 : y[1] < x[1] ? -1 : 0));
  const sorted = ranked.map((e) => e[1]);
  const pct = (n) => Number((n * 10000n) / total) / 100;
  const sum = (k) => sorted.slice(0, k).reduce((a, b) => a + b, 0n);
  return {
    top1Pct: pct(sorted[0] ?? 0n), top5Pct: pct(sum(5)), top10Pct: pct(sum(10)), holdersCounted: sorted.length,
    top: ranked.slice(0, 10).map(([owner, amount]) => ({ owner, pct: pct(amount) })),
  };
}

// ages: Map(owner -> account age in days, or null when unknown). Returns the share of supply sitting in
// brand-new wallets among the top holders. Unknown-age wallets are not counted as fresh.
export function computeFresh(top, ages) {
  let d1 = 0, d7 = 0, known = 0;
  for (const h of top ?? []) {
    const age = ages.get(h.owner);
    if (age === null || age === undefined) continue;
    known += 1;
    if (age < 1) d1 += h.pct;
    if (age < 7) d7 += h.pct;
  }
  return known === 0 ? null : { fresh1dPct: Math.round(d1 * 10) / 10, fresh7dPct: Math.round(d7 * 10) / 10, walletsChecked: known };
}

// Simple, explainable rules (not a prediction). Each flag adds points; points decide the level.
// security: { mintAuthority, freezeAuthority, top1Pct, top10Pct } (any may be null/undefined = unknown)
// market: { liquidityUsd, marketCapUsd, createdAt }
export function assessRisk({ security, market, intel = null, now = Date.now() }) {
  const flags = [];
  let score = 0;
  const add = (pts, text) => { score += pts; flags.push(text); };

  if (security) {
    if (security.mintAuthority) add(3, 'Mint authority is active (more supply can be created)');
    if (security.freezeAuthority) add(3, 'Freeze authority is active (wallets can be frozen)');
  }
  const t10 = security?.top10Pct ?? intel?.top10Pct;
  const t1 = security?.top1Pct ?? intel?.top1Pct;
  if (typeof t10 === 'number') {
    if (t10 > 50) add(2, `Top 10 holders own ${t10.toFixed(0)}%`);
    else if (t10 > 30) add(1, `Top 10 holders own ${t10.toFixed(0)}%`);
  }
  if (typeof t1 === 'number') {
    if (t1 > 20) add(2, `One wallet holds ${t1.toFixed(0)}%`);
    else if (t1 > 10) add(1, `One wallet holds ${t1.toFixed(0)}%`);
  }
  const liq = market?.liquidityUsd;
  if (typeof liq === 'number') {
    if (liq < 5_000) add(2, 'Very thin liquidity (under $5K)');
    else if (liq < 15_000) add(1, 'Thin liquidity (under $15K)');
    const mc = market?.marketCapUsd;
    if (typeof mc === 'number' && liq > 0 && mc / liq > 50) add(1, `MCap is ${Math.round(mc / liq)}x liquidity (hard to exit)`);
  }
  if (typeof market?.createdAt === 'number' && now - market.createdAt < 3_600_000) add(1, 'Less than 1 hour old');

  if (intel) {
    if (intel.rugged) add(6, 'RugCheck marks this token as rugged');
    if (typeof intel.insiderPct === 'number') {
      if (intel.insiderPct > 20) add(2, `Insider-linked wallets hold ${intel.insiderPct.toFixed(0)}%`);
      else if (intel.insiderPct > 10) add(1, `Insider-linked wallets hold ${intel.insiderPct.toFixed(0)}%`);
    }
    if (typeof intel.lpLockedPct === 'number' && intel.lpLockedPct < 50) add(2, 'Liquidity is not locked or burned');
    if (typeof intel.devPct === 'number') {
      if (intel.devPct > 15) add(2, `Dev wallet still holds ${intel.devPct.toFixed(0)}%`);
      else if (intel.devPct > 5) add(1, `Dev wallet still holds ${intel.devPct.toFixed(0)}%`);
    }
    if (typeof intel.fresh7dPct === 'number' && intel.fresh7dPct > 25) add(1, `${intel.fresh7dPct.toFixed(0)}% sits in wallets under 7 days old`);
  }

  const known = Boolean(security);
  const level = score >= 5 ? 'high' : score >= 2 ? 'medium' : 'low';
  return { level, score, flags, partial: !known };
}
