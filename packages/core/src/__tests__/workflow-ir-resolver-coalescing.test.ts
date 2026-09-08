import { describe, expect, it, vi } from "vitest";
import {
  resolveWorkflowIrById,
  resolveWorkflowIrForTaskWithProvenance,
  type WorkflowDefinitionReadTally,
} from "../workflows/workflow-ir-resolver.js";

const customIr = { version: "v2", id: "custom:big", nodes: [], edges: [], columns: [] };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function storeFor(getWorkflowDefinition = vi.fn(async () => ({ ir: customIr }))) {
  return {
    getTaskWorkflowSelection: vi.fn(() => undefined),
    getWorkflowDefinition,
  };
}

describe("workflow IR resolver coalescing", () => {
  it("coalesces fifty concurrent custom workflow reads sharing a pass cache", async () => {
    const read = deferred<{ ir: typeof customIr } | undefined>();
    const store = storeFor(vi.fn(() => read.promise));
    const cache = new Map();
    const tally: WorkflowDefinitionReadTally = { definitions: 0 };
    const pending = Promise.all(Array.from({ length: 50 }, () => resolveWorkflowIrById(store, "custom:big", cache, tally)));
    await Promise.resolve();
    expect(store.getWorkflowDefinition).toHaveBeenCalledTimes(1);
    expect(tally.definitions).toBe(1);
    read.resolve({ ir: customIr });
    await expect(pending).resolves.toEqual(Array.from({ length: 50 }, () => customIr));
  });

  it("keeps uncached single-row callers live", async () => {
    const store = storeFor();
    await Promise.all(Array.from({ length: 3 }, () => resolveWorkflowIrById(store, "custom:big")));
    expect(store.getWorkflowDefinition).toHaveBeenCalledTimes(3);
  });

  it("does not share inflight reads across caller cache objects or project scopes", async () => {
    const store = storeFor();
    await Promise.all([
      resolveWorkflowIrById(store, "custom:big", new Map()),
      resolveWorkflowIrById(store, "custom:big", new Map()),
    ]);
    expect(store.getWorkflowDefinition).toHaveBeenCalledTimes(2);
    const first = storeFor();
    const second = storeFor();
    Object.assign(first, { getWorkflowSettingsProjectId: () => "one" });
    Object.assign(second, { getWorkflowSettingsProjectId: () => "two" });
    const shared = new Map();
    await Promise.all([resolveWorkflowIrById(first, "custom:big", shared), resolveWorkflowIrById(second, "custom:big", shared)]);
    expect(first.getWorkflowDefinition).toHaveBeenCalledOnce();
    expect(second.getWorkflowDefinition).toHaveBeenCalledOnce();
  });

  it.each([undefined, new Error("temporary")])("keeps missing and failed definitions retryable", async (result) => {
    const getter = vi.fn(async () => {
      if (result instanceof Error) throw result;
      return result;
    });
    const store = storeFor(getter);
    const cache = new Map();
    await Promise.all(Array.from({ length: 3 }, () => resolveWorkflowIrById(store, "custom:missing", cache)));
    expect(getter).toHaveBeenCalledTimes(1);
    expect(cache).toHaveLength(0);
    await resolveWorkflowIrById(store, "custom:missing", cache);
    expect(getter).toHaveBeenCalledTimes(2);
  });

  it("reports only issued custom reads", async () => {
    const store = storeFor();
    const tally: WorkflowDefinitionReadTally = { definitions: 0 };
    await resolveWorkflowIrById(store, "builtin:coding", new Map(), tally);
    await resolveWorkflowIrForTaskWithProvenance(store, "absent", new Map(), new Map(), tally);
    await resolveWorkflowIrById(store, "custom:big", new Map([["custom:big", customIr]]), tally);
    expect(tally.definitions).toBe(0);
    await resolveWorkflowIrById(store, "custom:big", new Map(), tally);
    expect(tally.definitions).toBe(1);
  });
});
