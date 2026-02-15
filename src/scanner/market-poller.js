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
import { detectRegime } from "../engines/regime.js";
import { scoreDirection, applyTimeAwareness } from "../engines/probability.js";
import { computeEdge, decide } from "../engines/edge.js";
import { CONFIG } from "../config.js";

/**
 * Create an isolated poller for a single market.
 *
 * @param {object} market - Enriched market object from discovery.js
 *   { id, question, outcomes, clobTokenIds, outcomePrices, category, liquidity, endDate, ... }
 */
export function createMarketPoller(market) {
  const isCrypto = market.category === "crypto";
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
        }
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

    // Engines
    const regimeInfo = detectRegime({ price: lastPrice, vwap: vwapNow, vwapSlope, vwapCrossCount, volumeRecent, volumeAvg });
    const scored = scoreDirection({ price: lastPrice, vwap: vwapNow, vwapSlope, rsi: rsiNow, rsiSlope, macd, heikenColor: consec.color, heikenCount: consec.count, failedVwapReclaim });
    const timeAware = applyTimeAwareness(scored.rawUp, timeLeftMin, CONFIG.candleWindowMinutes);

    const marketUp = snapshot.ok ? snapshot.prices.up : null;
    const marketDown = snapshot.ok ? snapshot.prices.down : null;
    const edge = computeEdge({ modelUp: timeAware.adjustedUp, modelDown: timeAware.adjustedDown, marketYes: marketUp, marketNo: marketDown });
    const rec = decide({ remainingMinutes: timeLeftMin, edgeUp: edge.edgeUp, edgeDown: edge.edgeDown, modelUp: timeAware.adjustedUp, modelDown: timeAware.adjustedDown });

    const signal = rec.action === "ENTER" ? (rec.side === "UP" ? "BUY YES" : "BUY NO") : "NO TRADE";

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
      prices: { last: lastPrice, up: marketUp, down: marketDown },
      indicators: {
        vwap: vwapNow, vwapSlope, vwapDist,
        rsi: rsiNow, rsiMa, rsiSlope,
        macd,
        heiken: { color: consec.color, count: consec.count }
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
