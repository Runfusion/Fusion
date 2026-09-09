import { describe, expect, it, vi } from "vitest";
import { normalizeEvalFollowUpText } from "@fusion/core";
import { materializeEvalFollowUps, normalizeEvalFollowUps, resolveEvalFollowUpPolicyMode } from "../eval/eval-followups.js";

function makeStore(params: {
  openTasks?: Array<Record<string, unknown>>;
  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-19:30:
  Per-task complete lanes let a case put a prior follow-up in the completion lane for its workflow.
  Absent, the fake declares no workflow and completion falls back to Done.
  */
  terminalColumnsByTaskId?: Record<string, string[]>;
  priorDedupeKeys?: string[];
  taskLogsById?: Record<string, Array<{ action: string; timestamp: string }>>;
}) {
  const openTasks = params.openTasks ?? [];
  const priorDedupeKeys = params.priorDedupeKeys ?? [];
  const taskLogsById = params.taskLogsById ?? {};
  const terminalColumnsByTaskId = params.terminalColumnsByTaskId ?? {};
  return {
    getTaskWorkflowSelection: (taskId: string) =>
      terminalColumnsByTaskId[taskId] ? { workflowId: `wf-${taskId}`, stepIds: [] } : undefined,
    getWorkflowDefinition: async (workflowId: string) => {
      const taskId = workflowId.replace(/^wf-/, "");
      const lanes = terminalColumnsByTaskId[taskId];
      if (!lanes) return undefined;
      return {
        ir: {
          version: "v2",
          id: workflowId,
          name: workflowId,
          nodes: [],
          edges: [],
          columns: [
            { id: "backlog", name: "Backlog", traits: [{ trait: "hold" }] },
            { id: lanes[0], name: "Complete", traits: [{ trait: "complete" }] },
          ],
        },
      };
    },
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

  /*
  FNXC:WorkflowLifecycleColumns 2026-07-31-06:40 (engine feed):
  THE INVARIANT: "open" is the negation of the card's OWN terminal lanes.

  Census-invisible: the old gate was `OPEN_COLUMNS`, a `Set` literal — a definition, not a
  comparison — so nothing in the lifecycle backlog pointed at this file.

  On a renamed board that set matched NOTHING, so `openTasks` was empty and this dedup had no live
  work to compare against. Every eval run re-filed follow-ups it had already filed. The symptom is
  DUPLICATE TASK CREATION, which reads as the evaluator being thorough rather than as a bug.

  REVERT PROOF, measured: restore `OPEN_COLUMNS.has(task.column)` and the first case below fails —
  the duplicate is created instead of suppressed.
  */
  it("suppresses a duplicate of an open task sitting in a RENAMED wip lane", async () => {
    const followUps = await normalizeEvalFollowUps({
      parentTaskId: "FN-1",
      runId: "ER-1",
      overallBand: "weak",
      drafts: [{ title: "Investigate flaky verification command", description: "Investigate flaky verification command causing reruns.", reason: "Failed verification", evidenceRefs: ["workflow-1"] }],
      store: makeStore({
        openTasks: [{ id: "FN-open", column: "building", title: "Investigate flaky verification command", description: "x" }],
        terminalColumnsByTaskId: { "FN-open": ["shipped"] },
      }),
      policyMode: "persist_only",
    });

    expect(followUps[0]?.state).toBe("suppressed");
    expect(followUps[0]?.matchedTaskId).toBe("FN-open");
  });

  it("does NOT suppress against a card in a RENAMED terminal lane", async () => {
    // The dedup must stay scoped to live work: a finished card should not block a fresh follow-up.
    const followUps = await normalizeEvalFollowUps({
      parentTaskId: "FN-1",
      runId: "ER-1",
      overallBand: "weak",
      drafts: [{ title: "Investigate flaky verification command", description: "Investigate flaky verification command causing reruns.", reason: "Failed verification", evidenceRefs: ["workflow-1"] }],
      store: makeStore({
        openTasks: [{ id: "FN-shipped", column: "shipped", title: "Investigate flaky verification command", description: "x" }],
        terminalColumnsByTaskId: { "FN-shipped": ["shipped"] },
      }),
      policyMode: "persist_only",
    });

    expect(followUps[0]?.suppressedReason).not.toBe("duplicate_open_task");
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

  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-19:30 (the dedup blocked NEW follow-ups forever on a renamed board):
  The dedup deliberately excludes closed columns "so a re-run after the follow-up is finished can
  legitimately file a fresh card". Keyed on the literal {done, archived}, a finished follow-up in a RENAMED
  complete lane still read as OPEN — so the dedup matched it forever and the fresh card was never filed.

  The existing reuse case above uses `todo`, which is open under both the old and new logic, so it cannot
  tell them apart. This one puts the prior follow-up in a renamed COMPLETE lane, where the two disagree.

  REVERT CHECK, measured: restoring `CLOSED_FOLLOWUP_COLUMNS` fails this — `createTask` is never called
  because the finished card is treated as an open duplicate.
  */
  it("files a fresh card when the prior follow-up finished in a RENAMED complete lane", async () => {
    const store = makeStore({
      openTasks: [{
        id: "FN-finished",
        column: "shipped",
        description: "finished eval follow-up",
        sourceParentTaskId: "FN-parent",
        sourceMetadata: { suggestionId: "efs-1" },
      }],
      terminalColumnsByTaskId: { "FN-finished": ["shipped"] },
    });

    const [created] = await materializeEvalFollowUps({
      parentTaskId: "FN-parent",
      runId: "ER-6",
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

    expect(store.createTask).toHaveBeenCalled();
    expect(created?.createdTaskId).not.toBe("FN-finished");
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
    // FNXC:Evals 2026-07-26-00:00: the "[verification recurrence]" logEntry assertion here
    // belonged to the deleted shared follow-up dedup engine (which rate-limited a recurrence
    // note on the reused card). The inlined dedup only has to prove no duplicate card is
    // filed and that the existing one is reported back, which is what remains asserted.
    expect(created?.createdTaskId).toBe("FN-existing");
    expect(created?.recommendation.reason).toContain("Reused existing follow-up FN-existing");
  });
});
