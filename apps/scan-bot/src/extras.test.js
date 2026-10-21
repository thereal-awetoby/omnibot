import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normPeriod, parseCoins, heatColor, buildHeatmapSvg, buildMoversText, parsePolymarket, buildPolymarketText, parseAmount, parseEpoch, csvCell } from './extras.js';

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
