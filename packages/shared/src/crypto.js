import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

function getKey() {
  const hex = process.env.WALLET_ENCRYPTION_KEY;
  if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('WALLET_ENCRYPTION_KEY must be 64 hex chars (32 bytes)');
  }
  return Buffer.from(hex, 'hex');
}

// AES-256-GCM. Output format: base64(iv[12] | tag[16] | ciphertext)
export function encryptSecret(plain) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', getKey(), iv);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
}

export function decryptSecret(blob) {
  const buf = Buffer.from(blob, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', getKey(), buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]);
}
