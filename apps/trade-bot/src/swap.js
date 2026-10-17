// Builds, signs and sends one swap. No Telegram, no database: easy to unit test with a mock fetch.
import { VersionedTransaction } from '@solana/web3.js';
import { fetchOrder, executeOrder, executeSucceeded, explainExecuteFailure, tradeAmounts } from './jupiter.js';

// Takes Jupiter's unsigned base64 transaction, signs it with the wallet, returns base64 again.
export function signOrderTransaction(base64Tx, keypair) {
  const tx = VersionedTransaction.deserialize(Buffer.from(base64Tx, 'base64'));
  tx.sign([keypair]);
  return Buffer.from(tx.serialize()).toString('base64');
}

// Fetches a signable order. Throws a plain Error (with a readable message) when no swap is possible.
export async function prepareSwap({ keypair, inputMint, outputMint, amount, slippageBps, apiKey, fetchImpl }) {
  const order = await fetchOrder({
    inputMint, outputMint, amount, slippageBps, apiKey, fetchImpl,
    taker: keypair.publicKey.toBase58(),
  });
  if (!order?.transaction) {
    throw new Error(order?.errorMessage || order?.error || 'No route found for this swap (no liquidity, or not tradable yet).');
  }
  return order;
}

// Signs and sends a prepared order. Returns:
//   { status: 'success', signature, amounts }
//   { status: 'failed', error, signature? }       (did not land)
//   { status: 'unknown', error }                  (sent, outcome not confirmed: it may have landed)
export async function sendSwap({ order, keypair, side, apiKey, fetchImpl }) {
  let signedTransaction;
  try {
    signedTransaction = signOrderTransaction(order.transaction, keypair);
  } catch (e) {
    return { status: 'failed', error: `Could not sign the transaction (${e.message})` };
  }
  let result;
  try {
    result = await executeOrder({ signedTransaction, requestId: order.requestId, apiKey, fetchImpl });
  } catch (e) {
    return { status: e.unknown ? 'unknown' : 'failed', error: e.message };
  }
  if (executeSucceeded(result)) {
    return { status: 'success', signature: result.signature, amounts: tradeAmounts(result, order, side) };
  }
  return { status: 'failed', error: explainExecuteFailure(result), signature: result?.signature };
}
