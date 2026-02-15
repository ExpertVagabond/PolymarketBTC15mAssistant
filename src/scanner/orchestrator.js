/**
 * Scanner orchestrator: manages a pool of market pollers.
 * Discovers markets, starts/stops pollers, aggregates signals.
 * Emits events for downstream consumers (bots, alerts, web).
 */

import { EventEmitter } from "node:events";
import { discoverMarkets, getCachedMarkets } from "./discovery.js";
import { createMarketPoller } from "./market-poller.js";
import { CONFIG } from "../config.js";
import { sleep } from "../utils.js";

/**
 * Create the scanner orchestrator.
 * @param {object} opts
 * @param {number} opts.pollIntervalMs  - ms between each market poll cycle (default: 30s)
 * @param {number} opts.maxMarkets      - max markets to track (default: 50)
 * @param {number} opts.minLiquidity    - minimum liquidity filter (default: 100)
 * @param {string[]} opts.categories    - category filter (null = all)
 * @param {number} opts.staggerMs       - ms delay between starting each market poll (rate limit friendly)
 */
export function createOrchestrator(opts = {}) {
  const pollIntervalMs = opts.pollIntervalMs ?? CONFIG.scanner?.pollIntervalMs ?? 30_000;
  const maxMarkets = opts.maxMarkets ?? CONFIG.scanner?.maxMarkets ?? 50;
  const minLiquidity = opts.minLiquidity ?? CONFIG.scanner?.minLiquidity ?? 100;
  const categories = opts.categories ?? CONFIG.scanner?.categories ?? null;
  const staggerMs = opts.staggerMs ?? 200; // 200ms between market polls to avoid rate limit bursts

  const emitter = new EventEmitter();
  const pollers = new Map(); // marketId → { poller, lastTick }
  let running = false;
  let stopRequested = false;

  /**
   * Refresh the market list and start/stop pollers accordingly.
   */
  async function refreshMarkets() {
    const markets = await discoverMarkets({ maxMarkets, minLiquidity, categories });

    const activeIds = new Set(markets.map((m) => m.id));

    // Stop pollers for markets that are no longer active
    for (const [id, entry] of pollers) {
      if (!activeIds.has(id)) {
        pollers.delete(id);
        emitter.emit("market:removed", { marketId: id, question: entry.poller.market.question });
      }
    }

    // Start pollers for new markets
    for (const market of markets) {
      if (!pollers.has(market.id)) {
        const poller = createMarketPoller(market);
        pollers.set(market.id, { poller, lastTick: null });
        emitter.emit("market:added", { marketId: market.id, question: market.question, category: market.category });
      }
    }

    return markets;
  }

  /**
   * Poll all active markets once (staggered to respect rate limits).
   */
  async function pollAllOnce() {
    const entries = [...pollers.values()];
    const results = [];

    for (const entry of entries) {
      if (stopRequested) break;

      try {
        const tick = await entry.poller.pollOnce();
        entry.lastTick = tick;
        results.push(tick);

        if (tick.ok && tick.rec?.action === "ENTER") {
          emitter.emit("signal:enter", tick);
        }
      } catch (err) {
        emitter.emit("error", { marketId: entry.poller.market.id, error: err.message });
      }

      // Stagger to avoid rate limit bursts
      if (staggerMs > 0 && entries.indexOf(entry) < entries.length - 1) {
        await sleep(staggerMs);
      }
    }

    emitter.emit("cycle:complete", {
      timestamp: Date.now(),
      marketsPolled: results.length,
      signals: results.filter((t) => t.ok && t.rec?.action === "ENTER").length
    });

    return results;
  }

  /**
   * Start the scanner loop.
   */
  async function start() {
    if (running) return;
    running = true;
    stopRequested = false;

    emitter.emit("scanner:start", { timestamp: Date.now() });

    // Initial market discovery
    const markets = await refreshMarkets();
    emitter.emit("scanner:ready", { marketCount: markets.length });

    let cycleCount = 0;

    while (!stopRequested) {
      // Refresh market list every 10 cycles (~5 min at 30s interval)
      if (cycleCount > 0 && cycleCount % 10 === 0) {
        await refreshMarkets();
      }

      await pollAllOnce();
      cycleCount++;

      if (!stopRequested) {
        await sleep(pollIntervalMs);
      }
    }

    running = false;
    emitter.emit("scanner:stop", { timestamp: Date.now() });
  }

  function stop() {
    stopRequested = true;
  }

  /**
   * Get current state of all tracked markets.
   */
  function getState() {
    const state = {};
    for (const [id, entry] of pollers) {
      state[id] = {
        market: entry.poller.market,
        lastTick: entry.lastTick
      };
    }
    return state;
  }

  /**
   * Get the latest ticks that have active signals.
   */
  function getActiveSignals() {
    const signals = [];
    for (const [, entry] of pollers) {
      if (entry.lastTick?.ok && entry.lastTick?.rec?.action === "ENTER") {
        signals.push(entry.lastTick);
      }
    }
    return signals.sort((a, b) => (b.edge?.edgeUp ?? 0) - (a.edge?.edgeUp ?? 0));
  }

  /**
   * Get summary stats.
   */
  function getStats() {
    const markets = getCachedMarkets();
    const tracked = pollers.size;
    const withSignal = [...pollers.values()].filter((e) => e.lastTick?.ok && e.lastTick?.rec?.action === "ENTER").length;
    const categories = {};
    for (const [, entry] of pollers) {
      const cat = entry.poller.market.category || "other";
      categories[cat] = (categories[cat] || 0) + 1;
    }
    return { discovered: markets.length, tracked, withSignal, categories };
  }

  return {
    start,
    stop,
    getState,
    getActiveSignals,
    getStats,
    refreshMarkets,
    pollAllOnce,
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
    emitter
  };
}
