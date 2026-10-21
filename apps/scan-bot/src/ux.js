import { esc, formatUsd } from '@omnibot/shared';
import { formatDuration, formatPriceCard } from './scan.js';

// One look for every answer: a bold title, a monospace tree for the numbers, a quote block for lists.
export const tree = (rows) => {
  const w = Math.max(...rows.map(([k]) => String(k).length));
  return rows.map(([k, v], i) => `${i === rows.length - 1 ? '└' : '├'} ${String(k).padEnd(w)}  ${v}`).join('\n');
};
const pre = (rows) => `<pre>${esc(tree(rows))}</pre>`;
export const fmtX = (x) => (x >= 10 ? x.toFixed(0) : x.toFixed(2)) + 'x';
const name = (n) => esc(String(n ?? 'someone').replace(/^@/, '').slice(0, 24));
const sym = (c) => (c.symbol ? `$${c.symbol}` : `${String(c.mint).slice(0, 4)}…`);
const ago = (ms) => formatDuration(ms) ?? 'now';

export function buildFcText({ call, nowMcap, roi, athX, now = Date.now() }) {
  const rows = [
    ['Caller', `${String(call.caller_name ?? 'someone').replace(/^@/, '')}  (${ago(now - new Date(call.created_at).getTime())} ago)`],
    ['Called', formatUsd(call.mcap_usd)],
    ['Now', formatUsd(nowMcap)],
    ['ROI', roi ? fmtX(roi) : 'n/a'],
    ['ATH', athX ? fmtX(athX) : 'n/a'],
  ];
  return `🥇 <b>First Call</b> · ${esc(sym(call))}\n${pre(rows)}`;
}

// rows: group board rows (newest first) with x = highest multiple reached
export function buildLastText(rows, now = Date.now()) {
  if (!rows.length) return '🕘 <b>Last calls</b>\n\nNo calls in this group yet.';
  const best = rows.reduce((a, b) => (b.x > a.x ? b : a));
  const hit = rows.filter((r) => r.x >= 2).length / rows.length;
  const avg = rows.reduce((s, r) => s + r.x, 0) / rows.length;
  const stats = pre([['Calls', rows.length], ['Avg ATH', fmtX(avg)], ['Best', `${sym(best)} ${fmtX(best.x)}`], ['Hit 2x', `${Math.round(hit * 100)}%`]]);
  const list = rows.map((r, i) => `${i + 1}. <a href="https://dexscreener.com/solana/${r.mint}"><b>${esc(sym(r))}</b></a> @ ${formatUsd(r.mcap_usd)} · ${ago(now - new Date(r.created_at).getTime())}\n   └ ATH ${fmtX(r.x)} · ${name(r.caller_name)}`);
  return `🕘 <b>Last ${rows.length} calls</b>\n${stats}\n<blockquote>${list.join('\n')}</blockquote>`;
}

// targets: [{ label, value }]
export function buildTargetSetText({ symbol, nowLabel, targets, inGroup = false, botUser = null, refreshed = false }) {
  const rows = [['Now', nowLabel], ...targets.map((t) => [t.label, t.value])];
  const note = inGroup && botUser ? `\n<i>Alerts arrive in a private chat with @${esc(botUser)}. Open it and press Start once.</i>` : '';
  return `🎯 <b>Alerts set</b> · ${esc(symbol)}\n${pre(rows)}${refreshed ? '\n<i>Base price reset to now.</i>' : ''}${note}\n<i>/targets · /untarget</i>`;
}
export function buildTargetsText(groups) {
  if (!groups.length) return '🎯 <b>Your alerts</b>\n\nNone yet. Try <code>/target &lt;address&gt; 3x 5x</code>';
  const blocks = groups.map((g) => `<b>${esc(g.symbol)}</b>\n${pre([['From', g.from], ...g.targets.map((t) => [t.label, t.value])])}`);
  return `🎯 <b>Your alerts</b>\n${blocks.join('\n')}\n<i>/untarget &lt;address&gt; · /untarget all</i>`;
}
export function buildTargetHitText({ symbol, label, nowLabel, since }) {
  return `🎯 <b>${esc(symbol)}</b> reached <b>${esc(label)}</b>\n${pre([['Now', nowLabel], ['Since set', since]])}`;
}

export function buildReminderSetText({ id, delay, at, body, here }) {
  return `⏰ <b>Reminder set</b>\n${pre([['In', delay], ['At', at], ['Where', here ? 'this chat' : 'private'], ['Note', body.slice(0, 80)]])}\n<i>ID ${id} · /listreminders</i>`;
}
export function buildRemindersText(rows, fmt) {
  if (!rows.length) return '⏰ <b>Your reminders</b>\n\nNone. Try <code>/remindme 1h check the chart</code>';
  return `⏰ <b>Your reminders</b>\n<blockquote>${rows.map((r) => `${r.id} · ${fmt(r.fire_at)}\n   └ ${esc(r.body.slice(0, 60))}`).join('\n')}</blockquote>\n<i>Tap a button to cancel.</i>`;
}
export function buildReminderFiredText({ body, who, group }) {
  return `⏰ <b>#REMINDER</b>\n${esc(body)}${group ? `\n<i>by ${esc(who ?? 'someone')}</i>` : ''}`;
}

export function buildConvertText({ label, value, price, mcap, tokens = null }) {
  const rows = [['Value', value], ['Price', price], ['MCap', mcap]];
  if (tokens) rows.splice(1, 0, ['Tokens', tokens]);
  return `💱 <b>${esc(label)}</b>\n${pre(rows)}`;
}

export function buildEpochText(d, now = Date.now()) {
  const diff = d.getTime() - now;
  return `🕒 <b>Unix time</b>\n${pre([['UTC', d.toISOString().replace('T', ' ').slice(0, 19)], ['Unix', Math.floor(d.getTime() / 1000)], [diff <= 0 ? 'Ago' : 'In', ago(Math.abs(diff))]])}`;
}
export const buildIdText = (title, id) => `🪪 <b>${esc(title)}</b>\n${pre([['ID', id]])}\n<i>This message deletes itself in a minute.</i>`;

const sec = (title, lines) => `<b>${title}</b>\n<blockquote>${lines.map(([c, d], i) => `${i === lines.length - 1 ? '└' : '├'} ${c}  ${d}`).join('\n')}</blockquote>`;
export function buildHelpText() {
  return [
    '<b>Omni Scan</b>\nPaste any token address and I pull up its card: price, safety checks, holders and links. In a group, the first person to post a token gets the call.',
    sec('🔎 Token data', [['/s', 'Search a token'], ['/p', 'Price'], ['/c', 'Chart'], ['/ta', 'Technical read'], ['/v', 'Convert an amount'], ['/th', 'Top holders'], ['/dev', 'Deployer and launches'], ['/nar', 'Lore (the story)'], ['/soc', 'Social links'], ['/dp', 'DEX Paid status'], ['/bm', 'Bubblemap']]),
    sec('🌍 Markets', [['/hm', 'Heatmap'], ['/best', 'Top gainers'], ['/worst', 'Top losers'], ['/i', 'Top coins'], ['/trending', 'Trending tokens'], ['/poly', 'Polymarket search']]),
    sec('👥 Group', [['/lb', 'Leaderboard (1h, 1 week, all…)'], ['/calls', 'Your calls'], ['/fc', 'First caller of a token'], ['/last', 'Last calls'], ['/pnl', 'PnL card'], ['/elb', 'Export leaderboard'], ['/meme', 'Random crypto meme']]),
    sec('🔔 Alerts', [['/watch', 'Watch a token (moves of ±%)'], ['/target', 'Alert at 3x, 4x, -50%…'], ['/targets', 'Your alerts'], ['/untarget', 'Remove alerts'], ['/remindme', 'Reminder to you'], ['/remind', 'Reminder for the chat'], ['/listreminders', 'Your reminders']]),
    sec('🤖 AI tools', [['/tr', 'Translate (-fr, -es, -yo…)'], ['/tldr', 'Summarize text or a link'], ['/eli5', 'Explain simply']]),
    sec('🧰 Utilities', [['/userid', 'Your ID'], ['/chatid', 'Chat ID'], ['/epoch', 'Unix time'], ['/flip', 'Flip a coin'], ['/trade', 'Omni Trade'], ['/launch', 'Omni Launch']]),
  ].join('\n\n');
}
export { formatPriceCard };
