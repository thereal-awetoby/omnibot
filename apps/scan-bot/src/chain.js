// Reads token safety facts straight from Solana (free public RPC works, a paid one is faster).
import { Connection, PublicKey } from '@solana/web3.js';
import { computeHolderStats, computeFresh } from './security.js';
import { createdMintsFromTx } from './detail.js';
import { createRpcPool, parseRpcUrls } from './rpcpool.js';
import { parseDasAccounts, funderFromTx } from './bubblemap.js';

// Every RPC call goes through a small pool: each endpoint gets its own per-second limit (RPC_MAX_RPS, default 8),
// and a call that is refused with 429 is retried at once on the next endpoint. Put two or more free RPC URLs in
// RPC_URLS (comma separated) to multiply the speed. A single RPC_URL still works.
const rpcUrls = parseRpcUrls();
export const rpcPool = createRpcPool({ urls: rpcUrls, maxRps: Number(process.env.RPC_MAX_RPS) || 8 });
export const rpcStats = () => rpcPool.stats();
const connection = new Connection(rpcUrls[0], { commitment: 'confirmed', fetch: rpcPool.fetch, disableRetryOnRateLimit: true });
const PUMP_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');

const cache = new Map(); // mint -> { at, value }
const inflight = new Map(); // mint -> Promise, so two requests for one token share a single lookup
const TTL_MS = 60_000;

// Everything the RPC can tell us about a mint that does NOT depend on the market data, so it can start
// at the same time as the DexScreener call: authorities, supply, and the largest token accounts with their owners.
// Returns null when the mint can't be read. `largest` is null if only the holder lookup failed.
export function getSecurityRaw(mint) {
  const hit = cache.get(mint);
  if (hit && Date.now() - hit.at < TTL_MS) return Promise.resolve(hit.value);
  if (inflight.has(mint)) return inflight.get(mint);
  const p = loadRaw(mint)
    .catch((e) => { console.error('security error:', e.message); return null; })
    .then((value) => { if (value) cache.set(mint, { at: Date.now(), value }); inflight.delete(mint); return value; });
  inflight.set(mint, p);
  return p;
}

async function loadRaw(mint) {
  const mintKey = new PublicKey(mint);
  // The mint and its largest accounts do not depend on each other, so ask for both at once.
  const largestReq = connection.getTokenLargestAccounts(mintKey);
  largestReq.catch(() => {}); // handled below; avoids a stray rejection if the mint turns out unreadable
  const info = await connection.getParsedAccountInfo(mintKey);
  const parsed = info.value?.data?.parsed;
  if (parsed?.type !== 'mint') return null;
  const out = {
    mintAuthority: parsed.info.mintAuthority ?? null,
    freezeAuthority: parsed.info.freezeAuthority ?? null,
    supply: BigInt(parsed.info.supply ?? '0'),
    decimals: parsed.info.decimals,
    largest: null,
    owners: null,
  };
  try {
    const largest = (await largestReq).value.map((a) => ({ address: a.address.toBase58(), amount: a.amount }));
    const accs = await connection.getMultipleParsedAccounts(largest.map((a) => new PublicKey(a.address)));
    const owners = new Map();
    accs.value.forEach((acc, i) => { const o = acc?.data?.parsed?.info?.owner; if (o) owners.set(largest[i].address, o); });
    out.largest = largest;
    out.owners = owners;
  } catch (e) {
    console.error('holders error:', e.message);
  }
  return out;
}

// Raw RPC facts + the market's pool address -> the numbers the card shows:
// { mintAuthority, freezeAuthority, supply, decimals, top1Pct, top5Pct, top10Pct, top }.
export function withHolderStats(raw, mint, pairAddress = null) {
  if (!raw) return null;
  const out = {
    mintAuthority: raw.mintAuthority, freezeAuthority: raw.freezeAuthority, supply: raw.supply, decimals: raw.decimals,
    top1Pct: null, top5Pct: null, top10Pct: null, top: [],
  };
  if (raw.largest && raw.owners) {
    // The pool / bonding curve holds a big chunk of supply by design: don't count it as a "holder".
    const exclude = new Set();
    if (pairAddress) exclude.add(pairAddress);
    exclude.add(PublicKey.findProgramAddressSync([Buffer.from('bonding-curve'), new PublicKey(mint).toBuffer()], PUMP_PROGRAM_ID)[0].toBase58());
    const stats = computeHolderStats(raw.largest, raw.owners, raw.supply, exclude);
    if (stats) Object.assign(out, { top1Pct: stats.top1Pct, top5Pct: stats.top5Pct, top10Pct: stats.top10Pct, top: stats.top });
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
  await Promise.race([Promise.all([worker(), worker(), worker()]), new Promise((r) => setTimeout(r, 3_500))]);
  return computeFresh(top, ages);
}

// ---------- detail views (only run when the user taps a button) ----------

const TOKEN_PROGRAMS = [
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', // classic SPL Token
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', // Token-2022 (newer pump.fun tokens use this)
];

// Runs `fn` over `items` with a few at a time, and stops waiting after `deadlineMs` (partial results are fine).
async function pool(items, size, deadlineMs, fn) {
  const queue = [...items];
  const worker = async () => { for (let it = queue.shift(); it !== undefined; it = queue.shift()) await fn(it); };
  await Promise.race([Promise.all(Array.from({ length: size }, worker)), new Promise((r) => setTimeout(r, deadlineMs))]);
}

export async function getSolBalances(owners) {
  const out = new Map();
  try {
    const infos = await connection.getMultipleAccountsInfo(owners.map((o) => new PublicKey(o)));
    infos.forEach((acc, i) => out.set(owners[i], (acc?.lamports ?? 0) / 1e9));
  } catch (e) {
    console.error('sol balances error:', e.message);
  }
  return out;
}

// What else each wallet holds: Map(owner -> [{ mint, amount }]). Wallets that could not be read are left out.
export async function getHolderTokens(owners, deadlineMs = 8_000) {
  const out = new Map();
  await pool(owners, 4, deadlineMs, async (owner) => {
    try {
      const key = new PublicKey(owner);
      const lists = await Promise.all(TOKEN_PROGRAMS.map((p) => connection.getParsedTokenAccountsByOwner(key, { programId: new PublicKey(p) })));
      const byMint = new Map();
      for (const res of lists) {
        for (const { account } of res.value) {
          const info = account.data?.parsed?.info;
          const amt = info?.tokenAmount?.uiAmount;
          if (info?.mint && typeof amt === 'number' && amt > 0) byMint.set(info.mint, (byMint.get(info.mint) ?? 0) + amt);
        }
      }
      out.set(owner, [...byMint].map(([mint, amount]) => ({ mint, amount })));
    } catch (e) {
      console.error('holder tokens error:', e.message);
    }
  });
  return new Map(out);
}

// The wallet that created a token, read straight from Solana (used when RugCheck does not say).
// 1) pump.fun tokens: the bonding curve account stores its creator.  2) any token: the wallet that paid
// for the mint's first transaction. Returns an address or null.
export async function getCreatorOnChain(mint) {
  try {
    const mintKey = new PublicKey(mint);
    const curve = PublicKey.findProgramAddressSync([Buffer.from('bonding-curve'), mintKey.toBuffer()], PUMP_PROGRAM_ID)[0];
    const info = await connection.getAccountInfo(curve);
    if (info && info.owner.equals(PUMP_PROGRAM_ID) && info.data.length >= 81) return new PublicKey(info.data.subarray(49, 81)).toBase58();
  } catch (e) { console.error('creator (curve) error:', e.message); }
  try {
    const sigs = await connection.getSignaturesForAddress(new PublicKey(mint), { limit: 1000 });
    if (sigs.length && sigs.length < 1000) { // only trust the oldest entry when the whole history fit in one page
      const tx = await connection.getParsedTransaction(sigs.at(-1).signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
      const k0 = tx?.transaction?.message?.accountKeys?.[0];
      const payer = k0?.pubkey?.toBase58?.() ?? String(k0?.pubkey ?? k0 ?? '');
      if (payer) return payer;
    }
  } catch (e) { console.error('creator (first tx) error:', e.message); }
  return null;
}

export async function getSolBalance(owner) {
  try { return (await connection.getBalance(new PublicKey(owner))) / 1e9; } catch (e) { console.error('sol balance error:', e.message); return null; }
}

// Tokens a wallet created, found by reading its most recent transactions. Returns { launches, scannedTx } where
// launches = [{ mint, createdAt (ms) }]. Not the full history: only the last `limit` transactions are read.
export async function scanCreatedTokens(creator, { limit = 150, deadlineMs = 20_000 } = {}) {
  const sigs = (await connection.getSignaturesForAddress(new PublicKey(creator), { limit })).filter((s) => !s.err).map((s) => s.signature);
  const launches = [];
  let scanned = 0;
  const chunks = [];
  for (let i = 0; i < sigs.length; i += 25) chunks.push(sigs.slice(i, i + 25));
  const opts = { maxSupportedTransactionVersion: 0, commitment: 'confirmed' };
  await pool(chunks, 3, deadlineMs, async (chunk) => {
    let txs;
    try { txs = await connection.getParsedTransactions(chunk, opts); } // one batched request
    catch { txs = await Promise.all(chunk.map((sig) => connection.getParsedTransaction(sig, opts).catch(() => null))); } // RPC refuses batches
    for (const tx of txs) {
      scanned += 1;
      for (const mint of createdMintsFromTx(tx, creator)) launches.push({ mint, createdAt: tx?.blockTime ? tx.blockTime * 1000 : null });
    }
  });
  console.log(`dev scan: ${creator.slice(0, 6)}… read ${scanned}/${sigs.length} transactions, found ${launches.length} created token(s)`);
  return { launches: [...launches], scannedTx: scanned };
}

// For each top holder: the slot in which their token account first received the token (null if unknown).
// Used to spot wallets that all got in during the same block. `top` = [{ owner, pct }].
export async function getEarlyBuyers(raw, top, creator = null, { deadlineMs = 3_000, max = 10 } = {}) {
  if (!raw?.largest || !raw?.owners || !top?.length) return null;
  const accountOf = new Map();
  for (const a of raw.largest) { const o = raw.owners.get(a.address); if (o && !accountOf.has(o)) accountOf.set(o, a.address); }
  const entries = [];
  const todo = top.filter((h) => h.owner !== creator && accountOf.has(h.owner)).slice(0, max);
  await pool(todo, 5, deadlineMs, async (h) => {
    try {
      const sigs = await connection.getSignaturesForAddress(new PublicKey(accountOf.get(h.owner)), { limit: 1000 });
      const ok = sigs.filter((s) => !s.err);
      // only trust the oldest entry when the whole history fit in one page
      if (sigs.length < 1000 && ok.length) entries.push({ owner: h.owner, pct: h.pct, firstSlot: ok.at(-1).slot });
    } catch (e) {
      console.error('early buyer error:', e.message);
    }
  });
  return [...entries];
}

// The pump.fun bonding-curve wallet of a token (it holds the unsold supply, so it is not a "holder").
export const bondingCurveOf = (mint) => PublicKey.findProgramAddressSync([Buffer.from('bonding-curve'), new PublicKey(mint).toBuffer()], PUMP_PROGRAM_ID)[0].toBase58();

// Every holder of a token in one go, using Helius' getTokenAccounts (works on the free plan, needs a Helius URL in
// RPC_URL / RPC_URLS). Returns { rows: [{ owner, amount }], complete } or null when unavailable.
// `complete` is false when the token has more accounts than we are willing to page through.
export async function getHolderAccountsDas(mint, { maxPages = 3, pageSize = 1000 } = {}) {
  const rows = [];
  try {
    for (let page = 1; page <= maxPages; page++) {
      const res = await rpcPool.fetchWhere((u) => /helius/i.test(u), {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'omni', method: 'getTokenAccounts', params: { mint, page, limit: pageSize, options: { showZeroBalance: false } } }),
      });
      if (!res.ok) return null;
      const parsed = parseDasAccounts(await res.json());
      if (!parsed) return null;
      rows.push(...parsed.accounts);
      if (parsed.accounts.length < pageSize) return { rows, complete: true };
    }
    return { rows, complete: false };
  } catch (e) {
    console.error('holder list error:', e.message);
    return null;
  }
}

// Who first funded this wallet? Read from the wallet's oldest transaction. Wallets with a long history are skipped
// (their first transaction is far back and costs many calls). Result is remembered, so repeat maps are quick.
const funderCache = new Map(); // owner -> funder address | null
export async function getFunder(owner) {
  if (funderCache.has(owner)) return funderCache.get(owner);
  try {
    const sigs = await connection.getSignaturesForAddress(new PublicKey(owner), { limit: 200 });
    let funder = null;
    if (sigs.length > 0 && sigs.length < 200) {
      const tx = await connection.getParsedTransaction(sigs[sigs.length - 1].signature, { maxSupportedTransactionVersion: 0 });
      funder = funderFromTx(tx, owner);
    }
    if (funderCache.size > 5000) funderCache.clear();
    funderCache.set(owner, funder);
    return funder;
  } catch (e) {
    console.error('funder error:', e.message);
    return undefined; // unknown: not remembered, so a later map tries again
  }
}

// Funders for many wallets, 4 at a time, stopping at the deadline. Returns Map(owner -> funder | null | undefined).
export async function getFunders(owners, { deadlineMs = 11_000 } = {}) {
  const out = new Map();
  const queue = [...owners];
  const stopAt = Date.now() + deadlineMs;
  const worker = async () => {
    for (let o = queue.shift(); o; o = queue.shift()) {
      if (Date.now() > stopAt) return;
      out.set(o, await getFunder(o));
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  return out;
}
