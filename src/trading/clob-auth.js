/**
 * CLOB API authentication for Polymarket.
 * Uses ethers.js wallet for HMAC signing.
 * Env: POLYMARKET_API_KEY, POLYMARKET_API_SECRET, POLYMARKET_API_PASSPHRASE, POLYMARKET_PRIVATE_KEY
 */

import { ethers } from "ethers";

const API_KEY = process.env.POLYMARKET_API_KEY || "";
const API_SECRET = process.env.POLYMARKET_API_SECRET || "";
const API_PASSPHRASE = process.env.POLYMARKET_API_PASSPHRASE || "";
const PRIVATE_KEY = process.env.POLYMARKET_PRIVATE_KEY || "";

export function isTradingConfigured() {
  return API_KEY.length > 0 && API_SECRET.length > 0 && PRIVATE_KEY.length > 0;
}

export function getWallet() {
  if (!PRIVATE_KEY) return null;
  return new ethers.Wallet(PRIVATE_KEY);
}

/**
 * Build CLOB API headers for authenticated requests.
 */
export function buildClobHeaders(method, path, body = "") {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const message = timestamp + method.toUpperCase() + path + body;

  const hmac = ethers.hmac(
    ethers.id("sha256"),
    ethers.toUtf8Bytes(API_SECRET),
    ethers.toUtf8Bytes(message)
  );

  return {
    "POLY_TIMESTAMP": timestamp,
    "POLY_API_KEY": API_KEY,
    "POLY_PASSPHRASE": API_PASSPHRASE,
    "POLY_SIGNATURE": Buffer.from(hmac).toString("base64"),
    "Content-Type": "application/json"
  };
}

export function getApiCredentials() {
  return { apiKey: API_KEY, hasSecret: API_SECRET.length > 0, hasPassphrase: API_PASSPHRASE.length > 0, hasPrivateKey: PRIVATE_KEY.length > 0 };
}
