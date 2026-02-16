/**
 * A/B experiment framework with Thompson sampling.
 *
 * Run multiple strategy variants simultaneously. Each experiment has
 * N arms (variants). Traffic is allocated via Thompson sampling
 * (Beta distribution), which naturally balances exploration vs exploitation.
 *
 * Winner detection: arm is declared winner when its probability of being
 * the best exceeds 95% (computed via Monte Carlo simulation).
 *
 * SQLite-backed for persistence across restarts.
 */

import { getDb } from "../subscribers/db.js";

let initialized = false;

function ensureTables() {
  if (initialized) return;
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS ab_experiments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      status TEXT DEFAULT 'active' CHECK(status IN ('active', 'completed', 'paused')),
      winner_arm TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS ab_arms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      experiment_id INTEGER NOT NULL,
      arm_name TEXT NOT NULL,
      wins INTEGER DEFAULT 0,
      losses INTEGER DEFAULT 0,
      total_pnl REAL DEFAULT 0,
      FOREIGN KEY (experiment_id) REFERENCES ab_experiments(id),
      UNIQUE(experiment_id, arm_name)
    );

    CREATE INDEX IF NOT EXISTS idx_ab_arms_exp ON ab_arms(experiment_id);
  `);
  initialized = true;
}

/**
 * Create a new experiment with named arms.
 * @param {string} name - Experiment name (unique)
 * @param {string[]} arms - Arm names (e.g., ["control", "variant_a", "variant_b"])
 * @returns {{ id, name, arms }}
 */
export function createExperiment(name, arms) {
  ensureTables();
  if (!name || !arms || arms.length < 2) {
    return { error: "Need a name and at least 2 arms" };
  }

  const db = getDb();
  try {
    const info = db.prepare("INSERT INTO ab_experiments (name) VALUES (?)").run(name);
    const expId = info.lastInsertRowid;

    const insertArm = db.prepare("INSERT INTO ab_arms (experiment_id, arm_name) VALUES (?, ?)");
    for (const arm of arms) {
      insertArm.run(expId, arm);
    }

    return { id: expId, name, arms, status: "active" };
  } catch (err) {
    if (err.message.includes("UNIQUE")) return { error: "experiment_name_exists" };
    throw err;
  }
}

/**
 * Assign an arm for a new signal using Thompson sampling.
 * Draws from Beta(wins+1, losses+1) for each arm, picks highest.
 * @param {number} experimentId
 * @returns {{ arm: string, experimentId: number } | null}
 */
export function assignArm(experimentId) {
  ensureTables();
  const db = getDb();

  const exp = db.prepare("SELECT * FROM ab_experiments WHERE id = ? AND status = 'active'").get(experimentId);
  if (!exp) return null;

  const arms = db.prepare("SELECT * FROM ab_arms WHERE experiment_id = ?").all(experimentId);
  if (arms.length === 0) return null;

  // Thompson sampling: draw from Beta distribution for each arm
  let bestDraw = -1;
  let bestArm = arms[0].arm_name;

  for (const arm of arms) {
    const alpha = arm.wins + 1;
    const beta = arm.losses + 1;
    const draw = betaSample(alpha, beta);
    if (draw > bestDraw) {
      bestDraw = draw;
      bestArm = arm.arm_name;
    }
  }

  return { arm: bestArm, experimentId };
}

/**
 * Record an outcome for an experiment arm.
 * @param {number} experimentId
 * @param {string} armName
 * @param {boolean} win
 * @param {number} [pnl] - Optional P&L value
 */
export function recordArmOutcome(experimentId, armName, win, pnl = 0) {
  ensureTables();
  const db = getDb();

  if (win) {
    db.prepare(
      "UPDATE ab_arms SET wins = wins + 1, total_pnl = total_pnl + ? WHERE experiment_id = ? AND arm_name = ?"
    ).run(pnl, experimentId, armName);
  } else {
    db.prepare(
      "UPDATE ab_arms SET losses = losses + 1, total_pnl = total_pnl + ? WHERE experiment_id = ? AND arm_name = ?"
    ).run(pnl, experimentId, armName);
  }

  // Check if any arm has reached significance
  checkForWinner(experimentId);
}

/**
 * Check if an experiment has a statistically significant winner.
 * Uses Monte Carlo simulation (1000 draws) to estimate P(arm is best).
 * Declares winner if P > 0.95 and total samples > 30.
 */
function checkForWinner(experimentId) {
  const db = getDb();
  const arms = db.prepare("SELECT * FROM ab_arms WHERE experiment_id = ?").all(experimentId);
  if (arms.length < 2) return;

  const totalSamples = arms.reduce((s, a) => s + a.wins + a.losses, 0);
  if (totalSamples < 30) return; // Too few samples

  const SIMS = 1000;
  const winCounts = {};
  for (const a of arms) winCounts[a.arm_name] = 0;

  for (let sim = 0; sim < SIMS; sim++) {
    let bestVal = -1;
    let bestArm = "";
    for (const arm of arms) {
      const draw = betaSample(arm.wins + 1, arm.losses + 1);
      if (draw > bestVal) {
        bestVal = draw;
        bestArm = arm.arm_name;
      }
    }
    winCounts[bestArm]++;
  }

  // Check if any arm has >95% probability of being best
  for (const [armName, count] of Object.entries(winCounts)) {
    if (count / SIMS >= 0.95) {
      db.prepare(
        "UPDATE ab_experiments SET status = 'completed', winner_arm = ?, completed_at = datetime('now') WHERE id = ? AND status = 'active'"
      ).run(armName, experimentId);
      console.log(`[ab-experiments] Experiment #${experimentId}: winner detected = ${armName} (${(count / SIMS * 100).toFixed(1)}% probability)`);
      return;
    }
  }
}

/**
 * Get detailed stats for an experiment.
 */
export function getExperimentStats(experimentId) {
  ensureTables();
  const db = getDb();

  const exp = db.prepare("SELECT * FROM ab_experiments WHERE id = ?").get(experimentId);
  if (!exp) return { error: "not_found" };

  const arms = db.prepare("SELECT * FROM ab_arms WHERE experiment_id = ? ORDER BY arm_name").all(experimentId);

  const totalSamples = arms.reduce((s, a) => s + a.wins + a.losses, 0);

  // Run Monte Carlo to get current probabilities
  const SIMS = 1000;
  const winCounts = {};
  for (const a of arms) winCounts[a.arm_name] = 0;

  if (totalSamples > 0) {
    for (let sim = 0; sim < SIMS; sim++) {
      let bestVal = -1, bestArm = "";
      for (const arm of arms) {
        const draw = betaSample(arm.wins + 1, arm.losses + 1);
        if (draw > bestVal) { bestVal = draw; bestArm = arm.arm_name; }
      }
      winCounts[bestArm]++;
    }
  }

  const armStats = arms.map(a => {
    const total = a.wins + a.losses;
    return {
      arm: a.arm_name,
      wins: a.wins,
      losses: a.losses,
      total,
      winRate: total > 0 ? Math.round(a.wins / total * 100) : null,
      totalPnl: Math.round(a.total_pnl * 100) / 100,
      avgPnl: total > 0 ? Math.round(a.total_pnl / total * 100) / 100 : null,
      probBest: totalSamples > 0 ? Math.round(winCounts[a.arm_name] / SIMS * 100) : null
    };
  });

  return {
    id: exp.id,
    name: exp.name,
    status: exp.status,
    winner: exp.winner_arm,
    createdAt: exp.created_at,
    completedAt: exp.completed_at,
    totalSamples,
    arms: armStats
  };
}

/**
 * List all experiments.
 */
export function listExperiments() {
  ensureTables();
  const db = getDb();
  const exps = db.prepare("SELECT * FROM ab_experiments ORDER BY created_at DESC LIMIT 50").all();

  return exps.map(exp => {
    const arms = db.prepare("SELECT arm_name, wins, losses FROM ab_arms WHERE experiment_id = ?").all(exp.id);
    const total = arms.reduce((s, a) => s + a.wins + a.losses, 0);
    return {
      id: exp.id,
      name: exp.name,
      status: exp.status,
      winner: exp.winner_arm,
      totalSamples: total,
      armCount: arms.length,
      createdAt: exp.created_at
    };
  });
}

/**
 * Manually promote a winner and complete the experiment.
 */
export function promoteWinner(experimentId, armName) {
  ensureTables();
  const db = getDb();

  const exp = db.prepare("SELECT * FROM ab_experiments WHERE id = ?").get(experimentId);
  if (!exp) return { error: "not_found" };

  const arm = db.prepare("SELECT * FROM ab_arms WHERE experiment_id = ? AND arm_name = ?").get(experimentId, armName);
  if (!arm) return { error: "arm_not_found" };

  db.prepare(
    "UPDATE ab_experiments SET status = 'completed', winner_arm = ?, completed_at = datetime('now') WHERE id = ?"
  ).run(armName, experimentId);

  return { ok: true, experimentId, winner: armName };
}

/**
 * Pause or resume an experiment.
 */
export function setExperimentStatus(experimentId, status) {
  ensureTables();
  if (!["active", "paused"].includes(status)) return { error: "invalid_status" };
  const db = getDb();
  db.prepare("UPDATE ab_experiments SET status = ? WHERE id = ?").run(status, experimentId);
  return { ok: true, experimentId, status };
}

/**
 * Get the currently active experiment (if any) for signal assignment.
 * Returns the first active experiment, or null.
 */
export function getActiveExperiment() {
  ensureTables();
  const db = getDb();
  return db.prepare("SELECT * FROM ab_experiments WHERE status = 'active' ORDER BY id DESC LIMIT 1").get() || null;
}

/**
 * Sample from Beta(alpha, beta) distribution using the Joehnk method.
 * Simple approximation suitable for Thompson sampling.
 */
function betaSample(alpha, beta) {
  // Use the gamma distribution relationship: Beta(a,b) = Gamma(a) / (Gamma(a) + Gamma(b))
  const x = gammaSample(alpha);
  const y = gammaSample(beta);
  return x / (x + y);
}

/** Sample from Gamma(shape, 1) using Marsaglia and Tsang's method. */
function gammaSample(shape) {
  if (shape < 1) {
    return gammaSample(shape + 1) * Math.pow(Math.random(), 1 / shape);
  }

  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);

  while (true) {
    let x, v;
    do {
      x = randn();
      v = 1 + c * x;
    } while (v <= 0);

    v = v * v * v;
    const u = Math.random();

    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

/** Standard normal sample using Box-Muller. */
function randn() {
  const u1 = Math.random();
  const u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}
