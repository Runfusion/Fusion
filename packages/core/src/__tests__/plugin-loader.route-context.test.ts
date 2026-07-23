import { describe, it, expect, vi } from "vitest";
import { PluginLoader } from "../plugins/plugin-loader.js";

describe("PluginLoader.createRouteContext", () => {
  it("applies overrides including resolveProjectTaskStore", async () => {
    const pluginStore = {
      getPlugin: vi.fn().mockResolvedValue({ settings: { x: 1 } }),
    } as any;
    const baseStore = { getRootDir: () => "/tmp" } as any;
    const loader = new PluginLoader({ pluginStore, taskStore: baseStore });
    const resolveProjectTaskStore = vi.fn();
    const ctx = await loader.createRouteContext("fusion-plugin-roadmap", {
      taskStore: baseStore,
      settings: { ok: true },
      resolveProjectTaskStore,
    });

    expect(ctx.pluginId).toBe("fusion-plugin-roadmap");
    expect(ctx.settings).toEqual({ ok: true });
    expect(ctx.resolveProjectTaskStore).toBe(resolveProjectTaskStore);
  });
});
