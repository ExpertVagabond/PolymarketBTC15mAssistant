/**
 * Real-time P&L tracker: calculates unrealized P&L for all open positions
 * by fetching current token prices from the CLOB API.
 * Caches prices for 10s to avoid rate limiting.
 */

import { getDb } from "../subscribers/db.js";
import { CONFIG } from "../config.js";

const PRICE_CACHE_TTL = 10_000; // 10 seconds
const priceCache = new Map(); // tokenId -> { price, cachedAt }

/**
 * Fetch a single token's current price (cached).
 */
async function getCachedPrice(tokenId) {
  if (!tokenId) return null;
  const cached = priceCache.get(tokenId);
  if (cached && Date.now() - cached.cachedAt < PRICE_CACHE_TTL) {
    return cached.price;
  }

  try {
    const url = new URL("/price", CONFIG.clobBaseUrl);
    url.searchParams.set("token_id", tokenId);
    url.searchParams.set("side", "BUY");
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const data = await res.json();
    const price = data.price != null ? Number(data.price) : null;
    if (price != null) {
      priceCache.set(tokenId, { price, cachedAt: Date.now() });
    }
    return price;
  } catch {
    return null;
  }
}

/**
 * Get real-time unrealized P&L for all open positions.
 * Fetches current prices and calculates per-position and aggregate P&L.
 */
export async function getRealtimePnl() {
  let db;
  try {
    db = getDb();
  } catch {
    return { positions: [], aggregate: { totalUnrealizedPnl: 0, totalExposure: 0, positionCount: 0 } };
  }

  let openExecs;
  try {
    openExecs = db.prepare(
      "SELECT id, market_id, token_id, side, amount, entry_price, question, category, dry_run, opened_at FROM trade_executions WHERE status = 'open' ORDER BY opened_at DESC"
    ).all();
  } catch {
    return { positions: [], aggregate: { totalUnrealizedPnl: 0, totalExposure: 0, positionCount: 0 } };
  }

  if (openExecs.length === 0) {
    return { positions: [], aggregate: { totalUnrealizedPnl: 0, totalExposure: 0, positionCount: 0 } };
  }

  // Fetch prices for all unique tokens in parallel
  const tokenIds = [...new Set(openExecs.map(e => e.token_id).filter(Boolean))];
  await Promise.allSettled(tokenIds.map(id => getCachedPrice(id)));

  let totalUnrealizedPnl = 0;
  let totalExposure = 0;
  const positions = [];

  for (const exec of openExecs) {
    const currentPrice = exec.token_id ? await getCachedPrice(exec.token_id) : null;
    const entryPrice = exec.entry_price || 0;
    const amount = exec.amount || 0;

    let unrealizedPnlPct = 0;
    let unrealizedPnlUsd = 0;

    if (currentPrice != null && entryPrice > 0) {
      unrealizedPnlPct = ((currentPrice - entryPrice) / entryPrice) * 100;
      unrealizedPnlUsd = (unrealizedPnlPct / 100) * amount;
    }

    totalUnrealizedPnl += unrealizedPnlUsd;
    totalExposure += amount;

    const ageMs = Date.now() - new Date(exec.opened_at).getTime();

    positions.push({
      executionId: exec.id,
      marketId: exec.market_id,
      question: exec.question,
      category: exec.category,
      side: exec.side,
      amount,
      entryPrice,
      currentPrice,
      unrealizedPnlPct: Math.round(unrealizedPnlPct * 100) / 100,
      unrealizedPnlUsd: Math.round(unrealizedPnlUsd * 100) / 100,
      dryRun: !!exec.dry_run,
      ageMinutes: Math.round(ageMs / 60_000),
      priceAvailable: currentPrice != null
    });
  }

  return {
    positions,
    aggregate: {
      totalUnrealizedPnl: Math.round(totalUnrealizedPnl * 100) / 100,
      totalExposure: Math.round(totalExposure * 100) / 100,
      positionCount: positions.length,
      pricesAvailable: positions.filter(p => p.priceAvailable).length
    },
    cachedPrices: tokenIds.length,
    timestamp: new Date().toISOString()
  };
}
