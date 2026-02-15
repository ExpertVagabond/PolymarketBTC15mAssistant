/**
 * Simple TTL-based in-memory response cache.
 * Reduces SQLite load on high-traffic endpoints.
 *
 * Usage: wrap endpoint handlers with cachedResponse(key, ttlMs, fn)
 */

const cache = new Map(); // key -> { data, expiresAt }
let hits = 0;
let misses = 0;

/**
 * Get a cached value, or compute and cache it.
 * @param {string} key - Cache key
 * @param {number} ttlMs - Time to live in milliseconds
 * @param {Function} fn - Async function that returns the data
 * @returns {Promise<any>}
 */
export async function cachedResponse(key, ttlMs, fn) {
  const now = Date.now();
  const entry = cache.get(key);
  if (entry && entry.expiresAt > now) {
    hits++;
    return entry.data;
  }

  misses++;
  const data = await fn();
  cache.set(key, { data, expiresAt: now + ttlMs });
  return data;
}

/**
 * Invalidate a cache key or keys matching a prefix.
 * @param {string} keyOrPrefix - Exact key or prefix to match
 */
export function invalidateCache(keyOrPrefix) {
  for (const key of cache.keys()) {
    if (key === keyOrPrefix || key.startsWith(keyOrPrefix + ":")) {
      cache.delete(key);
    }
  }
}

/**
 * Clear the entire cache.
 */
export function clearCache() {
  cache.clear();
}

/**
 * Get cache statistics.
 */
export function getCacheStats() {
  const now = Date.now();
  let active = 0;
  let expired = 0;
  for (const [, entry] of cache) {
    if (entry.expiresAt > now) active++;
    else expired++;
  }
  // Clean up expired entries
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(key);
  }
  return { entries: active, expired, hits, misses, hitRate: hits + misses > 0 ? Math.round((hits / (hits + misses)) * 100) : 0 };
}
