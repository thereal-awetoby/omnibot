import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRpcPool, parseRpcUrls, hostOf } from './rpcpool.js';

// A fake clock: sleeping just moves time forward, so tests run instantly.
function clock() { let t = 1_000_000; return { now: () => t, sleep: async (ms) => { t += ms; }, advance: (ms) => { t += ms; } }; }
const ok = () => ({ ok: true, status: 200 });
const status = (s) => ({ ok: false, status: s });

test('parseRpcUrls: RPC_URLS wins, comma list is trimmed, default is the public RPC', () => {
  assert.deepEqual(parseRpcUrls({ RPC_URLS: ' https://a.io/?k=1 , https://b.io ,, ', RPC_URL: 'https://x.io' }), ['https://a.io/?k=1', 'https://b.io']);
  assert.deepEqual(parseRpcUrls({ RPC_URL: 'https://x.io' }), ['https://x.io']);
  assert.deepEqual(parseRpcUrls({}), ['https://api.mainnet-beta.solana.com']);
  assert.deepEqual(parseRpcUrls({ RPC_URLS: ' , ' }), ['https://api.mainnet-beta.solana.com']);
});

test('hostOf never leaks the api key', () => {
  assert.equal(hostOf('https://mainnet.helius-rpc.com/?api-key=SECRET'), 'mainnet.helius-rpc.com');
  assert.equal(hostOf('not a url'), 'rpc');
});

test('one endpoint: four calls at once are queued 1/maxRps (100ms) apart', async () => {
  const waits = []; let t = 1_000_000;
  const pool = createRpcPool({ urls: ['https://a'], maxRps: 10, now: () => t, sleep: async (ms) => { waits.push(ms); }, fetchImpl: async () => ok() });
  await Promise.all([pool.fetch('x', {}), pool.fetch('x', {}), pool.fetch('x', {}), pool.fetch('x', {})]);
  assert.deepEqual(waits.map((w) => Math.round(w)), [100, 200, 300]); // the first goes straight through
});

test('two endpoints share the load, so they go about twice as fast', async () => {
  const c = clock(); const used = [];
  const pool = createRpcPool({ urls: ['https://a', 'https://b'], maxRps: 10, now: c.now, sleep: c.sleep, fetchImpl: async (u) => { used.push(u); return ok(); } });
  const start = c.now();
  await Promise.all(Array.from({ length: 10 }, () => pool.fetch('x', {})));
  assert.equal(used.filter((u) => u === 'https://a').length, 5);
  assert.equal(used.filter((u) => u === 'https://b').length, 5);
  assert.ok(c.now() - start <= 5 * 100, 'ten calls over two endpoints at 10/s each should take about 0.5s');
});

test('a 429 moves the call to the other endpoint at once; the limited endpoint cools down', async () => {
  const c = clock(); const log = [];
  const pool = createRpcPool({ urls: ['https://a', 'https://b'], maxRps: 10, now: c.now, sleep: c.sleep, cooldownMs: 1500,
    fetchImpl: async (u) => { log.push(u); return u === 'https://a' ? status(429) : ok(); } });
  const res = await pool.fetch('x', {});
  assert.equal(res.status, 200);
  assert.deepEqual(log, ['https://a', 'https://b']);
  const s = pool.stats();
  assert.equal(s.retries, 1);
  assert.equal(s.endpoints[0].limited, 1);
  // while "a" is cooling down, new calls prefer "b"
  log.length = 0;
  await pool.fetch('x', {});
  assert.deepEqual(log, ['https://b']);
});

test('a single endpoint retries once after its cooldown, then hands the 429 back', async () => {
  const c = clock(); let n = 0;
  const pool = createRpcPool({ urls: ['https://a'], maxRps: 10, now: c.now, sleep: c.sleep, cooldownMs: 1000,
    fetchImpl: async () => { n += 1; return n === 1 ? status(429) : ok(); } });
  const t0 = c.now();
  assert.equal((await pool.fetch('x', {})).status, 200);
  assert.ok(c.now() - t0 >= 1000);
  const always = createRpcPool({ urls: ['https://a'], now: c.now, sleep: c.sleep, fetchImpl: async () => status(429) });
  assert.equal((await always.fetch('x', {})).status, 429);
});

test('network errors fail over; if everything throws, the error surfaces', async () => {
  const c = clock();
  const pool = createRpcPool({ urls: ['https://a', 'https://b'], now: c.now, sleep: c.sleep, fetchImpl: async (u) => { if (u === 'https://a') throw new Error('socket'); return ok(); } });
  assert.equal((await pool.fetch('x', {})).status, 200);
  const dead = createRpcPool({ urls: ['https://a'], now: c.now, sleep: c.sleep, fetchImpl: async () => { throw new Error('offline'); } });
  await assert.rejects(dead.fetch('x', {}), /offline/);
});

test('fetchWhere only uses endpoints that match (for Helius-only APIs)', async () => {
  const c = clock(); const used = [];
  const pool = createRpcPool({ urls: ['https://api.other.io', 'https://mainnet.helius-rpc.com/?api-key=K'], now: c.now, sleep: c.sleep, fetchImpl: async (u) => { used.push(u); return ok(); } });
  await pool.fetchWhere((u) => u.includes('helius'), {});
  await pool.fetchWhere((u) => u.includes('helius'), {});
  assert.ok(used.every((u) => u.includes('helius')));
  await assert.rejects(pool.fetchWhere((u) => u.includes('alchemy'), {}), /No RPC endpoint/);
});
