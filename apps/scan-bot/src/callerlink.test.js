import test from 'node:test';
import assert from 'node:assert/strict';
import { callerHtml, isXCaller } from './callerlink.js';
import { buildCallLine } from './scan.js';
import { buildPnlCaption } from './pnlcard.js';

test('X callers link to their X profile, Telegram callers stay plain text', () => {
  assert.equal(isXCaller(-123), true); assert.equal(isXCaller('-9'), true); assert.equal(isXCaller(6167112568), false); assert.equal(isXCaller(null), false);
  assert.equal(callerHtml('@therea_toby', -5), '<a href="https://x.com/therea_toby">@therea_toby</a>');
  assert.equal(callerHtml('therea_toby', -5, { at: false }), '<a href="https://x.com/therea_toby">therea_toby</a>');
  assert.equal(callerHtml('@Davidtobyawe', 6167112568), '@Davidtobyawe');
  assert.equal(callerHtml('<b>x</b>', -5), '@&lt;b&gt;x&lt;/b&gt;'); // never trust a name as markup
  assert.equal(callerHtml('', -5), '');
  assert.match(buildCallLine({ caller_name: '@therea_toby', caller_id: -7, mcap_usd: 1000, price_usd: 1 }, 2), /First call: <b><a href="https:\/\/x\.com\/therea_toby">@therea_toby<\/a><\/b>/);
  assert.match(buildPnlCaption({ symbol: 'A', callerName: '@therea_toby', callerId: -7, x: 3 }), /since <a href="https:\/\/x\.com\/therea_toby">@therea_toby<\/a> called it/);
  assert.match(buildPnlCaption({ symbol: 'A', callerName: '@Tg', callerId: 5, x: 3 }), /since @Tg called it/);
});
