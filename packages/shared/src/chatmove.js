import { getPool, query } from './db.js';

// When Telegram turns a small group into a supergroup, the chat gets a NEW id. Everything saved under the old id
// (calls, reminders, followed X accounts) has to move to the new one, or the group looks like it lost its history.

// Chats that have saved calls, newest activity first: [{ chat_id, n, last }]
export async function listCallChats(limit = 15) {
  const { rows } = await query('SELECT chat_id, count(*)::int AS n, max(created_at) AS last FROM calls GROUP BY chat_id ORDER BY max(created_at) DESC LIMIT $1', [limit]);
  return rows;
}

// Moves everything from oldId to newId. If both chats have a call for the same token, the EARLIER call is kept
// (so the original price, and the real multiple, comes back). Returns { calls, duplicates, reminders, follows }.
export async function moveChatData(oldId, newId) {
  const from = String(oldId), to = String(newId);
  if (from === to) return { calls: 0, duplicates: 0, reminders: 0, follows: 0 };
  const c = await getPool().connect();
  try {
    await c.query('BEGIN');
    // same token in both: drop the later one
    const d1 = await c.query('DELETE FROM calls n USING calls o WHERE n.chat_id = $2 AND o.chat_id = $1 AND n.mint = o.mint AND n.created_at >= o.created_at', [from, to]);
    const d2 = await c.query('DELETE FROM calls o USING calls n WHERE o.chat_id = $1 AND n.chat_id = $2 AND o.mint = n.mint', [from, to]);
    const calls = await c.query('UPDATE calls SET chat_id = $2 WHERE chat_id = $1', [from, to]);
    const reminders = await c.query('UPDATE reminders SET chat_id = $2 WHERE chat_id = $1', [from, to]);
    let follows = 0;
    if ((await c.query("SELECT to_regclass('x_follows') AS t")).rows[0].t) {
      await c.query('DELETE FROM x_follows o USING x_follows n WHERE o.chat_id = $1 AND n.chat_id = $2 AND o.handle = n.handle', [from, to]);
      follows = (await c.query('UPDATE x_follows SET chat_id = $2 WHERE chat_id = $1', [from, to])).rowCount;
    }
    await c.query('COMMIT');
    return { calls: calls.rowCount, duplicates: d1.rowCount + d2.rowCount, reminders: reminders.rowCount, follows };
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}
