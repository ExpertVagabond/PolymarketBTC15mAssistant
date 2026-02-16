/**
 * Strategy parameter evolution engine.
 *
 * Maintains a population of trading parameter sets and evolves them
 * using a simplified genetic algorithm:
 *
 * 1. Population: N parameter sets (confidence threshold, edge min, sizing multiplier, quality gate)
 * 2. Fitness: evaluated from recent trade P&L for each parameter set
 * 3. Selection: top 50% survive to next generation
 * 4. Mutation: surviving params randomly mutated within bounds
 * 5. Tracking: each generation's best params and fitness recorded
 *
 * This runs passively — it suggests optimal parameters but doesn't
 * auto-apply them. Admin can review and manually adopt.
 */

import { getDb } from "../subscribers/db.js";

const POPULATION_SIZE = 8;
const MUTATION_RATE = 0.2; // 20% change per mutation
const PARAM_BOUNDS = {
  minConfidence:    { min: 30, max: 80, step: 5 },
  minEdge:          { min: 0.02, max: 0.20, step: 0.01 },
  sizingMultiplier: { min: 0.3, max: 2.0, step: 0.1 },
  qualityGate:      { min: 20, max: 60, step: 5 },
  maxPositions:     { min: 3, max: 15, step: 1 }
};

let population = [];
let generation = 0;
let bestEver = null;

function ensureTable() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS param_evolution (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      generation INTEGER NOT NULL,
      params TEXT NOT NULL,
      fitness REAL,
      is_best INTEGER DEFAULT 0,
      timestamp TEXT DEFAULT (datetime('now'))
    )
  `);
}

/**
 * Initialize population with random parameter sets.
 */
function initPopulation() {
  population = [];
  for (let i = 0; i < POPULATION_SIZE; i++) {
    population.push({
      params: randomParams(),
      fitness: null,
      generation: 0
    });
  }
  generation = 0;
}

function randomParams() {
  const params = {};
  for (const [key, bounds] of Object.entries(PARAM_BOUNDS)) {
    const range = bounds.max - bounds.min;
    const steps = Math.round(range / bounds.step);
    const randomStep = Math.floor(Math.random() * (steps + 1));
    params[key] = Math.round((bounds.min + randomStep * bounds.step) * 1000) / 1000;
  }
  return params;
}

function mutateParams(params) {
  const mutated = { ...params };
  for (const [key, bounds] of Object.entries(PARAM_BOUNDS)) {
    if (Math.random() < MUTATION_RATE) {
      const delta = (Math.random() - 0.5) * 2 * bounds.step * 3; // up to 3 steps
      mutated[key] = Math.round(Math.max(bounds.min, Math.min(bounds.max, mutated[key] + delta)) * 1000) / 1000;
    }
  }
  return mutated;
}

function crossover(parentA, parentB) {
  const child = {};
  for (const key of Object.keys(PARAM_BOUNDS)) {
    child[key] = Math.random() < 0.5 ? parentA[key] : parentB[key];
  }
  return child;
}

/**
 * Evaluate fitness for a parameter set against recent trades.
 * Fitness = simulated P&L if those parameters had been used.
 */
function evaluateFitness(params) {
  try {
    const db = getDb();
    const trades = db.prepare(`
      SELECT confidence, edge, quality_score, pnl_usd, outcome, bet_size_usd
      FROM trade_executions
      WHERE outcome IN ('WIN', 'LOSS') AND created_at > datetime('now', '-7 days')
      ORDER BY created_at DESC LIMIT 200
    `).all();

    if (trades.length < 10) return null; // insufficient data

    let totalPnl = 0;
    let wins = 0;
    let trades_taken = 0;

    for (const t of trades) {
      // Would this trade have passed the parameter filters?
      if ((t.confidence || 0) < params.minConfidence) continue;
      if ((t.edge || 0) < params.minEdge) continue;
      if ((t.quality_score || 0) < params.qualityGate) continue;

      trades_taken++;
      const adjustedPnl = (t.pnl_usd || 0) * params.sizingMultiplier;
      totalPnl += adjustedPnl;
      if (t.outcome === "WIN") wins++;
    }

    if (trades_taken < 5) return null;

    const winRate = wins / trades_taken;
    // Fitness: risk-adjusted return (Sharpe-like)
    const avgPnl = totalPnl / trades_taken;
    const selectivity = trades_taken / trades.length; // penalize overly restrictive params

    return {
      totalPnl: Math.round(totalPnl * 100) / 100,
      winRate: Math.round(winRate * 1000) / 1000,
      tradesTaken: trades_taken,
      selectivity: Math.round(selectivity * 100) / 100,
      // Composite: P&L weighted by selectivity (don't reward filtering to 1 lucky trade)
      score: Math.round((avgPnl * Math.sqrt(trades_taken) * (0.5 + selectivity * 0.5)) * 100) / 100
    };
  } catch {
    return null;
  }
}

/**
 * Run one generation of evolution.
 * @returns {{ generation, population, best, improved }}
 */
export function evolveParameters() {
  ensureTable();

  if (population.length === 0) initPopulation();

  // Evaluate fitness for all
  for (const individual of population) {
    const fitness = evaluateFitness(individual.params);
    individual.fitness = fitness;
  }

  // Filter out individuals with no fitness data
  const evaluated = population.filter(i => i.fitness !== null);
  if (evaluated.length < 2) {
    return { generation, message: "insufficient trade data for evolution", populationSize: population.length };
  }

  // Sort by fitness score (descending)
  evaluated.sort((a, b) => (b.fitness?.score || 0) - (a.fitness?.score || 0));

  // Track best
  const currentBest = evaluated[0];
  const improved = !bestEver || (currentBest.fitness.score > (bestEver.fitness?.score || -Infinity));
  if (improved) bestEver = { ...currentBest };

  // Persist best to DB
  const db = getDb();
  db.prepare("INSERT INTO param_evolution (generation, params, fitness, is_best) VALUES (?, ?, ?, ?)")
    .run(generation, JSON.stringify(currentBest.params), currentBest.fitness.score, improved ? 1 : 0);

  // Selection: top 50%
  const survivors = evaluated.slice(0, Math.max(2, Math.floor(evaluated.length / 2)));

  // Next generation: survivors + crossover children + mutations
  const nextPop = [];

  // Keep survivors
  for (const s of survivors) {
    nextPop.push({ params: s.params, fitness: null, generation: generation + 1 });
  }

  // Fill remaining with crossover + mutation
  while (nextPop.length < POPULATION_SIZE) {
    const parentA = survivors[Math.floor(Math.random() * survivors.length)];
    const parentB = survivors[Math.floor(Math.random() * survivors.length)];
    const childParams = mutateParams(crossover(parentA.params, parentB.params));
    nextPop.push({ params: childParams, fitness: null, generation: generation + 1 });
  }

  population = nextPop;
  generation++;

  return {
    generation,
    best: { params: currentBest.params, fitness: currentBest.fitness },
    improved,
    populationSize: population.length,
    evaluated: evaluated.length
  };
}

/**
 * Get current evolution status.
 */
export function getEvolutionStatus() {
  ensureTable();
  const db = getDb();
  const recentBest = db.prepare(
    "SELECT * FROM param_evolution WHERE is_best = 1 ORDER BY generation DESC LIMIT 5"
  ).all().map(r => ({ ...r, params: JSON.parse(r.params) }));

  return {
    generation,
    populationSize: population.length,
    bestEver: bestEver ? { params: bestEver.params, fitness: bestEver.fitness } : null,
    recentBest,
    paramBounds: PARAM_BOUNDS
  };
}

/**
 * Get the current best parameter set.
 */
export function getCurrentBest() {
  if (!bestEver) {
    // Try loading from DB
    ensureTable();
    const db = getDb();
    const row = db.prepare("SELECT * FROM param_evolution WHERE is_best = 1 ORDER BY fitness DESC LIMIT 1").get();
    if (row) {
      return { params: JSON.parse(row.params), fitness: row.fitness, generation: row.generation };
    }
    return null;
  }
  return { params: bestEver.params, fitness: bestEver.fitness };
}
