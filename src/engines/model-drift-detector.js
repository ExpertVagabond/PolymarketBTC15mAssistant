/**
 * Model drift detector — tracks weight changes over time and alerts on significant divergence.
 * Compares current learned weights against a stored baseline snapshot.
 */

import { getAllWeights } from "./weights.js";

const DRIFT_THRESHOLD = 0.20; // 20% divergence triggers alert
let baselineWeights = null;
let baselineSetAt = null;

/**
 * Capture the current weights as the baseline for drift detection.
 */
export function setBaseline() {
  const current = getAllWeights();
  baselineWeights = structuredClone(current.weights);
  baselineSetAt = Date.now();
  return { set: true, modelVersion: current.modelVersion, timestamp: new Date(baselineSetAt).toISOString() };
}

/**
 * Get drift status: compare current weights against baseline.
 * @returns {object} Drift report with divergence metrics
 */
export function getDriftStatus() {
  const current = getAllWeights();

  if (!baselineWeights) {
    // Auto-set baseline on first call
    setBaseline();
    return {
      baselineSet: true,
      driftDetected: false,
      message: "Baseline auto-captured. Check again after weight updates.",
      modelVersion: current.modelVersion,
      source: current.source
    };
  }

  const drifts = [];
  let totalChecked = 0;
  let totalDrifted = 0;

  for (const [feat, values] of Object.entries(current.weights)) {
    if (!baselineWeights[feat]) continue;
    for (const [val, weight] of Object.entries(values)) {
      const baseWeight = baselineWeights[feat]?.[val];
      if (baseWeight == null) continue;
      totalChecked++;

      const divergence = Math.abs(weight - baseWeight);
      if (divergence > DRIFT_THRESHOLD) {
        totalDrifted++;
        drifts.push({
          feature: feat,
          value: val,
          baseline: +baseWeight.toFixed(3),
          current: +weight.toFixed(3),
          divergence: +divergence.toFixed(3),
          divergencePct: +(divergence * 100).toFixed(1),
          direction: weight > baseWeight ? "increased" : "decreased"
        });
      }
    }
  }

  // Sort by divergence descending
  drifts.sort((a, b) => b.divergence - a.divergence);

  const driftDetected = drifts.length > 0;
  const severity = drifts.length === 0 ? "none" :
    drifts.length <= 2 ? "low" :
    drifts.length <= 5 ? "medium" : "high";

  return {
    baselineSet: true,
    baselineSetAt: new Date(baselineSetAt).toISOString(),
    modelVersion: current.modelVersion,
    source: current.source,
    totalChecked,
    totalDrifted,
    driftDetected,
    severity,
    driftThreshold: DRIFT_THRESHOLD,
    topDrifts: drifts.slice(0, 10),
    recommendation: severity === "high" ? "Review model weights — significant drift detected. Consider reverting to baseline." :
      severity === "medium" ? "Monitor closely — some weights have shifted notably." :
      "Weights are within normal range."
  };
}

/**
 * Revert weights to baseline by re-setting the baseline (clears drift tracking).
 * Note: actual weight revert requires restarting the weight engine with defaults.
 */
export function acknowledgeBaseline() {
  setBaseline();
  return { acknowledged: true, message: "Baseline reset to current weights. Drift tracking restarted." };
}
