/* PolySignal — WebSocket client
 * Handles scanner mode (multi-market) and single-market tick mode.
 */

const $ = (id) => document.getElementById(id);
let mode = null;
let activeFilter = "all";
let lastScannerData = null;
let signalCache = {}; // keyed by market question for modal drill-down
let notificationsEnabled = false;
let notifiedSignals = new Set(); // track which signals we already notified
let audioCtx = null;

/* ═══ Feature Gates ═══ */

let userPlan = "free"; // free | basic | pro

const PLAN_GATES = {
  free: { maxSignals: 3, maxMarkets: 10, signalModal: false, portfolio: false, analytics: false, notifications: false, simulator: false, csvExport: false },
  basic: { maxSignals: Infinity, maxMarkets: Infinity, signalModal: true, portfolio: true, analytics: false, notifications: true, simulator: false, csvExport: false },
  pro: { maxSignals: Infinity, maxMarkets: Infinity, signalModal: true, portfolio: true, analytics: true, notifications: true, simulator: true, csvExport: true }
};

function gates() { return PLAN_GATES[userPlan] || PLAN_GATES.free; }

async function loadUserPlan() {
  try {
    const res = await fetch("/api/plan");
    if (res.ok) {
      const data = await res.json();
      userPlan = data.plan || "free";
    }
  } catch { /* not logged in = free */ }
  applyPlanUI();
  loadTrialStatus();
}

async function loadTrialStatus() {
  try {
    const res = await fetch("/api/trial/status");
    if (!res.ok) return;
    const data = await res.json();
    const el = $("trialBadge");
    if (data.active && data.daysRemaining != null && el) {
      el.textContent = `Trial: ${data.daysRemaining}d left`;
      el.style.display = "";
      el.style.color = data.daysRemaining <= 2 ? "#f87171" : "#fbbf24";
    }
  } catch { /* not logged in */ }
}

function applyPlanUI() {
  const badge = $("planBadge");
  if (badge) {
    badge.textContent = userPlan.toUpperCase();
    badge.className = "plan-badge " + userPlan;
  }

  // Show/hide notify button based on plan
  const notifyBtn = $("notifyBtn");
  if (notifyBtn) notifyBtn.style.display = gates().notifications ? "" : "none";
}

function showUpgradeModal() {
  $("upgradeModal")?.classList.add("open");
}

function closeUpgradeModal() {
  $("upgradeModal")?.classList.remove("open");
}

window.showUpgradeModal = showUpgradeModal;
window.closeUpgradeModal = closeUpgradeModal;

function gateOverlay(requiredPlan) {
  return `<div class="gate-overlay"><div class="gate-cta">
    <h3>Upgrade to ${requiredPlan === "pro" ? "Pro" : "Basic"}</h3>
    <p>${requiredPlan === "pro" ? "Analytics, strategy simulation, and CSV export require a Pro subscription." : "Full signal access, portfolio tracking, and notifications require a Basic subscription."}</p>
    <button class="upgrade-btn" onclick="showUpgradeModal()">View Plans</button>
    <div class="gate-tier">You're on the ${userPlan.toUpperCase()} plan</div>
  </div></div>`;
}

loadUserPlan();

/* ═══ Welcome / Onboarding ═══ */

let welcomeStep = 0;
const WELCOME_STEPS = 4;

function showWelcome() {
  if (localStorage.getItem("ps_welcomed")) return;
  $("welcomeModal")?.classList.add("open");
}

function closeWelcome() {
  $("welcomeModal")?.classList.remove("open");
  localStorage.setItem("ps_welcomed", "1");
}

function nextWelcomeStep() {
  welcomeStep++;
  if (welcomeStep >= WELCOME_STEPS) { closeWelcome(); return; }

  document.querySelectorAll(".welcome-step").forEach(s => s.classList.toggle("active", Number(s.dataset.step) === welcomeStep));
  document.querySelectorAll(".welcome-dot").forEach(d => d.classList.toggle("active", Number(d.dataset.dot) === welcomeStep));

  if (welcomeStep === WELCOME_STEPS - 1) {
    $("welcomeNextBtn").textContent = "Get Started";
  }
}

window.closeWelcome = closeWelcome;
window.nextWelcomeStep = nextWelcomeStep;

// Show welcome after a short delay so the page loads first
setTimeout(showWelcome, 1500);

/* ═══ Tab Switching ═══ */

let activeTab = "dashboard";
let analyticsLoaded = false;
let portfolioLoaded = false;
let portfolioRefreshTimer = null;
let analyticsCharts = {};

let simulatorLoaded = false;
let feedLoaded = false;
let settingsLoaded = false;

function switchTab(tab) {
  // Check feature gates
  if (tab === "analytics" && !gates().analytics) { showUpgradeModal(); return; }
  if (tab === "portfolio" && !gates().portfolio) { showUpgradeModal(); return; }
  if (tab === "simulator" && !gates().simulator) { showUpgradeModal(); return; }

  activeTab = tab;
  $("tabDashboard").classList.toggle("active", tab === "dashboard");
  $("tabAnalytics").classList.toggle("active", tab === "analytics");
  $("tabPortfolio").classList.toggle("active", tab === "portfolio");
  $("tabFeed").classList.toggle("active", tab === "feed");
  $("tabSimulator").classList.toggle("active", tab === "simulator");
  $("tabSettings").classList.toggle("active", tab === "settings");
  $("scannerMode").style.display = tab === "dashboard" ? "block" : "none";
  $("analyticsMode").style.display = tab === "analytics" ? "block" : "none";
  $("portfolioMode").style.display = tab === "portfolio" ? "block" : "none";
  $("feedMode").style.display = tab === "feed" ? "block" : "none";
  $("simulatorMode").style.display = tab === "simulator" ? "block" : "none";
  $("settingsMode").style.display = tab === "settings" ? "block" : "none";

  if (tab === "analytics" && !analyticsLoaded) {
    loadAnalytics();
  }
  if (tab === "feed" && !feedLoaded) {
    loadFeed();
    feedLoaded = true;
  }
  if (tab === "simulator" && !simulatorLoaded) {
    initSimulatorCategories();
    simulatorLoaded = true;
  }
  if (tab === "simulator") {
    loadStrategyList();
  }
  if (tab === "settings" && !settingsLoaded) {
    loadSettings();
    settingsLoaded = true;
  }
  if (tab === "portfolio") {
    loadPortfolio();
    if (!portfolioRefreshTimer) portfolioRefreshTimer = setInterval(loadPortfolio, 10_000);
  } else {
    if (portfolioRefreshTimer) { clearInterval(portfolioRefreshTimer); portfolioRefreshTimer = null; }
  }
}

window.switchTab = switchTab;

/* ═══ Notifications ═══ */

function toggleNotifications() {
  if (!gates().notifications) { showUpgradeModal(); return; }
  if (!notificationsEnabled) {
    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission().then(perm => {
        if (perm === "granted") enableNotifications();
      });
    } else if ("Notification" in window && Notification.permission === "granted") {
      enableNotifications();
    } else {
      enableNotifications(); // still enable sound even without permission
    }
  } else {
    notificationsEnabled = false;
    $("notifyBtn").textContent = "Alerts: Off";
    $("notifyBtn").classList.remove("active");
  }
}

function enableNotifications() {
  notificationsEnabled = true;
  $("notifyBtn").textContent = "Alerts: On";
  $("notifyBtn").classList.add("active");
  // Warm up audio context on user gesture
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
}

function checkNewSignals(signals) {
  if (!notificationsEnabled || !signals?.length) return;

  for (const s of signals) {
    const key = s.question + "|" + s.side;
    if (notifiedSignals.has(key)) continue;
    notifiedSignals.add(key);

    const side = s.side === "UP" ? "YES" : "NO";
    const isStrong = (s.strength || "").toUpperCase() === "STRONG";

    // Desktop notification
    if ("Notification" in window && Notification.permission === "granted") {
      new Notification(`PolySignal: BUY ${side}`, {
        body: `${s.question?.slice(0, 60)}\nEdge: +${((s.edge ?? 0) * 100).toFixed(1)}% | Conf: ${s.confidence ?? "-"}`,
        icon: "/favicon.ico",
        tag: key,
        requireInteraction: isStrong
      });
    }

    // Sound alert
    playAlertTone(isStrong);
  }

  // Prune old notifications (keep last 100)
  if (notifiedSignals.size > 100) {
    const arr = [...notifiedSignals];
    notifiedSignals = new Set(arr.slice(-50));
  }
}

function playAlertTone(isStrong) {
  if (!audioCtx) return;
  try {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.type = "sine";
    gain.gain.value = 0.15;

    if (isStrong) {
      // Two-tone alert for STRONG signals
      osc.frequency.value = 880;
      osc.start();
      osc.frequency.setValueAtTime(1100, audioCtx.currentTime + 0.1);
      gain.gain.setValueAtTime(0.15, audioCtx.currentTime + 0.1);
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.3);
      osc.stop(audioCtx.currentTime + 0.3);
    } else {
      // Single ping for GOOD signals
      osc.frequency.value = 660;
      osc.start();
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.15);
      osc.stop(audioCtx.currentTime + 0.15);
    }
  } catch { /* ignore audio errors */ }
}

window.toggleNotifications = toggleNotifications;

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

  // Check for new signals (notifications)
  checkNewSignals(d.signals || []);

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

  // Gate: limit signal cards for free users
  const maxSig = gates().maxSignals;
  const gatedSignals = signals.slice(0, maxSig);
  const hiddenCount = signals.length - gatedSignals.length;

  // Cache signal data for modal drill-down
  gatedSignals.forEach((s, i) => { signalCache[i] = s; });

  container.innerHTML = '<div class="signal-grid">' + gatedSignals.map((s, idx) => {
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
  }).join("") + '</div>'
    + (hiddenCount > 0 ? `<div style="text-align:center;padding:16px;color:#4b5563;font-size:12px">
      +${hiddenCount} more signal${hiddenCount > 1 ? "s" : ""} hidden.
      <button onclick="showUpgradeModal()" style="background:none;border:none;color:#60a5fa;cursor:pointer;font-size:12px;font-weight:600;text-decoration:underline">Upgrade to see all</button>
    </div>` : "");
}

function renderMarketsTable(markets) {
  const maxMkt = gates().maxMarkets;
  const filtered = markets
    .filter((m) => activeFilter === "all" || m.category === activeFilter)
    .sort((a, b) => {
      const aSig = a.signal !== "NO TRADE" ? 1 : 0;
      const bSig = b.signal !== "NO TRADE" ? 1 : 0;
      if (bSig !== aSig) return bSig - aSig;
      return (b.liquidity || 0) - (a.liquidity || 0);
    });

  const displayed = filtered.slice(0, maxMkt);
  const hiddenMkts = filtered.length - displayed.length;

  $("marketsBody").innerHTML = displayed.map((m) => {
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

    return `<tr class="${hasSignal ? "row-signal" : ""}" style="cursor:pointer" onclick="openMarketDetail('${esc(m.id || "")}')">
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
  }).join("")
    + (hiddenMkts > 0 ? `<tr><td colspan="13" style="text-align:center;color:#4b5563;padding:12px;font-size:12px">
      +${hiddenMkts} more market${hiddenMkts > 1 ? "s" : ""} hidden.
      <button onclick="showUpgradeModal()" style="background:none;border:none;color:#60a5fa;cursor:pointer;font-size:12px;font-weight:600;text-decoration:underline">Upgrade to see all</button>
    </td></tr>` : "");
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
    if ($("reconnectOverlay")) $("reconnectOverlay").style.display = "none";
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
    if ($("reconnectOverlay")) $("reconnectOverlay").style.display = "flex";
    setTimeout(connect, 2000);
  };

  ws.onerror = () => ws.close();
}

connect();

/* ═══ Signal Detail Modal ═══ */

function openSignalModal(idx) {
  if (!gates().signalModal) { showUpgradeModal(); return; }
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

let equityCurveDates = []; // store dates for drill-down

function renderEquityChart(dd) {
  const curve = dd.equityCurve || [];
  if (curve.length === 0) return;

  equityCurveDates = curve.map(p => p.date);
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
        { label: "Cumulative P&L %", data, borderColor: CHART_COLORS.green, backgroundColor: CHART_COLORS.greenBg, fill: true, tension: 0.3, pointRadius: 2, pointHoverRadius: 5, borderWidth: 2 },
        { label: "Drawdown %", data: drawdowns, borderColor: CHART_COLORS.red, backgroundColor: CHART_COLORS.redBg, fill: true, tension: 0.3, pointRadius: 0, borderWidth: 1 }
      ]
    },
    options: {
      ...CHART_DEFAULTS,
      onClick: (evt, elements) => {
        if (elements.length > 0) {
          const idx = elements[0].index;
          const date = equityCurveDates[idx];
          if (date) showDayDrillDown(date);
        }
      },
      plugins: { ...CHART_DEFAULTS.plugins, legend: { display: true, labels: { color: "#6b7280", font: { size: 10 } } },
        tooltip: { ...CHART_DEFAULTS.plugins.tooltip, callbacks: { afterLabel: () => "Click to view trades" } }
      }
    }
  });
}

async function showDayDrillDown(date) {
  try {
    const signals = await fetch("/api/signals/by-date?date=" + date).then(r => r.json());
    if (signals.error) return;

    const modal = $("signalModalContent");
    const settled = signals.filter(s => s.outcome != null);
    const wins = settled.filter(s => s.outcome === "WIN").length;
    const losses = settled.filter(s => s.outcome === "LOSS").length;

    modal.innerHTML = `
      <button class="modal-close" onclick="closeModal()">&times;</button>
      <h3>Trades on ${esc(date)}</h3>
      <div class="modal-sub">${signals.length} signals | ${wins}W / ${losses}L | ${settled.length ? Math.round(wins / settled.length * 100) : 0}% win rate</div>
      <div class="modal-section">
        ${signals.length === 0 ? '<div style="color:#4b5563;text-align:center;padding:20px">No signals on this date</div>' :
          signals.map(s => {
            const side = s.side === "UP" ? "YES" : "NO";
            const sideColor = s.side === "UP" ? "#34d399" : "#f87171";
            const edge = s.edge != null ? "+" + (s.edge * 100).toFixed(1) + "%" : "-";
            const pnl = s.pnl_pct != null ? (s.pnl_pct >= 0 ? "+" : "") + (s.pnl_pct * 100).toFixed(1) + "%" : "-";
            const pnlColor = (s.pnl_pct ?? 0) >= 0 ? "#34d399" : "#f87171";
            const outcomeClass = s.outcome === "WIN" ? "win" : s.outcome === "LOSS" ? "loss" : "";
            return `<div style="padding:8px 0;border-bottom:1px solid #141420;display:flex;align-items:center;gap:10px">
              <span style="color:${sideColor};font-weight:700;font-size:11px;width:36px">${side}</span>
              <span style="flex:1;font-size:12px;color:#d1d5db;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc((s.question || "").slice(0, 50))}</span>
              <span style="font-size:11px;color:#6b7280">${edge}</span>
              <span style="font-size:11px;font-weight:600" class="${outcomeClass}">${s.outcome || "OPEN"}</span>
              <span style="font-size:11px;font-weight:600;color:${pnlColor}">${pnl}</span>
            </div>`;
          }).join("")
        }
      </div>`;
    $("signalModal").classList.add("open");
  } catch (err) {
    console.error("[drill-down]", err);
  }
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

/* ═══ Portfolio ═══ */

async function loadPortfolio() {
  try {
    const [summary, positions, recent, predictions, riskData] = await Promise.all([
      fetch("/api/portfolio/summary").then(r => r.json()),
      fetch("/api/portfolio/positions").then(r => r.json()),
      fetch("/api/portfolio/recent?limit=30").then(r => r.json()),
      fetch("/api/portfolio/predictions").then(r => r.json()).catch(() => []),
      fetch("/api/portfolio/risk").then(r => r.json()).catch(() => null)
    ]);

    renderPortfolioKPIs(summary);
    renderOpenPositions(positions, predictions);
    renderRecentTrades(recent);
    renderPortfolioRisk(riskData);
    portfolioLoaded = true;
  } catch (err) {
    console.error("[portfolio] Load failed:", err);
  }
}

function renderPortfolioKPIs(s) {
  $("pfOpen").textContent = s.open_count ?? 0;
  $("pfExposure").textContent = s.total_exposure != null ? (s.total_exposure * 100).toFixed(1) + "%" : "-";

  const unr = s.totalUnrealized ?? 0;
  $("pfUnrealized").textContent = (unr >= 0 ? "+" : "") + unr.toFixed(2) + "%";
  $("pfUnrealized").className = "summary-val" + (unr >= 0 ? " highlight" : "");

  const real = s.realized_pnl ?? 0;
  $("pfRealized").textContent = (real >= 0 ? "+" : "") + real.toFixed(2) + "%";
  $("pfRealized").className = "summary-val" + (real >= 0 ? " highlight" : "");

  $("pfWinRate").textContent = s.winRate ? s.winRate + "%" : "-";
  $("pfBest").textContent = s.best_trade != null ? "+" + s.best_trade.toFixed(1) + "%" : "-";
}

function renderOpenPositions(positions, predictions) {
  // Build prediction lookup by position ID
  const predMap = {};
  if (Array.isArray(predictions)) {
    for (const pred of predictions) predMap[pred.positionId] = pred;
  }

  $("openPositionsBody").innerHTML = positions.length === 0
    ? '<tr><td colspan="10" style="text-align:center;color:#4b5563;padding:20px">No open positions. Signals will auto-open virtual positions.</td></tr>'
    : positions.map(p => {
      const side = p.side === "UP" ? "YES" : "NO";
      const pnlColor = p.unrealizedPnl >= 0 ? "#34d399" : "#f87171";
      const opened = p.opened_at ? new Date(p.opened_at).toLocaleTimeString() : "-";
      const pred = predMap[p.id];
      const winPct = pred ? pred.winProbabilityPct + "%" : "-";
      const winColor = pred ? (pred.winProbability >= 0.7 ? "#34d399" : pred.winProbability >= 0.45 ? "#fbbf24" : "#f87171") : "#4b5563";
      const riskBadge = pred ? `<span style="font-size:9px;font-weight:700;padding:1px 6px;border-radius:3px;background:${pred.risk==="LOW"?"#34d39918":"#f8717118"};color:${pred.risk==="LOW"?"#34d399":pred.risk==="HIGH"?"#f87171":"#fbbf24"}">${pred.risk}</span>` : "-";
      return `<tr>
        <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(p.question)}">${esc(truncQ(p.question, 45))}</td>
        <td><span class="sig-cell ${p.side === 'UP' ? 'active' : ''}">${side}</span></td>
        <td>${(p.entry_price * 100).toFixed(0)}c</td>
        <td>${(p.current_price * 100).toFixed(0)}c</td>
        <td style="color:#fbbf24">${(p.bet_pct * 100).toFixed(2)}%</td>
        <td>${p.confidence ?? "-"}</td>
        <td style="color:${pnlColor};font-weight:600">${p.unrealizedPnl >= 0 ? "+" : ""}${p.unrealizedPnl.toFixed(2)}%</td>
        <td style="color:${winColor};font-weight:600">${winPct}</td>
        <td>${riskBadge}</td>
        <td style="color:#4b5563">${opened}</td>
      </tr>`;
    }).join("");
}

function renderRecentTrades(trades) {
  const closed = trades.filter(t => t.status === "closed");
  $("recentTradesBody").innerHTML = closed.length === 0
    ? '<tr><td colspan="8" style="text-align:center;color:#4b5563;padding:20px">No closed trades yet.</td></tr>'
    : closed.map(t => {
      const side = t.side === "UP" ? "YES" : "NO";
      const pnl = t.pnl_pct != null ? (t.pnl_pct >= 0 ? "+" : "") + t.pnl_pct.toFixed(2) + "%" : "-";
      const pnlColor = (t.pnl_pct ?? 0) >= 0 ? "#34d399" : "#f87171";
      const closedAt = t.closed_at ? new Date(t.closed_at).toLocaleDateString() : "-";
      return `<tr>
        <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(t.question)}">${esc(truncQ(t.question, 45))}</td>
        <td><span class="sig-cell ${t.side === 'UP' ? 'active' : ''}">${side}</span></td>
        <td>${(t.entry_price * 100).toFixed(0)}c</td>
        <td>${(t.current_price * 100).toFixed(0)}c</td>
        <td style="color:#fbbf24">${(t.bet_pct * 100).toFixed(2)}%</td>
        <td style="color:${pnlColor};font-weight:600">${pnl}</td>
        <td>${t.close_reason || "settled"}</td>
        <td style="color:#4b5563">${closedAt}</td>
      </tr>`;
    }).join("");
}

function renderPortfolioRisk(data) {
  const el = $("portfolioRiskBlock");
  if (!el || !data || data.error) { if (el) el.innerHTML = ""; return; }

  const concColor = data.concentrationRisk === "HIGH" ? "#f87171" : data.concentrationRisk === "MEDIUM" ? "#fbbf24" : "#34d399";
  const concBg = data.concentrationRisk === "HIGH" ? "#f8717118" : data.concentrationRisk === "MEDIUM" ? "#fbbf2418" : "#34d39918";

  const concRows = (data.concentration || []).slice(0, 6).map(c =>
    `<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
      <span style="font-size:11px;color:#9ca3af;width:80px;flex-shrink:0">${esc(c.category)}</span>
      <div style="flex:1;height:6px;background:#1a1a24;border-radius:3px;overflow:hidden">
        <div style="width:${Math.min(c.exposurePct, 100)}%;height:100%;background:#60a5fa;border-radius:3px"></div>
      </div>
      <span style="font-size:11px;color:#e5e7eb;font-weight:600;width:36px;text-align:right">${c.exposurePct.toFixed(0)}%</span>
    </div>`
  ).join("");

  const se = data.sideExposure || {};
  el.innerHTML = `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">
      <div style="background:#0e0e16;border:1px solid #1a1a24;border-radius:6px;padding:10px;text-align:center">
        <div style="font-size:9px;color:#4b5563;text-transform:uppercase;margin-bottom:4px">Concentration Risk</div>
        <div style="font-size:16px;font-weight:700;color:${concColor}">${data.concentrationRisk}</div>
        <div style="font-size:10px;color:#4b5563">HHI: ${data.hhi != null ? data.hhi.toFixed(3) : "-"}</div>
      </div>
      <div style="background:#0e0e16;border:1px solid #1a1a24;border-radius:6px;padding:10px;text-align:center">
        <div style="font-size:9px;color:#4b5563;text-transform:uppercase;margin-bottom:4px">Side Exposure</div>
        <div style="font-size:13px;font-weight:700"><span style="color:#34d399">YES ${se.yesPct ?? 0}%</span> / <span style="color:#f87171">NO ${se.noPct ?? 0}%</span></div>
        <div style="font-size:10px;color:#4b5563">${data.openPositions ?? 0} open positions</div>
      </div>
    </div>
    <div style="font-size:10px;font-weight:700;color:#4b5563;text-transform:uppercase;margin-bottom:6px">Category Concentration</div>
    ${concRows || '<div style="color:#4b5563;font-size:11px">No positions</div>'}
    ${data.maxSinglePosition ? `<div style="margin-top:8px;font-size:11px;color:#6b7280">Max single position: <span style="color:#fbbf24;font-weight:600">${(data.maxSinglePosition.exposurePct || 0).toFixed(1)}%</span> in ${esc((data.maxSinglePosition.question || "").slice(0, 40))}</div>` : ""}
  `;
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

/* ═══ CSV Export ═══ */

async function exportCsv() {
  if (!gates().csvExport) { showUpgradeModal(); return; }
  try {
    const res = await fetch("/api/analytics/export?format=csv&days=90");
    const data = await res.json();
    if (!data.csv) { alert("No data to export"); return; }
    const blob = new Blob([data.csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `polysignal-signals-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (err) {
    console.error("[export] Failed:", err);
  }
}

window.exportCsv = exportCsv;

/* ═══ Strategy Simulator ═══ */

let simEquityChart = null;
let simSelectedCats = []; // empty = all
let simSelectedStr = "all";
let simSelectedSide = "all";

async function initSimulatorCategories() {
  try {
    const stats = await fetch("/api/signals/stats").then(r => r.json());
    const cats = (stats.byCategory || []).map(c => c.category).filter(Boolean).sort();
    const container = $("simCatChips");
    container.innerHTML = '<button class="sim-chip active" data-cat="all" onclick="toggleSimCat(this)">All</button>'
      + cats.map(c => `<button class="sim-chip" data-cat="${esc(c)}" onclick="toggleSimCat(this)">${esc(c)}</button>`).join("");
  } catch { /* ignore */ }
}

function toggleSimCat(btn) {
  const cat = btn.dataset.cat;
  if (cat === "all") {
    simSelectedCats = [];
    $("simCatChips").querySelectorAll(".sim-chip").forEach(b => b.classList.toggle("active", b.dataset.cat === "all"));
  } else {
    $("simCatChips").querySelector('[data-cat="all"]').classList.remove("active");
    btn.classList.toggle("active");
    simSelectedCats = [...$("simCatChips").querySelectorAll(".sim-chip.active")].map(b => b.dataset.cat).filter(c => c !== "all");
    if (simSelectedCats.length === 0) {
      $("simCatChips").querySelector('[data-cat="all"]').classList.add("active");
    }
  }
}

function toggleSimStr(btn) {
  const str = btn.dataset.str;
  btn.parentElement.querySelectorAll(".sim-chip").forEach(b => b.classList.remove("active"));
  btn.classList.add("active");
  simSelectedStr = str;
}

function toggleSimSide(btn) {
  const side = btn.dataset.side;
  btn.parentElement.querySelectorAll(".sim-chip").forEach(b => b.classList.remove("active"));
  btn.classList.add("active");
  simSelectedSide = side;
}

async function runSimulation() {
  const btn = $("simRunBtn");
  btn.disabled = true;
  btn.textContent = "Running...";

  try {
    const params = new URLSearchParams();
    const minConf = Number($("simMinConf").value);
    if (minConf > 0) params.set("minConfidence", minConf);
    const minEdge = Number($("simMinEdge").value);
    if (minEdge > 0) params.set("minEdge", minEdge / 100);
    if (simSelectedCats.length > 0) params.set("categories", simSelectedCats.join(","));
    if (simSelectedStr !== "all") params.set("strengths", simSelectedStr);
    if (simSelectedSide !== "all") params.set("sides", simSelectedSide);

    const [res, wfRes] = await Promise.all([
      fetch("/api/simulate?" + params.toString()),
      fetch("/api/simulate/walk-forward?" + params.toString()).catch(() => null)
    ]);
    const data = await res.json();
    const wfData = wfRes ? await wfRes.json().catch(() => null) : null;
    renderSimResults(data, wfData);
  } catch (err) {
    $("simResults").innerHTML = `<div class="sim-empty" style="color:#f87171">Simulation failed: ${esc(err.message)}</div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = "Run Simulation";
  }
}

function renderSimResults(data, wfData) {
  if (data.total === 0) {
    $("simResults").innerHTML = `<div class="sim-empty">${data.message || "No settled signals match your filters."}</div>`;
    return;
  }

  const winRate = data.winRate != null ? data.winRate + "%" : "-";
  const totalPnl = data.totalPnl != null ? (data.totalPnl >= 0 ? "+" : "") + data.totalPnl.toFixed(1) + "%" : "-";
  const avgPnl = data.avgPnl != null ? (data.avgPnl >= 0 ? "+" : "") + data.avgPnl.toFixed(2) + "%" : "-";
  const sharpe = data.sharpe != null ? data.sharpe.toFixed(2) : "-";
  const maxDD = data.maxDrawdown != null ? data.maxDrawdown.toFixed(1) + "%" : "-";

  const kpiHtml = `
    <div class="sim-kpi-strip">
      <div class="sim-kpi">
        <div class="sim-kpi-label">Signals</div>
        <div class="sim-kpi-val">${data.total}</div>
      </div>
      <div class="sim-kpi">
        <div class="sim-kpi-label">Win Rate</div>
        <div class="sim-kpi-val ${parseFloat(data.winRate) >= 50 ? 'green' : 'red'}">${winRate}</div>
      </div>
      <div class="sim-kpi">
        <div class="sim-kpi-label">Total P&L</div>
        <div class="sim-kpi-val ${data.totalPnl >= 0 ? 'green' : 'red'}">${totalPnl}</div>
      </div>
      <div class="sim-kpi">
        <div class="sim-kpi-label">Avg P&L</div>
        <div class="sim-kpi-val ${data.avgPnl >= 0 ? 'green' : 'red'}">${avgPnl}</div>
      </div>
      <div class="sim-kpi">
        <div class="sim-kpi-label">Sharpe</div>
        <div class="sim-kpi-val">${sharpe}</div>
      </div>
      <div class="sim-kpi">
        <div class="sim-kpi-label">Max DD</div>
        <div class="sim-kpi-val red">${maxDD}</div>
      </div>
      <div class="sim-kpi">
        <div class="sim-kpi-label">W / L</div>
        <div class="sim-kpi-val">${data.wins} / ${data.losses}</div>
      </div>
    </div>`;

  // Walk-forward validation results
  let wfHtml = "";
  if (wfData && !wfData.error && wfData.outOfSample) {
    const oos = wfData.outOfSample;
    const ins = wfData.inSample;
    const of = wfData.overfitting || {};
    const riskColor = of.risk === "HIGH" ? "#f87171" : of.risk === "MEDIUM" ? "#fbbf24" : "#34d399";
    const riskBg = of.risk === "HIGH" ? "#f8717118" : of.risk === "MEDIUM" ? "#fbbf2418" : "#34d39918";
    wfHtml = `
    <div style="background:#12121a;border:1px solid #1e1e2a;border-radius:8px;padding:14px 18px;margin-bottom:16px">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
        <span style="font-size:11px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:0.6px">Walk-Forward Validation</span>
        <span style="font-size:9px;font-weight:700;padding:2px 8px;border-radius:4px;background:${riskBg};color:${riskColor}">${of.risk || "?"} OVERFIT RISK</span>
        <span style="font-size:10px;color:#4b5563;margin-left:auto">${wfData.trainSize || 0} train / ${wfData.testSize || 0} test signals</span>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
        <div style="background:#0e0e16;border:1px solid #1a1a24;border-radius:6px;padding:10px;text-align:center">
          <div style="font-size:9px;color:#4b5563;text-transform:uppercase;margin-bottom:4px">In-Sample Win Rate</div>
          <div style="font-size:16px;font-weight:700;color:${(ins.winRate ?? 0) >= 50 ? '#34d399' : '#f87171'}">${ins.winRate != null ? ins.winRate + "%" : "-"}</div>
        </div>
        <div style="background:#0e0e16;border:1px solid #1a1a24;border-radius:6px;padding:10px;text-align:center">
          <div style="font-size:9px;color:#4b5563;text-transform:uppercase;margin-bottom:4px">Out-of-Sample Win Rate</div>
          <div style="font-size:16px;font-weight:700;color:${(oos.winRate ?? 0) >= 50 ? '#34d399' : '#f87171'}">${oos.winRate != null ? oos.winRate + "%" : "-"}</div>
        </div>
        <div style="background:#0e0e16;border:1px solid #1a1a24;border-radius:6px;padding:10px;text-align:center">
          <div style="font-size:9px;color:#4b5563;text-transform:uppercase;margin-bottom:4px">In-Sample Sharpe</div>
          <div style="font-size:16px;font-weight:700;color:#e5e7eb">${ins.sharpe != null ? ins.sharpe.toFixed(2) : "-"}</div>
        </div>
        <div style="background:#0e0e16;border:1px solid #1a1a24;border-radius:6px;padding:10px;text-align:center">
          <div style="font-size:9px;color:#4b5563;text-transform:uppercase;margin-bottom:4px">Out-of-Sample Sharpe</div>
          <div style="font-size:16px;font-weight:700;color:#e5e7eb">${oos.sharpe != null ? oos.sharpe.toFixed(2) : "-"}</div>
        </div>
      </div>
      ${of.recommendation ? `<div style="font-size:11px;color:#6b7280;margin-top:10px;padding:8px 10px;background:#0e0e16;border-radius:4px">${esc(of.recommendation)}</div>` : ""}
    </div>`;
  }

  // Equity curve
  const curve = data.equityCurve || [];
  const chartHtml = curve.length > 0 ? `
    <div class="analytics-card wide" style="margin-bottom:0">
      <div class="analytics-title">Simulated Equity Curve</div>
      <div class="analytics-chart"><canvas id="simEquityCanvas"></canvas></div>
    </div>` : "";

  $("simResults").innerHTML = kpiHtml + wfHtml + chartHtml;

  if (curve.length > 0) {
    if (simEquityChart) simEquityChart.destroy();
    const labels = curve.map(p => {
      const d = new Date(p.date);
      return (d.getMonth() + 1) + "/" + d.getDate();
    });
    const values = curve.map(p => p.cumPnl);

    simEquityChart = new Chart($("simEquityCanvas"), {
      type: "line",
      data: {
        labels,
        datasets: [{
          label: "Cumulative P&L %",
          data: values,
          borderColor: values[values.length - 1] >= 0 ? CHART_COLORS.green : CHART_COLORS.red,
          backgroundColor: values[values.length - 1] >= 0 ? CHART_COLORS.greenBg : CHART_COLORS.redBg,
          fill: true, tension: 0.3, pointRadius: 0, borderWidth: 2
        }]
      },
      options: CHART_DEFAULTS
    });
  }
}

window.toggleSimCat = toggleSimCat;
window.toggleSimStr = toggleSimStr;
window.toggleSimSide = toggleSimSide;
window.runSimulation = runSimulation;

/* ═══ Strategy Library ═══ */

function getCurrentSimFilters() {
  const filters = {};
  const minConf = Number($("simMinConf")?.value);
  if (minConf > 0) filters.minConfidence = minConf;
  const minEdge = Number($("simMinEdge")?.value);
  if (minEdge > 0) filters.minEdge = minEdge / 100;
  if (simSelectedCats.length > 0) filters.categories = simSelectedCats;
  if (simSelectedStr !== "all") filters.strengths = [simSelectedStr];
  if (simSelectedSide !== "all") filters.sides = [simSelectedSide];
  return filters;
}

async function saveCurrentStrategy() {
  const name = prompt("Strategy name:");
  if (!name) return;
  const filters = getCurrentSimFilters();
  try {
    const res = await fetch("/api/strategies", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, filters })
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    if (typeof showToast === "function") showToast("Strategy saved!", "success");
    loadStrategyList();
  } catch (e) {
    if (typeof showToast === "function") showToast("Save failed: " + e.message, "error");
  }
}

async function loadStrategyList() {
  const el = $("strategyList");
  if (!el) return;
  try {
    const strats = await fetch("/api/strategies").then(r => r.json());
    if (!strats.length) { el.innerHTML = '<div style="color:#4b5563;font-size:11px">No saved strategies</div>'; return; }
    el.innerHTML = strats.map(s => `<div style="display:flex;align-items:center;gap:8px;padding:4px 0;border-bottom:1px solid #141420;font-size:12px">
      <span style="flex:1;color:#e5e7eb;font-weight:500">${esc(s.name)}</span>
      <button class="try-btn" onclick="loadStrategy(${s.id})">Load</button>
      <button class="try-btn" onclick="backtestStrategy(${s.id})">Backtest</button>
      <button class="try-btn" style="color:#f87171" onclick="removeStrategy(${s.id})">Del</button>
    </div>`).join("");
  } catch { el.innerHTML = '<div style="color:#4b5563;font-size:11px">Failed to load</div>'; }
}

async function loadStrategy(id) {
  try {
    const strats = await fetch("/api/strategies").then(r => r.json());
    const s = strats.find(x => x.id === id);
    if (!s) return;
    const f = s.filters;
    if ($("simMinConf") && f.minConfidence != null) $("simMinConf").value = f.minConfidence;
    if ($("simMinEdge") && f.minEdge != null) $("simMinEdge").value = Math.round(f.minEdge * 100);
    if (typeof showToast === "function") showToast(`Loaded "${s.name}"`, "success");
  } catch {}
}

async function backtestSavedStrategy(id) {
  try {
    const res = await fetch(`/api/strategies/${id}/backtest`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    renderSimResults(data.results);
    if (typeof showToast === "function") showToast(`Backtested "${data.strategy.name}"`, "success");
  } catch (e) {
    if (typeof showToast === "function") showToast("Backtest failed: " + e.message, "error");
  }
}

async function removeStrategy(id) {
  try {
    await fetch(`/api/strategies/${id}`, { method: "DELETE" });
    loadStrategyList();
  } catch {}
}

window.saveCurrentStrategy = saveCurrentStrategy;
window.loadStrategy = loadStrategy;
window.backtestStrategy = backtestSavedStrategy;
window.removeStrategy = removeStrategy;

/* ═══ Signal Feed ═══ */

let feedSignals = [];
let feedFilter = "all";
let feedOffset = 0;
const FEED_PAGE = 50;

async function loadFeed(append = false) {
  try {
    const limit = FEED_PAGE;
    const offset = append ? feedOffset : 0;
    const res = await fetch(`/api/signals/recent?limit=${limit + offset}`);
    const all = await res.json();

    if (!append) {
      feedSignals = all;
      feedOffset = all.length;
    } else {
      feedSignals = all;
      feedOffset = all.length;
    }

    renderFeed();
  } catch (err) {
    $("feedList").innerHTML = `<div class="sim-empty" style="color:#f87171">Failed to load feed</div>`;
  }
}

function setFeedFilter(filter, btn) {
  feedFilter = filter;
  document.querySelectorAll("[data-feed-filter]").forEach(b => b.classList.remove("active"));
  btn.classList.add("active");
  renderFeed();
}

function renderFeed() {
  let items = feedSignals;

  // Apply filter
  if (feedFilter === "pending") {
    items = items.filter(s => !s.outcome);
  } else if (feedFilter === "WIN" || feedFilter === "LOSS") {
    items = items.filter(s => s.outcome === feedFilter);
  }

  if (items.length === 0) {
    $("feedList").innerHTML = '<div class="sim-empty">No signals match this filter.</div>';
    return;
  }

  const html = items.map(s => {
    const isYes = s.side === "UP";
    const side = isYes ? "YES" : "NO";
    const edge = s.edge != null ? "+" + (s.edge * 100).toFixed(1) + "%" : "-";
    const conf = s.confidence != null ? s.confidence : "-";
    const cat = s.category || "other";
    const str = s.strength || "GOOD";
    const time = s.created_at ? new Date(s.created_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "-";

    let outcomeHtml = "";
    if (s.outcome === "WIN") {
      outcomeHtml = '<span class="feed-outcome win">WIN</span>';
    } else if (s.outcome === "LOSS") {
      outcomeHtml = '<span class="feed-outcome loss">LOSS</span>';
    } else if (s.outcome === "VOID") {
      outcomeHtml = '<span class="feed-outcome void">VOID</span>';
    } else {
      outcomeHtml = '<span class="feed-outcome pending">OPEN</span>';
    }

    const pnl = s.pnl_pct != null ? `P&L: <em style="color:${s.pnl_pct >= 0 ? "#34d399" : "#f87171"}">${s.pnl_pct >= 0 ? "+" : ""}${(s.pnl_pct * 100).toFixed(1)}%</em>` : "";

    return `<div class="feed-item">
      <span class="feed-time">${time}</span>
      <span class="feed-side ${isYes ? 'yes' : 'no'}">${side}</span>
      <div class="feed-body">
        <div class="feed-question" title="${esc(s.question)}">${esc(s.question || "Unknown")}</div>
        <div class="feed-meta">
          <span>Edge: <em>${edge}</em></span>
          <span>Conf: <em>${conf}</em></span>
          <span><em>${str}</em></span>
          <span>${esc(cat)}</span>
          ${pnl ? `<span>${pnl}</span>` : ""}
        </div>
      </div>
      ${outcomeHtml}
      ${s.id ? `<button class="share-btn" onclick="shareSignal(${s.id})" title="Copy link">&#x1f517;</button>` : ""}
    </div>`;
  }).join("");

  const moreBtn = feedSignals.length >= feedOffset
    ? `<div class="feed-more"><button class="feed-more-btn" onclick="loadFeed(true)">Load More</button></div>`
    : "";

  $("feedList").innerHTML = html + moreBtn;
}

function shareSignal(id) {
  const url = `${location.origin}/s/${id}`;
  navigator.clipboard.writeText(url).then(() => {
    if (typeof showToast === "function") showToast("Link copied to clipboard!", "success");
  }).catch(() => {
    prompt("Copy this link:", url);
  });
}

window.setFeedFilter = setFeedFilter;
window.loadFeed = loadFeed;
window.shareSignal = shareSignal;

/* ═══ Market Detail Modal ═══ */

async function openMarketDetail(marketId) {
  if (!marketId) return;

  $("marketModalContent").innerHTML = '<div style="text-align:center;padding:40px;color:#4b5563">Loading market data...</div>';
  $("marketModal").classList.add("open");

  try {
    const data = await fetch(`/api/analytics/market/${encodeURIComponent(marketId)}`).then(r => r.json());

    if (data.error) {
      $("marketModalContent").innerHTML = `<button class="modal-close" onclick="closeMarketModal()">&times;</button>
        <div style="text-align:center;padding:40px;color:#4b5563">No signal data for this market yet.</div>`;
      return;
    }

    const winRate = data.win_rate != null ? data.win_rate + "%" : "-";
    const wrColor = parseFloat(data.win_rate) >= 50 ? "green" : "red";
    const totalPnl = data.total_pnl != null ? (data.total_pnl >= 0 ? "+" : "") + (data.total_pnl * 100).toFixed(1) + "%" : "-";
    const pnlColor = (data.total_pnl ?? 0) >= 0 ? "green" : "red";
    const avgEdge = data.avg_edge != null ? "+" + (data.avg_edge * 100).toFixed(1) + "%" : "-";
    const avgConf = data.avg_confidence != null ? Math.round(data.avg_confidence) : "-";
    const settled = (data.wins || 0) + (data.losses || 0);
    const firstSig = data.first_signal ? new Date(data.first_signal).toLocaleDateString() : "-";
    const lastSig = data.last_signal ? new Date(data.last_signal).toLocaleDateString() : "-";

    $("marketModalContent").innerHTML = `
      <button class="modal-close" onclick="closeMarketModal()">&times;</button>
      <h3>${esc((data.question || "").slice(0, 80))}</h3>
      <div class="modal-sub">${data.category || "other"} | ${data.total_signals} signals | ${firstSig} — ${lastSig}</div>

      <div class="mkt-detail-grid">
        <div class="mkt-detail-card">
          <div class="mkt-detail-label">Win Rate</div>
          <div class="mkt-detail-val ${wrColor}">${winRate}</div>
        </div>
        <div class="mkt-detail-card">
          <div class="mkt-detail-label">Total P&L</div>
          <div class="mkt-detail-val ${pnlColor}">${totalPnl}</div>
        </div>
        <div class="mkt-detail-card">
          <div class="mkt-detail-label">Avg Edge</div>
          <div class="mkt-detail-val green">${avgEdge}</div>
        </div>
        <div class="mkt-detail-card">
          <div class="mkt-detail-label">Avg Confidence</div>
          <div class="mkt-detail-val">${avgConf}</div>
        </div>
        <div class="mkt-detail-card">
          <div class="mkt-detail-label">Settled</div>
          <div class="mkt-detail-val">${settled}</div>
        </div>
        <div class="mkt-detail-card">
          <div class="mkt-detail-label">Pending</div>
          <div class="mkt-detail-val amber">${data.pending || 0}</div>
        </div>
      </div>

      <div class="modal-section" style="margin-top:16px">
        <div class="modal-section-title">Breakdown</div>
        <div class="modal-kv"><span class="k">Wins</span><span class="v" style="color:#34d399">${data.wins || 0}</span></div>
        <div class="modal-kv"><span class="k">Losses</span><span class="v" style="color:#f87171">${data.losses || 0}</span></div>
        <div class="modal-kv"><span class="k">Avg P&L per Signal</span><span class="v">${data.avg_pnl != null ? (data.avg_pnl >= 0 ? "+" : "") + (data.avg_pnl * 100).toFixed(2) + "%" : "-"}</span></div>
        <div class="modal-kv"><span class="k">Market ID</span><span class="v" style="font-size:10px;color:#4b5563">${data.market_id || marketId}</span></div>
      </div>
    `;
  } catch (err) {
    $("marketModalContent").innerHTML = `<button class="modal-close" onclick="closeMarketModal()">&times;</button>
      <div style="text-align:center;padding:40px;color:#f87171">Failed to load market data</div>`;
  }
}

function closeMarketModal() {
  $("marketModal").classList.remove("open");
}

window.openMarketDetail = openMarketDetail;
window.closeMarketModal = closeMarketModal;

/* ═══ Toast Notification System ═══ */

function showToast(message, type = "info", durationMs = 4000) {
  const container = $("toastContainer");
  if (!container) return;
  const toast = document.createElement("div");
  toast.className = "toast " + type;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translateY(12px)";
    toast.style.transition = "all 0.3s";
    setTimeout(() => toast.remove(), 300);
  }, durationMs);
}

window.showToast = showToast;

/* ═══ Global Error Handling ═══ */

window.onerror = function(msg, src, line) {
  console.error("[global]", msg, src, line);
  showToast("Something went wrong", "error");
  return false;
};

window.addEventListener("unhandledrejection", function(event) {
  console.error("[promise]", event.reason);
  showToast("Request failed", "error");
});

async function safeFetch(url, opts) {
  try {
    const res = await fetch(url, opts);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${res.status}`);
    }
    return res.json();
  } catch (err) {
    showToast(err.message || "Network error", "error");
    throw err;
  }
}

/* ═══ Settings Tab ═══ */

let settingsUser = null;

async function loadSettings() {
  // Load account info
  try {
    const me = await fetch("/api/auth/me").then(r => r.json());
    if (me.email) {
      settingsUser = me;
      $("setEmail").textContent = me.email;
      $("setPlan").textContent = (me.plan || "free").toUpperCase();
      $("setLoginBtn").textContent = "Logged in";
      $("setLoginBtn").disabled = true;
      loadApiKeys();
      loadWebhooks();
      loadEmailPrefs();
      loadDeliveryAudit();
      loadReferralSection();
    }
  } catch { /* not logged in */ }

  // Init notification prefs from localStorage
  initNotifPrefs();

  // Init email category checkboxes
  initEmailCategories();
}

async function loadDeliveryAudit() {
  const el = $("deliveryAuditBlock");
  if (!el) return;
  try {
    const data = await fetch("/api/notifications/delivery-audit").then(r => r.json());
    if (data.error || !data.recent) { el.innerHTML = '<div style="color:#4b5563;font-size:12px">No delivery data yet</div>'; return; }

    const stats = data.stats || {};
    const recent = (data.recent || []).slice(0, 10);
    const successRate = stats.total > 0 ? Math.round((stats.delivered / stats.total) * 100) : 0;
    const srColor = successRate >= 90 ? "#34d399" : successRate >= 70 ? "#fbbf24" : "#f87171";

    el.innerHTML = `
      <div style="display:flex;gap:12px;margin-bottom:10px">
        <div style="background:#0e0e16;border:1px solid #1a1a24;border-radius:6px;padding:8px 12px;text-align:center;flex:1">
          <div style="font-size:9px;color:#4b5563;text-transform:uppercase">Success Rate</div>
          <div style="font-size:16px;font-weight:700;color:${srColor}">${successRate}%</div>
        </div>
        <div style="background:#0e0e16;border:1px solid #1a1a24;border-radius:6px;padding:8px 12px;text-align:center;flex:1">
          <div style="font-size:9px;color:#4b5563;text-transform:uppercase">Total</div>
          <div style="font-size:16px;font-weight:700;color:#e5e7eb">${stats.total || 0}</div>
        </div>
        <div style="background:#0e0e16;border:1px solid #1a1a24;border-radius:6px;padding:8px 12px;text-align:center;flex:1">
          <div style="font-size:9px;color:#4b5563;text-transform:uppercase">Failed</div>
          <div style="font-size:16px;font-weight:700;color:#f87171">${stats.failed || 0}</div>
        </div>
      </div>
      ${recent.length > 0 ? recent.map(r => {
        const statusColor = r.status === "delivered" ? "#34d399" : r.status === "failed" ? "#f87171" : r.status === "throttled" ? "#fbbf24" : "#6b7280";
        const time = r.created_at ? new Date(r.created_at).toLocaleTimeString() : "-";
        return `<div style="display:flex;align-items:center;gap:8px;padding:4px 0;border-bottom:1px solid #141420;font-size:11px">
          <span style="color:#4b5563;width:60px">${time}</span>
          <span style="color:#9ca3af;flex:1">${esc(r.channel || "-")}</span>
          <span style="color:${statusColor};font-weight:600">${r.status}</span>
          ${r.latency_ms ? `<span style="color:#4b5563">${r.latency_ms}ms</span>` : ""}
        </div>`;
      }).join("") : '<div style="color:#4b5563;font-size:11px">No recent deliveries</div>'}
    `;
  } catch {
    el.innerHTML = '<div style="color:#4b5563;font-size:12px">Login to view delivery audit</div>';
  }
}

async function loadReferralSection() {
  const el = $("referralBlock");
  if (!el) return;
  try {
    const data = await fetch("/api/referral/code").then(r => r.json());
    if (data.error) { el.innerHTML = '<div style="color:#4b5563;font-size:12px">Login to view referral code</div>'; return; }

    const appUrl = window.location.origin;
    const link = `${appUrl}/?ref=${data.code}`;
    el.innerHTML = `
      <div class="settings-row">
        <span class="settings-label">Your code</span>
        <span class="settings-val" style="font-family:monospace;color:#a5b4fc">${esc(data.code)}</span>
      </div>
      <div class="settings-row">
        <span class="settings-label">Referral link</span>
        <span style="font-size:10px;font-family:monospace;color:#6b7280;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(link)}</span>
        <button class="settings-btn" onclick="navigator.clipboard.writeText('${link}');showToast('Copied!','success')">Copy</button>
      </div>
      <div class="settings-row">
        <span class="settings-label">Referrals completed</span>
        <span class="settings-val" style="color:#34d399">${data.completed || 0}</span>
      </div>
      <div class="settings-row">
        <span class="settings-label">Rewards earned</span>
        <span class="settings-val">${data.rewards || 0} free months</span>
      </div>
      ${data.untilNextReward > 0 ? `<div style="font-size:11px;color:#6b7280;margin-top:6px">${data.untilNextReward} more referrals until your next free month!</div>` : ""}
    `;
  } catch {
    el.innerHTML = '<div style="color:#4b5563;font-size:12px">Login to view referral code</div>';
  }
}

async function startTrialFromSettings() {
  try {
    const res = await fetch("/api/trial/start", { method: "POST" });
    const data = await res.json();
    if (data.ok) {
      showToast(data.message || "Trial started!", "success");
      loadUserPlan();
      loadTrialStatus();
      const btn = $("startTrialBtn");
      if (btn) { btn.textContent = "Trial Active"; btn.disabled = true; }
    } else {
      showToast(data.message || data.error || "Could not start trial", "error");
    }
  } catch (err) {
    showToast("Error: " + err.message, "error");
  }
}
window.startTrialFromSettings = startTrialFromSettings;

async function settingsLogin() {
  const email = prompt("Enter your email for a magic link:");
  if (!email || !email.includes("@")) return;
  try {
    await safeFetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email })
    });
    showToast("Magic link sent! Check your email.", "success");
  } catch { /* handled by safeFetch */ }
}

// API Keys
async function loadApiKeys() {
  try {
    const keys = await fetch("/api/keys").then(r => r.json());
    const el = $("apiKeysList");
    if (!Array.isArray(keys) || keys.length === 0) {
      el.innerHTML = '<div style="color:#4b5563;font-size:12px">No API keys yet</div>';
      return;
    }
    el.innerHTML = keys.map(k => `
      <div class="key-item">
        <div>
          <span class="key-prefix">${esc(k.key_prefix)}...</span>
          <div class="key-meta">${esc(k.name || "default")} | ${k.call_count || 0} calls</div>
        </div>
        <button class="settings-btn danger" onclick="revokeApiKey(${k.id})">Revoke</button>
      </div>
    `).join("");
  } catch { /* not logged in */ }
}

async function createApiKey() {
  if (!settingsUser) { showToast("Login required", "error"); return; }
  const name = prompt("Key name (optional):", "default") || "default";
  try {
    const result = await safeFetch("/api/keys/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name })
    });
    if (result.rawKey) {
      $("apiKeyReveal").style.display = "block";
      $("apiKeyReveal").innerHTML = `<div class="key-reveal">
        <strong>Save this key — it won't be shown again:</strong><br>${esc(result.rawKey)}
      </div>`;
      showToast("API key created", "success");
      loadApiKeys();
    }
  } catch { /* handled */ }
}

async function revokeApiKey(id) {
  if (!confirm("Revoke this API key?")) return;
  try {
    await safeFetch(`/api/keys/${id}`, { method: "DELETE" });
    showToast("Key revoked", "success");
    loadApiKeys();
  } catch { /* handled */ }
}

// Webhooks
async function loadWebhooks() {
  try {
    const hooks = await fetch("/api/webhooks").then(r => r.json());
    const el = $("webhooksList");
    if (!Array.isArray(hooks) || hooks.length === 0) {
      el.innerHTML = '<div style="color:#4b5563;font-size:12px">No webhooks configured</div>';
      return;
    }
    el.innerHTML = hooks.map(h => `
      <div class="webhook-item">
        <div>
          <div class="webhook-url">${esc(h.url)}</div>
          <div class="webhook-stats">${h.success_count || 0} ok / ${h.fail_count || 0} fail${h.active ? "" : " (disabled)"}</div>
        </div>
        <button class="settings-btn danger" onclick="deleteWebhook(${h.id})">Delete</button>
      </div>
    `).join("");
  } catch { /* not logged in */ }
}

async function addWebhook() {
  if (!settingsUser) { showToast("Login required", "error"); return; }
  const url = $("webhookUrlInput").value.trim();
  if (!url || !url.startsWith("https://")) { showToast("URL must start with https://", "error"); return; }
  try {
    await safeFetch("/api/webhooks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url })
    });
    $("webhookUrlInput").value = "";
    showToast("Webhook added", "success");
    loadWebhooks();
  } catch { /* handled */ }
}

async function deleteWebhook(id) {
  if (!confirm("Delete this webhook?")) return;
  try {
    await safeFetch(`/api/webhooks/${id}`, { method: "DELETE" });
    showToast("Webhook deleted", "success");
    loadWebhooks();
  } catch { /* handled */ }
}

// Email Alert Preferences
let emailAlertsEnabled = false;

function initEmailCategories() {
  const cats = ["Bitcoin", "Ethereum", "Crypto", "Sports", "Politics", "Science", "Culture", "Other"];
  const el = $("emailCatChecks");
  if (!el) return;
  el.innerHTML = cats.map(c =>
    `<label class="cat-check"><input type="checkbox" value="${c}" checked> ${c}</label>`
  ).join("");
}

async function loadEmailPrefs() {
  try {
    const prefs = await fetch("/api/email-prefs").then(r => r.json());
    emailAlertsEnabled = !!prefs.alerts_enabled;
    const toggle = $("emailAlertToggle");
    if (toggle) toggle.classList.toggle("on", emailAlertsEnabled);
    if (prefs.min_confidence != null) {
      $("emailMinConf").value = prefs.min_confidence;
      $("emailMinConfVal").textContent = prefs.min_confidence;
    }
    if (prefs.categories) {
      const selectedCats = prefs.categories.split(",").map(c => c.trim().toLowerCase());
      document.querySelectorAll("#emailCatChecks input").forEach(cb => {
        cb.checked = selectedCats.includes(cb.value.toLowerCase());
      });
    }
    if (prefs.maxAlertsPerHour != null && $("emailMaxPerHour")) {
      $("emailMaxPerHour").value = prefs.maxAlertsPerHour;
      $("emailMaxPerHourVal").textContent = prefs.maxAlertsPerHour;
    }
    // Load throttle status
    try {
      const ts = await fetch("/api/throttle-status").then(r => r.json());
      if ($("throttleStatus")) {
        $("throttleStatus").textContent = `${ts.count}/${ts.maxPerHour} this hour` + (ts.queuedCount > 0 ? ` (${ts.queuedCount} queued)` : "");
        $("throttleStatus").style.color = ts.count >= ts.maxPerHour ? "#f87171" : "#34d399";
      }
    } catch {}
  } catch { /* not logged in */ }
}

function toggleEmailAlerts() {
  emailAlertsEnabled = !emailAlertsEnabled;
  $("emailAlertToggle").classList.toggle("on", emailAlertsEnabled);
}

async function saveEmailPrefs() {
  if (!settingsUser) { showToast("Login required", "error"); return; }
  const cats = Array.from(document.querySelectorAll("#emailCatChecks input:checked")).map(cb => cb.value);
  try {
    await safeFetch("/api/email-prefs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        alertsEnabled: emailAlertsEnabled,
        minConfidence: Number($("emailMinConf").value),
        categories: cats.join(","),
        maxAlertsPerHour: Number($("emailMaxPerHour")?.value || 20)
      })
    });
    showToast("Email preferences saved", "success");
  } catch { /* handled */ }
}

// Browser Notification Preferences
function initNotifPrefs() {
  const soundOn = localStorage.getItem("ps_sound") !== "off";
  const vol = localStorage.getItem("ps_volume") || "50";
  $("soundToggle").classList.toggle("on", soundOn);
  $("soundVolume").value = vol;
}

function toggleSound() {
  const isOn = $("soundToggle").classList.toggle("on");
  localStorage.setItem("ps_sound", isOn ? "on" : "off");
}

function saveSoundPrefs() {
  localStorage.setItem("ps_volume", $("soundVolume").value);
}

function testNotification() {
  if ("Notification" in window && Notification.permission === "granted") {
    new Notification("PolySignal Test", { body: "This is a test notification", icon: "/icon-192.png" });
    showToast("Test notification sent", "info");
  } else if ("Notification" in window && Notification.permission === "default") {
    Notification.requestPermission().then(perm => {
      if (perm === "granted") testNotification();
    });
  } else {
    showToast("Notifications blocked by browser", "error");
  }
}

window.settingsLogin = settingsLogin;
window.createApiKey = createApiKey;
window.revokeApiKey = revokeApiKey;
window.addWebhook = addWebhook;
window.deleteWebhook = deleteWebhook;
window.toggleEmailAlerts = toggleEmailAlerts;
window.saveEmailPrefs = saveEmailPrefs;
window.toggleSound = toggleSound;
window.saveSoundPrefs = saveSoundPrefs;
window.testNotification = testNotification;

/* ═══ Data Freshness Poller ═══ */

async function pollFreshness() {
  try {
    const r = await fetch("/health/detailed");
    const data = await r.json();
    const badge = $("freshnessBadge");
    if (!badge || !data.staleness) return;

    if (data.staleness.anyStale) {
      const names = data.staleness.staleSources.join(", ");
      badge.textContent = `${data.staleness.staleCount} stale`;
      badge.className = data.staleness.staleCount > 2 ? "freshness-badge critical" : "freshness-badge stale";
      badge.title = `Stale sources: ${names}`;
    } else if (data.staleness.totalSources > 0) {
      badge.textContent = "Fresh";
      badge.className = "freshness-badge";
      badge.title = "All data sources are fresh";
    } else {
      badge.textContent = "";
    }
  } catch { /* ignore */ }
}

pollFreshness();
setInterval(pollFreshness, 30_000);
