# PolySignal

Multi-market Polymarket prediction signal scanner with real-time web dashboard, Telegram/Discord bots, virtual portfolio, and ML-driven confidence scoring.

## Features

### Signal Engine
- **Multi-market scanner** — auto-discovers and tracks 50+ active Polymarket markets
- **Model-based edge detection** — identifies mispriced outcomes across categories (BTC, ETH, sports, politics, crypto)
- **Confidence scoring (0-100)** — 9-factor composite: edge, indicators, confluence, order flow, correlation, volatility, time decay, regime, combo learning
- **Kelly Criterion sizing** — risk-adjusted position recommendations per signal
- **Signal strength tiers** — STRONG / GOOD classification with multi-indicator agreement

### Data & Indicators
- **Polymarket CLOB** — real-time YES/NO prices, orderbook depth, liquidity
- **Binance spot** — BTC klines (1m/5m/15m), last price
- **Chainlink oracle** — on-chain BTC/USD price fallback (Polygon RPC with rotation)
- **Technical indicators** — VWAP, RSI, MACD, Heiken Ashi, regime detection
- **Order flow analysis** — bid/ask depth, wall detection, spread quality, flow alignment
- **Multi-timeframe confluence** — 1m/5m/15m agreement scoring
- **BTC correlation adjustment** — macro price movement impact on crypto markets
- **Volatility regime** — LOW/NORMAL/HIGH detection for confidence gating

### Web Dashboard
- **Real-time signal cards** — side, edge, confidence, Kelly sizing, flow badges
- **All tracked markets table** — sortable, filterable by category
- **Analytics tab** — equity curve, daily win rate, category breakdown, calibration chart, signal volume
- **Portfolio tab** — open positions, realized P&L, trade history
- **Strategy simulator** — backtest with configurable filters (confidence, edge, category, strength, side)
- **Public performance page** (`/stats.html`) — standalone stats dashboard, no auth required
- **WebSocket** — auto-reconnecting live data stream
- **Browser notifications** — desktop alerts + audio tones for new signals

### Bots
- **Telegram** — private (real-time) + public (5-min delayed) channels, settlement notifications
- **Discord** — premium + free channels with rich embeds, settlement notifications
- **Settlement tracking** — WIN/LOSS results pushed to both platforms

### ML & Learning
- **Dynamic weights** — learns from outcome history, adjusts indicator scoring every 10 minutes
- **Combo feature learning** — VWAP+RSI pair win rates feed back into confidence scoring
- **Feature win rates** — per-indicator-state performance tracking
- **Weight audit trail** — tracks model version changes over time

### Monetization
- **3-tier subscription** — Free / Basic ($19/mo) / Pro ($49/mo) with feature gates
- **Magic link auth** — passwordless email login via Resend
- **Stripe webhooks** — subscription lifecycle management
- **API key system** — `pk_live_*` keys for programmatic access (SHA-256 hashed)

### Notifications
- **Custom webhooks** — register HTTPS endpoints to receive signal JSON payloads
- **Email alerts** — configurable confidence threshold and category filters via Resend
- **Auto-deactivation** — webhooks disabled after 10 consecutive failures

### Infrastructure
- **Resilience layer** — retry with exponential backoff + jitter, circuit breaker (5 failures = 1 min cooldown)
- **Per-source health tracking** — uptime, latency, error rates for all data sources
- **Security middleware** — Helmet (12 headers), CORS, rate limiting (100 req/min)
- **Health endpoints** — `/health` (simple) + `/health/detailed` (per-source metrics, memory, scanner stats)
- **Data retention** — auto-void stale signals (>24h), purge settled >90 days
- **MCP server** — 13 tools for Claude Code / AI integration
- **Virtual portfolio** — SQLite-backed position tracking with auto-settlement

## Quick Start

```bash
git clone <repo-url>
cd PolymarketBTC15mAssistant
npm install
node src/server.js
```

**No API keys required** for the base scanner. All data sources are public.

Dashboard opens at http://localhost:3000

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `WEB_PORT` | No | Web server port (default: 3000) |
| `TELEGRAM_BOT_TOKEN` | No | Telegram bot token from @BotFather |
| `TELEGRAM_PRIVATE_CHANNEL_ID` | No | Real-time signal channel |
| `TELEGRAM_PUBLIC_CHANNEL_ID` | No | Delayed (5min) free channel |
| `DISCORD_BOT_TOKEN` | No | Discord bot token |
| `DISCORD_PREMIUM_CHANNEL_ID` | No | Real-time signal channel |
| `DISCORD_FREE_CHANNEL_ID` | No | Delayed free channel |
| `RESEND_API_KEY` | No | Resend API key for magic links + email alerts |
| `RESEND_FROM` | No | From address (default: `PolySignal <alerts@polysignal.io>`) |
| `STRIPE_WEBHOOK_SECRET` | No | Stripe webhook signing secret |
| `JWT_SECRET` | No | JWT signing key for sessions |
| `CORS_ORIGIN` | No | CORS origin (default: allow all) |
| `POLYGON_RPC_URL` | No | Custom Polygon RPC (default: public) |
| `POLYGON_RPC_URLS` | No | Comma-separated fallback RPCs |
| `HTTPS_PROXY` / `ALL_PROXY` | No | HTTP/SOCKS5 proxy support |

## API Endpoints

### Public (no auth)
- `GET /health` — uptime check
- `GET /health/detailed` — per-source health, scanner stats, memory
- `GET /api/state` — current scanner state
- `GET /api/scanner/state` — all tracked markets
- `GET /api/scanner/signals` — active signals
- `GET /api/scanner/stats` — scanner statistics
- `GET /api/signals/recent?limit=50` — recent signal history
- `GET /api/signals/stats` — win rate, category breakdown
- `GET /api/public-stats?days=30` — full performance dashboard data
- `GET /api/plan` — current user plan (free if not logged in)
- `GET /api/simulate?minConfidence=60&categories=Bitcoin` — strategy simulator

### Analytics (no auth)
- `GET /api/analytics/timeseries?days=7` — daily bucketed stats
- `GET /api/analytics/calibration` — confidence calibration data
- `GET /api/analytics/drawdown` — equity curve + drawdown stats
- `GET /api/analytics/performance?days=7` — Sharpe, P&L, best/worst trade
- `GET /api/analytics/market/:marketId` — per-market stats
- `GET /api/analytics/export?format=csv&days=30` — signal export

### Portfolio (no auth)
- `GET /api/portfolio/positions` — open virtual positions
- `GET /api/portfolio/summary` — portfolio KPIs
- `GET /api/portfolio/recent?limit=20` — recent trades

### Learning (no auth)
- `GET /api/learning/weights` — current model weights + combos
- `GET /api/learning/features` — per-feature win rates
- `GET /api/learning/combos` — combo (pair) win rates
- `GET /api/learning/status` — learning system status

### Authenticated (session or API key)
- `POST /api/auth/login` — send magic link
- `GET /auth/verify?token=` — verify magic link
- `GET /api/auth/me` — current user info
- `POST /api/keys/generate` — create API key
- `GET /api/keys` — list API keys
- `DELETE /api/keys/:id` — revoke API key
- `POST /api/webhooks` — register webhook endpoint
- `GET /api/webhooks` — list webhooks
- `DELETE /api/webhooks/:id` — remove webhook
- `GET /api/email-prefs` — email alert preferences
- `POST /api/email-prefs` — update email alert preferences

### Programmatic API (X-API-Key header)
- `GET /api/v1/signals` — recent signals
- `GET /api/v1/stats` — signal statistics
- `GET /api/v1/scanner` — active signals + scanner stats

## Project Structure

```
src/
├── server.js              # Unified entry: scanner + web + bots
├── config.js              # Configuration from env vars
├── utils.js               # Shared utilities
├── core/
│   ├── poller.js          # Single-market poll loop
│   └── state.js           # Global state with subscriber pattern
├── scanner/
│   ├── orchestrator.js    # Multi-market scanner orchestrator
│   └── market-poller.js   # Per-market data collection + analysis
├── data/
│   ├── binance.js         # Binance klines + spot price (resilient)
│   ├── polymarket.js      # CLOB prices, orderbook, market discovery (resilient)
│   └── chainlink.js       # On-chain BTC/USD oracle (resilient)
├── engines/
│   ├── probability.js     # Model probability scoring with learned weights
│   ├── confidence.js      # 9-factor confidence scoring (0-100)
│   ├── weights.js         # Dynamic weight learning + combo multipliers
│   ├── edge.js            # Edge computation (model vs market)
│   └── kelly.js           # Kelly Criterion position sizing
├── indicators/            # VWAP, RSI, MACD, Heiken Ashi
├── signals/
│   └── history.js         # SQLite signal history, analytics, simulator
├── portfolio/
│   └── tracker.js         # Virtual portfolio with auto-settlement
├── subscribers/
│   ├── db.js              # SQLite connection manager
│   ├── manager.js         # Subscriber CRUD + plan management
│   ├── api-keys.js        # API key generation + verification
│   └── stripe-webhook.js  # Stripe subscription lifecycle
├── notifications/
│   └── dispatch.js        # Webhook + email alert dispatch
├── bots/
│   ├── telegram/          # Bot + broadcaster with settlement messages
│   └── discord/           # Bot + broadcaster with settlement embeds
├── net/
│   ├── proxy.js           # HTTP/SOCKS5 proxy support
│   └── resilience.js      # Retry, circuit breaker, health tracking
├── mcp/
│   ├── server.js          # MCP stdio server
│   └── tools.js           # 13 MCP tools
├── web/
│   ├── server.js          # Fastify HTTP + WS + all API routes
│   ├── ws-handler.js      # WebSocket client management
│   ├── auth.js            # Magic link auth + JWT sessions
│   └── static/
│       ├── index.html     # Main dashboard SPA
│       ├── app.js         # Dashboard client JS
│       └── stats.html     # Public performance dashboard
├── backtest/              # Window tracking + offline analyzer
├── trading/               # Auto-trading bot (dry-run default)
└── alerts/                # Legacy alert system
```

## Development Tiers

Built incrementally across 7 tiers:

1. **Core Scanner** — multi-market discovery, staggered polling, TA indicators, edge detection
2. **Dashboard** — real-time web UI, signal cards, markets table, WebSocket streaming
3. **Bots & Monetization** — Telegram/Discord, magic link auth, Stripe, 3-tier subscriptions
4. **Analytics** — signal history DB, drill-down modal, confidence scoring, Kelly sizing, order flow, ML feedback loop
5. **Portfolio & Gates** — virtual portfolio, strategy simulator API, feature gates, MCP upgrade
6. **Production Hardening** — resilience layer, security middleware, health monitoring, public performance dashboard, settlement tracking
7. **Intelligence & Integration** — strategy simulator UI, combo feature learning, API keys, webhooks, email alerts, settlement notifications

## Safety

This is not financial advice. Use at your own risk.

created by @krajekis
