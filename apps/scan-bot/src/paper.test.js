import test from 'node:test';
import assert from 'node:assert/strict';
import {
  matchesStrategy, hasRoom, sizeForTrade, pnlPct, shouldClose,
  buildPositionLine, buildPositionsText, buildHistoryText, buildOpenNotice, buildCloseNotice,
} from './paper.js';

test('matchesStrategy', () => {
  assert.equal(matchesStrategy({ enabled: false }, { mcapUsd: 1000 }), false);
  assert.equal(matchesStrategy({ enabled: true }, { mcapUsd: 0 }), false);
  assert.equal(matchesStrategy({ enabled: true, min_mcap_usd: null, max_mcap_usd: null }, { mcapUsd: 50 }), true);
  assert.equal(matchesStrategy({ enabled: true, min_mcap_usd: 1000, max_mcap_usd: 20000 }, { mcapUsd: 500 }), false);
  assert.equal(matchesStrategy({ enabled: true, min_mcap_usd: 1000, max_mcap_usd: 20000 }, { mcapUsd: 5000 }), true);
  assert.equal(matchesStrategy({ enabled: true, min_mcap_usd: 1000, max_mcap_usd: 20000 }, { mcapUsd: 50000 }), false);
});

test('hasRoom', () => {
  assert.equal(hasRoom({ open_count: 2, max_open: 3 }), true);
  assert.equal(hasRoom({ open_count: 3, max_open: 3 }), false);
});

test('sizeForTrade', () => {
  assert.equal(sizeForTrade({ alloc_pct: 5 }, 500), 25);
  assert.equal(sizeForTrade({ alloc_pct: 150 }, 500), 500); // clamped to 100%
  assert.equal(sizeForTrade({ alloc_pct: -5 }, 500), 0); // clamped to 0%
  assert.equal(sizeForTrade({ alloc_pct: 5 }, 0), 0);
  assert.equal(sizeForTrade({ alloc_pct: 33.333 }, 100), 33.33); // rounds down to cents
});

test('pnlPct', () => {
  assert.equal(pnlPct(1, 2), 100);
  assert.equal(pnlPct(2, 1), -50);
  assert.equal(pnlPct(0, 1), null);
  assert.equal(pnlPct(1, null), null);
  assert.equal(pnlPct(1, -1), null);
});

test('shouldClose', () => {
  assert.equal(shouldClose({ tp_pct: 100, sl_pct: 40 }, null), null);
  assert.equal(shouldClose({ tp_pct: 100, sl_pct: 40 }, 50), null);
  assert.equal(shouldClose({ tp_pct: 100, sl_pct: 40 }, 100), 'tp');
  assert.equal(shouldClose({ tp_pct: 100, sl_pct: 40 }, 150), 'tp');
  assert.equal(shouldClose({ tp_pct: 100, sl_pct: 40 }, -40), 'sl');
  assert.equal(shouldClose({ tp_pct: 100, sl_pct: 40 }, -39), null);
});

test('buildPositionLine / buildPositionsText', () => {
  const row = { mint: 'Aa'.padEnd(40, '1'), symbol: 'DOG', entry_price_usd: 1, size_usd: 25, opened_at: new Date(Date.now() - 5 * 60000).toISOString() };
  const line = buildPositionLine(row, 1.5);
  assert.match(line, /\$DOG/);
  assert.match(line, /\+50\.0%/);
  assert.match(line, /5m ago/);
  assert.equal(buildPositionsText([], new Map()), 'No open paper positions. They open automatically once your strategy is on and a call matches.');
  assert.match(buildPositionsText([row], new Map([[row.mint, { priceUsd: 2 }]])), /\$DOG/);
});

test('buildHistoryText', () => {
  assert.equal(buildHistoryText([]), 'No closed paper trades yet.');
  const row = { mint: 'Bb'.padEnd(40, '2'), symbol: 'CAT', pnl_usd: -10, pnl_pct: -40, close_reason: 'sl' };
  assert.match(buildHistoryText([row]), /\$CAT.*\$-10\.00.*stop-loss/s);
});

test('open/close notices', () => {
  assert.match(buildOpenNotice({ symbol: 'DOG', mint: 'x', sizeUsd: 25, mcapUsd: 12000 }), /\$DOG/);
  const c = buildCloseNotice({ symbol: 'DOG', mint: 'x', reason: 'tp', pnlUsd: 25, pnlPct: 100 });
  assert.match(c, /take-profit/);
  assert.match(c, /\+\$25\.00/);
});
