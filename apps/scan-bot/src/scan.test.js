import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMintInput, changePct, formatChange, shouldAlert, parseAlertPct, buildScanCard, buildTrendingText, buildWatchlistText, buildAlertText,
  formatPriceCard, formatCount, shortPct, formatDuration, safeUrl, buildSocialLine, buildCallLine, buildLeaderboard, buildLeaderboardText, buildUserCallsText, extractMint, multiple,
} from './scan.js';

const MINT = 'So11111111111111111111111111111111111111112';

test('parseMintInput accepts bare mints and commands, rejects chat', () => {
  assert.equal(parseMintInput(MINT), MINT);
  assert.equal(parseMintInput(`/token ${MINT}`), MINT);
  assert.equal(parseMintInput(`/token@OmniScanBot  ${MINT}`), MINT);
  assert.equal(parseMintInput('hello there'), null);
  assert.equal(parseMintInput(`${MINT} extra`), null);
});

test('changePct and formatChange', () => {
  assert.equal(changePct(1, 1.25), 25);
  assert.equal(changePct(2, 1), -50);
  assert.equal(changePct(0, 1), null);
  assert.equal(changePct(1, NaN), null);
  assert.equal(formatChange(12.34), '🟢 +12.3%');
  assert.equal(formatChange(-5), '🔴 -5.0%');
  assert.equal(formatChange(250.4), '🟢 +250%');
  assert.equal(formatChange(null), 'n/a');
});

test('shouldAlert fires on moves in either direction, at the threshold', () => {
  assert.equal(shouldAlert(1, 1.25, 25), true);
  assert.equal(shouldAlert(1, 0.75, 25), true);
  assert.equal(shouldAlert(1, 1.2, 25), false);
  assert.equal(shouldAlert(0, 5, 25), false);
});

test('parseAlertPct', () => {
  assert.equal(parseAlertPct('30'), 30);
  assert.equal(parseAlertPct('12.5%'), 12.5);
  for (const bad of ['0', '0.5', '1001', 'abc', '-3', '1.25', '']) assert.equal(parseAlertPct(bad), null, bad);
});

test('trending, watchlist and alert texts', () => {
  const t = buildTrendingText([{ symbol: 'AAA', marketCapUsd: 1e6, change24h: 10 }]);
  assert.match(t, /1\. \$AAA/);
  assert.match(buildTrendingText([]), /Nothing trending/);
  const rows = [{ mint: MINT, symbol: 'AAA', added_price_usd: 1, base_price_usd: 1, alert_pct: 25 }];
  const w = buildWatchlistText(rows, new Map([[MINT, { priceUsd: 1.5 }]]));
  assert.match(w, /\+50\.0%/);
  assert.match(w, /±25%/);
  assert.match(buildWatchlistText([], new Map()), /empty/);
  assert.match(buildAlertText(rows[0], 1.3), /moved 🟢 \+30\.0%/);
});

const NOW = 1_700_000_000_000;
const market = {
  symbol: 'A<B', name: 'N&M', priceUsd: 0.5, marketCapUsd: 2_000_000, fdvUsd: 2_500_000, liquidityUsd: 50_000,
  dex: 'Raydium', createdAt: NOW - 9 * 3_600_000, boosts: 2, hasProfile: true,
  volume: { m5: 1000, h1: 20_000, h6: 90_000, h24: 400_000 }, change: { m5: 1, h1: 43.9, h6: -2, h24: 2283 },
  txns: { h1: { buys: 4100, sells: 2900 } }, websites: [{ label: 'Website', url: 'https://a.io' }],
  socials: [{ type: 'twitter', url: 'https://x.com/a' }, { type: 'telegram', url: 'javascript:alert(1)' }],
};
const security = { mintAuthority: null, freezeAuthority: null, top1Pct: 11, top5Pct: 25, top10Pct: 31.2 };

test('formatters', () => {
  assert.equal(formatCount(4100), '4.1K');
  assert.equal(formatCount(2_500_000), '2.5M');
  assert.equal(formatCount(12), '12');
  assert.equal(shortPct(43.94), '+43.9%');
  assert.equal(shortPct(-3), '-3.0%');
  assert.equal(shortPct(2283), '+2283%');
  assert.equal(shortPct(null), 'n/a');
  assert.equal(formatDuration(30 * 60_000), '30m');
  assert.equal(formatDuration(9 * 3_600_000), '9h');
  assert.equal(formatDuration(5 * 86_400_000), '5d');
  assert.equal(formatDuration(100 * 86_400_000), '3mo');
  assert.equal(formatDuration(NaN), null);
  assert.equal(safeUrl('javascript:alert(1)'), null);
  assert.equal(safeUrl('https://a.io/?x=1&y="2"'), 'https://a.io/?x=1&amp;y=%222%22');
});

test('buildSocialLine says Social, keeps only safe links, never mentions DexScreener', () => {
  const t = buildSocialLine(market);
  assert.match(t, /^🔗 <b>Social<\/b>  /);
  assert.match(t, /<a href="https:\/\/a\.io\/">Website<\/a>/);
  assert.match(t, />X<\/a>/);
  assert.doesNotMatch(t, /javascript|DexScreener/);
  assert.match(buildSocialLine({ websites: [], socials: [] }), /none listed/);
});

test('call line, leaderboard and user calls', () => {
  const call = { caller_name: 'dav<id', caller_id: 1, price_usd: 1, mcap_usd: 1_000_000, mint: MINT, symbol: 'AAA', created_at: new Date(NOW - 2 * 86_400_000) };
  assert.match(buildCallLine(call, 2.5), /First call: <b>dav&lt;id<\/b> @ \$1\.00M  ·  now 2\.50x 🚀/);
  assert.match(buildCallLine(call, 0.5), /now 0\.50x 🔻/);
  assert.equal(buildCallLine(null, 1), null);
  assert.equal(multiple(0, 1), null);

  const calls = [
    { mint: 'A', caller_id: 1, caller_name: 'ann', price_usd: 1 },
    { mint: 'B', caller_id: 1, caller_name: 'ann', price_usd: 1 },
    { mint: 'C', caller_id: 2, caller_name: 'bob', price_usd: 1 },
    { mint: 'D', caller_id: 3, caller_name: 'cy', price_usd: 1 }, // no price now: ignored
  ];
  const prices = new Map([['A', { priceUsd: 4 }], ['B', { priceUsd: 0.5 }], ['C', { priceUsd: 3 }]]);
  const board = buildLeaderboard(calls, prices);
  assert.deepEqual(board.map((e) => e.name), ['bob', 'ann']);
  assert.equal(board[1].calls, 2);
  assert.equal(board[1].hits, 1);
  assert.equal(board[1].best, 4);
  assert.equal(board[1].avg, 2.25);
  const text = buildLeaderboardText(board);
  assert.match(text, /🥇 <b>bob<\/b>/);
  assert.match(text, /1\/2 hit 2x/);
  assert.match(buildLeaderboardText([]), /No calls yet/);

  const ut = buildUserCallsText([call], new Map([[MINT, { priceUsd: 3 }]]), 'dav<id', NOW);
  assert.match(ut, /\$AAA  @ \$1\.00M  ·  now 3\.00x 🚀  ·  2d ago/);
  assert.match(buildUserCallsText([], new Map(), 'x'), /no calls/);
});

test('extractMint finds an address inside chat text but not inside longer words', () => {
  assert.equal(extractMint(`check this ${MINT} lol`), MINT);
  assert.equal(extractMint('no address here'), null);
  assert.equal(extractMint(`${MINT}${MINT}`), null);
});

test('formatPriceCard: 4 significant digits and subscript zeros for tiny prices', () => {
  assert.equal(formatPriceCard(0.00002491), '$0.0₄2491');
  assert.equal(formatPriceCard(0.00000312), '$0.0₅3120');
  assert.equal(formatPriceCard(0.001005), '$0.001005');
  assert.equal(formatPriceCard(0.0123456), '$0.01235');
  assert.equal(formatPriceCard(0.5), '$0.5');
  assert.equal(formatPriceCard(2.5), '$2.5');
  assert.equal(formatPriceCard(1234.5678), '$1,234.57');
  assert.equal(formatPriceCard(null), 'n/a');
  assert.equal(formatPriceCard(0), 'n/a');
  assert.equal(formatPriceCard(1e-12), '$0.0₁₁1000');
});

const fullIntel = {
  lpLockedPct: 100, devPct: 0, fresh1dPct: 6.1, fresh7dPct: 13, walletsChecked: 9, holdersTotal: 1812,
  top10Pct: 31.2, top1Pct: 11, top: [{ owner: 'a', pct: 11 }, { owner: 'b', pct: 6.2 }, { owner: 'c', pct: 5 }],
  ath: { athMcapUsd: 1_060_000, fromAthPct: -4, athAt: NOW - 4 * 60_000 },
};

test('full card: compact rows, facts only, escaped text', () => {
  const card = buildScanCard({ mint: MINT, market, security, intel: fullIntel, watched: true, now: NOW });
  assert.match(card, /\$A&lt;B/);
  assert.match(card, /N&amp;M/);
  assert.match(card, /⭐/);
  assert.match(card, /└ Solana · Raydium · 🌱 9h · 🔥 2/);
  assert.match(card, /<code>Price    <\/code><b>\$0\.5<\/b>  \(\+2283%\)/);
  assert.match(card, /<code>MCap     <\/code><b>\$2\.00M<\/b>  ·  FDV \$2\.50M/);
  assert.match(card, /<code>Liq      <\/code><b>\$50\.00K<\/b>\n/);
  assert.match(card, /<code>Vol      <\/code>1h \$20\.00K · 24h \$400\.00K\n/);
  assert.match(card, /<code>1H       <\/code>\+43\.9% · 🟢 4\.1K · 🔴 2\.9K\n/);
  assert.match(card, /<code>ATH      <\/code><b>\$1\.06M<\/b>  \(-4\.0%\) · 4m\n/);
  assert.match(card, /Mint ✅ off · Freeze ✅ off/);
  assert.match(card, /<b>100% locked\/burned<\/b> ✅/);
  assert.match(card, /<b>holds 0%<\/b>  \(sold or moved\)/);
  assert.match(card, /<b>31\.2%<\/b>  ·  largest 11\.0%/);
  assert.match(card, /<code>TH       <\/code>11\.0 \| 6\.2 \| 5\.0/);
  assert.match(card, /1D <b>6\.1%<\/b> · 7D <b>13\.0%<\/b>\n/);
  assert.match(card, /<code>DEX Paid <\/code><b>yes<\/b> ✅/);
  assert.match(card, /<b>1,812<\/b>/);
  assert.match(card, /🔗 <b>Social<\/b>/);
  // tree glyphs: the last row of each block closes with └
  assert.equal((card.match(/└/g) ?? []).length, 3); // header line + stats + security
});

test('the card never contains risk wording, ratings, loading text or the old clutter', () => {
  const card = buildScanCard({ mint: MINT, market, security, intel: { ...fullIntel, insiderPct: 40, insiderNetworks: 3, insiderWallets: 9 }, now: NOW });
  for (const bad of [/risk/i, /MEDIUM|HIGH|LOW/, /Not advice/, /Running safety|loading|⏳/i, /Insider/, /linked group/, /MCap\/Liq/, /Moves/, /DexScreener/, /🟡|⚠️/]) {
    assert.doesNotMatch(card, bad, String(bad));
  }
});

test('risky authorities are shown as plain facts', () => {
  const card = buildScanCard({ mint: MINT, market, security: { mintAuthority: 'x', freezeAuthority: null }, intel: fullIntel, now: NOW });
  assert.match(card, /Mint ⚠️ active · Freeze ✅ off/);
});

test('card keeps the same rows when data is missing (n/a instead of vanishing)', () => {
  const card = buildScanCard({ mint: MINT, market, security: null, intel: null, now: NOW });
  for (const label of ['Auth', 'LP', 'Dev', 'Top 10', 'Fresh', 'Holders']) assert.match(card, new RegExp(`<code>${label.padEnd(9)}</code><i>n/a</i>`), label);
  assert.match(card, /<code>DEX Paid <\/code><b>yes<\/b>/);
  assert.match(buildScanCard({ mint: MINT, market: { ...market, hasProfile: false }, now: NOW }), /<code>DEX Paid <\/code>no/);
});

test('stats rows only appear when there is data, and stay short', () => {
  const lean = { symbol: 'X', priceUsd: 1, marketCapUsd: 1000, liquidityUsd: 500, volume24h: 12 };
  const card = buildScanCard({ mint: MINT, market: lean, now: NOW });
  assert.match(card, /<code>Vol      <\/code>24h \$12\.00\n/);
  assert.doesNotMatch(card, /<code>1H /);
  assert.doesNotMatch(card, /<code>ATH /);
  for (const line of card.split('\n').filter((l) => /^[├└] <code>/.test(l))) {
    assert.ok(line.replace(/<[^>]+>/g, '').length <= 44, line); // fits a phone screen without wrapping
  }
});

test('the full card rows all fit a phone screen', () => {
  const card = buildScanCard({ mint: MINT, market, security, intel: fullIntel, now: NOW });
  for (const line of card.split('\n').filter((l) => /^[├└] <code>/.test(l))) {
    assert.ok(line.replace(/<[^>]+>/g, '').length <= 44, line);
  }
});

test('RugCheck holders fill in when the RPC is busy', () => {
  const intel = { top: [{ owner: 'a', pct: 30 }], top10Pct: 62, top1Pct: 30, lpLockedPct: 100 };
  const card = buildScanCard({ mint: MINT, market, security: null, intel, now: NOW });
  assert.match(card, /<b>62\.0%<\/b>  ·  largest 30\.0%/);
  assert.match(buildScanCard({ mint: MINT, market: null, now: NOW }), /No market data/);
});
