import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callMapRows, callColor, buildCallMapSvg, buildCallMapCaption } from './callmap.js';
import { buildFcText, buildMyCallsText, callMsgLink, buildFollowingText, explainXError } from './ux.js';

const now = Date.UTC(2026, 10, 7, 15, 0);
const mk = (symbol, entry, peak, nowP, mcap = 10_000, caller = '@trader') => ({ symbol, mint: symbol.padEnd(32, 'A'), price_usd: entry, peak_price_usd: peak, mcap_usd: mcap, caller_name: caller, created_at: new Date(now - 3_600_000), _now: nowP });
const priceMap = (calls) => new Map(calls.filter((c) => c._now != null).map((c) => [c.mint, { priceUsd: c._now }]));

test('callMapRows: now and ATH multiples, ATH never below 1, no price = null now', () => {
  const calls = [mk('UP', 1, 5, 3), mk('DOWN', 1, 1.2, 0.4), mk('NOPRICE', 1, null, null), mk('BAD', 0, 1, 1)];
  const rows = callMapRows(calls, priceMap(calls));
  assert.equal(rows.length, 3); // a call with no entry price is left out
  const by = Object.fromEntries(rows.map((r) => [r.symbol, r]));
  assert.equal(by.UP.nowX, 3); assert.equal(by.UP.athX, 5); assert.equal(by.UP.peakMcap, 50_000);
  assert.equal(by.DOWN.nowX, 0.4); assert.equal(by.DOWN.athX, 1.2);
  assert.equal(by.NOPRICE.nowX, null); assert.equal(by.NOPRICE.athX, 1);
});

test('callColor: green up, red down, grey without a price', () => {
  const rgb = (s) => s.match(/\d+/g).map(Number);
  const [r1, g1] = rgb(callColor(4, 'now'));
  assert.ok(g1 > r1);
  const [r2, g2] = rgb(callColor(0.3, 'now'));
  assert.ok(r2 > g2);
  assert.equal(callColor(null), '#3a3f4b');
  assert.equal(callColor(1, 'ath'), 'rgb(58,63,75)'); // ATH mode: 1x = no colour
});

test('call map svg: one tile per call, labels escaped, emoji dropped', () => {
  const calls = [mk('A<B', 1, 3, 2), mk('WIF🔥', 1, 1, 0.5, 2_000_000), mk('C', 1, 9, 9, 50_000)];
  const svg = buildCallMapSvg(callMapRows(calls, priceMap(calls)), { mode: 'now', periodLabel: '7D', groupName: 'Degen 🐸 Club' });
  assert.equal((svg.match(/<rect /g) || []).length, 1 + 3);
  assert.match(svg, /\$A&lt;B/);
  assert.match(svg, /\$WIF</);
  assert.match(svg, /Call map · Degen Club/);
  assert.match(svg, /7D · now vs call/);
  assert.doesNotMatch(svg, /NaN|undefined/);
  assert.match(buildCallMapSvg(callMapRows(calls, priceMap(calls)), { mode: 'ath' }), /best since call/);
});

test('call map: keeps the biggest tiles when there are too many calls', () => {
  const calls = Array.from({ length: 80 }, (_, i) => mk(`T${i}`, 1, 1 + i, 1, 10_000));
  const svg = buildCallMapSvg(callMapRows(calls, priceMap(calls)), { max: 60 });
  assert.equal((svg.match(/<rect /g) || []).length, 61);
  assert.match(buildCallMapCaption(callMapRows(calls, priceMap(calls)), { max: 60 }), /80 calls \(biggest 60 shown\)/);
});

test('call map caption', () => {
  const calls = [mk('UP', 1, 5, 3, 40_000, '@alpha'), mk('DOWN', 1, 1.2, 0.4)];
  const c = buildCallMapCaption(callMapRows(calls, priceMap(calls)), { periodLabel: '24H' });
  assert.match(c, /24H · 2 calls/);
  assert.match(c, /Avg ATH <b>3\.10x<\/b> · 50% hit 2x · 1\/2 green now/);
  assert.match(c, /Best: <b>\$UP<\/b> 5\.00x \(\$200(\.00)?K\) by alpha/);
  assert.match(buildCallMapCaption([]), /No calls/);
});

test('first call card: PnL now, ATH market cap, time, record and link', () => {
  const call = { ...mk('DITTO', 1, 3, 2, 10_000, '@dave'), created_at: new Date(now - 2 * 3_600_000) };
  const t = buildFcText({ call, nowMcap: 20_000, roi: 2, athX: 3, now, record: { calls: 12, avgX: 2.4, hit2: 0.5, bestX: 9 }, link: 'https://t.me/c/123/45' });
  assert.match(t, /Now {1,}\$20(\.00)?K {2}🟢 \+100%/);
  assert.match(t, /ATH {1,}3\.00x {2}\(\$30(\.00)?K\)/);
  assert.match(t, /At {1,}Nov 7, 13:00 UTC/);
  assert.match(t, /Record {1,}12 calls · avg 2\.40x · 50% ≥2x/);
  assert.match(t, /<a href="https:\/\/t\.me\/c\/123\/45">↪ Original call<\/a>/);
  assert.match(buildFcText({ call, nowMcap: 5000, roi: 0.5, athX: 3, now }), /🔴 -50\.0%/);
});

test('callMsgLink', () => {
  assert.equal(callMsgLink(-1001234567890, 42), 'https://t.me/c/1234567890/42');
  assert.equal(callMsgLink(-1001234567890, 42, 'degens'), 'https://t.me/degens/42');
  assert.equal(callMsgLink(-123456, 42), null); // basic groups have no message links
  assert.equal(callMsgLink(-1001234567890, null), null);
});

test('calls of another member: their name when empty', () => {
  assert.equal(buildMyCallsText([], new Map(), '@alpha', now, { mine: false }), 'alpha has no calls in this group yet.');
});

// ---- /following status tests ----
test('explainXError: short messages for each class', () => {
  assert.equal(explainXError('worker is not running'), 'the X reader is switched off');
  assert.equal(explainXError('rate limited'), 'X is rate-limiting, retrying');
  assert.equal(explainXError('timed out (X slow or limiting)'), 'X is rate-limiting, retrying');
  assert.equal(explainXError('account locked - need new cookies'), 'needs fresh cookies');
  assert.equal(explainXError('no usable X account - need new cookies'), 'needs fresh cookies');
  assert.equal(explainXError('no such X account'), 'account does not exist');
  assert.equal(explainXError('something weird'), 'cannot read right now');
});

test('buildFollowingText: empty list', () => {
  assert.match(buildFollowingText([]), /None yet/);
});

test('buildFollowingText: healthy handle with worker columns', () => {
  const rows = [{
    handle: 'trader', added_by_name: 'bob', created_at: new Date(now - 86_400_000),
    polled_at: new Date(now - 30_000), ok_at: new Date(now - 30_000), last_error: null,
    via: 'x-worker', newest_tweet_at: new Date(now - 600_000),
    fail_count: 0, worker_last_ok_at: new Date(now - 25_000), worker_checked_at: new Date(now - 25_000),
    worker_ok: true, worker_error: null,
  }];
  const t = buildFollowingText(rows, now);
  assert.match(t, /@trader/);
  assert.match(t, /healthy/);
  assert.doesNotMatch(t, /fails/);
});

test('buildFollowingText: failing handle shows fail count', () => {
  const rows = [{
    handle: 'broken', added_by_name: 'bob', created_at: new Date(now - 86_400_000),
    polled_at: new Date(now - 30_000), ok_at: null, last_error: null,
    via: null, newest_tweet_at: null,
    fail_count: 5, worker_last_ok_at: new Date(now - 3_600_000), worker_checked_at: new Date(now - 30_000),
    worker_ok: false, worker_error: 'rate limited',
  }];
  const t = buildFollowingText(rows, now);
  assert.match(t, /@broken/);
  assert.match(t, /rate-limiting/);
  assert.match(t, /5 fails/);
  assert.match(t, /last OK/);
});

test('buildFollowingText: heartbeat footer', () => {
  const rows = [{
    handle: 'alpha', added_by_name: null, created_at: new Date(now - 86_400_000),
    polled_at: new Date(now - 60_000), ok_at: new Date(now - 60_000), last_error: null,
    via: 'x-worker', newest_tweet_at: new Date(now - 600_000),
    fail_count: 0, worker_last_ok_at: new Date(now - 55_000), worker_checked_at: new Date(now - 55_000),
    worker_ok: true, worker_error: null,
  }];
  const hb = { last_round_at: new Date(now - 45_000), accounts_total: 3, accounts_active: 2, handles_checked: 5, round_ms: 12000 };
  const t = buildFollowingText(rows, now, hb);
  assert.match(t, /X reader: .+ online/);
  assert.match(t, /2\/3 accounts active/);
});

test('buildFollowingText: worker offline in heartbeat', () => {
  const rows = [{
    handle: 'alpha', added_by_name: null, created_at: new Date(now - 86_400_000),
    polled_at: new Date(now - 60_000), ok_at: new Date(now - 60_000), last_error: null,
    via: 'x-worker', newest_tweet_at: null,
    fail_count: 0, worker_last_ok_at: null, worker_checked_at: null,
    worker_ok: null, worker_error: null,
  }];
  const hb = { last_round_at: new Date(now - 20 * 60_000), accounts_total: 1, accounts_active: 0, handles_checked: 0, round_ms: 0 };
  const t = buildFollowingText(rows, now, hb);
  assert.match(t, /offline/);
  assert.match(t, /0\/1 accounts active/);
});
