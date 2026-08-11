import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { getTaskWorkflowSelectionsAsyncImpl } from "../task-store/workflow-definitions.js";
import { resolveWorkflowIrForTask } from "../workflows/workflow-ir-resolver.js";

function sqlBoundValues(query: unknown): unknown[] {
  return new PgDialect().sqlToQuery(query as Parameters<PgDialect["sqlToQuery"]>[0]).params;
}

describe("workflow IR selection cache", () => {
  it("batches unique ids in the current project and leaves missing rows absent", async () => {
    const where = vi.fn().mockResolvedValue([
      { taskId: "FN-1", workflowId: "custom:one", stepIds: ["step-a", 4] },
    ]);
    const from = vi.fn(() => ({ where }));
    const select = vi.fn(() => ({ from }));
    const store = {
      asyncLayer: { projectId: " project-a ", db: { select } },
    } as never;

    const selections = await getTaskWorkflowSelectionsAsyncImpl(store, ["FN-1", "FN-2", "FN-1"]);

    expect(select).toHaveBeenCalledOnce();
    expect(from).toHaveBeenCalledOnce();
    expect(where).toHaveBeenCalledOnce();
    expect(sqlBoundValues(where.mock.calls[0]?.[0])).toEqual([
      "project-a", "FN-1", "FN-2",
    ]);
    expect(selections).toEqual(new Map([["FN-1", { workflowId: "custom:one", stepIds: ["step-a"] }]]));
  });

  it("avoids a query for an empty batch and uses the legacy partition for a blank project id", async () => {
    const where = vi.fn().mockResolvedValue([]);
    const select = vi.fn(() => ({ from: vi.fn(() => ({ where })) }));
    const blankProjectStore = { asyncLayer: { projectId: " ", db: { select } } } as never;

    await expect(getTaskWorkflowSelectionsAsyncImpl(blankProjectStore, [])).resolves.toEqual(new Map());
    expect(select).not.toHaveBeenCalled();

    await getTaskWorkflowSelectionsAsyncImpl(blankProjectStore, ["FN-1", "FN-1"]);
    expect(where).toHaveBeenCalledOnce();
    expect(sqlBoundValues(where.mock.calls[0]?.[0])).toEqual([
      "__legacy_unscoped__", "FN-1",
    ]);
  });

  it("uses cached selections, including explicit absence, without calling either reader", async () => {
    const asyncReader = vi.fn();
    const syncReader = vi.fn();
    const store = {
      getTaskWorkflowSelectionAsync: asyncReader,
      getTaskWorkflowSelection: syncReader,
      getWorkflowDefinition: vi.fn(),
    } as never;
    const cache = new Map([["FN-1", undefined]]);

    await resolveWorkflowIrForTask(store, "FN-1", undefined, cache);

    expect(asyncReader).not.toHaveBeenCalled();
    expect(syncReader).not.toHaveBeenCalled();
  });

  it("populates a supplied cache after a successful read but not after a throwing read", async () => {
    const cache = new Map();
    const store = {
      getTaskWorkflowSelectionAsync: vi.fn().mockResolvedValue({ workflowId: "builtin:coding", stepIds: [] }),
      getTaskWorkflowSelection: vi.fn(),
      getWorkflowDefinition: vi.fn(),
    } as never;
    await resolveWorkflowIrForTask(store, "FN-1", undefined, cache);
    expect(cache.get("FN-1")).toEqual({ workflowId: "builtin:coding", stepIds: [] });

    const throwingCache = new Map();
    await resolveWorkflowIrForTask({ ...store, getTaskWorkflowSelectionAsync: vi.fn().mockRejectedValue(new Error("transient")) } as never, "FN-2", undefined, throwingCache);
    expect(throwingCache.has("FN-2")).toBe(false);
  });
});
