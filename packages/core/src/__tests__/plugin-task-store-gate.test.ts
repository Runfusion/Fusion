import { describe, expect, it, vi } from "vitest";
import {
  PLUGIN_DESTRUCTIVE_TASK_STORE_METHODS,
  PLUGIN_READ_SHAPED_WRITE_METHODS,
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
    getDatabase: vi.fn().mockReturnValue({ raw: "sync-db" }),
    getAsyncLayer: vi.fn().mockReturnValue({ raw: "async-layer" }),
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

  /*
  FNXC:PluginTaskStoreGate 2026-07-26-18:25:
  Hardcoded raw-handle expectations (NOT derived from the denylist constant, so a
  constant regression cannot self-adjust these): the sync getDatabase handle is
  denied (raw SQL around the denylist), while getAsyncLayer deliberately passes
  through — four in-repo plugins depend on it for plugin-scoped schema; the
  residual is documented on the denylist in plugin-task-store-gate.ts.
  */
  it("denies the raw getDatabase handle without a declaration (hardcoded)", () => {
    const raw = makeFakeStore();
    const gated = createPluginGatedTaskStore(raw as unknown as TaskStore, {
      pluginId: "fusion-plugin-test",
    }) as unknown as typeof raw;

    expect(() => gated.getDatabase()).toThrow(
      "Plugin fusion-plugin-test is not permitted to call getDatabase; declare permissions.destructiveTaskOps in the plugin manifest",
    );
    expect(raw.getDatabase).not.toHaveBeenCalled();
  });

  it("keeps getAsyncLayer passing through (documented residual; plugins rely on it)", () => {
    const raw = makeFakeStore();
    const gated = createPluginGatedTaskStore(raw as unknown as TaskStore, {
      pluginId: "fusion-plugin-test",
    }) as unknown as typeof raw;

    expect(gated.getAsyncLayer()).toEqual({ raw: "async-layer" });
  });

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
    /*
    FNXC:PluginTaskStoreGate 2026-08-09-03:04:
    Named with a read prefix on purpose. This test is about `this`-binding, and under deny-by-default
    an arbitrarily-named method is refused before binding is ever reached — so an unprefixed name
    here would make the test fail for a reason that has nothing to do with what it asserts.
    */
    (raw as Record<string, unknown>).getWhoAmI = function (this: unknown) {
      observedThis = this;
      return "ok";
    };
    const gated = createPluginGatedTaskStore(raw as unknown as TaskStore, {
      pluginId: "fusion-plugin-test",
    }) as unknown as Record<string, () => unknown>;

    expect(gated.getWhoAmI()).toBe("ok");
    expect(observedThis).toBe(raw);
    // Bound method identity is stable across property reads.
    expect(gated.getWhoAmI).toBe(gated.getWhoAmI);
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

/*
FNXC:PluginTaskStoreGate 2026-08-09-03:04:
The deny-by-default contract (U5 step 4, R14). The suite above predates it and only proves the 8
named destructive methods are refused — which passed identically when EVERY other method on a
299-method store fell through untouched. These tests pin the inversion itself.
*/
describe("createPluginGatedTaskStore: deny-by-default on the write surface", () => {
  function makeStoreWith(extra: Record<string, unknown>) {
    return { ...makeFakeStore(), ...extra } as unknown as TaskStore;
  }

  it("denies a mutating method that is neither a read nor an allowed write", () => {
    const raw = makeStoreWith({ promoteHeldTask: vi.fn().mockResolvedValue(undefined) });
    const gated = createPluginGatedTaskStore(raw, { pluginId: "fusion-plugin-test" }) as unknown as {
      promoteHeldTask: () => unknown;
    };

    expect(() => gated.promoteHeldTask()).toThrow(/not permitted to call promoteHeldTask/);
    // The underlying method must never run — a denial that still mutates is not a denial.
    expect((raw as unknown as { promoteHeldTask: ReturnType<typeof vi.fn> }).promoteHeldTask).not.toHaveBeenCalled();
  });

  it("allows the writes plugins actually depend on", async () => {
    const calls = {
      createTask: vi.fn().mockResolvedValue({ id: "FN-2" }),
      updateTask: vi.fn().mockResolvedValue({ id: "FN-2" }),
      updateSettings: vi.fn().mockResolvedValue(undefined),
    };
    const gated = createPluginGatedTaskStore(makeStoreWith(calls), {
      pluginId: "fusion-plugin-test",
    }) as unknown as typeof calls;

    await gated.createTask();
    await gated.updateTask();
    await gated.updateSettings();
    expect(calls.createTask).toHaveBeenCalled();
    expect(calls.updateTask).toHaveBeenCalled();
    expect(calls.updateSettings).toHaveBeenCalled();
  });

  it("denies write methods whose names match the read-prefix rule", () => {
    for (const method of PLUGIN_READ_SHAPED_WRITE_METHODS) {
      const raw = makeStoreWith({ [method]: vi.fn().mockResolvedValue(undefined) });
      const gated = createPluginGatedTaskStore(raw, { pluginId: "fusion-plugin-test" }) as unknown as Record<
        string,
        () => unknown
      >;
      expect(() => gated[method]()).toThrow(new RegExp(`not permitted to call ${method}`));
      expect((raw as unknown as Record<string, ReturnType<typeof vi.fn>>)[method]).not.toHaveBeenCalled();
    }
  });

  it("allows reads by verb prefix", async () => {
    const gated = createPluginGatedTaskStore(makeStoreWith({}), {
      pluginId: "fusion-plugin-test",
    }) as unknown as { getTask: (id: string) => Promise<unknown>; getAsyncLayer: () => unknown };

    await expect(gated.getTask("FN-1")).resolves.toEqual({ id: "FN-1", column: "todo" });
    // getAsyncLayer stays reachable by design; four in-repo plugins depend on it. Documented limit.
    expect(gated.getAsyncLayer()).toEqual({ raw: "async-layer" });
  });

  /*
  Declaring destructiveTaskOps used to return the RAW store, so the most privileged plugin class was
  the one class with no deny-by-default at all. It must now widen the destructive set ONLY.
  */
  it("does not hand back an ungated store when destructiveTaskOps is declared", () => {
    const raw = makeStoreWith({ promoteHeldTask: vi.fn() });
    const gated = createPluginGatedTaskStore(raw, {
      pluginId: "fusion-plugin-test",
      permissions: { destructiveTaskOps: true },
    }) as unknown as { promoteHeldTask: () => unknown; deleteTask: () => unknown };

    expect(gated).not.toBe(raw);
    // The declaration buys the destructive methods...
    expect(() => gated.deleteTask()).not.toThrow();
    // ...and nothing else. An undeclared write is still refused.
    expect(() => gated.promoteHeldTask()).toThrow(/not permitted to call promoteHeldTask/);
  });

  /*
  A thenable proxy is a hang, not an error: if `then` returned a function, awaiting anything that
  resolves to this store would recurse into the proxy instead of settling.
  */
  it("never gates `then` or symbol members, so the store stays awaitable and inspectable", async () => {
    const gated = createPluginGatedTaskStore(makeStoreWith({}), { pluginId: "fusion-plugin-test" });

    expect((gated as unknown as { then?: unknown }).then).toBeUndefined();
    await expect(Promise.resolve(gated)).resolves.toBe(gated);
    expect(() => String(gated)).not.toThrow();
  });
});

/*
FNXC:PluginTaskStoreGate 2026-08-14-08:40 (review finding — escapes from the gate, not through it):
Both of these bypass the `get` trap entirely, so no amount of read/write classification catches them.
They are pinned as explicit escape attempts because that is how they were found.
*/
describe("plugin task-store gate: escapes around the get trap", () => {
  it("denies the constructor, which otherwise hands over the unbound prototype methods", () => {
    const deleteTask = vi.fn();
    class RealStore { deleteTask = deleteTask; }
    const gated = createPluginGatedTaskStore(new RealStore() as never, { pluginId: "p" });
    // The escape: store.constructor.prototype.<method>.call(store) never passes through `get`.
    expect(() => (gated as unknown as { constructor: () => void }).constructor()).toThrow(/not permitted/);
  });

  it("refuses assignment, so a denied method cannot be monkey-patched away", () => {
    const gated = createPluginGatedTaskStore({ deleteTask: vi.fn() } as never, { pluginId: "p" });
    expect(() => { (gated as unknown as Record<string, unknown>).deleteTask = () => "pwned"; })
      .toThrow(/read-only as an object/);
    expect(() => { delete (gated as unknown as Record<string, unknown>).createTask; })
      .toThrow(/read-only as an object/);
    expect(() => Object.defineProperty(gated, "createTask", { value: () => "pwned" }))
      .toThrow(/read-only as an object/);
  });

  it("still allows the language to inspect the object", () => {
    const gated = createPluginGatedTaskStore({ getTask: vi.fn() } as never, { pluginId: "p" });
    expect(() => String(gated)).not.toThrow();
    expect(() => JSON.stringify(gated)).not.toThrow();
  });
});
