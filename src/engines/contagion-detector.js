/**
 * Cross-market contagion & correlation regime detector.
 *
 * Detects systemic linkages and spillover effects:
 * - Rolling correlation matrix from recent trade outcomes
 * - Market clustering via correlation thresholds
 * - Spillover prediction (if A moves, expected move in B)
 * - Correlation regime detection (tight/loose/breaking)
 * - Contagion risk scoring for portfolio-level warnings
 *
 * Complements correlation.js (pair-wise) by escalating
 * to portfolio-level systemic risk assessment.
 */

import { getDb } from "../subscribers/db.js";

// In-memory tick buffer for real-time correlation
const tickBuffer = {};  // marketId → [{ price, timestamp }]
const BUFFER_SIZE = 120; // 2 hours of minute-level ticks

/**
 * Record a price tick for correlation tracking.
 *
 * @param {string} marketId
 * @param {number} price
 */
export function recordTick(marketId, price) {
  if (!tickBuffer[marketId]) tickBuffer[marketId] = [];
  tickBuffer[marketId].push({ price, timestamp: Date.now() });
  if (tickBuffer[marketId].length > BUFFER_SIZE) {
    tickBuffer[marketId] = tickBuffer[marketId].slice(-BUFFER_SIZE);
  }
}

/**
 * Build correlation matrix from recent trade P&L across markets.
 *
 * @param {number} days - Lookback
 * @returns {{ matrix, markets, eigenAnalysis, avgCorrelation }}
 */
export function buildCorrelationMatrix(days = 7) {
  const db = getDb();
  const daysOffset = `-${Math.min(Math.max(days, 1), 90)} days`;

  const rows = db.prepare(`
    SELECT market_id,
           strftime('%Y-%m-%d %H', created_at) as hour_bucket,
           AVG(realized_pnl) as avg_pnl,
           COUNT(*) as trades
    FROM trade_executions
    WHERE created_at > datetime('now', ?)
    AND status IN ('WIN', 'LOSS')
    AND realized_pnl IS NOT NULL
    GROUP BY market_id, hour_bucket
    HAVING COUNT(*) >= 1
    ORDER BY hour_bucket
  `).all(daysOffset);

  // Build time series per market
  const series = {};
  for (const r of rows) {
    if (!series[r.market_id]) series[r.market_id] = {};
    series[r.market_id][r.hour_bucket] = r.avg_pnl;
  }

  const markets = Object.keys(series).filter(m => Object.keys(series[m]).length >= 5);
  if (markets.length < 2) {
    return { matrix: {}, markets: [], eigenAnalysis: null, avgCorrelation: 0, message: "insufficient_data" };
  }

  // Get all time buckets
  const allBuckets = [...new Set(markets.flatMap(m => Object.keys(series[m])))].sort();

  // Compute NxN correlation matrix
  const matrix = {};
  let totalCorr = 0;
  let corrCount = 0;

  for (let i = 0; i < markets.length; i++) {
    matrix[markets[i]] = {};
    for (let j = 0; j < markets.length; j++) {
      if (i === j) {
        matrix[markets[i]][markets[j]] = 1.0;
        continue;
      }
      const corr = pearsonCorrelation(series[markets[i]], series[markets[j]], allBuckets);
      matrix[markets[i]][markets[j]] = round3(corr);
      if (i < j) {
        totalCorr += Math.abs(corr);
        corrCount++;
      }
    }
  }

  // Eigenvalue proxy via power iteration on correlation values
  const eigenAnalysis = computeEigenProxy(matrix, markets);

  return {
    matrix,
    markets,
    marketCount: markets.length,
    eigenAnalysis,
    avgCorrelation: corrCount > 0 ? round3(totalCorr / corrCount) : 0,
    lookbackDays: days
  };
}

/**
 * Detect market clusters — groups that move together.
 *
 * @param {number} days
 * @param {number} threshold - Correlation threshold for clustering
 * @returns {{ clusters, isolatedMarkets, clusterStability }}
 */
export function detectMarketClusters(days = 7, threshold = 0.5) {
  const { matrix, markets } = buildCorrelationMatrix(days);
  if (markets.length < 2) {
    return { clusters: [], isolatedMarkets: [], clusterStability: 0 };
  }

  // Simple agglomerative clustering
  const assigned = new Set();
  const clusters = [];

  for (const m of markets) {
    if (assigned.has(m)) continue;
    const cluster = [m];
    assigned.add(m);

    for (const other of markets) {
      if (assigned.has(other)) continue;
      // Check if correlated with all cluster members
      const allCorrelated = cluster.every(
        cm => Math.abs(matrix[cm]?.[other] || 0) >= threshold
      );
      if (allCorrelated) {
        cluster.push(other);
        assigned.add(other);
      }
    }

    clusters.push({
      markets: cluster,
      size: cluster.length,
      avgIntraCorrelation: cluster.length > 1
        ? round3(avgPairCorrelation(matrix, cluster))
        : 1.0
    });
  }

  const isolated = clusters.filter(c => c.size === 1).map(c => c.markets[0]);
  const multiClusters = clusters.filter(c => c.size > 1);

  return {
    clusters: multiClusters,
    isolatedMarkets: isolated,
    totalClusters: multiClusters.length,
    clusterStability: multiClusters.length > 0
      ? round3(multiClusters.reduce((s, c) => s + c.avgIntraCorrelation, 0) / multiClusters.length)
      : 0
  };
}

/**
 * Predict spillover: if source market moves, what happens to target?
 *
 * @param {number} days
 * @returns {{ pairs, systemicRisk }}
 */
export function getSpilloverMap(days = 14) {
  const db = getDb();
  const daysOffset = `-${Math.min(Math.max(days, 1), 90)} days`;

  // Get hourly P&L by market
  const rows = db.prepare(`
    SELECT market_id,
           strftime('%Y-%m-%d %H', created_at) as hour_bucket,
           SUM(realized_pnl) as total_pnl,
           COUNT(*) as trades
    FROM trade_executions
    WHERE created_at > datetime('now', ?)
    AND status IN ('WIN', 'LOSS')
    AND realized_pnl IS NOT NULL
    GROUP BY market_id, hour_bucket
    HAVING COUNT(*) >= 1
  `).all(daysOffset);

  const series = {};
  for (const r of rows) {
    if (!series[r.market_id]) series[r.market_id] = {};
    series[r.market_id][r.hour_bucket] = r.total_pnl;
  }

  const markets = Object.keys(series).filter(m => Object.keys(series[m]).length >= 5);
  const allBuckets = [...new Set(markets.flatMap(m => Object.keys(series[m])))].sort();

  const pairs = [];
  for (let i = 0; i < markets.length; i++) {
    for (let j = i + 1; j < markets.length; j++) {
      // Lag-1 correlation (A leads B by 1 hour)
      const lagAB = laggedCorrelation(series[markets[i]], series[markets[j]], allBuckets, 1);
      const lagBA = laggedCorrelation(series[markets[j]], series[markets[i]], allBuckets, 1);

      const maxLag = Math.max(Math.abs(lagAB), Math.abs(lagBA));
      if (maxLag > 0.25) {
        const leader = Math.abs(lagAB) > Math.abs(lagBA) ? markets[i] : markets[j];
        const follower = leader === markets[i] ? markets[j] : markets[i];
        const coeff = leader === markets[i] ? lagAB : lagBA;

        // Compute beta (regression coefficient)
        const beta = computeBeta(series[leader], series[follower], allBuckets);

        pairs.push({
          leader: leader.slice(0, 20),
          follower: follower.slice(0, 20),
          laggedCorrelation: round3(coeff),
          beta: round3(beta),
          direction: coeff > 0 ? "same" : "inverse",
          strength: maxLag > 0.6 ? "strong" : maxLag > 0.4 ? "moderate" : "weak"
        });
      }
    }
  }

  pairs.sort((a, b) => Math.abs(b.laggedCorrelation) - Math.abs(a.laggedCorrelation));

  // Systemic risk: how interconnected are markets?
  const strongLinks = pairs.filter(p => p.strength === "strong").length;
  const possibleLinks = markets.length * (markets.length - 1) / 2;
  const systemicRisk = possibleLinks > 0
    ? round3(strongLinks / possibleLinks)
    : 0;

  return {
    pairs: pairs.slice(0, 20),
    systemicRisk,
    riskLevel: systemicRisk > 0.5 ? "high" : systemicRisk > 0.2 ? "moderate" : "low",
    marketsAnalyzed: markets.length,
    strongLinks,
    totalPairs: pairs.length
  };
}

/**
 * Detect current correlation regime.
 *
 * @param {number} days
 * @returns {{ regime, avgCorrelation, trend, warning }}
 */
export function getCorrelationRegime(days = 7) {
  const recent = buildCorrelationMatrix(Math.min(days, 3));
  const older = buildCorrelationMatrix(days);

  const recentAvg = recent.avgCorrelation || 0;
  const olderAvg = older.avgCorrelation || 0;
  const delta = recentAvg - olderAvg;

  let regime = "normal";
  let warning = null;

  if (recentAvg > 0.7) {
    regime = "tight";
    warning = "High correlation — diversification reduced, contagion risk elevated";
  } else if (recentAvg < 0.2) {
    regime = "loose";
  } else if (Math.abs(delta) > 0.2) {
    regime = "breaking";
    warning = delta > 0
      ? "Correlation spiking — markets converging, possible stress event"
      : "Correlation breaking down — regime shift, reassess hedges";
  }

  return {
    regime,
    recentAvgCorrelation: round3(recentAvg),
    historicalAvgCorrelation: round3(olderAvg),
    delta: round3(delta),
    trend: delta > 0.05 ? "increasing" : delta < -0.05 ? "decreasing" : "stable",
    warning,
    recentMarkets: recent.marketCount || 0,
    historicalMarkets: older.marketCount || 0
  };
}

/**
 * Get contagion risk overview.
 *
 * @param {number} days
 * @returns {{ riskScore, clusters, spillovers, regime, recommendations }}
 */
export function getContagionOverview(days = 7) {
  const regime = getCorrelationRegime(days);
  const clusters = detectMarketClusters(days);
  const spillovers = getSpilloverMap(days);

  // Composite risk score
  let riskScore = 0;
  if (regime.regime === "tight") riskScore += 30;
  if (regime.regime === "breaking") riskScore += 25;
  if (regime.trend === "increasing") riskScore += 15;
  riskScore += Math.min(30, spillovers.strongLinks * 10);

  const recommendations = [];
  if (riskScore > 60) {
    recommendations.push("Reduce position sizes — high systemic risk detected");
    recommendations.push("Diversify across uncorrelated markets");
  }
  if (regime.regime === "tight") {
    recommendations.push("Hedging may be ineffective — markets are highly correlated");
  }
  if (clusters.totalClusters > 0 && clusters.clusters[0]?.size > 3) {
    recommendations.push(`Large cluster detected (${clusters.clusters[0].size} markets) — concentrated risk`);
  }

  return {
    riskScore: Math.min(100, riskScore),
    riskLevel: riskScore > 60 ? "high" : riskScore > 30 ? "moderate" : "low",
    correlationRegime: regime,
    clusters: clusters.clusters.slice(0, 5),
    topSpillovers: spillovers.pairs.slice(0, 5),
    systemicRisk: spillovers.systemicRisk,
    recommendations
  };
}

// Helpers

function pearsonCorrelation(seriesA, seriesB, buckets) {
  const pairs = [];
  for (const b of buckets) {
    const a = seriesA[b];
    const bv = seriesB[b];
    if (a !== undefined && bv !== undefined) pairs.push([a, bv]);
  }
  if (pairs.length < 3) return 0;

  const meanA = pairs.reduce((s, p) => s + p[0], 0) / pairs.length;
  const meanB = pairs.reduce((s, p) => s + p[1], 0) / pairs.length;
  let num = 0, denA = 0, denB = 0;
  for (const [a, b] of pairs) {
    num += (a - meanA) * (b - meanB);
    denA += (a - meanA) ** 2;
    denB += (b - meanB) ** 2;
  }
  const den = Math.sqrt(denA * denB);
  return den > 0 ? num / den : 0;
}

function laggedCorrelation(seriesA, seriesB, buckets, lag) {
  const pairs = [];
  for (let i = lag; i < buckets.length; i++) {
    const a = seriesA[buckets[i - lag]];
    const b = seriesB[buckets[i]];
    if (a !== undefined && b !== undefined) pairs.push([a, b]);
  }
  if (pairs.length < 3) return 0;

  const meanA = pairs.reduce((s, p) => s + p[0], 0) / pairs.length;
  const meanB = pairs.reduce((s, p) => s + p[1], 0) / pairs.length;
  let num = 0, denA = 0, denB = 0;
  for (const [a, b] of pairs) {
    num += (a - meanA) * (b - meanB);
    denA += (a - meanA) ** 2;
    denB += (b - meanB) ** 2;
  }
  const den = Math.sqrt(denA * denB);
  return den > 0 ? num / den : 0;
}

function computeBeta(leaderSeries, followerSeries, buckets) {
  const pairs = [];
  for (let i = 1; i < buckets.length; i++) {
    const x = leaderSeries[buckets[i - 1]];
    const y = followerSeries[buckets[i]];
    if (x !== undefined && y !== undefined) pairs.push([x, y]);
  }
  if (pairs.length < 3) return 0;

  const meanX = pairs.reduce((s, p) => s + p[0], 0) / pairs.length;
  const meanY = pairs.reduce((s, p) => s + p[1], 0) / pairs.length;
  let num = 0, den = 0;
  for (const [x, y] of pairs) {
    num += (x - meanX) * (y - meanY);
    den += (x - meanX) ** 2;
  }
  return den > 0 ? num / den : 0;
}

function avgPairCorrelation(matrix, cluster) {
  let total = 0, count = 0;
  for (let i = 0; i < cluster.length; i++) {
    for (let j = i + 1; j < cluster.length; j++) {
      total += Math.abs(matrix[cluster[i]]?.[cluster[j]] || 0);
      count++;
    }
  }
  return count > 0 ? total / count : 0;
}

function computeEigenProxy(matrix, markets) {
  // Simplified: sum of squared correlations per market (Gershgorin bound proxy)
  const dominance = [];
  for (const m of markets) {
    let sumSq = 0;
    for (const other of markets) {
      if (m !== other) sumSq += (matrix[m]?.[other] || 0) ** 2;
    }
    dominance.push({ market: m.slice(0, 20), variance_explained: round3(sumSq / (markets.length - 1 || 1)) });
  }
  dominance.sort((a, b) => b.variance_explained - a.variance_explained);

  const topExplained = dominance.slice(0, 3).reduce((s, d) => s + d.variance_explained, 0);

  return {
    topFactors: dominance.slice(0, 5),
    concentrationRatio: round3(topExplained / (dominance.reduce((s, d) => s + d.variance_explained, 0) || 1)),
    isDominated: dominance[0]?.variance_explained > 0.5
  };
}

function round3(v) { return Math.round((v ?? 0) * 1000) / 1000; }
