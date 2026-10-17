import { Keypair, Connection, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import * as bip39 from 'bip39';
import { derivePath } from 'ed25519-hd-key';

export const connection = new Connection(
  process.env.RPC_URL || 'https://api.mainnet-beta.solana.com',
  'confirmed'
);

export function createWallet() {
  return Keypair.generate();
}

// Accepts: base58 secret key, JSON array of bytes, or a 12/24-word seed phrase.
// Returns a Keypair or throws.
export function parseImport(input) {
  const text = input.trim();

  if (text.startsWith('[')) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(text)));
  }

  if (text.split(/\s+/).length >= 12) {
    const phrase = text.split(/\s+/).join(' ').toLowerCase();
    if (!bip39.validateMnemonic(phrase)) throw new Error('Invalid seed phrase');
    const seed = bip39.mnemonicToSeedSync(phrase);
    const { key } = derivePath("m/44'/501'/0'/0'", seed.toString('hex'));
    return Keypair.fromSeed(key);
  }

  return Keypair.fromSecretKey(bs58.decode(text));
}

export function isValidAddress(s) {
  try { new PublicKey(s); return true; } catch { return false; }
}

// Number of decimals of an SPL token mint (works for Token-2022 too).
export async function getTokenDecimals(mint) {
  const info = await connection.getParsedAccountInfo(new PublicKey(mint));
  const decimals = info.value?.data?.parsed?.info?.decimals;
  if (typeof decimals !== 'number') throw new Error('That address is not a token mint');
  return decimals;
}

// On-chain facts about a token mint: decimals + whether mint/freeze authority are still set.
export async function getMintInfo(mint) {
  const info = await connection.getParsedAccountInfo(new PublicKey(mint));
  const parsed = info.value?.data?.parsed;
  if (parsed?.type !== 'mint') throw new Error('That address is not a token mint');
  return {
    decimals: parsed.info.decimals,
    mintAuthority: parsed.info.mintAuthority ?? null,
    freezeAuthority: parsed.info.freezeAuthority ?? null,
  };
}

export const secretToBase58 = (kp) => bs58.encode(kp.secretKey);
export const keypairFromBytes = (bytes) => Keypair.fromSecretKey(Uint8Array.from(bytes));

export async function getSolBalance(publicKey) {
  const lamports = await connection.getBalance(new PublicKey(publicKey));
  return lamports / LAMPORTS_PER_SOL;
}
