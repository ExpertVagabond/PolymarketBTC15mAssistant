/**
 * CLOB order execution: place market orders, cancel orders.
 * Only called when TRADING_DRY_RUN=false AND ENABLE_TRADING=true.
 */

import { CONFIG } from "../config.js";
import { buildClobHeaders } from "./clob-auth.js";

const CLOB_BASE = CONFIG.clobBaseUrl;

export async function placeMarketOrder({ tokenId, side, amount }) {
  const path = "/order";
  const body = JSON.stringify({
    tokenID: tokenId,
    side: side === "UP" ? "BUY" : "BUY", // buying YES for UP or YES for DOWN token
    type: "MARKET",
    price: side === "UP" ? "1" : "1",
    size: String(amount)
  });

  const headers = buildClobHeaders("POST", path, body);
  const res = await fetch(`${CLOB_BASE}${path}`, {
    method: "POST",
    headers,
    body
  });

  const data = await res.json();
  return { ok: res.ok, status: res.status, data };
}

export async function cancelOrder({ orderId }) {
  const path = `/order/${orderId}`;
  const headers = buildClobHeaders("DELETE", path);
  const res = await fetch(`${CLOB_BASE}${path}`, {
    method: "DELETE",
    headers
  });
  const data = await res.json();
  return { ok: res.ok, status: res.status, data };
}
