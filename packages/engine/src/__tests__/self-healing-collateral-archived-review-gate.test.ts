import { afterEach, describe, expect, it, vi } from "vitest";
import { getLatestFailedPreMergeReviewStep, getTaskMergeBlocker, type Task, type WorkflowIr, type WorkflowStepResult } from "@fusion/core";
import { SelfHealingManager } from "../self-healing.js";

/*
FNXC:PreMergeApproval 2026-09-05-22:11:
FN-295's exact wedge: a Plan Review row left `pending` by a dead session, rewritten to `failed` by the
orphaned-step sweep, then archived as collateral of a Code Review remediation. The archived carrier is a
permanent merge veto that no reseed, reroute, or operator bypass can select. These cases assert the
restoration behaviourally through `getTaskMergeBlocker`, never by reading source text.
*/

const now = "2026-09-04T10:30:42.298Z";
const managers: SelfHealingManager[] = [];

function archivedPlanReview(overrides: Partial<WorkflowStepResult> = {}): WorkflowStepResult {
  return {
    workflowStepId: "plan-review",
    workflowStepName: "Plan Review",
    phase: "pre-merge",
    status: "skipped",
    reviewKind: "plan",
    startedAt: now,
    completedAt: now,
    remediationArchivedAt: "2026-09-04T19:28:37.579Z",
    remediationArchivedFromStatus: "failed",
    ...overrides,
  };
}

function approvedCodeReview(overrides: Partial<WorkflowStepResult> = {}): WorkflowStepResult {
  return {
    workflowStepId: "code-review",
    workflowStepName: "Code Review",
    phase: "pre-merge",
    status: "passed",
    verdict: "APPROVE",
    reviewKind: "code",
    reviewInputFingerprint: "current",
    startedAt: now,
    completedAt: now,
    ...overrides,
  };
}

function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: "Collaterally archived review gate",
    description: "Restore a gate archived by another gate's remediation",
    column: "in-review",
    dependencies: [],
    /* The open remediation wave belongs to Code Review — Plan Review was collateral. */
    steps: [{ name: "Fix: reconciliation stalls", status: "done", remediation: { wave: 1, gate: "Code Review", gateStepId: "code-review", detail: "…" } }],
    currentStep: 0,
    log: [],
    status: null,
    error: null,
    paused: false,
    userPaused: false,
    createdAt: now,
    updatedAt: now,
    enabledWorkflowSteps: ["plan-review", "code-review"],
    worktree: process.cwd(),
    workflowStepResults: [archivedPlanReview(), approvedCodeReview()],
    ...overrides,
  } as Task;
}

function workflow(): WorkflowIr {
  return {
    version: "v2",
    name: "review lanes",
    columns: [
      { id: "todo", name: "Planning", traits: [{ trait: "hold", config: { release: "capacity" } }] },
      { id: "in-progress", name: "Work", traits: [{ trait: "wip" }] },
      { id: "in-review", name: "Review", traits: [{ trait: "merge-blocker" }] },
      { id: "done", name: "Done", traits: [{ trait: "complete" }] },
    ],
    nodes: [
      { id: "start", kind: "start", column: "todo" },
      { id: "plan-review", kind: "optional-group", column: "todo", config: { name: "Plan Review", defaultOn: true, template: { nodes: [], edges: [] } } },
      { id: "code-review", kind: "optional-group", column: "in-review", config: { name: "Code Review", defaultOn: true, template: { nodes: [], edges: [] } } },
      { id: "end", kind: "end", column: "done" },
    ],
    edges: [{ from: "start", to: "plan-review" }, { from: "plan-review", to: "code-review" }, { from: "code-review", to: "end" }],
  } as WorkflowIr;
}

function harness(rows: Task[], options: { isTaskActive?: (taskId: string) => boolean } = {}) {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const auditEvents: Record<string, unknown>[] = [];
  const ir = workflow();
  const store = {
    listWorkflowDefinitions: vi.fn(async () => [{ id: "wf-test", ir }]),
    getWorkflowDefinition: vi.fn(async () => ({ id: "wf-test", ir })),
    getTaskWorkflowSelection: vi.fn(() => ({ workflowId: "wf-test" })),
    listTasks: vi.fn(async (query: { column?: string }) => [...byId.values()].filter((row) => !query.column || row.column === query.column)),
    getTask: vi.fn(async (id: string) => byId.get(id)),
    getSettings: vi.fn(async () => ({ autoMerge: true })),
    updateTask: vi.fn(async (id: string, patch: Partial<Task>) => {
      const row = byId.get(id);
      if (!row) throw new Error(`missing ${id}`);
      Object.assign(row, patch);
      return row;
    }),
    updateTaskAtomic: vi.fn(async (
      id: string,
      updater: (current: Task) => Partial<Task> | null | undefined | Promise<Partial<Task> | null | undefined>,
    ) => {
      const row = byId.get(id);
      if (!row) throw new Error(`missing ${id}`);
      const patch = await updater(row);
      if (patch) Object.assign(row, patch);
      return row;
    }),
    logEntry: vi.fn(async () => undefined),
    recordRunAuditEvent: vi.fn(async (event: Record<string, unknown>) => { auditEvents.push(event); }),
  };
  const manager = new SelfHealingManager(store as never, { rootDir: process.cwd(), isTaskActive: options.isTaskActive });
  managers.push(manager);
  return { manager, store, auditEvents };
}

const mergeContent = { kind: "singular" as const, diff: { state: "fingerprint" as const, fingerprint: "current" } };
const required = new Set(["plan-review", "code-review"]);

afterEach(() => {
  for (const manager of managers.splice(0)) manager.stop();
});

describe("reconcileCollateralArchivedReviewGates", () => {
  it("restores the collateral carrier so the card stops being unrecoverable", async () => {
    const row = task("FN-295");
    expect(getTaskMergeBlocker(row, { requiredPreMergeStepIds: required, mergeContent }))
      .toBe("task has enabled pre-merge workflow steps without a current approval (gate 'plan-review')");
    /* Before: the audited operator bypass has nothing to select — that is the wedge. */
    expect(getLatestFailedPreMergeReviewStep(row)).toBeUndefined();

    const { manager, store, auditEvents } = harness([row]);
    await expect(manager.reconcileCollateralArchivedReviewGates()).resolves.toBe(1);

    const restored = row.workflowStepResults?.find((entry) => entry.workflowStepId === "plan-review");
    expect(restored).toMatchObject({ status: "failed" });
    expect(restored).not.toHaveProperty("remediationArchivedAt");
    expect(restored).not.toHaveProperty("remediationArchivedFromStatus");
    /* No verdict is fabricated: the gate is recoverable, not approved. */
    expect(restored).not.toHaveProperty("verdict");
    /*
    After: the gate is selectable by the FN-7720 audited bypass, which is the recovery this sweep
    restores. The card stays BLOCKED — self-healing repairs reachability, it never grants approval.
    */
    expect(getLatestFailedPreMergeReviewStep(row)).toMatchObject({ workflowStepId: "plan-review", status: "failed" });
    expect(getTaskMergeBlocker(row, { requiredPreMergeStepIds: required, mergeContent }))
      .toBe("task has enabled pre-merge workflow steps without a current approval (gate 'plan-review')");
    expect(row.workflowStepResults?.find((entry) => entry.workflowStepId === "code-review")).toEqual(approvedCodeReview());
    expect(store.logEntry).toHaveBeenCalledWith(row.id, expect.stringContaining("plan-review"), expect.any(String));

    const event = auditEvents[0] as { mutationType: string; metadata: Record<string, unknown> };
    expect(event.mutationType).toBe("task:reconcile-collateral-archived-review-gate");
    expect(event.metadata).toEqual({
      taskId: row.id, column: "in-review", workflowStepId: "plan-review", restoredCount: 1, resultCount: 2,
    });

    /* Idempotent: a second pass finds nothing and emits nothing. */
    await expect(manager.reconcileCollateralArchivedReviewGates()).resolves.toBe(0);
    expect(auditEvents).toHaveLength(1);
  });

  it.each([
    ["the gate that owns the remediation wave", { workflowStepResults: [archivedPlanReview({ workflowStepId: "code-review", workflowStepName: "Code Review", reviewKind: "code" })] }],
    ["an audited operator waiver", { workflowStepResults: [archivedPlanReview({ bypassedBy: "operator", bypassReason: "known non-blocking" })] }],
    ["a user-paused card", { userPaused: true }],
    ["a workspace card", { workspaceWorktrees: { "repo-a": { worktreePath: "/tmp/repo-a" } } }],
    ["a gate the workflow no longer requires", { enabledWorkflowSteps: ["code-review"] }],
  ])("never touches %s", async (_label, overrides) => {
    const row = task("FN-GUARD", overrides as Partial<Task>);
    const before = structuredClone(row.workflowStepResults);
    const { manager, store, auditEvents } = harness([row]);

    await expect(manager.reconcileCollateralArchivedReviewGates()).resolves.toBe(0);

    expect(row.workflowStepResults).toEqual(before);
    expect(store.logEntry).not.toHaveBeenCalled();
    expect(auditEvents).toEqual([]);
  });

  it("never touches a card whose session is live", async () => {
    const row = task("FN-LIVE");
    const before = structuredClone(row.workflowStepResults);
    const { manager, auditEvents } = harness([row], { isTaskActive: (id) => id === "FN-LIVE" });

    await expect(manager.reconcileCollateralArchivedReviewGates()).resolves.toBe(0);
    expect(row.workflowStepResults).toEqual(before);
    expect(auditEvents).toEqual([]);
  });

  it("restores an advisory_failure carrier on a renamed review lane", async () => {
    const row = task("FN-ADVISORY", {
      workflowStepResults: [archivedPlanReview({ remediationArchivedFromStatus: "advisory_failure" }), approvedCodeReview()],
    });
    const { manager } = harness([row]);

    await expect(manager.reconcileCollateralArchivedReviewGates()).resolves.toBe(1);
    expect(row.workflowStepResults?.[0]).toMatchObject({ status: "advisory_failure" });
  });
});
