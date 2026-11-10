import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDashSearchJson, buildDashTrendingJson, buildDashWatchlistJson, buildDashTokenJson, buildPaperJson, DASH_PAGE } from './dashboard.js';

const MINT = 'So11111111111111111111111111111111111111112';

test('buildDashSearchJson normalizes searchTokens() rows', () => {
  const out = buildDashSearchJson([{ mint: MINT, symbol: 'SOL', name: 'Wrapped SOL', marketCapUsd: 1_000_000, liquidityUsd: 50_000 }]);
  assert.deepEqual(out, [{ mint: MINT, symbol: 'SOL', name: 'Wrapped SOL', marketCapUsd: 1_000_000, liquidityUsd: 50_000 }]);
  assert.deepEqual(buildDashSearchJson(null), []);
  assert.deepEqual(buildDashSearchJson([{ mint: MINT }]), [{ mint: MINT, symbol: null, name: null, marketCapUsd: null, liquidityUsd: null }]);
});

test('buildDashTrendingJson normalizes fetchPairsByTokens() rows, preferring the detailed change window', () => {
  const out = buildDashTrendingJson([{ mint: MINT, symbol: 'DOG', name: 'Dog', priceUsd: 0.5, marketCapUsd: 2_000_000, change: { h24: 12.3 } }]);
  assert.deepEqual(out, [{ mint: MINT, symbol: 'DOG', name: 'Dog', priceUsd: 0.5, marketCapUsd: 2_000_000, change24h: 12.3 }]);
  // falls back to the flat change24h field when there is no detailed window
  const flat = buildDashTrendingJson([{ mint: MINT, change24h: -4 }]);
  assert.equal(flat[0].change24h, -4);
});

test('buildDashWatchlistJson computes % change from the watch\'s added price', () => {
  const rows = [{ mint: MINT, symbol: 'SOL', added_price_usd: 100, alert_pct: 25 }];
  const prices = new Map([[MINT, { priceUsd: 125 }]]);
  const out = buildDashWatchlistJson(rows, prices);
  assert.deepEqual(out, [{ mint: MINT, symbol: 'SOL', priceUsd: 125, addedPriceUsd: 100, changePct: 25, alertPct: 25 }]);
  // missing price: changePct is null, not NaN or a crash
  const noPrice = buildDashWatchlistJson(rows, new Map());
  assert.equal(noPrice[0].priceUsd, null);
  assert.equal(noPrice[0].changePct, null);
  assert.deepEqual(buildDashWatchlistJson([], new Map()), []);
  assert.deepEqual(buildDashWatchlistJson(rows, undefined), [{ mint: MINT, symbol: 'SOL', priceUsd: null, addedPriceUsd: 100, changePct: null, alertPct: 25 }]);
});

test('buildDashTokenJson: no market data', () => {
  assert.deepEqual(buildDashTokenJson(MINT, {}), { mint: MINT, found: false });
  assert.deepEqual(buildDashTokenJson(MINT, { market: null }), { mint: MINT, found: false });
});

test('buildDashTokenJson: full card data condensed for the dashboard', () => {
  const card = {
    market: { symbol: 'ERC', name: 'European Relief Collective', priceUsd: 0.5, marketCapUsd: 2_000_000, liquidityUsd: 50_000, volume: { h24: 400_000 }, change: { h24: 12.3 }, dex: 'Raydium' },
    security: { mintAuthority: null, freezeAuthority: 'x' },
    intel: { devPct: 4.2, lpLockedPct: 100, top10Pct: 31.2, holdersTotal: 1812, insiderNetworks: 2, insiderWallets: 6, launchCount: 45, curve: { complete: false, progressPct: 74.4 } },
  };
  const t = buildDashTokenJson(MINT, card);
  assert.equal(t.found, true);
  assert.equal(t.symbol, 'ERC');
  assert.equal(t.priceUsd, 0.5);
  assert.equal(t.marketCapUsd, 2_000_000);
  assert.equal(t.volume24h, 400_000);
  assert.equal(t.change24h, 12.3);
  assert.deepEqual(t.security, { mintAuthority: false, freezeAuthority: true });
  assert.equal(t.devPct, 4.2);
  assert.equal(t.lpLockedPct, 100);
  assert.equal(t.insiderNetworks, 2);
  assert.equal(t.launchCount, 45);
  assert.deepEqual(t.curve, { complete: false, progressPct: 74.4 });
});

test('buildDashTokenJson: missing security/intel/curve degrade gracefully', () => {
  const t = buildDashTokenJson(MINT, { market: { symbol: 'X', priceUsd: 1 } });
  assert.equal(t.found, true);
  assert.equal(t.security, null);
  assert.equal(t.curve, null);
  assert.equal(t.devPct, null);
  assert.equal(t.insiderNetworks, 0);
});

test('DASH_PAGE is a self-contained HTML document with the Telegram WebApp script and API calls wired up', () => {
  assert.match(DASH_PAGE, /<!doctype html>/i);
  assert.match(DASH_PAGE, /telegram-web-app\.js/);
  assert.match(DASH_PAGE, /\/api\/dash\/search/);
  assert.match(DASH_PAGE, /\/api\/dash\/trending/);
  assert.match(DASH_PAGE, /\/api\/dash\/watchlist/);
  assert.match(DASH_PAGE, /\/api\/dash\/watch/);
  assert.match(DASH_PAGE, /\/api\/dash\/unwatch/);
  assert.match(DASH_PAGE, /\/api\/dash\/token/);
  assert.match(DASH_PAGE, /X-Init-Data/);
});

const PMINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

test('buildPaperJson: equity = cash + open positions at current value, unrealized folded in', () => {
  const account = { balance_usd: 400, realized_usd: 20 };
  const strategy = { enabled: true, min_mcap_usd: 5000, max_mcap_usd: null, alloc_pct: 5, tp_pct: 100, sl_pct: 40, max_open: 3 };
  const positions = [{ id: 1, mint: MINT, symbol: 'SOL', size_usd: 50, entry_price_usd: 2, opened_at: 't1' }, { id: 2, mint: PMINT, symbol: 'USDC', size_usd: 50, entry_price_usd: 1, opened_at: 't2' }];
  const prices = new Map([[MINT, { priceUsd: 3 }]]); // +50%; PMINT has no price
  const history = [{ id: 9, mint: MINT, symbol: 'OLD', pnl_usd: -10, pnl_pct: -40, close_reason: 'sl', closed_at: 't0' }];
  const j = buildPaperJson({ account, strategy, positions, prices, history });
  assert.equal(j.balanceUsd, 400);
  assert.equal(j.realizedUsd, 20);
  assert.equal(j.investedUsd, 100);
  assert.equal(j.equityUsd, 400 + 100 + 25); // cash + size + unrealized (25 gain on the priced one, 0 on the other)
  assert.deepEqual(j.strategy, {
    enabled: true, minMcapUsd: 5000, maxMcapUsd: null, allocPct: 5, tpPct: 100, slPct: 40, maxOpen: 3,
    mode: 'rules', agentPrompt: null, maxPositionUsd: null, dailyLossLimitPct: null,
  });
  assert.equal(j.positions.length, 2);
  assert.equal(j.positions[0].pnlUsd, 25);
  assert.equal(j.positions[0].pnlPct, 50);
  assert.equal(j.positions[0].openMode, 'rules');
  assert.equal(j.positions[1].pnlUsd, 0);
  assert.equal(j.positions[1].pnlPct, null); // no price: can't say a percent
  assert.deepEqual(j.history, [{ id: 9, mint: MINT, symbol: 'OLD', pnlUsd: -10, pnlPct: -40, reason: 'sl', closedAt: 't0', openMode: 'rules', decisionReason: null }]);
});

test('buildPaperJson: brand-new account, no strategy row, nothing open or closed', () => {
  const j = buildPaperJson({ account: { balance_usd: 500, realized_usd: 0 }, strategy: null, positions: [], prices: new Map(), history: [] });
  assert.equal(j.balanceUsd, 500);
  assert.equal(j.investedUsd, 0);
  assert.equal(j.equityUsd, 500);
  assert.equal(j.strategy, null);
  assert.deepEqual(j.positions, []);
  assert.deepEqual(j.history, []);
  assert.deepEqual(buildPaperJson({}), { balanceUsd: 0, realizedUsd: 0, investedUsd: 0, equityUsd: 0, strategy: null, positions: [], history: [] });
});

test('DASH_PAGE now has the Paper tab wired up: tab button, view, strategy fields, and the paper API calls', () => {
  assert.match(DASH_PAGE, /id="tab-paper"/);
  assert.match(DASH_PAGE, /id="paper"/);
  assert.match(DASH_PAGE, /id="p-tog"/);
  assert.match(DASH_PAGE, /id="p-alloc"/);
  assert.match(DASH_PAGE, /id="p-tp"/);
  assert.match(DASH_PAGE, /id="p-sl"/);
  assert.match(DASH_PAGE, /\/api\/dash\/paper(?!\/)/);
  assert.match(DASH_PAGE, /\/api\/dash\/paper\/strategy/);
  assert.match(DASH_PAGE, /\/api\/dash\/paper\/share/);
});
