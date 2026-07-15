import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@fusion/plugin-sdk";
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
      "reports_export_html",
    ]);
    expect(plugin.promptContributions?.enabledByDefault).toBe(true);
    expect(plugin.promptContributions?.contributions.map((item) => item.surface)).toEqual([
      "executor-system",
      "executor-task",
    ]);
  });

  it("does not expose privileged decisions without a host-authenticated tool principal", () => {
    const tools = createReportTools();
    expect(tools.some((tool) => tool.name === "reports_decide")).toBe(false);
    expect(JSON.stringify(tools)).not.toContain("actorId");
  });
});
