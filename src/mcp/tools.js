/**
 * MCP tool definitions for PolySignal.
 * Supports both single-market (legacy) and multi-market scanner modes.
 */

import { ensurePollerRunning, getCurrentState, getRecentHistory, getBacktestSummary } from "./state-provider.js";
import { getRecentSignals, getSignalStats, getTimeSeries, getCalibration, getDrawdownStats, getPerformanceSummary, simulateStrategy } from "../signals/history.js";
import { getOpenPositions, getPortfolioSummary } from "../portfolio/tracker.js";
import { getAllWeights, getLearningStatus } from "../engines/weights.js";

export function registerTools(server) {

  /* ── Scanner tools (multi-market) ── */

  server.tool(
    "get_active_signals",
    "Get all active trading signals from the multi-market scanner. Returns signals with confidence, Kelly sizing, and order flow data.",
    {},
    async () => {
      const signals = getRecentSignals(20);
      const active = signals.filter(s => s.outcome == null).slice(0, 10);

      if (active.length === 0) {
        return { content: [{ type: "text", text: "No active signals right now. The scanner is monitoring markets." }] };
      }

      const compact = active.map(s => ({
        market: s.question?.slice(0, 60),
        category: s.category,
        signal: s.signal,
        side: s.side,
        strength: s.strength,
        edge: s.edge != null ? (s.edge * 100).toFixed(1) + "%" : null,
        confidence: s.confidence,
        confidence_tier: s.confidence_tier,
        kelly_bet: s.kelly_bet_pct != null ? (s.kelly_bet_pct * 100).toFixed(2) + "%" : null,
        flow_quality: s.flow_quality,
        created: s.created_at
      }));

      return { content: [{ type: "text", text: JSON.stringify(compact, null, 2) }] };
    }
  );

  server.tool(
    "get_signal_stats",
    "Get overall signal performance stats: win rate, P&L, by category and strength.",
    {},
    async () => {
      const stats = getSignalStats();
      return { content: [{ type: "text", text: JSON.stringify(stats, null, 2) }] };
    }
  );

  server.tool(
    "get_performance",
    "Get performance summary for a time period (default 7 days): win rate, P&L, best/worst trade.",
    { days: { type: "number", description: "Lookback period in days (default 7, max 90)" } },
    async ({ days }) => {
      const d = Math.min(Math.max(Number(days) || 7, 1), 90);
      const perf = getPerformanceSummary(d);
      return { content: [{ type: "text", text: JSON.stringify(perf, null, 2) }] };
    }
  );

  server.tool(
    "get_analytics",
    "Get analytics data: time series stats, calibration, and drawdown analysis.",
    { days: { type: "number", description: "Lookback period in days (default 7)" } },
    async ({ days }) => {
      const d = Math.min(Math.max(Number(days) || 7, 1), 90);
      const [ts, cal, dd] = await Promise.all([
        getTimeSeries(d),
        getCalibration(),
        getDrawdownStats()
      ]);
      return { content: [{ type: "text", text: JSON.stringify({ timeSeries: ts, calibration: cal, drawdown: { maxDrawdown: dd.maxDrawdown, maxConsecutiveLosses: dd.maxConsecutiveLosses, maxConsecutiveWins: dd.maxConsecutiveWins, currentStreak: dd.currentStreak, totalSettled: dd.totalSettled } }, null, 2) }] };
    }
  );

  server.tool(
    "get_portfolio",
    "Get virtual portfolio: open positions with unrealized P&L and portfolio summary.",
    {},
    async () => {
      const positions = getOpenPositions();
      const summary = getPortfolioSummary();
      return { content: [{ type: "text", text: JSON.stringify({ summary, openPositions: positions.slice(0, 20) }, null, 2) }] };
    }
  );

  server.tool(
    "simulate_strategy",
    "Simulate a trading strategy with filters. Test 'what if I only traded HIGH confidence crypto signals?'",
    {
      minConfidence: { type: "number", description: "Minimum confidence score (0-100)" },
      categories: { type: "string", description: "Comma-separated categories to include (e.g. 'Crypto,Sports')" },
      strengths: { type: "string", description: "Comma-separated strengths (e.g. 'STRONG,GOOD')" },
      minEdge: { type: "number", description: "Minimum edge (e.g. 0.05 for 5%)" }
    },
    async ({ minConfidence, categories, strengths, minEdge }) => {
      const filters = {};
      if (minConfidence != null) filters.minConfidence = Number(minConfidence);
      if (categories) filters.categories = categories.split(",");
      if (strengths) filters.strengths = strengths.split(",");
      if (minEdge != null) filters.minEdge = Number(minEdge);

      const result = simulateStrategy(filters);
      // Trim equity curve for response size
      const compact = { ...result, equityCurve: undefined, curvePoints: result.equityCurve?.length ?? 0 };
      return { content: [{ type: "text", text: JSON.stringify(compact, null, 2) }] };
    }
  );

  server.tool(
    "get_learning_status",
    "Get the ML learning engine status: model version, weight source, recent weight changes.",
    {},
    async () => {
      const status = getLearningStatus();
      return { content: [{ type: "text", text: JSON.stringify(status, null, 2) }] };
    }
  );

  /* ── Legacy single-market tools ── */

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
