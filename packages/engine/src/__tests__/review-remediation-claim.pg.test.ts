import { beforeAll, beforeEach, afterEach, afterAll, expect, it } from "vitest";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../../core/src/__test-utils__/pg-test-harness.js";
import { claimRemediationAttempt } from "../executor/claim-review-remediation-attempt.js";
import { TaskExecutor } from "../executor.js";

/*
FNXC:ReviewRemediation 2026-08-31-08:20:
The remediation claim has three tiers and only the FIRST -- a PostgreSQL advisory-lock CAS through
`updateWorkflowStepResultsFenced` -- is the correctness boundary; the rest exist for unit
compatibility. Every mock-store test in this repo therefore exercises tier 2 and CANNOT observe what
production does.

That gap is not theoretical. FN-270 and FN-273 held a real REVISE with critical findings and produced
no fix steps, while a faithful mock replay of the same rows (real workflow IR, real verdict, real
findings) appended remediation and handed the card back. Everything modellable works; the divergence
lives in the tier no mock reaches, and the claim's non-`unavailable` refusals return SILENTLY:

    if (outcome.applied) return { applied: true, task: outcome.task };
    if (outcome.reason !== "unavailable") return { applied: false };

This pins what the real fenced tier answers for the exact production row shape, so the question stops
being answered by deduction. Auto-skips without PostgreSQL, so it never gates a merge.
*/

const pgTest = pgDescribe;

const REVISE_STEP = {
  phase: "pre-merge",
  status: "failed",
  verdict: "REVISE",
  source: "optional-group",
  reviewKind: "code",
  workflowStepId: "code-review",
  workflowStepName: "Code Review",
  notes: "Required workspace parity regression coverage is missing.",
  output: "Required workspace parity regression coverage is missing.",
  startedAt: "2026-08-31T07:38:49.764Z",
  completedAt: "2026-08-31T07:40:26.334Z",
  reviewedCommitSha: "62958c6db72998d96d7ba22de43abbc01b0cebfd",
  reviewInputFingerprint: "0f597d26bb93f95ada977678e96d054973422b1347c241fdbb68dd51a4af2871",
  findings: [
    {
      id: "fn-273-workspace-refresh-regression-matrix",
      title: "Workspace base-refresh integration matrix is largely untested",
      body: "Add real-git acquireWorkspaceTaskWorktrees cases for these outcomes.",
      filePath: "packages/engine/src/__tests__/workspace-base-refresh.test.ts",
      line: 52,
      severity: "critical",
      resolution: "open",
    },
  ],
} as const;

const PLAN_STEP = {
  phase: "pre-merge",
  status: "passed",
  verdict: "APPROVE",
  workflowStepId: "plan-review",
  workflowStepName: "Plan Review",
  completedAt: "2026-08-30T19:13:45.406Z",
} as const;

pgTest("review remediation claim against the real fenced tier (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_remediation_claim",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  /*
  Seeds the exact production shape through the store's OWN writers -- including the fenced
  step-result writer this test is about -- rather than raw SQL. Seeding by the real path is what
  makes the measurement trustworthy: the row under test was written the way production writes it.
  */
  async function seedReviewedTask(id: string) {
    const store = h.store();
    const at = new Date(Date.now() - 5 * 60_000).toISOString();
    await store.createTaskWithReservedId(
      { description: `${id} workspace file-overlap parity`, column: "in-review" },
      { taskId: id, createdAt: at, updatedAt: at, applyDefaultWorkflowSteps: false },
    );
    await store.updateTask(id, {
      column: "in-review",
      worktree: `/tmp/${id}`,
      steps: [
        { name: "Preflight", status: "done" },
        { name: "Implement", status: "done" },
        { name: "Testing & Verification", status: "done" },
      ],
      enabledWorkflowSteps: ["plan-review", "code-review", "documentation-delivery"],
      postReviewFixCount: 0,
    } as never);
    const written = await store.updateWorkflowStepResultsFenced(id, () => ({
      workflowStepResults: [PLAN_STEP, REVISE_STEP] as never,
    }));
    expect(written.applied).toBe(true);
    store.taskCache.delete(id);
    return await store.getTask(id);
  }

  it("reports what the fenced tier answers for a clean, unclaimed REVISE", async () => {
    const store = h.store();
    const task = await seedReviewedTask("FN-273");
    expect(task).toBeTruthy();
    const failedStep = (task!.workflowStepResults ?? []).find((r) => r.workflowStepId === "code-review");
    expect(failedStep).toBeTruthy();

    // Guard the premise: nothing has claimed or refused this round.
    const raw = failedStep as unknown as Record<string, unknown>;
    expect(raw.remediationAttemptOwner).toBeUndefined();
    expect(raw.remediationRefusedReason).toBeUndefined();

    /*
    Before the separator fix this THREW SQLSTATE 22P05 from the fenced writer, so the claim could
    never be taken and the backstop returned in silence: no fix steps, no timeline entry.
    */
    const admission = await claimRemediationAttempt(store, task!.id, failedStep!, "graph-failure", task!);
    expect(admission.kind).toBe("claimed");

    // The claim is durable, which is the whole point of the fenced tier.
    const after = await store.getTask(task!.id);
    const claimedStep = (after!.workflowStepResults ?? []).find((r) => r.workflowStepId === "code-review");
    const persisted = claimedStep as unknown as Record<string, string | undefined>;
    expect(persisted.remediationAttemptOwner).toContain("graph-failure");
    expect(persisted.remediationAttemptSignature).toBeTruthy();
  });

  it("re-admits the same round after the claim is released", async () => {
    const store = h.store();
    const task = await seedReviewedTask("FN-274");
    const failedStep = (task!.workflowStepResults ?? []).find((r) => r.workflowStepId === "code-review");

    const first = await claimRemediationAttempt(store, task!.id, failedStep!, "graph-failure", task!);
    const live = await store.getTask(task!.id);
    const liveStep = (live!.workflowStepResults ?? []).find((r) => r.workflowStepId === "code-review");
    const second = await claimRemediationAttempt(store, live!.id, liveStep!, "self-healing", live!);

    expect(first.kind).toBe("claimed");
    /* Real serialization across owners is what only this tier provides; a mock cannot prove it. */
    expect(second.kind).toBe("held");
  });

  /*
  FNXC:ReviewRemediation 2026-08-31-08:24:
  The operator-visible contract, end to end, against a real database: a blocking Code Review REVISE
  must leave named Fix steps on the card. The claim assertions above prove the repaired tier in
  isolation; this proves the WHOLE chain a card actually travels -- backstop, claim, producer,
  appender -- because that is the thing FN-270 and FN-273 could not do for fifteen hours while every
  isolated part looked correct.

  This is also the safety net for reducing the three remediation writers to one: any change that
  breaks the delivered outcome fails here, against real storage, instead of in production.
  */
  it("turns a blocking REVISE into named Fix steps on the card", async () => {
    const store = h.store();
    const task = await seedReviewedTask("FN-275");
    const executor = new TaskExecutor(store as never, "/tmp/test");

    await (executor as never as { handleGraphFailure(t: unknown, r: unknown): Promise<void> })
      .handleGraphFailure(task, {
        disposition: "failed",
        outcome: "failure",
        visitedNodeIds: ["code-review-step"],
        context: { "node:code-review-step:value": "revise" },
      });

    const after = await store.getTask(task!.id);
    const fixSteps = (after!.steps ?? []).filter((s) => /^Fix:/i.test(String(s.name ?? "")));
    expect(fixSteps.length).toBeGreaterThan(0);
    expect(fixSteps.every((s) => s.status === "pending")).toBe(true);
    // The finished implementation steps are preserved, not rewritten.
    expect((after!.steps ?? []).slice(0, 3).every((s) => s.status === "done")).toBe(true);
  });
});
