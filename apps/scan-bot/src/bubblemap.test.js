import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDasAccounts, aggregateOwners, buildNodes, funderFromTx, clusterByFunder, layoutBubbles, buildBubbleSvg, renderPng, buildBubbleCaption } from './bubblemap.js';
import { rowsFromRaw } from './bubbleload.js';

const SUPPLY = 1_000_000;
const row = (owner, pct) => ({ owner, amount: (pct / 100) * SUPPLY });

test('parseDasAccounts reads Helius getTokenAccounts and rejects other shapes', () => {
  const r = parseDasAccounts({ result: { total: 3, token_accounts: [{ owner: 'A', amount: 50 }, { owner: 'B', amount: 0 }, { owner: 'C', amount: '7' }, { amount: 5 }] } });
  assert.deepEqual(r.accounts, [{ owner: 'A', amount: 50 }, { owner: 'C', amount: 7 }]);
  assert.equal(r.total, 3);
  assert.equal(parseDasAccounts({ error: 'x' }), null);
  assert.equal(parseDasAccounts(null), null);
});

test('aggregateOwners merges accounts of one wallet and sorts biggest first', () => {
  assert.deepEqual(aggregateOwners([{ owner: 'a', amount: 1 }, { owner: 'b', amount: 5 }, { owner: 'a', amount: 6 }]), [{ owner: 'a', amount: 7 }, { owner: 'b', amount: 5 }]);
});

test('buildNodes: pools, curve and burn are separate; dev and flagged wallets are marked; topN applies', () => {
  const rows = [row('POOL', 30), row('BURN', 5), row('dev', 4), row('ins', 3), row('w1', 2), row('w2', 1), row('w3', 0.5)];
  const b = buildNodes({
    rows: [...rows.slice(0, 1), { owner: '1nc1nerator11111111111111111111111111111111', amount: 0.05 * SUPPLY }, ...rows.slice(2)],
    supply: SUPPLY, exclude: new Set(['POOL']), creator: 'dev', insiders: ['ins'], topN: 4,
  });
  assert.equal(Math.round(b.poolPct), 30);
  assert.equal(Math.round(b.burnPct), 5);
  assert.deepEqual(b.nodes.map((n) => [n.owner, n.kind]), [['dev', 'dev'], ['ins', 'insider'], ['w1', 'holder'], ['w2', 'holder']]);
  assert.equal(Math.round(b.topPct), 10);
  assert.equal(b.holdersSeen, 5);
  assert.equal(buildNodes({ rows, supply: 0 }), null);
});

test('funderFromTx finds the wallet that sent the first SOL, in main or inner instructions', () => {
  const transfer = (src, dst) => ({ program: 'system', parsed: { type: 'transfer', info: { source: src, destination: dst, lamports: 5 } } });
  assert.equal(funderFromTx({ transaction: { message: { instructions: [transfer('F', 'W')] } } }, 'W'), 'F');
  assert.equal(funderFromTx({ transaction: { message: { instructions: [] } }, meta: { innerInstructions: [{ instructions: [transfer('G', 'W')] }] } }, 'W'), 'G');
  assert.equal(funderFromTx({ transaction: { message: { instructions: [{ program: 'system', parsed: { type: 'createAccount', info: { source: 'H', newAccount: 'W' } } }] } } }, 'W'), 'H');
  assert.equal(funderFromTx({ transaction: { message: { instructions: [transfer('W', 'X')] } } }, 'W'), null); // W sent, did not receive
  assert.equal(funderFromTx({ transaction: { message: { instructions: [transfer('W', 'W')] } } }, 'W'), null);
  assert.equal(funderFromTx(null, 'W'), null);
});

test('clusterByFunder groups shared funders, ignores singletons, huge groups and unknowns', () => {
  const nodes = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((o, i) => ({ owner: o, pct: 10 - i, kind: 'holder', group: null }));
  const funders = new Map([['a', 'F1'], ['b', 'F1'], ['c', 'F2'], ['d', 'F2'], ['e', 'F2'], ['f', 'F3'], ['g', null]]);
  const groups = clusterByFunder(nodes, funders);
  // F2 holds 21% (c+d+e), F1 holds 19% (a+b): the bigger group comes first
  assert.deepEqual(groups.map((g) => [g.funder, g.owners]), [['F2', ['c', 'd', 'e']], ['F1', ['a', 'b']]]);
  assert.equal(nodes.find((n) => n.owner === 'f').group, null);
  assert.equal(nodes.find((n) => n.owner === 'g').group, null);
  const idxA = nodes.find((n) => n.owner === 'a').group;
  assert.equal(nodes.find((n) => n.owner === 'b').group, idxA);
  // an exchange-sized group is not a team
  const many = Array.from({ length: 20 }, (_, i) => ({ owner: `w${i}`, pct: 1, kind: 'holder', group: null }));
  assert.deepEqual(clusterByFunder(many, new Map(many.map((n) => [n.owner, 'EXCH']))), []);
});

test('layoutBubbles keeps every bubble inside the canvas and bubbles do not overlap; pool is capped', () => {
  const nodes = Array.from({ length: 30 }, (_, i) => ({ owner: `w${i}`, pct: 8 / (i + 1), kind: 'holder', group: i < 3 ? 0 : null }));
  const { bubbles, clusters } = layoutBubbles(nodes, 70, { width: 940, height: 820 });
  assert.equal(bubbles.length, 31);
  assert.equal(clusters.length, 1);
  for (const b of bubbles) { assert.ok(b.x - b.r >= -1 && b.x + b.r <= 941 && b.y - b.r >= -1 && b.y + b.r <= 821, `${b.owner} outside`); }
  for (let i = 0; i < bubbles.length; i++) for (let j = i + 1; j < bubbles.length; j++) {
    const d = Math.hypot(bubbles[i].x - bubbles[j].x, bubbles[i].y - bubbles[j].y);
    assert.ok(d >= bubbles[i].r + bubbles[j].r - 1, `${bubbles[i].owner} overlaps ${bubbles[j].owner}`);
  }
  const pool = bubbles.find((b) => b.kind === 'pool');
  const biggest = Math.max(...bubbles.filter((b) => b.kind !== 'pool').map((b) => b.r));
  assert.ok(pool.r <= biggest * 1.9, 'a 70% pool must not swallow the map'); // r scales with sqrt(2.5)
  assert.equal(layoutBubbles(nodes, 0, { hasPool: false }).bubbles.length, 30);
});

test('buildBubbleSvg escapes the symbol, draws every bubble and a pool label, and renders to a real PNG', async () => {
  const built = buildNodes({ rows: [row('POOL', 20), row('a', 5), row('b', 4), row('c', 3)], supply: SUPPLY, exclude: new Set(['POOL']) });
  const groups = clusterByFunder(built.nodes, new Map([['a', 'F'], ['b', 'F']]));
  const layout = layoutBubbles(built.nodes, built.poolPct);
  const svg = buildBubbleSvg({ symbol: 'A<B&', nodes: built.nodes, poolPct: built.poolPct, clusters: groups, layout, topPct: built.topPct, poolLabel: 'Curve' });
  assert.match(svg, /\$A&lt;B&amp; Bubblemap/);
  assert.equal((svg.match(/stroke-dasharray/g) ?? []).length, 1); // one group outline
  assert.match(svg, /Curve 20%/);
  assert.doesNotMatch(svg, /<script/);
  const png = await renderPng(svg);
  assert.equal(Buffer.from(png).subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.ok(png.length > 5000);
});

test('buildBubbleCaption: summary, groups with links, honest coverage line, stays under Telegram limit', () => {
  const built = buildNodes({ rows: [row('POOL', 20), row('a', 5), row('b', 4), row('c', 3)], supply: SUPPLY, exclude: new Set(['POOL']) });
  const groups = [{ funder: 'FUNDERWALLET1111111111111111111111111111111', owners: ['a', 'b'], pct: 9 }];
  const cap = buildBubbleCaption({ symbol: 'BDOG', built, groups, funderChecked: 3, funderTotal: 3, source: 'rpc' });
  assert.match(cap, /\$BDOG Bubblemap/);
  assert.match(cap, /Top 3 wallets hold <b>12%<\/b> · largest <b>5\.0%<\/b>/);
  assert.match(cap, /1 linked group<\/b> · 2 wallets · 9\.0% of supply/);
  assert.match(cap, /solscan\.io\/account\/FUNDERWALLET/);
  assert.match(cap, /Funding checked for 3 of 3 wallets \(top 20 only on this RPC\)/);
  assert.match(buildBubbleCaption({ symbol: null, built, groups: [], funderChecked: 3, funderTotal: 3, source: 'das' }), /No wallets share a funder/);
  assert.ok(cap.length < 1024);
});

test('rowsFromRaw maps token accounts to their owners', () => {
  const raw = { largest: [{ address: 't1', amount: '500' }, { address: 't2', amount: '100' }], owners: new Map([['t1', 'ownerA']]) };
  assert.deepEqual(rowsFromRaw(raw), [{ owner: 'ownerA', amount: 500 }, { owner: 't2', amount: 100 }]);
  assert.deepEqual(rowsFromRaw(null), []);
});
