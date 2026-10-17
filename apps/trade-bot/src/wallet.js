import { Keypair, Connection, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import { PUMP_PROGRAM_ID, PUMP_GLOBAL_ACCOUNT, DEFAULT_INITIAL_REAL_TOKENS, parsePumpCurve, parsePumpGlobal } from './token.js';
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

// pump.fun bonding-curve account for a token, or null if it never had one.
export async function getPumpCurve(mint) {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('bonding-curve'), new PublicKey(mint).toBuffer()],
    new PublicKey(PUMP_PROGRAM_ID)
  );
  const info = await connection.getAccountInfo(pda);
  if (!info || info.owner.toBase58() !== PUMP_PROGRAM_ID) return null;
  return parsePumpCurve(info.data);
}

let cachedInitialRealTokens = null;
// How many tokens a fresh pump.fun curve sells (read once, then cached). Falls back to the known value.
export async function getPumpInitialRealTokens() {
  if (cachedInitialRealTokens) return cachedInitialRealTokens;
  try {
    const info = await connection.getAccountInfo(new PublicKey(PUMP_GLOBAL_ACCOUNT));
    cachedInitialRealTokens = parsePumpGlobal(info?.data) ?? DEFAULT_INITIAL_REAL_TOKENS;
  } catch {
    return DEFAULT_INITIAL_REAL_TOKENS; // do not cache a failure
  }
  return cachedInitialRealTokens;
}

const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_2022_PROGRAM = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');

// Every token the wallet holds (classic + Token-2022): Map(mint -> raw balance as BigInt).
export async function getTokenBalances(ownerPublicKey) {
  const owner = new PublicKey(ownerPublicKey);
  const out = new Map();
  for (const programId of [TOKEN_PROGRAM, TOKEN_2022_PROGRAM]) {
    const res = await connection.getParsedTokenAccountsByOwner(owner, { programId });
    for (const { account } of res.value) {
      const info = account.data?.parsed?.info;
      if (!info?.mint) continue;
      const amt = BigInt(info.tokenAmount?.amount ?? '0');
      out.set(info.mint, (out.get(info.mint) ?? 0n) + amt);
    }
  }
  return out;
}
