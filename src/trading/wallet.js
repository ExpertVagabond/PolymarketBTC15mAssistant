/**
 * Wallet balance tracking for the Polymarket CLOB account.
 * Fetches available USDC balance and checks sufficiency before trades.
 * Caches balance for 30s to avoid rate limits.
 */

import { CONFIG } from "../config.js";
import { buildClobHeaders, isTradingConfigured, getWallet } from "./clob-auth.js";
import { logAuditEvent } from "./audit-log.js";

const CLOB_BASE = CONFIG.clobBaseUrl;
const MIN_BALANCE = Number(process.env.MIN_BALANCE_USD) || 1;

let cachedBalance = null;
let cachedAt = 0;
const CACHE_TTL = 30_000; // 30 seconds

/**
 * Fetch wallet balance from CLOB API.
 * Returns available USDC balance for trading.
 */
export async function getWalletBalance() {
  // Return cached if fresh
  if (cachedBalance != null && Date.now() - cachedAt < CACHE_TTL) {
    return cachedBalance;
  }

  if (!isTradingConfigured()) {
    return { ok: false, error: "not_configured", balance: 0, allowance: 0 };
  }

  try {
    // Polymarket CLOB balance endpoint
    const path = "/balance";
    const headers = buildClobHeaders("GET", path);
    const res = await fetch(`${CLOB_BASE}${path}`, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(5000)
    });

    if (!res.ok) {
      // Try alternate approach: get wallet address balance
      return await getBalanceFromAddress();
    }

    const data = await res.json();
    const result = {
      ok: true,
      balance: Number(data.balance || data.available || 0),
      allowance: Number(data.allowance || data.available || 0),
      locked: Number(data.locked || data.in_orders || 0),
      raw: data
    };

    cachedBalance = result;
    cachedAt = Date.now();
    return result;
  } catch (err) {
    // Fallback: try to get balance from address
    return await getBalanceFromAddress();
  }
}

/**
 * Fallback: fetch balance using the wallet address.
 */
async function getBalanceFromAddress() {
  try {
    const wallet = getWallet();
    if (!wallet) return { ok: false, error: "no_wallet", balance: 0 };

    const address = wallet.address;
    const path = `/balance/${address}`;
    const headers = buildClobHeaders("GET", path);
    const res = await fetch(`${CLOB_BASE}${path}`, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(5000)
    });

    if (!res.ok) {
      return { ok: false, error: `api_${res.status}`, balance: 0 };
    }

    const data = await res.json();
    const result = {
      ok: true,
      balance: Number(data.balance || data.available || 0),
      allowance: Number(data.allowance || 0),
      locked: Number(data.locked || 0),
      address,
      raw: data
    };

    cachedBalance = result;
    cachedAt = Date.now();
    return result;
  } catch (err) {
    return { ok: false, error: err.message, balance: 0 };
  }
}

/**
 * Check if wallet has sufficient balance for a trade.
 * Returns { ok, balance, shortfall? }
 */
export async function checkBalance(requiredAmount) {
  const wallet = await getWalletBalance();
  if (!wallet.ok) {
    return { ok: false, balance: 0, error: wallet.error, reason: "balance_check_failed" };
  }

  const available = wallet.balance - (wallet.locked || 0);

  if (available < MIN_BALANCE) {
    logAuditEvent("CIRCUIT_BREAKER", { detail: `low_balance: $${available.toFixed(2)} < min $${MIN_BALANCE}` });
    return { ok: false, balance: available, reason: "below_minimum", minBalance: MIN_BALANCE };
  }

  if (available < requiredAmount) {
    return { ok: false, balance: available, shortfall: requiredAmount - available, reason: "insufficient_balance" };
  }

  return { ok: true, balance: available, locked: wallet.locked || 0 };
}

/**
 * Clear the cached balance (call after a trade to force refresh).
 */
export function invalidateBalanceCache() {
  cachedBalance = null;
  cachedAt = 0;
}
