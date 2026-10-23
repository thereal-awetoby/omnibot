// Creating a token on pump.fun. Two network steps (signing lives in wallet.js), both easy to unit test with a mock fetch:
//  1. upload the logo + details to pump.fun's metadata storage (IPFS) -> a metadata link
//  2. ask PumpPortal for an unsigned "create" transaction, sign it locally, send it.
// The private key never leaves this process.

export const IPFS_URL = 'https://pump.fun/api/ipfs';
export const CREATE_URL = 'https://pumpportal.fun/api/trade-local';

export async function uploadMetadata({ imageBytes, mime, filename = 'logo', name, symbol, description, twitter, telegram, website, fetchImpl = fetch }) {
  const form = new FormData();
  form.append('file', new Blob([imageBytes], { type: mime }), filename);
  form.append('name', name);
  form.append('symbol', symbol);
  form.append('description', description);
  if (twitter) form.append('twitter', twitter);
  if (telegram) form.append('telegram', telegram);
  if (website) form.append('website', website);
  form.append('showName', 'true');
  const res = await fetchImpl(IPFS_URL, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`Metadata upload failed (${res.status}). Try again in a minute.`);
  const json = await res.json().catch(() => null);
  const uri = json?.metadataUri;
  if (typeof uri !== 'string' || !uri.startsWith('http')) throw new Error('Metadata upload gave no link. Try again in a minute.');
  return uri;
}

export async function fetchCreateTx({ publicKey, mintPublicKey, name, symbol, uri, devBuySol, slippagePct = 15, priorityFeeSol = 0.0005, fetchImpl = fetch }) {
  const res = await fetchImpl(CREATE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      publicKey,
      action: 'create',
      tokenMetadata: { name, symbol, uri },
      mint: mintPublicKey,
      denominatedInSol: 'true',
      amount: devBuySol,
      slippage: slippagePct,
      priorityFee: priorityFeeSol,
      pool: 'pump',
    }),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 160);
    throw new Error(`Could not build the create transaction (${res.status}) ${detail}`.trim());
  }
  return new Uint8Array(await res.arrayBuffer());
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Sends the signed transaction and waits up to ~60 s.
// -> { status: 'success', signature } | { status: 'failed', error, signature } | { status: 'unknown', signature }
export async function sendAndConfirm(connection, raw, { tries = 30, delayMs = 2000 } = {}) {
  let signature;
  try {
    signature = await connection.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 3 });
  } catch (e) {
    return { status: 'failed', error: explainSendError(e) };
  }
  for (let i = 0; i < tries; i++) {
    await sleep(delayMs);
    let st;
    try { st = (await connection.getSignatureStatuses([signature])).value[0]; } catch { continue; }
    if (st?.err) return { status: 'failed', signature, error: 'The network rejected the transaction.' };
    if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) return { status: 'success', signature };
  }
  return { status: 'unknown', signature };
}

export function explainSendError(e) {
  const m = String(e?.message ?? e);
  if (/insufficient|0x1\b|custom program error: 0x1/i.test(m)) return 'Not enough SOL in the wallet for this launch.';
  if (/blockhash/i.test(m)) return 'The transaction expired before it landed. Try again.';
  return `Could not send the transaction (${m.slice(0, 140)}).`;
}
