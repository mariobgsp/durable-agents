#!/usr/bin/env node
/** Minimal MCP stdio server for E2E: initialize, tools/list (echo), tools/call (echo). */
import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin });
const write = (value) => process.stdout.write(JSON.stringify(value) + "\n");

rl.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = message;
  if (method === "initialize") {
    write({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "fake-mcp", version: "1.0.0" },
      },
    });
    return;
  }
  if (method === "tools/list") {
    write({
      jsonrpc: "2.0",
      id,
      result: {
        tools: [
          {
            name: "echo",
            description: "Echo the provided text",
            inputSchema: {
              type: "object",
              properties: { text: { type: "string", description: "Text to echo" } },
              required: ["text"],
              additionalProperties: false,
            },
          },
        ],
      },
    });
    return;
  }
  if (method === "tools/call") {
    const text = params?.arguments?.text ?? "";
    write({
      jsonrpc: "2.0",
      id,
      result: { content: [{ type: "text", text: "echo: " + text }] },
    });
    return;
  }
  if (method === "ping") {
    write({ jsonrpc: "2.0", id, result: {} });
    return;
  }
  if (id !== undefined) {
    write({ jsonrpc: "2.0", id, error: { code: -32601, message: "unknown method " + method } });
  }
});

rl.on("close", () => process.exit(0));
