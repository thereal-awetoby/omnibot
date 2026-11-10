// Phase 3 of the Hybrid Agent plan: Agent Mode (basic).
// Pure prompt-building and response-parsing live here with no network calls, so they're unit-testable;
// decideWithAgent is the one async entry point and takes its AI call as an injectable dependency.
import { esc } from '@omnibot/shared';

export const AGENT_SYSTEM_PROMPT =
  'You are a trading assistant inside a Telegram bot, deciding whether to open a SIMULATED paper position on a ' +
  'newly-called token. No real money ever moves. Follow the user\'s instructions and stay inside the stated limits. ' +
  'Reply with ONLY one line of compact JSON, no markdown, no commentary: ' +
  '{"decision":"buy"|"skip","sizePct":0-100,"reason":"<one short sentence>"}. ' +
  '"sizePct" is how much of the user\'s available balance to risk, as a percentage, if buying (ignored if skipping). ' +
  'If you are unsure or the signal is weak, skip. Keep "reason" under 140 characters.';

// Builds the user-turn prompt: the call's context plus the user's own free-text instructions.
// `instructions` is the strategy's agent_prompt; `hardLimits` describes the guards the agent cannot override
// (shown so its reasoning stays inside them, even though they're also enforced in code afterward).
export function buildAgentPrompt({ instructions, mint, symbol, mcapUsd, liquidityUsd = null, volume24h = null, change24h = null, source = null, balanceUsd, openCount, maxOpen, hardLimits = {} }) {
  const lines = [
    `Token: ${symbol ? '$' + symbol : mint}`,
    `Market cap: ${mcapUsd != null ? '$' + Math.round(mcapUsd).toLocaleString('en-US') : 'unknown'}`,
  ];
  if (liquidityUsd != null) lines.push(`Liquidity: $${Math.round(liquidityUsd).toLocaleString('en-US')}`);
  if (volume24h != null) lines.push(`24h volume: $${Math.round(volume24h).toLocaleString('en-US')}`);
  if (change24h != null) lines.push(`24h price change: ${change24h >= 0 ? '+' : ''}${change24h.toFixed(1)}%`);
  if (source) lines.push(`Signal source: ${source}`);
  lines.push(`Your available paper balance: $${Number(balanceUsd).toFixed(2)}`);
  lines.push(`Open positions: ${openCount} of ${maxOpen} max`);
  if (hardLimits.maxPositionUsd != null) lines.push(`Hard limit: no single trade over $${hardLimits.maxPositionUsd}.`);
  if (hardLimits.allocPct != null) lines.push(`Hard limit: no single trade over ${hardLimits.allocPct}% of balance.`);
  lines.push('', 'User\'s instructions:', instructions?.trim() || '(none given — use your own judgment, favor caution)');
  return lines.join('\n');
}

// Pulls {decision, sizePct, reason} out of raw model text. Tolerates a code fence or stray prose around the
// JSON (small models sometimes add either) but never guesses past what's actually there.
export function parseAgentDecision(text) {
  if (!text || typeof text !== 'string') return null;
  const match = text.match(/\{[^{}]*\}/s);
  if (!match) return null;
  let obj;
  try { obj = JSON.parse(match[0]); } catch { return null; }
  const decision = String(obj.decision ?? '').toLowerCase();
  if (decision !== 'buy' && decision !== 'skip') return null;
  const sizePct = Number(obj.sizePct);
  const reason = typeof obj.reason === 'string' ? obj.reason.trim().slice(0, 200) : '';
  return { decision, sizePct: Number.isFinite(sizePct) ? Math.max(0, Math.min(100, sizePct)) : null, reason: reason || null };
}

// The one async entry point. Fails closed: any missing key, network error, timeout, or unparseable reply
// comes back as a 'skip' with a reason saying so, never a silent 'buy' — matching the plan's own risk principle
// that the agent is constrained, not a blank check.
export async function decideWithAgent({ instructions, call, strategy, apiKey, generateTextImpl, now = Date.now }) {
  if (!apiKey) return { decision: 'skip', sizePct: null, reason: 'agent unavailable (no AI key configured)' };
  const prompt = buildAgentPrompt({
    instructions, ...call, balanceUsd: strategy.balance_usd, openCount: strategy.open_count, maxOpen: strategy.max_open,
    hardLimits: { maxPositionUsd: strategy.max_position_usd ?? null, allocPct: strategy.mode === 'agent' ? null : strategy.alloc_pct ?? null },
  });
  let text = null;
  try {
    text = await generateTextImpl({ system: AGENT_SYSTEM_PROMPT, prompt, apiKey, now: now() });
  } catch (e) {
    return { decision: 'skip', sizePct: null, reason: `agent error: ${e.message}` };
  }
  const parsed = parseAgentDecision(text);
  if (!parsed) return { decision: 'skip', sizePct: null, reason: 'agent gave no usable answer' };
  return parsed;
}

// A short, HTML-safe line describing why a position was opened, for the history/position text and PnL cards.
export function decisionLabel(openMode, decisionReason) {
  if (openMode === 'rules' || !decisionReason) return 'matched your rules';
  return esc(decisionReason);
}
