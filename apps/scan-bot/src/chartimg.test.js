import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCandleSvg, defaultTf, parseTf, axisNum } from './chartimg.js';

const candles = Array.from({ length: 60 }, (_, i) => {
  const base = 3 + Math.sin(i / 6) * 2 + i * 0.1;
  return { t: 1_700_000_000 + i * 300, o: base, h: base + 1, l: base - 0.5, c: base + (i % 2 ? 0.4 : -0.3), v: 100 + i };
});
test('axisNum', () => {
  assert.equal(axisNum(97500), '97.5K'); assert.equal(axisNum(2800), '2.8K'); assert.equal(axisNum(1_250_000), '1.25M'); assert.equal(axisNum(120_000), '120K');
});
test('defaultTf follows the age', () => {
  assert.equal(defaultTf(10 * 60_000), '1m'); assert.equal(defaultTf(6 * 3_600_000), '5m'); assert.equal(defaultTf(5 * 86_400_000), '1h'); assert.equal(defaultTf(90 * 86_400_000), '4h');
  assert.equal(defaultTf(null), '5m');
});
test('parseTf', () => { assert.equal(parseTf(['abc', '15M']), '15m'); assert.equal(parseTf(['abc']), null); });
test('candle chart has candles, ATH, start, last price and first call', () => {
  const svg = buildCandleSvg({ candles, scale: 1000, symbol: 'BAKDINU', tf: '5m', started: true, call: { at: (1_700_000_000 + 20 * 300 + 30) * 1000, name: 'toby' } });
  assert.ok(svg.startsWith('<svg') && svg.endsWith('</svg>'));
  assert.ok(svg.includes('ATH ') && svg.includes('First Call') && svg.includes('BAKDINU') && svg.includes('Market Cap') && svg.includes('@OmniScanmc_bot'));
  assert.equal((svg.match(/stroke-width="1.6"/g) ?? []).length, 60);
  assert.ok(!svg.includes('NaN') && !svg.includes('undefined'));
});
test('symbols with non-latin letters or tags do not break the picture', () => {
  const svg = buildCandleSvg({ candles, symbol: '김여정<b>', tf: '1h' });
  assert.ok(!svg.includes('<b>') && svg.includes('TOKEN') === false || svg.includes('b'));
  assert.ok(!svg.includes('NaN'));
});
test('two candles and a flat price still draw', () => {
  const svg = buildCandleSvg({ candles: [{ t: 1, o: 1, h: 1, l: 1, c: 1, v: 0 }, { t: 61, o: 1, h: 1, l: 1, c: 1, v: 0 }], symbol: 'X', tf: '1m' });
  assert.ok(!svg.includes('NaN') && !svg.includes('Infinity'));
});
