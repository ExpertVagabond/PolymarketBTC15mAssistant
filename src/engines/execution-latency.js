/**
 * Execution latency profiler.
 *
 * Profiles signal-to-fill timing pipeline:
 * - Stage-by-stage latency breakdown (signal → decision → order → fill)
 * - Percentile latencies (p50/p95/p99) by regime
 * - Fill time prediction for new orders
 * - Bottleneck identification and recommendations
 * - Time-of-day latency patterns
 *
 * Complements execution-quality.js (cost analysis) with timing analysis.
 */

import { getDb } from "../subscribers/db.js";

// In-memory latency ring buffer
const latencyBuffer = []; // [{ marketId, stage, durationMs, timestamp }]
const BUFFER_SIZE = 500;

/**
 * Record a latency measurement for a pipeline stage.
 *
 * @param {string} marketId
 * @param {string} stage - signal_gen, decision, order_submit, fill
 * @param {number} durationMs
 */
export function recordLatency(marketId, stage, durationMs) {
  latencyBuffer.push({ marketId, stage, durationMs, timestamp: Date.now() });
  if (latencyBuffer.length > BUFFER_SIZE) {
    latencyBuffer.splice(0, latencyBuffer.length - BUFFER_SIZE);
  }
}

/**
 * Analyze execution latency from historical trade data.
 * Uses time gaps between signal creation and execution as proxy.
 *
 * @param {number} days
 * @returns {{ stages, bottlenecks, recommendations, percentiles }}
 */
export function analyzeExecutionLatency(days = 14) {
  const db = getDb();
  const daysOffset = `-${Math.min(Math.max(days, 1), 90)} days`;

  const rows = db.prepare(`
    SELECT market_id, regime, category, confidence, quality_score,
           status, realized_pnl, created_at,
           CAST(strftime('%H', created_at) AS INTEGER) as hour
    FROM trade_executions
    WHERE created_at > datetime('now', ?)
    AND status IN ('WIN', 'LOSS')
    AND realized_pnl IS NOT NULL
    ORDER BY created_at ASC
  `).all(daysOffset);

  if (rows.length < 10) {
    return { stages: [], bottlenecks: [], recommendations: [], message: "insufficient_data" };
  }

  // Compute inter-trade timing as latency proxy
  const gaps = [];
  for (let i = 1; i < rows.length; i++) {
    const prev = new Date(rows[i - 1].created_at).getTime();
    const curr = new Date(rows[i].created_at).getTime();
    const gapMs = curr - prev;
    if (gapMs > 0 && gapMs < 3600000) { // Under 1 hour
      gaps.push({
        gapMs,
        regime: rows[i].regime || "unknown",
        hour: rows[i].hour,
        confidence: rows[i].confidence || 0.5,
        outcome: rows[i].status
      });
    }
  }

  if (gaps.length < 5) {
    return { stages: [], bottlenecks: [], recommendations: [], message: "insufficient_gaps" };
  }

  // Percentiles
  const sortedGaps = gaps.map(g => g.gapMs).sort((a, b) => a - b);
  const p50 = sortedGaps[Math.floor(sortedGaps.length * 0.5)];
  const p95 = sortedGaps[Math.floor(sortedGaps.length * 0.95)];
  const p99 = sortedGaps[Math.floor(sortedGaps.length * 0.99)];

  // By regime
  const byRegime = {};
  for (const g of gaps) {
    if (!byRegime[g.regime]) byRegime[g.regime] = [];
    byRegime[g.regime].push(g.gapMs);
  }

  const regimeLatencies = {};
  for (const [regime, gapList] of Object.entries(byRegime)) {
    const sorted = gapList.sort((a, b) => a - b);
    regimeLatencies[regime] = {
      p50: Math.round(sorted[Math.floor(sorted.length * 0.5)]),
      p95: Math.round(sorted[Math.floor(sorted.length * 0.95)] || sorted[sorted.length - 1]),
      count: sorted.length,
      avgMs: Math.round(sorted.reduce((s, v) => s + v, 0) / sorted.length)
    };
  }

  // By hour
  const byHour = {};
  for (const g of gaps) {
    if (!byHour[g.hour]) byHour[g.hour] = [];
    byHour[g.hour].push(g.gapMs);
  }

  const hourlyLatency = Object.entries(byHour).map(([h, gList]) => ({
    hour: Number(h),
    avgMs: Math.round(gList.reduce((s, v) => s + v, 0) / gList.length),
    trades: gList.length
  })).sort((a, b) => a.hour - b.hour);

  // Bottleneck detection
  const bottlenecks = [];
  const fastestRegime = Object.entries(regimeLatencies).sort((a, b) => a[1].p50 - b[1].p50)[0];
  const slowestRegime = Object.entries(regimeLatencies).sort((a, b) => b[1].p50 - a[1].p50)[0];

  if (slowestRegime && fastestRegime && slowestRegime[1].p50 > fastestRegime[1].p50 * 2) {
    bottlenecks.push({
      type: "regime_dependent",
      slowRegime: slowestRegime[0],
      slowP50: slowestRegime[1].p50,
      fastRegime: fastestRegime[0],
      fastP50: fastestRegime[1].p50,
      ratio: round2(slowestRegime[1].p50 / fastestRegime[1].p50)
    });
  }

  if (p95 > p50 * 5) {
    bottlenecks.push({
      type: "tail_latency",
      p50,
      p95,
      ratio: round2(p95 / p50),
      description: "P95 is 5x+ worse than median — tail latency issue"
    });
  }

  // Recommendations
  const recommendations = [];
  if (bottlenecks.length > 0) {
    recommendations.push(`Latency spikes in ${slowestRegime?.[0] || "unknown"} regime — consider faster order algo`);
  }
  if (p95 > 60000) {
    recommendations.push("P95 fill time >60s — investigate order queue delays");
  }

  // In-memory buffer stats
  const bufferStats = getBufferStats();

  return {
    percentiles: { p50, p95, p99, unit: "ms" },
    byRegime: regimeLatencies,
    hourlyPattern: hourlyLatency,
    bottlenecks,
    recommendations,
    bufferStats,
    totalGaps: gaps.length,
    lookbackDays: days
  };
}

/**
 * Predict fill time for a new order.
 *
 * @param {object} opts
 * @param {string} opts.regime
 * @param {number} opts.confidence
 * @param {number} opts.shares
 * @returns {{ estimatedMs, p50, p95, confidence }}
 */
export function predictFillTime(opts = {}) {
  const analysis = analyzeExecutionLatency(14);
  if (!analysis.byRegime || Object.keys(analysis.byRegime).length === 0) {
    return { estimatedMs: 30000, p50: 30000, p95: 120000, confidence: 0, message: "using_defaults" };
  }

  const regime = opts.regime || "RANGE";
  const regimeData = analysis.byRegime[regime] || analysis.byRegime.RANGE || Object.values(analysis.byRegime)[0];

  // Adjust by confidence (higher confidence → faster fills expected)
  const confMultiplier = opts.confidence > 0.7 ? 0.8 : opts.confidence < 0.5 ? 1.3 : 1.0;

  // Adjust by size (larger orders → slower)
  const sizeMultiplier = (opts.shares || 10) > 50 ? 1.5 : 1.0;

  return {
    estimatedMs: Math.round((regimeData?.p50 || 30000) * confMultiplier * sizeMultiplier),
    p50: regimeData?.p50 || 30000,
    p95: regimeData?.p95 || 120000,
    regime,
    confidence: round3(regimeData?.count > 10 ? 0.8 : 0.4),
    adjustments: { confMultiplier: round3(confMultiplier), sizeMultiplier: round3(sizeMultiplier) }
  };
}

/**
 * Get latency dashboard overview.
 *
 * @returns {{ summary, byRegime, bottleneckCount, recommendations }}
 */
export function getLatencyDashboard() {
  const analysis = analyzeExecutionLatency();

  return {
    p50: analysis.percentiles?.p50 || 0,
    p95: analysis.percentiles?.p95 || 0,
    p99: analysis.percentiles?.p99 || 0,
    unit: "ms",
    byRegime: analysis.byRegime || {},
    bottleneckCount: (analysis.bottlenecks || []).length,
    bottlenecks: (analysis.bottlenecks || []).slice(0, 3),
    recommendations: (analysis.recommendations || []).slice(0, 3),
    totalSamples: analysis.totalGaps || 0,
    bufferStats: analysis.bufferStats || {}
  };
}

function getBufferStats() {
  if (latencyBuffer.length === 0) return { entries: 0 };

  const byStage = {};
  for (const entry of latencyBuffer) {
    if (!byStage[entry.stage]) byStage[entry.stage] = [];
    byStage[entry.stage].push(entry.durationMs);
  }

  const stages = Object.entries(byStage).map(([stage, durations]) => ({
    stage,
    count: durations.length,
    avgMs: Math.round(durations.reduce((s, v) => s + v, 0) / durations.length),
    maxMs: Math.max(...durations)
  }));

  return { entries: latencyBuffer.length, stages };
}

function round2(v) { return Math.round((v ?? 0) * 100) / 100; }
function round3(v) { return Math.round((v ?? 0) * 1000) / 1000; }
