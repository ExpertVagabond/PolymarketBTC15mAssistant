import { CONFIG } from "./config.js";
import { formatNumber, formatPct } from "./utils.js";
import { createPoller } from "./core/poller.js";
import { createWindowTracker } from "./backtest/window-tracker.js";
import { applyGlobalProxyFromEnv } from "./net/proxy.js";
import readline from "node:readline";

applyGlobalProxyFromEnv();

/* ── ANSI & rendering helpers (unchanged from original) ── */

function fmtTimeLeft(mins) {
  const totalSeconds = Math.max(0, Math.floor(mins * 60));
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

const ANSI = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  lightRed: "\x1b[91m",
  gray: "\x1b[90m",
  white: "\x1b[97m",
  dim: "\x1b[2m"
};

function screenWidth() {
  const w = Number(process.stdout?.columns);
  return Number.isFinite(w) && w >= 40 ? w : 80;
}

function sepLine(ch = "─") {
  const w = screenWidth();
  return `${ANSI.white}${ch.repeat(w)}${ANSI.reset}`;
}

function renderScreen(text) {
  try {
    readline.cursorTo(process.stdout, 0, 0);
    readline.clearScreenDown(process.stdout);
  } catch { /* ignore */ }
  process.stdout.write(text);
}

function stripAnsi(s) {
  return String(s).replace(/\x1b\[[0-9;]*m/g, "");
}

function padLabel(label, width) {
  const visible = stripAnsi(label).length;
  if (visible >= width) return label;
  return label + " ".repeat(width - visible);
}

function centerText(text, width) {
  const visible = stripAnsi(text).length;
  if (visible >= width) return text;
  const left = Math.floor((width - visible) / 2);
  const right = width - visible - left;
  return " ".repeat(left) + text + " ".repeat(right);
}

const LABEL_W = 16;
function kv(label, value) {
  const l = padLabel(String(label), LABEL_W);
  return `${l}${value}`;
}

function colorPriceLine({ label, price, prevPrice, decimals = 0, prefix = "" }) {
  if (price === null || price === undefined) {
    return `${label}: ${ANSI.gray}-${ANSI.reset}`;
  }
  const p = Number(price);
  const prev = prevPrice === null || prevPrice === undefined ? null : Number(prevPrice);
  let color = ANSI.reset;
  let arrow = "";
  if (prev !== null && Number.isFinite(prev) && Number.isFinite(p) && p !== prev) {
    if (p > prev) { color = ANSI.green; arrow = " ↑"; }
    else { color = ANSI.red; arrow = " ↓"; }
  }
  const formatted = `${prefix}${formatNumber(p, decimals)}`;
  return `${label}: ${color}${formatted}${arrow}${ANSI.reset}`;
}

function formatSignedDelta(delta, base) {
  if (delta === null || base === null || base === 0) return `${ANSI.gray}-${ANSI.reset}`;
  const sign = delta > 0 ? "+" : delta < 0 ? "-" : "";
  const pct = (Math.abs(delta) / Math.abs(base)) * 100;
  return `${sign}$${Math.abs(delta).toFixed(2)}, ${sign}${pct.toFixed(2)}%`;
}

function colorByNarrative(text, narrative) {
  if (narrative === "LONG") return `${ANSI.green}${text}${ANSI.reset}`;
  if (narrative === "SHORT") return `${ANSI.red}${text}${ANSI.reset}`;
  return `${ANSI.gray}${text}${ANSI.reset}`;
}

function formatNarrativeValue(label, value, narrative) {
  return `${label}: ${colorByNarrative(value, narrative)}`;
}

function narrativeFromSign(x) {
  if (x === null || x === undefined || !Number.isFinite(Number(x)) || Number(x) === 0) return "NEUTRAL";
  return Number(x) > 0 ? "LONG" : "SHORT";
}

function narrativeFromSlope(slope) {
  if (slope === null || slope === undefined || !Number.isFinite(Number(slope)) || Number(slope) === 0) return "NEUTRAL";
  return Number(slope) > 0 ? "LONG" : "SHORT";
}

function formatProbPct(p, digits = 0) {
  if (p === null || p === undefined || !Number.isFinite(Number(p))) return "-";
  return `${(Number(p) * 100).toFixed(digits)}%`;
}

function fmtEtTime(now = new Date()) {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
    }).format(now);
  } catch { return "-"; }
}

function getBtcSession(now = new Date()) {
  const h = now.getUTCHours();
  const inAsia = h >= 0 && h < 8;
  const inEurope = h >= 7 && h < 16;
  const inUs = h >= 13 && h < 22;
  if (inEurope && inUs) return "Europe/US overlap";
  if (inAsia && inEurope) return "Asia/Europe overlap";
  if (inAsia) return "Asia";
  if (inEurope) return "Europe";
  if (inUs) return "US";
  return "Off-hours";
}

/* ── console renderer ── */

function renderTick(s) {
  const { timeAware, rec, indicators, market, prices, deltas, timing, poly } = s;

  const pLong = timeAware?.adjustedUp ?? null;
  const pShort = timeAware?.adjustedDown ?? null;
  const predictNarrative = (pLong !== null && pShort !== null && Number.isFinite(pLong) && Number.isFinite(pShort))
    ? (pLong > pShort ? "LONG" : pShort > pLong ? "SHORT" : "NEUTRAL")
    : "NEUTRAL";
  const predictValue = `${ANSI.green}LONG${ANSI.reset} ${ANSI.green}${formatProbPct(pLong, 0)}${ANSI.reset} / ${ANSI.red}SHORT${ANSI.reset} ${ANSI.red}${formatProbPct(pShort, 0)}${ANSI.reset}`;

  const haNarrative = (indicators.heiken.color ?? "").toLowerCase() === "green" ? "LONG" : (indicators.heiken.color ?? "").toLowerCase() === "red" ? "SHORT" : "NEUTRAL";
  const heikenValue = `${indicators.heiken.color ?? "-"} x${indicators.heiken.count}`;
  const heikenLine = formatNarrativeValue("Heiken Ashi", heikenValue, haNarrative);

  const rsiNarrative = narrativeFromSlope(indicators.rsiSlope);
  const rsiArrow = indicators.rsiSlope !== null && indicators.rsiSlope < 0 ? "↓" : indicators.rsiSlope !== null && indicators.rsiSlope > 0 ? "↑" : "-";
  const rsiValue = `${formatNumber(indicators.rsi, 1)} ${rsiArrow}`;
  const rsiLine = formatNarrativeValue("RSI", rsiValue, rsiNarrative);

  const macdNarrative = narrativeFromSign(indicators.macd?.hist ?? null);
  const macdLabel = indicators.macd === null
    ? "-"
    : indicators.macd.hist < 0
      ? (indicators.macd.histDelta !== null && indicators.macd.histDelta < 0 ? "bearish (expanding)" : "bearish")
      : (indicators.macd.histDelta !== null && indicators.macd.histDelta > 0 ? "bullish (expanding)" : "bullish");
  const macdLine = formatNarrativeValue("MACD", macdLabel, macdNarrative);

  const delta1Narrative = narrativeFromSign(deltas.delta1m);
  const delta3Narrative = narrativeFromSign(deltas.delta3m);
  const klines1m = s.klines.klines1m;
  const lastClose = klines1m.length ? klines1m[klines1m.length - 1]?.close ?? null : null;
  const deltaValue = `${colorByNarrative(formatSignedDelta(deltas.delta1m, lastClose), delta1Narrative)} | ${colorByNarrative(formatSignedDelta(deltas.delta3m, lastClose), delta3Narrative)}`;

  const vwapNarrative = narrativeFromSign(indicators.vwapDist);
  const vwapSlopeLabel = indicators.vwapSlope === null ? "-" : indicators.vwapSlope > 0 ? "UP" : indicators.vwapSlope < 0 ? "DOWN" : "FLAT";
  const vwapValue = `${formatNumber(indicators.vwap, 0)} (${formatPct(indicators.vwapDist, 2)}) | slope: ${vwapSlopeLabel}`;
  const vwapLine = formatNarrativeValue("VWAP", vwapValue, vwapNarrative);

  const marketUp = market.up;
  const marketDown = market.down;
  const marketUpStr = `${marketUp ?? "-"}${marketUp == null ? "" : "¢"}`;
  const marketDownStr = `${marketDown ?? "-"}${marketDown == null ? "" : "¢"}`;
  const polyHeaderValue = `${ANSI.green}↑ UP${ANSI.reset} ${marketUpStr}  |  ${ANSI.red}↓ DOWN${ANSI.reset} ${marketDownStr}`;

  const liquidity = market.liquidity;
  const settlementLeftMin = market.settlementLeftMin;
  const timeLeftMin = settlementLeftMin ?? timing.remainingMinutes;

  const currentPrice = prices.current;
  const spotPrice = prices.spot;
  const priceToBeat = prices.priceToBeat;

  const currentPriceBaseLine = colorPriceLine({ label: "CURRENT PRICE", price: currentPrice, prevPrice: s.prevCurrentPrice, decimals: 2, prefix: "$" });
  const ptbDelta = (currentPrice !== null && priceToBeat !== null && Number.isFinite(currentPrice) && Number.isFinite(priceToBeat))
    ? currentPrice - priceToBeat : null;
  const ptbDeltaColor = ptbDelta === null ? ANSI.gray : ptbDelta > 0 ? ANSI.green : ptbDelta < 0 ? ANSI.red : ANSI.gray;
  const ptbDeltaText = ptbDelta === null
    ? `${ANSI.gray}-${ANSI.reset}`
    : `${ptbDeltaColor}${ptbDelta > 0 ? "+" : ptbDelta < 0 ? "-" : ""}$${Math.abs(ptbDelta).toFixed(2)}${ANSI.reset}`;
  const currentPriceValue = currentPriceBaseLine.split(": ")[1] ?? currentPriceBaseLine;
  const currentPriceLine = kv("CURRENT PRICE:", `${currentPriceValue} (${ptbDeltaText})`);

  const binanceSpotBaseLine = colorPriceLine({ label: "BTC (Binance)", price: spotPrice, prevPrice: s.prevSpotPrice, decimals: 0, prefix: "$" });
  const diffLine = (spotPrice !== null && currentPrice !== null && Number.isFinite(spotPrice) && Number.isFinite(currentPrice) && currentPrice !== 0)
    ? (() => {
      const diffUsd = spotPrice - currentPrice;
      const diffPct = (diffUsd / currentPrice) * 100;
      const sign = diffUsd > 0 ? "+" : diffUsd < 0 ? "-" : "";
      return ` (${sign}$${Math.abs(diffUsd).toFixed(2)}, ${sign}${Math.abs(diffPct).toFixed(2)}%)`;
    })()
    : "";
  const binanceSpotLine = `${binanceSpotBaseLine}${diffLine}`;
  const binanceSpotValue = binanceSpotLine.split(": ")[1] ?? binanceSpotLine;
  const binanceSpotKvLine = kv("BTC (Binance):", binanceSpotValue);

  const titleLine = poly?.ok ? `${poly.market?.question ?? "-"}` : "-";
  const marketLine = kv("Market:", poly?.ok ? (poly.market?.slug ?? "-") : "-");

  const timeColor = timeLeftMin >= 10 && timeLeftMin <= 15 ? ANSI.green
    : timeLeftMin >= 5 && timeLeftMin < 10 ? ANSI.yellow
      : timeLeftMin >= 0 && timeLeftMin < 5 ? ANSI.red : ANSI.reset;

  const polyTimeLeftColor = settlementLeftMin !== null
    ? (settlementLeftMin >= 10 && settlementLeftMin <= 15 ? ANSI.green
      : settlementLeftMin >= 5 && settlementLeftMin < 10 ? ANSI.yellow
        : settlementLeftMin >= 0 && settlementLeftMin < 5 ? ANSI.red : ANSI.reset)
    : ANSI.reset;

  const lines = [
    titleLine,
    marketLine,
    kv("Time left:", `${timeColor}${fmtTimeLeft(timeLeftMin)}${ANSI.reset}`),
    "",
    sepLine(),
    "",
    kv("TA Predict:", predictValue),
    kv("Heiken Ashi:", heikenLine.split(": ")[1] ?? heikenLine),
    kv("RSI:", rsiLine.split(": ")[1] ?? rsiLine),
    kv("MACD:", macdLine.split(": ")[1] ?? macdLine),
    kv("Delta 1/3:", deltaValue),
    kv("VWAP:", vwapLine.split(": ")[1] ?? vwapLine),
    "",
    sepLine(),
    "",
    kv("POLYMARKET:", polyHeaderValue),
    liquidity !== null ? kv("Liquidity:", formatNumber(liquidity, 0)) : null,
    settlementLeftMin !== null ? kv("Time left:", `${polyTimeLeftColor}${fmtTimeLeft(settlementLeftMin)}${ANSI.reset}`) : null,
    priceToBeat !== null ? kv("PRICE TO BEAT: ", `$${formatNumber(priceToBeat, 0)}`) : kv("PRICE TO BEAT: ", `${ANSI.gray}-${ANSI.reset}`),
    currentPriceLine,
    "",
    sepLine(),
    "",
    binanceSpotKvLine,
    "",
    sepLine(),
    "",
    kv("ET | Session:", `${ANSI.white}${fmtEtTime(new Date())}${ANSI.reset} | ${ANSI.white}${getBtcSession(new Date())}${ANSI.reset}`),
    "",
    sepLine(),
    centerText(`${ANSI.dim}${ANSI.gray}created by @krajekis${ANSI.reset}`, screenWidth())
  ].filter((x) => x !== null);

  renderScreen(lines.join("\n") + "\n");
}

/* ── main ── */

async function main() {
  const poller = createPoller();
  const windowTracker = createWindowTracker();

  await poller.start((state, err) => {
    if (err) {
      console.log("────────────────────────────");
      console.log(`Error: ${err?.message ?? String(err)}`);
      console.log("────────────────────────────");
      return;
    }

    // track window outcomes for backtesting
    const finalized = windowTracker.onTick(state);
    if (finalized) {
      // window just rolled over — logged to outcomes.csv
    }

    renderTick(state);
  });
}

main();
