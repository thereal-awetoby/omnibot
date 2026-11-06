import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTrades, aggregateTraders, topByVolume, estimateProfits, buildTopTradersText, buildTopWalletsText, fetchTrades,
  buildWalletText, parseForceOrder, summarizeLiquidations, buildRektText, createLiquidationFeed, parseRektWindow, REKT_WINDOWS,
} from './traders.js';

const MINT = 'G6NnKQTgN7Dmo9yrJXwoqiDm35FznQmQ1qXVFAXPpump';
const SOL = 'So11111111111111111111111111111111111111112';
const W = (n) => `Abcd${n}`.padEnd(44, '1'); // valid base58 look-alike addresses
const t0 = Date.parse('2026-10-23T12:00:00Z');
const trade = (wallet, side, usd, tokens, minsAgo, kind) => ({
  attributes: {
    tx_from_address: wallet, volume_in_usd: String(usd), block_timestamp: new Date(t0 - minsAgo * 60_000).toISOString(),
    kind: kind ?? side, from_token_address: side === 'buy' ? SOL : MINT, to_token_address: side === 'buy' ? MINT : SOL,
    from_token_amount: String(side === 'buy' ? 1 : tokens), to_token_amount: String(side === 'buy' ? tokens : 1),
  },
});
const body = (list) => ({ data: list });

test('parseTrades reads direction from the token addresses and sorts newest first', () => {
  const trades = parseTrades(body([trade(W(1), 'buy', 100, 1000, 10), trade(W(2), 'sell', 50, 400, 2)]), MINT);
  assert.equal(trades.length, 2);
  assert.deepEqual(trades.map((t) => [t.wallet, t.side, t.usd, t.tokens]), [[W(2), 'sell', 50, 400], [W(1), 'buy', 100, 1000]]);
});

test('parseTrades falls back to kind, and skips broken rows', () => {
  const noAddr = { attributes: { tx_from_address: W(3), volume_in_usd: '20', block_timestamp: new Date(t0).toISOString(), kind: 'sell', from_token_amount: '7', to_token_amount: '1' } };
  const bad = [{ attributes: { volume_in_usd: '5' } }, { attributes: { tx_from_address: W(4), volume_in_usd: 'x', block_timestamp: 'nope', kind: 'buy' } }, null];
  const trades = parseTrades(body([noAddr, ...bad]), MINT);
  assert.equal(trades.length, 1);
  assert.deepEqual([trades[0].side, trades[0].tokens], ['sell', 7]);
  assert.deepEqual(parseTrades(null, MINT), []);
});

const sample = () => parseTrades(body([
  trade(W(1), 'buy', 100, 1000, 30), trade(W(1), 'sell', 150, 500, 5),   // bought 1000 for $100, sold 500 for $150
  trade(W(2), 'buy', 300, 3000, 20),                                      // holds everything
  trade(W(3), 'sell', 80, 800, 15),                                       // sold older holdings: unknown cost
  trade(W(4), 'buy', 40, 400, 12), trade(W(4), 'sell', 10, 400, 3),       // round trip at a loss
]), MINT);

test('aggregateTraders sums buys and sells per wallet', () => {
  const rows = aggregateTraders(sample());
  const w1 = rows.find((r) => r.wallet === W(1));
  assert.deepEqual([w1.buyUsd, w1.sellUsd, w1.buyTokens, w1.sellTokens, w1.buys, w1.sells, w1.volume], [100, 150, 1000, 500, 1, 1, 250]);
  assert.equal(topByVolume(rows, 2)[0].wallet, W(2));
});

test('estimateProfits ranks wallets that bought in the window and leaves out older holders', () => {
  const p = estimateProfits(aggregateTraders(sample()), 0.1); // price per token $0.10
  assert.deepEqual(p.map((r) => r.wallet), [W(1), W(2), W(4)]); // W3 sold without buying: not listed
  const w1 = p[0], w2 = p[1], w4 = p[2];
  assert.ok(Math.abs(w2.pnl) < 1e-9); // held 3000 tokens worth $300, paid $300
  assert.ok(Math.abs(w1.pnl - (150 + 500 * 0.1 - 100)) < 1e-9); // sold $150 + holds 500 tokens = $50, paid $100
  assert.ok(Math.abs(w1.x - 2) < 1e-9);
  assert.ok(w4.pnl < 0);
});

test('text builders: titles, wallet links, rankings, honest notes, empty states', () => {
  const trades = sample(); const rows = aggregateTraders(trades); const market = { symbol: 'BDOG' };
  const tt = buildTopTradersText({ market, trades, rows, now: t0 });
  assert.match(tt, /Top traders<\/b> · \$BDOG/);
  assert.match(tt, /Window\s+6 trades · 27m/);
  assert.match(tt, /href="https:\/\/solscan\.io\/account\/Abcd2/);
  assert.match(tt, /Ranked by traded volume/);
  const tw = buildTopWalletsText({ market, trades, profits: estimateProfits(rows, 0.1), now: t0 });
  assert.match(tw, /Top wallets<\/b> · \$BDOG/);
  assert.match(tw, /Only wallets that bought inside the window/);
  assert.match(buildTopTradersText({ market, trades: [], rows: [] }), /No recent trades/);
  assert.match(buildTopWalletsText({ market, trades, profits: [] , now: t0 }), /No wallet in this window/);
  assert.doesNotMatch(tt + tw, /risk|advice|should/i);
});

test('fetchTrades parses, caches, and pauses after a 429', async () => {
  let calls = 0;
  const ok = async (url) => { calls += 1; assert.match(url, /pools\/POOL1\/trades$/); return { ok: true, status: 200, json: async () => body([trade(W(1), 'buy', 10, 100, 1)]) }; };
  const a = await fetchTrades('POOL1', MINT, { fetchImpl: ok, now: 1_000_000 });
  const b = await fetchTrades('POOL1', MINT, { fetchImpl: ok, now: 1_010_000 });
  assert.equal(a.length, 1); assert.equal(calls, 1); assert.equal(b, a);
  const limited = async () => ({ ok: false, status: 429, json: async () => ({}) });
  await assert.rejects(() => fetchTrades('POOL2', MINT, { fetchImpl: limited, now: 2_000_000 }), /rate limiting/);
  await assert.rejects(() => fetchTrades('POOL3', MINT, { fetchImpl: ok, now: 2_030_000 }), /rate limiting/); // still paused
});

test('buildWalletText shows SOL, token value, age, funder and top holdings', () => {
  const text = buildWalletText({
    address: W(9), sol: 12.4, solUsd: 170,
    holdings: { count: 14, totalUsd: 8300, top: [{ symbol: 'WIF', usd: 3100 }, { symbol: null, usd: 900 }] },
    funding: { funder: W(8), sol: 1.5, at: t0 - 45 * 86_400_000 }, now: t0,
  });
  assert.match(text, /Wallet<\/b> · <a href/);
  assert.match(text, /SOL\s+12\.40\s+\(~\$2\.11K\)/);
  assert.match(text, /Tokens\s+14/);
  assert.match(text, /Total\s+~\$10\.41K/);
  assert.match(text, /first funded 45d/);
  assert.match(text, /Funded by .*1\.50 SOL/);
  assert.match(text, /1\. \$WIF · \$3\.10K/);
  assert.match(buildWalletText({ address: W(9), sol: null, solUsd: null, holdings: null, funding: null }), /Could not read this wallet/);
});

const force = (s, S, ap, z, T) => ({ e: 'forceOrder', E: T, o: { s, S, ap: String(ap), z: String(z), q: String(z), T } });

test('parseForceOrder: SELL closes a long, BUY closes a short, bad messages are ignored', () => {
  assert.deepEqual(parseForceOrder(force('BTCUSDT', 'SELL', 60000, 0.5, 5)), { sym: 'BTC', side: 'long', usd: 30000, at: 5 });
  assert.equal(parseForceOrder(force('ETHUSDT', 'BUY', 3000, 2, 6)).side, 'short');
  assert.equal(parseForceOrder({ e: 'other' }), null);
  assert.equal(parseForceOrder(force('XUSDT', 'BUY', 0, 0, 1)), null);
  assert.equal(parseForceOrder(null), null);
});

test('summarizeLiquidations counts only the window and finds the biggest', () => {
  const now = 10 * 3_600_000;
  const ev = [
    { sym: 'BTC', side: 'long', usd: 1000, at: now - 1_000 }, { sym: 'BTC', side: 'short', usd: 500, at: now - 2_000 },
    { sym: 'ETH', side: 'long', usd: 3000, at: now - 3_000 }, { sym: 'OLD', side: 'long', usd: 9e9, at: now - 5 * 3_600_000 },
  ];
  const s = summarizeLiquidations(ev, REKT_WINDOWS['4h'], now);
  assert.deepEqual([s.count, s.total, s.long, s.short], [3, 4500, 4000, 500]);
  assert.deepEqual(s.coins.map((c) => c.sym), ['ETH', 'BTC']);
  assert.equal(s.biggest.sym, 'ETH');
  assert.equal(summarizeLiquidations(ev, REKT_WINDOWS['24h'], now).count, 4);
});

test('buildRektText: totals, per-coin split, coverage note and empty state', () => {
  const now = 10 * 3_600_000;
  const ev = [{ sym: 'BTC', side: 'long', usd: 750_000, at: now - 1 }, { sym: 'BTC', side: 'short', usd: 250_000, at: now - 2 }, { sym: 'SOL', side: 'short', usd: 100_000, at: now - 3 }];
  const text = buildRektText({ summary: summarizeLiquidations(ev, REKT_WINDOWS['4h'], now), windowLabel: '4h', coveredMs: 3_600_000 });
  assert.match(text, /Liquidations<\/b> · last 4h/);
  assert.match(text, /Total\s+\$1\.10M\s+\(3\)/);
  assert.match(text, /Longs\s+\$750\.00K\s+68%/);
  assert.match(text, /1\. <b>BTC<\/b>/);
  assert.match(text, /Counted since this bot started listening, 1h/);
  assert.match(buildRektText({ summary: summarizeLiquidations([], 1, now), windowLabel: '1h', coveredMs: 60_000 }), /No liquidations recorded/);
  assert.equal(parseRektWindow('24H'), '24h'); assert.equal(parseRektWindow('nope'), '4h'); assert.equal(parseRektWindow(undefined), '4h');
});

test('liquidation feed collects messages from a (fake) WebSocket and prunes old ones', () => {
  let t = 100 * 3_600_000;
  let sock;
  class FakeWS { constructor(url) { sock = this; this.url = url; } close() {} }
  const feed = createLiquidationFeed({ WebSocketImpl: FakeWS, now: () => t });
  feed.start();
  assert.match(sock.url, /forceOrder/);
  sock.onopen();
  sock.onmessage({ data: JSON.stringify(force('BTCUSDT', 'SELL', 100, 2, t - 1000)) });
  sock.onmessage({ data: 'not json' });
  sock.onmessage({ data: JSON.stringify(force('ETHUSDT', 'BUY', 10, 5, t - 2000)) });
  assert.equal(feed.events().length, 2);
  t += 3_600_000;
  assert.equal(feed.coveredMs(), 3_600_000);
  assert.deepEqual([feed.summary('4h').count, feed.summary('1h').count], [2, 0]);
  feed.stop();
});
