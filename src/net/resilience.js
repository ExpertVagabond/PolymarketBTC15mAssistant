/**
 * Resilience layer: retry with exponential backoff, circuit breaker, and health tracking.
 * Wraps any async function to make it fault-tolerant.
 */

import { sleep } from "../utils.js";

/* ── Health metrics store (per source) ── */

const sourceHealth = new Map();

function getHealth(name) {
  if (!sourceHealth.has(name)) {
    sourceHealth.set(name, {
      name,
      status: "up",          // up | degraded | down
      totalCalls: 0,
      totalErrors: 0,
      consecutiveErrors: 0,
      lastError: null,
      lastErrorAt: null,
      lastSuccessAt: null,
      latencies: [],          // last 20 latencies in ms
      circuitOpen: false,
      circuitOpenUntil: 0
    });
  }
  return sourceHealth.get(name);
}

function recordSuccess(health, latencyMs) {
  health.totalCalls++;
  health.consecutiveErrors = 0;
  health.lastSuccessAt = Date.now();
  health.latencies.push(latencyMs);
  if (health.latencies.length > 20) health.latencies.shift();
  health.circuitOpen = false;
  health.status = "up";
}

function recordFailure(health, error) {
  health.totalCalls++;
  health.totalErrors++;
  health.consecutiveErrors++;
  health.lastError = error.message || String(error);
  health.lastErrorAt = Date.now();

  if (health.consecutiveErrors >= 3) health.status = "degraded";
  if (health.consecutiveErrors >= 8) health.status = "down";
}

/* ── Circuit breaker ── */

const CIRCUIT_THRESHOLD = 5;     // consecutive failures to trip
const CIRCUIT_RESET_MS = 60_000; // 1 minute cooldown

function isCircuitOpen(health) {
  if (!health.circuitOpen) return false;
  if (Date.now() > health.circuitOpenUntil) {
    health.circuitOpen = false; // half-open: allow one probe
    return false;
  }
  return true;
}

function tripCircuit(health) {
  health.circuitOpen = true;
  health.circuitOpenUntil = Date.now() + CIRCUIT_RESET_MS;
  health.status = "down";
}

/* ── Retry with exponential backoff ── */

/**
 * Wrap an async function with retry, backoff, circuit breaker, and health tracking.
 *
 * @param {string} sourceName - Source identifier for health tracking
 * @param {Function} fn - Async function to wrap
 * @param {object} opts
 * @param {number} opts.maxRetries - Max retry attempts (default: 3)
 * @param {number} opts.baseDelayMs - Base delay for backoff (default: 500)
 * @param {number} opts.maxDelayMs - Max delay cap (default: 10000)
 * @param {number} opts.timeoutMs - Per-call timeout (default: 15000)
 * @param {Function} opts.fallback - Fallback function if all retries fail
 * @param {boolean} opts.isRateLimit - Function to detect rate-limit responses
 * @returns {Function} Wrapped function with same signature
 */
export function withResilience(sourceName, fn, opts = {}) {
  const maxRetries = opts.maxRetries ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 500;
  const maxDelayMs = opts.maxDelayMs ?? 10_000;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const fallback = opts.fallback ?? null;

  return async function resilientCall(...args) {
    const health = getHealth(sourceName);

    // Circuit breaker check
    if (isCircuitOpen(health)) {
      if (fallback) return fallback(...args);
      throw new Error(`[resilience] ${sourceName}: circuit open (${health.consecutiveErrors} consecutive failures)`);
    }

    let lastError = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const start = Date.now();

      try {
        // Timeout wrapper
        const result = await Promise.race([
          fn(...args),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs)
          )
        ]);

        recordSuccess(health, Date.now() - start);
        return result;
      } catch (err) {
        lastError = err;
        recordFailure(health, err);

        // Rate limit detection (429)
        const isRateLimit = err.message?.includes("429") || err.message?.includes("rate");

        // Don't retry on certain errors
        const noRetry = err.message?.includes("404") || err.message?.includes("401");
        if (noRetry) break;

        if (attempt < maxRetries) {
          // Exponential backoff with jitter
          const delay = Math.min(
            baseDelayMs * Math.pow(2, attempt) + Math.random() * 200,
            maxDelayMs
          );
          // Rate limited → longer backoff
          const actualDelay = isRateLimit ? delay * 3 : delay;
          await sleep(actualDelay);
        }
      }
    }

    // All retries exhausted
    if (health.consecutiveErrors >= CIRCUIT_THRESHOLD) {
      tripCircuit(health);
    }

    if (fallback) {
      try { return fallback(...args); } catch { /* fallback also failed */ }
    }

    throw lastError;
  };
}

/* ── Public API ── */

/**
 * Get health summary for all tracked sources.
 * @returns {object[]}
 */
export function getAllSourceHealth() {
  const result = [];
  for (const [, health] of sourceHealth) {
    const avgLatency = health.latencies.length > 0
      ? Math.round(health.latencies.reduce((a, b) => a + b, 0) / health.latencies.length)
      : null;
    const errorRate = health.totalCalls > 0
      ? ((health.totalErrors / health.totalCalls) * 100).toFixed(2) + "%"
      : "0%";

    result.push({
      name: health.name,
      status: health.status,
      totalCalls: health.totalCalls,
      errorRate,
      avgLatencyMs: avgLatency,
      consecutiveErrors: health.consecutiveErrors,
      circuitOpen: health.circuitOpen,
      lastError: health.lastError,
      lastErrorAt: health.lastErrorAt ? new Date(health.lastErrorAt).toISOString() : null,
      lastSuccessAt: health.lastSuccessAt ? new Date(health.lastSuccessAt).toISOString() : null
    });
  }
  return result;
}

/**
 * Get health for a single source.
 */
export function getSourceHealth(name) {
  return getAllSourceHealth().find(h => h.name === name) || null;
}

/**
 * Overall system status.
 * "ok" if all sources are up, "degraded" if any degraded, "down" if any critical source is down.
 */
export function getSystemStatus() {
  const all = getAllSourceHealth();
  if (all.length === 0) return "ok";
  if (all.some(h => h.status === "down")) return "down";
  if (all.some(h => h.status === "degraded")) return "degraded";
  return "ok";
}
