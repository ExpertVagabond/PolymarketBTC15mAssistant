/* WebSocket client + Chart.js sparklines */

const MAX_POINTS = 60;
const priceData = [];
const rsiData = [];
const probUpData = [];
const probDownData = [];
const labels = [];

/* Chart setup */
const chartOpts = (yMin, yMax) => ({
  responsive: true,
  maintainAspectRatio: false,
  animation: false,
  plugins: { legend: { display: false } },
  scales: {
    x: { display: false },
    y: {
      min: yMin, max: yMax,
      grid: { color: "#1a1a22" },
      ticks: { color: "#555", font: { size: 10 } }
    }
  },
  elements: { point: { radius: 0 }, line: { borderWidth: 1.5 } }
});

const priceChart = new Chart(document.getElementById("priceChart"), {
  type: "line",
  data: { labels, datasets: [{ data: priceData, borderColor: "#00ff88", fill: false }] },
  options: chartOpts(undefined, undefined)
});

const rsiChart = new Chart(document.getElementById("rsiChart"), {
  type: "line",
  data: { labels, datasets: [{ data: rsiData, borderColor: "#ffaa00", fill: false }] },
  options: chartOpts(20, 80)
});

const probChart = new Chart(document.getElementById("probChart"), {
  type: "line",
  data: {
    labels,
    datasets: [
      { data: probUpData, borderColor: "#00ff88", fill: false, label: "UP" },
      { data: probDownData, borderColor: "#ff4444", fill: false, label: "DOWN" }
    ]
  },
  options: chartOpts(0, 100)
});

/* DOM refs */
const $ = (id) => document.getElementById(id);

function fmt(n, d) {
  if (n == null || isNaN(n)) return "-";
  return Number(n).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}

function fmtTime(min) {
  if (min == null) return "-";
  const m = Math.floor(Math.max(0, min));
  const s = Math.floor((Math.max(0, min) - m) * 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function updateUI(d) {
  // signal
  const sig = $("signalText");
  sig.textContent = d.signal || "-";
  sig.className = "signal-text " + (d.signal === "BUY UP" ? "buy-up" : d.signal === "BUY DOWN" ? "buy-down" : "no-trade");
  $("recDetail").textContent = d.rec ? `${d.rec.action} ${d.rec.side || ""} | ${d.rec.phase} | ${d.rec.strength || ""}` : "-";

  // probability bar
  const up = d.model?.up != null ? (d.model.up * 100) : 50;
  const dn = 100 - up;
  $("probUp").style.width = up + "%";
  $("probUp").textContent = `UP ${up.toFixed(0)}%`;
  $("probDown").style.width = dn + "%";
  $("probDown").textContent = `DOWN ${dn.toFixed(0)}%`;

  // edge
  $("edgeUp").textContent = d.edge?.up != null ? (d.edge.up * 100).toFixed(1) + "%" : "-";
  $("edgeUp").className = "kv-value " + (d.edge?.up > 0 ? "green" : d.edge?.up < 0 ? "red" : "");
  $("edgeDown").textContent = d.edge?.down != null ? (d.edge.down * 100).toFixed(1) + "%" : "-";
  $("edgeDown").className = "kv-value " + (d.edge?.down > 0 ? "green" : d.edge?.down < 0 ? "red" : "");
  $("regime").textContent = d.regime || "-";

  // prices
  $("btcPrice").textContent = d.prices?.spot ? "$" + fmt(d.prices.spot, 0) : "-";
  $("currentPrice").textContent = d.prices?.current ? "$" + fmt(d.prices.current, 2) : "-";
  $("priceToBeat").textContent = d.prices?.priceToBeat ? "$" + fmt(d.prices.priceToBeat, 0) : "-";
  const d1 = d.deltas?.delta1m; const d3 = d.deltas?.delta3m;
  $("deltas").textContent = `${d1 != null ? (d1 > 0 ? "+" : "") + d1.toFixed(2) : "-"} / ${d3 != null ? (d3 > 0 ? "+" : "") + d3.toFixed(2) : "-"}`;

  // indicators
  $("vwap").textContent = d.indicators?.vwap ? fmt(d.indicators.vwap, 0) + (d.indicators.vwapSlope > 0 ? " ↑" : d.indicators.vwapSlope < 0 ? " ↓" : "") : "-";
  $("rsi").textContent = d.indicators?.rsi ? d.indicators.rsi.toFixed(1) + (d.indicators.rsiSlope > 0 ? " ↑" : d.indicators.rsiSlope < 0 ? " ↓" : "") : "-";
  const macd = d.indicators?.macd;
  $("macd").textContent = macd ? (macd.hist < 0 ? "Bearish" : "Bullish") + (macd.histDelta && Math.abs(macd.histDelta) > 0 ? " (exp)" : "") : "-";
  const hk = d.indicators?.heiken;
  $("heiken").textContent = hk ? `${hk.color} x${hk.count}` : "-";
  $("heiken").className = "kv-value " + (hk?.color === "green" ? "green" : hk?.color === "red" ? "red" : "");
  $("timeLeft").textContent = fmtTime(d.timing?.remainingMinutes);

  // polymarket
  $("marketSlug").textContent = d.market?.slug || "-";
  $("mktUp").textContent = d.market?.up != null ? d.market.up + "¢" : "-";
  $("mktDown").textContent = d.market?.down != null ? d.market.down + "¢" : "-";
  $("liquidity").textContent = d.market?.liquidity ? "$" + fmt(d.market.liquidity, 0) : "-";

  // charts
  const now = new Date(d.timestamp).toLocaleTimeString().slice(0, 5);
  labels.push(now);
  priceData.push(d.prices?.spot || null);
  rsiData.push(d.indicators?.rsi || null);
  probUpData.push(d.model?.up != null ? d.model.up * 100 : null);
  probDownData.push(d.model?.down != null ? d.model.down * 100 : null);

  if (labels.length > MAX_POINTS) {
    labels.shift(); priceData.shift(); rsiData.shift(); probUpData.shift(); probDownData.shift();
  }

  priceChart.update();
  rsiChart.update();
  probChart.update();
}

/* WebSocket connection with auto-reconnect */
function connect() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${proto}//${location.host}/ws`);

  ws.onopen = () => {
    $("statusDot").classList.add("live");
    $("statusText").textContent = "Live";
  };

  ws.onmessage = (e) => {
    try {
      const d = JSON.parse(e.data);
      if (d.type === "tick") updateUI(d);
    } catch { /* ignore */ }
  };

  ws.onclose = () => {
    $("statusDot").classList.remove("live");
    $("statusText").textContent = "Reconnecting...";
    setTimeout(connect, 2000);
  };

  ws.onerror = () => ws.close();
}

connect();
