#!/usr/bin/env node
// FNXC:AntigravityCompatibility 2026-09-20-18:32: This deterministic fixture is the credential-free authority for the documented non-ACP stream contract.
// FNXC:AntigravityPromptReaping 2026-09-20-19:37: The hold-open prompt keeps a real child alive until transport cancellation proves it reaped before callers can clean up MCP state.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("1.2.7"); process.exit(0); }
if (args[0] === "mcp") { console.log("fixture MCP command accepted"); process.exit(0); }
const input = createInterface({ input: process.stdin });
input.once("line", (line) => {
  const request = JSON.parse(line);
  if (request.prompt === "hold-open") {
    writeFileSync(join(process.cwd(), "agy-fixture.pid"), String(process.pid));
    console.log(JSON.stringify({ type: "assistant.delta", text: "Waiting" }));
    setInterval(() => undefined, 1_000);
    return;
  }
  console.log(JSON.stringify({ type: "assistant.delta", text: "Hello" }));
  console.log(JSON.stringify({ type: "thinking.delta", text: "Checking" }));
  console.log(JSON.stringify({ type: "tool.call.start", id: "call-1", name: "fn_task_list", arguments: { limit: 1 } }));
  console.log(JSON.stringify({ type: "tool.call.result", id: "call-1", name: "fn_task_list", result: "[]" }));
  console.log(JSON.stringify({ type: "result", session_id: "fixture-session", text: "Hello", is_error: false }));
});
