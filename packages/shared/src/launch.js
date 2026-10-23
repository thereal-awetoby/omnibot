// Omni Launch Bot storage: its own wallet (separate from the Trade bot wallet) and the list of launches.
import { query } from './db.js';

let ready = null;
export function ensureLaunchTables() {
  ready ??= (async () => {
    await query(`CREATE TABLE IF NOT EXISTS launch_wallets (
      id SERIAL PRIMARY KEY,
      telegram_id BIGINT NOT NULL UNIQUE REFERENCES users(telegram_id),
      public_key TEXT NOT NULL,
      encrypted_secret TEXT NOT NULL,
      source TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    await query(`CREATE TABLE IF NOT EXISTS launches (
      id SERIAL PRIMARY KEY,
      telegram_id BIGINT NOT NULL REFERENCES users(telegram_id),
      name TEXT NOT NULL,
      symbol TEXT NOT NULL,
      description TEXT,
      twitter TEXT, telegram TEXT, website TEXT,
      metadata_uri TEXT,
      dev_buy_lamports BIGINT NOT NULL DEFAULT 0,
      mint TEXT,
      signature TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  })().catch((e) => { ready = null; throw e; });
  return ready;
}

export async function getLaunchWallet(telegramId) {
  await ensureLaunchTables();
  const { rows } = await query(
    'SELECT id, public_key, encrypted_secret, source FROM launch_wallets WHERE telegram_id = $1', [telegramId]);
  return rows[0] ?? null;
}

// One wallet per user. Throws with code 23505 if they already have one.
export async function saveLaunchWallet({ telegramId, publicKey, encryptedSecret, source }) {
  await ensureLaunchTables();
  await query(
    'INSERT INTO launch_wallets (telegram_id, public_key, encrypted_secret, source) VALUES ($1,$2,$3,$4)',
    [telegramId, publicKey, encryptedSecret, source]);
}

export async function createLaunch({ telegramId, name, symbol, description, twitter, telegram, website, devBuyLamports }) {
  await ensureLaunchTables();
  const { rows } = await query(
    `INSERT INTO launches (telegram_id, name, symbol, description, twitter, telegram, website, dev_buy_lamports)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [telegramId, name, symbol, description ?? null, twitter ?? null, telegram ?? null, website ?? null, String(devBuyLamports)]);
  return rows[0].id;
}

// status: 'success' | 'failed' | 'unknown' (sent but not confirmed: it may have landed)
export async function finishLaunch(id, { status, mint = null, signature = null, metadataUri = null, error = null }) {
  await query(
    `UPDATE launches SET status = $2, mint = COALESCE($3, mint), signature = COALESCE($4, signature),
       metadata_uri = COALESCE($5, metadata_uri), error = $6 WHERE id = $1`,
    [id, status, mint, signature, metadataUri, error]);
}

export async function listLaunches(telegramId, { limit = 8 } = {}) {
  await ensureLaunchTables();
  const { rows } = await query(
    `SELECT id, name, symbol, mint, signature, status, dev_buy_lamports, created_at
     FROM launches WHERE telegram_id = $1 ORDER BY id DESC LIMIT $2`, [telegramId, limit]);
  return rows;
}
