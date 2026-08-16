#!/usr/bin/env node
/*
FNXC:AcpCustomTools 2026-08-16-00:30:
Executable MCP bridge for Fusion custom tools (fn_*) on generic ACP paths
(Hermes ACP, Prime, ...). tools/list is served from a schema file; tools/call
POSTs to a localhost bridge owned by AcpRuntimeAdapter so ToolDefinition.execute
runs in-process with the engine's closures. The bridge authenticates the POST
with a per-session bearer token passed via FUSION_ACP_TOOL_BRIDGE_TOKEN.
*/
"use strict";

const fs = require("fs");
const http = require("http");
const readline = require("readline");
// FNXC:AcpCustomTools 2026-08-16-00:30: CJS has no global URL under eslint no-undef; use node:url.
const { URL } = require("node:url");

const schemaPath = process.argv[2];
const bridgeUrl = process.env.FUSION_ACP_TOOL_BRIDGE_URL;
const bridgeToken = process.env.FUSION_ACP_TOOL_BRIDGE_TOKEN;
if (!schemaPath || !bridgeUrl) {
  process.stderr.write("fusion-custom-tools-mcp: missing schema path or FUSION_ACP_TOOL_BRIDGE_URL\n");
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

function callBridge(toolName, toolCallId, args) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ name: toolName, toolCallId, arguments: args ?? {} });
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
          ...(bridgeToken ? { authorization: `Bearer ${bridgeToken}` } : {}),
        },
        timeout: 120_000,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          // A non-2xx bridge response is a transport failure, not a tool result:
          // surface it as an error instead of fabricating an empty "success".
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`tool bridge responded ${res.statusCode}: ${data.slice(0, 200)}`));
            return;
          }
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

  // Ping must answer: some clients (Hermes ACP) treat a missing handler as a
  // method-not-found and back off.
  if (msg.method === "ping") {
    write({ jsonrpc: "2.0", id: msg.id, result: {} });
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
    // JSON-RPC ids are commonly numbers; coerce so the bridge threads the real
    // request id as the toolCallId instead of falling back to a fabricated id.
    const toolCallId = typeof msg.id === "string" ? msg.id : String(msg.id);
    callBridge(toolName, toolCallId, args)
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
