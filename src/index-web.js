#!/usr/bin/env node
/**
 * Web dashboard entry point.
 * Usage: node src/index-web.js
 * Env: WEB_PORT=3000
 */

import { startWebServer } from "./web/server.js";

startWebServer();
