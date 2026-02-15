/**
 * Data freshness tracker — monitors last-update timestamps per data source.
 * Detects stale data before it causes bad trades.
 */

const STALE_THRESHOLD_MS = Number(process.env.STALE_THRESHOLD_MS) || 60_000; // 60s default

const sources = new Map();

/**
 * Record a successful data update for a source.
 * @param {string} name - Source identifier (e.g., "binance", "polymarket-clob", "chainlink")
 */
export function markFresh(name) {
  const now = Date.now();
  const entry = sources.get(name);
  if (entry) {
    entry.lastUpdate = now;
    entry.updateCount++;
  } else {
    sources.set(name, { name, lastUpdate: now, updateCount: 1, registeredAt: now });
  }
}

/**
 * Get freshness status for all tracked sources.
 * @returns {object[]} Array of { name, lastUpdate, ageMs, ageSec, stale, updateCount }
 */
export function getFreshness() {
  const now = Date.now();
  const result = [];
  for (const [, entry] of sources) {
    const ageMs = now - entry.lastUpdate;
    result.push({
      name: entry.name,
      lastUpdate: new Date(entry.lastUpdate).toISOString(),
      ageMs,
      ageSec: Math.round(ageMs / 1000),
      stale: ageMs > STALE_THRESHOLD_MS,
      updateCount: entry.updateCount
    });
  }
  return result.sort((a, b) => b.ageMs - a.ageMs); // stalest first
}

/**
 * Check if any source is stale.
 * @returns {{ anyStale: boolean, staleCount: number, staleSources: string[] }}
 */
export function checkStaleness() {
  const fresh = getFreshness();
  const stale = fresh.filter(s => s.stale);
  return {
    anyStale: stale.length > 0,
    staleCount: stale.length,
    totalSources: fresh.length,
    staleSources: stale.map(s => s.name)
  };
}

/**
 * Get freshness for a single source.
 */
export function getSourceFreshness(name) {
  return getFreshness().find(s => s.name === name) || null;
}
