/* PolySignal — WebSocket client
 * Handles scanner mode (multi-market) and single-market tick mode.
 */

const $ = (id) => document.getElementById(id);
let mode = null;
let activeFilter = "all";
let lastScannerData = null;

/* ═══ Scanner Mode ═══ */

function updateScannerUI(d) {
  lastScannerData = d;

  // Summary strip
  const sigCount = d.signals?.length ?? 0;
  $("statTracked").textContent = d.stats?.tracked ?? d.markets?.length ?? 0;
  $("statSignals").textContent = sigCount;
  $("statUpdated").textContent = new Date(d.timestamp).toLocaleTimeString();

  // Signal count badge
  const badge = $("sigCountBadge");
  badge.textContent = sigCount;
  badge.className = "signal-count-badge" + (sigCount === 0 ? " zero" : "");

  // Build filter buttons from categories
  buildFilterBar(d.markets || []);

  // Render signal cards
  renderSignalCards(d.signals || []);

  // Render markets table
  renderMarketsTable(d.markets || []);
}

function renderSignalCards(signals) {
  const container = $("signalCards");

  if (signals.length === 0) {
    container.innerHTML = `
      <div class="no-signals-box">
        <div class="icon">~</div>
        <p><strong>No active signals right now.</strong><br>
        The scanner is watching all markets. When the model finds a mispriced outcome, it will appear here.</p>
      </div>`;
    return;
  }

  container.innerHTML = '<div class="signal-grid">' + signals.map((s) => {
    const isYes = s.side === "UP";
    const sideLabel = isYes ? "BUY YES" : "BUY NO";
    const sideClass = isYes ? "yes" : "no";
    const cardSide = isYes ? "side-yes" : "side-no";
    const str = (s.strength || "GOOD").toUpperCase();
    const strClass = str === "STRONG" ? "str-strong" : "str-good";
    const badgeClass = str === "STRONG" ? "strong" : "good";

    const modelPct = s.modelUp != null ? (s.modelUp * 100).toFixed(1) : "-";
    const mktPrice = isYes
      ? (s.priceUp != null ? (s.priceUp * 100).toFixed(0) : "-")
      : (s.priceDown != null ? (s.priceDown * 100).toFixed(0) : "-");
    const edgePct = s.edge != null ? (s.edge * 100).toFixed(1) : "-";

    // Time remaining
    const timeLeft = fmtSettlement(s.settlementLeftMin);

    // Confidence score
    const confScore = s.confidence != null ? s.confidence : null;
    const confTier = s.confidenceTier || "";
    const confColor = confScore >= 80 ? "high" : confScore >= 60 ? "med" : confScore >= 40 ? "low" : "vlow";

    // Kelly sizing
    const kellyPct = s.kelly?.betPct != null ? (s.kelly.betPct * 100).toFixed(2) : null;

    // Order flow
    const flowLabel = s.orderFlow?.pressureLabel || null;
    const flowAligned = s.orderFlow?.flowSupports;
    const flowConflict = s.orderFlow?.flowConflicts;

    // Confluence badge
    const conf = s.confluence;
    const confBadge = conf ? `<span class="conf-badge conf-${conf.score}" title="${conf.direction} across ${conf.score} timeframe(s)">${conf.score}/3 TF</span>` : "";

    // Volatility badge
    const volBadge = s.volRegime ? `<span class="vol-badge vol-${s.volRegime.toLowerCase().replace("_","")}">${fmtVol(s.volRegime)}</span>` : "";

    // Correlation indicator
    const corrNote = s.correlation && s.correlation.adj !== 1.0
      ? `<span class="corr-note" title="${s.correlation.reason}">BTC ${s.correlation.adj > 1 ? "+" : ""}${((s.correlation.adj - 1) * 100).toFixed(0)}%</span>`
      : "";

    // Plain-English explanation
    const outcomeName = isYes ? "YES" : "NO";
    const timeNote = s.settlementLeftMin != null ? ` Market settles in <em>${timeLeft}</em>.` : "";
    const explain = s.edge != null && s.priceUp != null
      ? `Model sees ${outcomeName} at <em>${modelPct}%</em> probability, but the market is only pricing it at <em>${mktPrice}c</em>. That's a <em>+${edgePct}%</em> edge.${timeNote}`
      : `Model detects ${outcomeName} is underpriced in this market.${timeNote}`;

    // Flow badge
    const flowBadge = flowLabel && flowLabel !== "NEUTRAL"
      ? `<span class="flow-badge flow-${flowAligned ? "pos" : flowConflict ? "neg" : "neutral"}" title="Order flow: ${flowLabel}">${flowLabel === "STRONG_BUY" || flowLabel === "STRONG_SELL" ? flowLabel.replace("_"," ") : flowLabel}</span>`
      : "";

    return `
      <div class="sig-card ${cardSide} ${strClass}">
        <div class="sig-top">
          <span class="sig-action ${sideClass}">${sideLabel}</span>
          <span class="sig-badge ${badgeClass}">${str}</span>
          ${confScore != null ? `<span class="confidence-pill conf-${confColor}" title="Confidence: ${confTier}">${confScore}</span>` : ""}
          ${confBadge}${volBadge}${corrNote}${flowBadge}
        </div>
        <div class="sig-question">${esc(s.question || "Unknown market")}</div>
        ${confScore != null ? `<div class="confidence-bar"><div class="confidence-fill conf-${confColor}" style="width:${confScore}%"></div><span class="confidence-label">${confScore}/100 Confidence</span></div>` : ""}
        <div class="sig-metrics">
          <div class="sig-metric">
            <div class="sig-metric-label">Model</div>
            <div class="sig-metric-value">${modelPct}%</div>
          </div>
          <div class="sig-metric">
            <div class="sig-metric-label">Mkt Price</div>
            <div class="sig-metric-value">${mktPrice}c</div>
          </div>
          <div class="sig-metric">
            <div class="sig-metric-label">Edge</div>
            <div class="sig-metric-value green">+${edgePct}%</div>
          </div>
          <div class="sig-metric">
            <div class="sig-metric-label">Kelly Bet</div>
            <div class="sig-metric-value amber">${kellyPct != null ? kellyPct + "%" : "-"}</div>
          </div>
        </div>
        <div class="sig-meta">
          <span class="sig-meta-item">Settles in <em>${timeLeft}</em></span>
          ${s.orderFlow ? `<span class="sig-meta-item">Flow: <em>${s.orderFlow.flowQuality}</em> depth</span>` : ""}
          ${s.orderFlow?.spreadQuality ? `<span class="sig-meta-item">Spread: <em>${s.orderFlow.spreadQuality}</em></span>` : ""}
        </div>
        <div class="sig-explain">${explain}</div>
      </div>`;
  }).join("") + '</div>';
}

function renderMarketsTable(markets) {
  const filtered = markets
    .filter((m) => activeFilter === "all" || m.category === activeFilter)
    .sort((a, b) => {
      const aSig = a.signal !== "NO TRADE" ? 1 : 0;
      const bSig = b.signal !== "NO TRADE" ? 1 : 0;
      if (bSig !== aSig) return bSig - aSig;
      return (b.liquidity || 0) - (a.liquidity || 0);
    });

  $("marketsBody").innerHTML = filtered.map((m) => {
    const hasSignal = m.signal && m.signal !== "NO TRADE";
    const cat = m.category || "other";
    const catSlug = cat.toLowerCase().replace(/[^a-z0-9]/g, "");

    // Model probability (YES side)
    const modelPct = m.modelUp != null ? (m.modelUp * 100).toFixed(1) + "%" : "-";

    // Market prices
    const yesPrice = m.priceUp != null ? (m.priceUp * 100).toFixed(0) + "c" : "-";
    const noPrice = m.priceDown != null ? (m.priceDown * 100).toFixed(0) + "c" : "-";

    // Edge
    const isYesSide = m.rec?.side === "UP" || m.signal === "BUY UP";
    const bestEdge = isYesSide ? m.edgeUp : m.edgeDown;
    const edgeStr = bestEdge != null ? (bestEdge > 0 ? "+" : "") + (bestEdge * 100).toFixed(1) + "%" : "-";
    const edgeColor = bestEdge > 0 ? "green" : bestEdge < 0 ? "red" : "";
    const edgeWidth = bestEdge != null ? Math.min(Math.abs(bestEdge * 100) * 2, 60) : 0;
    const edgeFillClass = bestEdge >= 0 ? "pos" : "neg";

    // RSI
    const rsiStr = m.rsi != null ? m.rsi.toFixed(0) : "-";
    const rsiColor = m.rsi > 70 ? "red" : m.rsi < 30 ? "green" : "";

    // Volatility regime
    const volLabel = m.volRegime ? fmtVol(m.volRegime) : "-";
    const volClass = m.volRegime === "HIGH_VOL" ? "high" : m.volRegime === "LOW_VOL" ? "low" : "normal";

    // Confluence
    const mConfScore = m.confluence != null ? m.confluence : null;
    const confLabel = mConfScore != null ? mConfScore + "/3" : "-";
    const confClass = mConfScore === 3 ? "c3" : mConfScore === 2 ? "c2" : mConfScore >= 1 ? "c1" : "c0";

    // Confidence
    const mConf = m.confidence != null ? m.confidence : null;
    const mConfColor = mConf >= 80 ? "high" : mConf >= 60 ? "med" : mConf >= 40 ? "low" : "vlow";

    // Order flow
    const mFlow = m.orderFlow;
    const mFlowLabel = mFlow?.pressureLabel && mFlow.pressureLabel !== "NEUTRAL" ? mFlow.pressureLabel.replace("_"," ") : "-";

    // Time remaining
    const timeStr = fmtSettlement(m.settlementLeftMin);
    const timeClass = m.settlementLeftMin != null
      ? (m.settlementLeftMin < 5 ? "imminent" : m.settlementLeftMin < 30 ? "urgent" : "")
      : "";

    // Liquidity
    const liq = m.liquidity ? "$" + fmtCompact(m.liquidity) : "-";

    // Signal display
    let sigDisplay = '<span class="sig-cell inactive">--</span>';
    if (hasSignal) {
      const sigSide = m.signal.includes("UP") ? "YES" : "NO";
      sigDisplay = `<span class="sig-cell active">BUY ${sigSide}</span>`;
    }

    return `<tr class="${hasSignal ? "row-signal" : ""}">
      <td style="max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(m.question)}">${esc(truncQ(m.question, 60))}</td>
      <td><span class="cat-pill cat-${catSlug}">${esc(cat)}</span></td>
      <td>${sigDisplay}</td>
      <td>${modelPct}</td>
      <td class="price-pair"><span class="price-yes">${yesPrice}</span><span class="price-sep">/</span><span class="price-no">${noPrice}</span></td>
      <td><span class="edge-bar"><span class="${edgeColor}">${edgeStr}</span>${edgeWidth > 0 ? `<span class="edge-fill ${edgeFillClass}" style="width:${edgeWidth}px"></span>` : ""}</span></td>
      <td class="${rsiColor}">${rsiStr}</td>
      <td>${m.volRegime ? `<span class="vol-pill ${volClass}">${volLabel}</span>` : "-"}</td>
      <td>${mConfScore != null ? `<span class="conf-pill ${confClass}">${confLabel}</span>` : "-"}</td>
      <td>${mConf != null ? `<span class="confidence-pill-sm conf-${mConfColor}">${mConf}</span>` : "-"}</td>
      <td class="flow-cell">${mFlowLabel !== "-" ? `<span class="flow-pill ${mFlow?.flowSupports ? "pos" : mFlow?.flowConflicts ? "neg" : ""}">${mFlowLabel}</span>` : "-"}</td>
      <td class="time-val ${timeClass}">${timeStr}</td>
      <td class="liq-val">${liq}</td>
    </tr>`;
  }).join("");
}

/* ── Filter bar ── */

function buildFilterBar(markets) {
  const cats = [...new Set(markets.map((m) => m.category).filter(Boolean))].sort();
  const bar = $("filterBar");
  const existing = new Set([...bar.querySelectorAll(".fbtn")].map((b) => b.dataset.cat));

  for (const cat of cats) {
    if (!existing.has(cat)) {
      const btn = document.createElement("button");
      btn.className = "fbtn" + (activeFilter === cat ? " active" : "");
      btn.dataset.cat = cat;
      btn.textContent = cat;
      btn.onclick = () => setFilter(cat);
      bar.appendChild(btn);
    }
  }
}

function setFilter(cat) {
  activeFilter = cat;
  document.querySelectorAll(".fbtn").forEach((b) => {
    b.classList.toggle("active", b.dataset.cat === cat);
  });
  // Re-render table immediately with cached data
  if (lastScannerData) renderMarketsTable(lastScannerData.markets || []);
}

$("filterBar")?.querySelector('[data-cat="all"]')?.addEventListener("click", () => setFilter("all"));

/* ═══ Single-Market Mode (legacy fallback) ═══ */

const MAX_POINTS = 60;
const priceData = [], rsiData = [], probUpData = [], probDownData = [], labels = [];
let priceChart, rsiChart, probChart;

function initCharts() {
  const opts = (yMin, yMax) => ({
    responsive: true, maintainAspectRatio: false, animation: false,
    plugins: { legend: { display: false } },
    scales: {
      x: { display: false },
      y: { min: yMin, max: yMax, grid: { color: "#141420" }, ticks: { color: "#4b5563", font: { size: 10 } } }
    },
    elements: { point: { radius: 0 }, line: { borderWidth: 1.5 } }
  });
  const pc = $("priceChart"); if (!pc) return;
  priceChart = new Chart(pc, { type: "line", data: { labels, datasets: [{ data: priceData, borderColor: "#34d399", fill: false }] }, options: opts(undefined, undefined) });
  rsiChart = new Chart($("rsiChart"), { type: "line", data: { labels, datasets: [{ data: rsiData, borderColor: "#fbbf24", fill: false }] }, options: opts(20, 80) });
  probChart = new Chart($("probChart"), { type: "line", data: { labels, datasets: [{ data: probUpData, borderColor: "#34d399", fill: false }, { data: probDownData, borderColor: "#f87171", fill: false }] }, options: opts(0, 100) });
}

function updateSingleUI(d) {
  const sig = $("signalText");
  sig.textContent = d.signal || "-";
  sig.className = "signal-text " + (d.signal === "BUY UP" ? "buy-up" : d.signal === "BUY DOWN" ? "buy-down" : "no-trade-text");
  $("recDetail").textContent = d.rec ? `${d.rec.action} ${d.rec.side || ""} | ${d.rec.phase} | ${d.rec.strength || ""}` : "-";

  const up = d.model?.up != null ? (d.model.up * 100) : 50;
  $("probUp").style.width = up + "%"; $("probUp").textContent = `YES ${up.toFixed(0)}%`;
  $("probDown").style.width = (100 - up) + "%"; $("probDown").textContent = `NO ${(100 - up).toFixed(0)}%`;

  $("edgeUp").textContent = d.edge?.up != null ? (d.edge.up * 100).toFixed(1) + "%" : "-";
  $("edgeDown").textContent = d.edge?.down != null ? (d.edge.down * 100).toFixed(1) + "%" : "-";
  $("regime").textContent = d.regime || "-";

  $("btcPrice").textContent = d.prices?.spot ? "$" + fmtNum(d.prices.spot, 0) : "-";
  $("currentPrice").textContent = d.prices?.current ? "$" + fmtNum(d.prices.current, 2) : "-";
  $("priceToBeat").textContent = d.prices?.priceToBeat ? "$" + fmtNum(d.prices.priceToBeat, 0) : "-";
  const d1 = d.deltas?.delta1m, d3 = d.deltas?.delta3m;
  $("deltas").textContent = `${d1 != null ? (d1 > 0 ? "+" : "") + d1.toFixed(2) : "-"} / ${d3 != null ? (d3 > 0 ? "+" : "") + d3.toFixed(2) : "-"}`;

  $("vwap").textContent = d.indicators?.vwap ? fmtNum(d.indicators.vwap, 0) + (d.indicators.vwapSlope > 0 ? " ↑" : d.indicators.vwapSlope < 0 ? " ↓" : "") : "-";
  $("rsi").textContent = d.indicators?.rsi ? d.indicators.rsi.toFixed(1) : "-";
  const macd = d.indicators?.macd;
  $("macd").textContent = macd ? (macd.hist < 0 ? "Bearish" : "Bullish") : "-";
  const hk = d.indicators?.heiken;
  $("heiken").textContent = hk ? `${hk.color} x${hk.count}` : "-";
  $("timeLeft").textContent = d.timing?.remainingMinutes != null ? fmtTime(d.timing.remainingMinutes) : "-";
  $("marketSlug").textContent = d.market?.slug || "-";
  $("mktUp").textContent = d.market?.up != null ? d.market.up + "c" : "-";
  $("mktDown").textContent = d.market?.down != null ? d.market.down + "c" : "-";
  $("liquidity").textContent = d.market?.liquidity ? "$" + fmtNum(d.market.liquidity, 0) : "-";

  if (priceChart) {
    const now = new Date(d.timestamp).toLocaleTimeString().slice(0, 5);
    labels.push(now); priceData.push(d.prices?.spot || null); rsiData.push(d.indicators?.rsi || null);
    probUpData.push(d.model?.up != null ? d.model.up * 100 : null);
    probDownData.push(d.model?.down != null ? d.model.down * 100 : null);
    if (labels.length > MAX_POINTS) { labels.shift(); priceData.shift(); rsiData.shift(); probUpData.shift(); probDownData.shift(); }
    priceChart.update(); rsiChart.update(); probChart.update();
  }
}

/* ═══ Helpers ═══ */

function fmtNum(n, d) {
  if (n == null || isNaN(n)) return "-";
  return Number(n).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}

function fmtCompact(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return n.toFixed(0);
}

function fmtSettlement(min) {
  if (min == null) return "-";
  if (min < 1) return "<1m";
  if (min < 60) return Math.floor(min) + "m";
  const h = Math.floor(min / 60);
  const m = Math.floor(min % 60);
  if (h < 24) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh > 0 ? `${d}d ${rh}h` : `${d}d`;
}

function fmtTime(min) {
  const m = Math.floor(Math.max(0, min)), s = Math.floor((Math.max(0, min) - m) * 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function fmtVol(regime) {
  if (!regime) return "";
  return regime.replace("_VOL", "").replace("_", " ");
}

function esc(s) {
  if (!s) return "";
  const el = document.createElement("span");
  el.textContent = s;
  return el.innerHTML;
}

function truncQ(q, max) {
  if (!q) return "-";
  return q.length > max ? q.slice(0, max - 1) + "..." : q;
}

/* ═══ Mode Switching ═══ */

function switchMode(newMode) {
  if (mode === newMode) return;
  mode = newMode;
  if (mode === "scanner") {
    $("scannerMode").style.display = "block";
    $("singleMode").style.display = "none";
    $("singleMode").className = "";
  } else {
    $("scannerMode").style.display = "none";
    $("singleMode").style.display = "block";
    $("singleMode").className = "visible";
    if (!priceChart) initCharts();
  }
}

/* ═══ WebSocket ═══ */

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
      if (d.type === "scanner") {
        switchMode("scanner");
        updateScannerUI(d);
      } else if (d.type === "tick") {
        switchMode("single");
        updateSingleUI(d);
      }
    } catch { /* ignore parse errors */ }
  };

  ws.onclose = () => {
    $("statusDot").classList.remove("live");
    $("statusText").textContent = "Reconnecting...";
    setTimeout(connect, 2000);
  };

  ws.onerror = () => ws.close();
}

connect();
