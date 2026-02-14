#!/usr/bin/env node
/**
 * Multi-market entry point.
 * Usage: node src/index-multi.js
 * Config: MULTI_MARKET_CONFIG env var (JSON array) or ./markets.json
 */

import { startOrchestrator } from "./multi-market/orchestrator.js";

startOrchestrator();
