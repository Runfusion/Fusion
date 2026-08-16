import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fusionToolsMcpServerPath, startFusionToolBridge, toolsToMcpToolDefs } from "../tool-bridge.js";

async function mcpRequest(child: ReturnType<typeof spawn>, payload: string): Promise<Record<string, unknown>> {
  const stdout = child.stdout;
  const stdin = child.stdin;
  if (!stdout || !stdin) {
    throw new Error("MCP child stdio is unavailable");
  }
  return new Promise((resolve, reject) => {
    let output = "";
    const onData = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      const lines = output.split("\n");
      const line = lines.find((candidate) => {
        try {
          JSON.parse(candidate);
          return true;
        } catch {
          return false;
        }
      });
      if (line) {
        stdout.off("data", onData);
        resolve(JSON.parse(line) as Record<string, unknown>);
      }
    };
    stdout.setEncoding("utf8");
    stdout.on("data", onData);
    child.once("error", reject);
    stdin.write(`${payload}\n`);
  });
}

describe("tool-bridge", () => {
  it("filters built-ins and maps tool schemas", () => {
    expect(
      toolsToMcpToolDefs([
        { name: "read", description: "builtin", parameters: {} },
        { name: "fn_task_list", description: "List tasks", parameters: { type: "object", properties: {} } },
      ]),
    ).toEqual([
      {
        name: "fn_task_list",
        description: "List tasks",
        inputSchema: { type: "object", properties: {} },
      },
    ]);
  });

  it("returns null when there are no custom tools", async () => {
    expect(await startFusionToolBridge([])).toBeNull();
    expect(await startFusionToolBridge(undefined)).toBeNull();
  });

  it("starts a bridge that executes Fusion custom tools over authenticated HTTP", async () => {
    const bridge = await startFusionToolBridge([
      {
        name: "fn_heartbeat_done",
        description: "Finish heartbeat",
        parameters: { type: "object", properties: {} },
        execute: async (toolCallId: string) => ({ text: `done:${toolCallId}` }),
      },
    ]);
    expect(bridge).not.toBeNull();
    expect(bridge!.toolCount).toBe(1);
    expect(bridge!.mcpServer.name).toBe("fusion-custom-tools");
    expect(bridge!.mcpServer.command).toBe(process.execPath);

    const env = bridge!.mcpServer.env;
    const bridgeUrl = env.find((e) => e.name === "FUSION_ACP_TOOL_BRIDGE_URL")?.value;
    const token = env.find((e) => e.name === "FUSION_ACP_TOOL_BRIDGE_TOKEN")?.value;
    expect(bridgeUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(token).toBeTruthy();

    // No token → 401 (a same-host probe must not invoke Fusion closures).
    const unauthorized = await fetch(`${bridgeUrl}/tool-call`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "fn_heartbeat_done", arguments: {} }),
    });
    expect(unauthorized.status).toBe(401);

    // Authenticated call threads the real toolCallId.
    const res = await fetch(`${bridgeUrl}/tool-call`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: "fn_heartbeat_done", toolCallId: "call-42", arguments: {} }),
    });
    const body = (await res.json()) as { isError?: boolean; content?: Array<{ text?: string }> };
    expect(body.isError).toBe(false);
    expect(body.content?.[0]?.text).toBe("done:call-42");

    // Unknown tool → 404.
    const unknown = await fetch(`${bridgeUrl}/tool-call`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: "fn_nope", arguments: {} }),
    });
    expect(unknown.status).toBe(404);

    await bridge!.dispose();
    // Port closed after dispose: a follow-up request must fail.
    await expect(
      fetch(`${bridgeUrl}/tool-call`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ name: "fn_heartbeat_done", arguments: {} }),
      }),
    ).rejects.toThrow();
  });

  it("dispose is idempotent and removes the temporary schema", async () => {
    const bridge = await startFusionToolBridge([
      { name: "fn_task_list", description: "List", parameters: {}, execute: async () => ({ text: "ok" }) },
    ]);
    expect(bridge).not.toBeNull();
    const schemaPath = bridge!.mcpServer.args[1] as string;
    expect(existsSync(schemaPath)).toBe(true);
    await bridge!.dispose();
    await bridge!.dispose();
    expect(existsSync(schemaPath)).toBe(false);
  });

  it("serves the full MCP protocol from the co-located schema server", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fusion-acp-mcp-smoke-"));
    const schemaPath = join(directory, "schemas.json");
    await writeFile(
      schemaPath,
      JSON.stringify([
        { name: "fn_heartbeat_done", description: "Finish heartbeat", inputSchema: { type: "object", properties: {} } },
      ]),
    );
    const child = spawn(process.execPath, [fusionToolsMcpServerPath(), schemaPath], {
      env: { ...process.env, FUSION_ACP_TOOL_BRIDGE_URL: "http://127.0.0.1:1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    try {
      const initialized = await mcpRequest(child, '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}');
      expect((initialized.result as { serverInfo?: { name?: string } }).serverInfo?.name).toBe("fusion-custom-tools");

      const pinged = await mcpRequest(child, '{"jsonrpc":"2.0","id":2,"method":"ping","params":{}}');
      expect(pinged.result).toEqual({});

      const listed = await mcpRequest(child, '{"jsonrpc":"2.0","id":3,"method":"tools/list","params":{}}');
      const tools = (listed.result as { tools?: Array<{ name: string }> }).tools ?? [];
      expect(tools.map((tool) => tool.name)).toEqual(["fn_heartbeat_done"]);

      // tools/call against a dead bridge (port 1) must surface an error result,
      // never an empty "success".
      const called = await mcpRequest(
        child,
        '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"fn_heartbeat_done","arguments":{}}}',
      );
      expect((called.result as { isError?: boolean }).isError).toBe(true);

      // Unknown method → -32601.
      const missing = await mcpRequest(child, '{"jsonrpc":"2.0","id":5,"method":"bogus","params":{}}');
      expect((missing.error as { code?: number }).code).toBe(-32601);
    } finally {
      child.kill();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
