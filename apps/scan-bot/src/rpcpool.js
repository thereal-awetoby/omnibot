// Spreads Solana RPC calls over one or more endpoints. Each endpoint has its own per-second limit, so
// adding a second free endpoint (Alchemy, QuickNode...) doubles how many calls the bot can make per second.
// A call that gets "429 Too Many Requests" (or a 5xx / network error) is retried at once on the next endpoint,
// instead of waiting seconds like the default retry does.

export function parseRpcUrls(env = process.env) {
  const raw = env.RPC_URLS || env.RPC_URL || 'https://api.mainnet-beta.solana.com';
  const urls = raw.split(',').map((u) => u.trim()).filter(Boolean);
  return urls.length ? urls : ['https://api.mainnet-beta.solana.com'];
}

// "https://mainnet.helius-rpc.com/?api-key=SECRET" -> "mainnet.helius-rpc.com" (safe to print in logs)
export const hostOf = (u) => { try { return new URL(u).host; } catch { return 'rpc'; } };

export function createRpcPool({
  urls, maxRps = 8, fetchImpl = fetch, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), cooldownMs = 1500,
}) {
  const eps = urls.map((url) => ({ url, next: 0, coolUntil: 0, calls: 0, limited: 0 }));
  const stats = { calls: 0, retries: 0 };

  function pick(candidates, tried) {
    const t = now();
    let best = null; let bestAt = Infinity;
    for (const e of candidates) {
      if (tried.has(e)) continue;
      const at = Math.max(t, e.next, e.coolUntil);
      if (at < bestAt) { best = e; bestAt = at; }
    }
    return best ? { e: best, at: bestAt } : null;
  }

  // filter: optional (url) => boolean to limit which endpoints may be used (e.g. only Helius for its extra APIs).
  async function send(opts, filter = null) {
    const candidates = filter ? eps.filter((e) => filter(e.url)) : eps;
    if (!candidates.length) throw new Error('No RPC endpoint supports this request');
    const tried = new Set();
    let lastRes = null; let lastErr = null;
    for (let attempt = 0; attempt < candidates.length + 2; attempt++) {
      const choice = pick(candidates, tried) ?? (tried.clear(), pick(candidates, tried));
      const { e, at } = choice;
      e.next = at + 1000 / maxRps; // reserve this endpoint's next free slot
      const wait = at - now();
      if (wait > 0) await sleep(wait);
      stats.calls += 1; e.calls += 1;
      let res;
      try { res = await fetchImpl(e.url, opts); }
      catch (err) { lastErr = err; tried.add(e); e.coolUntil = now() + cooldownMs; stats.retries += 1; continue; }
      if (res.status === 429 || res.status >= 500) { lastRes = res; e.limited += 1; tried.add(e); e.coolUntil = now() + cooldownMs; stats.retries += 1; continue; }
      return res;
    }
    if (lastRes) return lastRes;
    throw lastErr ?? new Error('RPC unavailable');
  }

  return {
    // Drop-in `fetch` for @solana/web3.js (it passes its own URL, which we ignore on purpose).
    fetch: (_url, opts) => send(opts),
    fetchWhere: (filter, opts) => send(opts, filter),
    stats: () => ({ ...stats, endpoints: eps.map((e) => ({ host: hostOf(e.url), calls: e.calls, limited: e.limited })) }),
    size: eps.length,
  };
}
