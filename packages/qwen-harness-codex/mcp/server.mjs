#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import {
  CODEX_HARNESS_TOOLS,
  callCodexHarnessTool,
} from "../src/mcp-tools.mjs";

const server = new Server(
  {
    name: "qwen-harness-codex",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: CODEX_HARNESS_TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const result = await callCodexHarnessTool(
    request.params.name,
    request.params.arguments ?? {},
  );
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(result, null, 2),
      },
    ],
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
