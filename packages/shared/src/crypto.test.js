import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

process.env.WALLET_ENCRYPTION_KEY = randomBytes(32).toString('hex');
const { encryptSecret, decryptSecret } = await import('./crypto.js');

test('encrypt/decrypt roundtrip', () => {
  const secret = randomBytes(64);
  const blob = encryptSecret(secret);
  assert.ok(decryptSecret(blob).equals(secret));
});

test('each encryption uses a fresh IV', () => {
  const s = randomBytes(64);
  assert.notEqual(encryptSecret(s), encryptSecret(s));
});

test('tampered ciphertext is rejected', () => {
  const buf = Buffer.from(encryptSecret(randomBytes(64)), 'base64');
  buf[buf.length - 1] ^= 1;
  assert.throws(() => decryptSecret(buf.toString('base64')));
});
