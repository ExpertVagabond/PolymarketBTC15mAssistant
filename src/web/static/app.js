/* PolySignal — WebSocket client
 * Handles scanner mode (multi-market) and single-market tick mode.
 */

const $ = (id) => document.getElementById(id);
let mode = null;
let activeFilter = "all";
let lastScannerData = null;
let signalCache = {}; // keyed by market question for modal drill-down

/* ═══ Tab Switching ═══ */

let activeTab = "dashboard";
let analyticsLoaded = false;
let analyticsCharts = {};

function switchTab(tab) {
  activeTab = tab;
  $("tabDashboard").classList.toggle("active", tab === "dashboard");
  $("tabAnalytics").classList.toggle("active", tab === "analytics");
  $("scannerMode").style.display = tab === "dashboard" ? "block" : "none";
  $("analyticsMode").style.display = tab === "analytics" ? "block" : "none";

  if (tab === "analytics" && !analyticsLoaded) {
    loadAnalytics();
  }
}

window.switchTab = switchTab;

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

  // Cache signal data for modal drill-down
  signals.forEach((s, i) => { signalCache[i] = s; });

  container.innerHTML = '<div class="signal-grid">' + signals.map((s, idx) => {
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
      <div class="sig-card ${cardSide} ${strClass}" onclick="openSignalModal(${idx})" style="cursor:pointer">
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

/* ═══ Signal Detail Modal ═══ */

function openSignalModal(idx) {
  const s = signalCache[idx];
  if (!s) return;

  const isYes = s.side === "UP";
  const side = isYes ? "BUY YES" : "BUY NO";
  const confColor = (s.confidence >= 80) ? "green" : (s.confidence >= 60) ? "blue" : (s.confidence >= 40) ? "amber" : "red";

  // Confidence breakdown bars
  const bd = s.confidenceBreakdown || {};
  const breakdownItems = [
    { label: "Edge Magnitude", val: bd.edge ?? 0, max: 20 },
    { label: "Indicator Agree", val: bd.indicators ?? 0, max: 20 },
    { label: "Multi-TF Conf", val: bd.confluence ?? 0, max: 15 },
    { label: "Order Flow", val: bd.orderFlow ?? 0, max: 15 },
    { label: "BTC Correlation", val: bd.correlation ?? 0, max: 10 },
    { label: "Vol Regime", val: bd.volatility ?? 0, max: 10 },
    { label: "Time Decay", val: bd.timeDecay ?? 0, max: 5 },
    { label: "Regime Quality", val: bd.regime ?? 0, max: 5 }
  ];

  const breakdownHtml = breakdownItems.map(b => {
    const pct = b.max > 0 ? (b.val / b.max * 100).toFixed(0) : 0;
    const fill = pct >= 70 ? "green" : pct >= 40 ? "blue" : pct >= 20 ? "amber" : "red";
    return `<div class="breakdown-row">
      <span class="breakdown-label">${b.label}</span>
      <div class="breakdown-bar"><div class="breakdown-fill ${fill}" style="width:${pct}%"></div></div>
      <span class="breakdown-val">${b.val}/${b.max}</span>
    </div>`;
  }).join("");

  // Order flow details
  const of = s.orderFlow || {};
  const flowHtml = of.yes ? `
    <div class="modal-kv"><span class="k">Pressure</span><span class="v">${of.pressureLabel || "-"} (${of.alignedScore ?? "-"})</span></div>
    <div class="modal-kv"><span class="k">Flow Quality</span><span class="v">${of.flowQuality || "-"} ($${fmtCompact(of.totalDepth || 0)})</span></div>
    <div class="modal-kv"><span class="k">Spread</span><span class="v">${of.spreadQuality || "-"}</span></div>
    <div class="modal-kv"><span class="k">YES Bid/Ask</span><span class="v">$${fmtCompact(of.yes?.bidDepth || 0)} / $${fmtCompact(of.yes?.askDepth || 0)}</span></div>
    <div class="modal-kv"><span class="k">NO Bid/Ask</span><span class="v">$${fmtCompact(of.no?.bidDepth || 0)} / $${fmtCompact(of.no?.askDepth || 0)}</span></div>
    <div class="modal-kv"><span class="k">YES Walls</span><span class="v">${of.yes?.walls?.length ?? 0} detected</span></div>
    <div class="modal-kv"><span class="k">NO Walls</span><span class="v">${of.no?.walls?.length ?? 0} detected</span></div>
    <div class="modal-kv"><span class="k">Flow Supports?</span><span class="v" style="color:${of.flowSupports ? "#34d399" : of.flowConflicts ? "#f87171" : "#6b7280"}">${of.flowSupports ? "YES" : of.flowConflicts ? "CONFLICTS" : "NEUTRAL"}</span></div>
  ` : '<div class="modal-kv"><span class="k">Status</span><span class="v">No orderbook data</span></div>';

  // Kelly details
  const k = s.kelly || {};
  const kellyHtml = k.betPct != null ? `
    <div class="modal-kv"><span class="k">Full Kelly</span><span class="v">${(k.kellyFull * 100).toFixed(2)}%</span></div>
    <div class="modal-kv"><span class="k">Fraction Used</span><span class="v">${k.fraction ?? "0.25"}x (${k.sizingTier || "-"})</span></div>
    <div class="modal-kv"><span class="k">Recommended Bet</span><span class="v" style="color:#fbbf24;font-weight:700">${(k.betPct * 100).toFixed(2)}% of bankroll</span></div>
    <div class="modal-kv"><span class="k">Implied Odds</span><span class="v">${k.odds != null ? k.odds.toFixed(2) + ":1" : "-"}</span></div>
    <div class="modal-kv"><span class="k">Win Rate Adj</span><span class="v">${k.reason || "-"}</span></div>
  ` : '<div class="modal-kv"><span class="k">Status</span><span class="v">No Kelly data (PASS signal)</span></div>';

  // Confluence
  const conf = s.confluence;
  const confHtml = conf ? `
    <div class="modal-kv"><span class="k">Score</span><span class="v">${conf.score}/3 timeframes agree</span></div>
    <div class="modal-kv"><span class="k">Direction</span><span class="v">${conf.direction || "-"}</span></div>
  ` : '<div class="modal-kv"><span class="k">Status</span><span class="v">No confluence data</span></div>';

  // Correlation
  const corr = s.correlation;
  const corrHtml = corr ? `
    <div class="modal-kv"><span class="k">BTC Adjustment</span><span class="v">${corr.adj != null ? ((corr.adj - 1) * 100).toFixed(0) + "%" : "-"}</span></div>
    <div class="modal-kv"><span class="k">Reason</span><span class="v">${corr.reason || "-"}</span></div>
  ` : '<div class="modal-kv"><span class="k">Status</span><span class="v">No correlation data</span></div>';

  $("signalModalContent").innerHTML = `
    <button class="modal-close" onclick="closeModal()">&times;</button>
    <h3>${side} — ${esc(s.question || "Unknown")}</h3>
    <div class="modal-sub">${s.category || "other"} | ${s.strength || "GOOD"} | Settles in ${fmtSettlement(s.settlementLeftMin)}</div>

    <div class="modal-section">
      <div class="modal-section-title">Confidence Breakdown (${s.confidence ?? "-"}/100 ${s.confidenceTier || ""})</div>
      ${breakdownHtml}
    </div>

    <div class="modal-section">
      <div class="modal-section-title">Order Flow</div>
      ${flowHtml}
    </div>

    <div class="modal-section">
      <div class="modal-section-title">Kelly Criterion Sizing</div>
      ${kellyHtml}
    </div>

    <div class="modal-section">
      <div class="modal-section-title">Multi-Timeframe Confluence</div>
      ${confHtml}
    </div>

    <div class="modal-section">
      <div class="modal-section-title">BTC Correlation</div>
      ${corrHtml}
    </div>
  `;

  $("signalModal").classList.add("open");
}

function closeModal() {
  $("signalModal").classList.remove("open");
}

window.openSignalModal = openSignalModal;
window.closeModal = closeModal;

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeModal();
});

/* ═══ Analytics ═══ */

const CHART_COLORS = {
  green: "#34d399", greenBg: "#34d39930",
  red: "#f87171", redBg: "#f8717130",
  blue: "#60a5fa", blueBg: "#60a5fa30",
  amber: "#fbbf24", amberBg: "#fbbf2430",
  purple: "#a78bfa", purpleBg: "#a78bfa30",
  gray: "#6b7280"
};

const CHART_DEFAULTS = {
  responsive: true,
  maintainAspectRatio: false,
  animation: { duration: 400 },
  plugins: {
    legend: { display: false },
    tooltip: { backgroundColor: "#1a1a24", titleColor: "#e5e7eb", bodyColor: "#9ca3af", borderColor: "#2a2a36", borderWidth: 1, cornerRadius: 6 }
  },
  scales: {
    x: { grid: { color: "#141420" }, ticks: { color: "#4b5563", font: { size: 10 } } },
    y: { grid: { color: "#141420" }, ticks: { color: "#4b5563", font: { size: 10 } } }
  }
};

async function loadAnalytics() {
  analyticsLoaded = true;
  try {
    const [ts, cal, dd, stats, perf] = await Promise.all([
      fetch("/api/analytics/timeseries?days=30").then(r => r.json()),
      fetch("/api/analytics/calibration").then(r => r.json()),
      fetch("/api/analytics/drawdown").then(r => r.json()),
      fetch("/api/signals/stats").then(r => r.json()),
      fetch("/api/analytics/performance?days=7").then(r => r.json())
    ]);

    renderKPIs(stats, dd, perf);
    renderEquityChart(dd);
    renderWinRateChart(ts);
    renderCategoryChart(stats);
    renderCalibrationChart(cal);
    renderVolumeChart(ts);
    renderSettledTable();
  } catch (err) {
    console.error("[analytics] Load failed:", err);
  }
}

function renderKPIs(stats, dd, perf) {
  $("kpiWinRate").textContent = stats.winRate ? stats.winRate + "%" : "-";
  $("kpiWinRate").className = "summary-val" + (parseFloat(stats.winRate) >= 50 ? " highlight" : "");

  const totalPnl = perf.total_pnl;
  $("kpiTotalPnl").textContent = totalPnl != null ? (totalPnl >= 0 ? "+" : "") + totalPnl.toFixed(1) + "%" : "-";
  $("kpiTotalPnl").className = "summary-val" + (totalPnl >= 0 ? " highlight" : "");

  $("kpiSettled").textContent = (stats.wins || 0) + (stats.losses || 0);
  $("kpiDrawdown").textContent = dd.maxDrawdown ? dd.maxDrawdown.toFixed(1) + "%" : "-";
  $("kpiStreak").textContent = dd.currentStreak?.type
    ? `${dd.currentStreak.count} ${dd.currentStreak.type}`
    : "-";
  $("kpiAvgConf").textContent = perf.avg_confidence != null ? Math.round(perf.avg_confidence) : "-";
}

function renderEquityChart(dd) {
  const curve = dd.equityCurve || [];
  if (curve.length === 0) return;

  const labels = curve.map(p => {
    const d = new Date(p.date);
    return (d.getMonth() + 1) + "/" + d.getDate();
  });
  const data = curve.map(p => p.cumPnl);
  const drawdowns = curve.map(p => -p.drawdown);

  if (analyticsCharts.equity) analyticsCharts.equity.destroy();
  analyticsCharts.equity = new Chart($("equityChart"), {
    type: "line",
    data: {
      labels,
      datasets: [
        { label: "Cumulative P&L %", data, borderColor: CHART_COLORS.green, backgroundColor: CHART_COLORS.greenBg, fill: true, tension: 0.3, pointRadius: 0, borderWidth: 2 },
        { label: "Drawdown %", data: drawdowns, borderColor: CHART_COLORS.red, backgroundColor: CHART_COLORS.redBg, fill: true, tension: 0.3, pointRadius: 0, borderWidth: 1 }
      ]
    },
    options: { ...CHART_DEFAULTS, plugins: { ...CHART_DEFAULTS.plugins, legend: { display: true, labels: { color: "#6b7280", font: { size: 10 } } } } }
  });
}

function renderWinRateChart(ts) {
  if (!ts.length) return;

  const labels = ts.map(d => d.date.slice(5));
  const winRates = ts.map(d => d.win_rate ?? 0);

  if (analyticsCharts.winRate) analyticsCharts.winRate.destroy();
  analyticsCharts.winRate = new Chart($("winRateChart"), {
    type: "bar",
    data: {
      labels,
      datasets: [{
        label: "Win Rate %",
        data: winRates,
        backgroundColor: winRates.map(w => w >= 50 ? CHART_COLORS.greenBg : CHART_COLORS.redBg),
        borderColor: winRates.map(w => w >= 50 ? CHART_COLORS.green : CHART_COLORS.red),
        borderWidth: 1, borderRadius: 4
      }]
    },
    options: { ...CHART_DEFAULTS, scales: { ...CHART_DEFAULTS.scales, y: { ...CHART_DEFAULTS.scales.y, min: 0, max: 100 } } }
  });
}

function renderCategoryChart(stats) {
  const cats = (stats.byCategory || []).filter(c => c.wins + c.losses > 0);
  if (!cats.length) return;

  const labels = cats.map(c => c.category || "other");
  const winRates = cats.map(c => {
    const settled = c.wins + c.losses;
    return settled > 0 ? Math.round(c.wins / settled * 100) : 0;
  });
  const totals = cats.map(c => c.wins + c.losses);

  if (analyticsCharts.category) analyticsCharts.category.destroy();
  analyticsCharts.category = new Chart($("categoryChart"), {
    type: "bar",
    data: {
      labels,
      datasets: [{
        label: "Win Rate %",
        data: winRates,
        backgroundColor: [CHART_COLORS.greenBg, CHART_COLORS.blueBg, CHART_COLORS.amberBg, CHART_COLORS.purpleBg, CHART_COLORS.redBg],
        borderColor: [CHART_COLORS.green, CHART_COLORS.blue, CHART_COLORS.amber, CHART_COLORS.purple, CHART_COLORS.red],
        borderWidth: 1, borderRadius: 4
      }]
    },
    options: {
      ...CHART_DEFAULTS,
      indexAxis: "y",
      scales: {
        x: { ...CHART_DEFAULTS.scales.x, min: 0, max: 100 },
        y: { ...CHART_DEFAULTS.scales.y }
      },
      plugins: {
        ...CHART_DEFAULTS.plugins,
        tooltip: {
          ...CHART_DEFAULTS.plugins.tooltip,
          callbacks: { afterLabel: (ctx) => `${totals[ctx.dataIndex]} settled signals` }
        }
      }
    }
  });
}

function renderCalibrationChart(cal) {
  if (!cal.length) return;

  const labels = cal.map(b => b.bucket);
  const actual = cal.map(b => b.actual_win_rate ?? 0);
  const expected = cal.map(b => b.avg_confidence ?? 0);

  if (analyticsCharts.calibration) analyticsCharts.calibration.destroy();
  analyticsCharts.calibration = new Chart($("calibrationChart"), {
    type: "bar",
    data: {
      labels,
      datasets: [
        { label: "Actual Win Rate %", data: actual, backgroundColor: CHART_COLORS.greenBg, borderColor: CHART_COLORS.green, borderWidth: 1, borderRadius: 4 },
        { label: "Avg Confidence", data: expected, backgroundColor: CHART_COLORS.blueBg, borderColor: CHART_COLORS.blue, borderWidth: 1, borderRadius: 4 }
      ]
    },
    options: {
      ...CHART_DEFAULTS,
      scales: { ...CHART_DEFAULTS.scales, y: { ...CHART_DEFAULTS.scales.y, min: 0, max: 100 } },
      plugins: { ...CHART_DEFAULTS.plugins, legend: { display: true, labels: { color: "#6b7280", font: { size: 10 } } } }
    }
  });
}

function renderVolumeChart(ts) {
  if (!ts.length) return;

  const labels = ts.map(d => d.date.slice(5));
  const wins = ts.map(d => d.wins || 0);
  const losses = ts.map(d => d.losses || 0);
  const pending = ts.map(d => d.pending || 0);

  if (analyticsCharts.volume) analyticsCharts.volume.destroy();
  analyticsCharts.volume = new Chart($("volumeChart"), {
    type: "bar",
    data: {
      labels,
      datasets: [
        { label: "Wins", data: wins, backgroundColor: CHART_COLORS.green, borderRadius: 2 },
        { label: "Losses", data: losses, backgroundColor: CHART_COLORS.red, borderRadius: 2 },
        { label: "Pending", data: pending, backgroundColor: CHART_COLORS.gray, borderRadius: 2 }
      ]
    },
    options: {
      ...CHART_DEFAULTS,
      scales: { ...CHART_DEFAULTS.scales, x: { ...CHART_DEFAULTS.scales.x, stacked: true }, y: { ...CHART_DEFAULTS.scales.y, stacked: true } },
      plugins: { ...CHART_DEFAULTS.plugins, legend: { display: true, labels: { color: "#6b7280", font: { size: 10 } } } }
    }
  });
}

async function renderSettledTable() {
  try {
    const signals = await fetch("/api/signals/recent?limit=50").then(r => r.json());
    const settled = signals.filter(s => s.outcome != null).slice(0, 20);

    $("settledBody").innerHTML = settled.map(s => {
      const isWin = s.outcome === "WIN";
      const side = s.side === "UP" ? "YES" : "NO";
      const pnl = s.pnl_pct != null ? (s.pnl_pct >= 0 ? "+" : "") + s.pnl_pct.toFixed(1) + "%" : "-";
      const edge = s.edge != null ? (s.edge > 0 ? "+" : "") + (s.edge * 100).toFixed(1) + "%" : "-";
      const conf = s.confidence != null ? s.confidence : "-";
      const kelly = s.kelly_bet_pct != null ? (s.kelly_bet_pct * 100).toFixed(2) + "%" : "-";
      const time = s.settled_at ? new Date(s.settled_at).toLocaleDateString() : "-";

      return `<tr>
        <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(s.question)}">${esc(truncQ(s.question, 45))}</td>
        <td><span class="sig-cell ${s.side === 'UP' ? 'active' : ''}">${side}</span></td>
        <td><span style="color:${isWin ? CHART_COLORS.green : CHART_COLORS.red};font-weight:600">${s.outcome}</span></td>
        <td>${edge}</td>
        <td>${conf}</td>
        <td>${kelly}</td>
        <td style="color:${s.pnl_pct >= 0 ? CHART_COLORS.green : CHART_COLORS.red};font-weight:600">${pnl}</td>
        <td style="color:#4b5563">${time}</td>
      </tr>`;
    }).join("");
  } catch { /* ignore */ }
}
