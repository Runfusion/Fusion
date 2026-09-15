/*
FNXC:HumanPlanApproval 2026-09-15-06:24:
FN-408 — THE INVARIANT: a card created with the per-card human plan requirement never enters
execution without a CURRENT operator decision, whatever else is true. Not under Fast execution, not
under project `auto-approve-all`, not through an explicit promote, not after an engine restart, and
not while a stale decision from a previous plan or a previous review episode is still on the row.

This suite drives the PRODUCTION entry points rather than the predicate helper:
  1. `runHoldReleaseSweep`      — the background capacity release.
  2. `evaluateTaskReleaseGate`  — the verdict every release surface and the board consume.
  3. `promoteHeldTask`          — the explicit operator promote (`issueRelease`).
  4. `persistWorkflowStepResult`— publishes the decision hold with the satisfied review result.

Surface enumeration (AGENTS.md — "Fix the invariant, not the repro"):
  • Execution admission: hold-release sweep, release gate, explicit promote, implementation entry.
  • Data states: option absent / false / true, decision absent / rejected / stale-plan /
    stale-episode / current, Plan Review pending / satisfied / superseded.
  • Modes: standard, Fast, Fast + auto-approve-all.
  • A card WITHOUT the option is the control in every group: its behavior must be unchanged.
*/
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Task, TaskStore, WorkflowIr } from "@fusion/core";
import { PLAN_REVIEW_GROUP_ID } from "@fusion/core";

import {
  evaluateTaskReleaseGate,
  evaluateUnplannedForExecution,
  promoteHeldTask,
  runHoldReleaseSweep,
  resetHoldReleaseInstrumentation,
} from "../execution/hold-release.js";
import { persistWorkflowStepResult } from "../executor/execute-workflow-graph.js";
import { schedulerLog } from "../logger.js";

const WF = "custom:fn-408-lane";
const EPISODE = "2026-09-15T06:20:00.000Z";
const LATER_EPISODE = "2026-09-15T09:00:00.000Z";
const FINGERPRINT = "f".repeat(64);

/** Plan Review sits in the hold column, before the capacity-bearing wip column. */
function laneIr(): WorkflowIr {
  return {
    version: "v2",
    id: WF,
    name: WF,
    columns: [
      { id: "todo", label: "Todo", traits: [{ trait: "hold", config: { release: "capacity" } }] },
      { id: "in-progress", label: "In progress", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
      { id: "done", label: "Done", traits: [{ trait: "complete" }] },
    ],
    nodes: [
      { id: "start", kind: "start", column: "todo" },
      {
        id: PLAN_REVIEW_GROUP_ID,
        kind: "optional-group",
        column: "todo",
        config: { name: "Plan Review", defaultOn: true, template: { nodes: [], edges: [] } },
      },
      { id: "execute", kind: "prompt", column: "in-progress", config: {} },
    ],
    edges: [
      { from: "start", to: PLAN_REVIEW_GROUP_ID },
      { from: PLAN_REVIEW_GROUP_ID, to: "execute", condition: "success" },
    ],
  } as unknown as WorkflowIr;
}

function planReviewPassed(completedAt = EPISODE, over: Record<string, unknown> = {}) {
  return {
    workflowStepId: PLAN_REVIEW_GROUP_ID,
    workflowStepName: "Plan Review",
    status: "passed",
    completedAt,
    ...over,
  } as NonNullable<Task["workflowStepResults"]>[number];
}

function approval(over: Record<string, unknown> = {}) {
  return {
    requestId: "req-1",
    decision: "approved",
    message: "Fais attention aux migrations",
    decidedBy: "dashboard-operator",
    decidedAt: EPISODE,
    planFingerprint: FINGERPRINT,
    planningEpisodeId: EPISODE,
    ...over,
  } as NonNullable<NonNullable<Task["humanPlanApproval"]>["decision"]>;
}

function task(over: Partial<Task> = {}): Task {
  return {
    id: "FN-408-A",
    title: "t",
    description: "",
    column: "todo",
    status: null,
    prompt: '# Planned\n\n## Plan Premises\n\n- {"kind":"file-exists","path":"package.json"}\n',
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    enabledWorkflowSteps: [PLAN_REVIEW_GROUP_ID],
    approvedPlanFingerprint: FINGERPRINT,
    workflowStepResults: [planReviewPassed()],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    columnMovedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  } as Task;
}

/** A card carrying the per-card requirement and no decision yet. */
function armed(over: Partial<Task> = {}): Task {
  return task({ humanPlanApproval: { enabled: true }, ...over });
}

function laneStore(tasks: Task[]): TaskStore {
  const selection = { workflowId: WF, stepIds: [PLAN_REVIEW_GROUP_ID] };
  const ir = laneIr();
  return {
    getSettings: vi.fn(async () => ({ maxConcurrent: 4 })),
    getRootDir: () => process.cwd(),
    listTasks: vi.fn(async () => tasks),
    getTask: vi.fn(async (id: string) => tasks.find((t) => t.id === id) ?? null),
    moveTaskIf: vi.fn(async (
      id: string,
      column: string,
      predicate: (live: Task) => boolean | Promise<boolean>,
    ) => {
      const cur = tasks.find((t) => t.id === id)!;
      if (!(await predicate(cur))) return { task: cur, moved: false };
      cur.column = column;
      return { task: cur, moved: true };
    }),
    moveTask: vi.fn(async (id: string, column: string) => {
      const cur = tasks.find((t) => t.id === id)!;
      cur.column = column;
      return cur;
    }),
    updateTaskAtomic: vi.fn(async (id: string, mutate: (live: Task) => Partial<Task> | null | Promise<Partial<Task> | null>) => {
      const cur = tasks.find((candidate) => candidate.id === id)!;
      const patch = await mutate(cur);
      if (patch) Object.assign(cur, patch);
      return cur;
    }),
    updateTask: vi.fn(async (id: string, patch: Partial<Task>) => {
      const cur = tasks.find((candidate) => candidate.id === id)!;
      Object.assign(cur, patch);
      return cur;
    }),
    logEntry: vi.fn(async () => undefined),
    recordRunAuditEvent: vi.fn(async () => undefined),
    getCompletionHandoffAcceptedMarker: vi.fn(async () => null),
    listWorkflowWorkItemsForTask: vi.fn(async () => []),
    checkAndRecordUnplannedExecutionBlock: vi.fn(async () => undefined),
    getTaskWorkflowSelection: vi.fn(() => selection),
    getTaskWorkflowSelectionAsync: vi.fn(async () => selection),
    getWorkflowDefinition: vi.fn(async () => ({ ir })),
  } as unknown as TaskStore;
}

beforeEach(() => {
  resetHoldReleaseInstrumentation();
  vi.restoreAllMocks();
  vi.spyOn(schedulerLog, "log").mockImplementation(() => {});
  vi.spyOn(schedulerLog, "debug").mockImplementation(() => {});
  vi.spyOn(schedulerLog, "warn").mockImplementation(() => {});
});

// ─────────────────────────────────────────────────────────────────────────────
// #1 — the background capacity release
// ─────────────────────────────────────────────────────────────────────────────

describe("#1 the capacity release withholds an armed card until the operator decides", () => {
  it("releases a card WITHOUT the option (control — the fixture can release)", async () => {
    const control = task({ id: "CONTROL" });
    const result = await runHoldReleaseSweep(laneStore([control]), { now: () => 1_000_000 });

    expect(result.released).toContain("CONTROL");
    expect(control.column).toBe("in-progress");
  });

  it("releases a card whose option is explicitly false", async () => {
    const off = task({ id: "OFF", humanPlanApproval: { enabled: false } });
    await runHoldReleaseSweep(laneStore([off]), { now: () => 1_000_000 });

    expect(off.column).toBe("in-progress");
  });

  it("withholds an armed card whose Plan Review passed but has no decision", async () => {
    const held = armed({ id: "ARMED" });
    const result = await runHoldReleaseSweep(laneStore([held]), { now: () => 1_000_000 });

    expect(held.column).toBe("todo");
    expect(result.released).not.toContain("ARMED");
  });

  it("withholds an armed card even under Fast execution and project auto-approve-all", async () => {
    /*
    Fast is planless and normally short-circuits the pre-release Plan Review wait, and
    auto-approve-all normally removes every manual gate. The per-card requirement outranks both.
    */
    const fast = armed({ id: "FAST", executionMode: "fast", workflowStepResults: [] });
    const store = laneStore([fast]);
    (store.getSettings as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      maxConcurrent: 4,
      planApprovalMode: "auto-approve-all",
    });

    await runHoldReleaseSweep(store, { now: () => 1_000_000 });

    expect(fast.column).toBe("todo");
  });

  it("releases an armed card once a current approval exists", async () => {
    const ok = armed({ id: "APPROVED", humanPlanApproval: { enabled: true, decision: approval() } });
    const result = await runHoldReleaseSweep(laneStore([ok]), { now: () => 1_000_000 });

    expect(result.released).toContain("APPROVED");
    expect(ok.column).toBe("in-progress");
  });

  it("withholds when the decision was a rejection", async () => {
    const rejected = armed({
      id: "REJECTED",
      humanPlanApproval: { enabled: true, decision: approval({ decision: "rejected", message: "Refais le plan" }) },
    });
    await runHoldReleaseSweep(laneStore([rejected]), { now: () => 1_000_000 });

    expect(rejected.column).toBe("todo");
  });

  it("withholds when the approval belongs to a different plan", async () => {
    const stalePlan = armed({
      id: "STALE-PLAN",
      approvedPlanFingerprint: "9".repeat(64),
      humanPlanApproval: { enabled: true, decision: approval() },
    });
    await runHoldReleaseSweep(laneStore([stalePlan]), { now: () => 1_000_000 });

    expect(stalePlan.column).toBe("todo");
  });

  it("withholds a byte-identical plan regenerated after a rejection (same fingerprint, new episode)", async () => {
    /*
    This is the case `approvedPlanFingerprint` alone can never catch: the regenerated plan hashes
    identically, so only the review-episode identity distinguishes the new plan from the rejected one.
    */
    const regenerated = armed({
      id: "REGENERATED",
      workflowStepResults: [
        planReviewPassed(EPISODE, { supersededAt: EPISODE, supersededReason: "respecify" }),
        planReviewPassed(LATER_EPISODE),
      ],
      humanPlanApproval: { enabled: true, decision: approval() },
    });
    await runHoldReleaseSweep(laneStore([regenerated]), { now: () => 1_000_000 });

    expect(regenerated.column).toBe("todo");
  });

  it("withholds even when the decision hold status was never published (crash between the two writes)", async () => {
    // The satisfied review landed but `awaiting-approval` did not; a status-only gate would release.
    const noStatus = armed({ id: "NO-STATUS", status: null });
    await runHoldReleaseSweep(laneStore([noStatus]), { now: () => 1_000_000 });

    expect(noStatus.column).toBe("todo");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #2 — the structured release verdict
// ─────────────────────────────────────────────────────────────────────────────

describe("#2 the release gate reports the per-card decision as its own reason", () => {
  it("names human-plan-approval-pending for an armed undecided card", async () => {
    const held = armed();
    const verdict = await evaluateTaskReleaseGate(laneStore([held]), held);

    expect(verdict?.promoteBlocked).toBe(true);
    expect(verdict?.reason).toBe("human-plan-approval-pending");
  });

  it("does not confuse the per-card hold with plan-review-pending", async () => {
    const pendingReview = armed({ workflowStepResults: [] });
    const evaluation = await evaluateUnplannedForExecution(laneStore([pendingReview]), pendingReview, laneIr());

    // Review has not run yet, so the earlier gate owns the refusal — but it is still a refusal.
    expect(evaluation.unplanned).toBe(true);
    expect(evaluation.reason).toBe("plan-review-pending");
  });

  it("clears once the operator approves", async () => {
    const ok = armed({ humanPlanApproval: { enabled: true, decision: approval() } });
    const verdict = await evaluateTaskReleaseGate(laneStore([ok]), ok);

    expect(verdict?.promoteBlocked).toBe(false);
    expect(verdict?.reason).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #3 — explicit operator promote
// ─────────────────────────────────────────────────────────────────────────────

describe("#3 explicit promote cannot bypass the decision", () => {
  it("refuses to promote an armed undecided card", async () => {
    const held = armed({ id: "PROMOTE" });
    const outcome = await promoteHeldTask(laneStore([held]), "PROMOTE");

    expect(held.column).toBe("todo");
    expect(outcome.released).toBe(false);
  });

  it("promotes the same card after approval", async () => {
    const ok = armed({ id: "PROMOTE-OK", humanPlanApproval: { enabled: true, decision: approval() } });
    const outcome = await promoteHeldTask(laneStore([ok]), "PROMOTE-OK");

    expect(outcome.released).toBe(true);
    expect(ok.column).toBe("in-progress");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #4 — publishing the hold with the satisfied review result
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// #5 — the whole chain, in order
// ─────────────────────────────────────────────────────────────────────────────

describe("#5 the full chain: plan -> review -> decision -> execution", () => {
  /*
  The acceptance requirement in one test, with the hardest settings turned on the whole time:
  Fast execution AND project auto-approve-all. The card must still stop, a rejection must carry the
  operator message into the revision, and only an approval on the NEW plan may release execution.
  */
  it("holds under Fast + auto-approve-all, re-plans on reject, and releases only after approving the new plan", async () => {
    const card = armed({ id: "CHAIN", executionMode: "fast", workflowStepResults: [] });
    const store = laneStore([card]);
    (store.getSettings as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      maxConcurrent: 4,
      planApprovalMode: "auto-approve-all",
    });
    const sweep = () => runHoldReleaseSweep(store, { now: () => 1_000_000 });

    // 1. Plan written, review not run yet: no execution.
    await sweep();
    expect(card.column).toBe("todo");

    // 2. Plan Review passes. Still no execution: the operator has not decided.
    card.workflowStepResults = [planReviewPassed(EPISODE)];
    await sweep();
    expect(card.column).toBe("todo");
    expect((await evaluateTaskReleaseGate(store, card))?.reason).toBe("human-plan-approval-pending");

    // 3. Reject with a message. The plan is retired as revision source and the card stays in place.
    card.workflowStepResults = [planReviewPassed(EPISODE, { supersededAt: EPISODE, supersededReason: "respecify" })];
    card.approvedPlanFingerprint = undefined;
    card.status = "needs-replan";
    card.humanPlanApproval = {
      enabled: true,
      decision: {
        requestId: "r-reject",
        decision: "rejected",
        message: "Le périmètre est trop large",
        decidedBy: "dashboard-operator",
        decidedAt: EPISODE,
        planFingerprint: FINGERPRINT,
        planningEpisodeId: EPISODE,
      },
    };
    await sweep();
    expect(card.column).toBe("todo");

    // 4. A NEW plan passes review. The rejection record must not release it, and neither may the
    //    old approval identity — even though the regenerated plan hashes identically.
    card.status = null;
    card.approvedPlanFingerprint = FINGERPRINT;
    card.workflowStepResults = [
      planReviewPassed(EPISODE, { supersededAt: EPISODE, supersededReason: "respecify" }),
      planReviewPassed(LATER_EPISODE),
    ];
    await sweep();
    expect(card.column).toBe("todo");

    // 5. Approve the NEW plan with a note. Only now may the card enter execution.
    card.humanPlanApproval = {
      enabled: true,
      decision: {
        requestId: "r-approve",
        decision: "approved",
        message: "Fais attention aux migrations",
        decidedBy: "dashboard-operator",
        decidedAt: LATER_EPISODE,
        planFingerprint: FINGERPRINT,
        planningEpisodeId: LATER_EPISODE,
      },
    };
    const released = await sweep();
    expect(released.released).toContain("CHAIN");
    expect(card.column).toBe("in-progress");
  });

  it("survives an engine restart: durable state alone still withholds, with no status to rely on", async () => {
    /*
    A restart loses every in-memory hold. The card is reconstructed from the database with its
    status never published (the crash-between-writes shape), so only the durable decision can
    refuse it — which is exactly what the shared predicate reads.
    */
    const rebooted = armed({ id: "REBOOT", status: null, awaitingApprovalReason: undefined });
    const store = laneStore([rebooted]);

    await runHoldReleaseSweep(store, { now: () => 2_000_000 });
    expect(rebooted.column).toBe("todo");

    // And the pre-rejection approval identity cannot release the post-rejection plan after restart.
    rebooted.humanPlanApproval = {
      enabled: true,
      decision: {
        requestId: "old",
        decision: "approved",
        decidedBy: "dashboard-operator",
        decidedAt: EPISODE,
        planFingerprint: FINGERPRINT,
        planningEpisodeId: EPISODE,
      },
    };
    rebooted.workflowStepResults = [
      planReviewPassed(EPISODE, { supersededAt: EPISODE, supersededReason: "respecify" }),
      planReviewPassed(LATER_EPISODE),
    ];
    await runHoldReleaseSweep(store, { now: () => 2_000_000 });
    expect(rebooted.column).toBe("todo");
  });
});

describe("#4 the decision hold is published with the satisfied Plan Review result", () => {
  function persistDeps(rows: Task[]) {
    return {
      store: {
        updateTask: vi.fn(async (id: string, patch: Partial<Task>) => {
          const cur = rows.find((t) => t.id === id)!;
          Object.assign(cur, patch);
          return cur;
        }),
        getTask: vi.fn(async (id: string) => rows.find((t) => t.id === id) ?? null),
        isBackendMode: () => false,
        logEntry: vi.fn(async () => undefined),
        recordRunAuditEvent: vi.fn(async () => undefined),
      } as unknown as TaskStore,
      getRunContextFor: () => undefined,
      readTaskArtifact: vi.fn(async () => undefined),
    };
  }

  it("stamps awaiting-approval with its own reason for an armed card", async () => {
    const row = armed({ id: "PUB", workflowStepResults: [] });
    const deps = persistDeps([row]);

    await persistWorkflowStepResult(deps as never, "PUB", planReviewPassed() as never);

    expect(row.status).toBe("awaiting-approval");
    expect(row.awaitingApprovalReason).toBe("human-plan-approval");
  });

  it("leaves a card without the option untouched (control)", async () => {
    const row = task({ id: "PUB-CONTROL", workflowStepResults: [], status: null });
    const deps = persistDeps([row]);

    await persistWorkflowStepResult(deps as never, "PUB-CONTROL", planReviewPassed() as never);

    expect(row.status).toBeNull();
    expect(row.awaitingApprovalReason).toBeUndefined();
  });

  it("does not stamp the hold for a REVISE verdict", async () => {
    const row = armed({ id: "PUB-REVISE", workflowStepResults: [], status: null });
    const deps = persistDeps([row]);

    await persistWorkflowStepResult(
      deps as never,
      "PUB-REVISE",
      planReviewPassed(EPISODE, { status: "failed", verdict: "REVISE" }) as never,
    );

    expect(row.status).toBeNull();
  });
});
