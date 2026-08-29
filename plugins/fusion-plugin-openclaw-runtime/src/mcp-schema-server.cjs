"use strict";

const fs = require("fs");
const readline = require("readline");

const schemaPath = process.argv[2];
if (!schemaPath) process.exit(1);

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
    process.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "fusion-custom-tools", version: "1.0.0" },
        },
      }) + "\n",
    );
    return;
  }

  if (msg.method === "tools/list") {
    process.stdout.write(
      JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools } }) + "\n",
    );
    return;
  }

  if (msg.method === "tools/call") {
    process.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          content: [{ type: "text", text: "Tool execution is handled by Fusion runtime." }],
          isError: true,
        },
      }) + "\n",
    );
  }
});
