// Collects everything for one bubblemap and draws it. Returns { png, caption }.
import { buildNodes, clusterByFunder, layoutBubbles, buildBubbleSvg, renderPng, buildBubbleCaption } from './bubblemap.js';
import { getSecurityRaw, getHolderAccountsDas, getFunders, bondingCurveOf } from './chain.js';

const FUNDING_CHECK = 25; // check the funding of this many of the biggest wallets
const cache = new Map(); // mint -> { at, value }
const TTL_MS = 10 * 60_000;
const inflight = new Map();

// Holder rows from the RPC's 20 largest accounts (the fallback when there is no Helius URL).
export function rowsFromRaw(raw) {
  if (!raw?.largest) return [];
  return raw.largest.map((a) => ({ owner: raw.owners?.get(a.address) ?? a.address, amount: Number(a.amount) }));
}

// card: { market, security, intel } as built for the token card.
export function loadBubblemap(mint, card) {
  const hit = cache.get(mint);
  if (hit && Date.now() - hit.at < TTL_MS) return Promise.resolve(hit.value);
  if (inflight.has(mint)) return inflight.get(mint);
  const p = build(mint, card)
    .then((value) => { if (value) { if (cache.size > 30) cache.delete(cache.keys().next().value); cache.set(mint, { at: Date.now(), value }); } return value; })
    .finally(() => inflight.delete(mint));
  inflight.set(mint, p);
  return p;
}

async function build(mint, card) {
  const raw = await getSecurityRaw(mint);
  if (!raw) return null;
  // Prefer the full holder list (Helius); fall back to the 20 largest accounts.
  const das = await getHolderAccountsDas(mint);
  const full = das?.complete && das.rows.length >= 5;
  const rows = full ? das.rows : rowsFromRaw(raw);
  const exclude = new Set([bondingCurveOf(mint)]);
  if (card.market?.pairAddress) exclude.add(card.market.pairAddress);
  const built = buildNodes({ rows, supply: raw.supply, exclude, creator: card.intel?.creator ?? null, insiders: card.intel?.linked ?? [], topN: full ? 40 : 20 });
  if (!built || built.nodes.length === 0) return null;

  const toCheck = built.nodes.slice(0, FUNDING_CHECK).map((n) => n.owner);
  const funders = await getFunders(toCheck);
  const checked = [...funders.values()].filter((v) => v !== undefined).length;
  const groups = clusterByFunder(built.nodes, funders);

  const curve = /curve/i.test(card.market?.dex ?? '');
  const layout = layoutBubbles(built.nodes, built.poolPct, { hasPool: built.poolPct > 0.05 });
  const svg = buildBubbleSvg({ symbol: card.market?.symbol, nodes: built.nodes, poolPct: built.poolPct, clusters: groups, layout, topPct: built.topPct, poolLabel: curve ? 'Curve' : 'LP' });
  const png = Buffer.from(await renderPng(svg));
  const caption = buildBubbleCaption({ symbol: card.market?.symbol, built, groups, funderChecked: checked, funderTotal: toCheck.length, poolLabel: curve ? 'Bonding curve' : 'Liquidity pool', source: full ? 'das' : 'rpc' });
  return { png, caption };
}
