import { describe, expect, it, vi } from "vitest";
import { SelfHealingManager } from "../self-healing.js";

/*
FNXC:WorkflowBatchCacheEpoch 2026-10-11-19:34 (RUFU-584, operator directive to eliminate the leak):
Retained heap was measured as suspended async frames holding materialized Task batches, caused by 15
per-sweep workflow caches in this manager: one card inspected by 15 sweeps cost 15 selection reads and
15 definition reads on a 3-lane pool per store, and every queued read pinned its caller's batch.
These assertions pin the manager-level mechanism that replaced them - one epoch-guarded cache pair per
pass - because the read collapse itself is covered in @fusion/core's epoched-workflow-pass-cache test.
The pass boundary is asserted too: without it a long-lived manager would trade the leak for a
board-sized map that never shrinks.
*/

function makeStore() {
  let selectionEpoch = 0;
  let definitionEpoch = 0;
  return {
    getTask: vi.fn(async () => null),
    getSettings: vi.fn(async () => ({})),
    recordRunAuditEvent: vi.fn(async () => undefined),
    logEntry: vi.fn(async () => undefined),
    workflowSelectionEpoch: () => selectionEpoch,
    workflowDefinitionEpoch: () => definitionEpoch,
    bumpWorkflowSelectionEpoch: () => { selectionEpoch += 1; },
    bumpWorkflowDefinitionEpoch: () => { definitionEpoch += 1; },
  };
}

describe("self-healing pass-scoped workflow caches", () => {
  it("serves every sweep from one cache object instead of one per sweep", () => {
    const store = makeStore();
    const manager = new SelfHealingManager(store as never, { rootDir: process.cwd() });

    const irFirst = manager.batchWorkflowIrCache();
    const selectionFirst = manager.batchWorkflowSelectionCache();
    // Two later sweeps ask for "their" cache: they must join the same object, or reads duplicate again.
    expect(manager.batchWorkflowIrCache()).toBe(irFirst);
    expect(manager.batchWorkflowSelectionCache()).toBe(selectionFirst);
  });

  it("discards the shared selection cache when the store reports a selection write", () => {
    const store = makeStore();
    const manager = new SelfHealingManager(store as never, { rootDir: process.cwd() });
    const selectionCache = manager.batchWorkflowSelectionCache();

    selectionCache.set("T1", { taskId: "T1", workflowId: "wf-a", stepIds: [] });
    expect(selectionCache.has("T1")).toBe(true);

    store.bumpWorkflowSelectionEpoch();

    expect(selectionCache.has("T1")).toBe(false);
    // A stale definition must not be dragged along by an unrelated selection edit.
    const irCache = manager.batchWorkflowIrCache();
    irCache.set("wf-a\u0000p", {} as never);
    store.bumpWorkflowSelectionEpoch();
    expect(irCache.has("wf-a\u0000p")).toBe(true);
  });

  it("starts a fresh cache pair at each pass so cache memory stays bounded", () => {
    const store = makeStore();
    const manager = new SelfHealingManager(store as never, { rootDir: process.cwd() });
    const before = manager.batchWorkflowIrCache();
    before.set("wf-a\u0000p", {} as never);

    manager.beginWorkflowCacheBatch();

    expect(manager.batchWorkflowIrCache()).not.toBe(before);
    expect(manager.batchWorkflowIrCache().size).toBe(0);
    expect(manager.batchWorkflowSelectionCache().size).toBe(0);
  });
});
