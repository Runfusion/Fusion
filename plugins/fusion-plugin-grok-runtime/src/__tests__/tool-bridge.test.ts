import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fusionToolsMcpServerPath, startFusionToolBridge, toolsToMcpToolDefs } from "../tool-bridge.js";

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

  it("exposes every expanded chat fusion tool to the Grok MCP schema", () => {
    /*
    FNXC:ChatAgentTools 2026-07-15-00:00:
    The Grok loopback bridge must publish every safe coordination/productivity
    tool assembled by dashboard chat. Each fixture includes execute because the
    MCP bridge can only invoke in-process Fusion tool closures.
    */
    const chatToolNames = [
      "fn_task_list",
      "fn_task_show",
      "fn_task_search",
      "fn_task_create",
      "fn_delegate_task",
      "fn_list_agents",
      "fn_get_agent_config",
      "fn_web_fetch",
      "fn_goal_list",
      "fn_goal_show",
      "fn_memory_search",
      "fn_memory_get",
      "fn_research_run",
      "fn_research_list",
      "fn_research_get",
      "fn_research_cancel",
      "fn_research_retry",
    ];
    const tools = chatToolNames.map((name) => ({
      name,
      description: name,
      parameters: { type: "object", properties: {} },
      execute: async () => ({ content: [] }),
    }));

    expect(toolsToMcpToolDefs(tools).map((tool) => tool.name)).toEqual(chatToolNames);
  });

  it("starts a bridge that executes Fusion custom tools over HTTP", async () => {
    const bridge = await startFusionToolBridge([
      {
        name: "fn_task_list",
        description: "List tasks",
        parameters: { type: "object", properties: {} },
        execute: async () => ({ text: "FN-1 todo" }),
      },
    ]);
    expect(bridge).not.toBeNull();
    expect(bridge!.toolCount).toBe(1);
    expect(bridge!.mcpServer.name).toBe("fusion-custom-tools");
    expect(bridge!.mcpServer).toMatchObject({
      command: process.execPath,
      env: [expect.objectContaining({ name: "FUSION_GROK_TOOL_BRIDGE_URL" })],
    });

    const env = "env" in bridge!.mcpServer ? bridge!.mcpServer.env : [];
    const bridgeUrl = env.find((e) => e.name === "FUSION_GROK_TOOL_BRIDGE_URL")?.value;
    expect(bridgeUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    const res = await fetch(`${bridgeUrl}/tool-call`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "fn_task_list", arguments: {} }),
    });
    const body = (await res.json()) as { isError?: boolean; content?: Array<{ text?: string }> };
    expect(body.isError).toBe(false);
    expect(body.content?.[0]?.text).toContain("FN-1");

    await bridge!.dispose();
  });

  it("serves MCP initialize from the co-located schema server", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fusion-mcp-smoke-"));
    const schemaPath = join(directory, "schemas.json");
    await writeFile(schemaPath, "[]");
    const child = spawn(process.execPath, [fusionToolsMcpServerPath(), schemaPath], {
      env: { ...process.env, FUSION_GROK_TOOL_BRIDGE_URL: "http://127.0.0.1:1" },
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

  it("returns null when there are no custom tools", async () => {
    expect(await startFusionToolBridge([])).toBeNull();
    expect(await startFusionToolBridge(undefined)).toBeNull();
  });
});
