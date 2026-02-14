/**
 * MCP tool definitions for the Polymarket BTC 15m assistant.
 */

import { ensurePollerRunning, getCurrentState, getRecentHistory, getBacktestSummary } from "./state-provider.js";

export function registerTools(server) {
  server.tool(
    "get_current_signal",
    "Get the current BTC 15-minute prediction signal, model probabilities, and recommendation",
    {},
    async () => {
      ensurePollerRunning();
      const state = getCurrentState();
      if (!state) return { content: [{ type: "text", text: "No data yet — poller is warming up. Try again in a few seconds." }] };

      const { signal, rec, timeAware, prices, market, regimeInfo, edge } = state;
      const result = {
        signal,
        recommendation: rec,
        model: { up: timeAware?.adjustedUp, down: timeAware?.adjustedDown },
        edge: { up: edge?.edgeUp, down: edge?.edgeDown },
        regime: regimeInfo?.regime,
        market_slug: market?.slug,
        btc_price: prices?.spot,
        timestamp: new Date(state.timestamp).toISOString()
      };

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "get_market_state",
    "Get full Polymarket state: market question, prices, orderbook, liquidity, time left",
    {},
    async () => {
      ensurePollerRunning();
      const state = getCurrentState();
      if (!state) return { content: [{ type: "text", text: "No data yet." }] };

      const { market, prices, timing } = state;
      const result = {
        question: market?.question,
        slug: market?.slug,
        prices: { up: market?.up, down: market?.down },
        liquidity: market?.liquidity,
        orderbook: market?.orderbook,
        price_to_beat: prices?.priceToBeat,
        current_price: prices?.current,
        time_left_min: market?.settlementLeftMin ?? timing?.remainingMinutes
      };

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "get_price",
    "Get current BTC prices from multiple sources",
    {},
    async () => {
      ensurePollerRunning();
      const state = getCurrentState();
      if (!state) return { content: [{ type: "text", text: "No data yet." }] };

      const result = {
        binance_spot: state.prices?.spot,
        chainlink_current: state.prices?.current,
        price_to_beat: state.prices?.priceToBeat,
        delta_1m: state.deltas?.delta1m,
        delta_3m: state.deltas?.delta3m
      };

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "get_indicators",
    "Get all technical indicators: VWAP, RSI, MACD, Heiken Ashi, regime",
    {},
    async () => {
      ensurePollerRunning();
      const state = getCurrentState();
      if (!state) return { content: [{ type: "text", text: "No data yet." }] };

      const result = {
        vwap: state.indicators?.vwap,
        vwap_slope: state.indicators?.vwapSlope,
        vwap_dist: state.indicators?.vwapDist,
        rsi: state.indicators?.rsi,
        rsi_slope: state.indicators?.rsiSlope,
        macd: state.indicators?.macd,
        heiken_ashi: state.indicators?.heiken,
        regime: state.regimeInfo?.regime,
        volume_recent: state.indicators?.volumeRecent,
        volume_avg: state.indicators?.volumeAvg
      };

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "get_history",
    "Get recent signal history (last N ticks)",
    { limit: { type: "number", description: "Number of ticks to return (default 20, max 500)" } },
    async ({ limit }) => {
      ensurePollerRunning();
      const n = Math.min(Math.max(1, limit || 20), 500);
      const history = getRecentHistory(n);

      const compact = history.map((h) => ({
        time: new Date(h.timestamp).toISOString(),
        signal: h.signal,
        model_up: h.timeAware?.adjustedUp?.toFixed(3),
        model_down: h.timeAware?.adjustedDown?.toFixed(3),
        btc: h.prices?.spot,
        regime: h.regimeInfo?.regime
      }));

      return { content: [{ type: "text", text: JSON.stringify(compact, null, 2) }] };
    }
  );

  server.tool(
    "get_backtest_summary",
    "Get the latest backtest results (accuracy, P&L, Sharpe, drawdown)",
    {},
    async () => {
      const summary = getBacktestSummary();
      if (!summary) return { content: [{ type: "text", text: "No backtest results found. Run `node src/backtest/analyzer.js` after collecting window data." }] };
      return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
    }
  );
}
