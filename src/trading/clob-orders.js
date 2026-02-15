/**
 * CLOB order execution: place market/limit orders, close positions, cancel orders.
 * Only called when TRADING_DRY_RUN=false AND ENABLE_TRADING=true.
 *
 * Polymarket CLOB: each market has YES and NO tokens.
 * - Signal UP → BUY the YES token (tokenId = upTokenId)
 * - Signal DOWN → BUY the NO token (tokenId = downTokenId)
 * - Close UP position → SELL the YES token
 * - Close DOWN position → SELL the NO token
 *
 * The bot.js already resolves the correct tokenId based on side before calling here.
 */

import { CONFIG } from "../config.js";
import { buildClobHeaders } from "./clob-auth.js";
import { fetchOrderBook, summarizeOrderBook } from "../data/polymarket.js";

const CLOB_BASE = CONFIG.clobBaseUrl;
const MAX_SLIPPAGE_PCT = Number(process.env.MAX_SLIPPAGE_PCT) || 2;

/**
 * Fetch the best price and book summary for a token.
 * @returns {{ bestBid, bestAsk, midpoint, bidLiquidity, askLiquidity, spread }}
 */
export async function getTokenPricing(tokenId) {
  const book = await fetchOrderBook({ tokenId });
  const summary = summarizeOrderBook(book);
  const bestBid = summary.bestBid;
  const bestAsk = summary.bestAsk;
  const midpoint = bestBid != null && bestAsk != null
    ? (bestBid + bestAsk) / 2
    : bestBid ?? bestAsk ?? null;
  const spread = bestBid != null && bestAsk != null
    ? bestAsk - bestBid
    : null;

  return {
    bestBid,
    bestAsk,
    midpoint,
    spread,
    bidLiquidity: summary.bidLiquidity ?? 0,
    askLiquidity: summary.askLiquidity ?? 0
  };
}

/**
 * Check if there's sufficient liquidity for the desired trade size.
 * Returns { ok, estimatedSlippage, availableLiquidity, reason? }
 */
export async function checkLiquidity(tokenId, orderSide, amount) {
  const pricing = await getTokenPricing(tokenId);

  // BUY eats ask liquidity, SELL eats bid liquidity
  const availableLiquidity = orderSide === "BUY"
    ? pricing.askLiquidity
    : pricing.bidLiquidity;

  if (availableLiquidity <= 0) {
    return { ok: false, estimatedSlippage: null, availableLiquidity: 0, reason: "no_liquidity" };
  }

  // Rough slippage estimate: if order is >50% of top-of-book liquidity, warn
  const slippageRatio = amount / availableLiquidity;
  const estimatedSlippage = slippageRatio * 100;

  if (estimatedSlippage > MAX_SLIPPAGE_PCT) {
    return { ok: false, estimatedSlippage, availableLiquidity, reason: `slippage_${estimatedSlippage.toFixed(1)}pct_exceeds_${MAX_SLIPPAGE_PCT}pct` };
  }

  return { ok: true, estimatedSlippage, availableLiquidity, pricing };
}

/**
 * Place a BUY order (opening a position).
 * Signal UP → buying YES token. Signal DOWN → buying NO token.
 * tokenId should already be the correct one for the signal side.
 *
 * @param {{ tokenId: string, side: string, amount: number, price?: number }} opts
 */
export async function placeMarketOrder({ tokenId, side, amount, price }) {
  // Always BUY the token — the correct token (YES or NO) was selected by bot.js
  const orderSide = "BUY";

  // Use provided price or fetch from order book
  let orderPrice = price;
  if (!orderPrice) {
    const pricing = await getTokenPricing(tokenId);
    // For BUY: use best ask (or midpoint + small buffer)
    orderPrice = pricing.bestAsk ?? pricing.midpoint ?? 0.5;
  }

  const path = "/order";
  const body = JSON.stringify({
    tokenID: tokenId,
    side: orderSide,
    type: "MARKET",
    price: String(orderPrice.toFixed(4)),
    size: String(amount)
  });

  const headers = buildClobHeaders("POST", path, body);
  const res = await fetch(`${CLOB_BASE}${path}`, {
    method: "POST",
    headers,
    body
  });

  const data = await res.json();

  return {
    ok: res.ok,
    status: res.status,
    data,
    orderPrice,
    side: orderSide,
    tokenId,
    amount
  };
}

/**
 * Place a SELL order (closing a position).
 * Sells the token we're holding to exit the position.
 *
 * @param {{ tokenId: string, amount: number, price?: number }} opts
 */
export async function placeSellOrder({ tokenId, amount, price }) {
  let orderPrice = price;
  if (!orderPrice) {
    const pricing = await getTokenPricing(tokenId);
    // For SELL: use best bid (or midpoint - small buffer)
    orderPrice = pricing.bestBid ?? pricing.midpoint ?? 0.5;
  }

  const path = "/order";
  const body = JSON.stringify({
    tokenID: tokenId,
    side: "SELL",
    type: "MARKET",
    price: String(orderPrice.toFixed(4)),
    size: String(amount)
  });

  const headers = buildClobHeaders("POST", path, body);
  const res = await fetch(`${CLOB_BASE}${path}`, {
    method: "POST",
    headers,
    body
  });

  const data = await res.json();

  return {
    ok: res.ok,
    status: res.status,
    data,
    orderPrice,
    side: "SELL",
    tokenId,
    amount
  };
}

/**
 * Cancel an open order by ID.
 */
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
