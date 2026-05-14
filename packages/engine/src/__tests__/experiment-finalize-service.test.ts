import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExperimentSession, ExperimentSessionRecord } from "@fusion/core";
import { ExperimentFinalizeService, __activeFinalizeLocksForTesting } from "../experiment/finalize-service.js";
import {
  ExperimentFinalizeBranchExistsError,
  ExperimentFinalizeCherryPickConflictError,
  ExperimentFinalizeNoKeptRunsError,
  ExperimentFinalizeStateError,
} from "../experiment/finalize-types.js";

function createSession(overrides: Partial<ExperimentSession> = {}): ExperimentSession {
  return {
    id: "EXP-1",
    name: "Experiment",
    status: "active",
    metric: { name: "score", direction: "maximize" },
    currentSegment: 1,
    keptRunIds: ["r1", "r2"],
    tags: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function runRecord(id: string, seq: number, status: "keep" | "discard" = "keep", commit?: string): ExperimentSessionRecord {
  return {
    id,
    sessionId: "EXP-1",
    segment: 1,
    seq,
    type: "run",
    payload: { status, commit, primaryMetric: 1, secondaryMetrics: [] },
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("ExperimentFinalizeService", () => {
  const records = [runRecord("r1", 1, "keep", "c1"), runRecord("r2", 2, "keep", "c2"), runRecord("r3", 3, "discard")];
  let session: ExperimentSession;
  let store: any;
  let git: any;

  beforeEach(() => {
    __activeFinalizeLocksForTesting.clear();
    session = createSession();
    store = {
      getSession: vi.fn(() => session),
      listRecords: vi.fn(() => records),
      updateSession: vi.fn((_id, patch) => {
        session = { ...session, ...patch };
        return session;
      }),
      appendRecord: vi.fn(() => ({ id: "fin-1" })),
    };
    git = {
      currentBranch: vi.fn(async () => "main"),
      head: vi.fn(async () => "head-sha"),
      mergeBase: vi.fn(async () => "merge-base"),
      branchExists: vi.fn(async () => false),
      createBranch: vi.fn(async () => undefined),
      checkout: vi.fn(async () => undefined),
      cherryPick: vi.fn(async () => undefined),
      deleteBranch: vi.fn(async () => undefined),
    };
  });

  it("finalizes happy path and appends finalize record", async () => {
    const service = new ExperimentFinalizeService({ store, git });

    const result = await service.finalize({ sessionId: "EXP-1" });

    expect(result.branches).toHaveLength(1);
    expect(store.updateSession).toHaveBeenNthCalledWith(1, "EXP-1", { status: "finalizing" });
    expect(store.updateSession).toHaveBeenLastCalledWith("EXP-1", { status: "finalized" });
    expect(store.appendRecord).toHaveBeenCalledWith(
      "EXP-1",
      expect.objectContaining({ type: "finalize", payload: expect.objectContaining({ keptRunIds: ["r1", "r2"], discardedRunIds: ["r3"] }) }),
    );
  });

  it("previewPlan is read-only", async () => {
    const service = new ExperimentFinalizeService({ store, git });

    const plan = await service.previewPlan({ sessionId: "EXP-1" });

    expect(plan.sessionId).toBe("EXP-1");
    expect(store.updateSession).not.toHaveBeenCalled();
    expect(git.createBranch).not.toHaveBeenCalled();
  });

  it("throws no-kept-runs and keeps session active", async () => {
    session = createSession({ keptRunIds: [] });
    const service = new ExperimentFinalizeService({ store, git });

    await expect(service.finalize({ sessionId: "EXP-1" })).rejects.toBeInstanceOf(ExperimentFinalizeNoKeptRunsError);
    expect(store.updateSession).not.toHaveBeenCalled();
  });

  it("rejects concurrent finalization with lock", async () => {
    __activeFinalizeLocksForTesting.add("EXP-1");
    const service = new ExperimentFinalizeService({ store, git });

    await expect(service.finalize({ sessionId: "EXP-1" })).rejects.toBeInstanceOf(ExperimentFinalizeStateError);
  });

  it("rolls back when branch already exists", async () => {
    git.branchExists = vi.fn(async () => true);
    const service = new ExperimentFinalizeService({ store, git });

    await expect(service.finalize({ sessionId: "EXP-1" })).rejects.toBeInstanceOf(ExperimentFinalizeBranchExistsError);
    expect(git.deleteBranch).not.toHaveBeenCalled();
    expect(git.checkout).toHaveBeenCalledWith("main");
    expect(session.status).toBe("finalizing");
  });

  it("rolls back branch on cherry-pick conflict", async () => {
    git.cherryPick = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new ExperimentFinalizeCherryPickConflictError("conflict", { groupId: "segment:1", commit: "c2", stderr: "boom" }));

    const service = new ExperimentFinalizeService({ store, git });

    await expect(service.finalize({ sessionId: "EXP-1" })).rejects.toBeInstanceOf(ExperimentFinalizeCherryPickConflictError);
    expect(git.deleteBranch).toHaveBeenCalledWith(expect.any(String), { force: true });
    expect(git.checkout).toHaveBeenCalledWith("main");
  });

  it("restores detached HEAD by sha", async () => {
    git.currentBranch = vi.fn(async () => null);
    git.head = vi.fn(async () => "detached-sha");
    const service = new ExperimentFinalizeService({ store, git });

    await service.finalize({ sessionId: "EXP-1" });

    expect(git.checkout).toHaveBeenCalledWith("detached-sha");
  });

  it.each([
    [new ExperimentFinalizeStateError("x"), "state_error"],
    [new ExperimentFinalizeNoKeptRunsError("x"), "no_kept_runs"],
    [new ExperimentFinalizeBranchExistsError("x"), "branch_exists"],
    [new ExperimentFinalizeCherryPickConflictError("x", { groupId: "g", commit: "c", stderr: "e" }), "cherry_pick_conflict"],
  ])("error code literal %s", (error: any, expectedCode: string) => {
    expect(error.code).toBe(expectedCode);
  });
});
