import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computePositions, capToBalance, parseSellAmount, formatSol, pnlPct, formatAge } from './positions.js';

const buy = (sol, tok, extra = {}) => ({ side: 'buy', mint: 'M', symbol: 'AAA', decimals: 6, sol_lamports: String(sol), token_raw: String(tok), ...extra });
const sell = (sol, tok, extra = {}) => ({ side: 'sell', mint: 'M', symbol: 'AAA', decimals: 6, sol_lamports: String(sol), token_raw: String(tok), ...extra });

test('buys add up tokens and cost', () => {
  const p = computePositions([buy(100, 1000), buy(300, 1000)]).get('M');
  assert.equal(p.tokens, 2000n);
  assert.equal(p.cost, 400n);
  assert.equal(p.realized, 0n);
});

test('partial sell uses average cost', () => {
  // cost 400 for 2000 tokens; sell 500 tokens (cost removed 100) for 250 -> realized +150
  const p = computePositions([buy(100, 1000), buy(300, 1000), sell(250, 500)]).get('M');
  assert.equal(p.tokens, 1500n);
  assert.equal(p.cost, 300n);
  assert.equal(p.realized, 150n);
});

test('full sell closes the position and books the loss', () => {
  const p = computePositions([buy(1000, 5000), sell(400, 5000)]).get('M');
  assert.equal(p.tokens, 0n);
  assert.equal(p.cost, 0n);
  assert.equal(p.realized, -600n);
});

test('selling more than tracked only counts the tracked part', () => {
  // tracked 1000 tokens cost 100; sells 2000 tokens for 400 -> only half the proceeds (200) count
  const p = computePositions([buy(100, 1000), sell(400, 2000)]).get('M');
  assert.equal(p.tokens, 0n);
  assert.equal(p.realized, 100n);
});

test('sell with nothing tracked is ignored; tokens separate by mint', () => {
  const m = computePositions([sell(50, 10), buy(10, 10, { mint: 'X' })]);
  assert.equal(m.get('M').tokens, 0n);
  assert.equal(m.get('M').realized, 0n);
  assert.equal(m.get('X').tokens, 10n);
});

test('capToBalance shrinks tracked position when the wallet holds less', () => {
  const p = { tokens: 1000n, cost: 400n, realized: 0n };
  assert.deepEqual(capToBalance(p, 250n), { tokens: 250n, cost: 100n, realized: 0n });
  assert.equal(capToBalance(p, 5000n), p);
  assert.equal(capToBalance(p, 0n).cost, 0n);
});

test('parseSellAmount: percents', () => {
  assert.equal(parseSellAmount('50%', 1000n, 6), 500n);
  assert.equal(parseSellAmount('100%', 1234n, 6), 1234n);
  assert.equal(parseSellAmount('12.5%', 1000n, 6), 125n);
  for (const bad of ['0%', '101%', '-5%', 'x%', '1.234%']) assert.throws(() => parseSellAmount(bad, 1000n, 6), undefined, bad);
});

test('parseSellAmount: exact token amounts', () => {
  assert.equal(parseSellAmount('1.5', 5_000_000n, 6), 1_500_000n);
  assert.equal(parseSellAmount('2', 5_000_000n, 6), 2_000_000n);
  assert.throws(() => parseSellAmount('6', 5_000_000n, 6), /more than you hold/);
  assert.throws(() => parseSellAmount('0', 5_000_000n, 6));
  assert.throws(() => parseSellAmount('1.1234567', 5_000_000n, 6));
  assert.throws(() => parseSellAmount('abc', 5_000_000n, 6));
  assert.throws(() => parseSellAmount('50%', 0n, 6), /do not hold/);
  assert.equal(parseSellAmount('3', 10n, 0), 3n); // 0-decimal token
});

test('parseSellAmount: percent of a tiny balance that rounds to zero is rejected', () => {
  assert.throws(() => parseSellAmount('1%', 50n, 6), /too small/);
});

test('formatSol / pnlPct / formatAge', () => {
  assert.equal(formatSol(100_000_000n), '0.1');
  assert.equal(formatSol(-250_000_000n), '-0.25');
  assert.equal(formatSol(1_500_000_000n, { withPlus: true }), '+1.5');
  assert.equal(formatSol(1n), '<0.0001');
  assert.equal(formatSol(0n), '0');
  assert.equal(pnlPct(50n, 100n), 50);
  assert.equal(pnlPct(-25n, 100n), -25);
  assert.equal(pnlPct(1n, 0n), null);
  const now = Date.parse('2026-10-17T12:00:00Z');
  assert.equal(formatAge('2026-10-17T11:59:30Z', now), '30s ago');
  assert.equal(formatAge('2026-10-17T10:00:00Z', now), '2h ago');
  assert.equal(formatAge('2026-10-15T12:00:00Z', now), '2d ago');
});
