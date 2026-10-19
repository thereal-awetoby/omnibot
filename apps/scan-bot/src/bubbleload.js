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

// The data behind a bubblemap (shared by the picture and the interactive mini app).
async function collect(mint, card) {
  const raw = await getSecurityRaw(mint);
  if (!raw) return null;
  // Prefer the full holder list (Helius); fall back to the 20 largest accounts.
  const das = await getHolderAccountsDas(mint);
  const full = das?.complete && das.rows.length >= 5;
  const rows = full ? das.rows : rowsFromRaw(raw);
  const exclude = new Set([bondingCurveOf(mint)]);
  if (card.market?.pairAddress) exclude.add(card.market.pairAddress);
  const built = buildNodes({ rows, supply: raw.supply, exclude, creator: card.intel?.creator ?? null, insiders: card.intel?.linked ?? [], topN: full ? 100 : 20 });
  if (!built || built.nodes.length === 0) return null;

  const toCheck = built.nodes.slice(0, FUNDING_CHECK).map((n) => n.owner);
  const funders = await getFunders(toCheck);
  const checked = [...funders.values()].filter((v) => v !== undefined).length;
  const groups = clusterByFunder(built.nodes, funders);

  const curve = /curve/i.test(card.market?.dex ?? '');
  // The picture shows the biggest 40; the interactive map also gets the rest of the top 100 (small, unlinked).
  const PICTURE_N = 40;
  const pic = { ...built, nodes: built.nodes.slice(0, PICTURE_N), topPct: built.nodes.slice(0, PICTURE_N).reduce((a, n) => a + n.pct, 0) };
  const more = built.nodes.slice(PICTURE_N);
  const layout = layoutBubbles(pic.nodes, built.poolPct, { hasPool: built.poolPct > 0.05 });
  return { built: pic, more, groups, funders, layout, checked, total: toCheck.length, curve, source: full ? 'das' : 'rpc' };
}

async function build(mint, card) {
  const d = await collectCached(mint, card);
  if (!d) return null;
  const { built, groups, layout, checked, total, curve, source } = d;
  const svg = buildBubbleSvg({ symbol: card.market?.symbol, nodes: built.nodes, poolPct: built.poolPct, clusters: groups, layout, topPct: built.topPct, poolLabel: curve ? 'Curve' : 'LP' });
  const png = Buffer.from(await renderPng(svg));
  const caption = buildBubbleCaption({ symbol: card.market?.symbol, built, groups, funderChecked: checked, funderTotal: total, poolLabel: curve ? 'Bonding curve' : 'Liquidity pool', source });
  return { png, caption };
}

// The same data for the mini app: one lookup is shared by the picture and the interactive map for 10 minutes.
const dataCache = new Map();
const dataInflight = new Map();
export function collectCached(mint, card) {
  const hit = dataCache.get(mint);
  if (hit && Date.now() - hit.at < TTL_MS) return Promise.resolve(hit.value);
  if (dataInflight.has(mint)) return dataInflight.get(mint);
  const p = collect(mint, card)
    .then((value) => { if (value) { if (dataCache.size > 30) dataCache.delete(dataCache.keys().next().value); dataCache.set(mint, { at: Date.now(), value }); } return value; })
    .finally(() => dataInflight.delete(mint));
  dataInflight.set(mint, p);
  return p;
}
export const loadBubbleData = collectCached;
