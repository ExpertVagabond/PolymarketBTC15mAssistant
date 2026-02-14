# Polymarket BTC 15m Assistant

A real-time trading assistant for Polymarket **"Bitcoin Up or Down" 15-minute** markets.

It combines:
- Polymarket market selection + UP/DOWN prices + liquidity
- Polymarket live WS **Chainlink BTC/USD CURRENT PRICE** (same feed shown on the Polymarket UI)
- Fallback to on-chain Chainlink (Polygon) via HTTP/WSS RPC
- Binance spot price for reference
- Short-term TA snapshot (Heiken Ashi, RSI, MACD, VWAP, Delta 1/3m)
- A simple live **Predict (LONG/SHORT %)** derived from the assistant's current TA scoring

## Features

| Command | What it does |
|---------|-------------|
| `npm start` | Console dashboard — original live view |
| `npm run start:web` | Web dashboard at http://localhost:3000 with real-time charts |
| `npm run start:alerts` | Console + Telegram/Discord alerts on strong signals |
| `npm run start:trading` | Auto-trading bot (dry-run by default) |
| `npm run start:multi` | Multi-market tabular view |
| `npm run start:full` | Everything: web + alerts + trading + backtest tracking |
| `npm run backtest` | Analyze collected window data (accuracy, P&L, Sharpe) |
| `npm run mcp` | MCP server for Claude Code / AI integration |

## Quick Start

```bash
git clone https://github.com/FrondEnt/PolymarketBTC15mAssistant.git
cd PolymarketBTC15mAssistant
npm install
npm start
```

**No API keys required** for the base app. All data sources are public.

## Setup

### Requirements

- Node.js **18+** (https://nodejs.org/en)
- npm (comes with Node)

### Environment Variables

Copy the example file and edit what you need:

```bash
cp .env.example .env
```

The base app works with zero configuration. Only add keys for the features you want.

### API Keys by Feature

#### Alerts (optional)

**Telegram:**
1. Message [@BotFather](https://t.me/BotFather) on Telegram → `/newbot` → copy the token
2. Message [@userinfobot](https://t.me/userinfobot) to get your chat ID
3. Set in `.env`:
```
ENABLE_ALERTS=true
TELEGRAM_BOT_TOKEN=123456:ABC-DEF...
TELEGRAM_CHAT_ID=987654321
```

**Discord:**
1. Open your Discord server → Settings → Integrations → Webhooks → New Webhook
2. Copy the webhook URL
3. Set in `.env`:
```
ENABLE_ALERTS=true
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
```

Alerts fire when the model detects a STRONG or GOOD entry signal, or when probability exceeds the threshold (default 70%). Cooldown is 15 minutes per market to avoid spam.

#### Live Trading (optional, advanced)

> **Default is DRY RUN** — all trades are logged to `./logs/dry-run-trades.csv` without executing. You must explicitly enable live trading.

1. Go to [polymarket.com](https://polymarket.com) → Account Settings → API
2. Generate API credentials
3. Set in `.env`:
```
ENABLE_TRADING=true
TRADING_DRY_RUN=false
POLYMARKET_API_KEY=your-api-key
POLYMARKET_API_SECRET=your-api-secret
POLYMARKET_API_PASSPHRASE=your-passphrase
POLYMARKET_PRIVATE_KEY=your-wallet-private-key
```

**Risk controls** (all configurable in `.env`):
- `MAX_BET_USD=1` — max bet per trade
- `DAILY_LOSS_LIMIT_USD=10` — circuit breaker trips at this loss
- `MAX_OPEN_POSITIONS=3` — max concurrent positions

#### Faster Price Data (optional)

The default public Polygon RPC works fine. For faster Chainlink updates, get a free key from [Alchemy](https://www.alchemy.com/), [Infura](https://infura.io/), or [QuickNode](https://www.quicknode.com/):

```
POLYGON_RPC_URL=https://polygon-mainnet.g.alchemy.com/v2/YOUR_KEY
POLYGON_WSS_URL=wss://polygon-mainnet.g.alchemy.com/v2/YOUR_KEY
```

## Web Dashboard

```bash
npm run start:web
```

Opens at http://localhost:3000 with:
- Real-time signal display with color-coded strength
- Model probability bar (UP vs DOWN)
- Live BTC price, RSI, and probability sparkline charts
- Polymarket prices, orderbook, and liquidity
- All indicators: VWAP, RSI, MACD, Heiken Ashi
- Auto-reconnecting WebSocket — never goes stale

## Backtesting

The app automatically tracks every 15-minute window outcome while running. After collecting data:

```bash
npm run backtest
```

Outputs:
- Model accuracy (overall and by regime/phase)
- Simulated P&L from trade signals
- Sharpe ratio, max drawdown, profit factor
- Results saved to `./logs/backtest-results.json`

Data files in `./logs/`:
- `signals.csv` — every tick with indicators, model probs, edge
- `outcomes.csv` — every 15m window with open/close prices and outcome
- `dry-run-trades.csv` — simulated trades (when trading bot is active)

## MCP Server (AI Integration)

```bash
npm run mcp
```

Add to your Claude Code MCP config to query the assistant from AI:

**6 tools available:**
- `get_current_signal` — current prediction, recommendation, edge
- `get_market_state` — Polymarket prices, liquidity, time left
- `get_price` — BTC prices from all sources
- `get_indicators` — VWAP, RSI, MACD, Heiken Ashi, regime
- `get_history` — recent signal history
- `get_backtest_summary` — latest backtest results

## Multi-Market

```bash
npm run start:multi
```

Track multiple markets simultaneously in a tabular console view. Configure via `markets.json` or `MULTI_MARKET_CONFIG` env var:

```json
[
  { "label": "btc-15m", "slug": "" },
  { "label": "btc-15m-specific", "slug": "btc-updown-15m-1771107300" }
]
```

## Configuration Reference

### Polymarket

- `POLYMARKET_AUTO_SELECT_LATEST` (default: `true`) — auto-pick latest 15m market
- `POLYMARKET_SERIES_ID` (default: `10192`)
- `POLYMARKET_SLUG` (optional) — pin a specific market slug

### Chainlink on Polygon (fallback)

- `POLYGON_RPC_URL` (default: `https://polygon-rpc.com`)
- `POLYGON_RPC_URLS` (optional, comma-separated fallbacks)
- `POLYGON_WSS_URL` / `POLYGON_WSS_URLS` (optional, for real-time fallback)

### Proxy Support

```bash
# HTTP proxy
export HTTPS_PROXY=http://user:pass@host:port

# SOCKS5 proxy
export ALL_PROXY=socks5://user:pass@host:port
```

If your password has special characters (`@`, `:`), URL-encode them: `p@ss:word` → `p%40ss%3Aword`

## Project Structure

```
src/
├── index.js              # Console dashboard (npm start)
├── index-web.js          # Web dashboard entry
├── index-alerts.js       # Console + alerts entry
├── index-trading.js      # Trading bot entry
├── index-multi.js        # Multi-market entry
├── index-full.js         # All features combined
├── config.js             # Configuration from env vars
├── utils.js              # Shared utilities
├── core/
│   ├── poller.js         # Reusable poll loop (data fetching + indicators)
│   └── state.js          # Global state with subscriber pattern
├── data/                 # Data sources (Binance, Chainlink, Polymarket)
├── indicators/           # TA: VWAP, RSI, MACD, Heiken Ashi
├── engines/              # Regime detection, scoring, edge computation
├── alerts/               # Telegram + Discord alert system
├── trading/              # Auto-trading bot with risk management
├── backtest/             # Window tracking + offline analyzer
├── mcp/                  # MCP server for AI integration
├── multi-market/         # Multi-market orchestrator
├── web/                  # Fastify server + dashboard SPA
│   └── static/           # HTML + JS frontend (Chart.js)
└── net/                  # Proxy support
```

## Notes / Troubleshooting

- If you see no Chainlink updates: Polymarket WS might be temporarily unavailable. The bot falls back to on-chain Polygon RPC.
- The console renderer uses `readline.cursorTo` for a stable screen — some terminals may behave differently.
- Web dashboard auto-reconnects if the connection drops.
- Trading is **always dry-run** unless you explicitly set both `ENABLE_TRADING=true` and `TRADING_DRY_RUN=false`.

## Safety

This is not financial advice. Use at your own risk. The trading bot defaults to dry-run mode with strict risk limits for a reason.

created by @krajekis
