import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callMapRows, callColor, buildCallMapSvg, buildCallMapCaption } from './callmap.js';
import { buildFcText, buildMyCallsText, callMsgLink } from './ux.js';

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
