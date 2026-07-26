import { describe, it, expect, vi } from "vitest";
import { PluginLoader } from "../plugin-loader.js";

describe("PluginLoader.createRouteContext", () => {
  it("applies overrides including resolveProjectTaskStore", async () => {
    const pluginStore = {
      getPlugin: vi.fn().mockResolvedValue({ settings: { x: 1 } }),
    } as any;
    const baseStore = { getRootDir: () => "/tmp" } as any;
    const loader = new PluginLoader({ pluginStore, taskStore: baseStore });
    const projectStore = { getTask: vi.fn().mockResolvedValue({ id: "FN-1" }), deleteTask: vi.fn() } as any;
    const resolveProjectTaskStore = vi.fn().mockResolvedValue(projectStore);
    const ctx = await loader.createRouteContext("fusion-plugin-roadmap", {
      taskStore: baseStore,
      settings: { ok: true },
      resolveProjectTaskStore,
    });

    expect(ctx.pluginId).toBe("fusion-plugin-roadmap");
    expect(ctx.settings).toEqual({ ok: true });
    /*
    FNXC:PluginTaskStoreGate 2026-07-26-13:00:
    resolveProjectTaskStore is no longer passed through by identity: the loader
    wraps it so resolved project stores carry the same destructive-method gate
    as ctx.taskStore. Assert delegation + gating behavior instead of identity.
    */
    expect(ctx.resolveProjectTaskStore).toBeDefined();
    const resolved = await ctx.resolveProjectTaskStore!("proj-1");
    expect(resolveProjectTaskStore).toHaveBeenCalledWith("proj-1");
    await expect(resolved.getTask("FN-1")).resolves.toEqual({ id: "FN-1" });
    expect(() => resolved.deleteTask("FN-1")).toThrow(
      "not permitted to call deleteTask",
    );
    expect(projectStore.deleteTask).not.toHaveBeenCalled();
  });
});
