import { describe, expect, it, vi } from "vitest";
import {
  EpochedWorkflowIrCache,
  EpochedWorkflowSelectionCache,
  resolveWorkflowIrForTask,
  type WorkflowSelection,
} from "../index.js";

/*
FNXC:WorkflowBatchCacheEpoch 2026-10-11-19:26 (RUFU-584, operator directive to eliminate the leak):
The leak was measured as ~2,000 async frames suspended on workflow reads, each pinning the batch of
materialized tasks it closed over. Cause: every self-healing sweep allocated its own pass cache, so one
card inspected by 15 sweeps cost 15 selection reads and 15 definition reads on a 3-lane pool per store.
These tests pin the two properties that let ONE cache serve the whole pass:
  1. shared caches collapse repeated per-card resolution to a single read (that is the read volume that
     created the suspended frames, so it is the behaviour the fix exists to change);
  2. a workflow write discards the shared cache, because sharing is only safe if staleness is impossible.
Reads are counted on the store method itself, not on a tally object, because the store call is what
consumes a pool lane and what pins the caller's frame.
*/

function makeStore(options: { selection?: WorkflowSelection } = {}) {
  let selectionEpoch = 0;
  let definitionEpoch = 0;
  const selection: WorkflowSelection = options.selection ?? { taskId: "T1", workflowId: "wf-review", stepIds: ["s1"] };
  const store = {
    getTaskWorkflowSelectionAsync: vi.fn(async () => selection),
    getWorkflowDefinition: vi.fn(async () => ({ id: "wf-review", ir: minimalIr("wf-review") })),
    getWorkflowSettingsProjectId: vi.fn(() => "p1"),
    getWorkflowPromptOverridesAsync: vi.fn(async () => ({})),
    workflowSelectionEpoch: () => selectionEpoch,
    workflowDefinitionEpoch: () => definitionEpoch,
    bumpSelection: () => { selectionEpoch += 1; },
    bumpDefinition: () => { definitionEpoch += 1; },
  };
  return store;
}

/** An object IR the resolver actually accepts (a JSON string here would fall back to the default). */
function minimalIr(id: string) {
  return {
    version: "v2",
    id,
    nodes: [],
    edges: [],
    columns: [
      { id: "inbox", label: "Inbox", traits: [{ trait: "intake" }] },
      { id: "waiting", label: "Waiting", traits: [{ trait: "review" }] },
      { id: "done", label: "Done", traits: [{ trait: "terminal", config: { outcome: "done" } }] },
    ],
  };
}

describe("epoch-guarded workflow pass caches", () => {
  it("collapses repeated per-card resolution onto one read when caches are shared", async () => {
    const store = makeStore();
    const irCache = new EpochedWorkflowIrCache(store.workflowDefinitionEpoch);
    const selectionCache = new EpochedWorkflowSelectionCache(store.workflowSelectionEpoch);

    // Three sweeps in one pass inspect the same card: the pre-fix cost was three of each read.
    for (let sweep = 0; sweep < 3; sweep++) {
      await resolveWorkflowIrForTask(store as never, "T1", irCache, selectionCache);
    }

    expect(store.getTaskWorkflowSelectionAsync).toHaveBeenCalledTimes(1);
    expect(store.getWorkflowDefinition).toHaveBeenCalledTimes(1);
  });

  it("discards the shared selection cache when a selection write moves the epoch", async () => {
    const store = makeStore();
    const irCache = new EpochedWorkflowIrCache(store.workflowDefinitionEpoch);
    const selectionCache = new EpochedWorkflowSelectionCache(store.workflowSelectionEpoch);

    await resolveWorkflowIrForTask(store as never, "T1", irCache, selectionCache);
    const epochBeforeWrite = selectionCache.validUnderEpoch();
    expect(selectionCache.has("T1")).toBe(true);

    store.bumpSelection();

    // Staleness is the hazard of sharing; the cache must be empty rather than merely older.
    expect(selectionCache.has("T1")).toBe(false);
    expect(selectionCache.size).toBe(0);

    await resolveWorkflowIrForTask(store as never, "T1", irCache, selectionCache);
    expect(store.getTaskWorkflowSelectionAsync).toHaveBeenCalledTimes(2);
    expect(selectionCache.validUnderEpoch()).toBe(epochBeforeWrite + 1);
  });

  it("discards the shared IR cache when a definition write moves the epoch", async () => {
    const store = makeStore();
    const irCache = new EpochedWorkflowIrCache(store.workflowDefinitionEpoch);
    const selectionCache = new EpochedWorkflowSelectionCache(store.workflowSelectionEpoch);

    await resolveWorkflowIrForTask(store as never, "T1", irCache, selectionCache);
    expect(store.getWorkflowDefinition).toHaveBeenCalledTimes(1);

    store.bumpDefinition();
    expect(irCache.size).toBe(0);

    await resolveWorkflowIrForTask(store as never, "T1", irCache, selectionCache);
    expect(store.getWorkflowDefinition).toHaveBeenCalledTimes(2);
    // The selection is unaffected by a definition edit, so it must NOT be re-read.
    expect(store.getTaskWorkflowSelectionAsync).toHaveBeenCalledTimes(1);
  });

  it("keeps a selection epoch change from discarding resolved IR, and vice versa", () => {
    let selectionEpoch = 3;
    let definitionEpoch = 7;
    const irCache = new EpochedWorkflowIrCache(() => definitionEpoch);
    const selectionCache = new EpochedWorkflowSelectionCache(() => selectionEpoch);
    irCache.set("wf\u0000p1", {} as never);
    selectionCache.set("T1", undefined);

    selectionEpoch += 1;
    // A selection edit invalidates selections only: throwing away resolved IR would re-read every
    // workflow on the board for no correctness reason.
    expect(selectionCache.size).toBe(0);
    expect(irCache.size).toBe(1);

    definitionEpoch += 1;
    expect(irCache.size).toBe(0);
  });
});
