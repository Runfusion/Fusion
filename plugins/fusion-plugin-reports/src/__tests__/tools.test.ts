import { describe, expect, it, vi } from "vitest";
import type { PluginContext, PluginRouteDefinition } from "@fusion/plugin-sdk";
import plugin from "../index.js";
import { createReportTools } from "../tools.js";

function context(): PluginContext {
  return {
    pluginId: "fusion-plugin-reports",
    taskStore: {} as PluginContext["taskStore"],
    settings: {},
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    emitEvent: vi.fn(),
  };
}

describe("report agent tools", () => {
  it("registers project report primitives and prompt vocabulary", () => {
    expect(plugin.tools?.map((tool) => tool.name)).toEqual([
      "reports_list",
      "reports_get",
      "reports_decide",
      "reports_export_html",
    ]);
    expect(plugin.promptContributions?.enabledByDefault).toBe(true);
    expect(plugin.promptContributions?.contributions.map((item) => item.surface)).toEqual([
      "executor-system",
      "executor-task",
    ]);
  });

  it("delegates agent decisions with explicit agent identity and returns the updated entity", async () => {
    const handler = vi.fn(async (request: unknown) => {
      const req = request as { headers: Record<string, string>; body: { note?: string } };
      expect(req.headers).toEqual({ "x-fusion-actor-type": "agent", "x-fusion-user": "agent-reviewer" });
      expect(req.body.note).toBe("ship it");
      return { status: 200, body: { report: { id: "rep_1", status: "approved", approvalState: "approved" } } };
    });
    const routes: PluginRouteDefinition[] = [
      { method: "POST", path: "/reports/:id/approve", handler },
    ];
    const tool = createReportTools(routes).find((candidate) => candidate.name === "reports_decide");

    const result = await tool!.execute({ reportId: "rep_1", action: "approve", actorId: "agent-reviewer", note: "ship it" }, context());

    expect(result.isError).toBe(false);
    expect(result.details).toEqual({
      status: 200,
      body: { report: { id: "rep_1", status: "approved", approvalState: "approved" } },
    });
  });

  it("preserves route authorization failures", async () => {
    const routes: PluginRouteDefinition[] = [
      {
        method: "POST",
        path: "/reports/:id/publish",
        handler: async () => ({ status: 403, body: { error: "unauthorized" } }),
      },
    ];
    const tool = createReportTools(routes).find((candidate) => candidate.name === "reports_decide");

    const result = await tool!.execute({ reportId: "rep_1", action: "publish", actorId: "wrong-agent" }, context());

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe("unauthorized");
    expect(result.details).toEqual({ status: 403, body: { error: "unauthorized" } });
  });
});
