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

// Set alert threshold for a single token on a user's watchlist.
export async function setWatchAlertPct(telegramId, mint, pct) {
  await query('UPDATE watchlist SET alert_pct = $2 WHERE telegram_id = $1 AND mint = $3', [telegramId, pct, mint]);
}

// Everything, for the background checker. Skips tokens alerted in the last 10 minutes (cooldown).
const ALERT_COOLDOWN_MS = 10 * 60_000;
export async function listAllWatches() {
  const { rows } = await query(
    `SELECT telegram_id, mint, symbol, base_price_usd, alert_pct, on_curve, curve_alerted, vol_baseline
     FROM watchlist WHERE last_alert_at IS NULL OR last_alert_at < now() - interval '10 minutes'`
  );
  return rows;
}

export async function updateWatchBase(telegramId, mint, priceUsd) {
  await query('UPDATE watchlist SET base_price_usd = $3, last_alert_at = now() WHERE telegram_id = $1 AND mint = $2', [telegramId, mint, priceUsd]);
}

// Mark a token as being on the bonding curve when first watched (best effort).
export async function setWatchOnCurve(telegramId, mint, onCurve) {
  await query('UPDATE watchlist SET on_curve = $3 WHERE telegram_id = $1 AND mint = $2', [telegramId, mint, onCurve]);
}

// Mark that a curve graduation alert has been sent for this watch.
export async function markCurveAlerted(telegramId, mint) {
  await query('UPDATE watchlist SET curve_alerted = TRUE, on_curve = FALSE WHERE telegram_id = $1 AND mint = $2', [telegramId, mint]);
}

// Store the volume baseline (h1) for volume spike comparison.
export async function setVolBaseline(telegramId, mint, vol) {
  await query('UPDATE watchlist SET vol_baseline = $3 WHERE telegram_id = $1 AND mint = $2', [telegramId, mint, vol]);
}

// Used when a user blocks the bot: stop checking for them.
export async function removeAllWatches(telegramId) {
  await query('DELETE FROM watchlist WHERE telegram_id = $1', [telegramId]);
}

// Total rows being watched right now, for the operator /status view.
export async function countAllWatches() {
  const { rows } = await query('SELECT count(*)::int AS n FROM watchlist');
  return rows[0]?.n ?? 0;
}
