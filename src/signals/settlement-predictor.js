/**
 * Settlement outcome predictor — estimates win probability for open positions.
 * Uses current price movement vs entry price, time remaining, and historical patterns.
 */

import { getDb } from "../subscribers/db.js";

/**
 * Predict settlement outcomes for all open portfolio positions.
 * @returns {object[]} Array of predictions with position data
 */
export function predictOpenPositions() {
  const db = getDb();

  const open = db.prepare(`
    SELECT id, market_id, question, category, side, entry_price, current_price,
           bet_pct, confidence, edge_at_entry, opened_at
    FROM portfolio_positions WHERE status = 'open'
    ORDER BY opened_at DESC
  `).all();

  if (open.length === 0) return [];

  // Get historical win rates by price movement direction for calibration
  const historical = db.prepare(`
    SELECT
      AVG(CASE WHEN outcome = 'WIN' THEN 1.0 ELSE 0.0 END) as base_win_rate,
      COUNT(*) as total
    FROM signal_history WHERE outcome IS NOT NULL
  `).get();

  const baseWinRate = historical?.base_win_rate ?? 0.5;

  return open.map(pos => {
    const prediction = predictPosition(pos, baseWinRate);
    return {
      positionId: pos.id,
      marketId: pos.market_id,
      question: pos.question,
      category: pos.category,
      side: pos.side,
      entryPrice: pos.entry_price,
      currentPrice: pos.current_price,
      betPct: pos.bet_pct,
      confidence: pos.confidence,
      edgeAtEntry: pos.edge_at_entry,
      openedAt: pos.opened_at,
      ...prediction
    };
  });
}

/**
 * Predict outcome for a single position.
 */
function predictPosition(pos, baseWinRate) {
  const entry = pos.entry_price || 0.5;
  const current = pos.current_price || entry;

  // Price momentum: how has price moved since entry?
  const priceDelta = current - entry;
  const priceMoveFavorable = (pos.side === "UP" && priceDelta > 0) || (pos.side === "DOWN" && priceDelta < 0);
  const absDelta = Math.abs(priceDelta);

  // Price proximity to settlement boundaries
  // Prices near 0.0 or 1.0 are more certain (market has resolved its view)
  const certaintyCurrent = Math.abs(current - 0.5) * 2; // 0 = uncertain, 1 = certain

  // Time factor: older positions have more info baked in
  const ageMs = Date.now() - new Date(pos.opened_at).getTime();
  const ageHours = ageMs / 3_600_000;
  const timeFactor = Math.min(1, ageHours / 24); // caps at 1 after 24h

  // Composite win probability
  let winProb = baseWinRate;

  // Adjust for price movement direction (+/- up to 25%)
  if (priceMoveFavorable) {
    winProb += Math.min(0.25, absDelta * 2);
  } else {
    winProb -= Math.min(0.25, absDelta * 2);
  }

  // Adjust for market certainty (higher certainty = more reliable signal)
  if (certaintyCurrent > 0.6) {
    // Market is quite certain — check if it favors our side
    const marketFavorsUs = (pos.side === "UP" && current > 0.5) || (pos.side === "DOWN" && current < 0.5);
    if (marketFavorsUs) {
      winProb += certaintyCurrent * 0.15;
    } else {
      winProb -= certaintyCurrent * 0.15;
    }
  }

  // Confidence at entry provides base edge estimate
  if (pos.confidence) {
    const confFactor = (pos.confidence - 50) / 200; // -0.25 to +0.25
    winProb += confFactor * 0.1;
  }

  // Clamp to [0.05, 0.95]
  winProb = Math.max(0.05, Math.min(0.95, winProb));

  // Unrealized P&L
  let unrealizedPnl;
  if (pos.side === "UP") {
    unrealizedPnl = (current - entry) / entry;
  } else {
    unrealizedPnl = (entry - current) / (1 - entry || 0.5);
  }

  // Risk assessment
  let risk;
  if (winProb >= 0.7) risk = "LOW";
  else if (winProb >= 0.45) risk = "MEDIUM";
  else risk = "HIGH";

  return {
    winProbability: +winProb.toFixed(3),
    winProbabilityPct: +(winProb * 100).toFixed(1),
    unrealizedPnlPct: +(unrealizedPnl * 100).toFixed(2),
    priceMoveFavorable,
    priceDelta: +priceDelta.toFixed(4),
    marketCertainty: +certaintyCurrent.toFixed(2),
    ageHours: +ageHours.toFixed(1),
    risk,
    suggestion: winProb < 0.3 ? "CONSIDER_EXIT" : winProb > 0.75 ? "HOLD_STRONG" : "MONITOR"
  };
}
