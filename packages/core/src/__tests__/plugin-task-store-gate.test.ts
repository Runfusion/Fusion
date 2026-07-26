import { describe, expect, it, vi } from "vitest";
import {
  PLUGIN_DESTRUCTIVE_TASK_STORE_METHODS,
  createPluginGatedTaskStore,
} from "../plugin-task-store-gate.js";
import type { TaskStore } from "../store.js";

/*
FNXC:PluginTaskStoreGate 2026-07-26-12:20:
Plugins must not be able to delete/bypass/bulk-archive tasks unless their manifest
declares permissions.destructiveTaskOps. These tests exercise the gate through a
fake plugin-context store: denylisted call without declaration throws, with
declaration passes through, and non-destructive methods are unaffected.
*/

function makeFakeStore() {
  return {
    deleteTask: vi.fn().mockResolvedValue({ id: "FN-1" }),
    deleteTaskIf: vi.fn().mockResolvedValue({ id: "FN-1" }),
    deleteTaskById: vi.fn().mockResolvedValue(undefined),
    deleteTaskBackend: vi.fn().mockResolvedValue(undefined),
    bypassFailedPreMergeReviewStep: vi.fn().mockResolvedValue({ id: "FN-1" }),
    archiveAllDone: vi.fn().mockResolvedValue([]),
    cleanupArchivedTasks: vi.fn().mockResolvedValue(0),
    getTask: vi.fn().mockResolvedValue({ id: "FN-1", column: "todo" }),
    moveTask: vi.fn().mockResolvedValue({ id: "FN-1", column: "todo" }),
    someCounter: 7,
  };
}

describe("createPluginGatedTaskStore", () => {
  it.each(PLUGIN_DESTRUCTIVE_TASK_STORE_METHODS)(
    "throws for %s without a destructiveTaskOps declaration",
    (method) => {
      const raw = makeFakeStore();
      const gated = createPluginGatedTaskStore(raw as unknown as TaskStore, {
        pluginId: "fusion-plugin-test",
      }) as unknown as Record<string, (...args: unknown[]) => unknown>;

      expect(() => gated[method]("FN-1")).toThrow(
        `Plugin fusion-plugin-test is not permitted to call ${method}; ` +
          `declare permissions.destructiveTaskOps in the plugin manifest`,
      );
      expect((raw as unknown as Record<string, ReturnType<typeof vi.fn>>)[method]).not.toHaveBeenCalled();
    },
  );

  it("passes destructive calls through when the manifest declares destructiveTaskOps", async () => {
    const raw = makeFakeStore();
    const gated = createPluginGatedTaskStore(raw as unknown as TaskStore, {
      pluginId: "fusion-plugin-test",
      permissions: { destructiveTaskOps: true },
    }) as unknown as typeof raw;

    await gated.deleteTask("FN-1");
    await gated.archiveAllDone();
    expect(raw.deleteTask).toHaveBeenCalledWith("FN-1");
    expect(raw.archiveAllDone).toHaveBeenCalledOnce();
  });

  it("leaves non-destructive methods and plain properties untouched", async () => {
    const raw = makeFakeStore();
    const gated = createPluginGatedTaskStore(raw as unknown as TaskStore, {
      pluginId: "fusion-plugin-test",
    }) as unknown as typeof raw;

    await expect(gated.getTask("FN-1")).resolves.toEqual({ id: "FN-1", column: "todo" });
    await gated.moveTask("FN-1", "todo");
    expect(raw.moveTask).toHaveBeenCalledWith("FN-1", "todo");
    expect(gated.someCounter).toBe(7);
  });

  it("binds pass-through methods to the raw store so store-identity seams survive", async () => {
    const raw = makeFakeStore();
    let observedThis: unknown;
    (raw as Record<string, unknown>).whoAmI = function (this: unknown) {
      observedThis = this;
      return "ok";
    };
    const gated = createPluginGatedTaskStore(raw as unknown as TaskStore, {
      pluginId: "fusion-plugin-test",
    }) as unknown as Record<string, () => unknown>;

    expect(gated.whoAmI()).toBe("ok");
    expect(observedThis).toBe(raw);
    // Bound method identity is stable across property reads.
    expect(gated.whoAmI).toBe(gated.whoAmI);
  });

  it("rejects when a denylisted method is awaited", async () => {
    const raw = makeFakeStore();
    const gated = createPluginGatedTaskStore(raw as unknown as TaskStore, {
      pluginId: "fusion-plugin-test",
    }) as unknown as typeof raw;

    await expect(async () => gated.bypassFailedPreMergeReviewStep("FN-1")).rejects.toThrow(
      "not permitted to call bypassFailedPreMergeReviewStep",
    );
  });
});
