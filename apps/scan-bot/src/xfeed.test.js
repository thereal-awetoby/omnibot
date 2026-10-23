import test from 'node:test';
import assert from 'node:assert/strict';
import { normHandle, extractMints, pickNew, newerId, xCallerId, parseSyndication, parseRss, parseApiTweets, fetchTweets } from './xfeed.js';

const MINT = 'ARAxPf4ZEmaP95W5oJPocTinBgmYXCEAcy4ZW4iMpump';
const NOW = Date.UTC(2026, 9, 22, 10, 0, 0);

test('normHandle accepts @name, name and profile or post links', () => {
  assert.equal(normHandle('@PumpDotFun'), 'pumpdotfun');
  assert.equal(normHandle('  toby_1 '), 'toby_1');
  assert.equal(normHandle('https://x.com/Some_One/status/1234567890'), 'some_one');
  assert.equal(normHandle('https://twitter.com/abc'), 'abc');
  assert.equal(normHandle('has space'), null);
  assert.equal(normHandle('waytoolongusername123'), null);
  assert.equal(normHandle(''), null);
});

test('extractMints finds addresses in text and in links, once each, and ignores other long words', () => {
  assert.deepEqual(extractMints(`new gem ${MINT} lfg`), [MINT]);
  assert.deepEqual(extractMints('see this', [`https://pump.fun/coin/${MINT}`, `https://dexscreener.com/solana/${MINT}`]), [MINT]);
  assert.deepEqual(extractMints('supercalifragilisticexpialidocious and 0OIl'), []);
  assert.deepEqual(extractMints('nothing here $SOL'), []);
});

test('pickNew: a new chat only learns the newest id, then only newer recent posts are returned oldest first', () => {
  const t = (id, minsAgo, extra = {}) => ({ id: String(id), text: 'x', urls: [], createdAt: NOW - minsAgo * 60_000, isRetweet: false, ...extra });
  const tweets = [t(300, 1), t(200, 5), t(100, 90), t(250, 3, { isRetweet: true })];
  assert.deepEqual(pickNew(tweets, null, { now: NOW }), { fresh: [], cursor: '300' });
  const r = pickNew(tweets, '150', { now: NOW });
  assert.deepEqual(r.fresh.map((x) => x.id), ['200', '300']); // 250 is a retweet, 100 is older than the cursor
  assert.equal(r.cursor, '300');
  assert.deepEqual(pickNew(tweets, '300', { now: NOW }).fresh, []);
  // an old post (restart after a long stop) is skipped but the cursor still moves forward
  const old = pickNew([t(400, 120)], '300', { now: NOW });
  assert.deepEqual(old.fresh, []); assert.equal(old.cursor, '400');
  // big 64-bit ids compare correctly
  assert.ok(newerId('1848000000000000002', '1848000000000000001'));
});

test('xCallerId is stable, negative and different per account', () => {
  assert.equal(xCallerId('abc'), xCallerId('abc'));
  assert.ok(xCallerId('abc') < 0 && xCallerId('abd') < 0);
  assert.notEqual(xCallerId('abc'), xCallerId('abd'));
});

const synd = (tweets) => `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { timeline: { entries: tweets.map((t) => ({ type: 'tweet', content: { tweet: t } })) } } } })}</script></html>`;
test('parseSyndication reads posts, links and retweets', () => {
  const html = synd([
    { id_str: '2', full_text: `ca: ${MINT} &amp; more`, created_at: 'Thu Oct 22 09:58:00 +0000 2026', entities: { urls: [{ expanded_url: 'https://dexscreener.com/solana/x' }] } },
    { id_str: '1', full_text: 'RT @someone: hi', created_at: 'Thu Oct 22 09:00:00 +0000 2026', retweeted_status: {} },
  ]);
  const t = parseSyndication(html);
  assert.equal(t.length, 2);
  assert.equal(t[0].id, '2'); assert.equal(t[0].text, `ca: ${MINT} & more`); assert.equal(t[0].urls[0], 'https://dexscreener.com/solana/x');
  assert.equal(t[0].createdAt, Date.UTC(2026, 9, 22, 9, 58, 0));
  assert.equal(t[1].isRetweet, true);
  assert.equal(parseSyndication('<html>nope</html>'), null);
  assert.equal(parseSyndication('<script id="__NEXT_DATA__">{bad</script>'), null);
});

test('parseRss reads a Nitter-style feed', () => {
  const xml = `<rss><channel><item><title>buy ${MINT}</title><description><![CDATA[<p>buy ${MINT} <a href="https://pump.fun/coin/${MINT}">link</a></p>]]></description><pubDate>Thu, 22 Oct 2026 09:59:00 GMT</pubDate><link>https://nitter.example/user/status/1850000000000000001#m</link></item><item><title>RT by @user: hi</title><description>hi</description><link>https://nitter.example/user/status/1850000000000000000#m</link></item></channel></rss>`;
  const t = parseRss(xml);
  assert.equal(t.length, 2);
  assert.equal(t[0].id, '1850000000000000001');
  assert.deepEqual(extractMints(t[0].text, t[0].urls), [MINT]);
  assert.equal(t[1].isRetweet, true);
  assert.equal(parseRss('not xml'), null);
});

test('parseApiTweets reads the official API answer', () => {
  const t = parseApiTweets({ data: [{ id: '5', text: `x ${MINT}`, created_at: '2026-10-22T09:59:00.000Z', entities: { urls: [{ expanded_url: 'https://a.b' }] } }, { id: '4', text: 'RT', referenced_tweets: [{ type: 'retweeted' }] }] });
  assert.equal(t[0].id, '5'); assert.equal(t[1].isRetweet, true);
  assert.equal(parseApiTweets({}), null);
});

test('fetchTweets falls through the sources and reports the errors when all fail', async () => {
  const html = synd([{ id_str: '9', full_text: 'hi' }]);
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(url);
    if (url.includes('nitter.bad')) return { ok: false, status: 503, text: async () => '' };
    return { ok: true, status: 200, text: async () => html };
  };
  const r = await fetchTweets('abc', { env: { NITTER_URLS: 'https://nitter.bad' }, fetchFn });
  assert.equal(r.via, 'x-embed'); assert.equal(r.tweets[0].id, '9');
  assert.ok(calls[0].includes('nitter.bad/abc/rss'));
  const none = await fetchTweets('abc', { env: {}, fetchFn: async () => ({ ok: false, status: 429, text: async () => '' }) });
  assert.match(none.error, /x-embed: X embed HTTP 429/);
});

import { rowsToTweets, loadXFeed } from './xfeed.js';
test('worker rows become posts; the worker is the only source unless X_FALLBACKS=1', async () => {
  const rows = [{ tweet_id: '20', text: 'ca 9Yub94kkNZF8ZQ2KMM9rQ4Pump1111111111111111pump', urls: ['https://x.com/a'], created_at: new Date('2026-10-23T08:00:00Z'), is_retweet: false }];
  assert.deepEqual(rowsToTweets(rows)[0], { id: '20', text: rows[0].text, urls: ['https://x.com/a'], createdAt: Date.parse('2026-10-23T08:00:00Z'), isRetweet: false });
  const never = async () => { throw new Error('must not be called'); };
  const ok = await fetchTweets('abc', { env: {}, fetchFn: never, workerFn: async () => rows });
  assert.equal(ok.via, 'x-worker'); assert.equal(ok.tweets.length, 1);
  const bad = await fetchTweets('abc', { env: {}, fetchFn: never, workerFn: async () => { throw new Error('worker is not running'); } });
  assert.equal(bad.error, 'x-worker: worker is not running');
  let calls = 0;
  const wide = await fetchTweets('abc', { env: { X_FALLBACKS: '1' }, fetchFn: async () => { calls++; return { ok: false, status: 429, text: async () => '' }; }, workerFn: async () => { throw new Error('off'); } });
  assert.ok(calls > 0 && /x-embed/.test(wide.error));
});
test('loadXFeed trusts only a fresh, successful worker check', async () => {
  const mk = (status, rows = []) => async (sql) => (/FROM x_feed_status/.test(sql) ? { rows: status ? [status] : [] } : /FROM x_feed /.test(sql) ? { rows } : { rows: [], rowCount: 0 });
  const now = new Date();
  await assert.rejects(loadXFeed('a', { q: mk(null) }), /not read this account yet/);
  await assert.rejects(loadXFeed('a', { q: mk({ ok: true, checked_at: new Date(Date.now() - 3_600_000) }) }), /not running/);
  await assert.rejects(loadXFeed('a', { q: mk({ ok: false, error: 'rate limited', checked_at: now }) }), /worker: rate limited/);
  assert.deepEqual(await loadXFeed('a', { q: mk({ ok: true, checked_at: now }, [{ tweet_id: '1' }]) }), [{ tweet_id: '1' }]);
});
