import { describe, expect, it } from "vitest";
import type { BranchGroup, ExperimentSession, ExperimentSessionRecord } from "@fusion/core";
import { buildDefaultPlan, buildTaskGroupPlan, mergePlanWithUserOverrides } from "../experiment/finalize-plan.js";
import { ExperimentFinalizePlanError } from "../experiment/finalize-types.js";

function createSession(overrides: Partial<ExperimentSession> = {}): ExperimentSession {
  return {
    id: "EXP-1",
    name: "Experiment",
    status: "active",
    metric: { name: "score", direction: "maximize" },
    currentSegment: 2,
    keptRunIds: [],
    tags: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function runRecord(id: string, segment: number, seq: number, status: "keep" | "discard" = "keep", commit?: string, asi?: Record<string, unknown>): ExperimentSessionRecord {
  return {
    id,
    sessionId: "EXP-1",
    segment,
    seq,
    type: "run",
    payload: {
      status,
      commit,
      primaryMetric: 1,
      secondaryMetrics: [],
      asi,
    },
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("experiment finalize plan", () => {
  it("groups by segment with unique slug branch names", () => {
    const records = [
      runRecord("r1", 1, 1, "keep", "c1"),
      runRecord("r2", 1, 2, "keep", "c2"),
      runRecord("r3", 1, 3, "keep", "c3"),
      runRecord("r4", 2, 4, "keep", "c4"),
      runRecord("r5", 2, 5, "keep", "c5"),
      runRecord("r6", 2, 6, "keep", "c6"),
    ];
    const session = createSession({ keptRunIds: records.map((r) => r.id) });

    const plan = buildDefaultPlan({ session, records, integrationBranch: "main", mergeBaseCommit: "base" });

    expect(plan.groups).toHaveLength(2);
    expect(plan.groups[0].runRecordIds).toEqual(["r1", "r2", "r3"]);
    expect(plan.groups[1].runRecordIds).toEqual(["r4", "r5", "r6"]);
    expect(plan.groups[0].suggestedBranchName).toContain("segment-1");
    expect(plan.groups[1].suggestedBranchName).toContain("segment-2");
    expect(plan.groups[0].suggestedBranchName).not.toBe(plan.groups[1].suggestedBranchName);
  });

  it("clusters by asi.group regardless of segment", () => {
    const records = [
      runRecord("r1", 1, 1, "keep", "c1", { group: "Latency" }),
      runRecord("r2", 2, 2, "keep", "c2", { group: "Latency" }),
      runRecord("r3", 1, 3, "keep", "c3"),
    ];
    const session = createSession({ keptRunIds: records.map((r) => r.id) });

    const plan = buildDefaultPlan({ session, records, integrationBranch: "main", mergeBaseCommit: "base" });

    expect(plan.groups).toHaveLength(2);
    expect(plan.groups[0].title).toBe("Latency");
    expect(plan.groups[0].runRecordIds).toEqual(["r1", "r2"]);
  });

  it("captures orphaned kept runs missing commit with warning", () => {
    const records = [runRecord("r1", 1, 1, "keep", undefined), runRecord("r2", 1, 2, "keep", "c2")];
    const session = createSession({ keptRunIds: ["r1", "r2"] });

    const plan = buildDefaultPlan({ session, records, integrationBranch: "main", mergeBaseCommit: "base" });

    expect(plan.orphanedRunRecordIds).toEqual(["r1"]);
    expect(plan.warnings.some((warning) => warning.includes("r1"))).toBe(true);
    expect(plan.groups).toHaveLength(1);
    expect(plan.groups[0].runRecordIds).toEqual(["r2"]);
  });

  it("throws when override causes branch-name collision", () => {
    const records = [
      runRecord("r1", 1, 1, "keep", "c1"),
      runRecord("r2", 2, 2, "keep", "c2"),
    ];
    const session = createSession({ id: "EXP-COLLIDE", keptRunIds: ["r1", "r2"] });

    const plan = buildDefaultPlan({ session, records, integrationBranch: "main", mergeBaseCommit: "base" });

    expect(() =>
      mergePlanWithUserOverrides(plan, {
        groups: plan.groups.map((group) => ({
          id: group.id,
          runRecordIds: group.runRecordIds,
          suggestedBranchName: "same-branch",
        })),
      }),
    ).toThrow(ExperimentFinalizePlanError);
  });

  it("supports overrides moving records and preserving order", () => {
    const records = [
      runRecord("r1", 1, 1, "keep", "c1"),
      runRecord("r2", 1, 2, "keep", "c2"),
      runRecord("r3", 2, 3, "keep", "c3"),
    ];
    const session = createSession({ keptRunIds: ["r1", "r2", "r3"] });
    const plan = buildDefaultPlan({ session, records, integrationBranch: "main", mergeBaseCommit: "base" });

    const merged = mergePlanWithUserOverrides(plan, {
      groups: [
        {
          id: plan.groups[0].id,
          runRecordIds: ["r2", "r1", "r3"],
          suggestedBranchName: "experiment/exp-1/custom-a",
        },
      ],
    });

    expect(merged.groups).toHaveLength(1);
    expect(merged.groups[0].runRecordIds).toEqual(["r2", "r1", "r3"]);
    expect(merged.groups[0].commits).toEqual(["c2", "c1", "c3"]);
  });

  it("throws when override leaves group empty", () => {
    const records = [runRecord("r1", 1, 1, "keep", "c1")];
    const session = createSession({ keptRunIds: ["r1"] });
    const plan = buildDefaultPlan({ session, records, integrationBranch: "main", mergeBaseCommit: "base" });

    expect(() => mergePlanWithUserOverrides(plan, { groups: [{ id: plan.groups[0].id, runRecordIds: [] }] })).toThrow(
      ExperimentFinalizePlanError,
    );
  });

  it("builds a task-group finalize plan keyed to existing branch name", () => {
    const branchGroup: BranchGroup = {
      id: "BG-1",
      sourceType: "mission",
      sourceId: "SL-1",
      branchName: "fusion/groups/sl-1",
      autoMerge: false,
      prState: "none",
      status: "open",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const plan = buildTaskGroupPlan({
      branchGroup,
      memberTasks: [
        { id: "FN-2", createdAt: "2026-01-02T00:00:00.000Z", mergeDetails: { commitSha: "c2" } },
        { id: "FN-1", createdAt: "2026-01-01T00:00:00.000Z", mergeDetails: { commitSha: "c1" } },
      ],
      integrationBranch: "main",
      mergeBaseCommit: "base",
    });

    expect(plan.groups).toHaveLength(1);
    expect(plan.groups[0].suggestedBranchName).toBe("fusion/groups/sl-1");
    expect(plan.groups[0].runRecordIds).toEqual(["FN-1", "FN-2"]);
    expect(plan.groups[0].commits).toEqual(["c1", "c2"]);
  });

  it("falls back baseline commit to baseline run then merge-base", () => {
    const baseline = runRecord("base", 1, 1, "keep", "baseline-commit");
    const kept = runRecord("r1", 1, 2, "keep", "c1");

    const withBaselineRun = buildDefaultPlan({
      session: createSession({ keptRunIds: ["r1"], baselineRunId: "base" }),
      records: [baseline, kept],
      integrationBranch: "main",
      mergeBaseCommit: "merge-base",
    });
    expect(withBaselineRun.baselineCommit).toBe("baseline-commit");

    const mergeBaseFallback = buildDefaultPlan({
      session: createSession({ keptRunIds: ["r1"] }),
      records: [kept],
      integrationBranch: "main",
      mergeBaseCommit: "merge-base",
    });
    expect(mergeBaseFallback.baselineCommit).toBe("merge-base");
    expect(mergeBaseFallback.warnings).toContain("no baseline commit; using merge-base as degenerate baseline");
  });
});
