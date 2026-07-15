import { describe, expect, it, vi } from "vitest";
import type { PluginContext, PluginRouteDefinition } from "@fusion/plugin-sdk";
import plugin from "../index.js";
import { createCliPrintingPressTools } from "../tools.js";

function context(): PluginContext {
  return {
    pluginId: "fusion-plugin-cli-printing-press",
    taskStore: {} as PluginContext["taskStore"],
    settings: {},
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    emitEvent: vi.fn(),
  };
}

describe("CLI Printing Press agent tools", () => {
  it("registers validated CRUD, generation, test primitives, and prompt vocabulary", () => {
    expect(plugin.tools?.map((tool) => tool.name)).toEqual([
      "cli_press_list",
      "cli_press_get",
      "cli_press_create",
      "cli_press_update",
      "cli_press_delete",
      "cli_press_generate",
      "cli_press_test",
    ]);
    expect(plugin.promptContributions?.enabledByDefault).toBe(true);
    expect(plugin.promptContributions?.contributions.map((item) => item.surface)).toEqual([
      "executor-system",
      "executor-task",
    ]);
  });

  it("passes the complete definition through the existing create route and returns its entity", async () => {
    const draft = { id: "svc_1", name: "Weather", slug: "weather", endpoints: [] };
    const handler = vi.fn(async (request: unknown) => {
      expect(request).toEqual({ params: {}, body: draft });
      return { status: 201, body: { ...draft, status: "draft" } };
    });
    const routes: PluginRouteDefinition[] = [{ method: "POST", path: "/drafts", handler }];
    const tool = createCliPrintingPressTools(routes).find((candidate) => candidate.name === "cli_press_create");

    const result = await tool!.execute({ draft }, context());

    expect(result.isError).toBe(false);
    expect(result.details).toEqual({ status: 201, body: { ...draft, status: "draft" } });
  });

  it("delegates bounded test inputs and preserves validation failures", async () => {
    const handler = vi.fn(async (request: unknown) => {
      expect(request).toEqual({
        params: { id: "svc_1" },
        body: { endpointId: "forecast", params: { days: 3 }, credentials: undefined, timeoutMs: 5000 },
      });
      return { status: 409, body: { error: "Draft has not been generated yet" } };
    });
    const routes: PluginRouteDefinition[] = [{ method: "POST", path: "/drafts/:id/run", handler }];
    const tool = createCliPrintingPressTools(routes).find((candidate) => candidate.name === "cli_press_test");

    const result = await tool!.execute({ id: "svc_1", endpointId: "forecast", params: { days: 3 }, timeoutMs: 5000 }, context());

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe("Draft has not been generated yet");
    expect(result.details).toEqual({ status: 409, body: { error: "Draft has not been generated yet" } });
  });
});
