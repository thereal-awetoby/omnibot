import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findLinkedWallets, within } from './intel.js';

test('within: resolves early on success, falls back on timeout or rejection', async () => {
  assert.equal(await within(Promise.resolve('fast'), 50), 'fast');
  assert.equal(await within(new Promise((r) => setTimeout(() => r('slow'), 200)), 20, 'fallback'), 'fallback');
  assert.equal(await within(Promise.reject(new Error('boom')), 50, 'fallback'), 'fallback');
  assert.equal(await within(Promise.reject(new Error('boom')), 50), null); // default fallback is null
});

test('findLinkedWallets: too few holders to say anything', async () => {
  assert.equal(await findLinkedWallets([]), null);
  assert.equal(await findLinkedWallets([{ owner: 'a', pct: 5 }]), null); // only one owner
  assert.equal(await findLinkedWallets(null), null);
});

test('findLinkedWallets: groups holders that share a funder, ignores ones that don\'t', async () => {
  const top = [{ owner: 'a', pct: 5 }, { owner: 'b', pct: 4 }, { owner: 'c', pct: 3 }, { owner: 'd', pct: 2 }];
  const fakeGetFunders = async (owners) => new Map(owners.map((o) => [o, o === 'd' ? null : 'FUNDER1']));
  const r = await findLinkedWallets(top, fakeGetFunders);
  assert.equal(r.groups.length, 1);
  assert.deepEqual(r.groups[0].owners, ['a', 'b', 'c']);
  assert.equal(Math.round(r.groups[0].pct * 10) / 10, 12);
  assert.equal(r.checked, 3); // 'd' had no funder found
});

test('findLinkedWallets: no shared funders found at all -> null, not an empty-groups object', async () => {
  const top = [{ owner: 'a', pct: 5 }, { owner: 'b', pct: 4 }];
  const r = await findLinkedWallets(top, async () => new Map());
  assert.equal(r, null);
});

test('findLinkedWallets: a getFunders implementation that never resolves falls back to null (time-boxed)', async () => {
  const r = await findLinkedWallets([{ owner: 'a', pct: 5 }, { owner: 'b', pct: 4 }], () => new Promise(() => {}));
  assert.equal(r, null);
});

test('findLinkedWallets: only checks the biggest few holders, even when given a long top list', async () => {
  const top = Array.from({ length: 30 }, (_, i) => ({ owner: `w${i}`, pct: 1 }));
  let seen = null;
  const r = await findLinkedWallets(top, async (owners) => { seen = owners; return new Map(owners.map((o) => [o, 'F'])); });
  assert.ok(seen.length <= 8, `checked too many owners: ${seen.length}`);
  const totalOwners = r.groups.reduce((a, g) => a + g.owners.length, 0);
  assert.ok(totalOwners <= 8);
});
