/**
 * WebSocket client manager: track connected clients, broadcast state.
 * Supports both single-market tick data and multi-market scanner data.
 */

const clients = new Set();

export function addClient(ws) {
  clients.add(ws);
  ws.on("close", () => clients.delete(ws));
  ws.on("error", () => clients.delete(ws));
}

/**
 * Broadcast single-market tick state (used by start:web, start:full).
 */
export function broadcastState(state) {
  if (clients.size === 0) return;

  // If this is already a scanner payload, broadcast as scanner type
  if (state.scanner) {
    broadcastScannerState(state.scanner);
    return;
  }

  const payload = JSON.stringify({
    type: "tick",
    timestamp: state.timestamp,
    signal: state.signal,
    rec: state.rec,
    model: { up: state.timeAware?.adjustedUp, down: state.timeAware?.adjustedDown },
    edge: { up: state.edge?.edgeUp, down: state.edge?.edgeDown },
    prices: state.prices,
    indicators: {
      vwap: state.indicators?.vwap,
      vwapSlope: state.indicators?.vwapSlope,
      rsi: state.indicators?.rsi,
      rsiSlope: state.indicators?.rsiSlope,
      macd: state.indicators?.macd ? { hist: state.indicators.macd.hist, histDelta: state.indicators.macd.histDelta, macd: state.indicators.macd.macd } : null,
      heiken: state.indicators?.heiken
    },
    market: {
      slug: state.market?.slug,
      question: state.market?.question,
      up: state.market?.up,
      down: state.market?.down,
      liquidity: state.market?.liquidity,
      settlementLeftMin: state.market?.settlementLeftMin
    },
    regime: state.regimeInfo?.regime,
    timing: { remainingMinutes: state.timing?.remainingMinutes },
    deltas: state.deltas
  });

  for (const ws of clients) {
    try { ws.send(payload); } catch { clients.delete(ws); }
  }
}

/**
 * Broadcast multi-market scanner state.
 */
export function broadcastScannerState({ state, signals, stats }) {
  if (clients.size === 0) return;

  // Build market table rows from scanner state
  const markets = [];
  if (state) {
    for (const [id, entry] of Object.entries(state)) {
      const t = entry.lastTick;
      if (!t) continue;
      markets.push({
        id,
        question: t.question || entry.market?.question || "Unknown",
        category: t.category || entry.market?.category || "other",
        signal: t.signal || "NO TRADE",
        rec: t.rec || null,
        modelUp: t.timeAware?.adjustedUp ?? null,
        edgeUp: t.edge?.edgeUp ?? null,
        edgeDown: t.edge?.edgeDown ?? null,
        priceUp: t.prices?.up ?? t.market?.up ?? null,
        priceDown: t.prices?.down ?? t.market?.down ?? null,
        liquidity: t.market?.liquidity ?? entry.market?.liquidity ?? 0,
        regime: t.regimeInfo?.regime ?? null,
        rsi: t.indicators?.rsi ?? null,
        volRegime: t.volRegime ?? null,
        confluence: t.confluence ? t.confluence.score : null,
        confDirection: t.confluence ? t.confluence.direction : null,
        corrAdj: t.correlation?.adj ?? null,
        settlementLeftMin: t.settlementLeftMin ?? t.market?.settlementLeftMin ?? null,
        timestamp: t.timestamp
      });
    }
  }

  const payload = JSON.stringify({
    type: "scanner",
    timestamp: Date.now(),
    stats: stats || {},
    signals: (signals || []).map((s) => ({
      question: s.question,
      category: s.category,
      signal: s.signal,
      side: s.rec?.side,
      strength: s.rec?.strength,
      phase: s.rec?.phase,
      modelUp: s.timeAware?.adjustedUp,
      edge: s.rec?.side === "UP" ? s.edge?.edgeUp : s.edge?.edgeDown,
      priceUp: s.prices?.up,
      priceDown: s.prices?.down,
      settlementLeftMin: s.settlementLeftMin ?? s.market?.settlementLeftMin ?? null,
      volRegime: s.volRegime ?? null,
      confluence: s.confluence ?? null,
      correlation: s.correlation ?? null
    })),
    markets
  });

  for (const ws of clients) {
    try { ws.send(payload); } catch { clients.delete(ws); }
  }
}

export function getClientCount() {
  return clients.size;
}
