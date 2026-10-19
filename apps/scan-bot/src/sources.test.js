import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRugCheck, fetchRugCheck, parseOhlcv, fetchAth, describeAth, parsePumpCreated, fetchPumpCreated, fetchLoreAI, fetchLoreStory, pickGeminiModels, getLastLoreError, parseTweetOembed, fetchTweetText, fetchImageInline, parseNewsRss, fetchNews, parseSearch, searchTokens, parseDexPaid, fetchDexPaid, fetchPriceSeries, buildChartUrl, parseGeckoHolders, fetchHolderCount, resetRugBreaker } from './sources.js';

const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

const report = {
  totalHolders: 1812, creator: 'DEV', rugged: false,
  topHolders: [
    { owner: 'POOL', pct: 40, insider: false }, { owner: 'a', pct: 8, insider: true }, { owner: 'b', pct: 5.5, insider: true }, { owner: 'c', pct: 3, insider: false },
  ],
  knownAccounts: { POOL: { name: 'Raydium', type: 'AMM' } },
  insiderNetworks: [{ id: 1, size: 4 }, { id: 2, activeAccounts: 3 }],
  markets: [
    { lp: { lpLockedPct: 0, baseUSD: 10, quoteUSD: 10 } },
    { lp: { lpLockedPct: 100, baseUSD: 5000, quoteUSD: 5000 } },
  ],
  risks: [{ name: 'Low Liquidity', level: 'warn' }, { name: 'ok thing', level: 'info' }, { name: 'Mint Authority still enabled', level: 'danger' }],
};

test('parseRugCheck keeps what the card needs and skips pools when summing insiders', () => {
  const r = parseRugCheck(report);
  assert.equal(r.totalHolders, 1812);
  assert.equal(r.insiderPct, 13.5);
  assert.equal(r.insiderNetworks, 2);
  assert.equal(r.insiderWallets, 7);
  assert.deepEqual(r.top.map((h) => h.owner), ['a', 'b', 'c']); // pool removed
  assert.equal(r.top1Pct, 8);
  assert.equal(r.top10Pct, 16.5);
  assert.equal(r.lpLockedPct, 100); // the biggest pool wins, not the first
  assert.equal(r.creator, 'DEV');
  assert.equal(r.rugged, false);
  assert.deepEqual(r.risks.map((x) => x.name), ['Low Liquidity', 'Mint Authority still enabled']);
});

test('parseRugCheck survives empty and odd payloads', () => {
  assert.equal(parseRugCheck(null), null);
  const r = parseRugCheck({});
  assert.equal(r.totalHolders, null);
  assert.equal(r.insiderPct, null);
  assert.equal(r.lpLockedPct, null);
  assert.equal(r.creator, null);
  assert.deepEqual(r.risks, []);
  assert.equal(parseRugCheck({ rugged: true }).rugged, true);
  assert.equal(parseRugCheck({ markets: [{ lp: { lpLockedPct: 250 } }] }).lpLockedPct, 100);
});

test('fetchRugCheck: after two unreachable lookups it stops asking for a while', async () => {
  resetRugBreaker();
  let calls = 0;
  const down = async () => { calls += 1; throw new Error('fetch failed'); };
  assert.equal(await fetchRugCheck('MINT_BRK_1', down), null);
  assert.equal(await fetchRugCheck('MINT_BRK_2', down), null);
  const before = calls;
  assert.equal(await fetchRugCheck('MINT_BRK_3', down), null);
  assert.equal(calls, before); // skipped: no request was made
  resetRugBreaker();
  assert.equal((await fetchRugCheck('MINT_BRK_4', async () => json({ markets: [] }, 200))) === undefined, false);
  resetRugBreaker();
});

test('fetchRugCheck calls the keyless endpoint, caches, and returns null on errors', async () => {
  let calls = 0; let url;
  const impl = async (u) => { calls += 1; url = u; return json(report); };
  const a = await fetchRugCheck('MINT_RUG_1', impl);
  const b = await fetchRugCheck('MINT_RUG_1', impl);
  assert.equal(url, 'https://api.rugcheck.xyz/v1/tokens/MINT_RUG_1/report');
  assert.equal(calls, 1);
  assert.equal(a.totalHolders, b.totalHolders);
  assert.equal(await fetchRugCheck('MINT_RUG_2', async () => json({}, 500)), null);
  assert.equal(await fetchRugCheck('MINT_RUG_3', async () => { throw new Error('offline'); }), null);
});

test('parseOhlcv finds the highest high and its time', () => {
  const candles = [[1000, 1, 2, 0.5, 1.5, 10], [2000, 1.5, 9, 1, 3, 10], [3000, 3, 4, 2, 2.5, 10], [4000, 1, 'x', 1, 1, 1]];
  assert.deepEqual(parseOhlcv(candles), { athPrice: 9, athAt: 2_000_000 });
  assert.equal(parseOhlcv([]), null);
  assert.equal(parseOhlcv(null), null);
});

test('describeAth converts to market cap and distance from ATH', () => {
  const market = { priceUsd: 0.5, marketCapUsd: 500_000 }; // supply = 1,000,000
  const d = describeAth({ athPrice: 1, athAt: 5 }, market);
  assert.equal(d.athMcapUsd, 1_000_000);
  assert.equal(d.fromAthPct, -50);
  assert.equal(describeAth(null, market), null);
  assert.equal(describeAth({ athPrice: 1, athAt: 5 }, { priceUsd: 0, marketCapUsd: 1 }), null);
});

test('fetchAth picks hourly for young pools, daily for old, caches, and pauses after a 429', async () => {
  const now = 1_800_000_000_000;
  const urls = [];
  const ok = async (u) => { urls.push(u); return json({ data: { attributes: { ohlcv_list: [[10, 1, 7, 1, 1, 1]] } } }); };
  const young = await fetchAth({ pairAddress: 'POOL_Y', mint: 'M', createdAt: now - 3_600_000 }, ok, now);
  assert.deepEqual(young, { athPrice: 7, athAt: 10_000 });
  assert.match(urls[0], /pools\/POOL_Y\/ohlcv\/hour\?aggregate=1&limit=1000/);
  assert.match(urls[0], /token=M$/);
  await fetchAth({ pairAddress: 'POOL_O', mint: 'M', createdAt: now - 90 * 86_400_000 }, ok, now);
  assert.match(urls[1], /ohlcv\/day/);
  await fetchAth({ pairAddress: 'POOL_Y', mint: 'M', createdAt: now - 3_600_000 }, ok, now); // cached
  assert.equal(urls.length, 2);
  assert.equal(await fetchAth({ pairAddress: 'P3', mint: 'M' }, async () => json({}, 429), now), null);
  assert.equal(await fetchAth({ pairAddress: 'P4', mint: 'M' }, ok, now + 1000), null); // paused
  assert.equal(urls.length, 2);
  assert.equal(await fetchAth({ pairAddress: null, mint: 'M' }, ok, now + 120_000), null);
});

test('parseRugCheck keeps the insider flag per holder, the creator info and the token description', () => {
  const r = parseRugCheck({
    ...report, detectedAt: '2026-10-17T10:00:00Z',
    fileMeta: { name: 'Barber Dog', symbol: 'BDOG', description: '  A dog at the barber.  ' },
  });
  assert.deepEqual(r.top.map((h) => h.insider), [true, true, false]);
  assert.deepEqual(r.meta, { name: 'Barber Dog', symbol: 'BDOG', description: 'A dog at the barber.' });
  assert.equal(r.detectedAt, Date.parse('2026-10-17T10:00:00Z'));
  const none = parseRugCheck({});
  assert.deepEqual(none.meta, { name: null, symbol: null, description: null });
  assert.equal(none.detectedAt, null);
  assert.equal(parseRugCheck({ fileMeta: { description: 42 }, detectedAt: 'nope' }).meta.description, null);
});

const A1 = 'So11111111111111111111111111111111111111112';
test('parsePumpCreated reads coins from a few shapes and drops junk', () => {
  const coins = [{ mint: A1, symbol: 'AAA', created_timestamp: 1_700_000_000_000 }, { mint: 'bad' }, null, { mint: A1, created_timestamp: 1_700_000_000 }];
  for (const body of [coins, { coins }, { data: coins }]) {
    const out = parsePumpCreated(body);
    assert.equal(out.length, 2);
    assert.deepEqual(out[0], { mint: A1, symbol: 'AAA', createdAt: 1_700_000_000_000 });
    assert.equal(out[1].createdAt, 1_700_000_000_000); // seconds are converted to ms
    assert.equal(out[1].symbol, null);
  }
  assert.equal(parsePumpCreated({ message: 'nope' }), null);
  assert.equal(parsePumpCreated(null), null);
});

test('fetchPumpCreated asks the creator endpoint and returns null when it fails', async () => {
  let url;
  const out = await fetchPumpCreated('CREATOR1', async (u) => { url = u; return json([{ mint: A1 }]); });
  assert.match(url, /^https:\/\/frontend-api-v3\.pump\.fun\/coins\/user-created-coins\/CREATOR1\?/);
  assert.equal(out.length, 1);
  assert.equal(await fetchPumpCreated('C', async () => json({}, 404)), null);
  assert.equal(await fetchPumpCreated('C', async () => { throw new Error('offline'); }), null);
});

test('fetchPumpCreated tries the next pump.fun host when one fails', async () => {
  const urls = [];
  const out = await fetchPumpCreated('CREATOR2', async (u) => { urls.push(u); return urls.length === 1 ? json({}, 404) : json([{ mint: A1 }]); });
  assert.equal(out.length, 1);
  assert.match(urls[0], /frontend-api-v3\.pump\.fun/);
  assert.match(urls[1], /frontend-api-v2\.pump\.fun/);
});

test('fetchLoreAI: no key means no call; reads the text, caches, respects the daily cap', async () => {
  const now = Date.UTC(2027, 0, 5, 12);
  assert.equal(await fetchLoreAI({ mint: 'L0' }, {}, async () => { throw new Error('must not call'); }, now), null);
  let calls = 0; let sent;
  const impl = async (u, o) => { calls += 1; sent = { u, o, body: JSON.parse(o.body) }; return json({ content: [{ type: 'server_tool_use' }, { type: 'text', text: 'A **dog** at the barber went viral.' }, { type: 'web_search_tool_result' }, { type: 'text', text: ' It spread on X.' }] }); };
  const t = await fetchLoreAI({ mint: 'L1', name: 'Barber Dog', symbol: 'BDOG', description: 'hi', xUrl: 'https://x.com/a' }, { apiKey: 'k' }, impl, now);
  assert.equal(t, 'A dog at the barber went viral. It spread on X.');
  assert.equal(sent.u, 'https://api.anthropic.com/v1/messages');
  assert.equal(sent.o.headers['x-api-key'], 'k');
  assert.equal(sent.body.tools[0].name, 'web_search');
  assert.match(sent.body.messages[0].content, /Name: Barber Dog[\s\S]*Symbol: BDOG[\s\S]*X link: https:\/\/x\.com\/a/);
  assert.match(sent.body.system, /Never give price predictions/);
  assert.equal(await fetchLoreAI({ mint: 'L1' }, { apiKey: 'k' }, impl, now + 1000), t); // cached
  assert.equal(calls, 1);
  assert.equal(await fetchLoreAI({ mint: 'L2' }, { apiKey: 'k' }, async () => json({}, 401), now), null);
  assert.equal(await fetchLoreAI({ mint: 'L3' }, { apiKey: 'k' }, async () => json({ content: [] }), now), null);
  // per person: 2 new stories a day each, cached ones are free, other people are not affected
  const d2 = now + 2 * 86_400_000;
  let u = 0;
  const cnt = async () => { u += 1; return json({ content: [{ type: 'text', text: 'ok' }] }); };
  const opt = (userId) => ({ apiKey: 'k', perUserMax: 2, userId });
  await fetchLoreAI({ mint: 'U1' }, opt(7), cnt, d2);
  await fetchLoreAI({ mint: 'U1' }, opt(7), cnt, d2); // cached: free
  await fetchLoreAI({ mint: 'U2' }, opt(7), cnt, d2);
  assert.equal(await fetchLoreAI({ mint: 'U3' }, opt(7), cnt, d2), null); // user 7 is at 2 new stories
  assert.equal(await fetchLoreAI({ mint: 'U3' }, opt(8), cnt, d2), 'ok'); // another user is fine
  assert.equal(await fetchLoreAI({ mint: 'U1' }, opt(7), cnt, d2), 'ok'); // and user 7 still sees cached ones
  assert.equal(u, 3);
  // daily cap: 2 calls allowed in a new day, third is refused without calling
  const later = now + 3 * 86_400_000;
  let n = 0;
  const counting = async () => { n += 1; return json({ content: [{ type: 'text', text: 'ok' }] }); };
  await fetchLoreAI({ mint: 'C1' }, { apiKey: 'k', dailyMax: 2 }, counting, later);
  await fetchLoreAI({ mint: 'C2' }, { apiKey: 'k', dailyMax: 2 }, counting, later);
  assert.equal(await fetchLoreAI({ mint: 'C3' }, { apiKey: 'k', dailyMax: 2 }, counting, later), null);
  assert.equal(n, 2);
});

test('parseSearch keeps Solana tokens once each, deepest pool first, and drops junk', () => {
  const A = 'So11111111111111111111111111111111111111112';
  const B = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const body = { pairs: [
    { chainId: 'solana', baseToken: { address: A, symbol: 'AAA', name: 'Aaa' }, liquidity: { usd: 100 }, marketCap: 1000 },
    { chainId: 'solana', baseToken: { address: A, symbol: 'AAA', name: 'Aaa' }, liquidity: { usd: 900 }, marketCap: 2000 },
    { chainId: 'solana', baseToken: { address: B, symbol: 'BBB' }, liquidity: { usd: 5000 } },
    { chainId: 'ethereum', baseToken: { address: '0xabc', symbol: 'ETH1' }, liquidity: { usd: 99999 } },
    { chainId: 'solana', baseToken: { address: 'short' }, liquidity: { usd: 1 } },
  ] };
  const r = parseSearch(body);
  assert.deepEqual(r.map((x) => x.symbol), ['BBB', 'AAA']);
  assert.equal(r[1].marketCapUsd, 2000);
  assert.deepEqual(parseSearch(null), []);
});

test('searchTokens calls DexScreener search and throws on HTTP errors', async () => {
  let url = '';
  await searchTokens('bar ber', async (u) => { url = u; return { ok: true, json: async () => ({ pairs: [] }) }; });
  assert.match(url, /search\?q=bar%20ber$/);
  await assert.rejects(searchTokens('x', async () => ({ ok: false, status: 500 })), /HTTP 500/);
  assert.deepEqual(await searchTokens('  ', async () => { throw new Error('no call'); }), []);
});

test('parseDexPaid finds the newest approved profile order and ignores the rest', () => {
  const r = parseDexPaid([
    { type: 'tokenProfile', status: 'processing', paymentTimestamp: 1_700_000_999_000 },
    { type: 'tokenProfile', status: 'approved', paymentTimestamp: 1_700_000_000_000 },
    { type: 'tokenAd', status: 'approved', paymentTimestamp: 1_700_000_500_000 },
    { type: 'other', status: 'approved', paymentTimestamp: 1_800_000_000_000 },
  ]);
  assert.equal(r.paidAt, 1_700_000_500_000);
  assert.equal(parseDexPaid([]), null);
  assert.equal(parseDexPaid(null), null);
});

test('fetchDexPaid returns null when the API fails', async () => {
  assert.equal(await fetchDexPaid('M', async () => ({ ok: false, status: 404 })), null);
  assert.equal((await fetchDexPaid('M', async () => ({ ok: true, json: async () => [{ type: 'tokenProfile', status: 'approved', paymentTimestamp: 1_700_000_000_000 }] }))).paidAt, 1_700_000_000_000);
});

test('fetchPriceSeries reads hourly closes oldest first; buildChartUrl makes a PNG url', async () => {
  const ok = async () => ({ ok: true, status: 200, json: async () => ({ data: { attributes: { ohlcv_list: [[200, 1, 2, 1, 1.5, 9], [100, 1, 2, 1, 1.2, 9], [300, 1, 2, 1, 0, 9]] } } }) });
  const pts = await fetchPriceSeries({ pairAddress: 'P', mint: 'M' }, ok, 1_900_000_000_000);
  assert.deepEqual(pts, [{ t: 100, c: 1.2 }, { t: 200, c: 1.5 }]);
  const url = buildChartUrl(pts, '$A');
  assert.match(url, /^https:\/\/quickchart\.io\/chart\?v=4&w=800/);
  assert.match(decodeURIComponent(url), /#22c55e/);
  assert.equal(await fetchPriceSeries({ pairAddress: null, mint: 'M' }, ok), null);
});

// ---- Lore providers ----
const gem = (text, grounded = true) => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text }] }, ...(grounded ? { groundingMetadata: { webSearchQueries: ['barber dog'] } } : {}) }] }) });
const httpErr = (status) => ({ ok: false, status, json: async () => ({}) });
const FACTS = { name: 'Barber Dog', symbol: 'BDOG', description: 'hi', xUrl: 'https://x.com/a' };

test('fetchLoreStory: no keys means no call at all', async () => {
  assert.equal(await fetchLoreStory({ mint: 'G0', ...FACTS }, {}, async () => { throw new Error('must not call'); }), null);
});

test('fetchLoreStory (Gemini): sends the key in a header, asks for Google Search, labels a searched story', async () => {
  let seen;
  const r = await fetchLoreStory({ mint: 'G1', ...FACTS }, { geminiKey: 'GK', geminiModels: ['m1'] }, async (u, o) => { seen = { u, o, body: JSON.parse(o.body) }; return gem('A **dog** at the barber went viral.'); });
  assert.deepEqual(r, { text: 'A dog at the barber went viral.', grounded: true, provider: 'gemini' });
  assert.match(seen.u, /models\/m1:generateContent$/);
  assert.equal(seen.o.headers['x-goog-api-key'], 'GK');
  assert.doesNotMatch(seen.u, /GK/); // the key never goes in the URL
  assert.deepEqual(seen.body.tools, [{ google_search: {} }]);
  assert.match(seen.body.contents[0].parts[0].text, /Barber Dog/);
});

test('fetchLoreStory (Gemini): if search is not allowed it asks again without search and says so; a model that did not search is not "grounded"', async () => {
  const calls = [];
  const impl = async (u, o) => { const b = JSON.parse(o.body); calls.push(Boolean(b.tools)); return b.tools ? httpErr(403) : gem('From the listing only.', false); };
  const r = await fetchLoreStory({ mint: 'G2', ...FACTS }, { geminiKey: 'GK', geminiModels: ['m1'] }, impl);
  assert.deepEqual(calls, [true, false]);
  assert.equal(r.grounded, false);
  assert.match(JSON.stringify(calls), /true,false/);
  // searched call that returns no grounding metadata is also not "grounded"
  const r2 = await fetchLoreStory({ mint: 'G3', ...FACTS }, { geminiKey: 'GK', geminiModels: ['m1'] }, async () => gem('No metadata.', false));
  assert.equal(r2.grounded, false);
});

test('fetchLoreStory (Gemini): 404 tries the next model, 429 gives up quietly, caching works', async () => {
  const tried = [];
  const r = await fetchLoreStory({ mint: 'G4', ...FACTS }, { geminiKey: 'GK', geminiModels: ['old', 'new'] }, async (u) => { tried.push(u.includes('/old:') ? 'old' : 'new'); return u.includes('/old:') ? httpErr(404) : gem('Story.'); });
  assert.deepEqual(tried, ['old', 'new']);
  assert.equal(r.text, 'Story.');
  assert.equal(await fetchLoreStory({ mint: 'G4', ...FACTS }, { geminiKey: 'GK' }, async () => { throw new Error('cached: must not call'); }), r);
  assert.equal(await fetchLoreStory({ mint: 'G5', ...FACTS }, { geminiKey: 'GK', geminiModels: ['m'] }, async () => httpErr(429)), null);
});

test('fetchLoreStory: Claude first, Gemini when Claude fails; per-user limit still applies', async () => {
  const order = [];
  const impl = async (u) => { order.push(u.includes('anthropic') ? 'claude' : 'gemini'); return u.includes('anthropic') ? httpErr(401) : gem('Gemini story.'); };
  const r = await fetchLoreStory({ mint: 'G6', ...FACTS }, { anthropicKey: 'AK', geminiKey: 'GK', geminiModels: ['m'] }, impl);
  assert.deepEqual(order, ['claude', 'gemini']);
  assert.equal(r.provider, 'gemini');
  const limited = { anthropicKey: 'AK', perUserMax: 1, userId: 'u-limit' };
  const ok = async () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: 'Claude story.' }] }) });
  assert.equal((await fetchLoreStory({ mint: 'G7', ...FACTS }, limited, ok)).text, 'Claude story.');
  assert.equal(await fetchLoreStory({ mint: 'G8', ...FACTS }, limited, ok), null); // second new story for the same user today
});

// ---- news headlines ----
const rss = (items) => `<?xml version="1.0"?><rss><channel>${items.map((i) => `<item><title><![CDATA[${i.t}]]></title><link>${i.l}</link><pubDate>${i.d}</pubDate><source url="https://x.com">${i.s}</source></item>`).join('')}</channel></rss>`;

test('parseNewsRss keeps only headlines that mention the token, newest first, recent only', () => {
  const now = Date.parse('2026-10-18T12:00:00Z');
  const xml = rss([
    { t: 'Barber Dog memecoin surges &amp; viral', l: 'https://n.com/1', d: 'Sat, 17 Oct 2026 10:00:00 GMT', s: 'CoinDesk' },
    { t: 'Unrelated Bitcoin news', l: 'https://n.com/2', d: 'Sat, 17 Oct 2026 11:00:00 GMT', s: 'X' },
    { t: 'Barber Dog old story', l: 'https://n.com/3', d: 'Mon, 01 Jan 2026 10:00:00 GMT', s: 'Old' },
    { t: 'Why $BDOG is trending', l: 'https://n.com/4', d: 'Sat, 17 Oct 2026 18:00:00 GMT', s: 'Decrypt' },
    { t: 'Barber Dog bad link', l: 'javascript:alert(1)', d: 'Sat, 17 Oct 2026 18:00:00 GMT', s: 'Evil' },
  ]);
  const items = parseNewsRss(xml, { name: 'Barber Dog', symbol: 'BDOG' }, now);
  assert.deepEqual(items.map((i) => i.url), ['https://n.com/4', 'https://n.com/1']);
  assert.equal(items[1].title, 'Barber Dog memecoin surges & viral');
  assert.equal(items[0].source, 'Decrypt');
  assert.deepEqual(parseNewsRss('', { name: 'Barber Dog' }, now), []);
  assert.deepEqual(parseNewsRss(xml, { name: 'ab', symbol: 'x' }, now), []); // too short to match safely
});

test('fetchNews builds a quoted search, caches, and returns [] on errors', async () => {
  const now = Date.parse('2026-10-18T12:00:00Z');
  let url; let n = 0;
  const xml = rss([{ t: 'Cat Wif Hat goes viral', l: 'https://n.com/9', d: 'Sat, 17 Oct 2026 10:00:00 GMT', s: 'S' }]);
  const impl = async (u) => { n += 1; url = u; return { ok: true, status: 200, text: async () => xml }; };
  const a = await fetchNews({ name: 'Cat Wif Hat', symbol: 'CWH' }, impl, now);
  assert.equal(a.length, 1);
  assert.match(url, /q=%22Cat%20Wif%20Hat%22%20crypto/);
  await fetchNews({ name: 'Cat Wif Hat', symbol: 'CWH' }, impl, now + 1000);
  assert.equal(n, 1);
  assert.deepEqual(await fetchNews({ name: 'Zed Zed Zed' }, async () => { throw new Error('offline'); }, now), []);
  assert.deepEqual(await fetchNews({ name: 'ab' }, impl, now), []);
});

// ---- model discovery, thinking models, error text, quota refund ----
const modelList = (...names) => ({ ok: true, status: 200, json: async () => ({ models: names.map((n) => ({ name: `models/${n}`, supportedGenerationMethods: ['generateContent'] })) }) });

test('pickGeminiModels: stable Flash first (newest version), then preview, then lite; special models skipped', () => {
  const models = [
    { name: 'models/gemini-2.5-pro', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-3-flash-preview', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-3.5-flash', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-2.5-flash-lite', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-2.5-flash-image', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-2.5-flash-preview-tts', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-live-2.5-flash', supportedGenerationMethods: ['bidiGenerateContent'] },
    { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
  ];
  assert.deepEqual(pickGeminiModels(models), ['gemini-3.5-flash', 'gemini-2.5-flash', 'gemini-3-flash-preview']);
  assert.deepEqual(pickGeminiModels(null), []);
});

test('fetchLoreStory (Gemini): with no model given it asks Google which models exist, then uses the best one', async () => {
  const urls = [];
  const impl = async (u) => { urls.push(u); return u.includes('/models?') ? modelList('gemini-9-flash', 'gemini-9-pro') : gem('Discovered story.'); };
  const r = await fetchLoreStory({ mint: 'D1', ...FACTS }, { geminiKey: 'GK' }, impl);
  assert.equal(r.text, 'Discovered story.');
  assert.match(urls[0], /\/v1beta\/models\?pageSize/);
  assert.match(urls[1], /models\/gemini-9-flash:generateContent/);
});

test('fetchLoreStory (Gemini): sends the post text and the logo, uses a big output budget, ignores "thought" parts', async () => {
  let body;
  const impl = async (u, o) => {
    body = JSON.parse(o.body);
    return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: 'secret reasoning', thought: true }, { text: 'The real story.' }] }, groundingMetadata: { webSearchQueries: ['q'] } }] }) };
  };
  const r = await fetchLoreStory({ mint: 'D2', ...FACTS, postText: 'sitting dog at the barber', imageUrl: 'https://img/x.png' }, { geminiKey: 'GK', geminiModels: ['m'] }, async (u, o) => {
    if (u === 'https://img/x.png') return { ok: true, status: 200, headers: { get: () => 'image/png' }, arrayBuffer: async () => Buffer.from('PNGDATA') };
    return impl(u, o);
  });
  assert.equal(r.text, 'The real story.');
  assert.match(body.contents[0].parts[0].text, /sitting dog at the barber/);
  assert.equal(body.contents[0].parts[1].inlineData.mimeType, 'image/png');
  assert.equal(body.contents[0].parts[1].inlineData.data, Buffer.from('PNGDATA').toString('base64'));
  assert.ok(body.generationConfig.maxOutputTokens >= 1500);
});

test('fetchLoreStory (Gemini): an empty searched answer is retried without search; errors carry Google\'s reason but never the key', async () => {
  const empty = { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [] }, finishReason: 'MAX_TOKENS' }] }) };
  const calls = [];
  const r = await fetchLoreStory({ mint: 'D3', ...FACTS }, { geminiKey: 'SECRETKEY', geminiModels: ['m'] }, async (u, o) => { const b = JSON.parse(o.body); calls.push(Boolean(b.tools)); return b.tools ? empty : gem('Second try works.', false); });
  assert.deepEqual(calls, [true, false]);
  assert.equal(r.text, 'Second try works.');
  const bad = async () => ({ ok: false, status: 403, json: async () => ({ error: { status: 'PERMISSION_DENIED', message: 'API key not valid. Please pass a valid API key.' } }) });
  assert.equal(await fetchLoreStory({ mint: 'D4', ...FACTS }, { geminiKey: 'SECRETKEY', geminiModels: ['m'] }, bad), null);
  assert.match(getLastLoreError(), /HTTP 403: PERMISSION_DENIED API key not valid/);
  assert.doesNotMatch(getLastLoreError(), /SECRETKEY/);
});

test('fetchLoreStory: failed stories do not use up the daily allowance, but the limit message is clear', async () => {
  const opts = { geminiKey: 'GK', geminiModels: ['m'], perUserMax: 2, userId: 'u-refund' };
  const fail = async () => httpErr(500);
  for (let i = 0; i < 4; i++) assert.equal(await fetchLoreStory({ mint: `F${i}`, ...FACTS }, opts, fail), null);
  assert.ok((await fetchLoreStory({ mint: 'F9', ...FACTS }, opts, async () => gem('works'))).text); // still allowed: failures were refunded
  assert.ok((await fetchLoreStory({ mint: 'F10', ...FACTS }, opts, async () => gem('works too'))).text);
  assert.equal(await fetchLoreStory({ mint: 'F11', ...FACTS }, opts, async () => gem('over the limit')), null);
  assert.match(getLastLoreError(), /already asked for 2 new stories today/);
});

// ---- linked X post and logo ----
test('parseTweetOembed and fetchTweetText read the post text from X oEmbed', async () => {
  const body = { html: '<blockquote class="twitter-tweet"><p lang="en" dir="ltr">Dog sits at the barber &amp; waits<br>so patient <a href="https://t.co/x">https://t.co/x</a> <a href="https://t.co/y">pic.twitter.com/abc</a></p>&mdash; Solsuke (@solsuke)</blockquote>' };
  assert.equal(parseTweetOembed(body), 'Dog sits at the barber & waits so patient https://t.co/x');
  assert.equal(parseTweetOembed({ html: '<div>no paragraph</div>' }), null);
  let url;
  const t = await fetchTweetText('https://x.com/solsuke/status/12345?s=20', async (u) => { url = u; return { ok: true, status: 200, json: async () => body }; });
  assert.match(t, /Dog sits at the barber/);
  assert.match(url, /oembed\?omit_script=1&url=https%3A%2F%2Ftwitter\.com%2Fsolsuke%2Fstatus%2F12345$/);
  assert.equal(await fetchTweetText('https://x.com/solsuke', async () => { throw new Error('must not call'); }), null); // a profile link has no single post
  assert.equal(await fetchTweetText('https://x.com/a/status/999', async () => ({ ok: false, status: 404, json: async () => ({}) })), null);
});

test('fetchImageInline only accepts small https images', async () => {
  const img = (type, size) => async () => ({ ok: true, status: 200, headers: { get: () => type }, arrayBuffer: async () => Buffer.alloc(size, 1) });
  assert.equal((await fetchImageInline('https://i/x.png', img('image/png', 100))).mimeType, 'image/png');
  assert.equal(await fetchImageInline('https://i/x.png', img('text/html', 100)), null);
  assert.equal(await fetchImageInline('https://i/x.png', img('image/png', 5_000_000)), null);
  assert.equal(await fetchImageInline('http://i/x.png', img('image/png', 100)), null);
  assert.equal(await fetchImageInline('https://i/x.png', async () => { throw new Error('offline'); }), null);
});

test('fetchLoreStory (Gemini): a 429 on the searched call falls back to a plain call; a 429 on a model moves to the next model', async () => {
  const calls = [];
  const impl = async (u, o) => {
    const b = JSON.parse(o.body); const model = /models\/([^:]+):/.exec(u)[1];
    calls.push(`${model}:${b.tools ? 'search' : 'plain'}`);
    if (model === 'm1') return httpErr(429);                 // m1 has no quota left at all
    return b.tools ? httpErr(429) : gem('Plain answer after search quota ran out.', false);
  };
  const r = await fetchLoreStory({ mint: 'Q1', ...FACTS }, { geminiKey: 'GK', geminiModels: ['m1', 'm2'] }, impl);
  assert.deepEqual(calls, ['m1:search', 'm1:plain', 'm2:search', 'm2:plain']);
  assert.equal(r.text, 'Plain answer after search quota ran out.');
  assert.equal(r.grounded, false);
  // every model out of quota: nothing is written and the reason is kept for LORE_DEBUG
  assert.equal(await fetchLoreStory({ mint: 'Q2', ...FACTS }, { geminiKey: 'GK', geminiModels: ['m1'] }, async () => httpErr(429)), null);
  assert.match(getLastLoreError(), /HTTP 429/);
});

test('fetchLoreStory (Gemini): a slow searched call times out and the plain call answers', async () => {
  const impl = async (u, o) => {
    const b = JSON.parse(o.body);
    if (b.tools) { const e = new Error('The operation was aborted due to timeout'); e.name = 'TimeoutError'; throw e; }
    return gem('It is a memecoin shown with a green starter pack.', false);
  };
  const r = await fetchLoreStory({ mint: 'T1', ...FACTS }, { geminiKey: 'GK', geminiModels: ['m1'] }, impl);
  assert.equal(r.text, 'It is a memecoin shown with a green starter pack.');
  assert.equal(r.grounded, false);
});

test('holder count from GeckoTerminal: parsed, cached, and a refusal gives null', async () => {
  assert.equal(parseGeckoHolders({ data: { attributes: { holders: { count: 35375 } } } }), 35375);
  assert.equal(parseGeckoHolders({ data: { attributes: {} } }), null);
  const mint = 'HoldersTestMint1111111111111111111111111111';
  const ok = async () => ({ ok: true, status: 200, json: async () => ({ data: { attributes: { holders: { count: 95 } } } }) });
  assert.equal(await fetchHolderCount(mint, ok, 9e15), 95);
  let calls = 0;
  assert.equal(await fetchHolderCount(mint, async () => { calls += 1; return ok(); }, 9e15 + 1000), 95); // cached
  assert.equal(calls, 0);
  assert.equal(await fetchHolderCount('Other1111111111111111111111111111111111111', async () => ({ ok: false, status: 404 }), 9e15), null);
});
