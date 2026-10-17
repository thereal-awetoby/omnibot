// Pure helpers for selling, positions and history. No Telegram, no network, no database.
import { formatUnits } from './jupiter.js';

// Average-cost positions, built by replaying SUCCESSFUL trades oldest-first.
// trades: [{ side, mint, symbol, decimals, sol_lamports, token_raw }] (numbers may be strings).
// Returns Map(mint -> { mint, symbol, decimals, tokens, cost, realized }) as BigInts (lamports / raw units).
export function computePositions(trades) {
  const map = new Map();
  for (const t of trades) {
    const sol = BigInt(t.sol_lamports);
    const tok = BigInt(t.token_raw);
    if (tok <= 0n) continue;
    const p = map.get(t.mint) ?? { mint: t.mint, symbol: null, decimals: t.decimals, tokens: 0n, cost: 0n, realized: 0n };
    if (t.symbol) p.symbol = t.symbol;
    p.decimals = t.decimals;
    if (t.side === 'buy') {
      p.tokens += tok;
      p.cost += sol;
    } else if (p.tokens > 0n) {
      // Selling more than we tracked (bought elsewhere): only the tracked part has a known cost.
      const sold = tok > p.tokens ? p.tokens : tok;
      const proceeds = sold === tok ? sol : (sol * sold) / tok;
      const costRemoved = (p.cost * sold) / p.tokens;
      p.realized += proceeds - costRemoved;
      p.tokens -= sold;
      p.cost -= costRemoved;
    }
    map.set(t.mint, p);
  }
  return map;
}

// If the wallet really holds fewer tokens than we tracked (sent away, sold elsewhere), shrink the
// position and its cost to match. Holding more than tracked changes nothing (no known cost for extras).
export function capToBalance(position, chainRaw) {
  if (chainRaw >= position.tokens) return position;
  const cost = position.tokens > 0n ? (position.cost * chainRaw) / position.tokens : 0n;
  return { ...position, tokens: chainRaw, cost };
}

// "50%" -> half of the balance. "1234.5" -> that many tokens. Returns raw units (BigInt) or throws a friendly Error.
export function parseSellAmount(input, balanceRaw, decimals) {
  const s = String(input ?? '').trim();
  if (balanceRaw <= 0n) throw new Error('You do not hold any of this token in the active wallet.');
  let raw;
  if (s.endsWith('%')) {
    const num = s.slice(0, -1).trim();
    if (!/^\d+(\.\d{1,2})?$/.test(num)) throw new Error('Percent must look like 25% or 12.5%.');
    const hundredths = BigInt(Math.round(Number(num) * 100)); // 100% = 10000
    if (hundredths <= 0n || hundredths > 10000n) throw new Error('Percent must be between 0 and 100.');
    raw = hundredths === 10000n ? balanceRaw : (balanceRaw * hundredths) / 10000n;
  } else {
    const re = new RegExp(`^\\d+(\\.\\d{1,${Math.max(decimals, 1)}})?$`);
    if (!re.test(s)) throw new Error(`Amount must be a number with at most ${decimals} decimals, or a percent like 50%.`);
    const [whole, frac = ''] = s.split('.');
    raw = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0');
    if (raw > balanceRaw) throw new Error('That is more than you hold.');
  }
  if (raw <= 0n) throw new Error('That amount is too small to sell.');
  return raw;
}

// Signed lamports -> "+0.1234" style text (no sign for positive unless withPlus).
export function formatSol(lamports, { withPlus = false, maxFrac = 4 } = {}) {
  const n = BigInt(lamports);
  const abs = n < 0n ? -n : n;
  let body = formatUnits(abs, 9, maxFrac);
  if (body === '0' && abs > 0n) body = '<0.0001';
  const sign = n < 0n ? '-' : withPlus && n > 0n ? '+' : '';
  return `${sign}${body}`;
}

// Profit/loss percent of cost, one decimal. null when cost is 0.
export function pnlPct(pnl, cost) {
  if (BigInt(cost) <= 0n) return null;
  return Number((BigInt(pnl) * 10000n) / BigInt(cost)) / 100;
}

export function formatAge(date, now = Date.now()) {
  const s = Math.max(0, Math.floor((now - new Date(date).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
