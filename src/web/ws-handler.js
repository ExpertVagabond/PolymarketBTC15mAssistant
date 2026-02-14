/**
 * WebSocket client manager: track connected clients, broadcast state.
 */

const clients = new Set();

export function addClient(ws) {
  clients.add(ws);
  ws.on("close", () => clients.delete(ws));
  ws.on("error", () => clients.delete(ws));
}

export function broadcastState(state) {
  if (clients.size === 0) return;

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
      macd: state.indicators?.macd ? { hist: state.indicators.macd.hist, histDelta: state.indicators.macd.histDelta } : null,
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

export function getClientCount() {
  return clients.size;
}
