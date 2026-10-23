import { query } from './db.js';

// Records the call if nobody in this chat has called the token yet.
// Returns { first: true|false, call } where `call` is the first caller's row.
// calls.source_url: the post a call came from (set for calls made by a followed X account). Added on first use.
let colReady = null;
const ensureCallCols = () => (colReady ??= query('ALTER TABLE calls ADD COLUMN IF NOT EXISTS source_url TEXT').catch((e) => { colReady = null; throw e; }));

export async function recordFirstCall({ chatId, mint, symbol, callerId, callerName, priceUsd, mcapUsd, sourceUrl = null }) {
  await ensureCallCols();
  const ins = await query(
    `INSERT INTO calls (chat_id, mint, symbol, caller_id, caller_name, price_usd, mcap_usd, source_url)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (chat_id, mint) DO NOTHING
     RETURNING chat_id, mint, symbol, caller_id, caller_name, price_usd, mcap_usd, peak_price_usd, created_at, source_url`,
    [chatId, mint, symbol ?? null, callerId, callerName ?? null, priceUsd, mcapUsd ?? null, sourceUrl]
  );
  if (ins.rows[0]) return { first: true, call: ins.rows[0] };
  return { first: false, call: await getFirstCall(chatId, mint) };
}

export async function getFirstCall(chatId, mint) {
  await ensureCallCols();
  const { rows } = await query(
    `SELECT chat_id, mint, symbol, caller_id, caller_name, price_usd, mcap_usd, peak_price_usd, created_at, source_url
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

export async function listUserCalls(chatId, callerId, { limit = 10 } = {}) {
  await ensureCallCols();
  const { rows } = await query(
    `SELECT mint, symbol, caller_id, caller_name, price_usd, mcap_usd, peak_price_usd, created_at, source_url
     FROM calls WHERE chat_id = $1 AND caller_id = $2 ORDER BY created_at DESC LIMIT $3`,
    [chatId, callerId, limit]
  );
  return rows;
}

// Calls from the last `days` days across all groups, for the multiplier announcements.
export async function listLiveCalls({ days = 7, limit = 1000 } = {}) {
  await ensureCallCols();
  const { rows } = await query(
    `SELECT chat_id, mint, symbol, caller_id, caller_name, price_usd, mcap_usd, peak_price_usd, created_at, last_x, source_url
     FROM calls WHERE created_at > now() - make_interval(days => $1) ORDER BY created_at DESC LIMIT $2`,
    [days, limit]
  );
  return rows;
}

export async function setCallMilestone(chatId, mint, x) {
  await query('UPDATE calls SET last_x = $3 WHERE chat_id = $1 AND mint = $2', [chatId, mint, x]);
}

// Remembers the highest price seen for a call (never goes down).
export async function setCallPeak(chatId, mint, price) {
  await query('UPDATE calls SET peak_price_usd = GREATEST(COALESCE(peak_price_usd, 0), $3) WHERE chat_id = $1 AND mint = $2', [chatId, mint, price]);
}
