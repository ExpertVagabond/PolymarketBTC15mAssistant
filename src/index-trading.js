#!/usr/bin/env node
/**
 * Trading bot entry point.
 * Usage: node src/index-trading.js
 * DEFAULT: Dry-run only. Set ENABLE_TRADING=true AND TRADING_DRY_RUN=false for live.
 */

import { startTradingBot } from "./trading/bot.js";

startTradingBot();
