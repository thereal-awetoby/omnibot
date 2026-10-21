import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normPeriod, parseCoins, heatColor, buildHeatmapSvg, buildMoversText, parsePolymarket, buildPolymarketText, parseAmount, parseEpoch, csvCell, parseTargets, targetLabel, targetHit, parseDelay, analyzeCloses, rsi, ema, buildTaText, isPublicUrl, stripHtml, parseTranslate } from './extras.js';

const coins = parseCoins(Array.from({ length: 12 }, (_, i) => ({ id: `c${i}`, symbol: `s${i}`, name: 'n', current_price: 1 + i, market_cap: 1e9 / (i + 1), price_change_percentage_24h_in_currency: i - 5, price_change_percentage_7d_in_currency: null })));

test('periods and amounts are understood', () => {
  assert.equal(normPeriod('1w'), '7d');
  assert.equal(normPeriod('zzz'), '24h');
  assert.deepEqual(parseAmount('1.5m'), { kind: 'amount', n: 1.5e6 });
  assert.deepEqual(parseAmount('2%'), { kind: 'percent', n: 2 });
  assert.equal(parseAmount('0'), null);
  assert.equal(parseAmount('abc'), null);
  assert.equal(parseEpoch('1700000000').toISOString(), '2023-11-14T22:13:20.000Z');
  assert.equal(parseEpoch('x'), null);
  assert.equal(csvCell('a,"b"'), '"a,""b"""');
});

test('heatmap draws every coin and never prints NaN', () => {
  const svg = buildHeatmapSvg(coins, '24h');
  assert.doesNotMatch(svg, /NaN|undefined/);
  assert.match(svg, />S0</);
  assert.match(svg, /<svg[^>]*width="1280"/);
  assert.notEqual(heatColor(5, '24h'), heatColor(-5, '24h'));
  assert.equal(heatColor(null), '#3a3f4b');
  assert.doesNotMatch(buildHeatmapSvg(coins, '7d'), /NaN/); // coins without 7d data still draw
});

test('best and worst list the biggest movers', () => {
  assert.match(buildMoversText(coins, '24h', 'best', 2), /S11/);
  assert.match(buildMoversText(coins, '24h', 'worst', 2), /S0/);
  assert.match(buildMoversText(coins, '7d', 'best'), /No data/);
});

test('polymarket answers are cleaned and searchable', () => {
  const body = [
    { question: 'Will BTC hit 200k?', slug: 'btc-200k', outcomes: '["Yes","No"]', outcomePrices: '["0.31","0.69"]', volume24hr: 125000 },
    { question: 'Rain tomorrow?', slug: 'rain', outcomes: '["Yes","No"]', outcomePrices: '["0.5"]' },
    { question: 'Eth flip?', slug: 'eth', outcomes: ['Yes', 'No'], outcomePrices: ['0.1', '0.9'] },
  ];
  assert.equal(parsePolymarket(body).length, 2); // the malformed one is dropped
  assert.equal(parsePolymarket(body, 'btc').length, 1);
  assert.match(buildPolymarketText(parsePolymarket(body, 'btc'), 'btc'), /Yes <b>31%<\/b>/);
  assert.match(buildPolymarketText([], 'zzz'), /No active/);
});

test('price targets: multiples and percents', () => {
  assert.deepEqual(parseTargets('3x 4x, 10x'), [3, 4, 10]);
  assert.deepEqual(parseTargets('+50% -30%'), [0.7, 1.5]);
  assert.equal(parseTargets('1x'), null);
  assert.equal(parseTargets('abc'), null);
  assert.equal(parseTargets('0%'), null);
  assert.equal(targetLabel(0.5), '-50%');
  assert.equal(targetLabel(4), '4x');
  assert.equal(targetHit(1, 3.2, 3), true);
  assert.equal(targetHit(1, 2.9, 3), false);
  assert.equal(targetHit(1, 0.4, 0.5), true);
  assert.equal(targetHit(1, 0.6, 0.5), false);
});

test('reminder time parsing', () => {
  assert.deepEqual(parseDelay('30m check the chart'), { ms: 1_800_000, rest: 'check the chart' });
  assert.deepEqual(parseDelay('2h30m sell half'), { ms: 9_000_000, rest: 'sell half' });
  assert.deepEqual(parseDelay('in 10 minutes call mom'), { ms: 600_000, rest: 'call mom' });
  assert.equal(parseDelay('1d').ms, 86_400_000);
  assert.equal(parseDelay('tomorrow'), null);
  assert.equal(parseDelay('2s hi'), null); // too short
  assert.equal(parseDelay('999d hi'), null); // too far
});

test('technical read: rising, falling and flat prices', () => {
  const up = Array.from({ length: 80 }, (_, i) => 1 + i * 0.02);
  const down = [...up].reverse();
  assert.equal(analyzeCloses(up).label, 'Bullish');
  assert.equal(analyzeCloses(down).label, 'Bearish');
  assert.equal(analyzeCloses(up).rsi, 100);
  assert.equal(analyzeCloses(up.slice(0, 10)), null);
  assert.ok(Math.abs(rsi(down) - 0) < 1e-9);
  assert.equal(ema([1, 2, 3], 5), null);
  const text = buildTaText('ABC', [{ tf: '1h', a: analyzeCloses(up) }, { tf: '5m', a: null }]);
  assert.match(text, /\$ABC/);
  assert.match(text, /Bullish/);
  assert.match(text, /overbought/);
  assert.match(buildTaText('ABC', [{ tf: '1h', a: null }]), /Not enough/);
});

test('AI helpers: safe links and translate language codes', () => {
  assert.equal(isPublicUrl('https://example.com/a'), true);
  assert.equal(isPublicUrl('http://localhost:3000'), false);
  assert.equal(isPublicUrl('http://127.0.0.1/x'), false);
  assert.equal(isPublicUrl('http://192.168.1.5/x'), false);
  assert.equal(isPublicUrl('http://169.254.169.254/latest'), false);
  assert.equal(isPublicUrl('ftp://example.com'), false);
  assert.equal(stripHtml('<p>Hi <b>there</b></p><script>x()</script>'), 'Hi there');
  assert.deepEqual(parseTranslate('bonjour -en'), { text: 'bonjour', lang: 'English' });
  assert.deepEqual(parseTranslate('good morning -fr'), { text: 'good morning', lang: 'French' });
  assert.equal(parseTranslate('hi -zz').bad, 'zz');
});
