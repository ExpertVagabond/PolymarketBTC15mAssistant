import { clamp } from "../utils.js";

export function computeEdge({ modelUp, modelDown, marketYes, marketNo }) {
  if (marketYes === null || marketNo === null) {
    return { marketUp: null, marketDown: null, edgeUp: null, edgeDown: null };
  }

  const sum = marketYes + marketNo;
  const marketUp = sum > 0 ? marketYes / sum : null;
  const marketDown = sum > 0 ? marketNo / sum : null;

  const edgeUp = marketUp === null ? null : modelUp - marketUp;
  const edgeDown = marketDown === null ? null : modelDown - marketDown;

  return {
    marketUp: marketUp === null ? null : clamp(marketUp, 0, 1),
    marketDown: marketDown === null ? null : clamp(marketDown, 0, 1),
    edgeUp,
    edgeDown
  };
}

/**
 * Category-specific threshold profiles.
 * Crypto markets are fast-moving with deep liquidity — lower thresholds OK.
 * Sports/esports are event-driven with less history — need stronger signals.
 * Politics/other are slow-moving — require highest conviction.
 */
const CATEGORY_PROFILES = {
  crypto:    { edgeMult: 0.8,  probMult: 0.95 },
  Bitcoin:   { edgeMult: 0.8,  probMult: 0.95 },
  Ethereum:  { edgeMult: 0.8,  probMult: 0.95 },
  "Up or Down": { edgeMult: 1.8, probMult: 1.15 },  // 50/50 coin-flip markets — require strong conviction
  "15M":        { edgeMult: 1.8, probMult: 1.15 },
  "Hide From New": { edgeMult: 1.8, probMult: 1.15 },
  Sports:    { edgeMult: 1.2,  probMult: 1.1  },
  Esports:   { edgeMult: 1.1,  probMult: 1.05 },
  Tennis:    { edgeMult: 1.2,  probMult: 1.1  },
  Politics:  { edgeMult: 1.4,  probMult: 1.15 },
};

function getCategoryProfile(category) {
  if (!category) return { edgeMult: 1.0, probMult: 1.0 };
  return CATEGORY_PROFILES[category] || { edgeMult: 1.0, probMult: 1.0 };
}

/**
 * Regime adjustments:
 * - CHOP: Suppress signals (high noise, low volume)
 * - TREND_UP/TREND_DOWN: Lower thresholds (indicators are aligned, higher confidence)
 * - RANGE: Normal thresholds
 */
function getRegimeAdjustment(regime) {
  switch (regime) {
    case "CHOP":       return { edgeMult: 2.0, probMult: 1.2, suppress: false };
    case "TREND_UP":   return { edgeMult: 0.75, probMult: 0.9, suppress: false };
    case "TREND_DOWN": return { edgeMult: 0.75, probMult: 0.9, suppress: false };
    case "RANGE":      return { edgeMult: 1.0, probMult: 1.0, suppress: false };
    default:           return { edgeMult: 1.0, probMult: 1.0, suppress: false };
  }
}

export function decide({
  remainingMinutes,
  edgeUp,
  edgeDown,
  modelUp = null,
  modelDown = null,
  regime = null,
  category = null
}) {
  const phase = remainingMinutes > 10 ? "EARLY" : remainingMinutes > 5 ? "MID" : "LATE";

  // Base thresholds (phase-dependent)
  let baseEdge = phase === "EARLY" ? 0.05 : phase === "MID" ? 0.1 : 0.2;
  let baseProb = phase === "EARLY" ? 0.55 : phase === "MID" ? 0.6 : 0.65;

  // Apply category adjustments
  const catProfile = getCategoryProfile(category);
  baseEdge *= catProfile.edgeMult;
  baseProb *= catProfile.probMult;

  // Apply regime adjustments
  const regimeAdj = getRegimeAdjustment(regime);
  const threshold = baseEdge * regimeAdj.edgeMult;
  const minProb = Math.min(baseProb * regimeAdj.probMult, 0.85); // Cap at 85%

  if (edgeUp === null || edgeDown === null) {
    return { action: "NO_TRADE", side: null, phase, reason: "missing_market_data", regime, category };
  }

  // CHOP regime with very high threshold makes it nearly impossible to signal
  // but we still allow truly extreme edges through
  const bestSide = edgeUp > edgeDown ? "UP" : "DOWN";
  const bestEdge = bestSide === "UP" ? edgeUp : edgeDown;
  const bestModel = bestSide === "UP" ? modelUp : modelDown;

  if (bestEdge < threshold) {
    return { action: "NO_TRADE", side: null, phase, reason: `edge_${(bestEdge * 100).toFixed(1)}%_below_${(threshold * 100).toFixed(1)}%`, regime, category };
  }

  if (bestModel !== null && bestModel < minProb) {
    return { action: "NO_TRADE", side: null, phase, reason: `prob_${(bestModel * 100).toFixed(1)}%_below_${(minProb * 100).toFixed(1)}%`, regime, category };
  }

  const strength = bestEdge >= 0.2 ? "STRONG" : bestEdge >= 0.1 ? "GOOD" : "OPTIONAL";
  return { action: "ENTER", side: bestSide, phase, strength, edge: bestEdge, regime, category };
}
