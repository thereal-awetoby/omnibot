import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newMilestone, buildPnlSvg, buildPnlCaption, fmtMult, peakMultiple } from './pnlcard.js';

test('newMilestone announces each multiple once', () => {
  assert.equal(newMilestone(1, 1.9), null);
  assert.equal(newMilestone(1, 2.1), 2);
  assert.equal(newMilestone(2, 2.9), null);
  assert.equal(newMilestone(2, 3.2), 3);
  assert.equal(newMilestone(1, 12), 10); // jumps straight to the biggest one reached
  assert.equal(newMilestone(10, 12), null);
  assert.equal(newMilestone(1, null), null);
});

test('peakMultiple is the best the token reached after the call, never below 1x', () => {
  assert.equal(peakMultiple(1, 0.4, 3.3, 2), 3.3);
  assert.equal(peakMultiple(1, 0.4), 1);          // only ever lower: shows 1.00x, never the drop
  assert.equal(peakMultiple(2, null, undefined, 5), 2.5);
  assert.equal(peakMultiple(0, 5), null);
});

test('PnL card shows the peak multiple, names and market caps (no "now" and no loss)', () => {
  const svg = buildPnlSvg({ symbol: 'ABC', callerName: '@toby', entryMcap: 10000, peakMcap: 45000, x: 4.5, ageText: '3h', groupName: 'Alpha <Chat>' });
  assert.match(svg, /\$ABC/);
  assert.match(svg, /4\.50x/);
  assert.match(svg, /\+350%/);
  assert.match(svg, /@toby/);
  assert.match(svg, /Alpha &lt;Chat&gt;/);
  assert.match(svg, />Peak/);
  assert.doesNotMatch(svg, />Now/);
  assert.doesNotMatch(svg, /#ef4444|-\d+\.\d%/);
  assert.doesNotMatch(svg, /undefined|NaN/);
});

test('PnL card has square corners and a Solana mark, with or without a picture', () => {
  const plainSvg = buildPnlSvg({ symbol: 'ABC', callerName: 'x', entryMcap: 1000, peakMcap: 3000, x: 3 });
  assert.doesNotMatch(plainSvg, /rx=/);
  assert.match(plainSvg, />Solana</);
  assert.match(plainSvg, /#9945FF/);
  const art = { mime: 'image/jpeg', buf: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]) };
  const withArt = buildPnlSvg({ symbol: 'ABC', callerName: 'x', entryMcap: 1000, peakMcap: 3000, x: 3, art });
  assert.match(withArt, /data:image\/jpeg;base64,/);
  assert.match(withArt, /preserveAspectRatio="xMidYMid slice"/); // the picture fills the whole card
  assert.doesNotMatch(withArt, /rx=/);
  assert.match(withArt, />Solana</);
});

test('emoji in the group name and caller name are dropped from the card', () => {
  const svg = buildPnlSvg({ symbol: 'ABC', callerName: 'Winter Arc 🪖', entryMcap: 1000, peakMcap: 3000, x: 3, groupName: "I'm tired of losing 🙏" });
  assert.match(svg, /I'm tired of losing</);
  assert.match(svg, /called by Winter Arc</);
  assert.doesNotMatch(svg, /🙏|🪖/u);
});

test('captions', () => {
  assert.equal(fmtMult(25), '25x');
  assert.match(buildPnlCaption({ symbol: 'ABC', callerName: '@t', x: 3, milestone: true }), /🚀.*3\.00x/);
  assert.match(buildPnlCaption({ symbol: 'ABC', callerName: '@t', x: 1.5 }), /📊.*peaked/);
});
