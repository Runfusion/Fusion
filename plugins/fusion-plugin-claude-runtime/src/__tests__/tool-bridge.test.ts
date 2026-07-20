import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { fusionToolsMcpServerPath, startFusionToolBridge } from "../tool-bridge.js";

function bridgeEnv(bridge: NonNullable<Awaited<ReturnType<typeof startFusionToolBridge>>>, name: string): string {
  if (!("env" in bridge.mcpServer)) throw new Error("custom tool bridge must use stdio MCP");
  const value = bridge.mcpServer.env.find((entry) => entry.name === name)?.value;
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

async function post(url: string, body: string, token?: string): Promise<{ status: number; body: string }> {
  const target = new URL("/tool-call", url);
  return await new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      },
      (res) => {
        let response = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (response += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: response }));
      },
    );
    req.once("error", reject);
    req.end(body);
  });
}

describe("startFusionToolBridge", () => {
  it("serves MCP initialize from the co-located schema server", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fusion-mcp-smoke-"));
    const schemaPath = join(directory, "schemas.json");
    await writeFile(schemaPath, "[]");
    const child = spawn(process.execPath, [fusionToolsMcpServerPath(), schemaPath], {
      env: { ...process.env, FUSION_GROK_TOOL_BRIDGE_URL: "http://127.0.0.1:1", FUSION_TOOL_BRIDGE_CAPABILITY: "test" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    try {
      const response = await new Promise<Record<string, unknown>>((resolve, reject) => {
        let output = "";
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
          output += chunk;
          const line = output.split("\n")[0];
          if (line) resolve(JSON.parse(line) as Record<string, unknown>);
        });
        child.once("error", reject);
        child.stdin.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n');
      });
      expect((response.result as { serverInfo?: { name?: string } }).serverInfo?.name).toBe("fusion-custom-tools");
    } finally {
      child.kill();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("requires a session capability and action-gate authorization before executing a custom tool", async () => {
    const execute = vi.fn().mockResolvedValue({ text: "done" });
    const bridge = await startFusionToolBridge(
      [{ name: "fn_task_update", execute }],
      { actionGateContext: { permissionPolicy: { rules: { task_agent_mutation: "allow" } } }, allowUnrestricted: true },
    );
    expect(bridge).not.toBeNull();
    if (!bridge) return;

    const url = bridgeEnv(bridge, "FUSION_GROK_TOOL_BRIDGE_URL");
    const token = bridgeEnv(bridge, "FUSION_TOOL_BRIDGE_CAPABILITY");
    try {
      expect((await post(url, JSON.stringify({ name: "fn_task_update" }))).status).toBe(401);
      expect(execute).not.toHaveBeenCalled();

      const response = await post(url, JSON.stringify({ name: "fn_task_update", arguments: { step: 1 } }), token);
      expect(response.status).toBe(200);
      expect(execute).toHaveBeenCalledOnce();
    } finally {
      await bridge.dispose();
    }
  });

  it("default-denies when no action policy is available and bounds request bodies", async () => {
    const execute = vi.fn();
    const bridge = await startFusionToolBridge([{ name: "fn_task_update", execute }]);
    expect(bridge).not.toBeNull();
    if (!bridge) return;

    const url = bridgeEnv(bridge, "FUSION_GROK_TOOL_BRIDGE_URL");
    const token = bridgeEnv(bridge, "FUSION_TOOL_BRIDGE_CAPABILITY");
    try {
      expect((await post(url, JSON.stringify({ name: "fn_task_update" }), token)).status).toBe(403);
      expect(execute).not.toHaveBeenCalled();
      expect((await post(url, "x".repeat(1_048_577), token)).status).toBe(413);
    } finally {
      await bridge.dispose();
    }
  });
});
