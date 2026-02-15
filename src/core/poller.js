/**
 * Reusable poller extracted from index.js main() loop.
 * Returns a tick state object on each cycle so features can hook in.
 */

import { CONFIG } from "../config.js";
import { fetchKlines, fetchLastPrice } from "../data/binance.js";
import { fetchChainlinkBtcUsd } from "../data/chainlink.js";
import { startChainlinkPriceStream } from "../data/chainlinkWs.js";
import { startPolymarketChainlinkPriceStream } from "../data/polymarketLiveWs.js";
import {
  fetchMarketBySlug,
  fetchLiveEventsBySeriesId,
  flattenEventMarkets,
  pickLatestLiveMarket,
  fetchClobPrice,
  fetchOrderBook,
  summarizeOrderBook
} from "../data/polymarket.js";
import { computeSessionVwap, computeVwapSeries } from "../indicators/vwap.js";
import { computeRsi, sma, slopeLast } from "../indicators/rsi.js";
import { computeMacd } from "../indicators/macd.js";
import { computeHeikenAshi, countConsecutive } from "../indicators/heikenAshi.js";
import { detectRegime } from "../engines/regime.js";
import { scoreDirection, applyTimeAwareness } from "../engines/probability.js";
import { computeEdge, decide } from "../engines/edge.js";
import { appendCsvRow, formatNumber, formatPct, getCandleWindowTiming, sleep } from "../utils.js";
import { startBinanceTradeStream } from "../data/binanceWs.js";
import fs from "node:fs";
import path from "node:path";
import { pushState } from "./state.js";

/* ── market resolution (same as original) ── */

const marketCache = { market: null, fetchedAtMs: 0 };

async function resolveCurrentBtc15mMarket() {
  if (CONFIG.polymarket.marketSlug) {
    return await fetchMarketBySlug(CONFIG.polymarket.marketSlug);
  }
  if (!CONFIG.polymarket.autoSelectLatest) return null;

  const now = Date.now();
  if (marketCache.market && now - marketCache.fetchedAtMs < CONFIG.pollIntervalMs) {
    return marketCache.market;
  }

  const events = await fetchLiveEventsBySeriesId({ seriesId: CONFIG.polymarket.seriesId, limit: 25 });
  const markets = flattenEventMarkets(events);
  const picked = pickLatestLiveMarket(markets);

  marketCache.market = picked;
  marketCache.fetchedAtMs = now;
  return picked;
}

function parsePriceToBeat(market) {
  const text = String(market?.question ?? market?.title ?? "");
  if (!text) return null;
  const m = text.match(/price\s*to\s*beat[^\d$]*\$?\s*([0-9][0-9,]*(?:\.[0-9]+)?)/i);
  if (!m) return null;
  const raw = m[1].replace(/,/g, "");
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function extractNumericFromMarket(market) {
  const directKeys = [
    "priceToBeat", "price_to_beat", "strikePrice", "strike_price",
    "strike", "threshold", "thresholdPrice", "threshold_price",
    "targetPrice", "target_price", "referencePrice", "reference_price"
  ];
  for (const k of directKeys) {
    const v = market?.[k];
    const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
    if (Number.isFinite(n)) return n;
  }
  const seen = new Set();
  const stack = [{ obj: market, depth: 0 }];
  while (stack.length) {
    const { obj, depth } = stack.pop();
    if (!obj || typeof obj !== "object") continue;
    if (seen.has(obj) || depth > 6) continue;
    seen.add(obj);
    const entries = Array.isArray(obj) ? obj.entries() : Object.entries(obj);
    for (const [key, value] of entries) {
      const k = String(key).toLowerCase();
      if (value && typeof value === "object") { stack.push({ obj: value, depth: depth + 1 }); continue; }
      if (!/(price|strike|threshold|target|beat)/i.test(k)) continue;
      const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
      if (!Number.isFinite(n)) continue;
      if (n > 1000 && n < 2_000_000) return n;
    }
  }
  return null;
}

function priceToBeatFromPolymarketMarket(market) {
  const n = extractNumericFromMarket(market);
  if (n !== null) return n;
  return parsePriceToBeat(market);
}

function safeFileSlug(x) {
  return String(x ?? "").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/-+/g, "-").replace(/(^-|-$)/g, "").slice(0, 120);
}

function countVwapCrosses(closes, vwapSeries, lookback) {
  if (closes.length < lookback || vwapSeries.length < lookback) return null;
  let crosses = 0;
  for (let i = closes.length - lookback + 1; i < closes.length; i += 1) {
    const prev = closes[i - 1] - vwapSeries[i - 1];
    const cur = closes[i] - vwapSeries[i];
    if (prev === 0) continue;
    if ((prev > 0 && cur < 0) || (prev < 0 && cur > 0)) crosses += 1;
  }
  return crosses;
}

/* ── polymarket snapshot ── */

async function fetchPolymarketSnapshot() {
  const market = await resolveCurrentBtc15mMarket();
  if (!market) return { ok: false, reason: "market_not_found" };

  const outcomes = Array.isArray(market.outcomes) ? market.outcomes : (typeof market.outcomes === "string" ? JSON.parse(market.outcomes) : []);
  const outcomePrices = Array.isArray(market.outcomePrices) ? market.outcomePrices : (typeof market.outcomePrices === "string" ? JSON.parse(market.outcomePrices) : []);
  const clobTokenIds = Array.isArray(market.clobTokenIds) ? market.clobTokenIds : (typeof market.clobTokenIds === "string" ? JSON.parse(market.clobTokenIds) : []);

  let upTokenId = null, downTokenId = null;
  for (let i = 0; i < outcomes.length; i += 1) {
    const label = String(outcomes[i]);
    const tokenId = clobTokenIds[i] ? String(clobTokenIds[i]) : null;
    if (!tokenId) continue;
    if (label.toLowerCase() === CONFIG.polymarket.upOutcomeLabel.toLowerCase()) upTokenId = tokenId;
    if (label.toLowerCase() === CONFIG.polymarket.downOutcomeLabel.toLowerCase()) downTokenId = tokenId;
  }

  const upIndex = outcomes.findIndex((x) => String(x).toLowerCase() === CONFIG.polymarket.upOutcomeLabel.toLowerCase());
  const downIndex = outcomes.findIndex((x) => String(x).toLowerCase() === CONFIG.polymarket.downOutcomeLabel.toLowerCase());
  const gammaYes = upIndex >= 0 ? Number(outcomePrices[upIndex]) : null;
  const gammaNo = downIndex >= 0 ? Number(outcomePrices[downIndex]) : null;

  if (!upTokenId || !downTokenId) {
    return { ok: false, reason: "missing_token_ids", market, outcomes, clobTokenIds, outcomePrices };
  }

  let upBuy = null, downBuy = null;
  let upBookSummary = { bestBid: null, bestAsk: null, spread: null, bidLiquidity: null, askLiquidity: null };
  let downBookSummary = { bestBid: null, bestAsk: null, spread: null, bidLiquidity: null, askLiquidity: null };

  try {
    const [yesBuy, noBuy, upBook, downBook] = await Promise.all([
      fetchClobPrice({ tokenId: upTokenId, side: "buy" }),
      fetchClobPrice({ tokenId: downTokenId, side: "buy" }),
      fetchOrderBook({ tokenId: upTokenId }),
      fetchOrderBook({ tokenId: downTokenId })
    ]);
    upBuy = yesBuy;
    downBuy = noBuy;
    upBookSummary = summarizeOrderBook(upBook);
    downBookSummary = summarizeOrderBook(downBook);
  } catch {
    upBuy = null;
    downBuy = null;
    upBookSummary = { bestBid: Number(market.bestBid) || null, bestAsk: Number(market.bestAsk) || null, spread: Number(market.spread) || null, bidLiquidity: null, askLiquidity: null };
    downBookSummary = { bestBid: null, bestAsk: null, spread: Number(market.spread) || null, bidLiquidity: null, askLiquidity: null };
  }

  return {
    ok: true, market,
    tokens: { upTokenId, downTokenId },
    prices: { up: upBuy ?? gammaYes, down: downBuy ?? gammaNo },
    orderbook: { up: upBookSummary, down: downBookSummary }
  };
}

/* ── poller factory ── */

export function createPoller(config = {}) {
  const pollInterval = config.pollIntervalMs ?? CONFIG.pollIntervalMs;
  let running = false;
  let stopRequested = false;

  // mutable state across ticks
  let prevSpotPrice = null;
  let prevCurrentPrice = null;
  let priceToBeatState = { slug: null, value: null, setAtMs: null };
  const dumpedMarkets = new Set();

  const csvHeader = [
    "timestamp", "entry_minute", "time_left_min", "regime", "signal",
    "model_up", "model_down", "mkt_up", "mkt_down",
    "edge_up", "edge_down", "recommendation",
    "window_id", "price_to_beat", "current_price"
  ];

  // streams — started lazily on first start()
  let binanceStream = null;
  let polymarketLiveStream = null;
  let chainlinkStream = null;

  function ensureStreams() {
    if (!binanceStream) binanceStream = startBinanceTradeStream({ symbol: CONFIG.symbol });
    if (!polymarketLiveStream) polymarketLiveStream = startPolymarketChainlinkPriceStream({});
    if (!chainlinkStream) chainlinkStream = startChainlinkPriceStream({});
  }

  async function pollOnce() {
    ensureStreams();

    const timing = getCandleWindowTiming(CONFIG.candleWindowMinutes);
    const windowId = Math.floor(Date.now() / (CONFIG.candleWindowMinutes * 60_000));

    const wsTick = binanceStream.getLast();
    const wsPrice = wsTick?.price ?? null;
    const polymarketWsTick = polymarketLiveStream.getLast();
    const polymarketWsPrice = polymarketWsTick?.price ?? null;
    const chainlinkWsTick = chainlinkStream.getLast();
    const chainlinkWsPrice = chainlinkWsTick?.price ?? null;

    const chainlinkPromise = polymarketWsPrice !== null
      ? Promise.resolve({ price: polymarketWsPrice, updatedAt: polymarketWsTick?.updatedAt ?? null, source: "polymarket_ws" })
      : chainlinkWsPrice !== null
        ? Promise.resolve({ price: chainlinkWsPrice, updatedAt: chainlinkWsTick?.updatedAt ?? null, source: "chainlink_ws" })
        : fetchChainlinkBtcUsd();

    const [klines1m, klines5m, lastPrice, chainlink, poly] = await Promise.all([
      fetchKlines({ interval: "1m", limit: 240 }),
      fetchKlines({ interval: "5m", limit: 200 }),
      fetchLastPrice(),
      chainlinkPromise,
      fetchPolymarketSnapshot()
    ]);

    const settlementMs = poly.ok && poly.market?.endDate ? new Date(poly.market.endDate).getTime() : null;
    const settlementLeftMin = settlementMs ? (settlementMs - Date.now()) / 60_000 : null;
    const timeLeftMin = settlementLeftMin ?? timing.remainingMinutes;

    const candles = klines1m;
    const closes = candles.map((c) => c.close);

    // indicators
    const vwap = computeSessionVwap(candles);
    const vwapSeries = computeVwapSeries(candles);
    const vwapNow = vwapSeries[vwapSeries.length - 1];
    const lookback = CONFIG.vwapSlopeLookbackMinutes;
    const vwapSlope = vwapSeries.length >= lookback ? (vwapNow - vwapSeries[vwapSeries.length - lookback]) / lookback : null;
    const vwapDist = vwapNow ? (lastPrice - vwapNow) / vwapNow : null;

    const rsiNow = computeRsi(closes, CONFIG.rsiPeriod);
    const rsiSeries = [];
    for (let i = 0; i < closes.length; i += 1) {
      const sub = closes.slice(0, i + 1);
      const r = computeRsi(sub, CONFIG.rsiPeriod);
      if (r !== null) rsiSeries.push(r);
    }
    const rsiMa = sma(rsiSeries, CONFIG.rsiMaPeriod);
    const rsiSlope = slopeLast(rsiSeries, 3);

    const macd = computeMacd(closes, CONFIG.macdFast, CONFIG.macdSlow, CONFIG.macdSignal);
    const ha = computeHeikenAshi(candles);
    const consec = countConsecutive(ha);

    const vwapCrossCount = countVwapCrosses(closes, vwapSeries, 20);
    const volumeRecent = candles.slice(-20).reduce((a, c) => a + c.volume, 0);
    const volumeAvg = candles.slice(-120).reduce((a, c) => a + c.volume, 0) / 6;
    const failedVwapReclaim = vwapNow !== null && vwapSeries.length >= 3
      ? closes[closes.length - 1] < vwapNow && closes[closes.length - 2] > vwapSeries[vwapSeries.length - 2]
      : false;

    // engines
    const regimeInfo = detectRegime({ price: lastPrice, vwap: vwapNow, vwapSlope, vwapCrossCount, volumeRecent, volumeAvg });
    // Orderbook imbalance
    const obUp = poly.ok ? poly.orderbook?.up : null;
    const orderbookImbalance = obUp?.bidLiquidity && obUp?.askLiquidity && obUp.askLiquidity > 0
      ? obUp.bidLiquidity / obUp.askLiquidity
      : null;

    const scored = scoreDirection({ price: lastPrice, vwap: vwapNow, vwapSlope, rsi: rsiNow, rsiSlope, macd, heikenColor: consec.color, heikenCount: consec.count, failedVwapReclaim, orderbookImbalance });
    const timeAware = applyTimeAwareness(scored.rawUp, timeLeftMin, CONFIG.candleWindowMinutes);

    const marketUp = poly.ok ? poly.prices.up : null;
    const marketDown = poly.ok ? poly.prices.down : null;
    const edge = computeEdge({ modelUp: timeAware.adjustedUp, modelDown: timeAware.adjustedDown, marketYes: marketUp, marketNo: marketDown });
    const rec = decide({ remainingMinutes: timeLeftMin, edgeUp: edge.edgeUp, edgeDown: edge.edgeDown, modelUp: timeAware.adjustedUp, modelDown: timeAware.adjustedDown, regime: regimeInfo.regime });

    const signal = rec.action === "ENTER" ? (rec.side === "UP" ? "BUY UP" : "BUY DOWN") : "NO TRADE";

    // price-to-beat tracking
    const spotPrice = wsPrice ?? lastPrice;
    const currentPrice = chainlink?.price ?? null;
    const marketSlug = poly.ok ? String(poly.market?.slug ?? "") : "";
    const marketStartMs = poly.ok && poly.market?.eventStartTime ? new Date(poly.market.eventStartTime).getTime() : null;

    if (marketSlug && priceToBeatState.slug !== marketSlug) {
      priceToBeatState = { slug: marketSlug, value: null, setAtMs: null };
    }
    if (priceToBeatState.slug && priceToBeatState.value === null && currentPrice !== null) {
      const nowMs = Date.now();
      const okToLatch = marketStartMs === null ? true : nowMs >= marketStartMs;
      if (okToLatch) priceToBeatState = { slug: priceToBeatState.slug, value: Number(currentPrice), setAtMs: nowMs };
    }
    const priceToBeat = priceToBeatState.slug === marketSlug ? priceToBeatState.value : null;

    // dump market JSON once per slug
    if (poly.ok && poly.market && priceToBeatState.value === null) {
      const slug = safeFileSlug(poly.market.slug || poly.market.id || "market");
      if (slug && !dumpedMarkets.has(slug)) {
        dumpedMarkets.add(slug);
        try {
          fs.mkdirSync("./logs", { recursive: true });
          fs.writeFileSync(path.join("./logs", `polymarket_market_${slug}.json`), JSON.stringify(poly.market, null, 2), "utf8");
        } catch { /* ignore */ }
      }
    }

    // deltas
    const lastCandle = klines1m.length ? klines1m[klines1m.length - 1] : null;
    const lastClose = lastCandle?.close ?? null;
    const close1mAgo = klines1m.length >= 2 ? klines1m[klines1m.length - 2]?.close ?? null : null;
    const close3mAgo = klines1m.length >= 4 ? klines1m[klines1m.length - 4]?.close ?? null : null;
    const delta1m = lastClose !== null && close1mAgo !== null ? lastClose - close1mAgo : null;
    const delta3m = lastClose !== null && close3mAgo !== null ? lastClose - close3mAgo : null;

    // CSV logging with enhanced columns
    appendCsvRow("./logs/signals.csv", csvHeader, [
      new Date().toISOString(),
      timing.elapsedMinutes.toFixed(3),
      timeLeftMin.toFixed(3),
      regimeInfo.regime,
      signal,
      timeAware.adjustedUp,
      timeAware.adjustedDown,
      marketUp,
      marketDown,
      edge.edgeUp,
      edge.edgeDown,
      rec.action === "ENTER" ? `${rec.side}:${rec.phase}:${rec.strength}` : "NO_TRADE",
      windowId,
      priceToBeat,
      currentPrice
    ]);

    // build tick state
    const tickState = {
      timestamp: Date.now(),
      windowId,
      timing,
      signal,
      scored,
      timeAware,
      rec,
      regimeInfo,
      edge,
      poly,
      prices: { spot: spotPrice, current: currentPrice, priceToBeat },
      indicators: {
        vwap: vwapNow, vwapSlope, vwapDist,
        rsi: rsiNow, rsiMa, rsiSlope,
        macd,
        heiken: { color: consec.color, count: consec.count },
        vwapCrossCount,
        volumeRecent, volumeAvg, failedVwapReclaim
      },
      market: {
        up: marketUp, down: marketDown,
        slug: marketSlug,
        question: poly.ok ? poly.market?.question : null,
        liquidity: poly.ok ? (Number(poly.market?.liquidityNum) || Number(poly.market?.liquidity) || null) : null,
        orderbook: poly.ok ? poly.orderbook : null,
        settlementLeftMin
      },
      deltas: { delta1m, delta3m },
      klines: { klines1m, klines5m },
      prevSpotPrice,
      prevCurrentPrice
    };

    // update prev prices
    prevSpotPrice = spotPrice ?? prevSpotPrice;
    prevCurrentPrice = currentPrice ?? prevCurrentPrice;

    // push to global state
    pushState(tickState);

    return tickState;
  }

  async function start(onTick) {
    if (running) return;
    running = true;
    stopRequested = false;

    while (!stopRequested) {
      try {
        const state = await pollOnce();
        if (onTick) onTick(state);
      } catch (err) {
        if (onTick) {
          try { onTick(null, err); } catch { /* ignore */ }
        }
      }
      await sleep(pollInterval);
    }

    running = false;
  }

  function stop() {
    stopRequested = true;
  }

  return { start, stop, pollOnce };
}
