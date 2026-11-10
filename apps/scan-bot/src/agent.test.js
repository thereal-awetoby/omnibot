import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAgentPrompt, parseAgentDecision, decideWithAgent, decisionLabel, AGENT_SYSTEM_PROMPT } from './agent.js';

test('buildAgentPrompt includes the call context, limits and the user\'s own instructions', () => {
  const prompt = buildAgentPrompt({
    instructions: 'Only narrative plays, under 50k mcap.',
    mint: 'Aa1', symbol: 'DOG', mcapUsd: 25000, liquidityUsd: 5000, volume24h: 12000, change24h: 12.5,
    source: 'group call', balanceUsd: 480, openCount: 1, maxOpen: 3, hardLimits: { maxPositionUsd: 50, allocPct: 5 },
  });
  assert.match(prompt, /\$DOG/);
  assert.match(prompt, /\$25,000/);
  assert.match(prompt, /group call/);
  assert.match(prompt, /no single trade over \$50/);
  assert.match(prompt, /no single trade over 5%/);
  assert.match(prompt, /Only narrative plays, under 50k mcap\./);
});

test('buildAgentPrompt falls back to a neutral line when no instructions are set', () => {
  const prompt = buildAgentPrompt({ instructions: null, mint: 'Aa1', symbol: 'DOG', mcapUsd: 1000, balanceUsd: 100, openCount: 0, maxOpen: 3 });
  assert.match(prompt, /use your own judgment, favor caution/);
});

test('parseAgentDecision reads clean JSON', () => {
  assert.deepEqual(parseAgentDecision('{"decision":"buy","sizePct":5,"reason":"Strong momentum"}'),
    { decision: 'buy', sizePct: 5, reason: 'Strong momentum', detail: null });
  assert.deepEqual(parseAgentDecision('{"decision":"skip","sizePct":0,"reason":"Too thin"}'),
    { decision: 'skip', sizePct: 0, reason: 'Too thin', detail: null });
});

// Phase 4: the agent can flag a token without risking paper capital.
test('parseAgentDecision reads a "call" decision (no trade, just a heads-up)', () => {
  assert.deepEqual(parseAgentDecision('{"decision":"call","sizePct":0,"reason":"Interesting but too early to size in"}'),
    { decision: 'call', sizePct: 0, reason: 'Interesting but too early to size in', detail: null });
});

// Deeper agent logging: a "detail" field is kept separately from the short, always-shown "reason".
test('parseAgentDecision reads the fuller "detail" field when the model gives one', () => {
  const r = parseAgentDecision('{"decision":"buy","sizePct":5,"reason":"Strong setup","detail":"Volume tripled in the last hour and the caller has a good track record on similar launches."}');
  assert.equal(r.reason, 'Strong setup');
  assert.equal(r.detail, 'Volume tripled in the last hour and the caller has a good track record on similar launches.');
});

test('parseAgentDecision caps the detail length too', () => {
  const r = parseAgentDecision(`{"decision":"buy","sizePct":5,"reason":"x","detail":"${'y'.repeat(2000)}"}`);
  assert.equal(r.detail.length, 1000);
});

test('parseAgentDecision tolerates a markdown fence or stray prose around the JSON', () => {
  const r = parseAgentDecision('Sure, here you go:\n```json\n{"decision": "buy", "sizePct": 10, "reason": "ok"}\n```\nHope that helps!');
  assert.equal(r.decision, 'buy');
  assert.equal(r.sizePct, 10);
});

test('parseAgentDecision rejects garbage rather than guessing', () => {
  assert.equal(parseAgentDecision(null), null);
  assert.equal(parseAgentDecision(''), null);
  assert.equal(parseAgentDecision('no json here'), null);
  assert.equal(parseAgentDecision('{"decision":"maybe"}'), null);
  assert.equal(parseAgentDecision('{"nope":1}'), null);
});

test('parseAgentDecision clamps sizePct into 0-100 and caps the reason length', () => {
  const r = parseAgentDecision(`{"decision":"buy","sizePct":500,"reason":"${'x'.repeat(300)}"}`);
  assert.equal(r.sizePct, 100);
  assert.equal(r.reason.length, 200);
});

test('decideWithAgent fails closed with no API key', async () => {
  const r = await decideWithAgent({ instructions: null, call: { mint: 'x' }, strategy: { balance_usd: 100, open_count: 0, max_open: 3 }, apiKey: null, generateTextImpl: async () => { throw new Error('should not be called'); } });
  assert.equal(r.decision, 'skip');
  assert.match(r.reason, /no AI key/);
});

test('decideWithAgent returns the parsed decision on a good reply', async () => {
  const r = await decideWithAgent({
    instructions: 'Buy anything with volume.', call: { mint: 'x', symbol: 'DOG', mcapUsd: 5000 },
    strategy: { balance_usd: 200, open_count: 0, max_open: 3 }, apiKey: 'fake-key',
    generateTextImpl: async ({ system, prompt }) => { assert.equal(system, AGENT_SYSTEM_PROMPT); assert.match(prompt, /\$DOG/); return '{"decision":"buy","sizePct":8,"reason":"Volume picking up"}'; },
  });
  assert.deepEqual(r, { decision: 'buy', sizePct: 8, reason: 'Volume picking up', detail: null });
});

test('decideWithAgent passes through a "call" decision unchanged', async () => {
  const r = await decideWithAgent({
    instructions: null, call: { mint: 'x', symbol: 'DOG', mcapUsd: 5000 },
    strategy: { balance_usd: 200, open_count: 0, max_open: 3 }, apiKey: 'fake-key',
    generateTextImpl: async () => '{"decision":"call","sizePct":0,"reason":"Worth watching, not buying yet"}',
  });
  assert.deepEqual(r, { decision: 'call', sizePct: 0, reason: 'Worth watching, not buying yet', detail: null });
});

test('decideWithAgent fails closed on a network/provider error', async () => {
  const r = await decideWithAgent({ instructions: null, call: { mint: 'x' }, strategy: { balance_usd: 100, open_count: 0, max_open: 3 }, apiKey: 'fake-key', generateTextImpl: async () => { throw new Error('timeout'); } });
  assert.equal(r.decision, 'skip');
  assert.match(r.reason, /agent error/);
});

test('decideWithAgent fails closed on an unparseable reply (never a silent buy)', async () => {
  const r = await decideWithAgent({ instructions: null, call: { mint: 'x' }, strategy: { balance_usd: 100, open_count: 0, max_open: 3 }, apiKey: 'fake-key', generateTextImpl: async () => null });
  assert.equal(r.decision, 'skip');
  assert.match(r.reason, /no usable answer/);
});

test('decisionLabel', () => {
  assert.equal(decisionLabel('rules', null), 'matched your rules');
  assert.equal(decisionLabel('agent', null), 'matched your rules'); // no reason recorded: fall back rather than show blank
  assert.equal(decisionLabel('agent', 'Strong narrative and volume'), 'Strong narrative and volume');
  assert.equal(decisionLabel('agent', 'Tom & Jerry style pump'), 'Tom &amp; Jerry style pump'); // HTML-escaped for the Telegram message
});
