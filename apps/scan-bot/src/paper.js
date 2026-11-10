// Paper trading logic: rule matching, position sizing and PnL math. Pure functions, no DB, no network, no Telegram.
import { esc, formatUsd } from '@omnibot/shared';

// Does this new call match a user's strategy? (Market cap range only, for v1 — "any source" counts.)
export function matchesStrategy(strategy, { mcapUsd }) {
  if (!strategy?.enabled) return false;
  if (!(mcapUsd > 0)) return false; // no market cap to judge: skip rather than guess
  if (strategy.min_mcap_usd != null && mcapUsd < Number(strategy.min_mcap_usd)) return false;
  if (strategy.max_mcap_usd != null && mcapUsd > Number(strategy.max_mcap_usd)) return false;
  return true;
}

export function hasRoom(strategy) {
  return Number(strategy.open_count) < Number(strategy.max_open);
}

// Source filter: restricts a strategy to specific X accounts / group chats, in every mode — the plan's own
// hybrid example ("only these 5 X accounts..."). sourceId is whatever identifies the signal (an X handle, a
// group chat id); an unset filter (null/empty) allows everything, so every existing strategy is unaffected.
export function matchesSourceFilter(strategy, sourceId) {
  const filter = (strategy.source_filter ?? '').trim();
  if (!filter) return true;
  if (!sourceId) return false; // a filter is set but this signal has no identifiable source: don't guess
  const allowed = filter.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return allowed.includes(String(sourceId).trim().toLowerCase());
}

// Trade size: a slice of the current balance, never more than the balance itself, with a $1 floor below which it's not worth opening.
export function sizeForTrade(strategy, balanceUsd) {
  const pct = Math.max(0, Math.min(100, Number(strategy.alloc_pct) || 0));
  const size = Math.min(Number(balanceUsd) || 0, (Number(balanceUsd) || 0) * (pct / 100));
  return Math.floor(size * 100) / 100;
}
export const MIN_TRADE_USD = 1;

// Hard risk guards (Phase 3, plan section 7): apply in every mode, including pure Agent Mode, and the
// agent's own suggestion can never push past them.

// Clamps a proposed trade to the strategy's absolute per-trade cap (if any) and to what's actually in the
// balance. sizePct, when given, is the agent's own suggested slice of the balance (0-100); it still passes
// through the same ceiling as a rule-mode trade. With no sizePct, the base size comes from the strategy's own
// sizing: a fixed $ amount (size_mode 'fixed' + alloc_usd) or the default %-of-balance (alloc_pct).
export function capSize(strategy, balanceUsd, sizePct = null) {
  const bal = Number(balanceUsd) || 0;
  let size;
  if (sizePct != null) {
    size = bal * (Math.max(0, Math.min(100, Number(sizePct) || 0)) / 100);
  } else if (strategy.size_mode === 'fixed' && strategy.alloc_usd != null) {
    size = Math.max(0, Number(strategy.alloc_usd) || 0);
  } else {
    size = bal * (Math.max(0, Math.min(100, Number(strategy.alloc_pct) || 0)) / 100);
  }
  if (strategy.max_position_usd != null) size = Math.min(size, Number(strategy.max_position_usd));
  size = Math.min(size, bal);
  return Math.floor(Math.max(0, size) * 100) / 100;
}

// Has today's realized loss already hit the strategy's daily stop? No limit set (null) means no stop.
// todayPnlUsd is realized PnL only (closed trades) — unrealized moves on open positions don't count against it.
export function withinDailyLimit(strategy, todayPnlUsd, equityUsd) {
  if (strategy.daily_loss_limit_pct == null) return true;
  if (!(Number(equityUsd) > 0)) return true; // nothing to measure a % loss against yet
  const lossPct = (-Number(todayPnlUsd) / Number(equityUsd)) * 100;
  return lossPct < Number(strategy.daily_loss_limit_pct);
}

export function pnlPct(entryPriceUsd, currentPriceUsd) {
  if (!(entryPriceUsd > 0) || typeof currentPriceUsd !== 'number' || !Number.isFinite(currentPriceUsd) || currentPriceUsd < 0) return null;
  return ((currentPriceUsd - entryPriceUsd) / entryPriceUsd) * 100;
}

// TP/SL check for one open position against its owner's current strategy settings.
export function shouldClose(strategy, pct) {
  if (pct == null) return null;
  if (strategy.tp_pct != null && pct >= Number(strategy.tp_pct)) return 'tp';
  if (strategy.sl_pct != null && pct <= -Number(strategy.sl_pct)) return 'sl';
  return null;
}

// Partial take-profit: has this position crossed its one partial-close tier, and not taken it yet? Checked
// before the full TP/SL above so a partial can fire on its way to the final target rather than being skipped.
export function partialTpHit(strategy, pct, alreadyTaken) {
  if (alreadyTaken || pct == null) return false;
  if (strategy.partial_tp_pct == null || strategy.partial_tp_close_pct == null) return false;
  return pct >= Number(strategy.partial_tp_pct);
}

// How much of the position's current size to peel off for that partial tier, in dollars.
export function partialCloseSize(strategy, sizeUsd) {
  const pct = Math.max(0, Math.min(100, Number(strategy.partial_tp_close_pct) || 0));
  return Math.floor(Number(sizeUsd) * (pct / 100) * 100) / 100;
}

const REASON_LABEL = { tp: '🎯 take-profit', sl: '🛑 stop-loss', manual: 'closed manually', partial: '🎯 partial take-profit' };

// A tiny equity-curve-as-text: one block character per snapshot, scaled between the series' own min and max.
// Good enough for a Telegram line without any charting infra; the Mini App gets the same numbers to draw a
// real line chart from (dashboard.js's equityCurve).
const SPARK_BARS = '▁▂▃▄▅▆▇█';
export function buildSparkline(values) {
  const nums = values.filter((v) => Number.isFinite(v));
  if (nums.length < 2) return '';
  const min = Math.min(...nums), max = Math.max(...nums);
  const span = max - min || 1;
  return nums.map((v) => SPARK_BARS[Math.min(SPARK_BARS.length - 1, Math.max(0, Math.floor(((v - min) / span) * (SPARK_BARS.length - 1))))]).join('');
}

export function buildAccountText({ account, strategy, openCount, investedUsd, equityHistory = null }) {
  const equity = Number(account.balance_usd) + investedUsd;
  const spark = equityHistory ? buildSparkline(equityHistory) : '';
  return (
    `📝 <b>Paper account</b> (virtual, no real money)\n\n` +
    `Cash: <b>${formatUsd(Number(account.balance_usd))}</b>\n` +
    `In open positions: ${formatUsd(investedUsd)} (${openCount})\n` +
    `Equity: <b>${formatUsd(equity)}</b>${spark ? `  ${spark}` : ''}\n` +
    `Realized so far: ${Number(account.realized_usd) >= 0 ? '+' : ''}${formatUsd(Number(account.realized_usd))}\n\n` +
    `Strategy: ${strategy.enabled ? '🟢 on' : '⚪ off'} · /strategy to edit`
  );
}

const MODE_LABEL = { rules: '📏 Rules', agent: '🤖 Agent', hybrid: '🤝 Hybrid' };
const MODE_BLURB = {
  rules: 'Opens a paper trade on every new call inside your market-cap range.',
  agent: 'Your market-cap range is ignored. An AI reads every new call plus your instructions below and decides buy or skip.',
  hybrid: 'Your market-cap range is a hard filter first — only calls inside it reach the AI, which then decides buy or skip using your instructions.',
};

export function buildStrategyText(strategy) {
  const r = (n) => (n == null ? 'any' : formatUsd(Number(n)));
  const mode = strategy.mode ?? 'rules';
  const sizeLine = strategy.size_mode === 'fixed' && strategy.alloc_usd != null
    ? `Size per trade: ${formatUsd(Number(strategy.alloc_usd))} fixed`
    : `Size per trade: ${strategy.alloc_pct}% of balance`;
  const lines = [
    `⚙️ <b>Your paper strategy</b>\n`,
    `Status: ${strategy.enabled ? '🟢 on' : '⚪ off — matches nothing'} · Mode: <b>${MODE_LABEL[mode] ?? mode}</b>`,
    `Market cap: ${r(strategy.min_mcap_usd)} – ${r(strategy.max_mcap_usd)}`,
    `${sizeLine}${strategy.max_position_usd != null ? ` (capped at ${formatUsd(Number(strategy.max_position_usd))})` : ''}`,
    `Take-profit: +${strategy.tp_pct}%${strategy.partial_tp_pct != null ? ` · partial: close ${strategy.partial_tp_close_pct}% at +${strategy.partial_tp_pct}%` : ''}`,
    `Stop-loss: -${strategy.sl_pct}%`,
    `Max open at once: ${strategy.max_open}`,
    `Daily loss stop: ${strategy.daily_loss_limit_pct != null ? `-${strategy.daily_loss_limit_pct}% of equity` : 'none'}`,
    `Sources: ${strategy.source_filter ? esc(strategy.source_filter) : 'any (every group/X follow)'}`,
  ];
  if (mode !== 'rules') lines.push(`Instructions: ${strategy.agent_prompt ? esc(strategy.agent_prompt) : '<i>none set — the AI will use its own judgment, favoring caution</i>'}`);
  lines.push('', MODE_BLURB[mode] ?? MODE_BLURB.rules);
  return lines.join('\n');
}

export function buildPositionLine({ mint, symbol, entry_price_usd, size_usd, opened_at, open_mode, decision_reason }, currentPriceUsd) {
  const pct = pnlPct(Number(entry_price_usd), currentPriceUsd);
  const sym = symbol ? `$${esc(symbol)}` : esc(mint.slice(0, 4) + '…' + mint.slice(-4));
  const pctTxt = pct == null ? 'price n/a' : `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
  const age = Math.max(1, Math.round((Date.now() - new Date(opened_at).getTime()) / 60000));
  const why = open_mode && open_mode !== 'rules' && decision_reason ? `\n   <i>${esc(decision_reason)}</i>` : '';
  return `${pct > 0 ? '🟢' : pct < 0 ? '🔴' : '⚪'} ${sym} · ${formatUsd(Number(size_usd))} · ${pctTxt} · ${age}m ago${why}`;
}

// Trojan-style position card for a single open paper position
export function buildPositionCard({ id, symbol, mint, entry_price_usd, size_usd, opened_at }, currentPriceUsd) {
  const entry = Number(entry_price_usd);
  const size = Number(size_usd);
  const now = Number(currentPriceUsd) || entry;
  const pct = pnlPct(entry, now) ?? 0;
  const pnlUsd = size * (pct / 100);
  const value = size + pnlUsd;
  const sign = pct >= 0 ? '+' : '';
  const color = pct >= 0 ? '🟢' : '🔴';
  const age = Math.max(1, Math.round((Date.now() - new Date(opened_at).getTime()) / 60000));

  return (
    `📈 <b>${esc(symbol || 'Token')}</b> ${color}\n` +
    `<code>${mint}</code>\n\n` +
    `Entry: $${entry.toFixed(6)} · Size: $${size.toFixed(2)}\n` +
    `Now: $${now.toFixed(6)}\n` +
    `PnL: <b>${sign}${pct.toFixed(2)}%</b> (${sign}$${pnlUsd.toFixed(2)})\n` +
    `Value: $${value.toFixed(2)} · ${age}m ago\n\n` +
    `<i>Paper position · no real money</i>`
  );
}

export function positionKeyboard(id) {
  return {
    inline_keyboard: [
      [
        { text: '🔄 Refresh', callback_data: `pp:refresh:${id}` },
        { text: '📤 Share PnL', callback_data: `pp:share:${id}` },
      ],
      [
        { text: '25%', callback_data: `pp:close:${id}:25` },
        { text: '50%', callback_data: `pp:close:${id}:50` },
        { text: '100%', callback_data: `pp:close:${id}:100` },
      ],
    ],
  };
}

export function buildPositionsText(rows, prices) {
  if (rows.length === 0) return 'No open paper positions. They open automatically once your strategy is on and a call matches.';
  return '📈 <b>Open paper positions</b>\n\n' + rows.map((r) => buildPositionLine(r, prices.get(r.mint)?.priceUsd ?? null)).join('\n');
}

export function buildHistoryText(rows) {
  if (rows.length === 0) return 'No closed paper trades yet.';
  const lines = rows.map((r) => {
    const sym = r.symbol ? `$${esc(r.symbol)}` : esc(r.mint.slice(0, 4) + '…' + r.mint.slice(-4));
    const pnl = Number(r.pnl_usd);
    const why = r.open_mode && r.open_mode !== 'rules' && r.decision_reason ? `\n   <i>bought because: ${esc(r.decision_reason)}</i>` : '';
    const via = r.signal_source ? ` · via ${esc(r.signal_source)}` : '';
    return `${pnl >= 0 ? '🟢' : '🔴'} ${sym} · ${pnl >= 0 ? '+' : ''}${formatUsd(pnl)} (${Number(r.pnl_pct).toFixed(1)}%) · ${REASON_LABEL[r.close_reason] ?? r.close_reason}${via}${why}`;
  });
  return '📜 <b>Paper trade history</b>\n\n' + lines.join('\n');
}

export function buildOpenNotice({ symbol, mint, sizeUsd, mcapUsd, openMode = 'rules', decisionReason = null, source = null }) {
  const sym = symbol ? `$${esc(symbol)}` : esc(mint.slice(0, 4) + '…' + mint.slice(-4));
  const why = openMode !== 'rules' && decisionReason ? esc(decisionReason) : 'matched your strategy';
  const via = source ? ` · via ${esc(source)}` : '';
  return `📝 Paper-bought ${sym}\n${formatUsd(sizeUsd)} at ${mcapUsd ? formatUsd(mcapUsd) + ' mcap' : 'entry'} — ${why}${via}.`;
}

export function buildCloseNotice({ symbol, mint, reason, pnlUsd, pnlPct: pct }) {
  const sym = symbol ? `$${esc(symbol)}` : esc(mint.slice(0, 4) + '…' + mint.slice(-4));
  const sign = pnlUsd >= 0 ? '+' : '';
  return `${pnlUsd >= 0 ? '🎉' : '💀'} Paper-closed ${sym} (${REASON_LABEL[reason] ?? reason})\n${sign}${formatUsd(pnlUsd)} (${sign}${pct.toFixed(1)}%)`;
}

// ---------- Phase 4: Agent "call" (a heads-up with no paper trade — no capital risked) ----------
export function buildAgentCallNotice({ symbol, mint, mcapUsd, reason = null, source = null }) {
  const sym = symbol ? `$${esc(symbol)}` : esc(mint.slice(0, 4) + '…' + mint.slice(-4));
  const via = source ? ` · via ${esc(source)}` : '';
  return (
    `📣 <b>Agent call</b> (no paper trade)\n` +
    `${sym} at ${mcapUsd ? formatUsd(mcapUsd) + ' mcap' : 'current price'}${via}\n` +
    (reason ? `<i>${esc(reason)}</i>` : 'Flagged as worth watching.')
  );
}

// A milestone reply, threaded under the original open/call message — mirrors a real group call's multiplier post.
export function buildMilestoneNotice({ symbol, mint, x }) {
  const sym = symbol ? `$${esc(symbol)}` : esc(mint.slice(0, 4) + '…' + mint.slice(-4));
  return `🚀 ${sym} just hit <b>${(x >= 10 ? x.toFixed(0) : x.toFixed(2))}x</b> on your paper trade.`;
}

// ---------- Phase 5: a shareable performance summary (plan section 8 — proof the system is live) ----------
// Partial take-profit notice: part of the position was closed, the rest keeps running.
export function buildPartialCloseNotice({ symbol, mint, closedUsd, remainingUsd, pnlUsd, pnlPct: pct }) {
  const sym = symbol ? `$${esc(symbol)}` : esc(mint.slice(0, 4) + '…' + mint.slice(-4));
  const sign = pnlUsd >= 0 ? '+' : '';
  return `🎯 Partial take-profit on ${sym}\nClosed ${formatUsd(closedUsd)} (${sign}${formatUsd(pnlUsd)}, ${sign}${pct.toFixed(1)}%) · ${formatUsd(remainingUsd)} still running.`;
}

// /paperwhy: the agent's fuller reasoning for one trade (deeper logging) — falls back plainly when there is
// none to show (a rule-mode trade, or an agent trade from before this was tracked).
export function buildWhyText(position) {
  if (!position) return 'No paper trade with that id.';
  const sym = position.symbol ? `$${esc(position.symbol)}` : esc(position.mint.slice(0, 4) + '…' + position.mint.slice(-4));
  if (position.open_mode === 'rules' || !position.decision_reason) return `${sym}: matched your rules — no AI reasoning to show.`;
  return (
    `${sym}\n<b>Reason shown to you:</b> ${esc(position.decision_reason)}\n\n` +
    (position.decision_detail ? `<b>Full reasoning:</b> ${esc(position.decision_detail)}` : '<i>No fuller reasoning was recorded for this trade.</i>')
  );
}

export function buildStatsText(rows, equityHistory = null) {
  if (!rows.length) return 'No closed paper trades yet — stats show up once you have some history.';
  const wins = rows.filter((r) => Number(r.pnl_usd) >= 0);
  const totalPnl = rows.reduce((a, r) => a + Number(r.pnl_usd), 0);
  const totalSize = rows.reduce((a, r) => a + Number(r.size_usd), 0);
  const best = rows.reduce((a, r) => (Number(r.pnl_pct) > Number(a?.pnl_pct ?? -Infinity) ? r : a), null);
  const avgPct = rows.reduce((a, r) => a + Number(r.pnl_pct), 0) / rows.length;
  const bestSym = best?.symbol ? `$${esc(best.symbol)}` : best ? esc(best.mint.slice(0, 4) + '…' + best.mint.slice(-4)) : null;
  const spark = equityHistory ? buildSparkline(equityHistory) : '';
  return (
    `📊 <b>Paper trading stats</b> (${rows.length} closed trade${rows.length === 1 ? '' : 's'})\n\n` +
    `Win rate: <b>${((wins.length / rows.length) * 100).toFixed(0)}%</b> (${wins.length}/${rows.length})\n` +
    `Realized PnL: ${totalPnl >= 0 ? '+' : ''}${formatUsd(totalPnl)}${totalSize > 0 ? ` (${totalPnl >= 0 ? '+' : ''}${((totalPnl / totalSize) * 100).toFixed(1)}% on capital deployed)` : ''}\n` +
    `Average trade: ${avgPct >= 0 ? '+' : ''}${avgPct.toFixed(1)}%\n` +
    (best ? `Best trade: ${bestSym} ${Number(best.pnl_pct) >= 0 ? '+' : ''}${Number(best.pnl_pct).toFixed(1)}%\n` : '') +
    (spark ? `Equity curve: ${spark}\n` : '') +
    `\n<i>Virtual balance — not real money.</i>`
  );
}
