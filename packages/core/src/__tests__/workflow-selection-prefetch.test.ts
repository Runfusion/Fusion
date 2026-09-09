import { describe, expect, it, vi } from "vitest";
import { prefetchWorkflowSelections, resolveWorkflowIrForTask, type WorkflowSelectionCache } from "../workflows/workflow-ir-resolver.js";

function storeFor(selections = new Map<string, { workflowId: string; stepIds: string[] }>()) {
  return {
    getTaskWorkflowSelection: vi.fn(),
    getTaskWorkflowSelectionAsync: vi.fn(async (id: string) => selections.get(id)),
    getTaskWorkflowSelectionsAsync: vi.fn(async (ids: string[]) => new Map(ids.flatMap((id) => selections.has(id) ? [[id, selections.get(id)!] as const] : []))),
    getWorkflowDefinition: vi.fn(),
  };
}

describe("workflow selection prefetch", () => {
  it("batches unique ids and supplies the cache to resolution", async () => {
    const store = storeFor(new Map([["A", { workflowId: "builtin:coding", stepIds: [] }]]));
    const cache: WorkflowSelectionCache = new Map();
    await expect(prefetchWorkflowSelections(store, ["A", "B", "A"], cache)).resolves.toEqual({ batched: 1, singles: 0 });
    expect(store.getTaskWorkflowSelectionsAsync).toHaveBeenCalledWith(["A", "B"]);
    expect(cache.has("B")).toBe(true);
    await resolveWorkflowIrForTask(store, "B", undefined, cache);
    expect(store.getTaskWorkflowSelectionAsync).not.toHaveBeenCalled();
  });

  it("reports individual fallback work without caching a failed batch", async () => {
    const store = storeFor();
    store.getTaskWorkflowSelectionsAsync.mockRejectedValueOnce(new Error("temporary"));
    const cache: WorkflowSelectionCache = new Map();
    await expect(prefetchWorkflowSelections(store, ["A", "B", "A"], cache)).resolves.toEqual({ batched: 0, singles: 2 });
    expect(cache.size).toBe(0);
    await resolveWorkflowIrForTask(store, "A", undefined, cache);
    expect(store.getTaskWorkflowSelectionAsync).toHaveBeenCalledWith("A");
  });

  it("does not read already-cached ids and degrades when batch support is absent", async () => {
    const store = storeFor();
    const cache: WorkflowSelectionCache = new Map([["A", undefined]]);
    await expect(prefetchWorkflowSelections(store, ["A"], cache)).resolves.toEqual({ batched: 0, singles: 0 });
    await expect(prefetchWorkflowSelections({ ...store, getTaskWorkflowSelectionsAsync: undefined }, ["B", "C"], cache)).resolves.toEqual({ batched: 0, singles: 2 });
    expect(store.getTaskWorkflowSelectionsAsync).not.toHaveBeenCalled();
  });
});
