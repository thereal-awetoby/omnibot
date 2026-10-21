import { query } from './db.js';

export const MAX_TARGETS = 40;
export const MAX_REMINDERS = 25;

// ---- price targets ----
// Adds the targets (multiples of the price now). Returns how many were new.
export async function addTargets({ telegramId, mint, symbol, basePrice, mults }) {
  const { rows } = await query('SELECT count(*)::int AS n FROM price_targets WHERE telegram_id = $1 AND fired_at IS NULL', [telegramId]);
  let room = MAX_TARGETS - rows[0].n;
  let added = 0;
  for (const m of mults) {
    if (room <= 0) break;
    const r = await query(
      `INSERT INTO price_targets (telegram_id, mint, symbol, base_price_usd, mult) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (telegram_id, mint, mult) DO UPDATE SET base_price_usd = EXCLUDED.base_price_usd, fired_at = NULL, created_at = now()
       RETURNING (xmax = 0) AS inserted`,
      [telegramId, mint, symbol ?? null, basePrice, m]
    );
    if (r.rows[0]?.inserted) { added += 1; room -= 1; }
  }
  return added;
}
export async function listTargets(telegramId) {
  const { rows } = await query('SELECT id, mint, symbol, base_price_usd, mult, created_at FROM price_targets WHERE telegram_id = $1 AND fired_at IS NULL ORDER BY symbol, mult', [telegramId]);
  return rows;
}
export async function removeTargets(telegramId, mint = null) {
  const r = mint
    ? await query('DELETE FROM price_targets WHERE telegram_id = $1 AND mint = $2 AND fired_at IS NULL', [telegramId, mint])
    : await query('DELETE FROM price_targets WHERE telegram_id = $1 AND fired_at IS NULL', [telegramId]);
  return r.rowCount;
}
export async function listActiveTargets() {
  const { rows } = await query('SELECT id, telegram_id, mint, symbol, base_price_usd, mult FROM price_targets WHERE fired_at IS NULL LIMIT 5000');
  return rows;
}
export async function markTargetFired(id) { await query('UPDATE price_targets SET fired_at = now() WHERE id = $1', [id]); }

// ---- reminders ----
export async function addReminder({ telegramId, chatId, fireAt, body, who }) {
  const { rows } = await query('SELECT count(*)::int AS n FROM reminders WHERE telegram_id = $1 AND done = false', [telegramId]);
  if (rows[0].n >= MAX_REMINDERS) return null;
  const r = await query('INSERT INTO reminders (telegram_id, chat_id, fire_at, body, who) VALUES ($1, $2, $3, $4, $5) RETURNING id', [telegramId, chatId, fireAt, body, who ?? null]);
  return r.rows[0].id;
}
export async function listReminders(telegramId) {
  const { rows } = await query('SELECT id, chat_id, fire_at, body FROM reminders WHERE telegram_id = $1 AND done = false ORDER BY fire_at LIMIT 30', [telegramId]);
  return rows;
}
export async function removeReminder(id, telegramId) {
  const r = await query('DELETE FROM reminders WHERE id = $1 AND telegram_id = $2 AND done = false', [id, telegramId]);
  return r.rowCount > 0;
}
export async function dueReminders() {
  const { rows } = await query('SELECT id, telegram_id, chat_id, body, who FROM reminders WHERE done = false AND fire_at <= now() ORDER BY fire_at LIMIT 50');
  return rows;
}
export async function markReminderDone(id) { await query('UPDATE reminders SET done = true WHERE id = $1', [id]); }
