import { describe, expect, it, vi } from "vitest";
import {
  ProjectAdmissionCoordinator,
  type AdmissionCandidate,
} from "../concurrency/concurrency.js";

function candidate(params: {
  id: string;
  lane: AdmissionCandidate["lane"];
  consumesWorktree: boolean;
  start?: () => Promise<boolean | void>;
}): AdmissionCandidate {
  return {
    taskId: params.id,
    projectId: "project-a",
    lane: params.lane,
    consumesWorktree: params.consumesWorktree,
    start: params.start ?? (async () => true),
  };
}

describe("ProjectAdmissionCoordinator two-gate admission", () => {
  it("admits checkout-free planning when three execution worktrees fill a 3-slot gate", async () => {
    const coordinator = new ProjectAdmissionCoordinator();
    const executeStart = vi.fn(async () => true);
    const planningStart = vi.fn(async () => true);

    const admitted = await coordinator.admitNext({
      projectId: "project-a",
      maxConcurrent: 30,
      claimed: () => 3,
      claimedTaskIds: () => ["FN-1", "FN-2", "FN-3"],
      worktreeGate: {
        limit: 3,
        claimed: () => 3,
        claimedTaskIds: () => ["FN-1", "FN-2", "FN-3"],
      },
      refresh: async () => [
        candidate({ id: "FN-EXECUTE", lane: "execute", consumesWorktree: true, start: executeStart }),
        candidate({ id: "FN-PLAN", lane: "planning", consumesWorktree: false, start: planningStart }),
      ],
    });

    expect(admitted).toBe("FN-PLAN");
    expect(executeStart).not.toHaveBeenCalled();
    expect(planningStart).toHaveBeenCalledOnce();
  });

  it("walks past an older worktree-blocked execute candidate instead of starving planning", async () => {
    const coordinator = new ProjectAdmissionCoordinator();
    const starts: string[] = [];

    expect(await coordinator.admitNext({
      projectId: "project-a",
      maxConcurrent: 30,
      claimed: () => 3,
      worktreeGate: { limit: 3, claimed: () => 3 },
      refresh: async () => [
        candidate({ id: "FN-1", lane: "execute", consumesWorktree: true, start: async () => { starts.push("execute"); } }),
        candidate({ id: "FN-2", lane: "planning", consumesWorktree: false, start: async () => { starts.push("planning"); } }),
      ],
    })).toBe("FN-2");
    expect(starts).toEqual(["planning"]);
  });

  it("counts an in-flight execution reservation until its durable worktree claim appears", async () => {
    const coordinator = new ProjectAdmissionCoordinator();

    expect(await coordinator.admitNext({
      projectId: "project-a",
      maxConcurrent: 30,
      claimed: () => 0,
      worktreeGate: { limit: 1, claimed: () => 0 },
      refresh: async () => [candidate({ id: "FN-1", lane: "execute", consumesWorktree: true })],
    })).toBe("FN-1");
    expect(coordinator.inspectProjectStateForTests("project-a")).toMatchObject({
      reservedCount: 1,
      reservedWorktreeCount: 1,
    });

    expect(await coordinator.admitNext({
      projectId: "project-a",
      maxConcurrent: 30,
      claimed: () => 0,
      worktreeGate: { limit: 1, claimed: () => 0 },
      refresh: async () => [candidate({ id: "FN-2", lane: "execute", consumesWorktree: true })],
    })).toBeUndefined();
  });

  it("releases a worktree reservation when the lane rejects its handoff", async () => {
    const coordinator = new ProjectAdmissionCoordinator();

    expect(await coordinator.admitNext({
      projectId: "project-a",
      maxConcurrent: 30,
      claimed: () => 0,
      worktreeGate: { limit: 1, claimed: () => 0 },
      refresh: async () => [candidate({ id: "FN-REJECT", lane: "execute", consumesWorktree: true, start: async () => false })],
    })).toBeUndefined();
    expect(coordinator.inspectProjectStateForTests("project-a")).toMatchObject({
      reservedCount: 0,
      reservedWorktreeCount: 0,
    });
  });

  it("never counts a planning reservation against the worktree gate", async () => {
    const coordinator = new ProjectAdmissionCoordinator();
    expect(await coordinator.admitNext({
      projectId: "project-a",
      maxConcurrent: 30,
      claimed: () => 0,
      worktreeGate: { limit: 1, claimed: () => 0 },
      refresh: async () => [candidate({ id: "FN-PLAN", lane: "planning", consumesWorktree: false })],
    })).toBe("FN-PLAN");
    expect(coordinator.inspectProjectStateForTests("project-a")).toMatchObject({
      reservedCount: 1,
      reservedWorktreeCount: 0,
    });

    expect(await coordinator.admitNext({
      projectId: "project-a",
      maxConcurrent: 30,
      claimed: () => 0,
      worktreeGate: { limit: 1, claimed: () => 0 },
      refresh: async () => [candidate({ id: "FN-EXECUTE", lane: "execute", consumesWorktree: true })],
    })).toBe("FN-EXECUTE");
  });

  it("deduplicates the same durable task and reservation independently within each gate", async () => {
    const coordinator = new ProjectAdmissionCoordinator();
    expect(await coordinator.admitNext({
      projectId: "project-a",
      maxConcurrent: 2,
      claimed: () => 1,
      claimedTaskIds: () => ["FN-1"],
      worktreeGate: { limit: 2, claimed: () => 1, claimedTaskIds: () => ["FN-1"] },
      refresh: async () => [candidate({ id: "FN-1", lane: "execute", consumesWorktree: true })],
    })).toBe("FN-1");

    expect(await coordinator.admitNext({
      projectId: "project-a",
      maxConcurrent: 2,
      claimed: () => 1,
      claimedTaskIds: () => ["FN-1"],
      worktreeGate: { limit: 2, claimed: () => 1, claimedTaskIds: () => ["FN-1"] },
      refresh: async () => [candidate({ id: "FN-2", lane: "planning", consumesWorktree: false })],
    })).toBe("FN-2");
  });

  it("keeps agent-gate-only behavior when no worktree gate is supplied", async () => {
    const coordinator = new ProjectAdmissionCoordinator();
    expect(await coordinator.admitNext({
      projectId: "project-a",
      maxConcurrent: 2,
      claimed: () => 1,
      refresh: async () => [candidate({ id: "FN-EXECUTE", lane: "execute", consumesWorktree: true })],
    })).toBe("FN-EXECUTE");
  });
});
