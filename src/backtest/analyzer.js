#!/usr/bin/env node
/**
 * Standalone backtest analyzer.
 * Usage: node src/backtest/analyzer.js [--signals ./logs/signals.csv] [--outcomes ./logs/outcomes.csv]
 *
 * Joins signals.csv + outcomes.csv by window_id, computes accuracy, win rates,
 * simulated P&L, Sharpe ratio, max drawdown. Prints table, saves JSON.
 */

import fs from "node:fs";
import path from "node:path";
import { accuracy, winRateByCategory, simulatedPnl, sharpeRatio, maxDrawdown, profitFactor, expectancy } from "./metrics.js";

/* ── CLI args ── */

const args = process.argv.slice(2);
function argVal(flag, fallback) {
  const idx = args.indexOf(flag);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
}

const signalsPath = argVal("--signals", "./logs/signals.csv");
const outcomesPath = argVal("--outcomes", "./logs/outcomes.csv");

/* ── CSV parser ── */

function parseCsv(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, "utf8").trim();
  const lines = raw.split("\n");
  if (lines.length < 2) return [];
  const headers = lines[0].split(",").map((h) => h.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = lines[i].split(",");
    const obj = {};
    for (let j = 0; j < headers.length; j++) {
      obj[headers[j]] = vals[j]?.trim() ?? "";
    }
    rows.push(obj);
  }
  return rows;
}

/* ── main ── */

function run() {
  console.log("\n=== PolymarketBTC15m Backtest Analyzer ===\n");

  // load outcomes
  const outcomes = parseCsv(outcomesPath);
  if (!outcomes.length) {
    console.log(`No outcomes found at ${outcomesPath}`);
    console.log("Run the main app with window tracking enabled to collect data first.\n");
    process.exit(0);
  }

  console.log(`Loaded ${outcomes.length} windows from ${outcomesPath}`);

  // load signals
  const signals = parseCsv(signalsPath);
  console.log(`Loaded ${signals.length} signal ticks from ${signalsPath}`);

  // build signal summary per window
  const signalsByWindow = {};
  for (const s of signals) {
    const wid = s.window_id;
    if (!wid) continue;
    if (!signalsByWindow[wid]) signalsByWindow[wid] = { signals: [], modelUps: [], modelDowns: [], edgeUps: [], edgeDowns: [], regimes: [] };
    signalsByWindow[wid].signals.push(s.signal);
    if (s.model_up) signalsByWindow[wid].modelUps.push(Number(s.model_up));
    if (s.model_down) signalsByWindow[wid].modelDowns.push(Number(s.model_down));
    if (s.edge_up) signalsByWindow[wid].edgeUps.push(Number(s.edge_up));
    if (s.edge_down) signalsByWindow[wid].edgeDowns.push(Number(s.edge_down));
    if (s.regime) signalsByWindow[wid].regimes.push(s.regime);
  }

  // join outcomes with signal summaries
  const results = [];
  const trades = [];

  for (const o of outcomes) {
    const wid = o.window_id;
    const actual = o.outcome;
    if (!actual) continue;

    const sw = signalsByWindow[wid];
    const avgModelUp = sw?.modelUps.length ? sw.modelUps.reduce((a, b) => a + b, 0) / sw.modelUps.length : 0.5;
    const avgModelDown = sw?.modelDowns.length ? sw.modelDowns.reduce((a, b) => a + b, 0) / sw.modelDowns.length : 0.5;

    // dominant prediction from model probabilities
    const predicted = avgModelUp > avgModelDown ? "UP" : avgModelUp < avgModelDown ? "DOWN" : "NEUTRAL";

    const regime = o.regime_dominant || (sw?.regimes.length ? mostCommon(sw.regimes) : "UNKNOWN");
    const phase = Number(o.buy_up_count || 0) + Number(o.buy_down_count || 0) > 0 ? "ACTIVE" : "PASSIVE";

    results.push({ predicted, actual, category: regime, phase });

    // trades: windows where at least one BUY signal fired
    const buyUpCount = Number(o.buy_up_count || 0);
    const buyDownCount = Number(o.buy_down_count || 0);

    if (buyUpCount > 0 || buyDownCount > 0) {
      const tradeSide = buyUpCount >= buyDownCount ? "UP" : "DOWN";
      const avgEdge = tradeSide === "UP"
        ? (sw?.edgeUps.length ? sw.edgeUps.reduce((a, b) => a + b, 0) / sw.edgeUps.length : 0.1)
        : (sw?.edgeDowns.length ? sw.edgeDowns.reduce((a, b) => a + b, 0) / sw.edgeDowns.length : 0.1);

      trades.push({ predicted: tradeSide, actual, edge: Math.max(0.01, avgEdge) });
    }
  }

  function mostCommon(arr) {
    const counts = {};
    for (const x of arr) counts[x] = (counts[x] || 0) + 1;
    return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "UNKNOWN";
  }

  // compute metrics
  const overallAccuracy = accuracy(results);
  const byRegime = winRateByCategory(results);
  const byPhase = winRateByCategory(results.map((r) => ({ ...r, category: r.phase })));

  const pnl = simulatedPnl(trades);
  const sharpe = sharpeRatio(pnl.returns);
  const dd = maxDrawdown(pnl.returns);
  const pf = profitFactor(pnl.returns);
  const exp = expectancy(pnl.returns);

  // print results
  console.log("\n--- Overall ---");
  console.log(`  Windows analyzed:   ${results.length}`);
  console.log(`  Model accuracy:     ${overallAccuracy !== null ? (overallAccuracy * 100).toFixed(1) + "%" : "N/A"}`);
  console.log(`  Trade count:        ${trades.length}`);
  console.log(`  Simulated P&L:      $${pnl.totalPnl.toFixed(2)}`);
  console.log(`  Sharpe ratio:       ${sharpe !== null ? sharpe.toFixed(2) : "N/A"}`);
  console.log(`  Max drawdown:       $${dd.maxDrawdown.toFixed(2)} (${dd.maxDrawdownPct.toFixed(1)}%)`);
  console.log(`  Profit factor:      ${pf !== null ? (pf === Infinity ? "Inf" : pf.toFixed(2)) : "N/A"}`);
  console.log(`  Expectancy/trade:   ${exp !== null ? "$" + exp.toFixed(4) : "N/A"}`);

  console.log("\n--- Win Rate by Regime ---");
  for (const [regime, stats] of Object.entries(byRegime).sort((a, b) => b[1].total - a[1].total)) {
    console.log(`  ${regime.padEnd(14)} ${(stats.winRate * 100).toFixed(1)}% (${stats.wins}/${stats.total})`);
  }

  console.log("\n--- Win Rate by Phase ---");
  for (const [phase, stats] of Object.entries(byPhase).sort((a, b) => b[1].total - a[1].total)) {
    console.log(`  ${phase.padEnd(14)} ${(stats.winRate * 100).toFixed(1)}% (${stats.wins}/${stats.total})`);
  }

  // save JSON
  const report = {
    generatedAt: new Date().toISOString(),
    windowsAnalyzed: results.length,
    tradeCount: trades.length,
    overallAccuracy,
    totalPnl: pnl.totalPnl,
    sharpeRatio: sharpe,
    maxDrawdown: dd.maxDrawdown,
    maxDrawdownPct: dd.maxDrawdownPct,
    profitFactor: pf === Infinity ? "Infinity" : pf,
    expectancy: exp,
    byRegime,
    byPhase
  };

  const outPath = "./logs/backtest-results.json";
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), "utf8");
  console.log(`\nResults saved to ${outPath}\n`);
}

run();
