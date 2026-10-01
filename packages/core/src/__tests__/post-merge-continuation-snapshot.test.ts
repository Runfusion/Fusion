import { describe, expect, it, vi } from "vitest";
import { seedWorkspaceCodeReviewContinuationIfIdle } from "../task-store/async/async-workflow-workitems.js";
import type { AsyncDataLayer } from "../postgres/data-layer.js";

/* FNXC:PostMergeRecovery 2026-10-01-04:43: Concurrent operator/task changes must refuse the idle seed without writes. */
describe("post-merge continuation task snapshot fence", () => {
  const input = {
    taskId: "FN-9368", nodeId: "post-merge-verification", kind: "task" as const,
    state: "runnable" as const, runId: "recovery", expectedTaskUpdatedAt: "before",
  };
  function layerWithReads(rows: unknown[][]) {
    const tx = {
      execute: vi.fn(async () => []),
      select: vi.fn(() => {
        const result = rows.shift() ?? [];
        return { from: () => ({ where: () => Object.assign(Promise.resolve(result), { limit: async () => result }) }) };
      }),
      insert: vi.fn(), update: vi.fn(), delete: vi.fn(),
    };
    const layer = { projectId: "project", transactionImmediate: async (fn: (db: typeof tx) => unknown) => fn(tx) } as unknown as AsyncDataLayer;
    return { layer, tx };
  }

  it.each([{ rows: [] }, { rows: [{ updatedAt: "after" }] }])("rejects an absent or changed task under the transaction lock: %j", async ({ rows }) => {
    const { layer, tx } = layerWithReads([rows]);
    await expect(seedWorkspaceCodeReviewContinuationIfIdle(layer, input))
      .resolves.toEqual({ seeded: false, reason: "task-state-changed" });
    expect(tx.execute).toHaveBeenCalledTimes(1);
    expect(tx.insert).not.toHaveBeenCalled();
    expect(tx.update).not.toHaveBeenCalled();
    expect(tx.delete).not.toHaveBeenCalled();
  });

  it("still honors an active continuation after a matching task snapshot", async () => {
    const { layer, tx } = layerWithReads([[{ updatedAt: "before" }], [{ id: "live" }]]);
    await expect(seedWorkspaceCodeReviewContinuationIfIdle(layer, input))
      .resolves.toEqual({ seeded: false, reason: "active-continuation" });
    expect(tx.select).toHaveBeenCalledTimes(2);
    expect(tx.insert).not.toHaveBeenCalled();
  });
});
