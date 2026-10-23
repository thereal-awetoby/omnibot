import { query } from './db.js';

// Followed X accounts per group: when a followed account posts a token address, the group gets it as a call.
export const MAX_X_FOLLOWS = 10;

let ready = null;
// The tables are created on first use, so no separate migration step is needed. Safe to call many times.
export function ensureXTables() {
  if (!ready) {
    ready = (async () => {
      await query(`CREATE TABLE IF NOT EXISTS x_follows (
        chat_id BIGINT NOT NULL,
        handle TEXT NOT NULL,
        added_by BIGINT,
        added_by_name TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_tweet_id TEXT,
        PRIMARY KEY (chat_id, handle)
      )`);
      await query(`CREATE TABLE IF NOT EXISTS x_handles (
        handle TEXT PRIMARY KEY,
        polled_at TIMESTAMPTZ,
        ok_at TIMESTAMPTZ,
        last_error TEXT,
        via TEXT,
        newest_tweet_id TEXT,
        newest_tweet_at TIMESTAMPTZ
      )`);
      // Filled by the Omni X worker (apps/x-worker), which is the only program that talks to X.
      await query(`CREATE TABLE IF NOT EXISTS x_feed (
        handle TEXT NOT NULL,
        tweet_id TEXT NOT NULL,
        text TEXT NOT NULL DEFAULT '',
        urls TEXT[] NOT NULL DEFAULT '{}',
        created_at TIMESTAMPTZ,
        is_retweet BOOLEAN NOT NULL DEFAULT false,
        seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (handle, tweet_id)
      )`);
      await query(`CREATE TABLE IF NOT EXISTS x_feed_status (
        handle TEXT PRIMARY KEY,
        checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        ok BOOLEAN NOT NULL DEFAULT false,
        error TEXT
      )`);
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

export async function addXFollow({ chatId, handle, addedBy, addedByName }) {
  await ensureXTables();
  const { rows } = await query('SELECT count(*)::int AS n FROM x_follows WHERE chat_id = $1', [chatId]);
  const had = await query('SELECT 1 FROM x_follows WHERE chat_id = $1 AND handle = $2', [chatId, handle]);
  if (had.rowCount) return 'exists';
  if (rows[0].n >= MAX_X_FOLLOWS) return 'full';
  await query('INSERT INTO x_follows (chat_id, handle, added_by, added_by_name) VALUES ($1, $2, $3, $4)', [chatId, handle, addedBy ?? null, addedByName ?? null]);
  await query('INSERT INTO x_handles (handle) VALUES ($1) ON CONFLICT DO NOTHING', [handle]);
  return 'added';
}
export async function removeXFollow(chatId, handle) {
  await ensureXTables();
  const r = await query('DELETE FROM x_follows WHERE chat_id = $1 AND handle = $2', [chatId, handle]);
  return r.rowCount > 0;
}
// The followed accounts of one chat, with how the last check went.
export async function listXFollows(chatId) {
  await ensureXTables();
  const { rows } = await query(
    `SELECT f.handle, f.added_by_name, f.created_at, h.polled_at, h.ok_at, h.last_error, h.via, h.newest_tweet_at
     FROM x_follows f LEFT JOIN x_handles h ON h.handle = f.handle WHERE f.chat_id = $1 ORDER BY f.created_at`, [chatId]);
  return rows;
}
// Every followed account with the chats that follow it: [{ handle, polled_at, chats: [{ chat_id, last_tweet_id }] }]
export async function listAllXFollows() {
  await ensureXTables();
  const { rows } = await query(
    `SELECT f.chat_id, f.handle, f.last_tweet_id, h.polled_at FROM x_follows f LEFT JOIN x_handles h ON h.handle = f.handle`);
  const by = new Map();
  for (const r of rows) {
    if (!by.has(r.handle)) by.set(r.handle, { handle: r.handle, polled_at: r.polled_at, chats: [] });
    by.get(r.handle).chats.push({ chat_id: r.chat_id, last_tweet_id: r.last_tweet_id });
  }
  return [...by.values()];
}
export async function setXCursor(chatId, handle, tweetId) {
  await query('UPDATE x_follows SET last_tweet_id = $3 WHERE chat_id = $1 AND handle = $2', [chatId, handle, String(tweetId)]);
}
export async function setXPoll({ handle, ok, error = null, via = null, newestId = null, newestAt = null }) {
  await ensureXTables();
  await query(
    `INSERT INTO x_handles (handle, polled_at, ok_at, last_error, via, newest_tweet_id, newest_tweet_at)
     VALUES ($1, now(), CASE WHEN $2 THEN now() END, $3, $4, $5, $6)
     ON CONFLICT (handle) DO UPDATE SET polled_at = now(),
       ok_at = CASE WHEN $2 THEN now() ELSE x_handles.ok_at END,
       last_error = $3, via = COALESCE($4, x_handles.via),
       newest_tweet_id = COALESCE($5, x_handles.newest_tweet_id), newest_tweet_at = COALESCE($6, x_handles.newest_tweet_at)`,
    [handle, Boolean(ok), ok ? null : String(error ?? 'unreadable').slice(0, 200), via, newestId ? String(newestId) : null, newestAt]
  );
}
