import { query } from './db.js';

// Records the call if nobody in this chat has called the token yet.
// Returns { first: true|false, call } where `call` is the first caller's row.
// calls.source_url: the post a call came from (set for calls made by a followed X account).
// calls.call_msg_id: the message that made the call (the member's post, or the bot's card for an X call), so the
// multiplier posts reply to it. call_settings: each group's choice for multiplier posts. All added on first use.
let colReady = null;
const ensureCallCols = () => (colReady ??= (async () => {
  await query('ALTER TABLE calls ADD COLUMN IF NOT EXISTS source_url TEXT');
  await query('ALTER TABLE calls ADD COLUMN IF NOT EXISTS call_msg_id BIGINT');
  await query(`CREATE TABLE IF NOT EXISTS call_settings (
    chat_id       BIGINT PRIMARY KEY,
    milestones_on BOOLEAN NOT NULL DEFAULT true,
    min_x         INT,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now())`);
})().catch((e) => { colReady = null; throw e; }));

export async function recordFirstCall({ chatId, mint, symbol, callerId, callerName, priceUsd, mcapUsd, sourceUrl = null, msgId = null }) {
  await ensureCallCols();
  const ins = await query(
    `INSERT INTO calls (chat_id, mint, symbol, caller_id, caller_name, price_usd, mcap_usd, source_url, call_msg_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (chat_id, mint) DO NOTHING
     RETURNING chat_id, mint, symbol, caller_id, caller_name, price_usd, mcap_usd, peak_price_usd, created_at, source_url`,
    [chatId, mint, symbol ?? null, callerId, callerName ?? null, priceUsd, mcapUsd ?? null, sourceUrl, msgId]
  );
  if (ins.rows[0]) return { first: true, call: ins.rows[0] };
  return { first: false, call: await getFirstCall(chatId, mint) };
}

export async function getFirstCall(chatId, mint) {
  await ensureCallCols();
  const { rows } = await query(
    `SELECT chat_id, mint, symbol, caller_id, caller_name, price_usd, mcap_usd, peak_price_usd, created_at, source_url, call_msg_id
     FROM calls WHERE chat_id = $1 AND mint = $2`,
    [chatId, mint]
  );
  return rows[0] ?? null;
}

// Calls in this chat from the last `days` days (newest first), for the leaderboard.
// `seconds` (any length of time) wins over `days`.
export async function listChatCalls(chatId, { days = 30, seconds = null, limit = 300 } = {}) {
  await ensureCallCols();
  const { rows } = await query(
    `SELECT mint, symbol, caller_id, caller_name, price_usd, mcap_usd, peak_price_usd, created_at, source_url
     FROM calls WHERE chat_id = $1 AND created_at > now() - make_interval(secs => $2)
     ORDER BY created_at DESC LIMIT $3`,
    [chatId, seconds ?? days * 86400, limit]
  );
  return rows;
}

// The caller_id behind a name used in this group ("@handle" or "handle"), newest call first; null when unknown.
export async function findCallerByName(chatId, name) {
  const n = String(name ?? '').trim().replace(/^@/, '').toLowerCase();
  if (!n) return null;
  const { rows } = await query(
    `SELECT caller_id, caller_name FROM calls WHERE chat_id = $1 AND lower(ltrim(caller_name, '@')) = $2
     ORDER BY created_at DESC LIMIT 1`,
    [chatId, n]
  );
  return rows[0] ?? null;
}

// A caller's record in this group from the saved peaks (no price lookups): { calls, avgX, hit2, bestX }.
export async function callerRecord(chatId, callerId) {
  const { rows } = await query(
    `SELECT count(*)::int AS calls,
            avg(GREATEST(1, COALESCE(peak_price_usd, price_usd) / NULLIF(price_usd, 0)))::float8 AS avg_x,
            avg(CASE WHEN COALESCE(peak_price_usd, 0) >= 2 * price_usd THEN 1 ELSE 0 END)::float8 AS hit2,
            max(GREATEST(1, COALESCE(peak_price_usd, price_usd) / NULLIF(price_usd, 0)))::float8 AS best_x
     FROM calls WHERE chat_id = $1 AND caller_id = $2 AND price_usd > 0`,
    [chatId, callerId]
  );
  const r = rows[0];
  return r?.calls ? { calls: r.calls, avgX: r.avg_x, hit2: r.hit2, bestX: r.best_x } : null;
}

export async function listUserCalls(chatId, callerId, { limit = 10 } = {}) {
  await ensureCallCols();
  const { rows } = await query(
    `SELECT mint, symbol, caller_id, caller_name, price_usd, mcap_usd, peak_price_usd, created_at, source_url
     FROM calls WHERE chat_id = $1 AND caller_id = $2 ORDER BY created_at DESC LIMIT $3`,
    [chatId, callerId, limit]
  );
  return rows;
}

// Calls from the last `days` days across all groups, for the multiplier announcements. Groups that turned the posts
// off are left out, and so are calls that already reached the last multiple (`maxX`): nothing more to announce.
export async function listLiveCalls({ days = 7, limit = 3000, maxX = 1000 } = {}) {
  await ensureCallCols();
  const { rows } = await query(
    `SELECT c.chat_id, c.mint, c.symbol, c.caller_id, c.caller_name, c.price_usd, c.mcap_usd, c.peak_price_usd, c.created_at,
            c.last_x, c.source_url, c.call_msg_id, s.min_x
     FROM calls c LEFT JOIN call_settings s ON s.chat_id = c.chat_id
     WHERE c.created_at > now() - make_interval(days => $1) AND c.last_x < $3 AND COALESCE(s.milestones_on, true)
     ORDER BY c.created_at DESC LIMIT $2`,
    [days, limit, maxX]
  );
  return rows;
}

// The bot's own card for a call (an X call has no member post to reply to).
export async function setCallMessage(chatId, mint, msgId) {
  await ensureCallCols();
  await query('UPDATE calls SET call_msg_id = $3 WHERE chat_id = $1 AND mint = $2 AND call_msg_id IS NULL', [chatId, mint, msgId]);
}

// A group's multiplier-post setting: { enabled, minX } (on, from 2x, when never set).
export async function getMilestoneSetting(chatId) {
  await ensureCallCols();
  const { rows } = await query('SELECT milestones_on, min_x FROM call_settings WHERE chat_id = $1', [chatId]);
  return { enabled: rows[0]?.milestones_on ?? true, minX: rows[0]?.min_x ?? null };
}

// enabled: true/false; minX: a number, or undefined to keep the current one.
export async function setMilestoneSetting(chatId, { enabled, minX }) {
  await ensureCallCols();
  await query(
    `INSERT INTO call_settings (chat_id, milestones_on, min_x) VALUES ($1, $2, $3)
     ON CONFLICT (chat_id) DO UPDATE SET milestones_on = $2, min_x = CASE WHEN $4 THEN $3 ELSE call_settings.min_x END, updated_at = now()`,
    [chatId, enabled, minX ?? null, minX !== undefined]
  );
  return getMilestoneSetting(chatId);
}

export async function setCallMilestone(chatId, mint, x) {
  await query('UPDATE calls SET last_x = $3 WHERE chat_id = $1 AND mint = $2', [chatId, mint, x]);
}

// Remembers the highest price seen for a call (never goes down).
export async function setCallPeak(chatId, mint, price) {
  await query('UPDATE calls SET peak_price_usd = GREATEST(COALESCE(peak_price_usd, 0), $3) WHERE chat_id = $1 AND mint = $2', [chatId, mint, price]);
}
