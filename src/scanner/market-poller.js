/**
 * Per-market isolated poller for the multi-market scanner.
 *
 * Crypto markets: use Binance klines + existing indicator stack.
 * Non-crypto markets: use CLOB price history as the candle source.
 * Each instance carries its own indicator state — no shared globals.
 */

import { fetchClobCandles } from "./clob-candles.js";
import { fetchKlines } from "../data/binance.js";
import { fetchClobPrice, fetchOrderBook, summarizeOrderBook } from "../data/polymarket.js";
import { computeSessionVwap, computeVwapSeries } from "../indicators/vwap.js";
import { computeRsi, sma, slopeLast } from "../indicators/rsi.js";
import { computeMacd } from "../indicators/macd.js";
import { computeHeikenAshi, countConsecutive } from "../indicators/heikenAshi.js";
import { computeATR, computeBollingerWidth, classifyVolatility } from "../indicators/volatility.js";
import { computeConfluence } from "../engines/confluence.js";
import { getBtcMacroState, computeCorrelationAdj } from "../engines/correlation.js";
import { detectRegimeWithTracking } from "../engines/regime.js";
import { scoreDirection, applyTimeAwareness } from "../engines/probability.js";
import { computeEdge, decide } from "../engines/edge.js";
import { analyzeMarketOrderFlow } from "../engines/orderflow.js";
import { computeConfidence } from "../engines/confidence.js";
import { computeSignalKelly } from "../engines/kelly.js";
import { CONFIG } from "../config.js";

/**
 * Create an isolated poller for a single market.
 *
 * @param {object} market - Enriched market object from discovery.js
 *   { id, question, outcomes, clobTokenIds, outcomePrices, category, liquidity, endDate, ... }
 */
export function createMarketPoller(market) {
  // Detect crypto-based markets: explicit "crypto" category, or tags containing Crypto/Bitcoin/Ethereum
  const cryptoCategories = new Set(["crypto", "Bitcoin", "Ethereum"]);
  const cryptoTags = new Set(["Crypto", "Bitcoin", "Ethereum", "Crypto Prices"]);
  const isCrypto = cryptoCategories.has(market.category)
    || (Array.isArray(market.tags) && market.tags.some((t) => cryptoTags.has(t)));
  const yesTokenId = market.clobTokenIds[0] || null;
  const noTokenId = market.clobTokenIds[1] || null;

  /**
   * Fetch candles for this market.
   * Crypto: Binance klines (hardcoded BTCUSDT for now — expandable later).
   * Non-crypto: CLOB price history for the YES token.
   */
  async function fetchCandles() {
    if (isCrypto) {
      return fetchKlines({ interval: "1m", limit: 240 });
    }
    if (!yesTokenId) return [];
    return fetchClobCandles(yesTokenId, { interval: "1h", limit: 240 });
  }

  /**
   * Fetch Polymarket orderbook snapshot for this market.
   */
  async function fetchSnapshot() {
    if (!yesTokenId || !noTokenId) {
      return { ok: false, reason: "missing_token_ids" };
    }

    try {
      const [yesBuy, noBuy, yesBook, noBook] = await Promise.all([
        fetchClobPrice({ tokenId: yesTokenId, side: "buy" }),
        fetchClobPrice({ tokenId: noTokenId, side: "buy" }),
        fetchOrderBook({ tokenId: yesTokenId }),
        fetchOrderBook({ tokenId: noTokenId })
      ]);

      return {
        ok: true,
        prices: { up: yesBuy, down: noBuy },
        orderbook: {
          up: summarizeOrderBook(yesBook),
          down: summarizeOrderBook(noBook)
        },
        rawBooks: { yes: yesBook, no: noBook }
      };
    } catch {
      // Fallback to gamma prices
      const gammaYes = Number(market.outcomePrices[0]) || null;
      const gammaNo = Number(market.outcomePrices[1]) || null;
      return {
        ok: gammaYes !== null,
        prices: { up: gammaYes, down: gammaNo },
        orderbook: { up: {}, down: {} }
      };
    }
  }

  /**
   * Run one poll cycle: fetch data → compute indicators → score → decide.
   * Returns a tick state compatible with the alert/broadcast system.
   */
  async function pollOnce() {
    const [candles, snapshot] = await Promise.all([
      fetchCandles(),
      fetchSnapshot()
    ]);

    if (!candles.length) {
      return { ok: false, marketId: market.id, reason: "no_candles" };
    }

    const closes = candles.map((c) => c.close);
    const lastPrice = closes[closes.length - 1];

    // Settlement timing
    const settlementMs = market.endDate ? new Date(market.endDate).getTime() : null;
    const settlementLeftMin = settlementMs ? (settlementMs - Date.now()) / 60_000 : null;
    const timeLeftMin = settlementLeftMin ?? CONFIG.candleWindowMinutes;

    // Indicators
    const vwapSeries = computeVwapSeries(candles);
    const vwapNow = vwapSeries[vwapSeries.length - 1];
    const lookback = CONFIG.vwapSlopeLookbackMinutes;
    const vwapSlope = vwapSeries.length >= lookback
      ? (vwapNow - vwapSeries[vwapSeries.length - lookback]) / lookback
      : null;
    const vwapDist = vwapNow ? (lastPrice - vwapNow) / vwapNow : null;

    const rsiNow = computeRsi(closes, CONFIG.rsiPeriod);
    const rsiSeries = [];
    for (let i = 0; i < closes.length; i++) {
      const r = computeRsi(closes.slice(0, i + 1), CONFIG.rsiPeriod);
      if (r !== null) rsiSeries.push(r);
    }
    const rsiMa = sma(rsiSeries, CONFIG.rsiMaPeriod);
    const rsiSlope = slopeLast(rsiSeries, 3);

    const macd = computeMacd(closes, CONFIG.macdFast, CONFIG.macdSlow, CONFIG.macdSignal);
    const ha = computeHeikenAshi(candles);
    const consec = countConsecutive(ha);

    // VWAP cross count
    let vwapCrossCount = 0;
    const crossLookback = Math.min(20, closes.length);
    for (let i = closes.length - crossLookback + 1; i < closes.length; i++) {
      const prev = closes[i - 1] - vwapSeries[i - 1];
      const cur = closes[i] - vwapSeries[i];
      if (prev !== 0 && ((prev > 0 && cur < 0) || (prev < 0 && cur > 0))) vwapCrossCount++;
    }

    const volumeRecent = candles.slice(-20).reduce((a, c) => a + c.volume, 0);
    const volumeAvg = candles.length >= 120
      ? candles.slice(-120).reduce((a, c) => a + c.volume, 0) / 6
      : candles.reduce((a, c) => a + c.volume, 0) / Math.max(candles.length / 20, 1);

    const failedVwapReclaim = vwapNow !== null && vwapSeries.length >= 3
      ? closes[closes.length - 1] < vwapNow && closes[closes.length - 2] > vwapSeries[vwapSeries.length - 2]
      : false;

    // Orderbook imbalance (bid volume / ask volume for YES token)
    const obUp = snapshot.ok ? snapshot.orderbook?.up : null;
    const orderbookImbalance = obUp?.bidLiquidity && obUp?.askLiquidity && obUp.askLiquidity > 0
      ? obUp.bidLiquidity / obUp.askLiquidity
      : null;

    // Volatility indicators
    const atrData = computeATR(candles, 14);
    const bbData = computeBollingerWidth(closes, 20, 2);
    const volInfo = atrData ? classifyVolatility(atrData.atrPct, market.category) : { volRegime: "NORMAL_VOL", volMultiplier: 1.0 };

    // Indicator horizon: how far out current indicators are useful (minutes)
    // This is the "sweet spot" where indicators are most predictive.
    // Beyond this, sqrt decay reduces confidence gradually.
    const indicatorHorizon = isCrypto
      ? (market.category === "Up or Down" || market.category === "15M" ? 15 : 60)
      : 240; // CLOB hourly candles: trends persist for ~4 hours

    // Multi-timeframe confluence (crypto only, cached across pollers)
    const confluenceData = isCrypto ? await computeConfluence() : null;

    // BTC macro state for cross-market correlation (crypto only)
    if (isCrypto) await getBtcMacroState(); // Ensure BTC state is fresh

    // Engines
    const regimeInfo = detectRegimeWithTracking(market.slug || market.id, { price: lastPrice, vwap: vwapNow, vwapSlope, vwapCrossCount, volumeRecent, volumeAvg });
    const scored = scoreDirection({ price: lastPrice, vwap: vwapNow, vwapSlope, rsi: rsiNow, rsiSlope, macd, heikenColor: consec.color, heikenCount: consec.count, failedVwapReclaim, orderbookImbalance });
    const timeAware = applyTimeAwareness(scored.rawUp, timeLeftMin, indicatorHorizon);

    const marketUp = snapshot.ok ? snapshot.prices.up : null;
    const marketDown = snapshot.ok ? snapshot.prices.down : null;
    const edge = computeEdge({ modelUp: timeAware.adjustedUp, modelDown: timeAware.adjustedDown, marketYes: marketUp, marketNo: marketDown });

    // Determine preliminary side for correlation adjustment
    const prelimSide = edge.edgeUp > edge.edgeDown ? "UP" : "DOWN";
    const corrAdj = isCrypto ? computeCorrelationAdj(market, prelimSide) : { correlationAdj: 1.0, reason: "non_crypto" };

    // Apply confluence + correlation as combined multiplier on vol threshold
    const confluenceMult = confluenceData?.confluenceMultiplier ?? 1.0;
    // Confluence boosts/suppresses the effective vol multiplier:
    // If all timeframes agree with the signal → lower threshold (easier to trigger)
    // If timeframes conflict → raise threshold (harder to trigger)
    const effectiveVolMult = volInfo.volMultiplier / confluenceMult;

    const rec = decide({
      remainingMinutes: timeLeftMin,
      edgeUp: edge.edgeUp * corrAdj.correlationAdj,
      edgeDown: edge.edgeDown * corrAdj.correlationAdj,
      modelUp: timeAware.adjustedUp, modelDown: timeAware.adjustedDown,
      regime: regimeInfo.regime, category: market.category,
      volMultiplier: effectiveVolMult
    });

    const signal = rec.action === "ENTER" ? (rec.side === "UP" ? "BUY YES" : "BUY NO") : "NO TRADE";

    // Order flow analysis (uses raw orderbooks, not summaries)
    const orderFlowData = snapshot.ok && snapshot.rawBooks
      ? analyzeMarketOrderFlow(snapshot.rawBooks.yes, snapshot.rawBooks.no, prelimSide)
      : null;

    // Build partial tick for confidence scoring (needs all fields)
    const partialTick = {
      rec, scored, edge, timeAware, regimeInfo,
      volRegime: volInfo.volRegime,
      confluence: confluenceData ? { score: confluenceData.confluence, direction: confluenceData.direction } : null,
      correlation: { adj: corrAdj.correlationAdj, reason: corrAdj.reason },
      orderFlow: orderFlowData,
      prices: { last: lastPrice, up: marketUp, down: marketDown }
    };

    // Confidence score (0-100, only meaningful for active signals)
    const confidenceResult = rec.action === "ENTER" ? computeConfidence(partialTick) : null;
    const confidence = confidenceResult?.score ?? null;

    // Kelly sizing (only for active signals)
    const kellyTick = { ...partialTick, confidence };
    const kellyResult = rec.action === "ENTER" ? computeSignalKelly(kellyTick) : null;

    return {
      ok: true,
      marketId: market.id,
      question: market.question,
      category: market.category,
      slug: market.slug,
      timestamp: Date.now(),
      signal,
      scored,
      timeAware,
      rec,
      regimeInfo,
      edge,
      orderbookImbalance,
      volRegime: volInfo.volRegime,
      atrPct: atrData?.atrPct ?? null,
      bbWidth: bbData?.width ?? null,
      bbSqueeze: bbData?.squeeze ?? false,
      confluence: confluenceData ? {
        score: confluenceData.confluence,
        direction: confluenceData.direction,
        multiplier: confluenceData.confluenceMultiplier
      } : null,
      correlation: {
        adj: corrAdj.correlationAdj,
        reason: corrAdj.reason
      },
      orderFlow: orderFlowData ? {
        alignedScore: orderFlowData.alignedScore,
        pressureLabel: orderFlowData.yes.pressureLabel,
        flowQuality: orderFlowData.flowQuality,
        spreadQuality: orderFlowData.spreadQuality,
        flowSupports: orderFlowData.flowSupports,
        flowConflicts: orderFlowData.flowConflicts,
        totalDepth: orderFlowData.totalDepth,
        bidWallCount: (orderFlowData.yes.bidWalls?.length ?? 0) + (orderFlowData.no.bidWalls?.length ?? 0),
        askWallCount: (orderFlowData.yes.askWalls?.length ?? 0) + (orderFlowData.no.askWalls?.length ?? 0)
      } : null,
      confidence,
      confidenceTier: confidenceResult?.tier ?? null,
      confidenceBreakdown: confidenceResult?.breakdown ?? null,
      kelly: kellyResult ? {
        betPct: kellyResult.kelly.betPct,
        kellyFull: kellyResult.kelly.kellyFull,
        odds: kellyResult.kelly.odds,
        sizingTier: kellyResult.sizingTier
      } : null,
      prices: { last: lastPrice, up: marketUp, down: marketDown },
      indicators: {
        vwap: vwapNow, vwapSlope, vwapDist,
        rsi: rsiNow, rsiMa, rsiSlope,
        macd,
        heiken: { color: consec.color, count: consec.count },
        atr: atrData?.atr ?? null,
        atrPct: atrData?.atrPct ?? null,
        bbWidth: bbData?.width ?? null,
        bbSqueeze: bbData?.squeeze ?? false
      },
      market: {
        up: marketUp, down: marketDown,
        question: market.question,
        liquidity: market.liquidity,
        orderbook: snapshot.ok ? snapshot.orderbook : null,
        settlementLeftMin,
        outcomes: market.outcomes
      },
      settlementLeftMin
    };
  }

  return {
    market,
    pollOnce
  };
}
