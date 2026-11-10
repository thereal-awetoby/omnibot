import test from 'node:test';
import assert from 'node:assert/strict';
import {
  matchesStrategy, matchesSourceFilter, hasRoom, sizeForTrade, capSize, withinDailyLimit, pnlPct, shouldClose,
  partialTpHit, partialCloseSize, buildSparkline,
  buildPositionLine, buildPositionsText, buildHistoryText, buildOpenNotice, buildCloseNotice, buildStrategyText,
  buildAgentCallNotice, buildMilestoneNotice, buildStatsText, buildPartialCloseNotice, buildWhyText,
  buildPositionCard, positionKeyboard,
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
  assert.match(buildStatsText(rows, [100, 150, 80, 130]), /Equity curve: [▁▂▃▄▅▆▇█]+/);
});

// ---------- Post-plan: source filters ----------

test('matchesSourceFilter: no filter allows everything; a filter restricts by handle/chat id', () => {
  assert.equal(matchesSourceFilter({ source_filter: null }, 'elonmusk'), true);
  assert.equal(matchesSourceFilter({ source_filter: '' }, null), true);
  assert.equal(matchesSourceFilter({ source_filter: 'elonmusk, -100123' }, 'ElonMusk'), true); // case-insensitive
  assert.equal(matchesSourceFilter({ source_filter: 'elonmusk,-100123' }, '-100123'), true);
  assert.equal(matchesSourceFilter({ source_filter: 'elonmusk' }, 'someoneelse'), false);
  assert.equal(matchesSourceFilter({ source_filter: 'elonmusk' }, null), false); // filter set, source unknown: don't guess
});

// ---------- Post-plan: fixed-$ sizing ----------

test('capSize: fixed-$ sizing is used when size_mode is "fixed", still capped and bounded by balance', () => {
  assert.equal(capSize({ size_mode: 'fixed', alloc_usd: 30, alloc_pct: 5 }, 500), 30);
  assert.equal(capSize({ size_mode: 'fixed', alloc_usd: 1000, alloc_pct: 5 }, 500), 500); // never above balance
  assert.equal(capSize({ size_mode: 'fixed', alloc_usd: 30, max_position_usd: 10 }, 500), 10); // hard cap still applies
  assert.equal(capSize({ size_mode: 'pct', alloc_usd: 30, alloc_pct: 5 }, 500), 25); // pct mode ignores alloc_usd
  assert.equal(capSize({ size_mode: 'fixed', alloc_usd: 30, alloc_pct: 5 }, 500, 10), 50); // agent's own sizePct still wins when given
});

// ---------- Post-plan: partial take-profit ----------

test('partialTpHit fires once, at the configured tier', () => {
  const s = { partial_tp_pct: 50, partial_tp_close_pct: 50 };
  assert.equal(partialTpHit(s, 40, false), false); // not there yet
  assert.equal(partialTpHit(s, 50, false), true);
  assert.equal(partialTpHit(s, 80, false), true); // still fires even if it ran past the tier
  assert.equal(partialTpHit(s, 80, true), false); // already taken
  assert.equal(partialTpHit({ partial_tp_pct: null, partial_tp_close_pct: null }, 80, false), false); // no tier configured
});

test('partialCloseSize peels off the configured % of the current size', () => {
  assert.equal(partialCloseSize({ partial_tp_close_pct: 50 }, 100), 50);
  assert.equal(partialCloseSize({ partial_tp_close_pct: 33.333 }, 90), 29.99);
});

test('buildPartialCloseNotice', () => {
  const n = buildPartialCloseNotice({ symbol: 'DOG', mint: 'x', closedUsd: 25, remainingUsd: 25, pnlUsd: 12.5, pnlPct: 50 });
  assert.match(n, /Partial take-profit on \$DOG/);
  assert.match(n, /\$25\.00/);
  assert.match(n, /still running/);
});

// ---------- Post-plan: equity curve / sparkline ----------

test('buildSparkline needs at least two points and scales between min/max', () => {
  assert.equal(buildSparkline([100]), '');
  assert.equal(buildSparkline([]), '');
  const s = buildSparkline([100, 200]);
  assert.equal(s.length, 2);
  assert.notEqual(s[0], s[1]);
});

// ---------- Post-plan: deeper agent logging ----------

test('buildWhyText shows the fuller reasoning, or says plainly there is none', () => {
  assert.equal(buildWhyText(null), 'No paper trade with that id.');
  assert.match(buildWhyText({ mint: 'x', symbol: 'DOG', open_mode: 'rules' }), /matched your rules/);
  assert.match(buildWhyText({ mint: 'x', symbol: 'DOG', open_mode: 'agent', decision_reason: 'Strong volume', decision_detail: null }),
    /Strong volume.*No fuller reasoning/s);
  assert.match(
    buildWhyText({ mint: 'x', symbol: 'DOG', open_mode: 'agent', decision_reason: 'Strong volume', decision_detail: 'Volume tripled and narrative is building.' }),
    /Strong volume.*Volume tripled and narrative is building\./s,
  );
});

// ---------- Position cards (/pos) ----------

test('buildPositionCard shows entry, live PnL and value', () => {
  const c = buildPositionCard(
    { id: 7, symbol: 'DOG', mint: 'Mint111', entry_price_usd: 0.001, size_usd: 50, opened_at: new Date(Date.now() - 5 * 60000).toISOString() },
    0.0015,
  );
  assert.match(c, /DOG/);
  assert.match(c, /Mint111/);
  assert.match(c, /\+50\.00%/);
  assert.match(c, /\+\$25\.00/);
  assert.match(c, /Value: \$75\.00/);
  assert.match(c, /no real money/);
});

test('buildPositionCard falls back to entry price when no live price', () => {
  const c = buildPositionCard(
    { id: 7, symbol: null, mint: 'Mint111', entry_price_usd: 0.002, size_usd: 10, opened_at: new Date().toISOString() },
    null,
  );
  assert.match(c, /Token/);
  assert.match(c, /0\.00%/);
});

test('positionKeyboard has refresh/share and 25/50/100 close buttons', () => {
  const kb = positionKeyboard(42);
  const flat = kb.inline_keyboard.flat();
  assert.deepEqual(flat.map((b) => b.callback_data), [
    'pp:refresh:42', 'pp:share:42', 'pp:close:42:25', 'pp:close:42:50', 'pp:close:42:100',
  ]);
});
