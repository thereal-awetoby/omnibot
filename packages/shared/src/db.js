import pg from 'pg';

let pool;

export function getPool() {
  if (!pool) {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  }
  return pool;
}

export const query = (text, params) => getPool().query(text, params);

export async function upsertUser({ id, username }) {
  await query(
    `INSERT INTO users (telegram_id, username) VALUES ($1, $2)
     ON CONFLICT (telegram_id) DO UPDATE SET username = EXCLUDED.username`,
    [id, username ?? null]
  );
}

export async function getTradeWallet(telegramId) {
  const { rows } = await query(
    'SELECT public_key, encrypted_secret, source FROM trade_wallets WHERE telegram_id = $1',
    [telegramId]
  );
  return rows[0] ?? null;
}

export async function saveTradeWallet({ telegramId, publicKey, encryptedSecret, source }) {
  await query(
    `INSERT INTO trade_wallets (telegram_id, public_key, encrypted_secret, source)
     VALUES ($1, $2, $3, $4)`,
    [telegramId, publicKey, encryptedSecret, source]
  );
}
