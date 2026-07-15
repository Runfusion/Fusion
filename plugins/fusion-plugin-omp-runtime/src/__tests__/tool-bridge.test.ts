import { describe, expect, it } from "vitest";
import {
  FUSION_OMP_TOOL_BRIDGE_URL,
  startFusionToolBridge,
  toolsToMcpToolDefs,
} from "../tool-bridge.js";
import { buildOmpFusionToolRules } from "../runtime-adapter.js";

describe("tool-bridge", () => {
  it("filters built-ins and maps tool schemas", () => {
    expect(
      toolsToMcpToolDefs([
        { name: "read", description: "builtin", parameters: {} },
        {
          name: "fn_task_list",
          description: "List tasks",
          parameters: { type: "object", properties: {} },
        },
      ]),
    ).toEqual([
      {
        name: "fn_task_list",
        description: "List tasks",
        inputSchema: { type: "object", properties: {} },
      },
    ]);
  });

  it("starts a bridge that executes Fusion custom tools over HTTP", async () => {
    const bridge = await startFusionToolBridge([
      {
        name: "fn_task_list",
        description: "List tasks",
        parameters: { type: "object", properties: {} },
        execute: async () => ({ text: "FN-1 todo" }),
      },
      {
        name: "fn_task_show",
        description: "Show task",
        parameters: {
          type: "object",
          properties: { id: { type: "string" } },
        },
        execute: async (_id, params) => {
          const id = (params as { id?: string })?.id ?? "?";
          return { text: `task ${id}` };
        },
      },
    ]);
    expect(bridge).not.toBeNull();
    expect(bridge!.toolCount).toBe(2);
    expect(bridge!.mcpServer.name).toBe("fusion-custom-tools");
    expect(bridge!.mcpServer).toMatchObject({
      command: process.execPath,
      env: [expect.objectContaining({ name: FUSION_OMP_TOOL_BRIDGE_URL })],
    });

    const env = "env" in bridge!.mcpServer ? bridge!.mcpServer.env : [];
    const bridgeUrl = env.find((e) => e.name === FUSION_OMP_TOOL_BRIDGE_URL)?.value;
    expect(bridgeUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    const listRes = await fetch(`${bridgeUrl}/tool-call`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "fn_task_list", arguments: {} }),
    });
    const listBody = (await listRes.json()) as {
      isError?: boolean;
      content?: Array<{ text?: string }>;
    };
    expect(listBody.isError).toBe(false);
    expect(listBody.content?.[0]?.text).toContain("FN-1");

    const showRes = await fetch(`${bridgeUrl}/tool-call`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "fn_task_show", arguments: { id: "FN-2" } }),
    });
    const showBody = (await showRes.json()) as {
      isError?: boolean;
      content?: Array<{ text?: string }>;
    };
    expect(showBody.isError).toBe(false);
    expect(showBody.content?.[0]?.text).toContain("FN-2");

    await bridge!.dispose();
  });

  it("returns null when there are no custom tools", async () => {
    expect(await startFusionToolBridge([])).toBeNull();
    expect(await startFusionToolBridge(undefined)).toBeNull();
  });

  it("describes fusion tools in system rules", () => {
    const rules = buildOmpFusionToolRules({ fusionToolCount: 12, operatorMcpCount: 1 });
    expect(rules).toContain("fusion-custom-tools");
    expect(rules).toContain("12");
    expect(rules).toContain("fn_");
    expect(rules).toContain("Operator MCP");
  });
});
