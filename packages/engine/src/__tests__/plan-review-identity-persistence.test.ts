/*
FNXC:CurrentPlanReviewIdentity 2026-10-11-11:50:
Plan Review (review validation) — production persistence-adapter regression for the approval-anchor seam
(persistWorkflowStepResultWithOutcome, execute-workflow-graph.ts). This is the SECOND independent
Plan Review authority: a satisfied anchor may only be stamped when the incoming result's
dispatch-captured `reviewedInputIdentity` validates — inside the existing planning-lifecycle lock
and attempt fences — against the CURRENT plan (fresh under-lock read), the CURRENT resolved
workflow pin, and the fenced attempt identity. A stale/unprovable application persists the genuine
row as honest history but writes no `approvedPlanFingerprint`, takes no spec lock, and reconciles
no plan drift. Fixture proof values belong in fixtures only.
*/
import { describe, expect, it, vi } from "vitest";
import {
  UnavailablePlanLockError,
  computePlanApprovalFingerprint,
  computeWorkflowIrPin,
  resolveWorkflowIrForTask,
  type Task,
  type WorkflowIr,
  type WorkflowStepResult,
} from "@fusion/core";
import {
  persistWorkflowStepResult,
  persistWorkflowStepResultWithOutcome,
} from "../executor/execute-workflow-graph.js";

const PLAN_A = "# Plan A\n\noriginal contract";
const PLAN_B = "# Plan B\n\nrevised contract nobody reviewed";
/*
FNXC:CurrentPlanReviewIdentity 2026-10-11-17:05:
Genuine attempt data (R4): the real graph stamps `stepStartedAt` as an ISO timestamp and a DISTINCT
later completion. The anchor validator refuses unparseable or non-strictly-ordered original times,
so an arbitrary token string is no longer a legal positive fixture — corrected here rather than
weakening the validator. Lease identity: the pending claim row's genuine `leaseOwner` equals the
proof's `runAttemptId` exactly as the production claim writer stamps it for a genuine attempt.
*/
const ATTEMPT = "2026-10-11T15:00:00.000Z";
const COMPLETED = "2026-10-11T15:00:05.000Z";
const LEASE_OWNER = "run-under-test";

function anchorIr(): WorkflowIr {
  return {
    version: "v2",
    name: "current-plan-review-anchor-seam",
    columns: [{ id: "todo", name: "Todo", traits: [] }],
    nodes: [
      { id: "start", kind: "start", column: "todo" },
      {
        id: "plan-review",
        kind: "optional-group",
        column: "todo",
        config: {
          name: "Plan Review",
          reviewKind: "plan",
          defaultOn: true,
          template: {
            nodes: [{ id: "plan-review-step", kind: "prompt", config: { prompt: "review the plan" } }],
            edges: [],
          },
        },
      },
      { id: "execute", kind: "prompt", column: "todo", config: { prompt: "execute" } },
      { id: "end", kind: "end", column: "todo" },
    ],
    edges: [
      { from: "start", to: "plan-review" },
      { from: "plan-review", to: "execute", condition: "success" },
      { from: "execute", to: "end" },
    ],
  };
}

interface SeamHarness {
  task: Task;
  store: Record<string, unknown>;
  updateTask: ReturnType<typeof vi.fn>;
  lockCurrentPlanWhilePlanningLocked: ReturnType<typeof vi.fn>;
  reconcileSpecDriftWhilePlanningLocked: ReturnType<typeof vi.fn>;
  setArtifact: (content: string | undefined) => void;
  /** Move the durable workflow selection the seam resolves against: "explicit" keeps the custom
   *  selection (definition = `ir`), "absent" is a SUCCESSFUL no-selection read (the default
   *  workflow then governs), "throwing" fails the selection read — where the fail-soft core
   *  resolver would INVISIBLY substitute the default, so only the strict Plan Review provenance
   *  classification can tell a successful default read from that read failure. */
  setSelectionMode: (mode: "explicit" | "absent" | "throwing") => void;
  /** Fires inside the REAL fenced apply-check, on its fresh re-read, immediately before the patch
   *  is computed — models the exact window a competing lease reclaim races in production. */
  setApplyBoundaryHook: (hook: ((current: Task) => void) | undefined) => void;
  persist: (result: WorkflowStepResult, fence?: Record<string, unknown>) => Promise<unknown>;
  persistOutcome: (result: WorkflowStepResult, fence?: Record<string, unknown>) => Promise<unknown>;
}

/** Store fakes wired for backend mode (the only mode where the anchor branch runs at all) with the
 *  real artifact-read path controllable per test. Production receipts throughout. */
function harness(opts: { artifact?: string; ir?: WorkflowIr } = {}): SeamHarness {
  let artifact: string | undefined = opts.artifact ?? PLAN_A;
  const ir = opts.ir ?? anchorIr();
  let selectionMode: "explicit" | "absent" | "throwing" = "explicit";
  let applyBoundaryHook: ((current: Task) => void) | undefined;
  const task = {
    id: "FN-Plan Review-SEAM",
    column: "todo",
    workflowStepResults: [
      {
        workflowStepId: "plan-review",
        workflowStepName: "Plan Review",
        phase: "pre-merge",
        source: "optional-group",
        status: "pending",
        startedAt: ATTEMPT,
        leaseOwner: LEASE_OWNER,
      },
    ],
  } as unknown as Task;

  const updateTask = vi.fn(async (_id: string, patch: Partial<Task>) => {
    Object.assign(task, patch);
    return task;
  });
  const lockCurrentPlanWhilePlanningLocked = vi.fn(async () => undefined);
  const reconcileSpecDriftWhilePlanningLocked = vi.fn(async () => undefined);
  const store = {
    getTask: vi.fn(async () => task),
    updateTask,
    // Core fenced tier — mirrors the production writer tier these fences enforce. The real writer
    // re-reads durably inside its transaction before applying; a boundary hook models exactly the
    // reclaim that can land between the outer lifecycle-lock read and this apply-check.
    updateWorkflowStepResultsFenced: vi.fn(async (_id: string, compute: (current: Task) => Partial<Task> | null) => {
      applyBoundaryHook?.(task);
      const patch = compute(task);
      if (!patch) return { applied: false, reason: "refused" } as const;
      Object.assign(task, patch);
      return { applied: true, task };
    }),
    isBackendMode: vi.fn(() => true),
    withPlanningLifecycleLock: vi.fn(async (_id: string, callback: () => Promise<void>) => {
      await callback();
    }),
    lockCurrentPlanWhilePlanningLocked,
    reconcileSpecDriftWhilePlanningLocked,
    recordAgentActivity: vi.fn(async () => undefined),
    logEntry: vi.fn(async () => undefined),
    // WorkflowIrResolverStore surface for the seam's CURRENT-workflow validation. The ASYNC form
    // is what the real resolver prefers, so selection movement (and a read failure) are exercised
    // on the same read path production takes — never through a sync fallback a live store skips.
    getTaskWorkflowSelection: () => (selectionMode === "explicit" ? { workflowId: "WF-Plan Review", stepIds: [] } : undefined),
    getWorkflowDefinition: async (id: string) => (id === "WF-Plan Review" ? { ir } : undefined),
  };
  // The resolver's async selection preference is exactly what a backend-mode store exposes.
  Object.defineProperty(store, "getTaskWorkflowSelectionAsync", {
    configurable: true,
    get: () => async () => {
      if (selectionMode === "throwing") throw new Error("durable selection read failed");
      return selectionMode === "explicit" ? { workflowId: "WF-Plan Review", stepIds: [] } : undefined;
    },
  });
  const deps = {
    store,
    getRunContextFor: () => undefined,
    readTaskArtifact: async (_taskId: string, _key: string) => artifact,
  } as never;

  return {
    task,
    store,
    updateTask,
    lockCurrentPlanWhilePlanningLocked,
    reconcileSpecDriftWhilePlanningLocked,
    setArtifact: (content) => { artifact = content; },
    setSelectionMode: (mode) => { selectionMode = mode; },
    setApplyBoundaryHook: (hook) => { applyBoundaryHook = hook; },
    persist: (result, fence) => persistWorkflowStepResult(deps, task.id, result, fence as never),
    persistOutcome: (result, fence) => persistWorkflowStepResultWithOutcome(deps, task.id, result, fence as never),
  };
}

/** The genuine terminal row a graph attempt writes: proof captured before dispatch (plan A),
 *  attempt identity bound to the claimed lease, distinct original times. */
function passedPlanReview(opts: {
  planFingerprint?: string;
  pinOverride?: { nodeId: string; irHash: string; columnId?: string };
  omitProof?: boolean;
  startedAt?: string;
} = {}): WorkflowStepResult {
  const startedAt = opts.startedAt ?? ATTEMPT;
  const pin = opts.pinOverride ?? { nodeId: "plan-review", irHash: "PIN-NOT-OVERRIDDEN", columnId: "todo" };
  return {
    workflowStepId: "plan-review",
    workflowStepName: "Plan Review",
    phase: "pre-merge",
    source: "optional-group",
    status: "passed",
    verdict: "APPROVE",
    reviewKind: "plan",
    startedAt,
    completedAt: COMPLETED,
    ...(opts.omitProof ? {} : {
      reviewedInputIdentity: {
        planFingerprint: opts.planFingerprint ?? computePlanApprovalFingerprint(PLAN_A),
        workflowPin: pin,
        runAttemptId: LEASE_OWNER,
        attemptStartedAt: startedAt,
      },
    }),
  };
}

describe("Plan Review approval-anchor dispatch-proof validation (Plan Review 8B)", () => {
  it("1. stale review before persistence: captured plan A vs current plan B stamps NO anchor", async () => {
    const h = harness({ artifact: PLAN_B });
    // Proof honestly says A; the current artifact is B.
    const result = passedPlanReview();

    const outcome = await h.persistOutcome(result, { requireAttemptStartedAt: ATTEMPT });

    expect(outcome).toMatchObject({ scopeCurrent: true, persisted: true, disposition: "applied" });
    // No satisfied-anchor application: no fingerprint, no spec lock, no drift reconciliation.
    expect(h.task.approvedPlanFingerprint).toBeUndefined();
    expect(h.lockCurrentPlanWhilePlanningLocked).not.toHaveBeenCalled();
    expect(h.reconcileSpecDriftWhilePlanningLocked).not.toHaveBeenCalled();
    // The genuine reviewer evidence persists unchanged — honestly attributed to what it reviewed.
    const row = (h.task.workflowStepResults ?? [])[0];
    expect(row).toMatchObject({
      workflowStepId: "plan-review",
      status: "passed",
      verdict: "APPROVE",
      startedAt: ATTEMPT,
      completedAt: COMPLETED,
    });
    expect(row?.reviewedInputIdentity?.planFingerprint).toBe(computePlanApprovalFingerprint(PLAN_A));
  });

  it("2. identity movement during persistence: A→B while the plan lock is awaited refuses a B anchor", async () => {
    const h = harness({ artifact: PLAN_A });
    // The plan changes after the pre-lock read but before the under-lock re-read.
    h.store.withPlanningLifecycleLock = vi.fn(async (_id: string, callback: () => Promise<void>) => {
      h.setArtifact(PLAN_B);
      await callback();
    });

    await h.persistOutcome(passedPlanReview(), { requireAttemptStartedAt: ATTEMPT });

    expect(h.task.approvedPlanFingerprint).toBeUndefined();
    expect(h.lockCurrentPlanWhilePlanningLocked).not.toHaveBeenCalled();
  });

  it("3. displaced attempt: proof whose attempt identity is not the fenced one refuses", async () => {
    const h = harness({ artifact: PLAN_A });
    // The fence names a NEWER claim than the proof's attempt — the displaced attempt must not land.
    const outcome = await h.persistOutcome(
      passedPlanReview(),
      { requireAttemptStartedAt: "run-under-test:newer-claim" },
    );

    expect(outcome).toEqual({ scopeCurrent: true, persisted: false, disposition: "fence-refused" });
    expect(h.task.approvedPlanFingerprint).toBeUndefined();
    expect(h.store.updateWorkflowStepResultsFenced).not.toHaveBeenCalled();
    expect(h.updateTask).not.toHaveBeenCalled();
  });

  it("4. absent proof: old-record row persists without an anchor; preserved branches keep behavior", async () => {
    const h = harness({ artifact: PLAN_A });
    const outcome = await h.persistOutcome(
      passedPlanReview({ omitProof: true }),
      { requireAttemptStartedAt: ATTEMPT },
    );

    expect(outcome).toMatchObject({ persisted: true, disposition: "applied" });
    // 8B #4: no anchor via an unprovable application.
    expect(h.task.approvedPlanFingerprint).toBeUndefined();
    expect(h.lockCurrentPlanWhilePlanningLocked).not.toHaveBeenCalled();
  });

  it("4b. preserved plan-lock-unavailable diagnostic runs when the proof IS valid", async () => {
    const h = harness({ artifact: PLAN_A });
    // Bind the proof to the CURRENT resolved workflow so the pin check passes.
    const ir = anchorIr();
    const resolved = await resolveWorkflowIrForTask(h.store as never, h.task.id);
    const pin = computeWorkflowIrPin(resolved, "plan-review");
    expect(pin.nodeId).toBe(ir.nodes[1].id);
    h.store.lockCurrentPlanWhilePlanningLocked = vi.fn(async () => {
      throw new UnavailablePlanLockError("section-duplicate", ["non-goals"], "source-hash");
    });

    const outcome = await h.persistOutcome(
      passedPlanReview({ pinOverride: pin }),
      { requireAttemptStartedAt: ATTEMPT },
    );

    // Existing supported diagnostic branch keeps its behavior when reached with a valid proof.
    expect(outcome).toMatchObject({
      scopeCurrent: true,
      persisted: true,
      disposition: "applied",
      persistedResult: expect.objectContaining({ status: "failed" }),
    });
    expect(h.task.approvedPlanFingerprint).toBeUndefined();
    expect(h.store.updateWorkflowStepResultsFenced).toHaveBeenCalledOnce();
  });

  it("4c. preserved cancellation refusal keeps refusing with a valid proof", async () => {
    const h = harness({ artifact: PLAN_A });
    const resolved = await resolveWorkflowIrForTask(h.store as never, h.task.id);
    const pin = computeWorkflowIrPin(resolved, "plan-review");
    const controller = new AbortController();
    h.store.lockCurrentPlanWhilePlanningLocked = vi.fn(async () => {
      controller.abort();
    });

    await h.persist(
      passedPlanReview({ pinOverride: pin }),
      { signal: controller.signal, requireAttemptStartedAt: ATTEMPT },
    );

    // Post-lock cancellation still refuses the write — the fenced compute refuses, nothing lands,
    // and no activity is emitted.
    const row = (h.task.workflowStepResults ?? [])[0];
    expect(row).toMatchObject({ workflowStepId: "plan-review", status: "pending" });
    expect(h.task.approvedPlanFingerprint).toBeUndefined();
    expect(h.updateTask).not.toHaveBeenCalled();
    expect((h.store.recordAgentActivity as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it("5. genuinely matching approval: anchor + satisfied row land in the existing single write", async () => {
    const h = harness({ artifact: PLAN_A });
    const resolved = await resolveWorkflowIrForTask(h.store as never, h.task.id);
    const pin = computeWorkflowIrPin(resolved, "plan-review");

    const outcome = await h.persistOutcome(
      passedPlanReview({ pinOverride: pin }),
      { requireAttemptStartedAt: ATTEMPT },
    );

    expect(outcome).toMatchObject({ persisted: true, disposition: "applied" });
    expect(h.task.approvedPlanFingerprint).toBe(computePlanApprovalFingerprint(PLAN_A));
    expect(h.lockCurrentPlanWhilePlanningLocked).toHaveBeenCalledOnce();
    expect(h.reconcileSpecDriftWhilePlanningLocked).toHaveBeenCalledOnce();
  });

  it("6. non-plan behavior preserved: a passed code-review row writes no approvedPlanFingerprint", async () => {
    const h = harness({ artifact: PLAN_A });
    // No attempt fence here: this row belongs to a different step than the held plan-review lease.
    const codeResult: WorkflowStepResult = {
      workflowStepId: "code-review",
      workflowStepName: "Code Review",
      phase: "pre-merge",
      source: "optional-group",
      status: "passed",
      verdict: "APPROVE",
      reviewKind: "code",
      startedAt: ATTEMPT,
      completedAt: COMPLETED,
    };

    await h.persistOutcome(codeResult, {});

    expect(h.task.approvedPlanFingerprint).toBeUndefined();
    expect(h.lockCurrentPlanWhilePlanningLocked).not.toHaveBeenCalled();
    // Non-plan rows never enter the plan branch at all — the content-review carrier keeps its
    // baseline semantics: a passed code-review row without `reviewInputFingerprint` is still
    // downgraded by the existing content-binding guard, proving this task did not touch it.
    const row = (h.task.workflowStepResults ?? []).find((entry) => entry.workflowStepId === "code-review");
    expect(row).toMatchObject({
      workflowStepId: "code-review",
      status: "failed",
      output: expect.stringContaining("reviewInputFingerprint"),
    });

    // A fingerprint-backed code-review row passes through unchanged, still with no anchor.
    const h2 = harness({ artifact: PLAN_A });
    await h2.persistOutcome({ ...codeResult, reviewInputFingerprint: "content-fixture-hash" }, {});
    expect(h2.task.approvedPlanFingerprint).toBeUndefined();
    const row2 = (h2.task.workflowStepResults ?? []).find((entry) => entry.workflowStepId === "code-review");
    expect(row2).toMatchObject({ workflowStepId: "code-review", status: "passed", reviewInputFingerprint: "content-fixture-hash" });
  });

  it("7. workflow mismatch: matching plan but a captured pin from a different IR refuses", async () => {
    const h = harness({ artifact: PLAN_A });
    const stalePin = { nodeId: "plan-review" as const, irHash: "different-ir-hash", columnId: "todo" };

    await h.persistOutcome(
      passedPlanReview({ pinOverride: stalePin }),
      { requireAttemptStartedAt: ATTEMPT },
    );

    expect(h.task.approvedPlanFingerprint).toBeUndefined();
    expect(h.lockCurrentPlanWhilePlanningLocked).not.toHaveBeenCalled();
  });
});

/*
FNXC:CurrentPlanReviewIdentity 2026-10-11-17:05:
Plan Review R4 (review validation) — run/attempt identity is ONLY meaningful against the durable world: the proof's
`runAttemptId` must equal the CURRENT persisted plan-review row's genuine `leaseOwner` (what the
real pending-lease claim writer stamps), freshly re-validated at the apply-check boundary. An
arbitrary nonempty run token is not evidence. Original attempt times must additionally be REAL
parseable ISO in strict order. Every refusal below keeps the genuine row (exact verdict and
timestamps) as honest history with no anchor, no spec lock, and no drift reconciliation.
*/
describe("Plan Review anchor attempt identity and original-time validation (Plan Review R4)", () => {
  async function validPin(h: SeamHarness) {
    const resolved = await resolveWorkflowIrForTask(h.store as never, h.task.id);
    return computeWorkflowIrPin(resolved, "plan-review");
  }

  function expectHonestHistory(row: WorkflowStepResult | undefined, startedAt: string, completedAt: string | undefined) {
    expect(row).toMatchObject({
      workflowStepId: "plan-review",
      status: "passed",
      verdict: "APPROVE",
      startedAt,
      ...(completedAt !== undefined ? { completedAt } : {}),
    });
  }

  it("8. a proof runAttemptId that is NOT the current persisted pending lease owner refuses", async () => {
    const h = harness({ artifact: PLAN_A });
    const pin = await validPin(h);
    // The token is nonempty and complete — but it is not the genuine leaseOwner on the durable
    // row ("run-under-test"), so it proves nothing about WHO owns this attempt.
    const displaced = passedPlanReview({ pinOverride: pin });
    displaced.reviewedInputIdentity = { ...displaced.reviewedInputIdentity!, runAttemptId: "some-other-run" };

    const outcome = await h.persistOutcome(displaced, { requireAttemptStartedAt: ATTEMPT });

    expect(outcome).toMatchObject({ persisted: true, disposition: "applied" });
    expect(h.task.approvedPlanFingerprint).toBeUndefined();
    expect(h.lockCurrentPlanWhilePlanningLocked).not.toHaveBeenCalled();
    expect(h.reconcileSpecDriftWhilePlanningLocked).not.toHaveBeenCalled();
    expectHonestHistory((h.task.workflowStepResults ?? [])[0], ATTEMPT, COMPLETED);
  });

  it("9. an unparseable original attempt start time refuses the anchor", async () => {
    const h = harness({ artifact: PLAN_A });
    const pin = await validPin(h);
    // Internally consistent (row, proof, and fence all name the same token) but NOT a real time —
    // exactly the arbitrary-string attempt the validator must refuse.
    const UNPARSEABLE = "run-under-test:attempt";
    // The durable pending lease row, the proof, and the fence ALL name the same token with the
    // genuine lease owner intact — so every identity/fence check passes and only the REAL-TIME
    // validity of the original attempt can refuse.
    (h.task.workflowStepResults ?? [])[0] = { ...(h.task.workflowStepResults ?? [])[0], startedAt: UNPARSEABLE } as WorkflowStepResult;
    const row = passedPlanReview({ pinOverride: pin, startedAt: UNPARSEABLE });
    row.completedAt = COMPLETED;

    await h.persistOutcome(row, { requireAttemptStartedAt: UNPARSEABLE });

    expect(h.task.approvedPlanFingerprint).toBeUndefined();
    expect(h.lockCurrentPlanWhilePlanningLocked).not.toHaveBeenCalled();
    expectHonestHistory((h.task.workflowStepResults ?? []).find((entry) => entry.workflowStepId === "plan-review" && entry.status === "passed"), UNPARSEABLE, COMPLETED);
  });

  it("10. a missing original completion time refuses the anchor", async () => {
    const h = harness({ artifact: PLAN_A });
    const pin = await validPin(h);
    const row = passedPlanReview({ pinOverride: pin });
    row.completedAt = undefined;

    await h.persistOutcome(row, { requireAttemptStartedAt: ATTEMPT });

    expect(h.task.approvedPlanFingerprint).toBeUndefined();
    expect(h.lockCurrentPlanWhilePlanningLocked).not.toHaveBeenCalled();
    // No completion time exists to assert — the genuine uncompleted-attempt row still persists.
    expect((h.task.workflowStepResults ?? [])[0]).toMatchObject({ status: "passed", verdict: "APPROVE", completedAt: undefined });
  });

  it("11. identical start and completion times (zero-duration) refuse the anchor", async () => {
    const h = harness({ artifact: PLAN_A });
    const pin = await validPin(h);
    const row = passedPlanReview({ pinOverride: pin });
    row.completedAt = ATTEMPT;

    await h.persistOutcome(row, { requireAttemptStartedAt: ATTEMPT });

    expect(h.task.approvedPlanFingerprint).toBeUndefined();
    expect(h.lockCurrentPlanWhilePlanningLocked).not.toHaveBeenCalled();
    expectHonestHistory((h.task.workflowStepResults ?? [])[0], ATTEMPT, ATTEMPT);
  });

  it("12. reversed original timing (completion before start) refuses the anchor", async () => {
    const h = harness({ artifact: PLAN_A });
    const pin = await validPin(h);
    // The exact shape of the pre-R4 granted fixture bug: completion 23 minutes BEFORE the attempt.
    const row = passedPlanReview({ pinOverride: pin });
    row.completedAt = "2026-10-11T14:37:00.000Z";

    await h.persistOutcome(row, { requireAttemptStartedAt: ATTEMPT });

    expect(h.task.approvedPlanFingerprint).toBeUndefined();
    expect(h.lockCurrentPlanWhilePlanningLocked).not.toHaveBeenCalled();
    expectHonestHistory((h.task.workflowStepResults ?? [])[0], ATTEMPT, "2026-10-11T14:37:00.000Z");
  });

  it("13. a lease reclaim between the lock read and the apply-check withholds the stamp", async () => {
    const h = harness({ artifact: PLAN_A });
    const pin = await validPin(h);
    h.setApplyBoundaryHook((current) => {
      const pendingRow = (current.workflowStepResults ?? []).find((entry) => entry.workflowStepId === "plan-review" && entry.status === "pending");
      if (pendingRow) pendingRow.leaseOwner = "reclaimed-by-another-run";
    });

    const outcome = await h.persistOutcome(passedPlanReview({ pinOverride: pin }), { requireAttemptStartedAt: ATTEMPT });

    // The outer read passed (ownership was true then); the apply-check's fresh validation withholds
    // the anchor. The genuine row still lands — the startedAt fence still names this attempt.
    expect(outcome).toMatchObject({ persisted: true, disposition: "applied" });
    expect(h.task.approvedPlanFingerprint).toBeUndefined();
    expect(h.reconcileSpecDriftWhilePlanningLocked).not.toHaveBeenCalled();
    const row = (h.task.workflowStepResults ?? []).find((entry) => entry.workflowStepId === "plan-review");
    expect(row).toMatchObject({ status: "passed", verdict: "APPROVE", startedAt: ATTEMPT });
  });
});

/*
FNXC:CurrentPlanReviewIdentity 2026-10-11-17:05:
Plan Review R3b (review validation) — default-equality at the PERSISTENCE seam. The general core resolver is
fail-soft: a throwing selection read or a deleted selected definition SUBSTITUTES the default
coding IR, visible only as its `.ir`. For a Plan Review whose captured pin is default-equal, that
substituted pin is IDENTICAL to the captured pin — so a read FAILURE would otherwise masquerade as
"still current" and stamp a satisfied anchor. Only the strict provenance classification (read
SUCCESS = named selection, or a SUCCESSFUL no-selection read) closes it. The legitimate default
steady state (P-D1) must still pass; the read-failure look-alike (P-D2) must refuse.
*/
describe("Plan Review anchor default-equality (Plan Review R3b)", () => {
  it("P-D1. a default-equal proof releases the anchor when the no-selection read SUCCEEDS (legitimate default)", async () => {
    const h = harness({ artifact: PLAN_A });
    h.setSelectionMode("absent");
    // The captured pin genuinely equals the default workflow's pin — exactly what a genuine
    // dispatch against the default workflow captures through the production resolver.
    const resolved = await resolveWorkflowIrForTask(h.store as never, h.task.id);
    const pin = computeWorkflowIrPin(resolved, "plan-review");

    const outcome = await h.persistOutcome(passedPlanReview({ pinOverride: pin }), { requireAttemptStartedAt: ATTEMPT });

    expect(outcome).toMatchObject({ persisted: true, disposition: "applied" });
    expect(h.task.approvedPlanFingerprint).toBe(computePlanApprovalFingerprint(PLAN_A));
    expect(h.lockCurrentPlanWhilePlanningLocked).toHaveBeenCalledOnce();
    expect(h.reconcileSpecDriftWhilePlanningLocked).toHaveBeenCalledOnce();
  });

  it("P-D2. a default-equal proof refuses when the selection read THROWS (fail-soft substitution cannot pin-prove currentness)", async () => {
    const h = harness({ artifact: PLAN_A });
    h.setSelectionMode("absent");
    const resolved = await resolveWorkflowIrForTask(h.store as never, h.task.id);
    const pin = computeWorkflowIrPin(resolved, "plan-review");
    // After capture, the durable selection read begins FAILING. The fail-soft resolver would
    // substitute the default — pin-identical to the captured pin — so ONLY read-SUCCESS
    // provenance can distinguish "default is authoritative" from "reading broke".
    h.setSelectionMode("throwing");

    const outcome = await h.persistOutcome(passedPlanReview({ pinOverride: pin }), { requireAttemptStartedAt: ATTEMPT });

    expect(outcome).toMatchObject({ persisted: true, disposition: "applied" });
    // Honest history lands; anchor authority does not.
    expect(h.task.approvedPlanFingerprint).toBeUndefined();
    expect(h.lockCurrentPlanWhilePlanningLocked).not.toHaveBeenCalled();
    expect(h.reconcileSpecDriftWhilePlanningLocked).not.toHaveBeenCalled();
    const row = (h.task.workflowStepResults ?? []).find((entry) => entry.workflowStepId === "plan-review");
    expect(row).toMatchObject({ status: "passed", verdict: "APPROVE", startedAt: ATTEMPT, completedAt: COMPLETED });
  });
});

/*
FNXC:CurrentPlanReviewIdentity 2026-10-11-20:42:
Plan Review anchor-refusal race (review validation, Code Review finding `anchor-refusal-race-narrow`) — the
receipt-level contract: `disposition: "applied"` ONLY describes the ROW write, so the honest
`satisfiedApplication` disposition is what the fresh graph admission consumes to block on a
refused satisfied application. These cases pin the vocabulary at the production seam itself:
outer-proof refusal, apply-check reclaim, genuine landing, and non-plan byte-inertness.
*/
describe("Plan Review satisfied-application receipt disposition (Plan Review anchor-refusal race)", () => {
  async function validPin(h: SeamHarness) {
    const resolved = await resolveWorkflowIrForTask(h.store as never, h.task.id);
    return computeWorkflowIrPin(resolved, "plan-review");
  }

  it("S1. an outer-proof refusal persists honest history and reports satisfiedApplication anchor-proof-refused", async () => {
    const h = harness({ artifact: PLAN_B });
    // Proof honestly says A; the current artifact is B — the outer validation refuses.
    const outcome = await h.persistOutcome(passedPlanReview(), { requireAttemptStartedAt: ATTEMPT });

    expect(outcome).toMatchObject({
      scopeCurrent: true,
      persisted: true,
      disposition: "applied",
      satisfiedApplication: "anchor-proof-refused",
    });
    // The row is honest history; the satisfied application was refused, so NO anchor exists.
    expect(h.task.approvedPlanFingerprint).toBeUndefined();
    const row = (h.task.workflowStepResults ?? []).find((entry) => entry.workflowStepId === "plan-review");
    expect(row).toMatchObject({ status: "passed", verdict: "APPROVE", startedAt: ATTEMPT, completedAt: COMPLETED });
  });

  it("S2. a reclaim that wins the fenced apply-check reports satisfiedApplication apply-check-ownership-lost", async () => {
    const h = harness({ artifact: PLAN_A });
    const pin = await validPin(h);
    h.setApplyBoundaryHook((current) => {
      const pendingRow = (current.workflowStepResults ?? []).find((entry) => entry.workflowStepId === "plan-review" && entry.status === "pending");
      if (pendingRow) pendingRow.leaseOwner = "reclaimed-by-another-run";
    });

    const outcome = await h.persistOutcome(passedPlanReview({ pinOverride: pin }), { requireAttemptStartedAt: ATTEMPT });

    expect(outcome).toMatchObject({
      persisted: true,
      disposition: "applied",
      satisfiedApplication: "apply-check-ownership-lost",
    });
    expect(h.task.approvedPlanFingerprint).toBeUndefined();
    expect(h.reconcileSpecDriftWhilePlanningLocked).not.toHaveBeenCalled();
    const row = (h.task.workflowStepResults ?? []).find((entry) => entry.workflowStepId === "plan-review");
    expect(row).toMatchObject({ status: "passed", verdict: "APPROVE", startedAt: ATTEMPT, completedAt: COMPLETED });
  });

  it("S3. a genuinely landed satisfied application reports satisfiedApplication applied (control)", async () => {
    const h = harness({ artifact: PLAN_A });
    const pin = await validPin(h);

    const outcome = await h.persistOutcome(passedPlanReview({ pinOverride: pin }), { requireAttemptStartedAt: ATTEMPT });

    expect(outcome).toMatchObject({
      persisted: true,
      disposition: "applied",
      satisfiedApplication: "applied",
    });
    expect(h.task.approvedPlanFingerprint).toBe(computePlanApprovalFingerprint(PLAN_A));
    expect(h.reconcileSpecDriftWhilePlanningLocked).toHaveBeenCalledOnce();
  });

  it("S4. non-plan-review and non-satisfied writes carry NO satisfiedApplication disposition (byte-inert)", async () => {
    const h = harness({ artifact: PLAN_A });
    // A satisfied-shape code-review row never enters the plan branch.
    const codeOutcome = (await h.persistOutcome({
      workflowStepId: "code-review",
      workflowStepName: "Code Review",
      phase: "pre-merge",
      source: "optional-group",
      status: "passed",
      verdict: "APPROVE",
      reviewKind: "code",
      reviewInputFingerprint: "content-fixture-hash",
      startedAt: ATTEMPT,
      completedAt: COMPLETED,
    }, {})) as { satisfiedApplication?: string };
    expect(codeOutcome.satisfiedApplication).toBeUndefined();

    // A PENDING plan-review lease is not a satisfied application either.
    const h2 = harness({ artifact: PLAN_A });
    const pending = (await h2.persistOutcome({
      workflowStepId: "plan-review",
      workflowStepName: "Plan Review",
      phase: "pre-merge",
      source: "optional-group",
      status: "pending",
      startedAt: ATTEMPT,
      leaseOwner: LEASE_OWNER,
    }, {})) as { satisfiedApplication?: string };
    expect(pending.satisfiedApplication).toBeUndefined();
    // The pending write replaced the fixture lease row with the same identity — still unlanded.
    expect(h2.task.approvedPlanFingerprint).toBeUndefined();
  });
});
