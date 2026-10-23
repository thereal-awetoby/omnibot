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
    sec('𝕏 X calls', [['/follow', 'Call tokens an X account posts'], ['/unfollow', 'Stop following'], ['/following', 'Followed accounts']]),
    sec('🔔 Alerts', [['/watch', 'Watch a token (moves of ±%)'], ['/target', 'Alert at 3x, 4x, -50%…'], ['/targets', 'Your alerts'], ['/untarget', 'Remove alerts'], ['/remindme', 'Reminder to you'], ['/remind', 'Reminder for the chat'], ['/listreminders', 'Your reminders']]),
    sec('🤖 AI tools', [['/tr', 'Translate (-fr, -es, -yo…)'], ['/tldr', 'Summarize text or a link'], ['/eli5', 'Explain simply']]),
    sec('🧰 Utilities', [['/userid', 'Your ID'], ['/chatid', 'Chat ID'], ['/epoch', 'Unix time'], ['/flip', 'Flip a coin'], ['/trade', 'Omni Trade'], ['/launch', 'Omni Launch']]),
  ].join('\n\n');
}
export { formatPriceCard };

// /calls: one summary block, then every call in a quote block (collapsed after a few lines).
// calls: newest first, { mint, symbol, price_usd, mcap_usd, peak_price_usd, created_at }; prices: Map(mint -> { priceUsd }).
export function buildMyCallsText(calls, prices, who, now = Date.now()) {
  if (!calls.length) return 'You have no calls in this group yet. Post a token address that nobody has called.';
  const rows = calls.map((c) => {
    const entry = Number(c.price_usd) || 0;
    const nowP = prices.get(c.mint)?.priceUsd ?? null;
    const best = Math.max(Number(c.peak_price_usd) || 0, nowP || 0);
    return { c, x: entry && nowP ? nowP / entry : null, ath: entry && best ? Math.max(1, best / entry) : null };
  });
  const known = rows.filter((r) => r.x !== null);
  const pnl = known.length ? (known.reduce((a, r) => a + (r.x - 1), 0) / known.length) * 100 : null;
  const green = known.filter((r) => r.x > 1.0005).length;
  const red = known.filter((r) => r.x < 0.9995).length;
  const aths = rows.filter((r) => r.ath !== null);
  const avgAth = aths.length ? aths.reduce((a, r) => a + r.ath, 0) / aths.length : null;
  const top = aths.length ? aths.reduce((a, b) => (b.ath > a.ath ? b : a)) : null;
  const hit = aths.length ? (aths.filter((r) => r.ath >= 2).length / aths.length) * 100 : null;
  const pctTxt = (v) => (v === null ? 'n/a' : `${v >= 0 ? '+' : ''}${v.toFixed(Math.abs(v) >= 100 ? 0 : 0)}%`);
  const stats = tree([
    ['PNL', `${pctTxt(pnl)} (${green} 🟢 / ${red} 🔴)`],
    ['ATH', avgAth ? `${fmtX(avgAth)} avg` : 'n/a'],
    ['Best', top ? `${sym(top.c)} ${fmtX(top.ath)}` : 'n/a'],
    ['Hit', hit === null ? 'n/a' : `${hit.toFixed(0)}% ≥2x`],
  ]);
  const list = rows.map(({ c, x, ath }) => {
    const age = ago(now - new Date(c.created_at).getTime());
    const cur = x === null ? 'n/a' : `${x >= 1 ? '+' : ''}${((x - 1) * 100).toFixed(0)}%`;
    return `<b>${esc(sym(c))}</b> @ ${formatUsd(c.mcap_usd)} <i>(${age})</i>\n└ Now ${x === null ? '' : x >= 1 ? '🟢' : '🔴'} <b>${cur}</b> | ATH <b>${ath ? fmtX(ath) : '-'}</b>`;
  });
  return `📣 <b>Last ${calls.length} Call${calls.length === 1 ? '' : 's'}</b> · ${esc(String(who ?? 'you').replace(/^@/, ''))}\n<pre>${esc(stats)}</pre>\n<blockquote expandable>${list.join('\n')}</blockquote>`;
}

// ---- followed X accounts ----
const ago2 = (ms) => formatDuration(ms) ?? 'now';
export function buildFollowAddedText({ handle, latestAgoMs = null, error = null }) {
  const head = `𝕏 <b>Following @${esc(handle)}</b>\nAny token address they post will be called here as <i>called by @${esc(handle)}</i>.`;
  if (error) return `${head}\n\n⚠️ I could not read their posts just now, so I will keep trying. /following shows the status.`;
  return `${head}\n\n<pre>${esc(tree([['Status', 'reading OK'], ['Latest post', latestAgoMs == null ? 'n/a' : `${ago2(latestAgoMs)} ago`], ['Checks', 'every ~2 min']]))}</pre>`;
}
// What the X worker's saved reason means for the person reading /following.
export function explainXError(err) {
  const e = String(err ?? '').toLowerCase();
  if (e.includes('not running')) return 'the X reader is switched off';
  if (e.includes('not read this account yet')) return 'waiting for the X reader to check it';
  if (e.includes('rate limited') || e.includes('timed out')) return 'X is limiting the reader, it will retry';
  if (e.includes('locked') || e.includes('no usable') || e.includes('authentication')) return 'the reader\u2019s X login needs fresh cookies';
  if (e.includes('no such x account')) return 'that X account does not exist';
  return 'cannot read right now';
}
export function buildFollowingText(rows, now = Date.now()) {
  if (!rows.length) return '𝕏 <b>Followed accounts</b>\n\nNone yet. Add one with <code>/follow @handle</code>: any token address they post will be called in this group.';
  const lines = rows.map((r) => {
    const polled = r.polled_at ? new Date(r.polled_at).getTime() : null;
    const ok = r.ok_at ? new Date(r.ok_at).getTime() : null;
    let st;
    if (!polled) st = '⏳ not checked yet';
    else if (r.last_error) st = `⚠️ ${explainXError(r.last_error)}${ok ? ` (last worked ${ago2(now - ok)} ago)` : ''}`;
    else st = `✅ reading OK · checked ${ago2(now - polled)} ago`;
    const post = r.newest_tweet_at ? ` · latest post ${ago2(now - new Date(r.newest_tweet_at).getTime())} ago` : '';
    return `<b>@${esc(r.handle)}</b>\n└ ${st}${post}`;
  });
  return `𝕏 <b>Followed accounts</b> · ${rows.length}\n<blockquote>${lines.join('\n')}</blockquote>\n<i>Stop one with /unfollow @handle.</i>`;
}
export const buildXCallHeader = (handle, tweetId) => `𝕏 <a href="https://x.com/${esc(handle)}/status/${esc(tweetId)}">@${esc(handle)}</a> posted a token`;
