import pg from 'pg';
import { nextWalletLabel } from './labels.js';

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

// The user's currently active trade wallet (or null).
export async function getTradeWallet(telegramId) {
  const { rows } = await query(
    `SELECT id, label, public_key, encrypted_secret, source
     FROM trade_wallets WHERE telegram_id = $1 AND is_active`,
    [telegramId]
  );
  return rows[0] ?? null;
}

// All of the user's trade wallets (no secrets).
export async function listTradeWallets(telegramId) {
  const { rows } = await query(
    `SELECT id, label, public_key, source, is_active
     FROM trade_wallets WHERE telegram_id = $1 ORDER BY id`,
    [telegramId]
  );
  return rows;
}

async function inTransaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Adds a wallet and makes it the active one. Returns its label ("Wallet 2", ...).
// Throws with code 23505 if this user already has this public key.
export function saveTradeWallet({ telegramId, publicKey, encryptedSecret, source }) {
  return inTransaction(async (c) => {
    const { rows } = await c.query(
      'SELECT label FROM trade_wallets WHERE telegram_id = $1',
      [telegramId]
    );
    const label = nextWalletLabel(rows.map((r) => r.label ?? ''));
    await c.query('UPDATE trade_wallets SET is_active = false WHERE telegram_id = $1', [telegramId]);
    await c.query(
      `INSERT INTO trade_wallets (telegram_id, public_key, encrypted_secret, source, label, is_active)
       VALUES ($1, $2, $3, $4, $5, true)`,
      [telegramId, publicKey, encryptedSecret, source, label]
    );
    return label;
  });
}

// Switches the active wallet. Returns false if the wallet isn't this user's.
export function setActiveWallet(telegramId, walletId) {
  return inTransaction(async (c) => {
    const found = await c.query(
      'SELECT 1 FROM trade_wallets WHERE id = $1 AND telegram_id = $2',
      [walletId, telegramId]
    );
    if (found.rowCount === 0) return false;
    await c.query('UPDATE trade_wallets SET is_active = false WHERE telegram_id = $1', [telegramId]);
    await c.query('UPDATE trade_wallets SET is_active = true WHERE id = $1', [walletId]);
    return true;
  });
}

// Renames one of the user's wallets. Returns false if it isn't theirs.
// Throws with code 23505 if the user already has a wallet with that name.
export async function renameWallet(telegramId, walletId, label) {
  const r = await query(
    'UPDATE trade_wallets SET label = $3 WHERE id = $2 AND telegram_id = $1',
    [telegramId, walletId, label]
  );
  return r.rowCount > 0;
}
