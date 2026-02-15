/**
 * Signal history database — logs every signal, tracks outcomes.
 * Uses the same better-sqlite3 DB as subscribers.
 */

import { getDb } from "../subscribers/db.js";

let stmts = null;

function ensureTable() {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS signal_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      market_id TEXT NOT NULL,
      question TEXT,
      category TEXT,
      signal TEXT NOT NULL,
      side TEXT,
      strength TEXT,
      phase TEXT,
      regime TEXT,
      model_up REAL,
      model_down REAL,
      market_yes REAL,
      market_no REAL,
      edge REAL,
      rsi REAL,
      orderbook_imbalance REAL,
      settlement_left_min REAL,
      liquidity REAL,
      created_at TEXT DEFAULT (datetime('now')),
      -- Outcome fields (filled after settlement)
      outcome TEXT,
      outcome_price_yes REAL,
      outcome_price_no REAL,
      settled_at TEXT,
      pnl_pct REAL,
      -- Indicator snapshot features (for feedback learning)
      vwap_position TEXT,
      vwap_slope_dir TEXT,
      rsi_zone TEXT,
      macd_state TEXT,
      heiken_color TEXT,
      heiken_count INTEGER,
      ob_zone TEXT,
      vol_regime TEXT,
      atr_pct REAL,
      bb_width REAL,
      time_decay REAL,
      degenerate INTEGER DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_signal_market ON signal_history(market_id);
    CREATE INDEX IF NOT EXISTS idx_signal_created ON signal_history(created_at);
    CREATE INDEX IF NOT EXISTS idx_signal_signal ON signal_history(signal);
    CREATE INDEX IF NOT EXISTS idx_signal_outcome ON signal_history(outcome);
  `);

  // Add columns to existing tables (safe: ALTER TABLE ADD COLUMN is a no-op if column exists in SQLite)
  const existingCols = db.prepare("PRAGMA table_info(signal_history)").all().map(c => c.name);
  const newCols = [
    ["vwap_position", "TEXT"], ["vwap_slope_dir", "TEXT"], ["rsi_zone", "TEXT"],
    ["macd_state", "TEXT"], ["heiken_color", "TEXT"], ["heiken_count", "INTEGER"],
    ["ob_zone", "TEXT"], ["vol_regime", "TEXT"], ["atr_pct", "REAL"],
    ["bb_width", "REAL"], ["time_decay", "REAL"], ["degenerate", "INTEGER DEFAULT 0"],
    ["confidence", "INTEGER"], ["confidence_tier", "TEXT"],
    ["kelly_bet_pct", "REAL"], ["kelly_sizing_tier", "TEXT"],
    ["flow_aligned_score", "INTEGER"], ["flow_quality", "TEXT"]
  ];
  for (const [col, type] of newCols) {
    if (!existingCols.includes(col)) {
      db.exec(`ALTER TABLE signal_history ADD COLUMN ${col} ${type}`);
    }
  }

  stmts = {
    insert: db.prepare(`
      INSERT INTO signal_history (
        market_id, question, category, signal, side, strength, phase, regime,
        model_up, model_down, market_yes, market_no, edge, rsi,
        orderbook_imbalance, settlement_left_min, liquidity,
        vwap_position, vwap_slope_dir, rsi_zone, macd_state,
        heiken_color, heiken_count, ob_zone, vol_regime, atr_pct,
        bb_width, time_decay, degenerate,
        confidence, confidence_tier, kelly_bet_pct, kelly_sizing_tier,
        flow_aligned_score, flow_quality
      ) VALUES (
        @market_id, @question, @category, @signal, @side, @strength, @phase, @regime,
        @model_up, @model_down, @market_yes, @market_no, @edge, @rsi,
        @orderbook_imbalance, @settlement_left_min, @liquidity,
        @vwap_position, @vwap_slope_dir, @rsi_zone, @macd_state,
        @heiken_color, @heiken_count, @ob_zone, @vol_regime, @atr_pct,
        @bb_width, @time_decay, @degenerate,
        @confidence, @confidence_tier, @kelly_bet_pct, @kelly_sizing_tier,
        @flow_aligned_score, @flow_quality
      )
    `),

    recordOutcome: db.prepare(`
      UPDATE signal_history
      SET outcome = @outcome,
          outcome_price_yes = @outcome_price_yes,
          outcome_price_no = @outcome_price_no,
          settled_at = datetime('now'),
          pnl_pct = @pnl_pct
      WHERE id = @id
    `),

    getUnsettled: db.prepare(`
      SELECT id, market_id, side, edge, market_yes, market_no
      FROM signal_history
      WHERE signal != 'NO TRADE' AND outcome IS NULL AND settled_at IS NULL
      ORDER BY created_at DESC
    `),

    getRecent: db.prepare(`
      SELECT * FROM signal_history
      WHERE signal != 'NO TRADE'
      ORDER BY created_at DESC
      LIMIT @limit
    `),

    getStats: db.prepare(`
      SELECT
        COUNT(*) as total_signals,
        SUM(CASE WHEN outcome = 'WIN' THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN outcome = 'LOSS' THEN 1 ELSE 0 END) as losses,
        SUM(CASE WHEN outcome IS NULL AND signal != 'NO TRADE' THEN 1 ELSE 0 END) as pending,
        AVG(CASE WHEN outcome IS NOT NULL THEN pnl_pct END) as avg_pnl,
        AVG(CASE WHEN outcome = 'WIN' THEN pnl_pct END) as avg_win_pnl,
        AVG(CASE WHEN outcome = 'LOSS' THEN pnl_pct END) as avg_loss_pnl,
        AVG(edge) as avg_edge
      FROM signal_history
      WHERE signal != 'NO TRADE'
    `),

    getStatsByCategory: db.prepare(`
      SELECT
        category,
        COUNT(*) as total,
        SUM(CASE WHEN outcome = 'WIN' THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN outcome = 'LOSS' THEN 1 ELSE 0 END) as losses,
        AVG(CASE WHEN outcome IS NOT NULL THEN pnl_pct END) as avg_pnl
      FROM signal_history
      WHERE signal != 'NO TRADE'
      GROUP BY category
    `),

    getStatsByStrength: db.prepare(`
      SELECT
        strength,
        COUNT(*) as total,
        SUM(CASE WHEN outcome = 'WIN' THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN outcome = 'LOSS' THEN 1 ELSE 0 END) as losses,
        AVG(CASE WHEN outcome IS NOT NULL THEN pnl_pct END) as avg_pnl
      FROM signal_history
      WHERE signal != 'NO TRADE'
      GROUP BY strength
    `)
  };
}

/**
 * Classify indicator states into categorical zones for learning.
 */
function classifyIndicators(tick) {
  const ind = tick.indicators || {};
  const price = tick.prices?.last;
  const vwap = ind.vwap;

  // VWAP position: ABOVE / BELOW / AT
  let vwap_position = null;
  if (price != null && vwap != null) {
    const dist = (price - vwap) / vwap;
    vwap_position = dist > 0.001 ? "ABOVE" : dist < -0.001 ? "BELOW" : "AT";
  }

  // VWAP slope direction
  let vwap_slope_dir = null;
  if (ind.vwapSlope != null) {
    vwap_slope_dir = ind.vwapSlope > 0 ? "UP" : ind.vwapSlope < 0 ? "DOWN" : "FLAT";
  }

  // RSI zone
  let rsi_zone = null;
  if (ind.rsi != null) {
    if (ind.rsi >= 70) rsi_zone = "OVERBOUGHT";
    else if (ind.rsi >= 55) rsi_zone = "BULLISH";
    else if (ind.rsi > 45) rsi_zone = "NEUTRAL";
    else if (ind.rsi > 30) rsi_zone = "BEARISH";
    else rsi_zone = "OVERSOLD";
  }

  // MACD state
  let macd_state = null;
  const macd = ind.macd;
  if (macd != null && macd.hist != null) {
    if (macd.hist > 0 && (macd.histDelta ?? 0) > 0) macd_state = "EXPANDING_GREEN";
    else if (macd.hist > 0) macd_state = "FADING_GREEN";
    else if (macd.hist < 0 && (macd.histDelta ?? 0) < 0) macd_state = "EXPANDING_RED";
    else if (macd.hist < 0) macd_state = "FADING_RED";
    else macd_state = "ZERO";
  }

  // Orderbook imbalance zone
  let ob_zone = null;
  const obi = tick.orderbookImbalance;
  if (obi != null) {
    if (obi > 1.5) ob_zone = "STRONG_BID";
    else if (obi > 1.2) ob_zone = "BID";
    else if (obi < 0.67) ob_zone = "STRONG_ASK";
    else if (obi < 0.83) ob_zone = "ASK";
    else ob_zone = "BALANCED";
  }

  return {
    vwap_position,
    vwap_slope_dir,
    rsi_zone,
    macd_state,
    heiken_color: ind.heiken?.color || null,
    heiken_count: ind.heiken?.count ?? null,
    ob_zone,
    vol_regime: tick.volRegime || null,
    atr_pct: tick.atrPct ?? null,
    bb_width: tick.bbWidth ?? null,
    time_decay: tick.timeAware?.timeDecay ?? null,
    degenerate: tick.scored?.degenerate ? 1 : 0
  };
}

/**
 * Log a signal from a tick.
 */
export function logSignal(tick) {
  if (!stmts) ensureTable();

  const side = tick.rec?.side || null;
  const bestEdge = side === "UP" ? tick.edge?.edgeUp : tick.edge?.edgeDown;
  const features = classifyIndicators(tick);

  return stmts.insert.run({
    market_id: tick.marketId || "unknown",
    question: tick.question || null,
    category: tick.category || null,
    signal: tick.signal || "NO TRADE",
    side,
    strength: tick.rec?.strength || null,
    phase: tick.rec?.phase || null,
    regime: tick.regimeInfo?.regime || null,
    model_up: tick.timeAware?.adjustedUp ?? null,
    model_down: tick.timeAware?.adjustedDown ?? null,
    market_yes: tick.prices?.up ?? null,
    market_no: tick.prices?.down ?? null,
    edge: bestEdge ?? null,
    rsi: tick.indicators?.rsi ?? null,
    orderbook_imbalance: tick.orderbookImbalance ?? null,
    settlement_left_min: tick.settlementLeftMin ?? null,
    liquidity: tick.market?.liquidity ?? null,
    ...features,
    confidence: tick.confidence ?? null,
    confidence_tier: tick.confidenceTier ?? null,
    kelly_bet_pct: tick.kelly?.betPct ?? null,
    kelly_sizing_tier: tick.kelly?.sizingTier ?? null,
    flow_aligned_score: tick.orderFlow?.alignedScore ?? null,
    flow_quality: tick.orderFlow?.flowQuality ?? null
  });
}

/**
 * Record outcome for a settled signal.
 * outcome: "WIN" | "LOSS"
 */
export function recordOutcome({ id, outcome, outcomeYes, outcomeNo, pnlPct }) {
  if (!stmts) ensureTable();

  return stmts.recordOutcome.run({
    id,
    outcome,
    outcome_price_yes: outcomeYes ?? null,
    outcome_price_no: outcomeNo ?? null,
    pnl_pct: pnlPct ?? null
  });
}

/**
 * Get signals that haven't been settled yet (for outcome tracking).
 */
export function getUnsettledSignals() {
  if (!stmts) ensureTable();
  return stmts.getUnsettled.all();
}

/**
 * Get recent signals (for dashboard display).
 */
export function getRecentSignals(limit = 50) {
  if (!stmts) ensureTable();
  return stmts.getRecent.all({ limit });
}

/**
 * Get aggregate stats.
 */
export function getSignalStats() {
  if (!stmts) ensureTable();

  const overall = stmts.getStats.get();
  const byCategory = stmts.getStatsByCategory.all();
  const byStrength = stmts.getStatsByStrength.all();

  const winRate = overall.wins + overall.losses > 0
    ? (overall.wins / (overall.wins + overall.losses) * 100).toFixed(1)
    : null;

  return {
    ...overall,
    winRate,
    byCategory,
    byStrength
  };
}

/**
 * Get win rates per indicator feature value.
 * Returns a map: { featureName: { featureValue: { wins, losses, total, winRate } } }
 * Only includes features with at least minSamples settled outcomes.
 */
export function getFeatureWinRates(minSamples = 10) {
  if (!stmts) ensureTable();
  const db = getDb();

  const features = [
    "vwap_position", "vwap_slope_dir", "rsi_zone", "macd_state",
    "heiken_color", "ob_zone", "vol_regime", "regime"
  ];

  const result = {};
  for (const feat of features) {
    const rows = db.prepare(`
      SELECT
        ${feat} as val,
        COUNT(*) as total,
        SUM(CASE WHEN outcome = 'WIN' THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN outcome = 'LOSS' THEN 1 ELSE 0 END) as losses
      FROM signal_history
      WHERE signal != 'NO TRADE'
        AND outcome IS NOT NULL
        AND ${feat} IS NOT NULL
      GROUP BY ${feat}
      HAVING total >= ?
    `).all(minSamples);

    if (rows.length > 0) {
      result[feat] = {};
      for (const row of rows) {
        const settled = row.wins + row.losses;
        result[feat][row.val] = {
          wins: row.wins,
          losses: row.losses,
          total: row.total,
          winRate: settled > 0 ? row.wins / settled : null
        };
      }
    }
  }

  return result;
}

/**
 * Compute dynamic indicator weights from outcome history.
 *
 * For each indicator feature, measure how well each value predicts wins.
 * Weight = (win_rate - 0.5) * 2 * confidence_factor
 * where confidence_factor = min(1, samples / 50)
 *
 * Returns: { featureName: { featureValue: weight } }
 * Positive weight = bullish signal, negative = bearish.
 *
 * Falls back to null if insufficient data (<50 total settled outcomes).
 */
export function computeDynamicWeights() {
  if (!stmts) ensureTable();
  const db = getDb();

  // Check if we have enough settled outcomes
  const { settled } = db.prepare(`
    SELECT COUNT(*) as settled FROM signal_history
    WHERE signal != 'NO TRADE' AND outcome IS NOT NULL
  `).get();

  if (settled < 50) return null; // Not enough data

  const featureRates = getFeatureWinRates(5);
  const weights = {};

  for (const [feat, values] of Object.entries(featureRates)) {
    weights[feat] = {};
    for (const [val, stats] of Object.entries(values)) {
      if (stats.winRate === null) continue;
      const confidenceFactor = Math.min(1, stats.total / 50);
      // Weight ranges from -1 (always loses) to +1 (always wins)
      // 0 = coin flip (50% win rate)
      weights[feat][val] = (stats.winRate - 0.5) * 2 * confidenceFactor;
    }
  }

  return weights;
}

/**
 * Get combo win rates: pairs of features that appear together.
 * Useful for identifying high-confidence setups.
 */
export function getComboWinRates(minSamples = 10) {
  if (!stmts) ensureTable();
  const db = getDb();

  return db.prepare(`
    SELECT
      vwap_position || '+' || rsi_zone as combo,
      COUNT(*) as total,
      SUM(CASE WHEN outcome = 'WIN' THEN 1 ELSE 0 END) as wins,
      ROUND(CAST(SUM(CASE WHEN outcome = 'WIN' THEN 1 ELSE 0 END) AS REAL) /
        NULLIF(SUM(CASE WHEN outcome IS NOT NULL THEN 1 ELSE 0 END), 0) * 100, 1) as win_rate,
      AVG(pnl_pct) as avg_pnl
    FROM signal_history
    WHERE signal != 'NO TRADE'
      AND outcome IS NOT NULL
      AND vwap_position IS NOT NULL
      AND rsi_zone IS NOT NULL
    GROUP BY combo
    HAVING total >= ?
    ORDER BY win_rate DESC
  `).all(minSamples);
}

/* ── Analytics queries ── */

/**
 * Time-series stats: daily bucketed win/loss/winrate/pnl.
 * @param {number} days - lookback period (default 7)
 */
export function getTimeSeries(days = 7) {
  if (!stmts) ensureTable();
  const db = getDb();

  return db.prepare(`
    SELECT
      DATE(created_at) as date,
      COUNT(*) as total,
      SUM(CASE WHEN outcome = 'WIN' THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN outcome = 'LOSS' THEN 1 ELSE 0 END) as losses,
      SUM(CASE WHEN outcome IS NULL AND signal != 'NO TRADE' THEN 1 ELSE 0 END) as pending,
      ROUND(CAST(SUM(CASE WHEN outcome = 'WIN' THEN 1 ELSE 0 END) AS REAL) /
        NULLIF(SUM(CASE WHEN outcome IS NOT NULL THEN 1 ELSE 0 END), 0) * 100, 1) as win_rate,
      AVG(CASE WHEN outcome IS NOT NULL THEN pnl_pct END) as avg_pnl,
      SUM(CASE WHEN outcome IS NOT NULL THEN pnl_pct ELSE 0 END) as total_pnl,
      AVG(edge) as avg_edge,
      AVG(confidence) as avg_confidence
    FROM signal_history
    WHERE signal != 'NO TRADE'
      AND created_at >= datetime('now', ?)
    GROUP BY DATE(created_at)
    ORDER BY date ASC
  `).all(`-${days} days`);
}

/**
 * Confidence calibration: bucket confidence scores vs actual win rates.
 * Returns [{bucket, range, total, wins, losses, actual_win_rate, expected_mid}]
 */
export function getCalibration() {
  if (!stmts) ensureTable();
  const db = getDb();

  return db.prepare(`
    SELECT
      CASE
        WHEN confidence >= 80 THEN '80-100'
        WHEN confidence >= 60 THEN '60-79'
        WHEN confidence >= 40 THEN '40-59'
        WHEN confidence >= 20 THEN '20-39'
        ELSE '0-19'
      END as bucket,
      COUNT(*) as total,
      SUM(CASE WHEN outcome = 'WIN' THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN outcome = 'LOSS' THEN 1 ELSE 0 END) as losses,
      ROUND(CAST(SUM(CASE WHEN outcome = 'WIN' THEN 1 ELSE 0 END) AS REAL) /
        NULLIF(SUM(CASE WHEN outcome IS NOT NULL THEN 1 ELSE 0 END), 0) * 100, 1) as actual_win_rate,
      AVG(confidence) as avg_confidence,
      AVG(CASE WHEN outcome IS NOT NULL THEN pnl_pct END) as avg_pnl
    FROM signal_history
    WHERE signal != 'NO TRADE'
      AND confidence IS NOT NULL
      AND outcome IS NOT NULL
    GROUP BY bucket
    ORDER BY avg_confidence DESC
  `).all();
}

/**
 * Drawdown analysis: max drawdown, consecutive losses, streaks.
 */
export function getDrawdownStats() {
  if (!stmts) ensureTable();
  const db = getDb();

  const settled = db.prepare(`
    SELECT outcome, pnl_pct, created_at, settled_at, question, category, confidence
    FROM signal_history
    WHERE signal != 'NO TRADE' AND outcome IS NOT NULL
    ORDER BY created_at ASC
  `).all();

  if (settled.length === 0) {
    return { maxDrawdown: 0, maxConsecutiveLosses: 0, maxConsecutiveWins: 0, currentStreak: { type: null, count: 0 }, equityCurve: [] };
  }

  let cumPnl = 0;
  let peak = 0;
  let maxDrawdown = 0;
  let maxConsecutiveLosses = 0;
  let maxConsecutiveWins = 0;
  let currentLossStreak = 0;
  let currentWinStreak = 0;
  const equityCurve = [];

  for (const row of settled) {
    cumPnl += row.pnl_pct || 0;
    if (cumPnl > peak) peak = cumPnl;
    const dd = peak - cumPnl;
    if (dd > maxDrawdown) maxDrawdown = dd;

    if (row.outcome === "WIN") {
      currentWinStreak++;
      currentLossStreak = 0;
      if (currentWinStreak > maxConsecutiveWins) maxConsecutiveWins = currentWinStreak;
    } else {
      currentLossStreak++;
      currentWinStreak = 0;
      if (currentLossStreak > maxConsecutiveLosses) maxConsecutiveLosses = currentLossStreak;
    }

    equityCurve.push({
      date: row.created_at,
      cumPnl: Math.round(cumPnl * 100) / 100,
      drawdown: Math.round(dd * 100) / 100
    });
  }

  const lastOutcome = settled[settled.length - 1].outcome;
  const currentStreak = {
    type: lastOutcome,
    count: lastOutcome === "WIN" ? currentWinStreak : currentLossStreak
  };

  return { maxDrawdown: Math.round(maxDrawdown * 100) / 100, maxConsecutiveLosses, maxConsecutiveWins, currentStreak, totalSettled: settled.length, equityCurve };
}

/**
 * Export signals as flat objects suitable for CSV.
 * @param {object} opts - { limit, days, category }
 */
export function exportSignals(opts = {}) {
  if (!stmts) ensureTable();
  const db = getDb();

  let where = "signal != 'NO TRADE'";
  const params = {};

  if (opts.days) {
    where += " AND created_at >= datetime('now', @daysAgo)";
    params.daysAgo = `-${opts.days} days`;
  }
  if (opts.category) {
    where += " AND category = @category";
    params.category = opts.category;
  }

  const limit = Math.min(opts.limit || 1000, 5000);

  return db.prepare(`
    SELECT
      id, market_id, question, category, signal, side, strength, regime,
      model_up, model_down, market_yes, market_no, edge, rsi,
      orderbook_imbalance, settlement_left_min, liquidity,
      confidence, confidence_tier, kelly_bet_pct, kelly_sizing_tier,
      flow_aligned_score, flow_quality, vol_regime,
      outcome, pnl_pct, created_at, settled_at
    FROM signal_history
    WHERE ${where}
    ORDER BY created_at DESC
    LIMIT ${limit}
  `).all(params);
}

/**
 * Per-market performance stats.
 */
export function getMarketStats(marketId) {
  if (!stmts) ensureTable();
  const db = getDb();

  return db.prepare(`
    SELECT
      market_id,
      question,
      category,
      COUNT(*) as total_signals,
      SUM(CASE WHEN outcome = 'WIN' THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN outcome = 'LOSS' THEN 1 ELSE 0 END) as losses,
      SUM(CASE WHEN outcome IS NULL THEN 1 ELSE 0 END) as pending,
      ROUND(CAST(SUM(CASE WHEN outcome = 'WIN' THEN 1 ELSE 0 END) AS REAL) /
        NULLIF(SUM(CASE WHEN outcome IS NOT NULL THEN 1 ELSE 0 END), 0) * 100, 1) as win_rate,
      AVG(CASE WHEN outcome IS NOT NULL THEN pnl_pct END) as avg_pnl,
      SUM(CASE WHEN outcome IS NOT NULL THEN pnl_pct ELSE 0 END) as total_pnl,
      AVG(edge) as avg_edge,
      AVG(confidence) as avg_confidence,
      MIN(created_at) as first_signal,
      MAX(created_at) as last_signal
    FROM signal_history
    WHERE signal != 'NO TRADE' AND market_id = ?
    GROUP BY market_id
  `).get(marketId);
}

/**
 * Performance summary for bots: 7-day P&L, streak, best/worst trade.
 */
export function getPerformanceSummary(days = 7) {
  if (!stmts) ensureTable();
  const db = getDb();

  const stats = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN outcome = 'WIN' THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN outcome = 'LOSS' THEN 1 ELSE 0 END) as losses,
      SUM(CASE WHEN outcome IS NOT NULL THEN pnl_pct ELSE 0 END) as total_pnl,
      MAX(CASE WHEN outcome IS NOT NULL THEN pnl_pct END) as best_trade,
      MIN(CASE WHEN outcome IS NOT NULL THEN pnl_pct END) as worst_trade,
      AVG(CASE WHEN outcome IS NOT NULL THEN pnl_pct END) as avg_pnl,
      AVG(confidence) as avg_confidence
    FROM signal_history
    WHERE signal != 'NO TRADE'
      AND created_at >= datetime('now', ?)
  `).get(`-${days} days`);

  const winRate = stats.wins + stats.losses > 0
    ? (stats.wins / (stats.wins + stats.losses) * 100).toFixed(1)
    : null;

  return { ...stats, winRate, days };
}

/**
 * Strategy simulator: replay settled signals through a filter to compute hypothetical performance.
 * @param {object} filters - { minConfidence, maxConfidence, categories, strengths, minEdge, sides }
 */
export function simulateStrategy(filters = {}) {
  if (!stmts) ensureTable();
  const db = getDb();

  // Get all settled signals
  let settled = db.prepare(`
    SELECT * FROM signal_history
    WHERE signal != 'NO TRADE' AND outcome IS NOT NULL
    ORDER BY created_at ASC
  `).all();

  // Apply filters
  if (filters.minConfidence != null) {
    settled = settled.filter(s => (s.confidence ?? 0) >= filters.minConfidence);
  }
  if (filters.maxConfidence != null) {
    settled = settled.filter(s => (s.confidence ?? 100) <= filters.maxConfidence);
  }
  if (filters.categories?.length) {
    const cats = new Set(filters.categories.map(c => c.toLowerCase()));
    settled = settled.filter(s => cats.has((s.category || "").toLowerCase()));
  }
  if (filters.strengths?.length) {
    const str = new Set(filters.strengths.map(s => s.toUpperCase()));
    settled = settled.filter(s => str.has((s.strength || "").toUpperCase()));
  }
  if (filters.minEdge != null) {
    settled = settled.filter(s => (s.edge ?? 0) >= filters.minEdge);
  }
  if (filters.sides?.length) {
    const sides = new Set(filters.sides.map(s => s.toUpperCase()));
    settled = settled.filter(s => sides.has((s.side || "").toUpperCase()));
  }

  if (settled.length === 0) {
    return { total: 0, wins: 0, losses: 0, winRate: null, totalPnl: 0, avgPnl: null, sharpe: null, maxDrawdown: 0, equityCurve: [], message: "No settled signals match filters" };
  }

  // Compute stats
  let wins = 0, losses = 0, cumPnl = 0, peak = 0, maxDD = 0;
  const pnls = [];
  const equityCurve = [];

  for (const s of settled) {
    if (s.outcome === "WIN") wins++;
    else losses++;

    const pnl = s.pnl_pct || 0;
    pnls.push(pnl);
    cumPnl += pnl;
    if (cumPnl > peak) peak = cumPnl;
    const dd = peak - cumPnl;
    if (dd > maxDD) maxDD = dd;

    equityCurve.push({ date: s.created_at, cumPnl: Math.round(cumPnl * 100) / 100 });
  }

  const total = wins + losses;
  const winRate = total > 0 ? (wins / total * 100).toFixed(1) : null;
  const avgPnl = pnls.length > 0 ? pnls.reduce((a, b) => a + b, 0) / pnls.length : null;

  // Sharpe ratio (simplified: mean/std of P&L per trade)
  let sharpe = null;
  if (pnls.length > 1) {
    const mean = avgPnl;
    const variance = pnls.reduce((sum, p) => sum + (p - mean) ** 2, 0) / (pnls.length - 1);
    const std = Math.sqrt(variance);
    sharpe = std > 0 ? Math.round((mean / std) * 100) / 100 : null;
  }

  return {
    total,
    wins,
    losses,
    winRate,
    totalPnl: Math.round(cumPnl * 100) / 100,
    avgPnl: avgPnl != null ? Math.round(avgPnl * 100) / 100 : null,
    sharpe,
    maxDrawdown: Math.round(maxDD * 100) / 100,
    equityCurve: equityCurve.length > 200 ? equityCurve.filter((_, i) => i % Math.ceil(equityCurve.length / 200) === 0) : equityCurve,
    filters
  };
}

/**
 * Initialize the signal history table.
 */
export function initSignalHistory() {
  ensureTable();
}
