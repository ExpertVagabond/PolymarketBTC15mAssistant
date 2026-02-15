/**
 * Endpoint performance tracking.
 * Fastify onResponse hook that records response times per route.
 * Logs slow requests (>500ms) and exposes stats via /api/admin/perf.
 */

const SLOW_THRESHOLD_MS = 500;
const MAX_SLOW_LOG = 100;

/** Per-route stats: { route: { count, totalMs, maxMs, p95Bucket, slow } } */
const routeStats = new Map();

/** Recent slow requests (ring buffer) */
const slowLog = [];

/**
 * Fastify onResponse hook — register on the app instance.
 */
export function perfHook(request, reply, done) {
  const start = request.perfStart || Date.now();
  const duration = Date.now() - start;
  const route = request.routeOptions?.url || request.url;
  const method = request.method;
  const key = `${method} ${route}`;

  let stat = routeStats.get(key);
  if (!stat) {
    stat = { count: 0, totalMs: 0, maxMs: 0, errors: 0, buckets: [0, 0, 0, 0, 0] }; // <10, <50, <200, <500, 500+
    routeStats.set(key, stat);
  }

  stat.count++;
  stat.totalMs += duration;
  if (duration > stat.maxMs) stat.maxMs = duration;
  if (reply.statusCode >= 400) stat.errors++;

  // Bucket: <10ms, <50ms, <200ms, <500ms, >=500ms
  if (duration < 10) stat.buckets[0]++;
  else if (duration < 50) stat.buckets[1]++;
  else if (duration < 200) stat.buckets[2]++;
  else if (duration < 500) stat.buckets[3]++;
  else stat.buckets[4]++;

  // Slow request logging
  if (duration >= SLOW_THRESHOLD_MS) {
    slowLog.push({
      route: key,
      durationMs: duration,
      status: reply.statusCode,
      ts: new Date().toISOString()
    });
    if (slowLog.length > MAX_SLOW_LOG) slowLog.shift();
    console.warn(`[perf] Slow request: ${key} ${duration}ms (${reply.statusCode})`);
  }

  done();
}

/**
 * Fastify onRequest hook — stamps perfStart on the request.
 */
export function perfStartHook(request, reply, done) {
  request.perfStart = Date.now();
  done();
}

/**
 * Get aggregated performance stats.
 */
export function getPerfStats() {
  const routes = [];
  for (const [route, stat] of routeStats.entries()) {
    routes.push({
      route,
      count: stat.count,
      avgMs: stat.count > 0 ? Math.round(stat.totalMs / stat.count) : 0,
      maxMs: stat.maxMs,
      errors: stat.errors,
      errorRate: stat.count > 0 ? +(stat.errors / stat.count * 100).toFixed(1) : 0,
      distribution: {
        "<10ms": stat.buckets[0],
        "<50ms": stat.buckets[1],
        "<200ms": stat.buckets[2],
        "<500ms": stat.buckets[3],
        ">=500ms": stat.buckets[4]
      }
    });
  }

  // Sort by total traffic descending
  routes.sort((a, b) => b.count - a.count);

  return {
    routes: routes.slice(0, 50),
    totalRoutes: routes.length,
    slowRequests: slowLog.slice(-20),
    slowThresholdMs: SLOW_THRESHOLD_MS
  };
}

/**
 * Reset perf stats (for testing or admin use).
 */
export function resetPerfStats() {
  routeStats.clear();
  slowLog.length = 0;
  return { ok: true };
}
