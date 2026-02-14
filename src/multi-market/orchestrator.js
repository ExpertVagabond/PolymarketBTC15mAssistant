/**
 * Run N market loops in parallel.
 * Config via MULTI_MARKET_CONFIG env var (JSON) or markets.json file.
 */

import { createMarketLoop } from "./market-loop.js";
import { updateMarketState, getAllMarketStates } from "./state-manager.js";
import { renderMultiMarketTable } from "./renderer.js";
import { applyGlobalProxyFromEnv } from "../net/proxy.js";
import fs from "node:fs";

function loadMarketConfigs() {
  // try env var first
  const envJson = process.env.MULTI_MARKET_CONFIG;
  if (envJson) {
    try { return JSON.parse(envJson); } catch { /* fall through */ }
  }

  // try markets.json file
  try {
    if (fs.existsSync("./markets.json")) {
      return JSON.parse(fs.readFileSync("./markets.json", "utf8"));
    }
  } catch { /* fall through */ }

  // default: auto-select latest (one market)
  return [
    { label: "btc-15m-auto", slug: "", autoSelect: true }
  ];
}

export async function startOrchestrator() {
  applyGlobalProxyFromEnv();
  const configs = loadMarketConfigs();
  const loops = [];

  for (const cfg of configs) {
    const loop = createMarketLoop(cfg);
    loops.push(loop);

    // start each in parallel (non-blocking)
    loop.start((label, state, err) => {
      if (state) {
        updateMarketState(label, state);
      }
    });
  }

  // render table at fixed interval
  const renderInterval = setInterval(() => {
    const states = getAllMarketStates();
    if (states.length > 0) {
      renderMultiMarketTable(states);
    }
  }, 1000);

  // cleanup on exit
  process.on("SIGINT", () => {
    clearInterval(renderInterval);
    for (const loop of loops) loop.stop();
    process.exit(0);
  });

  return { loops, stop: () => { clearInterval(renderInterval); loops.forEach((l) => l.stop()); } };
}
