/**
 * Risk management: max bet, daily loss limit, position tracking, circuit breaker.
 * Env: MAX_BET_USD=1, DAILY_LOSS_LIMIT_USD=10, MAX_OPEN_POSITIONS=3
 */

const MAX_BET = Number(process.env.MAX_BET_USD) || 1;
const DAILY_LOSS_LIMIT = Number(process.env.DAILY_LOSS_LIMIT_USD) || 10;
const MAX_POSITIONS = Number(process.env.MAX_OPEN_POSITIONS) || 3;

let dailyPnl = 0;
let dailyResetDate = new Date().toDateString();
let openPositions = 0;
let circuitBroken = false;

function checkDayReset() {
  const today = new Date().toDateString();
  if (today !== dailyResetDate) {
    dailyPnl = 0;
    dailyResetDate = today;
    circuitBroken = false;
  }
}

export function canTrade() {
  checkDayReset();
  if (circuitBroken) return { allowed: false, reason: "circuit_breaker" };
  if (dailyPnl <= -DAILY_LOSS_LIMIT) return { allowed: false, reason: "daily_loss_limit" };
  if (openPositions >= MAX_POSITIONS) return { allowed: false, reason: "max_positions" };
  return { allowed: true };
}

export function getBetSize(edge) {
  // simple fixed bet for now, capped at MAX_BET
  return Math.min(MAX_BET, Math.max(0.1, Math.abs(edge) * 10));
}

export function recordTradeOpen() {
  openPositions++;
}

export function recordTradeClose(pnl) {
  openPositions = Math.max(0, openPositions - 1);
  dailyPnl += pnl;
  if (dailyPnl <= -DAILY_LOSS_LIMIT) {
    circuitBroken = true;
  }
}

export function tripCircuitBreaker(reason) {
  circuitBroken = true;
}

export function getRiskStatus() {
  checkDayReset();
  return {
    dailyPnl,
    dailyLossLimit: DAILY_LOSS_LIMIT,
    openPositions,
    maxPositions: MAX_POSITIONS,
    maxBet: MAX_BET,
    circuitBroken
  };
}
