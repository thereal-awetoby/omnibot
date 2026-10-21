import { existsSync } from 'node:fs';
// Our own bubblemap: holders drawn as circles (size = share of supply), wallets first funded by the same address
// grouped together. Everything here is pure (no network), except renderPng which turns the SVG into a PNG.
import { hierarchy, pack } from 'd3-hierarchy';
import { esc } from '@omnibot/shared';
import { BURN_OWNERS, POOL_AUTHORITIES } from './security.js';

const CLUSTER_COLORS = ['#ff9f43', '#a55eea', '#26de81', '#fd79a8', '#00cec9', '#fdcb6e', '#e17055', '#74b9ff'];
const COLOR = { holder: '#4f8cff', insider: '#ff4d4d', dev: '#ffd43b', pool: '#6b7280', text: '#ffffff', bg: '#0b1220', muted: '#8b98b0' };

// ---------- data shaping ----------

// Helius DAS getTokenAccounts response -> { accounts: [{ owner, amount }], total } or null if it is not that shape.
export function parseDasAccounts(json) {
  const list = json?.result?.token_accounts;
  if (!Array.isArray(list)) return null;
  const accounts = list.filter((a) => a?.owner && Number(a.amount) > 0).map((a) => ({ owner: String(a.owner), amount: Number(a.amount) }));
  return { accounts, total: Number.isFinite(Number(json.result.total)) ? Number(json.result.total) : null };
}

// Merge accounts that share an owner (one wallet can hold several token accounts).
export function aggregateOwners(rows) {
  const by = new Map();
  for (const r of rows) by.set(r.owner, (by.get(r.owner) ?? 0) + Number(r.amount));
  return [...by.entries()].map(([owner, amount]) => ({ owner, amount })).sort((a, b) => b.amount - a.amount);
}

// rows: [{ owner, amount }] (raw token units), supply: raw units. exclude: Set of pool/curve owners.
// Returns the top holders as nodes plus how much sits in pools and burn addresses.
export function buildNodes({ rows, supply, exclude = new Set(), creator = null, insiders = [], topN = 40 }) {
  const total = Number(supply);
  if (!(total > 0)) return null;
  const flagged = new Set(insiders);
  const owners = aggregateOwners(rows);
  let poolAmt = 0; let burnAmt = 0;
  const holders = [];
  for (const o of owners) {
    if (BURN_OWNERS.has(o.owner)) burnAmt += o.amount;
    else if (exclude.has(o.owner) || POOL_AUTHORITIES.has(o.owner)) poolAmt += o.amount;
    else holders.push(o);
  }
  const pct = (n) => (n / total) * 100;
  const nodes = holders.slice(0, topN).map((h) => ({
    owner: h.owner, pct: pct(h.amount), kind: h.owner === creator ? 'dev' : flagged.has(h.owner) ? 'insider' : 'holder', group: null,
  }));
  return {
    nodes,
    poolPct: pct(poolAmt),
    burnPct: pct(burnAmt),
    topPct: nodes.reduce((a, n) => a + n.pct, 0),
    holdersSeen: holders.length,
  };
}

// The address that first sent SOL to `owner`, read from that wallet's oldest transaction. null if not found.
export function funderFromTx(tx, owner) {
  const ixs = [...(tx?.transaction?.message?.instructions ?? []), ...((tx?.meta?.innerInstructions ?? []).flatMap((i) => i.instructions ?? []))];
  for (const ix of ixs) {
    const p = ix?.parsed;
    if (ix?.program !== 'system' || !p?.info) continue;
    if (p.type === 'transfer' && p.info.destination === owner && p.info.source && p.info.source !== owner) return p.info.source;
    if ((p.type === 'createAccount' || p.type === 'createAccountWithSeed') && p.info.newAccount === owner && p.info.source && p.info.source !== owner) return p.info.source;
  }
  return null;
}

// funders: Map(owner -> funderAddress | null | undefined). Wallets with the same funder form a group, as long as the
// group is a believable size (a funder behind dozens of holders is usually an exchange, not a team).
// Sets node.group (0, 1, 2...) and returns [{ funder, owners, pct }] biggest first.
export function clusterByFunder(nodes, funders, { minSize = 2, maxSize = 15 } = {}) {
  const by = new Map();
  for (const n of nodes) {
    const f = funders.get(n.owner);
    if (!f) continue;
    if (!by.has(f)) by.set(f, []);
    by.get(f).push(n);
  }
  const groups = [...by.entries()]
    .filter(([, members]) => members.length >= minSize && members.length <= maxSize)
    .map(([funder, members]) => ({ funder, owners: members.map((m) => m.owner), pct: members.reduce((a, m) => a + m.pct, 0), members }))
    .sort((a, b) => b.pct - a.pct);
  groups.forEach((g, i) => g.members.forEach((m) => { m.group = i; }));
  return groups.map(({ funder, owners, pct }) => ({ funder, owners, pct }));
}

// ---------- drawing ----------

const POOL_CAP = 2.5; // the pool is drawn at most this many times the biggest holder, so it never swallows the map

// Positions every bubble. Returns [{ ...node, x, y, r }] and the cluster circles [{ group, x, y, r }].
export function layoutBubbles(nodes, poolPct, { width = 940, height = 820, hasPool = true } = {}) {
  const maxHolder = Math.max(...nodes.map((n) => n.pct), 0.1);
  const items = [...nodes];
  if (hasPool && poolPct > 0) items.push({ owner: 'POOL', pct: poolPct, kind: 'pool', group: null, drawPct: Math.min(poolPct, maxHolder * POOL_CAP) });
  const groups = new Map();
  const children = [];
  for (const n of items) {
    const leaf = { n, value: Math.max(n.drawPct ?? n.pct, 0.05) };
    if (n.group === null || n.group === undefined) children.push(leaf);
    else {
      if (!groups.has(n.group)) { const g = { group: n.group, children: [] }; groups.set(n.group, g); children.push(g); }
      groups.get(n.group).children.push(leaf);
    }
  }
  const root = hierarchy({ children }).sum((d) => d.value ?? 0);
  pack().size([width, height]).padding((d) => (d.children ? 10 : 5))(root);
  const bubbles = []; const clusters = [];
  for (const node of root.descendants()) {
    if (node.data.n) bubbles.push({ ...node.data.n, x: node.x, y: node.y, r: node.r });
    else if (node.data.group !== undefined) clusters.push({ group: node.data.group, x: node.x, y: node.y, r: node.r });
  }
  return { bubbles, clusters };
}

const shortAddr = (a) => `${a.slice(0, 4)}…${a.slice(-4)}`;
const fmtPct = (p) => (p >= 10 ? p.toFixed(0) : p >= 1 ? p.toFixed(1) : p.toFixed(2));

// Returns an SVG string (1000 x 1000).
export function buildBubbleSvg({ symbol, nodes, poolPct = 0, clusters = [], layout, topPct, poolLabel = 'LP' }) {
  const W = 1000; const H = 1000; const ox = 30; const oy = 100;
  const colorOf = (n) => (n.kind === 'pool' ? COLOR.pool : n.kind === 'dev' ? COLOR.dev : n.kind === 'insider' ? COLOR.insider : n.group !== null && n.group !== undefined ? CLUSTER_COLORS[n.group % CLUSTER_COLORS.length] : COLOR.holder);
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`,
    `<rect width="${W}" height="${H}" fill="${COLOR.bg}"/>`,
    `<text x="30" y="52" font-family="Arial, Helvetica, sans-serif" font-size="34" font-weight="700" fill="${COLOR.text}">${esc(symbol ? `$${symbol}` : 'Token')} Bubblemap</text>`,
    `<text x="30" y="82" font-family="Arial, Helvetica, sans-serif" font-size="20" fill="${COLOR.muted}">Top ${nodes.length} wallets hold ${fmtPct(topPct)}% · circle size = share of supply</text>`,
  ];
  for (const c of layout.clusters) {
    const col = CLUSTER_COLORS[c.group % CLUSTER_COLORS.length];
    parts.push(`<circle cx="${(c.x + ox).toFixed(1)}" cy="${(c.y + oy).toFixed(1)}" r="${c.r.toFixed(1)}" fill="${col}" fill-opacity="0.08" stroke="${col}" stroke-width="3" stroke-dasharray="10 8"/>`);
  }
  for (const b of layout.bubbles) {
    const col = colorOf(b);
    const cx = (b.x + ox).toFixed(1); const cy = (b.y + oy).toFixed(1);
    parts.push(`<circle cx="${cx}" cy="${cy}" r="${b.r.toFixed(1)}" fill="${col}" fill-opacity="0.85" stroke="${col}" stroke-width="2"/>`);
    const label = b.kind === 'pool' ? `${poolLabel} ${fmtPct(poolPct)}%` : `${fmtPct(b.pct)}%`;
    const size = Math.max(10, Math.min(b.r * (b.kind === 'pool' ? 0.38 : 0.52), 30));
    if (b.r >= 15) parts.push(`<text x="${cx}" y="${(b.y + oy + size * 0.35).toFixed(1)}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="${size.toFixed(0)}" font-weight="700" fill="#06101f">${esc(label)}</text>`);
  }
  // legend
  const legend = [['Wallet', COLOR.holder], ['Linked group', CLUSTER_COLORS[0]], ['Flagged linked', COLOR.insider], ['Dev', COLOR.dev], ['Pool', COLOR.pool]];
  let lx = 30;
  for (const [label, col] of legend) {
    parts.push(`<circle cx="${lx + 9}" cy="966" r="9" fill="${col}"/>`);
    parts.push(`<text x="${lx + 25}" y="973" font-family="Arial, Helvetica, sans-serif" font-size="19" fill="${COLOR.muted}">${label}</text>`);
    lx += 52 + label.length * 10.5;
  }
  parts.push('</svg>');
  return parts.join('');
}

// SVG text -> PNG bytes. resvg is loaded only when a map is drawn, so the rest of the bot never depends on it.
// Scanning every font on the computer takes seconds on each card. Cards use Arial only, so with `fast` just its files are loaded.
const ARIAL = ['C:\\Windows\\Fonts\\arial.ttf', 'C:\\Windows\\Fonts\\arialbd.ttf', '/usr/share/fonts/truetype/msttcorefonts/Arial.ttf', '/usr/share/fonts/truetype/msttcorefonts/Arial_Bold.ttf', '/Library/Fonts/Arial.ttf', '/Library/Fonts/Arial Bold.ttf'];
const arialFiles = ARIAL.filter((f) => existsSync(f));
// Draws the SVG and returns the raw pixels (no PNG step): { pixels, width, height, ms } where ms = { setup, draw }.
export async function renderRaw(svg, width = 1000) {
  const t0 = Date.now();
  const { Resvg } = await import('@resvg/resvg-js');
  const font = arialFiles.length >= 2 ? { fontFiles: arialFiles, loadSystemFonts: false, defaultFontFamily: 'Arial' } : { loadSystemFonts: true, defaultFontFamily: 'Arial' };
  const r = new Resvg(svg, { fitTo: { mode: 'width', value: width }, font });
  const t1 = Date.now();
  const img = r.render();
  return { pixels: img.pixels, width: img.width, height: img.height, ms: { setup: t1 - t0, draw: Date.now() - t1 } };
}
export async function renderPng(svg, width = 1000, { fast = false } = {}) {
  const { Resvg } = await import('@resvg/resvg-js');
  const font = fast && arialFiles.length >= 2 ? { fontFiles: arialFiles, loadSystemFonts: false, defaultFontFamily: 'Arial' } : { loadSystemFonts: true, defaultFontFamily: 'Arial' };
  const r = new Resvg(svg, { fitTo: { mode: 'width', value: width }, font });
  return r.render().asPng();
}

// Telegram caption (HTML, under 1024 characters).
export function buildBubbleCaption({ symbol, built, groups, funderChecked, funderTotal, poolLabel = 'Pool', source }) {
  const name = symbol ? `$${esc(symbol)}` : 'Token';
  const lines = [`🫧 <b>${name} Bubblemap</b>`, `Top ${built.nodes.length} wallets hold <b>${fmtPct(built.topPct)}%</b> · largest <b>${fmtPct(built.nodes[0]?.pct ?? 0)}%</b>`];
  if (built.poolPct > 0.05) lines.push(`${poolLabel}: ${fmtPct(built.poolPct)}% (not counted as a holder)`);
  if (groups.length) {
    const wallets = groups.reduce((a, g) => a + g.owners.length, 0);
    const pct = groups.reduce((a, g) => a + g.pct, 0);
    lines.push('', `🔗 <b>${groups.length} linked group${groups.length > 1 ? 's' : ''}</b> · ${wallets} wallets · ${fmtPct(pct)}% of supply`);
    groups.slice(0, 3).forEach((g, i) => lines.push(`${i + 1}. ${g.owners.length} wallets · ${fmtPct(g.pct)}% · funded by <a href="https://solscan.io/account/${g.funder}">${shortAddr(g.funder)}</a>`));
    lines.push('<i>Linked = first funded by the same wallet.</i>');
  } else if (funderChecked > 0) {
    lines.push('', 'No wallets share a funder among those checked.');
  }
  if (funderTotal) lines.push(`<i>Funding checked for ${funderChecked} of ${funderTotal} wallets${source === 'rpc' ? ' (top 20 only on this RPC)' : ''}.</i>`);
  return lines.join('\n');
}
