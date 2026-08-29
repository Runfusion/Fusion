#!/usr/bin/env node
// Schema-only MCP server. Reads tool schemas from a JSON file.
// Only implements initialize + tools/list. tools/call is never reached
// because the parent process kills the Claude subprocess at message_stop
// before tool execution (break-early pattern).
"use strict";

const fs = require("fs");
const readline = require("readline");

const schemaPath = process.argv[2];
if (!schemaPath) {
  process.exit(1);
}

let tools = [];
try {
  tools = JSON.parse(fs.readFileSync(schemaPath, "utf-8"));
} catch {
  process.exit(1);
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
    const resp = {
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "custom-tools", version: "1.0.0" },
      },
    };
    process.stdout.write(JSON.stringify(resp) + "\n");
  } else if (msg.method === "tools/list") {
    const resp = { jsonrpc: "2.0", id: msg.id, result: { tools } };
    process.stdout.write(JSON.stringify(resp) + "\n");
  }
  // notifications/initialized: no response needed (notification)
  // tools/call: never reached (break-early kills subprocess first)
});
