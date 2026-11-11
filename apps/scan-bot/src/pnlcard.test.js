import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newMilestone, buildPnlSvg, buildPnlCaption, fmtMult, peakMultiple, buildPaperPnlSvg, buildPaperPnlCaption } from './pnlcard.js';

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
  assert.doesNotMatch(plainSvg, />Solana</); // the mark alone, in the bottom right corner
  assert.match(plainSvg, /translate\(892 469\)/);
  assert.match(plainSvg, /#9945FF/);
  const art = { mime: 'image/jpeg', buf: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]) };
  const withArt = buildPnlSvg({ symbol: 'ABC', callerName: 'x', entryMcap: 1000, peakMcap: 3000, x: 3, art });
  assert.match(withArt, /data:image\/jpeg;base64,/);
  assert.match(withArt, /preserveAspectRatio="xMidYMid slice"/); // the picture fills the whole card
  assert.doesNotMatch(withArt, /rx=/);
  assert.doesNotMatch(withArt, />Solana</);
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

test('paper PnL card: a win is green, shows entry/exit market cap, size, and a paper-trading disclaimer', () => {
  const svg = buildPaperPnlSvg({ symbol: 'DOG', entryMcap: 10_000, nowMcap: 25_000, pct: 150, status: 'tp', ageText: 'closed 2h ago', sizeUsd: 50 });
  assert.match(svg, /\$DOG/);
  assert.match(svg, /\+150%/);
  assert.match(svg, /#22c55e/);
  assert.doesNotMatch(svg, /#ef4444/);
  assert.match(svg, />Take-profit hit · closed 2h ago</);
  assert.match(svg, />Entry</);
  assert.match(svg, />Exit</);
  assert.match(svg, />\$10\.00K</);
  assert.match(svg, />\$25\.00K</);
  assert.match(svg, />\$50\.00</);
  assert.match(svg, /PAPER TRADE/);
  assert.match(svg, /no real SOL moved/);
  assert.doesNotMatch(svg, /undefined|NaN/);
});

test('paper PnL card: a loss is red, an open position says Now and has no size in the row if omitted', () => {
  const svg = buildPaperPnlSvg({ symbol: 'CAT', entryMcap: 50_000, nowMcap: 30_000, pct: -40, status: 'sl' });
  assert.match(svg, /-40\.0%/);
  assert.match(svg, /#ef4444/);
  assert.doesNotMatch(svg, /#22c55e/);
  assert.match(svg, />Stop-loss hit</);
  const open = buildPaperPnlSvg({ symbol: 'FOX', entryMcap: 1000, nowMcap: 1200, pct: 20, status: 'open' });
  assert.match(open, />Open position</);
  assert.match(open, />Now</);
  assert.doesNotMatch(open, />Size</);
});

test('paper PnL card: no current price available shows n/a, never crashes', () => {
  const svg = buildPaperPnlSvg({ symbol: null, entryMcap: 1000, nowMcap: null, pct: 0, status: 'open' });
  assert.match(svg, />n\/a</);
  assert.match(svg, />Token</);
  assert.doesNotMatch(svg, /undefined|NaN/);
});

test('buildPaperPnlCaption', () => {
  assert.match(buildPaperPnlCaption({ symbol: 'DOG', status: 'tp', pct: 150 }), /\$DOG.*Take-profit hit.*\+150\.0%/s);
  assert.match(buildPaperPnlCaption({ symbol: null, status: 'open', pct: -5 }), /this token.*Open position.*-5\.0%/s);
});

// Phase 5: the card and caption also show the multiplier and the signal's source (plan section 4).
test('paper PnL card and caption show the multiplier and the source when given', () => {
  const svg = buildPaperPnlSvg({ symbol: 'DOG', entryMcap: 10_000, nowMcap: 25_000, pct: 150, status: 'tp', source: 'group call' });
  assert.match(svg, /2\.50x/);
  assert.match(svg, /group call/);
  const caption = buildPaperPnlCaption({ symbol: 'DOG', status: 'tp', pct: 150, source: 'X follow' });
  assert.match(caption, /via X follow/);
});

// Random stored background (backgrounds/mine) on the paper card, when the caller supplies one.
test('paper PnL card draws a supplied background picture full-bleed, plain gradient without one', () => {
  const art = { buf: Buffer.from('fakejpeg'), mime: 'image/jpeg' };
  const withArt = buildPaperPnlSvg({ symbol: 'DOG', entryMcap: 10_000, nowMcap: 25_000, pct: 150, status: 'tp', art });
  assert.match(withArt, /<image xlink:href="data:image\/jpeg;base64,ZmFrZWpwZWc="/);
  assert.match(withArt, /fill="url\(#shade\)"/);
  const plain = buildPaperPnlSvg({ symbol: 'DOG', entryMcap: 10_000, nowMcap: 25_000, pct: 150, status: 'tp' });
  assert.doesNotMatch(plain, /<image/);
});
