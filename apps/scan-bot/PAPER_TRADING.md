# Paper Trading

A personal, simulated trading account built into the scan bot. No real money ever moves — every balance,
position and PnL number here is virtual, tracked per Telegram user. This doc covers every paper-trading
feature end to end: the original plan (Phases 1–5) plus the later round of polish.

All paper commands are DM-only (the bot replies "Paper trading is personal — DM the bot instead." in a group).

## Quick start

1. DM the bot `/paper` — creates your paper account (starting balance from `PAPER_START_USD`, default $1,000)
   and shows your equity, cash, and open positions.
2. DM `/strategy` to configure how it trades, and turn it on with the "🟢 Turn on" button.
3. Call a token in a group (or follow an X account with `/follow @handle`) — if your strategy matches, the
   bot opens a paper position and DMs you.

## Modes

Set from the "Mode" button in `/strategy`:

- **Rules** — the original behavior. A trade opens only when the call's market cap falls inside your
  Min/Max MC range.
- **Agent** — an AI (Gemini) decides every call from scratch: buy, just flag it ("call"), or skip. Market-cap
  range is ignored; instead it follows the free-text instructions you set under "🤖 Edit instructions".
- **Hybrid** — your Min/Max MC range is a hard pre-filter; only calls that pass it are even shown to the
  agent, which then decides buy/call/skip the same way as Agent mode.

In Agent/Hybrid mode, a **"call"** decision sends you a heads-up message with no trade and no capital at
risk — useful when the signal looks interesting but not confident enough to size into.

The agent needs `GEMINI_API_KEY` set in the bot's environment. Without it, Agent/Hybrid modes fail closed
(skip everything) rather than guessing — paper trading in Rules mode needs no API key at all.

## Risk limits (always enforced, every mode)

These are hard limits, not agent suggestions — they're checked in code after any decision is made:

- **Size %** or **Fixed $** — how much of a trade to risk (see "Sizing" below).
- **Max $/trade** — an absolute cap per trade, on top of the Size %/$ setting.
- **Max open** — the most paper positions you can hold at once.
- **Daily loss stop** — once realized losses hit this % of your equity in a day (UTC), no new trades open
  until the next day; you get a one-time heads-up when it trips. Existing open positions still get checked
  for take-profit/stop-loss while paused.

## Sizing

Two modes, toggled from `/strategy`:

- **Size %** (default) — each trade risks this % of your current paper balance.
- **Fixed $** — each trade risks a fixed dollar amount (`alloc_usd`) regardless of balance. Useful for
  consistent position sizing independent of how the account has grown or shrunk.

Either way, **Max $/trade** still applies as a hard ceiling.

## Exits

- **Take-profit %** and **Stop-loss %** close the whole position automatically.
- **Partial take-profit** (optional) — set "Partial TP %" and "Partial close %" to peel off part of a
  winning position early (e.g. partial TP at +50%, closing 50% of the position) while letting the rest keep
  running toward the full take-profit. Fires once per position.
- Milestone replies (2x, 3x, 5x, 10x…) post automatically under the original call as a position runs, same
  as a real group call.
- `/paperclose <id>` closes an open position manually, right now, at the current price.

## Source filters

Restrict a strategy to only act on calls from specific sources. Set "Sources" in `/strategy` to a
comma-separated list of group chat IDs and/or X handles (e.g. `-100123456,elonmusk`). Leave it unset (or
type "clear") to act on every source, which is the default. This is a hard filter applied before any mode's
own logic, in every mode.

## Commands

| Command | What it does |
|---|---|
| `/paper` | Account summary: equity (with a text sparkline once you have history), cash, realized PnL, open count. |
| `/strategy` | View/edit your strategy (mode, sizing, limits, filters) via buttons. |
| `/positions` | List your open positions with live PnL. |
| `/paperhistory` | List closed trades, each with a "Share" button that sends a PnL card image. |
| `/paperstats` | Win rate, total realized PnL, best trade, and an equity curve sparkline. |
| `/paperwhy <id>` | Shows the AI agent's fuller reasoning for a trade (Agent/Hybrid only), beyond the short reason shown everywhere else. |
| `/paperclose <id>` | Manually closes an open position at the current price. |
| `/paperpause` | Turns your strategy off (same as the "Turn off" button). |
| `/paperresume` | Turns your strategy back on. |
| `/paperreset` | Wipes positions, equity history, and balance back to the starting amount. Destructive — type `/paperreset confirm` to actually do it. |

## Equity curve

Every full or partial close takes a snapshot of your equity (cash + value of what's still open) into a
small history table. `/paper` and `/paperstats` show it as a text sparkline (`▁▂▃▅▇`); the Mini App's Paper
tab gets the same numbers as a plain array (`equityCurve`) if you want to render a real chart there.

## Deeper agent logging

In Agent/Hybrid mode, the AI's response includes a short `reason` (shown everywhere — notices, history,
PnL cards) and an optional, longer `detail` with its fuller reasoning. `detail` is never shown unless you
ask for it with `/paperwhy <id>` — keeps the everyday messages readable while still letting you audit why
a trade happened.

## Public access controls

By default, paper trading is open to anyone who DMs the bot. If you've set `ADMIN_IDS` in the bot's
environment (the same variable used elsewhere in this bot, e.g. `/pnlbg`), paper trading automatically
restricts itself to those Telegram IDs — unless you also set `PAPER_PUBLIC=1`, which reopens it to everyone
regardless of `ADMIN_IDS`. If `ADMIN_IDS` is unset, paper trading stays open to everyone (so a fresh install
is never locked out before you've configured anything).

| `ADMIN_IDS` | `PAPER_PUBLIC` | Result |
|---|---|---|
| unset | — | open to everyone |
| set | unset or anything but `1` | restricted to the IDs in `ADMIN_IDS` |
| set | `1` | open to everyone |

## Mini App (Paper tab)

The Telegram Mini App's Paper tab shows the same account summary, open positions, and history, and lets you
edit the core strategy fields (mode toggle not yet exposed there — use `/strategy` in chat for Mode, Sources,
Fixed $, and the partial take-profit tier; the Mini App covers the original Min/Max MC, Size %, Take-profit,
Stop-loss, and Max open fields). The dashboard JSON (`/api/dash/paper`) does include every field and the full
`equityCurve` array, so a future UI pass can wire up the rest without any backend changes.
