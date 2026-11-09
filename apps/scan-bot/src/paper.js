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

// Trade size: a slice of the current balance, never more than the balance itself, with a $1 floor below which it's not worth opening.
export function sizeForTrade(strategy, balanceUsd) {
  const pct = Math.max(0, Math.min(100, Number(strategy.alloc_pct) || 0));
  const size = Math.min(Number(balanceUsd) || 0, (Number(balanceUsd) || 0) * (pct / 100));
  return Math.floor(size * 100) / 100;
}
export const MIN_TRADE_USD = 1;

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

const REASON_LABEL = { tp: '🎯 take-profit', sl: '🛑 stop-loss', manual: 'closed manually' };

export function buildAccountText({ account, strategy, openCount, investedUsd }) {
  const equity = Number(account.balance_usd) + investedUsd;
  return (
    `📝 <b>Paper account</b> (virtual, no real money)\n\n` +
    `Cash: <b>${formatUsd(Number(account.balance_usd))}</b>\n` +
    `In open positions: ${formatUsd(investedUsd)} (${openCount})\n` +
    `Equity: <b>${formatUsd(equity)}</b>\n` +
    `Realized so far: ${Number(account.realized_usd) >= 0 ? '+' : ''}${formatUsd(Number(account.realized_usd))}\n\n` +
    `Strategy: ${strategy.enabled ? '🟢 on' : '⚪ off'} · /strategy to edit`
  );
}

export function buildStrategyText(strategy) {
  const r = (n) => (n == null ? 'any' : formatUsd(Number(n)));
  return (
    `⚙️ <b>Your paper strategy</b>\n\n` +
    `Status: ${strategy.enabled ? '🟢 on — opens a paper trade on every new call in range' : '⚪ off — matches nothing'}\n` +
    `Market cap: ${r(strategy.min_mcap_usd)} – ${r(strategy.max_mcap_usd)}\n` +
    `Size per trade: ${strategy.alloc_pct}% of balance\n` +
    `Take-profit: +${strategy.tp_pct}%\n` +
    `Stop-loss: -${strategy.sl_pct}%\n` +
    `Max open at once: ${strategy.max_open}\n\n` +
    `v1 matches every tracked call (any group, any followed X account) in your market-cap range. Picking specific sources comes later.`
  );
}

export function buildPositionLine({ mint, symbol, entry_price_usd, size_usd, opened_at }, currentPriceUsd) {
  const pct = pnlPct(Number(entry_price_usd), currentPriceUsd);
  const sym = symbol ? `$${esc(symbol)}` : esc(mint.slice(0, 4) + '…' + mint.slice(-4));
  const pctTxt = pct == null ? 'price n/a' : `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
  const age = Math.max(1, Math.round((Date.now() - new Date(opened_at).getTime()) / 60000));
  return `${pct > 0 ? '🟢' : pct < 0 ? '🔴' : '⚪'} ${sym} · ${formatUsd(Number(size_usd))} · ${pctTxt} · ${age}m ago`;
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
    return `${pnl >= 0 ? '🟢' : '🔴'} ${sym} · ${pnl >= 0 ? '+' : ''}${formatUsd(pnl)} (${Number(r.pnl_pct).toFixed(1)}%) · ${REASON_LABEL[r.close_reason] ?? r.close_reason}`;
  });
  return '📜 <b>Paper trade history</b>\n\n' + lines.join('\n');
}

export function buildOpenNotice({ symbol, mint, sizeUsd, mcapUsd }) {
  const sym = symbol ? `$${esc(symbol)}` : esc(mint.slice(0, 4) + '…' + mint.slice(-4));
  return `📝 Paper-bought ${sym}\n${formatUsd(sizeUsd)} at ${mcapUsd ? formatUsd(mcapUsd) + ' mcap' : 'entry'} — matched your strategy.`;
}

export function buildCloseNotice({ symbol, mint, reason, pnlUsd, pnlPct: pct }) {
  const sym = symbol ? `$${esc(symbol)}` : esc(mint.slice(0, 4) + '…' + mint.slice(-4));
  const sign = pnlUsd >= 0 ? '+' : '';
  return `${pnlUsd >= 0 ? '🎉' : '💀'} Paper-closed ${sym} (${REASON_LABEL[reason] ?? reason})\n${sign}${formatUsd(pnlUsd)} (${sign}${pct.toFixed(1)}%)`;
}
