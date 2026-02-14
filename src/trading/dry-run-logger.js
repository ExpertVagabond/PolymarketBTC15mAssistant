/**
 * Dry-run trade logger: logs would-be trades to CSV without executing.
 */

import { appendCsvRow } from "../utils.js";

const CSV_PATH = "./logs/dry-run-trades.csv";
const HEADER = [
  "timestamp", "market_slug", "side", "strength", "phase",
  "model_up", "model_down", "edge_up", "edge_down",
  "bet_size", "btc_price", "price_to_beat", "regime"
];

export function logDryRunTrade(state, betSize) {
  appendCsvRow(CSV_PATH, HEADER, [
    new Date().toISOString(),
    state.market?.slug || "",
    state.rec?.side || "",
    state.rec?.strength || "",
    state.rec?.phase || "",
    state.timeAware?.adjustedUp?.toFixed(4) || "",
    state.timeAware?.adjustedDown?.toFixed(4) || "",
    state.edge?.edgeUp?.toFixed(4) || "",
    state.edge?.edgeDown?.toFixed(4) || "",
    betSize.toFixed(2),
    state.prices?.spot || "",
    state.prices?.priceToBeat || "",
    state.regimeInfo?.regime || ""
  ]);
}
