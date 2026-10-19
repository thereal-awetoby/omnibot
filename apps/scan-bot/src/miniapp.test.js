import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { buildMapPayload, startMiniApp, MAP_PAGE } from './miniapp.js';

const A = 'So11111111111111111111111111111111111111112';
const loaded = {
  built: { nodes: [{}, {}, {}], topPct: 12.34, poolPct: 30.04, burnPct: 1.26 },
  groups: [{ funder: 'FUNDER', owners: ['w2', 'w3'], pct: 4.5 }],
  funders: new Map([['w2', 'FUNDER'], ['w3', 'FUNDER']]),
  layout: {
    bubbles: [
      { owner: 'POOL', pct: 30, kind: 'pool', group: null, x: 10, y: 10, r: 80 },
      { owner: 'w3', pct: 2, kind: 'holder', group: 0, x: 30.123, y: 40, r: 20 },
      { owner: 'dev', pct: 5, kind: 'dev', group: null, x: 50, y: 60, r: 30 },
      { owner: 'w2', pct: 2.5, kind: 'holder', group: 0, x: 70, y: 80, r: 22 },
    ],
    clusters: [{ group: 0, x: 50, y: 60, r: 55.55 }],
  },
  checked: 3, total: 3, curve: false,
};

test('buildMapPayload ranks holders, puts the pool last, and carries funders and groups', () => {
  const p = buildMapPayload({ symbol: 'BDOG', name: 'Barber Dog', market: { marketCapUsd: 1_000_000, fdvUsd: 1_000_000, priceUsd: 0.001 }, loaded });
  assert.equal(p.mcapUsd, 1_000_000);
  assert.equal(p.supply, 1_000_000_000);
  assert.deepEqual(p.bubbles.map((b) => [b.owner, b.rank]), [['dev', 1], ['w2', 2], ['w3', 3], [null, null]]);
  assert.equal(p.bubbles[1].funder, 'FUNDER');
  assert.equal(p.bubbles[3].pct, 30.04);
  assert.equal(p.bubbles[3].funder, null);
  assert.deepEqual(p.groups, [{ funder: 'FUNDER', count: 2, pct: 4.5 }]);
  assert.equal(p.topPct, 12.3);
  assert.equal(p.poolLabel, 'Liquidity pool');
  assert.equal(buildMapPayload({ loaded: { ...loaded, curve: true } }).poolLabel, 'Bonding curve');
  assert.equal(p.clusters[0].r, 55.6);
  const more = [{ owner: 'w9', pct: 0.4, kind: 'holder' }, { owner: 'w10', pct: 0.3, kind: 'holder' }];
  const q = buildMapPayload({ symbol: 'BDOG', loaded: { ...loaded, more } });
  assert.deepEqual(q.others.map((o) => [o.owner, o.rank]), [['w9', 4], ['w10', 5]]);
  assert.equal(q.wallets, 3 + 2);
});

test('mini app server: page, data, bad address, cache, errors', async () => {
  let loads = 0;
  const server = startMiniApp({ port: 0, loadData: async (m) => { loads += 1; return m === A ? buildMapPayload({ symbol: 'X', loaded }) : null; }, log: { log() {}, error() {} } });
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (p) => new Promise((resolve, reject) => http.get(base + p, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, body: b })); }).on('error', reject));
  assert.equal((await get('/health')).body, 'ok');
  const page = await get('/map?mint=' + A);
  assert.equal(page.status, 200);
  assert.equal(page.body, MAP_PAGE);
  assert.match(page.body, /Copy address/);
  assert.equal((await get('/api/map?mint=nope')).status, 400);
  const ok = await get('/api/map?mint=' + A);
  assert.equal(ok.status, 200);
  assert.equal(JSON.parse(ok.body).symbol, 'X');
  assert.equal((await get('/api/map?mint=' + A)).status, 200);
  assert.equal(loads, 1); // the second answer came from the cache
  assert.equal((await get('/api/map?mint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')).status, 404);
  assert.equal((await get('/nothing')).status, 404);
  server.close();
});
