import test from 'node:test';
import assert from 'node:assert/strict';
import { uploadMetadata, fetchCreateTx, sendAndConfirm, explainSendError } from './pump.js';

const okJson = (obj) => ({ ok: true, status: 200, json: async () => obj });

test('uploadMetadata sends a form and returns the link', async () => {
  let seen;
  const uri = await uploadMetadata({
    imageBytes: new Uint8Array([1, 2, 3]), mime: 'image/png', name: 'N', symbol: 'S', description: 'D', twitter: 'https://x.com/a',
    fetchImpl: async (url, init) => { seen = { url, init }; return okJson({ metadataUri: 'https://ipfs.io/ipfs/abc' }); },
  });
  assert.equal(uri, 'https://ipfs.io/ipfs/abc');
  assert.equal(seen.init.method, 'POST');
  assert.equal(seen.init.body.get('name'), 'N');
  assert.equal(seen.init.body.get('twitter'), 'https://x.com/a');
  assert.equal(seen.init.body.get('telegram'), null);
});
test('uploadMetadata errors are readable', async () => {
  await assert.rejects(uploadMetadata({ imageBytes: new Uint8Array(1), mime: 'image/png', name: 'N', symbol: 'S', description: 'D', fetchImpl: async () => ({ ok: false, status: 500 }) }), /Metadata upload failed/);
  await assert.rejects(uploadMetadata({ imageBytes: new Uint8Array(1), mime: 'image/png', name: 'N', symbol: 'S', description: 'D', fetchImpl: async () => okJson({}) }), /no link/);
});
test('fetchCreateTx posts the create request', async () => {
  let body;
  const bytes = await fetchCreateTx({
    publicKey: 'PK', mintPublicKey: 'MINT', name: 'N', symbol: 'S', uri: 'https://u', devBuySol: 0.5,
    fetchImpl: async (url, init) => { body = JSON.parse(init.body); return { ok: true, arrayBuffer: async () => new Uint8Array([9, 8]).buffer }; },
  });
  assert.deepEqual([...bytes], [9, 8]);
  assert.equal(body.action, 'create');
  assert.equal(body.mint, 'MINT');
  assert.equal(body.amount, 0.5);
  assert.equal(body.tokenMetadata.uri, 'https://u');
  await assert.rejects(fetchCreateTx({ publicKey: 'a', mintPublicKey: 'b', name: 'n', symbol: 's', uri: 'u', devBuySol: 0, fetchImpl: async () => ({ ok: false, status: 400, text: async () => 'bad' }) }), /400/);
});
test('sendAndConfirm outcomes', async () => {
  const mk = (statuses, sendErr) => ({
    sendRawTransaction: async () => { if (sendErr) throw new Error(sendErr); return 'SIG'; },
    getSignatureStatuses: async () => ({ value: [statuses.shift() ?? null] }),
  });
  assert.deepEqual(await sendAndConfirm(mk([null, { confirmationStatus: 'confirmed' }]), new Uint8Array(1), { tries: 3, delayMs: 1 }), { status: 'success', signature: 'SIG' });
  assert.equal((await sendAndConfirm(mk([{ err: {} }]), new Uint8Array(1), { tries: 3, delayMs: 1 })).status, 'failed');
  assert.equal((await sendAndConfirm(mk([null, null]), new Uint8Array(1), { tries: 2, delayMs: 1 })).status, 'unknown');
  const f = await sendAndConfirm(mk([], 'Blockhash not found'), new Uint8Array(1));
  assert.equal(f.status, 'failed');
  assert.match(f.error, /expired/);
  assert.match(explainSendError(new Error('insufficient lamports')), /Not enough SOL/);
});
