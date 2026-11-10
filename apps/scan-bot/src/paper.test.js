import test from 'node:test';
import assert from 'node:assert/strict';
import {
  matchesStrategy, hasRoom, sizeForTrade, capSize, withinDailyLimit, pnlPct, shouldClose,
  buildPositionLine, buildPositionsText, buildHistoryText, buildOpenNotice, buildCloseNotice, buildStrategyText,
  buildAgentCallNotice, buildMilestoneNotice, buildStatsText,
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
  assert.match(buildOpenNotice({ symbol: 'DOG', mint: 'x', sizeUsd: 25, mcapUsd: 12000 }), /matched your strategy/);
  assert.match(buildOpenNotice({ symbol: 'DOG', mint: 'x', sizeUsd: 25, mcapUsd: 12000, source: 'group call' }), /via group call/);
  const c = buildCloseNotice({ symbol: 'DOG', mint: 'x', reason: 'tp', pnlUsd: 25, pnlPct: 100 });
  assert.match(c, /take-profit/);
  assert.match(c, /\+\$25\.00/);
});

// ---------- Phase 3: Agent Mode ----------

test('capSize caps per-trade size at max_position_usd, never above the balance', () => {
  assert.equal(capSize({ alloc_pct: 5, max_position_usd: null }, 500), 25); // falls back to alloc_pct like sizeForTrade
  assert.equal(capSize({ alloc_pct: 50, max_position_usd: 20 }, 500), 20); // $250 alloc, but capped at $20
  assert.equal(capSize({ alloc_pct: 100, max_position_usd: null }, 10), 10); // never above balance
  assert.equal(capSize({ alloc_pct: 5, max_position_usd: 100 }, 500, 30), 100); // agent's own sizePct (30%=$150) still gets capped
  assert.equal(capSize({ alloc_pct: 5, max_position_usd: 100 }, 500, 2), 10); // agent's sizePct under the cap passes through
});

test('withinDailyLimit: no limit set never blocks, a hit limit does', () => {
  assert.equal(withinDailyLimit({ daily_loss_limit_pct: null }, -1000, 500), true);
  assert.equal(withinDailyLimit({ daily_loss_limit_pct: 20 }, -50, 500), true); // -10% of equity, under the 20% stop
  assert.equal(withinDailyLimit({ daily_loss_limit_pct: 20 }, -100, 500), false); // -20% hits the stop
  assert.equal(withinDailyLimit({ daily_loss_limit_pct: 20 }, 50, 500), true); // a winning day never trips it
  assert.equal(withinDailyLimit({ daily_loss_limit_pct: 20 }, -50, 0), true); // no equity to measure against: don't block
});

test('buildStrategyText shows the mode and, outside Rules mode, the instructions', () => {
  const rules = { enabled: true, mode: 'rules', min_mcap_usd: null, max_mcap_usd: null, alloc_pct: 5, tp_pct: 100, sl_pct: 40, max_open: 3, max_position_usd: null, daily_loss_limit_pct: null };
  const t = buildStrategyText(rules);
  assert.match(t, /Mode: <b>📏 Rules<\/b>/);
  assert.doesNotMatch(t, /Instructions:/);

  const agent = { ...rules, mode: 'agent', agent_prompt: 'Only narrative plays.' };
  const a = buildStrategyText(agent);
  assert.match(a, /Mode: <b>🤖 Agent<\/b>/);
  assert.match(a, /Instructions: Only narrative plays\./);

  const noPrompt = { ...rules, mode: 'hybrid', agent_prompt: null };
  assert.match(buildStrategyText(noPrompt), /none set — the AI will use its own judgment/);
});

// ---------- Phase 4: Telegram calls & threading ----------

test('buildAgentCallNotice: a heads-up with no trade', () => {
  const n = buildAgentCallNotice({ symbol: 'DOG', mint: 'x', mcapUsd: 15000, reason: 'Interesting narrative forming', source: 'X follow' });
  assert.match(n, /\$DOG/);
  assert.match(n, /no paper trade/);
  assert.match(n, /Interesting narrative forming/);
  assert.match(n, /via X follow/);
  assert.match(buildAgentCallNotice({ symbol: 'DOG', mint: 'x', mcapUsd: 15000 }), /worth watching/);
});

test('buildMilestoneNotice formats the multiple', () => {
  assert.match(buildMilestoneNotice({ symbol: 'DOG', mint: 'x', x: 2 }), /\$DOG.*2\.00x/s);
  assert.match(buildMilestoneNotice({ symbol: 'DOG', mint: 'x', x: 25 }), /25x/);
});

// ---------- Phase 5: shareable stats ----------

test('buildStatsText: win rate, realized PnL and the best trade', () => {
  assert.equal(buildStatsText([]), 'No closed paper trades yet — stats show up once you have some history.');
  const rows = [
    { mint: 'Aa1', symbol: 'DOG', pnl_usd: 50, pnl_pct: 100, size_usd: 50 },
    { mint: 'Bb2', symbol: 'CAT', pnl_usd: -20, pnl_pct: -40, size_usd: 50 },
  ];
  const t = buildStatsText(rows);
  assert.match(t, /2 closed trades/);
  assert.match(t, /Win rate: <b>50%<\/b> \(1\/2\)/);
  assert.match(t, /\+\$30\.00/); // net realized PnL
  assert.match(t, /Best trade: \$DOG \+100\.0%/);
});
