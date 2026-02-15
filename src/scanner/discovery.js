/**
 * Market discovery: fetch ALL active Polymarket markets, categorize, filter.
 * Polls Gamma API every 5 minutes, caches results.
 */

import { CONFIG } from "../config.js";

const GAMMA_BASE = CONFIG.gammaBaseUrl;
const DISCOVERY_INTERVAL_MS = 5 * 60_000;

let cachedMarkets = [];
let lastFetchMs = 0;

/**
 * Paginate through all active events and flatten their markets.
 */
export async function fetchAllActiveEvents({ limit = 50, maxPages = 10 } = {}) {
  const allEvents = [];
  let offset = 0;

  for (let page = 0; page < maxPages; page++) {
    const url = new URL("/events", GAMMA_BASE);
    url.searchParams.set("active", "true");
    url.searchParams.set("closed", "false");
    url.searchParams.set("order", "id");
    url.searchParams.set("ascending", "false");
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("offset", String(offset));

    const res = await fetch(url);
    if (!res.ok) break;
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) break;

    allEvents.push(...data);
    if (data.length < limit) break;
    offset += limit;
  }

  return allEvents;
}

/**
 * Flatten events into individual markets with metadata.
 */
export function flattenAndEnrich(events) {
  const markets = [];

  for (const event of events) {
    const eventMarkets = Array.isArray(event.markets) ? event.markets : [];
    const tags = Array.isArray(event.tags) ? event.tags.map((t) => t.label || t.slug || t) : [];
    const category = tags[0] || guessCategory(event.title || "");

    for (const m of eventMarkets) {
      const outcomes = Array.isArray(m.outcomes)
        ? m.outcomes
        : typeof m.outcomes === "string" ? JSON.parse(m.outcomes) : [];
      const clobTokenIds = Array.isArray(m.clobTokenIds)
        ? m.clobTokenIds
        : typeof m.clobTokenIds === "string" ? JSON.parse(m.clobTokenIds) : [];
      const outcomePrices = Array.isArray(m.outcomePrices)
        ? m.outcomePrices
        : typeof m.outcomePrices === "string" ? JSON.parse(m.outcomePrices) : [];

      markets.push({
        id: m.id,
        conditionId: m.conditionId,
        slug: m.slug,
        question: m.question || event.title,
        outcomes,
        clobTokenIds,
        outcomePrices,
        category,
        tags,
        endDate: m.endDate || event.endDate,
        startDate: m.eventStartTime || m.startDate || event.startDate,
        liquidity: Number(m.liquidityNum || m.liquidity) || 0,
        volume: Number(m.volumeNum || m.volume) || 0,
        active: m.active !== false,
        closed: m.closed === true,
        enableOrderBook: m.enableOrderBook !== false,
        eventId: event.id,
        eventTitle: event.title
      });
    }
  }

  return markets;
}

function guessCategory(title) {
  const t = title.toLowerCase();
  if (/bitcoin|btc|eth|crypto|token|defi/i.test(t)) return "crypto";
  if (/president|election|vote|congress|senate|trump|biden/i.test(t)) return "politics";
  if (/nfl|nba|mlb|nhl|soccer|football|game|match|win/i.test(t)) return "sports";
  if (/weather|temperature|rain|hurricane/i.test(t)) return "weather";
  if (/gdp|inflation|fed|rate|cpi|jobs/i.test(t)) return "economics";
  return "other";
}

/**
 * Filter to binary markets with orderbook and minimum liquidity.
 */
export function filterTradableMarkets(markets, { minLiquidity = 100, categories = null } = {}) {
  return markets.filter((m) => {
    if (m.closed || !m.active) return false;
    if (!m.enableOrderBook) return false;
    if (m.outcomes.length !== 2) return false; // binary only
    if (m.clobTokenIds.length < 2) return false;
    if (m.liquidity < minLiquidity) return false;
    if (categories && categories.length > 0) {
      if (!categories.includes(m.category.toLowerCase())) return false;
    }
    return true;
  });
}

/**
 * Categorize markets into groups.
 */
export function categorizeMarkets(markets) {
  const groups = {};
  for (const m of markets) {
    const cat = m.category || "other";
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push(m);
  }
  return groups;
}

/**
 * Discover markets with caching. Returns fresh list every DISCOVERY_INTERVAL_MS.
 */
export async function discoverMarkets(opts = {}) {
  const now = Date.now();
  if (cachedMarkets.length > 0 && now - lastFetchMs < DISCOVERY_INTERVAL_MS) {
    return cachedMarkets;
  }

  const events = await fetchAllActiveEvents();
  const all = flattenAndEnrich(events);
  const tradable = filterTradableMarkets(all, {
    minLiquidity: opts.minLiquidity ?? 100,
    categories: opts.categories ?? null
  });

  // sort by liquidity descending
  tradable.sort((a, b) => b.liquidity - a.liquidity);

  // cap at max markets
  const maxMarkets = opts.maxMarkets ?? 50;
  cachedMarkets = tradable.slice(0, maxMarkets);
  lastFetchMs = now;

  return cachedMarkets;
}

export function getCachedMarkets() {
  return cachedMarkets;
}
