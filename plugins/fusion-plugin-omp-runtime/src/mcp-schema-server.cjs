#!/usr/bin/env node
/*
FNXC:OmpAcp 2026-07-14-00:05:
Executable MCP bridge for Fusion custom tools (fn_*) on the OMP ACP path.
tools/list is served from a schema file; tools/call POSTs to a localhost bridge
owned by OmpRuntimeAdapter so ToolDefinition.execute runs in-process with the
engine's closures. Ported from fusion-plugin-grok-runtime for fn_* parity.
*/
"use strict";

const fs = require("fs");
const http = require("http");
const readline = require("readline");
const { URL } = require("node:url");

const schemaPath = process.argv[2];
const bridgeUrl = process.env.FUSION_OMP_TOOL_BRIDGE_URL;
if (!schemaPath || !bridgeUrl) {
  process.stderr.write("fusion-tools-mcp-server: missing schema path or FUSION_OMP_TOOL_BRIDGE_URL\n");
  process.exit(1);
}

let tools = [];
try {
  tools = JSON.parse(fs.readFileSync(schemaPath, "utf-8"));
  if (!Array.isArray(tools)) tools = [];
} catch {
  process.exit(1);
}

function write(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function callBridge(toolName, args) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ name: toolName, arguments: args ?? {} });
    const url = new URL("/tool-call", bridgeUrl);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
        timeout: 120_000,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          try {
            resolve(JSON.parse(data || "{}"));
          } catch (err) {
            reject(err);
          }
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy(new Error("tool bridge timeout"));
    });
    req.write(body);
    req.end();
  });
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  if (msg.method === "initialize") {
    write({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "fusion-custom-tools", version: "1.0.0" },
      },
    });
    return;
  }

  if (msg.method === "notifications/initialized" || msg.method === "initialized") {
    return;
  }

  if (msg.method === "tools/list") {
    write({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        tools: tools.map((tool) => ({
          name: tool.name,
          description: tool.description ?? "",
          inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
        })),
      },
    });
    return;
  }

  if (msg.method === "tools/call") {
    const toolName = msg.params?.name;
    const args = msg.params?.arguments ?? {};
    callBridge(toolName, args)
      .then((result) => {
        write({
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            content: Array.isArray(result.content)
              ? result.content
              : [{ type: "text", text: typeof result.text === "string" ? result.text : JSON.stringify(result) }],
            isError: result.isError === true,
          },
        });
      })
      .catch((err) => {
        write({
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
            isError: true,
          },
        });
      });
    return;
  }

  if (msg.id !== undefined) {
    write({
      jsonrpc: "2.0",
      id: msg.id,
      error: { code: -32601, message: `Method not found: ${msg.method}` },
    });
  }
});
