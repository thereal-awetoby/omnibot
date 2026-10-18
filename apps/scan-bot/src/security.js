// Pure safety maths for the Scan card: holder concentration and fresh-wallet share. No ratings.
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

// entries: [{ owner, pct, firstSlot }] = top holders and the slot in which each first received the token.
// "Bundled" = wallets that got the token in the same block as the earliest buyer (or the next one),
// the usual sign of a bundle. Returns { count, pct, slot }, or null when there is too little data to tell.
export function findBundle(entries, window = 1) {
  const known = (entries ?? []).filter((e) => Number.isFinite(e?.firstSlot));
  if (known.length < 2) return null;
  const first = Math.min(...known.map((e) => e.firstSlot));
  const group = known.filter((e) => e.firstSlot - first <= window);
  if (group.length < 2) return { count: 0, pct: 0, slot: null };
  return { count: group.length, pct: Math.round(group.reduce((a, e) => a + e.pct, 0) * 10) / 10, slot: first };
}
