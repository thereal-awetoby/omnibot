// Reads token safety facts straight from Solana (free public RPC works, a paid one is faster).
import { Connection, PublicKey } from '@solana/web3.js';
import { computeHolderStats, computeFresh } from './security.js';

const connection = new Connection(process.env.RPC_URL || 'https://api.mainnet-beta.solana.com', 'confirmed');
const PUMP_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');

const cache = new Map(); // mint -> { at, value }
const TTL_MS = 60_000;

// { mintAuthority, freezeAuthority, supply, decimals, top1Pct, top5Pct, top10Pct } or null when the mint can't be read.
// Holder numbers are null if the holder lookup fails but the mint itself was readable.
export async function getSecurity(mint, { pairAddress = null } = {}) {
  const hit = cache.get(mint);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const value = await load(mint, pairAddress).catch((e) => { console.error('security error:', e.message); return null; });
  if (value) cache.set(mint, { at: Date.now(), value });
  return value;
}

async function load(mint, pairAddress) {
  const mintKey = new PublicKey(mint);
  const info = await connection.getParsedAccountInfo(mintKey);
  const parsed = info.value?.data?.parsed;
  if (parsed?.type !== 'mint') return null;
  const out = {
    mintAuthority: parsed.info.mintAuthority ?? null,
    freezeAuthority: parsed.info.freezeAuthority ?? null,
    supply: BigInt(parsed.info.supply ?? '0'),
    decimals: parsed.info.decimals,
    top1Pct: null, top5Pct: null, top10Pct: null, top: [],
  };
  try {
    const largest = (await connection.getTokenLargestAccounts(mintKey)).value.map((a) => ({ address: a.address.toBase58(), amount: a.amount }));
    const accs = await connection.getMultipleParsedAccounts(largest.map((a) => new PublicKey(a.address)));
    const owners = new Map();
    accs.value.forEach((acc, i) => { const o = acc?.data?.parsed?.info?.owner; if (o) owners.set(largest[i].address, o); });
    // The pool / bonding curve holds a big chunk of supply by design: don't count it as a "holder".
    const exclude = new Set();
    if (pairAddress) exclude.add(pairAddress);
    exclude.add(PublicKey.findProgramAddressSync([Buffer.from('bonding-curve'), mintKey.toBuffer()], PUMP_PROGRAM_ID)[0].toBase58());
    const stats = computeHolderStats(largest, owners, out.supply, exclude);
    if (stats) Object.assign(out, { top1Pct: stats.top1Pct, top5Pct: stats.top5Pct, top10Pct: stats.top10Pct, top: stats.top });
  } catch (e) {
    console.error('holders error:', e.message);
  }
  return out;
}

// Share of supply still held by the token creator's wallet (0 = sold or moved everything). null if unreadable.
export async function getDevHolding(creator, mint, supply) {
  if (!creator || !supply || BigInt(supply) <= 0n) return null;
  try {
    const res = await connection.getParsedTokenAccountsByOwner(new PublicKey(creator), { mint: new PublicKey(mint) });
    const held = res.value.reduce((a, x) => a + BigInt(x.account.data.parsed.info.tokenAmount.amount), 0n);
    return Number((held * 10000n) / BigInt(supply)) / 100;
  } catch (e) {
    console.error('dev holding error:', e.message);
    return null;
  }
}

// Wallet age in days from its oldest transaction. Only trusted when the whole history fits in one page
// (under 100 transactions) or the page already reaches back more than 7 days. Otherwise null (unknown).
const ageCache = new Map(); // owner -> age in days | null
async function walletAgeDays(owner, nowSec) {
  if (ageCache.has(owner)) return ageCache.get(owner);
  let age = null;
  try {
    const sigs = await connection.getSignaturesForAddress(new PublicKey(owner), { limit: 100 });
    const oldest = sigs.at(-1)?.blockTime;
    if (sigs.length === 0) age = 0;
    else if (oldest) {
      const days = (nowSec - oldest) / 86_400;
      if (sigs.length < 100 || days >= 7) age = days; // full history known, or provably old
    }
  } catch (e) {
    console.error('wallet age error:', e.message);
    return null; // do not cache failures
  }
  if (ageCache.size > 5000) ageCache.clear();
  ageCache.set(owner, age);
  return age;
}

// Fresh-wallet share among the top holders: { fresh1dPct, fresh7dPct, walletsChecked } or null.
export async function getFreshWallets(top) {
  if (!top?.length) return null;
  const nowSec = Math.floor(Date.now() / 1000);
  const ages = new Map();
  const queue = [...top];
  const worker = async () => { for (let h = queue.shift(); h; h = queue.shift()) ages.set(h.owner, await walletAgeDays(h.owner, nowSec)); };
  await Promise.race([Promise.all([worker(), worker(), worker()]), new Promise((r) => setTimeout(r, 7_000))]);
  return computeFresh(top, ages);
}
