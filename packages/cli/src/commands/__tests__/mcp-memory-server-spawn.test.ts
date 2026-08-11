import { existsSync } from "node:fs";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { buildKnowledgeGraph } from "../../../../core/src/knowledge-graph/graph-builder.js";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const testDir = dirname(fileURLToPath(import.meta.url));
const builtEntry = resolve(testDir, "../../../dist/bin.js");
const sourceEntry = resolve(testDir, "../../bin.ts");
const CHILD_RESPONSE_TIMEOUT_MS = 10_000;

function resolveChildCommand(): { command: string; args: string[]; provisionedBy: "dist" | "tsx" } {
  if (existsSync(builtEntry)) return { command: process.execPath, args: [builtEntry], provisionedBy: "dist" };
  const tsxCli = createRequire(import.meta.url).resolve("tsx/cli");
  return { command: process.execPath, args: [tsxCli, sourceEntry], provisionedBy: "tsx" };
}

describe("memory MCP child transport", () => {
  const roots: string[] = [];
  afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

  it("keeps serving valid JSON-RPC after a project-store open failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "fusion-memory-mcp-"));
    roots.push(root);
    // The child has no database, but graph artifacts are independent of the store.
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "memory.ts"), "export const memory = true;", "utf8");
    await buildKnowledgeGraph({ projectRoot: root, discovery: { sourceRoots: ["src"], markdownRoots: [] } });
    const childCommand = resolveChildCommand();
    const child = spawn(childCommand.command, [...childCommand.args, "mcp", "serve-memory", "--project-root", root], {
      stdio: ["pipe", "pipe", "pipe"],
      detached: false,
      // Force the lazy project-store open to fail; graph artifacts remain readable.
      env: { ...process.env, FUSION_NO_EMBEDDED_PG: "1" },
    });
    const lines = createInterface({ input: child.stdout! });
    const messages: Array<Record<string, unknown>> = [];
    let stderr = "";
    child.stderr!.on("data", chunk => { stderr += String(chunk); });
    const exit = new Promise<void>((resolveExit, rejectExit) => {
      child.once("exit", () => resolveExit());
      child.once("error", rejectExit);
    });
    try {
      const received = new Promise<void>((resolveResponse, rejectResponse) => {
        const timer = setTimeout(() => rejectResponse(new Error(`memory MCP child (${childCommand.provisionedBy}) did not respond: ${stderr}`)), CHILD_RESPONSE_TIMEOUT_MS);
        lines.on("line", line => {
          messages.push(JSON.parse(line) as Record<string, unknown>);
          if (messages.length === 4) { clearTimeout(timer); resolveResponse(); }
        });
        child.once("error", rejectResponse);
      });
      child.stdin!.write('{"jsonrpc":"2.0","id":1,"method":"initialize"}\n');
      child.stdin!.write('{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n');
      child.stdin!.write('{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"graph_query","arguments":{}}}\n');
      child.stdin!.write('{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"recall_search","arguments":{"query":"memory"}}}\n');
      await received;
      expect(messages[0]?.result).toMatchObject({ protocolVersion: "2024-11-05" });
      expect(messages[1]?.result).toMatchObject({ tools: expect.arrayContaining([expect.objectContaining({ name: "graph_query" })]) });
      expect(messages[2]?.result).toMatchObject({ content: [{ type: "text", text: expect.any(String) }] });
      expect(messages[2]?.result).not.toMatchObject({ isError: true });
      expect(JSON.parse((messages[2]?.result as { content: Array<{ text: string }> }).content[0]!.text).results).not.toHaveLength(0);
      expect(messages[3]?.result).toMatchObject({ isError: true, content: [{ type: "text", text: expect.any(String) }] });
      child.stdin!.end();
      await exit;
    } finally {
      lines.close();
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
        await exit.catch(() => undefined);
      }
    }
  }, CHILD_RESPONSE_TIMEOUT_MS + 2_000);
});
