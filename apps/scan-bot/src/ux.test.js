import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tree, buildFcText, buildLastText, buildTargetSetText, buildTargetsText, buildReminderSetText, buildRemindersText, buildReminderFiredText, buildConvertText, buildEpochText, buildIdText, buildHelpText } from './ux.js';

const now = Date.now();
const call = { symbol: 'DITTO', mint: 'A'.repeat(32), caller_name: '@Davidtobyawe', mcap_usd: 3100, created_at: new Date(now - 3 * 3_600_000) };

test('tree draws aligned rows', () => {
  assert.equal(tree([['A', 1], ['Long', 2]]), '├ A     1\n└ Long  2');
});

test('first call card', () => {
  const t = buildFcText({ call, nowMcap: 3100, roi: 1, athX: 1.2, now });
  assert.match(t, /First Call<\/b> · \$DITTO/);
  assert.match(t, /<pre>├ Caller/);
  assert.match(t, /Davidtobyawe  \(3h/);
  assert.match(t, /ATH {1,}1\.20x/);
  assert.doesNotMatch(buildFcText({ call: { ...call, symbol: null }, now }), /undefined|NaN/);
});

test('last calls card', () => {
  const rows = [{ ...call, x: 1.2 }, { ...call, symbol: 'SPCX', mint: 'B'.repeat(32), x: 3.3 }];
  const t = buildLastText(rows, now);
  assert.match(t, /Last 2 calls/);
  assert.match(t, /Best {1,}\$SPCX 3\.30x/);
  assert.match(t, /Hit 2x {1,}50%/);
  assert.match(t, /<blockquote>1\./);
  assert.match(buildLastText([]), /No calls/);
});

test('alert and reminder cards never break the HTML', () => {
  const set = buildTargetSetText({ symbol: '$X<y>', nowLabel: '$3.1K', targets: [{ label: '2x', value: '$6.2K' }], inGroup: true, botUser: 'OmniScanmc_bot' });
  assert.match(set, /Alerts set/);
  assert.match(set, /\$X&lt;y&gt;/);
  assert.match(set, /press Start/);
  assert.doesNotMatch(buildTargetsText([]), /<address>/); // a raw <address> broke Telegram before
  assert.match(buildTargetsText([{ symbol: '$X', from: '$1', targets: [{ label: '3x', value: '$3' }] }]), /<b>\$X<\/b>/);
  assert.match(buildReminderSetText({ id: 4, delay: '1m', at: 'now', body: 'a < b', here: false }), /a &lt; b/);
  assert.match(buildRemindersText([{ id: 4, fire_at: new Date(), body: 'x' }], () => 'when'), /4 · when/);
  assert.match(buildReminderFiredText({ body: 'hi', who: 'ann', group: true }), /#REMINDER[\s\S]*by ann/);
});

test('convert, epoch and id cards', () => {
  assert.match(buildConvertText({ label: '1M $BONK', value: '$30', price: '$0.00003', mcap: '$2B' }), /Value {1,}\$30/);
  assert.match(buildConvertText({ label: '2% $X', value: '$1', tokens: '20M', price: '$1', mcap: '$1' }), /Tokens/);
  assert.match(buildEpochText(new Date(1_700_000_000_000), now), /2023-11-14 22:13:20/);
  assert.match(buildIdText('Your ID', 123), /<pre>└ ID {1,}123<\/pre>/);
});

test('help lists every section and every html tag is closed', () => {
  const h = buildHelpText();
  for (const w of ['Token data', 'Markets', 'Group', 'Alerts', 'AI tools', '/target', '/remindme', '/hm', '/fc']) assert.match(h, new RegExp(w));
  assert.equal((h.match(/<blockquote>/g) ?? []).length, (h.match(/<\/blockquote>/g) ?? []).length);
  assert.ok(h.length < 4000);
});

import { buildMyCallsText } from './ux.js';
test('calls: summary block, then every call in a collapsible quote', () => {
  const mk = (symbol, entry, mcap, peak, hoursAgo) => ({ symbol, mint: symbol.padEnd(32, 'A'), price_usd: entry, mcap_usd: mcap, peak_price_usd: peak, created_at: new Date(now - hoursAgo * 3_600_000) });
  const calls = [mk('DREAM', 1, 3220, 1.1, 4), mk('SPCX', 1, 15530, 3.3, 41), mk('DITTO', 1, 3100, 1, 9)];
  const prices = new Map([[calls[0].mint, { priceUsd: 0.93 }], [calls[1].mint, { priceUsd: 0.32 }], [calls[2].mint, { priceUsd: 1 }]]);
  const t = buildMyCallsText(calls, prices, '@Davidtobyawe', now);
  assert.match(t, /Last 3 Calls/);
  assert.match(t, /PNL\s+-\d+% \(0 🟢 \/ 2 🔴\)/);
  assert.match(t, /Best\s+\$SPCX 3\.30x/);
  assert.match(t, /Hit\s+33% ≥2x/);
  assert.match(t, /<blockquote expandable>[\s\S]*<b>\$DREAM<\/b> @ \$3\.22K[\s\S]*Now 🔴 <b>-7%<\/b> \| ATH <b>1\.10x<\/b>/);
  assert.equal(buildMyCallsText([], new Map(), 'x'), 'You have no calls in this group yet. Post a token address that nobody has called.');
});
