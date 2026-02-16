/**
 * Volatility surface engine.
 *
 * Models implied volatility for binary prediction markets:
 * - Implied vol extracted from bid-ask spreads and price history
 * - Volatility term structure: how vol changes with time to settlement
 * - Smile/skew detection: asymmetric vol around the money (50/50)
 * - Greeks approximation: delta, gamma, vega equivalents for CLOB markets
 *
 * Binary options pricing: price = N(d1) where d1 = (ln(p/K) + σ²t/2) / (σ√t)
 * We invert this to extract implied vol from market prices.
 */

// In-memory vol surface data
const volSurface = {};
const MAX_SNAPSHOTS = 60;

/**
 * Record market data for volatility surface construction.
 *
 * @param {string} marketId
 * @param {object} data
 * @param {number} data.yesPrice - Current YES price (0-1)
 * @param {number} data.spread - Bid-ask spread
 * @param {number} data.minutesToSettlement - Time until resolution
 * @param {string} data.category
 * @param {number} data.volume24h
 */
export function recordVolData(marketId, data) {
  if (!marketId) return;

  if (!volSurface[marketId]) {
    volSurface[marketId] = { category: data.category || "unknown", snapshots: [] };
  }

  const entry = volSurface[marketId];
  entry.category = data.category || entry.category;
  entry.snapshots.push({
    price: data.yesPrice ?? 0.5,
    spread: data.spread ?? 0.05,
    minsToSettle: data.minutesToSettlement ?? 10000,
    volume: data.volume24h ?? 0,
    timestamp: Date.now()
  });

  if (entry.snapshots.length > MAX_SNAPSHOTS) {
    entry.snapshots = entry.snapshots.slice(-MAX_SNAPSHOTS);
  }
}

/**
 * Compute implied volatility from a binary option price.
 * Uses the relationship: price ≈ N(d1) where we solve for σ.
 * Approximation via bisection method.
 *
 * @param {number} price - Market price (0-1)
 * @param {number} timeYears - Time to settlement in years
 * @returns {number} Implied volatility (annualized)
 */
function impliedVol(price, timeYears) {
  if (price <= 0.01 || price >= 0.99 || timeYears <= 0) return 0;

  // Binary option: price = Φ(d2) where d2 = -σ√t/2 for at-the-money
  // More generally: d2 = (ln(p/(1-p))) / (σ√t) - σ√t/2
  // We use bisection to find σ that matches observed price

  const target = price;
  let lo = 0.01;
  let hi = 5.0;

  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    const sqrtT = Math.sqrt(timeYears);
    const d2 = Math.log(target / (1 - target)) / (mid * sqrtT);
    const modelPrice = normalCDF(d2);

    if (Math.abs(modelPrice - target) < 0.0001) return mid;
    if (modelPrice > target) hi = mid;
    else lo = mid;
  }

  return (lo + hi) / 2;
}

/**
 * Get volatility surface for a specific market.
 *
 * @param {string} marketId
 * @returns {{ impliedVol, historicalVol, termStructure, greeks, smile }|null}
 */
export function getMarketVolSurface(marketId) {
  const entry = volSurface[marketId];
  if (!entry || entry.snapshots.length < 5) return null;

  const snaps = entry.snapshots;
  const latest = snaps[snaps.length - 1];
  const prices = snaps.map(s => s.price);

  // Historical volatility (realized)
  const returns = [];
  for (let i = 1; i < prices.length; i++) {
    if (prices[i - 1] > 0.01 && prices[i - 1] < 0.99) {
      returns.push(Math.log(prices[i] / prices[i - 1]));
    }
  }
  const histVol = returns.length > 2 ? stddev(returns) * Math.sqrt(252 * 24 * 4) : 0; // Annualized from 15-min

  // Implied volatility from current price
  const timeYears = (latest.minsToSettle ?? 10000) / (365.25 * 24 * 60);
  const iv = impliedVol(latest.price, timeYears);

  // Spread-implied vol: wider spreads suggest higher uncertainty
  const spreadVol = (latest.spread ?? 0.05) * 4; // Rough heuristic: 5% spread ≈ 20% vol

  // Term structure: compute IV at different time horizons
  const termStructure = [
    { horizon: "1h", timeYears: 1 / (365.25 * 24), iv: impliedVol(latest.price, 1 / (365.25 * 24)) },
    { horizon: "4h", timeYears: 4 / (365.25 * 24), iv: impliedVol(latest.price, 4 / (365.25 * 24)) },
    { horizon: "1d", timeYears: 1 / 365.25, iv: impliedVol(latest.price, 1 / 365.25) },
    { horizon: "1w", timeYears: 7 / 365.25, iv: impliedVol(latest.price, 7 / 365.25) }
  ].map(t => ({ ...t, iv: Math.round(t.iv * 10000) / 10000 }));

  // Volatility smile: compute IV at different price levels
  const smilePoints = [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8].map(p => ({
    price: p,
    iv: Math.round(impliedVol(p, timeYears) * 10000) / 10000
  }));

  // Check for skew: is IV higher on one side?
  const leftIV = smilePoints.filter(s => s.price < 0.5).reduce((s, v) => s + v.iv, 0) / 3;
  const rightIV = smilePoints.filter(s => s.price > 0.5).reduce((s, v) => s + v.iv, 0) / 3;
  const skew = Math.round((rightIV - leftIV) * 10000) / 10000;

  // Greeks approximation
  const greeks = computeGreeks(latest.price, timeYears, iv);

  return {
    marketId,
    category: entry.category,
    currentPrice: latest.price,
    impliedVol: Math.round(iv * 10000) / 10000,
    historicalVol: Math.round(histVol * 10000) / 10000,
    spreadImpliedVol: Math.round(spreadVol * 10000) / 10000,
    volPremium: Math.round((iv - histVol) * 10000) / 10000, // IV - HV = risk premium
    termStructure,
    smile: smilePoints,
    skew,
    skewLabel: skew > 0.05 ? "right_skew" : skew < -0.05 ? "left_skew" : "symmetric",
    greeks,
    dataPoints: snaps.length
  };
}

/**
 * Compute Greeks for binary option approximation.
 *
 * @param {number} price - Current price
 * @param {number} timeYears - Time to settlement
 * @param {number} vol - Implied volatility
 * @returns {{ delta, gamma, vega, theta }}
 */
function computeGreeks(price, timeYears, vol) {
  if (price <= 0.01 || price >= 0.99 || timeYears <= 0 || vol <= 0) {
    return { delta: 0, gamma: 0, vega: 0, theta: 0 };
  }

  const sqrtT = Math.sqrt(timeYears);
  const d1 = Math.log(price / (1 - price)) / (vol * sqrtT) + vol * sqrtT / 2;
  const nd1 = normalPDF(d1);

  // Delta: sensitivity to underlying probability change
  const delta = Math.round(normalCDF(d1) * 10000) / 10000;

  // Gamma: rate of change of delta
  const gamma = Math.round(nd1 / (price * (1 - price) * vol * sqrtT) * 10000) / 10000;

  // Vega: sensitivity to volatility (per 1% vol change)
  const vega = Math.round(nd1 * sqrtT * 0.01 * 10000) / 10000;

  // Theta: time decay per day
  const theta = Math.round(-nd1 * vol / (2 * sqrtT) / 365.25 * 10000) / 10000;

  return { delta, gamma, vega, theta };
}

/**
 * Get aggregate volatility surface across all markets.
 *
 * @returns {{ markets: object[], summary: object }}
 */
export function getVolSurfaceOverview() {
  const results = [];

  for (const marketId of Object.keys(volSurface)) {
    const surface = getMarketVolSurface(marketId);
    if (surface) results.push(surface);
  }

  if (results.length === 0) {
    return { markets: [], summary: { count: 0, avgIV: 0, avgHV: 0 } };
  }

  results.sort((a, b) => b.impliedVol - a.impliedVol);

  const avgIV = results.reduce((s, r) => s + r.impliedVol, 0) / results.length;
  const avgHV = results.reduce((s, r) => s + r.historicalVol, 0) / results.length;
  const avgPremium = results.reduce((s, r) => s + r.volPremium, 0) / results.length;

  // Category breakdown
  const byCat = {};
  for (const r of results) {
    const cat = r.category || "unknown";
    if (!byCat[cat]) byCat[cat] = { ivs: [], hvs: [], count: 0 };
    byCat[cat].ivs.push(r.impliedVol);
    byCat[cat].hvs.push(r.historicalVol);
    byCat[cat].count++;
  }

  const categoryBreakdown = Object.entries(byCat)
    .map(([cat, d]) => ({
      category: cat,
      avgIV: Math.round(d.ivs.reduce((s, v) => s + v, 0) / d.ivs.length * 10000) / 10000,
      avgHV: Math.round(d.hvs.reduce((s, v) => s + v, 0) / d.hvs.length * 10000) / 10000,
      count: d.count
    }))
    .sort((a, b) => b.avgIV - a.avgIV);

  return {
    markets: results.slice(0, 20),
    summary: {
      count: results.length,
      avgImpliedVol: Math.round(avgIV * 10000) / 10000,
      avgHistoricalVol: Math.round(avgHV * 10000) / 10000,
      avgVolPremium: Math.round(avgPremium * 10000) / 10000,
      highVolMarkets: results.filter(r => r.impliedVol > 1.0).length,
      skewedMarkets: results.filter(r => Math.abs(r.skew) > 0.05).length
    },
    categoryBreakdown
  };
}

// Standard normal CDF (Abramowitz & Stegun approximation)
function normalCDF(x) {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const t = 1 / (1 + p * Math.abs(x));
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x / 2);
  return 0.5 * (1 + sign * y);
}

function normalPDF(x) {
  return Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI);
}

function stddev(arr) {
  if (arr.length === 0) return 0;
  const mean = arr.reduce((s, v) => s + v, 0) / arr.length;
  return Math.sqrt(arr.reduce((s, v) => s + (v - mean) ** 2, 0) / arr.length);
}
