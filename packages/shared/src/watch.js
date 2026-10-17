import { query } from './db.js';

export const MAX_WATCHES = 20;
export const DEFAULT_ALERT_PCT = 25;

// The user's alert threshold = the one on their newest watch, else the default.
export async function getAlertPct(telegramId) {
  const { rows } = await query(
    'SELECT alert_pct FROM watchlist WHERE telegram_id = $1 ORDER BY created_at DESC LIMIT 1',
    [telegramId]
  );
  return rows[0]?.alert_pct ?? DEFAULT_ALERT_PCT;
}

// Returns 'added' | 'exists' | 'full'.
export async function addWatch({ telegramId, mint, symbol, priceUsd }) {
  const { rows } = await query('SELECT mint FROM watchlist WHERE telegram_id = $1', [telegramId]);
  if (rows.some((r) => r.mint === mint)) return 'exists';
  if (rows.length >= MAX_WATCHES) return 'full';
  const pct = await getAlertPct(telegramId);
  await query(
    `INSERT INTO watchlist (telegram_id, mint, symbol, base_price_usd, added_price_usd, alert_pct)
     VALUES ($1, $2, $3, $4, $4, $5) ON CONFLICT DO NOTHING`,
    [telegramId, mint, symbol ?? null, priceUsd, pct]
  );
  return 'added';
}

export async function removeWatch(telegramId, mint) {
  const r = await query('DELETE FROM watchlist WHERE telegram_id = $1 AND mint = $2', [telegramId, mint]);
  return r.rowCount > 0;
}

export async function isWatching(telegramId, mint) {
  const r = await query('SELECT 1 FROM watchlist WHERE telegram_id = $1 AND mint = $2', [telegramId, mint]);
  return r.rowCount > 0;
}

export async function listWatches(telegramId) {
  const { rows } = await query(
    `SELECT mint, symbol, base_price_usd, added_price_usd, alert_pct
     FROM watchlist WHERE telegram_id = $1 ORDER BY created_at`,
    [telegramId]
  );
  return rows;
}

export async function setAlertPct(telegramId, pct) {
  await query('UPDATE watchlist SET alert_pct = $2 WHERE telegram_id = $1', [telegramId, pct]);
}

// Everything, for the background checker.
export async function listAllWatches() {
  const { rows } = await query('SELECT telegram_id, mint, symbol, base_price_usd, alert_pct FROM watchlist');
  return rows;
}

export async function updateWatchBase(telegramId, mint, priceUsd) {
  await query('UPDATE watchlist SET base_price_usd = $3 WHERE telegram_id = $1 AND mint = $2', [telegramId, mint, priceUsd]);
}

// Used when a user blocks the bot: stop checking for them.
export async function removeAllWatches(telegramId) {
  await query('DELETE FROM watchlist WHERE telegram_id = $1', [telegramId]);
}
