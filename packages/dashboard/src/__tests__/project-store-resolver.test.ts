/**
 * Regression tests for project-scoped real-time SSE delivery (FN-758).
 *
 * Validates that:
 * 1. The shared project-store resolver reuses the same TaskStore instance
 * 2. No duplicate watch() calls or listeners are stacked
 * 3. Eviction properly cleans up
 * 4. SSE streams receive live events from the same store instance used for mutations
 */

import { EventEmitter } from "node:events";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getOrCreateProjectStore,
  countRunningAgentsInRegisteredProjectStores,
  countRunningAgentsInStore,
  evictProjectStore,
  evictAllProjectStores,
  listRegisteredProjectStores,
  onProjectStoreRegistered,
  setOnProjectFirstCreated,
} from "../project-store-resolver.js";
import type { TaskStore } from "@fusion/core";

// Mock @fusion/core to control the PostgreSQL TaskStore startup factory.
const createdStores: Array<{
  projectId: string;
  store: TaskStore;
  watchMock: ReturnType<typeof vi.fn>;
  closeMock: ReturnType<typeof vi.fn>;
  stopWatchingMock: ReturnType<typeof vi.fn>;
}> = [];
const backendShutdowns = new Map<string, ReturnType<typeof vi.fn>>();
let watchFailureProjectId: string | undefined;
let delayedWatchProjectId: string | undefined;
let releaseDelayedWatch: (() => void) | undefined;
const delayedShutdownProjectIds = new Set<string>();
const releaseDelayedShutdowns = new Map<string, () => void>();

vi.mock("@fusion/core", async () => {
  const actual = await vi.importActual<typeof import("@fusion/core")>("@fusion/core");
  const makeStore = (projectId: string): TaskStore => {
    const store = Object.create(EventEmitter.prototype) as TaskStore;
    EventEmitter.call(store as any);
    (store as any).setMaxListeners(100);

    const watchMock = vi.fn(async () => {
      if (projectId === watchFailureProjectId) throw new Error("watch failed");
      if (projectId === delayedWatchProjectId) {
        await new Promise<void>((resolve) => { releaseDelayedWatch = resolve; });
      }
    });
    const closeMock = vi.fn(() => {});
    const stopWatchingMock = vi.fn(() => {});

    const entry = { projectId, store, watchMock, closeMock, stopWatchingMock };

    // Minimal store interface
    (store as any).init = vi.fn(async () => {});
    (store as any).watch = watchMock;
    (store as any).close = closeMock;
    (store as any).stopWatching = stopWatchingMock;
    (store as any).getMissionStore = vi.fn(() => ({
      on: vi.fn(),
      off: vi.fn(),
    }));

    createdStores.push(entry);
    return store;
  };
  return {
    ...actual,
    /*
    FNXC:PostgresCutover 2026-07-05-17:00:
    The resolver uses createTaskStoreForBackend exclusively; mock it at that
    seam so cache/dedup/eviction/SSE invariants do not boot a real cluster.
    */
    createTaskStoreForBackend: vi.fn(async ({ projectId }: { projectId: string }) => {
      const shutdown = vi.fn(async () => {
        if (delayedShutdownProjectIds.has(projectId)) {
          await new Promise<void>((resolve) => {
            releaseDelayedShutdowns.set(projectId, resolve);
          });
        }
      });
      backendShutdowns.set(projectId, shutdown);
      return { taskStore: makeStore(projectId), shutdown };
    }),
  };
});

describe("project-store-resolver", () => {
  beforeEach(async () => {
    delayedShutdownProjectIds.clear();
    for (const release of releaseDelayedShutdowns.values()) release();
    await evictAllProjectStores();
    createdStores.length = 0;
    backendShutdowns.clear();
    watchFailureProjectId = undefined;
    delayedWatchProjectId = undefined;
    releaseDelayedWatch = undefined;
    delayedShutdownProjectIds.clear();
    releaseDelayedShutdowns.clear();
  });

  afterEach(async () => {
    delayedShutdownProjectIds.clear();
    for (const release of releaseDelayedShutdowns.values()) release();
    await evictAllProjectStores();
    createdStores.length = 0;
    backendShutdowns.clear();
    watchFailureProjectId = undefined;
    delayedWatchProjectId = undefined;
    releaseDelayedWatch = undefined;
    delayedShutdownProjectIds.clear();
    releaseDelayedShutdowns.clear();
  });

  it("creates a new store on first call for a project", async () => {
    const store = await getOrCreateProjectStore("proj_abc");
    expect(store).toBeDefined();
    expect(createdStores).toHaveLength(1);
    expect(createdStores[0].projectId).toBe("proj_abc");
  });

  it("lists registered stores", async () => {
    const storeA = await getOrCreateProjectStore("proj_list_a");
    const storeB = await getOrCreateProjectStore("proj_list_b");

    const registered = listRegisteredProjectStores();
    expect(registered).toEqual(expect.arrayContaining([
      { projectId: "proj_list_a", store: storeA },
      { projectId: "proj_list_b", store: storeB },
    ]));
  });

  it("notifies on project store registration", async () => {
    const listener = vi.fn();
    const unsubscribe = onProjectStoreRegistered(listener);

    const store = await getOrCreateProjectStore("proj_listener");
    expect(listener).toHaveBeenCalledWith("proj_listener", store);

    unsubscribe();
    await getOrCreateProjectStore("proj_listener_2");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("reuses the same TaskStore instance for repeated calls with the same projectId", async () => {
    const store1 = await getOrCreateProjectStore("proj_abc");
    const store2 = await getOrCreateProjectStore("proj_abc");
    const store3 = await getOrCreateProjectStore("proj_abc");

    // Same instance returned every time
    expect(store1).toBe(store2);
    expect(store2).toBe(store3);

    // Only one store was created
    expect(createdStores).toHaveLength(1);
  });

  it("deduplicates concurrent calls — concurrent SSE + API route requests share one store", async () => {
    // Simulate the race: SSE endpoint and an API mutation both call
    // getOrCreateProjectStore before either has set the cache.
    const [store1, store2, store3] = await Promise.all([
      getOrCreateProjectStore("proj_concurrent"),
      getOrCreateProjectStore("proj_concurrent"),
      getOrCreateProjectStore("proj_concurrent"),
    ]);

    // All callers must receive the same instance so SSE and mutations share an EventEmitter
    expect(store1).toBe(store2);
    expect(store2).toBe(store3);

    // Only one underlying store should have been created
    expect(createdStores).toHaveLength(1);
    // watch() called exactly once
    expect(createdStores[0].watchMock).toHaveBeenCalledTimes(1);
  });

  it("creates separate stores for different projectIds", async () => {
    const storeA = await getOrCreateProjectStore("proj_alpha");
    const storeB = await getOrCreateProjectStore("proj_beta");

    expect(storeA).not.toBe(storeB);
    expect(createdStores).toHaveLength(2);
    expect(createdStores[0].projectId).toBe("proj_alpha");
    expect(createdStores[1].projectId).toBe("proj_beta");
  });

  it("calls watch() exactly once per project store", async () => {
    await getOrCreateProjectStore("proj_once");
    await getOrCreateProjectStore("proj_once");
    await getOrCreateProjectStore("proj_once");

    expect(createdStores).toHaveLength(1);
    expect(createdStores[0].watchMock).toHaveBeenCalledTimes(1);
  });

  it("shuts down a factory backend when watcher startup fails", async () => {
    watchFailureProjectId = "proj_watch_failure";
    await expect(getOrCreateProjectStore("proj_watch_failure")).rejects.toThrow("watch failed");
    expect(backendShutdowns.get("proj_watch_failure")).toHaveBeenCalledTimes(1);
    expect(listRegisteredProjectStores()).not.toContainEqual(expect.objectContaining({ projectId: "proj_watch_failure" }));
  });

  it("does not stack duplicate watch() calls on repeated lookups", async () => {
    for (let i = 0; i < 10; i++) {
      await getOrCreateProjectStore("proj_repeat");
    }

    expect(createdStores).toHaveLength(1);
    expect(createdStores[0].watchMock).toHaveBeenCalledTimes(1);
  });

  it("evictProjectStore stops watching and closes the store", async () => {
    await getOrCreateProjectStore("proj_evict");
    expect(createdStores).toHaveLength(1);

    await evictProjectStore("proj_evict");

    expect(createdStores[0].stopWatchingMock).toHaveBeenCalledTimes(1);
    expect(createdStores[0].closeMock).toHaveBeenCalledTimes(1);

    // Next call should create a fresh store
    createdStores.length = 0;
    await getOrCreateProjectStore("proj_evict");
    expect(createdStores).toHaveLength(1);
  });

  it("deduplicates overlapping project evictions until the owned shutdown finishes", async () => {
    /*
    FNXC:PostgresResourceLifecycle 2026-07-14-21:35:
    Every caller that evicts one project must await the owner of its backend shutdown, and project recreation must remain blocked until that shared barrier settles.
    */
    await getOrCreateProjectStore("proj_overlapping_evict");
    delayedShutdownProjectIds.add("proj_overlapping_evict");

    const firstEviction = evictProjectStore("proj_overlapping_evict");
    await vi.waitFor(() => expect(releaseDelayedShutdowns.has("proj_overlapping_evict")).toBe(true));
    const secondEviction = evictProjectStore("proj_overlapping_evict");
    let secondSettled = false;
    void secondEviction.then(() => { secondSettled = true; });
    await Promise.resolve();

    expect(secondSettled).toBe(false);
    await expect(getOrCreateProjectStore("proj_overlapping_evict")).rejects.toThrow("shutting down");
    expect(backendShutdowns.get("proj_overlapping_evict")).toHaveBeenCalledTimes(1);

    releaseDelayedShutdowns.get("proj_overlapping_evict")?.();
    await Promise.all([firstEviction, secondEviction]);
    delayedShutdownProjectIds.delete("proj_overlapping_evict");
    await expect(getOrCreateProjectStore("proj_overlapping_evict")).resolves.toBeDefined();
  });

  it("keeps global eviction blocked behind an overlapping project shutdown", async () => {
    /*
    FNXC:PostgresResourceLifecycle 2026-07-14-21:35:
    Evict-all must join an already-owned project cleanup rather than completing after an empty duplicate cleanup and reopening creation while the original shutdown remains pending.
    */
    await getOrCreateProjectStore("proj_project_then_all");
    delayedShutdownProjectIds.add("proj_project_then_all");

    const projectEviction = evictProjectStore("proj_project_then_all");
    await vi.waitFor(() => expect(releaseDelayedShutdowns.has("proj_project_then_all")).toBe(true));
    const globalEviction = evictAllProjectStores();
    let globalSettled = false;
    void globalEviction.then(() => { globalSettled = true; });
    await Promise.resolve();

    expect(globalSettled).toBe(false);
    await expect(getOrCreateProjectStore("proj_project_then_all")).rejects.toThrow("shutting down");
    expect(backendShutdowns.get("proj_project_then_all")).toHaveBeenCalledTimes(1);

    releaseDelayedShutdowns.get("proj_project_then_all")?.();
    await Promise.all([projectEviction, globalEviction]);
    delayedShutdownProjectIds.delete("proj_project_then_all");
    await expect(getOrCreateProjectStore("proj_project_then_all")).resolves.toBeDefined();
  });

  it("makes a project eviction join an overlapping evict-all shutdown", async () => {
    /*
    FNXC:PostgresResourceLifecycle 2026-07-14-21:42:
    A project-specific caller arriving after evict-all owns that project's cleanup must join the same barrier instead of reporting completion before backend shutdown finishes.
    */
    await getOrCreateProjectStore("proj_all_then_project");
    delayedShutdownProjectIds.add("proj_all_then_project");

    const globalEviction = evictAllProjectStores();
    await vi.waitFor(() => expect(releaseDelayedShutdowns.has("proj_all_then_project")).toBe(true));
    const projectEviction = evictProjectStore("proj_all_then_project");
    let projectSettled = false;
    void projectEviction.then(() => { projectSettled = true; });
    await Promise.resolve();

    expect(projectSettled).toBe(false);
    await expect(getOrCreateProjectStore("proj_all_then_project")).rejects.toThrow("shutting down");
    expect(backendShutdowns.get("proj_all_then_project")).toHaveBeenCalledTimes(1);

    releaseDelayedShutdowns.get("proj_all_then_project")?.();
    await Promise.all([globalEviction, projectEviction]);
  });

  it("evictAllProjectStores cleans up all cached stores", async () => {
    await getOrCreateProjectStore("proj_a");
    await getOrCreateProjectStore("proj_b");
    await getOrCreateProjectStore("proj_c");

    expect(createdStores).toHaveLength(3);

    await evictAllProjectStores();

    for (const entry of createdStores) {
      expect(entry.stopWatchingMock).toHaveBeenCalledTimes(1);
      expect(entry.closeMock).toHaveBeenCalledTimes(1);
    }
  });

  it("awaits an in-flight creation and closes it without a late cache insertion", async () => {
    delayedWatchProjectId = "proj_late";
    const creation = getOrCreateProjectStore("proj_late");
    await vi.waitFor(() => expect(releaseDelayedWatch).toBeTypeOf("function"));

    const eviction = evictAllProjectStores();
    releaseDelayedWatch?.();

    await expect(creation).rejects.toThrow("evicted during creation");
    await eviction;
    expect(listRegisteredProjectStores()).not.toContainEqual(expect.objectContaining({ projectId: "proj_late" }));
    expect(backendShutdowns.get("proj_late")).toHaveBeenCalledTimes(1);
    expect(createdStores[0].closeMock).toHaveBeenCalledTimes(1);
  });

  it("evictProjectStore is a no-op for unknown projectIds", async () => {
    await expect(evictProjectStore("nonexistent")).resolves.toBeUndefined();
  });

  it("shared store receives events from both SSE and API route context", async () => {
    const store = await getOrCreateProjectStore("proj_events");

    // Simulate an SSE listener attaching to the store's EventEmitter
    const events: string[] = [];
    store.on("task:created", (task: any) => {
      events.push(`created:${task.id}`);
    });
    store.on("task:updated", (task: any) => {
      events.push(`updated:${task.id}`);
    });

    // Simulate the same store being used for a mutation (like getScopedStore)
    const sameStore = await getOrCreateProjectStore("proj_events");
    expect(sameStore).toBe(store);

    // Emit events from "mutation path" — same store instance
    sameStore.emit("task:created", { id: "FN-001" } as any);
    sameStore.emit("task:updated", { id: "FN-001", title: "Updated" } as any);

    // SSE listener should have received both events through the shared EventEmitter
    expect(events).toEqual(["created:FN-001", "updated:FN-001"]);
  });

  describe("setOnProjectFirstCreated", () => {
    afterEach(() => {
      // Always clear the callback so it doesn't bleed into other tests
      setOnProjectFirstCreated(undefined);
    });

    it("fires callback once when a new project store is first created", async () => {
      const cb = vi.fn();
      setOnProjectFirstCreated(cb);

      await getOrCreateProjectStore("proj_cb_new");

      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb).toHaveBeenCalledWith("proj_cb_new");
    });

    it("does not fire callback on subsequent cache hits for the same project", async () => {
      const cb = vi.fn();
      setOnProjectFirstCreated(cb);

      await getOrCreateProjectStore("proj_cb_cached");
      await getOrCreateProjectStore("proj_cb_cached");
      await getOrCreateProjectStore("proj_cb_cached");

      expect(cb).toHaveBeenCalledTimes(1);
    });

    it("fires callback once per unique project (any number of projects)", async () => {
      const cb = vi.fn();
      setOnProjectFirstCreated(cb);

      // Use sequential awaits to avoid concurrent import() race in vitest mock resolution
      await getOrCreateProjectStore("proj_multi_1");
      await getOrCreateProjectStore("proj_multi_2");
      await getOrCreateProjectStore("proj_multi_3");
      await getOrCreateProjectStore("proj_multi_4");
      await getOrCreateProjectStore("proj_multi_5");

      expect(cb).toHaveBeenCalledTimes(5);
      expect(cb).toHaveBeenCalledWith("proj_multi_1");
      expect(cb).toHaveBeenCalledWith("proj_multi_2");
      expect(cb).toHaveBeenCalledWith("proj_multi_3");
      expect(cb).toHaveBeenCalledWith("proj_multi_4");
      expect(cb).toHaveBeenCalledWith("proj_multi_5");
    });

    it("deduplicates concurrent calls — callback fires exactly once even under concurrency", async () => {
      const cb = vi.fn();
      setOnProjectFirstCreated(cb);

      await Promise.all([
        getOrCreateProjectStore("proj_concurrent_cb"),
        getOrCreateProjectStore("proj_concurrent_cb"),
        getOrCreateProjectStore("proj_concurrent_cb"),
      ]);

      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb).toHaveBeenCalledWith("proj_concurrent_cb");
    });

    it("stops firing after callback is cleared with undefined", async () => {
      const cb = vi.fn();
      setOnProjectFirstCreated(cb);
      setOnProjectFirstCreated(undefined);

      await getOrCreateProjectStore("proj_cb_cleared");

      expect(cb).not.toHaveBeenCalled();
    });

    it("fires for a re-created project after eviction", async () => {
      const cb = vi.fn();
      setOnProjectFirstCreated(cb);

      await getOrCreateProjectStore("proj_cb_evict");
      expect(cb).toHaveBeenCalledTimes(1);

      await evictProjectStore("proj_cb_evict");
      createdStores.length = 0;

      await getOrCreateProjectStore("proj_cb_evict");
      expect(cb).toHaveBeenCalledTimes(2);
    });
  });

  it("SSE stream receives live events via shared store (integration)", async () => {
    // This test simulates the full server-side path:
    // 1. SSE handler calls getOrCreateProjectStore("proj_sse") → store A
    // 2. Task mutation route calls getOrCreateProjectStore("proj_sse") → same store A
    // 3. Task mutation emits event on store A
    // 4. SSE listener (attached to store A) receives the event

    const sseStore = await getOrCreateProjectStore("proj_sse");

    // Collect SSE messages (simulates createSSE attaching listeners)
    const sseMessages: string[] = [];
    sseStore.on("task:created", (task: any) => {
      sseMessages.push(`event: task:created\ndata: ${JSON.stringify(task)}\n\n`);
    });
    sseStore.on("task:updated", (task: any) => {
      sseMessages.push(`event: task:updated\ndata: ${JSON.stringify(task)}\n\n`);
    });
    sseStore.on("task:moved", (data: any) => {
      sseMessages.push(`event: task:moved\ndata: ${JSON.stringify(data)}\n\n`);
    });

    // Simulate API route handler using the same resolver
    const apiStore = await getOrCreateProjectStore("proj_sse");
    expect(apiStore).toBe(sseStore);

    // Simulate task creation via API (this is what routes.ts does)
    const newTask = { id: "FN-100", description: "Integration test task" };
    apiStore.emit("task:created", newTask as any);

    // Simulate task update
    const updatedTask = { ...newTask, title: "Updated title" };
    apiStore.emit("task:updated", updatedTask as any);

    // Simulate task move
    apiStore.emit("task:moved", { task: updatedTask as any, from: "triage", to: "todo" });

    // Assert SSE listener received all events in order
    expect(sseMessages).toHaveLength(3);
    expect(sseMessages[0]).toContain("task:created");
    expect(sseMessages[0]).toContain("FN-100");
    expect(sseMessages[1]).toContain("task:updated");
    expect(sseMessages[1]).toContain("Updated title");
    expect(sseMessages[2]).toContain("task:moved");
    expect(sseMessages[2]).toContain('"to":"todo"');
  });
});

describe("countRunningAgentsInRegisteredProjectStores", () => {
  beforeEach(async () => {
    await evictAllProjectStores();
    createdStores.length = 0;
  });

  afterEach(async () => {
    await evictAllProjectStores();
    createdStores.length = 0;
  });

  type SeedTask = {
    column: string;
    status?: string;
    paused?: boolean;
  };

  function installTaskList(store: TaskStore, seedTasks: Array<string | SeedTask>) {
    const tasks = seedTasks.map((seedTask, index) => (
      typeof seedTask === "string"
        ? { id: `FN-${index + 1}`, column: seedTask }
        : { id: `FN-${index + 1}`, ...seedTask }
    ));
    const listTasks = vi.fn().mockImplementation(async (options?: { column?: string }) => (
      options?.column ? tasks.filter((task) => task.column === options.column) : tasks
    ));
    (store as TaskStore & { listTasks: typeof listTasks }).listTasks = listTasks;
    return listTasks;
  }

  it("counts in-progress tasks from already-open stores without opening unopened projects", async () => {
    const openStore = await getOrCreateProjectStore("proj_open");
    const listTasks = installTaskList(openStore, ["todo", "in-progress", "in-progress", "done"]);
    const openEntry = createdStores.find((entry) => entry.projectId === "proj_open");
    expect(openEntry).toBeDefined();
    vi.clearAllMocks();

    const counts = await countRunningAgentsInRegisteredProjectStores(["proj_open", "proj_unopened"]);

    expect(counts).toEqual({ proj_open: 2 });
    expect(listTasks).toHaveBeenCalledWith({ slim: true });
    expect(createdStores).toHaveLength(1);
    expect(openEntry?.watchMock).not.toHaveBeenCalled();
  });

  it("excludes cached stores that are not requested and reports zero for open stores with no running tasks", async () => {
    const zeroStore = await getOrCreateProjectStore("proj_zero");
    const ignoredStore = await getOrCreateProjectStore("proj_ignored");
    const zeroListTasks = installTaskList(zeroStore, ["todo", "in-review", "done"]);
    const ignoredListTasks = installTaskList(ignoredStore, ["in-progress", "in-progress"]);
    const zeroEntry = createdStores.find((entry) => entry.projectId === "proj_zero");
    const ignoredEntry = createdStores.find((entry) => entry.projectId === "proj_ignored");
    vi.clearAllMocks();

    const counts = await countRunningAgentsInRegisteredProjectStores(["proj_zero", "proj_unopened"]);

    expect(counts).toEqual({ proj_zero: 0 });
    expect(zeroListTasks).toHaveBeenCalledWith({ slim: true });
    expect(ignoredListTasks).not.toHaveBeenCalled();
    expect(createdStores).toHaveLength(2);
    expect(zeroEntry?.watchMock).not.toHaveBeenCalled();
    expect(ignoredEntry?.watchMock).not.toHaveBeenCalled();
  });

  it("returns per-project counts for multiple already-open stores", async () => {
    const storeA = await getOrCreateProjectStore("proj_a");
    const storeB = await getOrCreateProjectStore("proj_b");
    const listTasksA = installTaskList(storeA, ["in-progress", "todo"]);
    const listTasksB = installTaskList(storeB, ["todo", "in-progress", "in-progress"]);
    vi.clearAllMocks();

    const counts = await countRunningAgentsInRegisteredProjectStores(["proj_a", "proj_b"]);

    expect(counts).toEqual({ proj_a: 1, proj_b: 2 });
    expect(listTasksA).toHaveBeenCalledWith({ slim: true });
    expect(listTasksB).toHaveBeenCalledWith({ slim: true });
    expect(createdStores).toHaveLength(2);
  });

  it("counts an actively triaging planning task even when no executors are running", async () => {
    const store = await getOrCreateProjectStore("proj_triage_only");
    const listTasks = installTaskList(store, [
      { column: "triage", status: "planning" },
      "todo",
    ]);

    await expect(countRunningAgentsInStore(store)).resolves.toBe(1);
    expect(listTasks).toHaveBeenCalledWith({ slim: true });
  });

  it("sums in-progress executors, active triage agents, and active in-review agents while excluding inactive states", async () => {
    const store = await getOrCreateProjectStore("proj_mixed");
    installTaskList(store, [
      "in-progress",
      { column: "triage", status: "planning" },
      { column: "triage", status: "planning", paused: true },
      { column: "triage", status: "triaged" },
      { column: "triage" },
      { column: "in-review", status: "reviewing", paused: false },
      { column: "in-review", status: "merging", paused: false },
      { column: "in-review", status: "merging-pr", paused: false },
      { column: "in-review", status: "merging-fix", paused: false },
      { column: "in-review", status: "fixing", paused: false },
      { column: "in-review", status: "reviewing", paused: true },
      { column: "in-review", status: "pending", paused: false },
      "todo",
    ]);

    await expect(countRunningAgentsInStore(store)).resolves.toBe(7);
  });

  it("returns per-project active triage, in-review, and executor counts for multiple already-open stores", async () => {
    const storeA = await getOrCreateProjectStore("proj_triage_a");
    const storeB = await getOrCreateProjectStore("proj_triage_b");
    const listTasksA = installTaskList(storeA, [
      "in-progress",
      { column: "triage", status: "planning" },
      { column: "triage", status: "waiting" },
    ]);
    const listTasksB = installTaskList(storeB, [
      { column: "triage", status: "planning" },
      { column: "triage", status: "planning" },
      { column: "triage", status: "planning", paused: true },
      { column: "in-review", status: "fixing", paused: false },
      { column: "in-review", status: "merging-fix", paused: false },
      { column: "in-review", status: "merging", paused: true },
      "done",
    ]);
    vi.clearAllMocks();

    const counts = await countRunningAgentsInRegisteredProjectStores(["proj_triage_a", "proj_triage_b"]);

    expect(counts).toEqual({ proj_triage_a: 2, proj_triage_b: 4 });
    expect(Object.values(counts).reduce((sum, count) => sum + count, 0)).toBe(6);
    expect(listTasksA).toHaveBeenCalledWith({ slim: true });
    expect(listTasksB).toHaveBeenCalledWith({ slim: true });
    expect(createdStores).toHaveLength(2);
  });
});
