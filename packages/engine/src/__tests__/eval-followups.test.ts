import { describe, expect, it, vi } from "vitest";
import { normalizeEvalFollowUpText } from "@fusion/core";
import { materializeEvalFollowUps, normalizeEvalFollowUps, resolveEvalFollowUpPolicyMode } from "../eval-followups.js";

function makeStore(params: {
  openTasks?: Array<Record<string, unknown>>;
  priorDedupeKeys?: string[];
  taskLogsById?: Record<string, Array<{ action: string; timestamp: string }>>;
}) {
  const openTasks = params.openTasks ?? [];
  const priorDedupeKeys = params.priorDedupeKeys ?? [];
  const taskLogsById = params.taskLogsById ?? {};
  return {
    listTasks: async () => openTasks,
    createTask: vi.fn(async () => ({ id: "FN-created" })),
    getTask: vi.fn(async (id: string) => ({ id, log: taskLogsById[id] ?? [] })),
    logEntry: vi.fn(async () => undefined),
    recordRunAuditEvent: vi.fn(async () => undefined),
    getEvalStore: () => ({
      listTaskResults: () => [{ followUps: priorDedupeKeys.map((dedupeKey) => ({ dedupeKey })) }],
    }),
  } as any;
}

describe("normalizeEvalFollowUps", () => {
  it("suppresses empty or generic suggestions", async () => {
    const followUps = await normalizeEvalFollowUps({
      parentTaskId: "FN-1",
      runId: "ER-1",
      overallBand: "weak",
      drafts: [{ title: "Follow-up", description: "too short", reason: "", evidenceRefs: [] }],
      store: makeStore({}),
      policyMode: "persist_only",
    });

    expect(followUps[0]?.state).toBe("suppressed");
    expect(followUps[0]?.suppressedReason).toBe("empty_or_generic");
  });

  it("suppresses duplicates of open tasks", async () => {
    const followUps = await normalizeEvalFollowUps({
      parentTaskId: "FN-1",
      runId: "ER-1",
      overallBand: "weak",
      drafts: [{ title: "Investigate flaky verification command", description: "Investigate flaky verification command causing reruns.", reason: "Failed verification", evidenceRefs: ["workflow-1"] }],
      store: makeStore({
        openTasks: [{ id: "FN-open", column: "todo", title: "Investigate flaky verification command", description: "x" }],
      }),
      policyMode: "persist_only",
    });

    expect(followUps[0]?.state).toBe("suppressed");
    expect(followUps[0]?.suppressedReason).toBe("duplicate_open_task");
    expect(followUps[0]?.matchedTaskId).toBe("FN-open");
  });

  it("suppresses duplicates from prior eval results", async () => {
    const priorKey = normalizeEvalFollowUpText("FN-1:Add regression test for merge flow:Add regression test for merge flow regressions.");
    const followUps = await normalizeEvalFollowUps({
      parentTaskId: "FN-1",
      runId: "ER-1",
      overallBand: "weak",
      drafts: [{ title: "Add regression test for merge flow", description: "Add regression test for merge flow regressions.", reason: "Missing tests", evidenceRefs: ["workflow-2"] }],
      store: makeStore({ priorDedupeKeys: [priorKey] }),
      policyMode: "persist_only",
    });

    expect(followUps[0]?.state).toBe("suppressed");
    expect(followUps[0]?.suppressedReason).toBe("duplicate_prior_suggestion");
  });

  it("marks qualified follow-ups for creation in create-all mode", async () => {
    const followUps = await normalizeEvalFollowUps({
      parentTaskId: "FN-1",
      runId: "ER-1",
      overallBand: "weak",
      drafts: [{ title: "Add flaky test diagnostics", description: "Add flaky test diagnostics for failing suite evidence.", reason: "Multiple failing runs", evidenceRefs: ["workflow-3"] }],
      store: makeStore({}),
      policyMode: "create_all_non_duplicates",
    });

    expect(followUps[0]?.state).toBe("suggested");
    expect(followUps[0]?.recommendation.shouldCreate).toBe(true);
    expect(followUps[0]?.policyMode).toBe("create_all_non_duplicates");
  });

  it("resolves project follow-up policy to backend policy mode", () => {
    expect(resolveEvalFollowUpPolicyMode("off")).toBe("persist_only");
    expect(resolveEvalFollowUpPolicyMode("suggest")).toBe("persist_only");
    expect(resolveEvalFollowUpPolicyMode("create")).toBe("auto_create_qualified");
  });

  it("creates task and stamps provenance when suggestion is qualified", async () => {
    const store = makeStore({});
    const [created] = await materializeEvalFollowUps({
      parentTaskId: "FN-parent",
      runId: "ER-5",
      policyMode: "create_all_non_duplicates",
      overallScore: 42,
      store,
      followUps: [{
        suggestionId: "efs-1",
        dedupeKey: "k",
        title: "Investigate issue",
        description: "Investigate issue found by eval.",
        priority: "high",
        severity: "weak",
        rationale: "Signals showed repeated failures.",
        evidenceRefs: [{ evidenceId: "workflow-1", source: "other" }],
        recommendation: { shouldCreate: true, reason: "qualified", policyQualified: true },
        state: "suggested",
        policyMode: "create_all_non_duplicates",
      }],
    });

    expect(store.createTask).toHaveBeenCalledTimes(1);
    expect(store.createTask.mock.calls[0][0].source.sourceParentTaskId).toBe("FN-parent");
    expect(store.createTask.mock.calls[0][0].source.sourceMetadata).toMatchObject({
      runId: "ER-5",
      suggestionId: "efs-1",
      policyMode: "create_all_non_duplicates",
    });
    expect(created?.state).toBe("created");
    expect(created?.createdTaskId).toBe("FN-created");
  });

  it("reuses an existing task when the suggestion id already has an open follow-up", async () => {
    const store = makeStore({
      openTasks: [{
        id: "FN-existing",
        column: "todo",
        description: "existing eval follow-up",
        sourceParentTaskId: "FN-parent",
        sourceMetadata: { suggestionId: "efs-1" },
      }],
    });

    const [created] = await materializeEvalFollowUps({
      parentTaskId: "FN-parent",
      runId: "ER-5",
      policyMode: "create_all_non_duplicates",
      overallScore: 42,
      store,
      followUps: [{
        suggestionId: "efs-1",
        dedupeKey: "k",
        title: "Investigate issue",
        description: "Investigate issue found by eval.",
        priority: "high",
        severity: "weak",
        rationale: "Signals showed repeated failures.",
        evidenceRefs: [{ evidenceId: "workflow-1", source: "other" }],
        recommendation: { shouldCreate: true, reason: "qualified", policyQualified: true },
        state: "suggested",
        policyMode: "create_all_non_duplicates",
      }],
    });

    expect(store.createTask).not.toHaveBeenCalled();
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-existing",
      expect.stringContaining("[verification recurrence] signature=none"),
      expect.stringContaining("kind=eval; parentTaskId=FN-parent"),
    );
    expect(created?.createdTaskId).toBe("FN-existing");
    expect(created?.recommendation.reason).toContain("Reused existing follow-up FN-existing");
  });
});
