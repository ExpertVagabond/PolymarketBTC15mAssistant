/**
 * Tabular console renderer for multi-market view.
 */

import readline from "node:readline";
import { formatNumber } from "../utils.js";

const ANSI = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  gray: "\x1b[90m",
  white: "\x1b[97m",
  dim: "\x1b[2m",
  bold: "\x1b[1m"
};

function renderScreen(text) {
  try {
    readline.cursorTo(process.stdout, 0, 0);
    readline.clearScreenDown(process.stdout);
  } catch { /* ignore */ }
  process.stdout.write(text);
}

function pad(s, w) {
  const str = String(s ?? "-");
  return str.length >= w ? str.slice(0, w) : str + " ".repeat(w - str.length);
}

function padR(s, w) {
  const str = String(s ?? "-");
  return str.length >= w ? str.slice(0, w) : " ".repeat(w - str.length) + str;
}

export function renderMultiMarketTable(markets) {
  const header = [
    pad("Market", 32),
    padR("Signal", 10),
    padR("Up%", 6),
    padR("Dn%", 6),
    padR("Mkt↑", 7),
    padR("Mkt↓", 7),
    padR("Edge↑", 7),
    padR("Edge↓", 7),
    padR("BTC", 10),
    padR("RSI", 5),
    padR("Regime", 12),
    padR("Time", 6)
  ].join(" | ");

  const sep = "─".repeat(header.length);

  const rows = markets.map((m) => {
    const state = m;
    if (!state || !state.signal) {
      return `${pad(m.label || "?", 32)} | ${ANSI.gray}warming up...${ANSI.reset}`;
    }

    const signalColor = state.signal === "BUY UP" ? ANSI.green : state.signal === "BUY DOWN" ? ANSI.red : ANSI.gray;
    const up = state.timeAware?.adjustedUp ? (state.timeAware.adjustedUp * 100).toFixed(0) : "-";
    const dn = state.timeAware?.adjustedDown ? (state.timeAware.adjustedDown * 100).toFixed(0) : "-";
    const mktUp = state.market?.up ?? "-";
    const mktDn = state.market?.down ?? "-";
    const edgeUp = state.edge?.edgeUp != null ? (state.edge.edgeUp * 100).toFixed(1) : "-";
    const edgeDn = state.edge?.edgeDown != null ? (state.edge.edgeDown * 100).toFixed(1) : "-";
    const btc = state.prices?.spot ? formatNumber(state.prices.spot, 0) : "-";
    const rsi = state.indicators?.rsi ? state.indicators.rsi.toFixed(0) : "-";
    const regime = state.regimeInfo?.regime ?? "-";
    const timeLeft = state.timing?.remainingMinutes ? `${state.timing.remainingMinutes.toFixed(0)}m` : "-";

    return [
      pad(state.market?.slug?.slice(0, 32) || m.label || "?", 32),
      `${signalColor}${padR(state.signal, 10)}${ANSI.reset}`,
      padR(up, 6),
      padR(dn, 6),
      padR(mktUp, 7),
      padR(mktDn, 7),
      padR(edgeUp, 7),
      padR(edgeDn, 7),
      padR(btc, 10),
      padR(rsi, 5),
      padR(regime, 12),
      padR(timeLeft, 6)
    ].join(" | ");
  });

  const now = new Date().toISOString().slice(11, 19);
  const lines = [
    `${ANSI.bold}${ANSI.white}Polymarket BTC Multi-Market Dashboard${ANSI.reset}  ${ANSI.dim}${now} UTC${ANSI.reset}`,
    "",
    `${ANSI.white}${sep}${ANSI.reset}`,
    `${ANSI.white}${header}${ANSI.reset}`,
    `${ANSI.white}${sep}${ANSI.reset}`,
    ...rows,
    `${ANSI.white}${sep}${ANSI.reset}`,
    "",
    `${ANSI.dim}${ANSI.gray}${markets.length} markets tracked${ANSI.reset}`
  ];

  renderScreen(lines.join("\n") + "\n");
}
