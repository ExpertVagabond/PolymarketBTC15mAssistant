/**
 * Backend plan enforcement middleware.
 * Applies per-plan limits on API responses server-side.
 *
 * Usage: Apply as response transform, not route guard.
 * Free users still get data, but limited/truncated.
 */

import { verifySession } from "./auth.js";
import { verifyKey } from "../subscribers/api-keys.js";
import { checkTrialActive } from "../subscribers/trial.js";

const PLAN_LIMITS = {
  free: {
    recentSignalsLimit: 10,
    portfolioPositionsLimit: 5,
    analyticsExport: false,
    simulatorAccess: false,
    fullAnalytics: false
  },
  basic: {
    recentSignalsLimit: 100,
    portfolioPositionsLimit: Infinity,
    analyticsExport: false,
    simulatorAccess: false,
    fullAnalytics: false
  },
  pro: {
    recentSignalsLimit: 200,
    portfolioPositionsLimit: Infinity,
    analyticsExport: true,
    simulatorAccess: true,
    fullAnalytics: true
  }
};

/**
 * Extract user plan from request (session cookie or API key).
 * Returns "free" if not authenticated.
 */
export function extractPlan(req) {
  // Try API key first
  const apiKey = req.headers?.["x-api-key"];
  if (apiKey) {
    const result = verifyKey(apiKey);
    if (result) return result.plan || "pro"; // API key users get their plan
  }

  // Try session cookie
  const cookieHeader = req.headers?.cookie;
  if (cookieHeader) {
    const match = cookieHeader.match(/(?:^|;)\s*session=([^;]*)/);
    if (match) {
      const session = verifySession(decodeURIComponent(match[1]));
      if (session) {
        const plan = session.plan || "free";
        // Check if user has an active trial that overrides their plan
        if (plan === "free" && session.email) {
          const trialPlan = checkTrialActive(session.email);
          if (trialPlan) return trialPlan;
        }
        return plan;
      }
    }
  }

  return "free";
}

/**
 * Get plan limits for a plan tier.
 */
export function getPlanLimits(plan) {
  return PLAN_LIMITS[plan] || PLAN_LIMITS.free;
}

/**
 * Create a "plan required" error response.
 */
export function planRequired(requiredPlan) {
  return { error: "plan_required", required: requiredPlan, message: `This feature requires a ${requiredPlan} plan or higher.` };
}
