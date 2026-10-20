import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hedge } from './hedge.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('hedge: a fast first answer never starts a twin', async () => {
  let calls = 0;
  assert.equal(await hedge(async () => { calls += 1; return 'a'; }, 50), 'a');
  await sleep(80);
  assert.equal(calls, 1);
});

test('hedge: a stalled first request is rescued by its twin', async () => {
  let calls = 0;
  const v = await hedge(async () => { calls += 1; if (calls === 1) { await sleep(500); return 'slow'; } return 'twin'; }, 30);
  assert.equal(v, 'twin');
});

test('hedge: an early failure starts the twin at once, and two failures reject', async () => {
  let calls = 0;
  assert.equal(await hedge(async () => { calls += 1; if (calls === 1) throw new Error('boom'); return 'ok'; }, 1000), 'ok');
  let n = 0;
  await assert.rejects(hedge(async () => { n += 1; throw new Error('down'); }, 1000), /down/);
  assert.equal(n, 2);
});
