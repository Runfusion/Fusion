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
  evictProjectStore,
  evictAllProjectStores,
} from "../project-store-resolver.js";
import type { TaskStore } from "@fusion/core";

// Mock @fusion/core to control TaskStore.getOrCreateForProject
const createdStores: Array<{
  projectId: string;
  store: TaskStore;
  watchMock: ReturnType<typeof vi.fn>;
  closeMock: ReturnType<typeof vi.fn>;
  stopWatchingMock: ReturnType<typeof vi.fn>;
}> = [];

vi.mock("@fusion/core", async () => {
  const actual = await vi.importActual<typeof import("@fusion/core")>("@fusion/core");
  return {
    ...actual,
    TaskStore: {
      ...actual.TaskStore,
      getOrCreateForProject: vi.fn(async (projectId: string): Promise<TaskStore> => {
        const store = Object.create(EventEmitter.prototype) as TaskStore;
        EventEmitter.call(store as any);
        (store as any).setMaxListeners(100);

        const watchMock = vi.fn(async () => {});
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
      }),
    },
  };
});

describe("project-store-resolver", () => {
  beforeEach(() => {
    evictAllProjectStores();
    createdStores.length = 0;
  });

  afterEach(() => {
    evictAllProjectStores();
    createdStores.length = 0;
  });

  it("creates a new store on first call for a project", async () => {
    const store = await getOrCreateProjectStore("proj_abc");
    expect(store).toBeDefined();
    expect(createdStores).toHaveLength(1);
    expect(createdStores[0].projectId).toBe("proj_abc");
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

    evictProjectStore("proj_evict");

    expect(createdStores[0].stopWatchingMock).toHaveBeenCalledTimes(1);
    expect(createdStores[0].closeMock).toHaveBeenCalledTimes(1);

    // Next call should create a fresh store
    createdStores.length = 0;
    await getOrCreateProjectStore("proj_evict");
    expect(createdStores).toHaveLength(1);
  });

  it("evictAllProjectStores cleans up all cached stores", async () => {
    await getOrCreateProjectStore("proj_a");
    await getOrCreateProjectStore("proj_b");
    await getOrCreateProjectStore("proj_c");

    expect(createdStores).toHaveLength(3);

    evictAllProjectStores();

    for (const entry of createdStores) {
      expect(entry.stopWatchingMock).toHaveBeenCalledTimes(1);
      expect(entry.closeMock).toHaveBeenCalledTimes(1);
    }
  });

  it("evictProjectStore is a no-op for unknown projectIds", () => {
    expect(() => evictProjectStore("nonexistent")).not.toThrow();
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
    sameStore.emit("task:created", { id: "FN-001" });
    sameStore.emit("task:updated", { id: "FN-001", title: "Updated" });

    // SSE listener should have received both events through the shared EventEmitter
    expect(events).toEqual(["created:FN-001", "updated:FN-001"]);
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
    apiStore.emit("task:created", newTask);

    // Simulate task update
    const updatedTask = { ...newTask, title: "Updated title" };
    apiStore.emit("task:updated", updatedTask);

    // Simulate task move
    apiStore.emit("task:moved", { task: updatedTask, from: "triage", to: "todo" });

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
