#!/usr/bin/env node
/**
 * MCP Server for the Polymarket BTC 15m assistant.
 * Entry point: node src/mcp/server.js
 * Communicates via stdio.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./tools.js";

const server = new McpServer({
  name: "polymarket-btc-15m",
  version: "0.1.0"
});

registerTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);
