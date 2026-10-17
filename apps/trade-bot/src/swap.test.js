import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, VersionedTransaction, TransactionMessage, SystemProgram } from '@solana/web3.js';
import { signOrderTransaction, prepareSwap, sendSwap } from './swap.js';
import { fetchOrder, executeOrder, tradeAmounts, executeSucceeded, explainExecuteFailure, SOL_MINT } from './jupiter.js';

function unsignedTx(payer) {
  const msg = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: '11111111111111111111111111111111',
    instructions: [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 })],
  }).compileToV0Message();
  return Buffer.from(new VersionedTransaction(msg).serialize()).toString('base64');
}

const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

test('signOrderTransaction produces a valid signature from the wallet', () => {
  const kp = Keypair.generate();
  const signed = signOrderTransaction(unsignedTx(kp), kp);
  const tx = VersionedTransaction.deserialize(Buffer.from(signed, 'base64'));
  assert.equal(tx.signatures.length, 1);
  assert.ok(tx.signatures[0].some((b) => b !== 0));
});

test('fetchOrder sends taker and slippage', async () => {
  let seen;
  await fetchOrder({ inputMint: 'A', outputMint: 'B', amount: 5n, taker: 'T', slippageBps: 300, fetchImpl: async (u) => { seen = new URL(u); return json(200, {}); } });
  assert.equal(seen.searchParams.get('inputMint'), 'A');
  assert.equal(seen.searchParams.get('outputMint'), 'B');
  assert.equal(seen.searchParams.get('amount'), '5');
  assert.equal(seen.searchParams.get('taker'), 'T');
  assert.equal(seen.searchParams.get('slippageBps'), '300');
});

test('prepareSwap throws a readable error when there is no transaction', async () => {
  const kp = Keypair.generate();
  const fetchImpl = async () => json(200, { outAmount: '0', transaction: '', errorMessage: 'Insufficient funds' });
  await assert.rejects(prepareSwap({ keypair: kp, inputMint: SOL_MINT, outputMint: 'B', amount: 1n, slippageBps: 100, fetchImpl }), /Insufficient funds/);
});

test('tradeAmounts maps buy and sell correctly and falls back to the order', () => {
  const order = { inAmount: '100', outAmount: '5000' };
  assert.deepEqual(tradeAmounts({ totalInputAmount: '110', totalOutputAmount: '4900' }, order, 'buy'), { solLamports: 110n, tokenRaw: 4900n });
  assert.deepEqual(tradeAmounts({ inputAmountResult: '90', outputAmountResult: '4800' }, order, 'buy'), { solLamports: 90n, tokenRaw: 4800n });
  assert.deepEqual(tradeAmounts({}, order, 'buy'), { solLamports: 100n, tokenRaw: 5000n });
  assert.deepEqual(tradeAmounts({ totalInputAmount: '5000', totalOutputAmount: '95' }, order, 'sell'), { solLamports: 95n, tokenRaw: 5000n });
  assert.deepEqual(tradeAmounts({}, {}, 'sell'), { solLamports: null, tokenRaw: null });
});

test('executeSucceeded / explainExecuteFailure', () => {
  assert.equal(executeSucceeded({ status: 'Success', signature: 'abc' }), true);
  assert.equal(executeSucceeded({ status: 'Success' }), false);
  assert.equal(executeSucceeded({ status: 'Failed', signature: 'abc' }), false);
  assert.match(explainExecuteFailure({ code: -2003 }), /expired/);
  assert.equal(explainExecuteFailure({ error: 'boom' }), 'boom');
  assert.match(explainExecuteFailure({ code: 7 }), /code 7/);
});

test('executeOrder: network failure is "unknown", HTTP 400 with body is returned', async () => {
  await assert.rejects(
    executeOrder({ signedTransaction: 's', requestId: 'r', fetchImpl: async () => { throw new Error('timeout'); } }),
    (e) => e.unknown === true && /timeout/.test(e.message)
  );
  const r = await executeOrder({ signedTransaction: 's', requestId: 'r', fetchImpl: async () => json(400, { status: 'Failed', code: -1 }) });
  assert.equal(r.code, -1);
});

test('sendSwap: success, failure and unknown outcomes', async () => {
  const kp = Keypair.generate();
  const order = { transaction: unsignedTx(kp), requestId: 'req', inAmount: '100', outAmount: '5000' };
  const ok = await sendSwap({ order, keypair: kp, side: 'buy', fetchImpl: async () => json(200, { status: 'Success', signature: 'SIG', totalInputAmount: '100', totalOutputAmount: '4990' }) });
  assert.equal(ok.status, 'success');
  assert.equal(ok.signature, 'SIG');
  assert.deepEqual(ok.amounts, { solLamports: 100n, tokenRaw: 4990n });

  const failed = await sendSwap({ order, keypair: kp, side: 'buy', fetchImpl: async () => json(200, { status: 'Failed', code: -2000 }) });
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /failed to land/);

  const unknown = await sendSwap({ order, keypair: kp, side: 'sell', fetchImpl: async () => { throw new Error('socket hang up'); } });
  assert.equal(unknown.status, 'unknown');

  const badTx = await sendSwap({ order: { ...order, transaction: 'not-a-tx' }, keypair: kp, side: 'buy', fetchImpl: async () => json(200, {}) });
  assert.equal(badTx.status, 'failed');
});
