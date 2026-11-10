// Paper trading storage: a virtual balance, one strategy per user, and the positions it opens.
// Phase 1 of the Hybrid Agent plan: rule-based only, personal (DM) use. No real money ever moves.
// Phase 3 adds Agent Mode: a strategy can hand some or all of the buy/skip decision to an LLM,
// constrained by hard risk limits (max_position_usd, daily_loss_limit_pct) that apply in every mode.
import { query } from './db.js';

export const PAPER_START_USD = Number(process.env.PAPER_START_USD) || 500;

let ready = null;
export function ensurePaperTables() {
  ready ??= (async () => {
    await query(`CREATE TABLE IF NOT EXISTS paper_accounts (
      telegram_id   BIGINT PRIMARY KEY REFERENCES users(telegram_id),
      balance_usd   NUMERIC NOT NULL,
      realized_usd  NUMERIC NOT NULL DEFAULT 0,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    await query(`CREATE TABLE IF NOT EXISTS paper_strategy (
      telegram_id   BIGINT PRIMARY KEY REFERENCES users(telegram_id),
      enabled       BOOLEAN NOT NULL DEFAULT false,
      min_mcap_usd  NUMERIC,
      max_mcap_usd  NUMERIC,
      alloc_pct     NUMERIC NOT NULL DEFAULT 5,
      tp_pct        NUMERIC NOT NULL DEFAULT 100,
      sl_pct        NUMERIC NOT NULL DEFAULT 40,
      max_open      INT NOT NULL DEFAULT 3,
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    await query(`CREATE TABLE IF NOT EXISTS paper_positions (
      id            SERIAL PRIMARY KEY,
      telegram_id   BIGINT NOT NULL REFERENCES users(telegram_id),
      mint          TEXT NOT NULL,
      symbol        TEXT,
      entry_price_usd NUMERIC NOT NULL,
      entry_mcap_usd  NUMERIC,
      size_usd      NUMERIC NOT NULL,
      status        TEXT NOT NULL DEFAULT 'open',
      exit_price_usd  NUMERIC,
      exit_mcap_usd   NUMERIC,
      close_reason  TEXT,
      pnl_usd       NUMERIC,
      pnl_pct       NUMERIC,
      opened_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      closed_at     TIMESTAMPTZ
    )`);
    await query('CREATE INDEX IF NOT EXISTS paper_positions_open_idx ON paper_positions (status) WHERE status = \'open\'');
    // Phase 3: Agent Mode. mode picks who decides (rules/agent/hybrid); agent_prompt is the user's free-text
    // instructions; max_position_usd and daily_loss_limit_pct are hard risk guards that apply in every mode.
    await query("ALTER TABLE paper_strategy ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'rules'");
    await query('ALTER TABLE paper_strategy ADD COLUMN IF NOT EXISTS agent_prompt TEXT');
    await query('ALTER TABLE paper_strategy ADD COLUMN IF NOT EXISTS max_position_usd NUMERIC');
    await query('ALTER TABLE paper_strategy ADD COLUMN IF NOT EXISTS daily_loss_limit_pct NUMERIC');
    // Transparency (plan section 7): every position records why it was opened — a rule match or the
    // agent's own short reasoning — plus which mode opened it, shown back to the user later.
    await query("ALTER TABLE paper_positions ADD COLUMN IF NOT EXISTS open_mode TEXT NOT NULL DEFAULT 'rules'");
    await query('ALTER TABLE paper_positions ADD COLUMN IF NOT EXISTS decision_reason TEXT');
  })().catch((e) => { ready = null; throw e; });
  return ready;
}

export async function getPaperAccount(telegramId) {
  await ensurePaperTables();
  const { rows } = await query('SELECT telegram_id, balance_usd, realized_usd FROM paper_accounts WHERE telegram_id = $1', [telegramId]);
  return rows[0] ?? null;
}

// Creates the account (with the starting balance) and a disabled default strategy, if the user has neither yet.
export async function ensurePaperAccount(telegramId) {
  await ensurePaperTables();
  let acct = await getPaperAccount(telegramId);
  if (!acct) {
    const { rows } = await query(
      'INSERT INTO paper_accounts (telegram_id, balance_usd) VALUES ($1, $2) ON CONFLICT (telegram_id) DO NOTHING RETURNING telegram_id, balance_usd, realized_usd',
      [telegramId, PAPER_START_USD]);
    acct = rows[0] ?? await getPaperAccount(telegramId);
  }
  await query('INSERT INTO paper_strategy (telegram_id) VALUES ($1) ON CONFLICT (telegram_id) DO NOTHING', [telegramId]);
  return acct;
}

const STRATEGY_COLUMNS = 'telegram_id, enabled, min_mcap_usd, max_mcap_usd, alloc_pct, tp_pct, sl_pct, max_open, ' +
  'mode, agent_prompt, max_position_usd, daily_loss_limit_pct';

export async function getStrategy(telegramId) {
  await ensurePaperTables();
  const { rows } = await query(`SELECT ${STRATEGY_COLUMNS} FROM paper_strategy WHERE telegram_id = $1`, [telegramId]);
  return rows[0] ?? null;
}

const STRATEGY_FIELDS = [
  'enabled', 'min_mcap_usd', 'max_mcap_usd', 'alloc_pct', 'tp_pct', 'sl_pct', 'max_open',
  'mode', 'agent_prompt', 'max_position_usd', 'daily_loss_limit_pct',
];
export async function updateStrategy(telegramId, patch) {
  await ensurePaperTables();
  const keys = Object.keys(patch).filter((k) => STRATEGY_FIELDS.includes(k));
  if (keys.length === 0) return getStrategy(telegramId);
  const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
  await query(`UPDATE paper_strategy SET ${sets}, updated_at = now() WHERE telegram_id = $1`, [telegramId, ...keys.map((k) => patch[k])]);
  return getStrategy(telegramId);
}

export async function listStrategiesByIds(ids) {
  await ensurePaperTables();
  const uniq = [...new Set(ids)];
  if (uniq.length === 0) return new Map();
  const { rows } = await query(`SELECT ${STRATEGY_COLUMNS} FROM paper_strategy WHERE telegram_id = ANY($1)`, [uniq]);
  return new Map(rows.map((r) => [String(r.telegram_id), r]));
}

// Every user with an enabled strategy, for matching against a new call.
export async function listEnabledStrategies() {
  await ensurePaperTables();
  const { rows } = await query(
    `SELECT s.telegram_id, s.enabled, s.min_mcap_usd, s.max_mcap_usd, s.alloc_pct, s.tp_pct, s.sl_pct, s.max_open,
       s.mode, s.agent_prompt, s.max_position_usd, s.daily_loss_limit_pct, a.balance_usd,
       (SELECT count(*) FROM paper_positions p WHERE p.telegram_id = s.telegram_id AND p.status = 'open') AS open_count
     FROM paper_strategy s JOIN paper_accounts a ON a.telegram_id = s.telegram_id WHERE s.enabled = true`);
  return rows;
}

// Realized PnL since the start of today (UTC), for the daily-drawdown guard — section 7 of the plan:
// hard risk limits apply even in pure Agent Mode, and this is the one that isn't a per-trade cap.
export async function getRealizedPnlToday(telegramId) {
  await ensurePaperTables();
  const { rows } = await query(
    "SELECT COALESCE(SUM(pnl_usd), 0) AS pnl FROM paper_positions WHERE telegram_id = $1 AND status = 'closed' AND closed_at >= date_trunc('day', now())",
    [telegramId]);
  return Number(rows[0]?.pnl ?? 0);
}

export async function hasOpenPosition(telegramId, mint) {
  await ensurePaperTables();
  const { rows } = await query(
    "SELECT 1 FROM paper_positions WHERE telegram_id = $1 AND mint = $2 AND status = 'open' LIMIT 1", [telegramId, mint]);
  return rows.length > 0;
}

// Opens a position and debits the account balance in one go.
// openMode/decisionReason are the transparency record (plan section 7): how this trade was decided
// ('rules' or 'agent'/'hybrid') and, in a sentence, why — a rule match or the agent's own reasoning.
export async function openPosition({ telegramId, mint, symbol, entryPriceUsd, entryMcapUsd, sizeUsd, openMode = 'rules', decisionReason = null }) {
  await ensurePaperTables();
  const { rows } = await query(
    `INSERT INTO paper_positions (telegram_id, mint, symbol, entry_price_usd, entry_mcap_usd, size_usd, open_mode, decision_reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [telegramId, mint, symbol ?? null, entryPriceUsd, entryMcapUsd ?? null, sizeUsd, openMode, decisionReason]);
  await query('UPDATE paper_accounts SET balance_usd = balance_usd - $2 WHERE telegram_id = $1', [telegramId, sizeUsd]);
  return rows[0].id;
}

// One position by id, scoped to its owner (used for sharing/recapping a specific trade).
export async function getPaperPosition(telegramId, id) {
  await ensurePaperTables();
  const { rows } = await query('SELECT * FROM paper_positions WHERE telegram_id = $1 AND id = $2', [telegramId, id]);
  return rows[0] ?? null;
}

export async function listOpenPositions(telegramId = null) {
  await ensurePaperTables();
  const { rows } = telegramId
    ? await query("SELECT * FROM paper_positions WHERE telegram_id = $1 AND status = 'open' ORDER BY id", [telegramId])
    : await query("SELECT * FROM paper_positions WHERE status = 'open' ORDER BY id");
  return rows;
}

export async function listClosedPositions(telegramId, { limit = 10 } = {}) {
  await ensurePaperTables();
  const { rows } = await query(
    "SELECT * FROM paper_positions WHERE telegram_id = $1 AND status = 'closed' ORDER BY closed_at DESC LIMIT $2",
    [telegramId, limit]);
  return rows;
}

// Closes a position, credits the payout back to the balance, and records realized PnL.
export async function closePosition(id, { exitPriceUsd, exitMcapUsd, reason, payoutUsd, pnlUsd, pnlPct }) {
  await ensurePaperTables();
  const { rows } = await query(
    `UPDATE paper_positions SET status = 'closed', exit_price_usd = $2, exit_mcap_usd = $3, close_reason = $4,
       pnl_usd = $5, pnl_pct = $6, closed_at = now() WHERE id = $1 AND status = 'open' RETURNING telegram_id`,
    [id, exitPriceUsd, exitMcapUsd ?? null, reason, pnlUsd, pnlPct]);
  if (!rows[0]) return null; // already closed (e.g. the loop and a manual close raced): do nothing twice
  await query('UPDATE paper_accounts SET balance_usd = balance_usd + $2, realized_usd = realized_usd + $3 WHERE telegram_id = $1',
    [rows[0].telegram_id, payoutUsd, pnlUsd]);
  return rows[0].telegram_id;
}
