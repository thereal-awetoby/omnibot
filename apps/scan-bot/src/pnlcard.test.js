import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newMilestone, buildPnlSvg, buildPnlCaption, fmtMult } from './pnlcard.js';

test('newMilestone announces each multiple once', () => {
  assert.equal(newMilestone(1, 1.9), null);
  assert.equal(newMilestone(1, 2.1), 2);
  assert.equal(newMilestone(2, 2.9), null);
  assert.equal(newMilestone(2, 3.2), 3);
  assert.equal(newMilestone(1, 12), 10); // jumps straight to the biggest one reached
  assert.equal(newMilestone(10, 12), null);
  assert.equal(newMilestone(1, null), null);
});

test('PnL card shows the multiple, names and market caps', () => {
  const svg = buildPnlSvg({ symbol: 'ABC', callerName: '@toby', entryMcap: 10000, nowMcap: 45000, x: 4.5, ageText: '3h', groupName: 'Alpha <Chat>' });
  assert.match(svg, /\$ABC/);
  assert.match(svg, /4\.50x/);
  assert.match(svg, /\+350%/);
  assert.match(svg, /@toby/);
  assert.match(svg, /Alpha &lt;Chat&gt;/);
  assert.match(svg, /#22c55e/);
  assert.doesNotMatch(svg, /undefined|NaN/);
});

test('PnL card turns red below 1x', () => {
  const svg = buildPnlSvg({ symbol: 'ABC', callerName: 'x', entryMcap: 10000, nowMcap: 4000, x: 0.4 });
  assert.match(svg, /0\.40x/);
  assert.match(svg, /-60\.0%/);
  assert.match(svg, /#ef4444/);
});

test('PnL card can use a picture as the background', () => {
  const art = { mime: 'image/jpeg', buf: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]) };
  const svg = buildPnlSvg({ symbol: 'ABC', callerName: 'x', entryMcap: 1000, nowMcap: 3000, x: 3, art });
  assert.match(svg, /<image [^>]*data:image\/jpeg;base64,/);
  assert.match(svg, /preserveAspectRatio="xMidYMid slice"/);
  assert.match(svg, /height="563"/);
  assert.doesNotMatch(svg, /undefined|NaN/);
});

test('PnL card has square corners and a Solana mark', () => {
  const svg = buildPnlSvg({ symbol: 'ABC', callerName: 'x', entryMcap: 1000, nowMcap: 3000, x: 3 });
  assert.doesNotMatch(svg, /rx=/);
  assert.doesNotMatch(svg, /clipPath/);
  assert.match(svg, />Solana</);
  assert.match(svg, /#9945FF/);
});

test('emoji in the group name and caller name are dropped from the card', () => {
  const svg = buildPnlSvg({ symbol: 'ABC', callerName: 'Winter Arc 🪖', entryMcap: 1000, nowMcap: 3000, x: 3, groupName: "I'm tired of losing 🙏" });
  assert.match(svg, /I'm tired of losing</);
  assert.match(svg, /called by Winter Arc</);
  assert.doesNotMatch(svg, /🙏|🪖/u);
});

test('captions', () => {
  assert.equal(fmtMult(25), '25x');
  assert.match(buildPnlCaption({ symbol: 'ABC', callerName: '@t', x: 3, milestone: true }), /🚀.*3\.00x/);
  assert.match(buildPnlCaption({ symbol: 'ABC', callerName: '@t', x: 1.5 }), /📊/);
});
