import { afterEach, describe, expect, it, vi } from "vitest";
import { processDueWorkflowWorkItem } from "../workflow-work-processor.js";

const item = { id: "WW-renew", taskId: "FN-renew", runId: "run-renew", nodeId: "execute", kind: "execute" } as any;

afterEach(() => vi.useRealTimers());

describe("processDueWorkflowWorkItem symbol lock renewal", () => {
  it("renews a claimed mission symbol before its short admission lease can expire", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const runWorkItem = vi.fn(() => new Promise<any>((resolve) => { finish = () => resolve({ disposition: "completed", outcome: "success", visitedNodeIds: [], context: {} }); }));
    const renewSymbolLocks = vi.fn(async () => ({ renewed: ["pkg/a.ts#a"], lost: [] }));
    const store = {
      listDueWorkflowWorkItems: () => [item],
      acquireWorkflowWorkItemLease: () => item,
      getTask: async () => ({ id: "FN-renew", missionId: "M-1", sliceId: "SL-1", declaredSymbols: ["pkg/a.ts#A"] }),
      getMissionStore: () => ({
        getFeatureByTaskId: async () => ({ id: "F-1", sliceId: "SL-1", status: "triaged" }),
        getSlice: async () => ({ id: "SL-1", milestoneId: "MS-1", status: "active" }),
        getMilestone: async () => ({ id: "MS-1", missionId: "M-1", status: "active" }),
        getMission: async () => ({ id: "M-1", status: "active" }),
      }),
      acquireSymbolLocks: async () => ({ acquired: true, conflicts: [] as [] }),
      renewSymbolLocks,
    };

    const processing = processDueWorkflowWorkItem(store as any, { runWorkItem } as any, undefined, {
      leaseOwner: "worker", leaseDurationMs: 1_000,
    });
    await vi.advanceTimersByTimeAsync(200_001);
    expect(renewSymbolLocks).toHaveBeenCalledWith(["pkg/a.ts#a"], "FN-renew", 10 * 60_000);

    finish();
    await processing;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(renewSymbolLocks).toHaveBeenCalledOnce();
  });
});
