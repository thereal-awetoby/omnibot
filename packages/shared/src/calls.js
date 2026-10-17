import { query } from './db.js';

// Records the call if nobody in this chat has called the token yet.
// Returns { first: true|false, call } where `call` is the first caller's row.
export async function recordFirstCall({ chatId, mint, symbol, callerId, callerName, priceUsd, mcapUsd }) {
  const ins = await query(
    `INSERT INTO calls (chat_id, mint, symbol, caller_id, caller_name, price_usd, mcap_usd)
     VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (chat_id, mint) DO NOTHING
     RETURNING chat_id, mint, symbol, caller_id, caller_name, price_usd, mcap_usd, created_at`,
    [chatId, mint, symbol ?? null, callerId, callerName ?? null, priceUsd, mcapUsd ?? null]
  );
  if (ins.rows[0]) return { first: true, call: ins.rows[0] };
  return { first: false, call: await getFirstCall(chatId, mint) };
}

export async function getFirstCall(chatId, mint) {
  const { rows } = await query(
    `SELECT chat_id, mint, symbol, caller_id, caller_name, price_usd, mcap_usd, created_at
     FROM calls WHERE chat_id = $1 AND mint = $2`,
    [chatId, mint]
  );
  return rows[0] ?? null;
}

// Calls in this chat from the last `days` days (newest first), for the leaderboard.
export async function listChatCalls(chatId, { days = 30, limit = 300 } = {}) {
  const { rows } = await query(
    `SELECT mint, symbol, caller_id, caller_name, price_usd, mcap_usd, created_at
     FROM calls WHERE chat_id = $1 AND created_at > now() - make_interval(days => $2)
     ORDER BY created_at DESC LIMIT $3`,
    [chatId, days, limit]
  );
  return rows;
}

export async function listUserCalls(chatId, callerId, { limit = 10 } = {}) {
  const { rows } = await query(
    `SELECT mint, symbol, caller_id, caller_name, price_usd, mcap_usd, created_at
     FROM calls WHERE chat_id = $1 AND caller_id = $2 ORDER BY created_at DESC LIMIT $3`,
    [chatId, callerId, limit]
  );
  return rows;
}
