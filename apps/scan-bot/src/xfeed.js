// Reading the posts of followed X accounts, and finding token addresses in them. Pure helpers plus small fetchers.
// X has no free official feed, so the sources are tried in order and any of them may stop working: the bot keeps
// the result of every check (ok / error) so /following can say what is going on.
const MINT = /(?<![1-9A-HJ-NP-Za-km-z])[1-9A-HJ-NP-Za-km-z]{32,44}(?![1-9A-HJ-NP-Za-km-z])/g;

// "@Name", "name", "https://x.com/Name/status/123" -> "name" (lower case), or null
export function normHandle(input) {
  let s = String(input ?? '').trim();
  const m = /(?:^|\/\/)(?:www\.|mobile\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})(?:[/?#]|$)/i.exec(s);
  if (m) s = m[1];
  s = s.replace(/^@/, '');
  return /^[A-Za-z0-9_]{1,15}$/.test(s) ? s.toLowerCase() : null;
}

// Token addresses in a post (text and the links it contains), first seen first.
export function extractMints(text, urls = []) {
  const hay = [String(text ?? ''), ...urls.map(String)].join(' \n ');
  const out = [];
  for (const m of hay.matchAll(MINT)) {
    const a = m[0];
    if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a) && !out.includes(a)) out.push(a);
  }
  return out;
}

// A tweet id is a 64-bit number: compare as BigInt.
export const newerId = (a, b) => { try { return BigInt(a) > BigInt(b); } catch { return false; } };

// Which posts are new for a chat: those after its cursor (a chat that has no cursor yet only learns the newest id),
// not older than maxAgeMs (so a restart does not replay old posts), no plain retweets. Returns { fresh (oldest first), cursor }.
export function pickNew(tweets, cursor, { now = Date.now(), maxAgeMs = 45 * 60_000 } = {}) {
  const sorted = [...tweets].sort((a, b) => (newerId(a.id, b.id) ? -1 : 1));
  const newest = sorted[0]?.id ?? cursor ?? null;
  if (!cursor) return { fresh: [], cursor: newest };
  const fresh = sorted
    .filter((t) => newerId(t.id, cursor) && !t.isRetweet && (!t.createdAt || now - t.createdAt <= maxAgeMs))
    .reverse();
  return { fresh, cursor: newest && newerId(newest, cursor) ? newest : cursor };
}

// A made-up but stable negative id for a followed account, so its calls never clash with a real Telegram user.
export function xCallerId(handle) {
  let h = 5381;
  for (const c of String(handle)) h = ((h * 33) ^ c.charCodeAt(0)) >>> 0;
  return -(1_000_000_000 + (h % 900_000_000));
}

const decode = (s) => String(s ?? '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
const ms = (v) => { const t = Date.parse(v); return Number.isFinite(t) ? t : null; };

// ---- source 1: X's embedded profile timeline (no key, unofficial) ----
export function parseSyndication(html) {
  const m = /<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(String(html ?? ''));
  if (!m) return null;
  let data;
  try { data = JSON.parse(m[1]); } catch { return null; }
  const entries = data?.props?.pageProps?.timeline?.entries;
  if (!Array.isArray(entries)) return null;
  const out = [];
  for (const e of entries) {
    const t = e?.content?.tweet ?? e?.content;
    const id = t?.id_str ?? (t?.id != null ? String(t.id) : null);
    if (!id || !/^\d+$/.test(id)) continue;
    const urls = [...(t.entities?.urls ?? []), ...(t.quoted_status?.entities?.urls ?? [])].map((u) => u?.expanded_url ?? u?.url).filter(Boolean);
    out.push({
      id,
      text: decode(t.full_text ?? t.text ?? ''),
      urls,
      createdAt: ms(t.created_at),
      isRetweet: Boolean(t.retweeted_status) || /^RT @/.test(t.full_text ?? t.text ?? ''),
    });
  }
  return out;
}

// ---- source 2: a Nitter-style RSS feed (NITTER_URLS in .env) ----
export function parseRss(xml) {
  const items = String(xml ?? '').match(/<item>[\s\S]*?<\/item>/g);
  if (!items) return null;
  const out = [];
  for (const it of items) {
    const link = /<link>([^<]+)<\/link>/.exec(it)?.[1] ?? /<guid[^>]*>([^<]+)<\/guid>/.exec(it)?.[1] ?? '';
    const id = /status\/(\d+)/.exec(link)?.[1];
    if (!id) continue;
    const title = decode(/<title>([\s\S]*?)<\/title>/.exec(it)?.[1] ?? '');
    const desc = decode((/<description>([\s\S]*?)<\/description>/.exec(it)?.[1] ?? '').replace(/^<!\[CDATA\[|\]\]>$/g, ''));
    const urls = [...(/<description>[\s\S]*?<\/description>/.exec(it)?.[0] ?? '').matchAll(/href="([^"]+)"/g)].map((x) => x[1]);
    out.push({ id, text: desc || title, urls, createdAt: ms(/<pubDate>([^<]+)<\/pubDate>/.exec(it)?.[1]), isRetweet: /^RT by /.test(title) || /^RT @/.test(title) });
  }
  return out;
}

// ---- source 3: the official X API (X_BEARER_TOKEN in .env, paid plan) ----
export function parseApiTweets(json) {
  const list = json?.data;
  if (!Array.isArray(list)) return null;
  return list.map((t) => ({
    id: String(t.id),
    text: String(t.text ?? ''),
    urls: (t.entities?.urls ?? []).map((u) => u.expanded_url ?? u.url).filter(Boolean),
    createdAt: ms(t.created_at),
    isRetweet: (t.referenced_tweets ?? []).some((r) => r.type === 'retweeted'),
  }));
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
async function viaSyndication(handle, fetchFn) {
  const res = await fetchFn(`https://syndication.twitter.com/srv/timeline-profile/screen-name/${handle}`, { headers: { 'user-agent': UA, accept: 'text/html' }, signal: AbortSignal.timeout(9_000) });
  if (!res.ok) throw new Error(`X embed HTTP ${res.status}`);
  const t = parseSyndication(await res.text());
  if (!t) throw new Error('X embed gave no timeline');
  return t;
}
async function viaNitter(handle, base, fetchFn) {
  const res = await fetchFn(`${base.replace(/\/+$/, '')}/${handle}/rss`, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(9_000) });
  if (!res.ok) throw new Error(`${new URL(base).host} HTTP ${res.status}`);
  const t = parseRss(await res.text());
  if (!t) throw new Error(`${new URL(base).host} gave no feed`);
  return t;
}
async function viaApi(handle, token, fetchFn) {
  const h = { authorization: `Bearer ${token}` };
  const u = await fetchFn(`https://api.x.com/2/users/by/username/${handle}`, { headers: h, signal: AbortSignal.timeout(9_000) });
  if (!u.ok) throw new Error(`X API HTTP ${u.status}`);
  const id = (await u.json())?.data?.id;
  if (!id) throw new Error('X API: no such account');
  const r = await fetchFn(`https://api.x.com/2/users/${id}/tweets?max_results=20&tweet.fields=created_at,entities,referenced_tweets&exclude=replies`, { headers: h, signal: AbortSignal.timeout(9_000) });
  if (!r.ok) throw new Error(`X API HTTP ${r.status}`);
  const t = parseApiTweets(await r.json());
  if (!t) throw new Error('X API gave no posts');
  return t;
}

// Tries every configured source. Returns { tweets, via } or { error }.
export async function fetchTweets(handle, { env = process.env, fetchFn = fetch } = {}) {
  const tries = [];
  if (env.X_BEARER_TOKEN) tries.push(['x-api', () => viaApi(handle, env.X_BEARER_TOKEN, fetchFn)]);
  for (const base of String(env.NITTER_URLS ?? '').split(',').map((s) => s.trim()).filter((s) => /^https:\/\//.test(s))) tries.push([`nitter ${new URL(base).host}`, () => viaNitter(handle, base, fetchFn)]);
  tries.push(['x-embed', () => viaSyndication(handle, fetchFn)]);
  const errors = [];
  for (const [via, run] of tries) {
    try { return { tweets: await run(), via }; } catch (e) { errors.push(`${via}: ${e.message}`); }
  }
  return { error: errors.join(' | ').slice(0, 200) };
}
