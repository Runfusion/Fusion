import { describe, expect, it, vi } from "vitest";
import { claimDueWorkflowWorkItem } from "../workflows/workflow-work-scheduler.js";

const item = { id: "WW-1", taskId: "FN-1", runId: "run-1", nodeId: "execute", kind: "execute" } as any;

describe("claimDueWorkflowWorkItem", () => {
  it("awaits normal coarse-fallback workflow lease acquisition", async () => {
    const acquireWorkflowWorkItemLease = vi.fn(() => item);
    const result = await claimDueWorkflowWorkItem({ listDueWorkflowWorkItems: () => [item], acquireWorkflowWorkItemLease }, { leaseOwner: "worker", leaseDurationMs: 1000 });
    expect(result).toMatchObject({ taskId: "FN-1", workItem: item });
    expect(acquireWorkflowWorkItemLease).toHaveBeenCalledOnce();
  });

  it("does not consume a work lease when mission lineage is unapproved", async () => {
    const acquireWorkflowWorkItemLease = vi.fn(() => item);
    const logEntry = vi.fn(async () => undefined);
    const result = await claimDueWorkflowWorkItem({
      listDueWorkflowWorkItems: () => [item], acquireWorkflowWorkItemLease, logEntry,
      getTask: async () => ({ id: "FN-1", missionId: "M-1", sliceId: "SL-1", declaredSymbols: ["pkg/a.ts#A"] } as any),
      getMissionStore: () => ({ getFeatureByTaskId: async () => undefined, getSlice: async () => undefined, getMilestone: async () => undefined, getMission: async () => undefined } as any),
      acquireSymbolLocks: vi.fn(),
    }, { leaseOwner: "worker", leaseDurationMs: 1000 });
    expect(result).toBeNull();
    expect(acquireWorkflowWorkItemLease).not.toHaveBeenCalled();
    expect(logEntry).toHaveBeenCalledWith("FN-1", expect.stringContaining("mission lineage blocked"));
  });

  it("releases an acquired symbol lock when the workflow lease races", async () => {
    const releaseSymbolLocks = vi.fn(async () => undefined);
    const result = await claimDueWorkflowWorkItem({
      listDueWorkflowWorkItems: () => [item], acquireWorkflowWorkItemLease: () => null, releaseSymbolLocks,
      getTask: async () => ({ id: "FN-1", missionId: "M-1", sliceId: "SL-1", declaredSymbols: ["pkg/a.ts#A"] } as any),
      getMissionStore: () => ({
        getFeatureByTaskId: async () => ({ id: "F-1", sliceId: "SL-1", status: "triaged" }),
        getSlice: async () => ({ id: "SL-1", milestoneId: "MS-1", status: "active" }),
        getMilestone: async () => ({ id: "MS-1", missionId: "M-1", status: "active" }),
        getMission: async () => ({ id: "M-1", status: "active" }),
      } as any),
      acquireSymbolLocks: async () => ({ acquired: true, conflicts: [] }),
    }, { leaseOwner: "worker", leaseDurationMs: 1000 });
    expect(result).toBeNull();
    expect(releaseSymbolLocks).toHaveBeenCalledWith(["pkg/a.ts#a"], "FN-1");
  });
});
