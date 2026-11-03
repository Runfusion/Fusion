/*
 * Surface enumeration: this suite covers the engine's FN-9304 landed-review fence (the recovery half of a
 * zero-commit finalize) and the core merge doors it consults. No UI surface is involved: the change is a
 * merge-authority decision and a recovery-lane disposition, and the operator-visible halves of the same
 * invariant (the CLI sentence, the dashboard reconcile route) are pinned in
 * `packages/cli/src/__tests__/task-reconcile-commit-free.test.ts` and
 * `packages/dashboard/src/routes/__tests__/task-reconcile-commit-free.test.ts`. The descriptorless question and
 * the workspace descriptor question are pinned in
 * `packages/core/src/__tests__/pre-merge-approval-gate.test.ts` and
 * `packages/core/src/__tests__/zero-commit-workspace-land-park.test.ts`.
 */

/*
FNXC:ZeroCommitEmptyInputContentProof 2026-11-03-19:15 (RUFU-384):
RUFU-365 REPLAY. Measured 2026-09-28: a card whose PROMPT.md declared `No commits expected: true` finished all
eight steps with zero commits, Code Review dispatched against empty input and returned APPROVE bound to
`empty-review-input:v1`, and then nothing could close it. Auto-merge refused with "task has no provable approval
for the content being merged", the card parked `in-review`/`failed` under a terminal-failed wedge, `fusion/rufu-365`
existed in no ref, and the FN-9304 fence — the lane built for exactly a missing branch — answered `not-landed`
on every pass forever, because a zero-commit delivery leaves no commit for a landed test to find.

Every case below is the same synthetic row: review lane, `failed`, no worktree, no branch content, a code-review
APPROVE whose `reviewInputFingerprint` IS the canonical empty-input marker. The positive case asserts the five
things that were true the other way round; the negative cases hold the line RUFU-337 drew, because the whole
safety claim of this change is that it widens ONE conjunction and nothing else.

No git and no real worktree are involved: a task with no `worktree` makes `captureMergeContentDescriptor` answer
`{ kind: "singular", diff: { state: "unavailable" } }` by construction (`probeReviewDiffFingerprint` refuses
without a worktree path), which IS RUFU-365's observed content evidence. The zero-commit door stays real — only
its one git read is stubbed — so the allow/refuse decision under test is the production predicate's, not a mock's.
*/

import { afterEach, describe, expect, it, vi } from "vitest";
import { getTaskHardMergeBlocker, getTaskMergeBlocker, CORE_EMPTY_REVIEW_INPUT_FINGERPRINT, CORE_MISSING_CHECKOUT_DIFF_REASON, type Settings, type Task, type TaskStore } from "@fusion/core";
import { SelfHealingManager } from "../self-healing.js";
import { EMPTY_REVIEW_DIFF_FINGERPRINT, probeReviewDiffFingerprint } from "../worktree/review-diff-fingerprint.js";

const collectZeroCommitEvidence = vi.hoisted(() => vi.fn());

vi.mock("../merge/zero-commit-finalization-guard.js", async (importActual) => {
  const actual = await importActual<typeof import("../merge/zero-commit-finalization-guard.js")>();
  return {
    ...actual,
    // One git observation is the only non-deterministic input to the door; the verdict logic stays real.
    collectZeroCommitEvidence,
  };
});

const taskId = "RUFU-365";

const baseSettings = {
  globalPause: false,
  enginePaused: false,
  autoMerge: true,
  taskStuckTimeoutMs: 60_000,
} as Settings;

/** RUFU-365's row, at the moment the wedge became permanent. */
function wedgedCard(overrides: Partial<Task> = {}): Task {
  return {
    id: taskId,
    title: "Audit-lane measurement card",
    description: "Deliverable is a measurement verdict routed to follow-up tasks, not code.",
    column: "in-review",
    status: "failed",
    error: "AUTO_MERGE_RETRY_REJECTED: Cannot merge RUFU-365: task has no provable approval for the content being merged",
    branch: "fusion/rufu-365",
    // No `worktree`, no `baseCommitSha`: the branch exists in no ref and its checkout is gone.
    worktree: undefined,
    noCommitsExpected: true,
    dependencies: [],
    steps: [],
    currentStep: 8,
    log: [],
    createdAt: "2026-09-28T00:00:00.000Z",
    updatedAt: "2026-09-28T00:17:24.000Z",
    enabledWorkflowSteps: ["code-review"],
    workflowStepResults: [
      {
        workflowStepId: "code-review",
        status: "passed",
        verdict: "APPROVE",
        reviewInputFingerprint: EMPTY_REVIEW_DIFF_FINGERPRINT,
      },
    ],
    ...overrides,
  } as Task;
}

type TestStore = TaskStore & {
  row: Task;
  updateTask: ReturnType<typeof vi.fn>;
  updateTaskAtomic: ReturnType<typeof vi.fn>;
  moveTask: ReturnType<typeof vi.fn>;
  logEntry: ReturnType<typeof vi.fn>;
  recordRunAuditEvent: ReturnType<typeof vi.fn>;
};

function storeFor(initial: Task): TestStore {
  const store = {
    row: initial,
    getTask: vi.fn(async () => store.row),
    getSettings: vi.fn(async () => baseSettings),
    listTasks: vi.fn(async ({ column }: { column?: string } = {}) => (!column || store.row.column === column ? [store.row] : [])),
    updateTask: vi.fn(async (_id: string, patch: Partial<Task>) => {
      store.row = { ...store.row, ...patch } as Task;
      return store.row;
    }),
    updateTaskAtomic: vi.fn(async (_id: string, updater: (current: Task) => Partial<Task> | null) => {
      const patch = updater(store.row);
      if (!patch) return null;
      store.row = { ...store.row, ...patch } as Task;
      return store.row;
    }),
    moveTask: vi.fn(async (_id: string, column: string) => {
      store.row = { ...store.row, column } as Task;
      return store.row;
    }),
    logEntry: vi.fn(async () => undefined),
    recordRunAuditEvent: vi.fn(async () => undefined),
    getTaskWorkflowSelection: vi.fn(() => ({ workflowId: "builtin:coding", stepIds: ["code-review"] })),
    getTaskWorkflowSelectionAsync: vi.fn(async () => ({ workflowId: "builtin:coding", stepIds: ["code-review"] })),
  } as unknown as TestStore;
  return store;
}

/** A provably clean tree on a branch zero commits ahead — the delivery half RUFU-274's door asks about. */
function cleanZeroAheadEvidence() {
  collectZeroCommitEvidence.mockResolvedValue({
    aheadCommitCount: 0,
    landingProof: null,
    content: { content: { state: "clean", modifiedCount: 0, untrackedCount: 0, paths: [] }, basis: "acquired-worktree" },
  });
}

function fenceFor(store: TestStore, overrides: Record<string, unknown> = {}) {
  const manager = new SelfHealingManager(store, { rootDir: process.cwd(), isTaskActive: () => false });
  const landedCleanup = vi.fn(async () => store.row);
  Object.assign(manager, {
    resolveSelfHealingMergeTarget: vi.fn(async () => ({ branch: "main", source: "project-default" as const })),
    isBranchTipMisboundToTask: vi.fn(async () => ({
      misbound: false,
      branchMissing: true,
      branchTip: "",
      landed: null,
    })),
    hasUnlandedTaskOwnedContent: vi.fn(async () => false),
    recordSelfHealingBranchGroupMemberLanding: vi.fn(async () => undefined),
    moveToCompleteLaneAfterLandedCleanup: landedCleanup,
    emitTaskMerged: vi.fn(),
    reconcileCompletedTask: vi.fn(async () => undefined),
    ...overrides,
  });
  return { manager, landedCleanup };
}

function reconcile(artifacts: { manager: SelfHealingManager }) {
  return artifacts.manager.reconcileLandedReviewTask(taskId, { source: "manual", requireAutoMergeEligible: false });
}

/** Drives the automatic sweep, which is the only producer of the `-unproven` row. */
function reconcileSweep(artifacts: { manager: SelfHealingManager }) {
  return artifacts.manager.recoverBranchMisboundInReviewTasks();
}

/** The RUFU-337 refusal sentence, read from the one file that owns it. */
const NO_PROVABLE_APPROVAL = "task has no provable approval for the content being merged";

const reviewColumns = new Set(["in-review"]);
const requiredGates = new Set(["code-review"]);

afterEach(() => {
  collectZeroCommitEvidence.mockReset();
});

describe("RUFU-365 replay: an approved zero-commit card can finally be closed", () => {
  it("refuses no more at the merge door — the RUFU-337 sentence is gone for this shape", async () => {
    const card = wedgedCard();

    const blocker = getTaskHardMergeBlocker(card, {
      reviewColumns,
      requiredPreMergeStepIds: requiredGates,
      // The capture the fence and the merge lane both take for a card with no checkout.
      mergeContent: { kind: "singular", diff: { state: "unavailable", reason: "missing-worktree-or-base" } },
    });

    expect(blocker).toBeUndefined();
    expect(blocker ?? "").not.toContain(NO_PROVABLE_APPROVAL);
  });

  it("discharges through the FN-9304 fence instead of answering not-landed", async () => {
    cleanZeroAheadEvidence();
    const store = storeFor(wedgedCard());
    const artifacts = fenceFor(store);

    const result = await reconcile(artifacts);

    expect(result).toEqual({ outcome: "zero-commit-discharged", baseBranch: "main", basis: "empty-input-approval" });
    // The card left the review lane via the shared complete-lane move. The landed-cleanup helper is built
    // around a landed sha, so a commit-free discharge that reached it would be claiming a landing.
    expect(store.moveTask).toHaveBeenCalledWith(taskId, "done");
    expect(artifacts.landedCleanup).not.toHaveBeenCalled();
  });

  it("finalizes commit-free: mergeConfirmed with no fabricated sha, and the park cleared", async () => {
    cleanZeroAheadEvidence();
    const store = storeFor(wedgedCard());

    await reconcile(fenceFor(store));

    expect(store.row.mergeDetails).toMatchObject({
      mergeConfirmed: true,
      mergeTargetBranch: "main",
      mergeTargetSource: "project-default",
    });
    expect(store.row.mergeDetails?.commitSha).toBeUndefined();
    // The terminal wedge that notified at 00:17:24Z is gone from the row.
    expect(store.row).toMatchObject({ status: null, error: null, paused: false, branch: null });
  });

  it("names the commit-free basis on the card instead of claiming a landing", async () => {
    cleanZeroAheadEvidence();
    const store = storeFor(wedgedCard());

    await reconcile(fenceFor(store));

    const lines = store.logEntry.mock.calls.map((call) => String(call[1] ?? ""));
    const discharge = lines.find((line) => line.includes("commit-free"));
    expect(discharge).toBeDefined();
    expect(discharge).toContain("no commit");
    expect(discharge).not.toMatch(/Merge-\d+/);
  });

  it("stops writing task:reconcile-absent-branch-unproven for a discharged card", async () => {
    cleanZeroAheadEvidence();
    const store = storeFor(wedgedCard());

    // The `-unproven` row is the SWEEP's write, not the fence's — asserting against a direct
    // `reconcileLandedReviewTask` call would prove nothing, because that path never emits it. RUFU-365 sat in
    // the sweep's refusal branch, re-announcing on every pass, which is why this drives the sweep itself.
    await reconcileSweep(fenceFor(store));

    const mutationTypes = store.recordRunAuditEvent.mock.calls.map((call) => (call[0] as { mutationType?: string })?.mutationType);
    expect(mutationTypes).not.toContain("task:reconcile-absent-branch-unproven");
    // And no `-landed` row either: that one carries mergeSha/mergeStrategy this card does not have.
    expect(mutationTypes).not.toContain("task:reconcile-absent-branch-landed");
    expect(store.row.column).toBe("done");
  });

  it("still writes task:reconcile-absent-branch-unproven for an unflagged card through the same sweep", async () => {
    // The paired negative, and the sharper half of the claim: the refusal class is intact and only the
    // discharged shape stopped feeding it. If this assertion went green-by-disappearing-row, the change
    // would have deleted an operator's only signal for a card that genuinely has unlanded content.
    cleanZeroAheadEvidence();
    const store = storeFor(wedgedCard({ id: "RUFU-999", noCommitsExpected: undefined, branch: "fusion/rufu-999" }));

    await reconcileSweep(fenceFor(store));

    const mutationTypes = store.recordRunAuditEvent.mock.calls.map((call) => (call[0] as { mutationType?: string })?.mutationType);
    expect(mutationTypes).toContain("task:reconcile-absent-branch-unproven");
    expect(store.row.column).toBe("in-review");
  });
  it("keeps the core-side marker constant equal to the engine's fingerprint fact", () => {
    /*
    FNXC:ZeroCommitEmptyInputContentProof 2026-11-03-19:15 (RUFU-384):
    `@fusion/core` cannot import `@fusion/engine`, so the gate arm matches a core-owned mirror of the literal
    rather than the engine constant. That mirror is the one thing in this change that can rot silently: rename
    or version the engine's marker and the core arm stops recognising approvals while every test in the
    package that owns either file stays green. Pin the equality where both are importable.
    */
    expect(CORE_EMPTY_REVIEW_INPUT_FINGERPRINT).toBe(EMPTY_REVIEW_DIFF_FINGERPRINT);
  });

  it("keeps the core-side waiver reason equal to the reason the engine's probe actually reports", async () => {
    /*
    FNXC:ZeroCommitEmptyInputContentProof 2026-11-03-18:50 (RUFU-384, code-review P0):
    The same silent-rot hazard on the OTHER mirror this change introduced: the waiver now reads a diff
    REASON, whose spelling the engine writes inline in `probeReviewDiffFingerprint` and core mirrors as a
    constant. Re-name it upstream and the core arm silently stops discharging zero-commit cards — a
    regression that fails closed, i.e. it re-creates the RUFU-365 wedge rather than breaking the gate. Pin
    the equality against the engine's own probe output, not against a second literal.
    */
    const probe = await probeReviewDiffFingerprint(undefined, undefined);
    expect(probe).toEqual({ state: "unavailable", reason: CORE_MISSING_CHECKOUT_DIFF_REASON });
  });
});

describe("RUFU-365 replay: the line RUFU-337 drew is still there", () => {
  it("refuses an empty-marker approval whose version differs from the canonical marker", () => {
    // Same conjunction, wrong marker version: the gate keeps refusing a shape it cannot name.
    const blocker = getTaskHardMergeBlocker(wedgedCard({
      workflowStepResults: [{ workflowStepId: "code-review", status: "passed", verdict: "APPROVE", reviewInputFingerprint: "empty-review-input:v2" }],
    }), {
      reviewColumns,
      requiredPreMergeStepIds: requiredGates,
      mergeContent: { kind: "singular", diff: { state: "unavailable", reason: "missing-worktree-or-base" } },
    });

    expect(blocker).toContain(NO_PROVABLE_APPROVAL);
  });
  it.each(["git-diff-too-large", "git-diff-failed"] as const)(
    "keeps the fence's own approval authority refusing when the diff is unavailable because %s",
    (reason) => {
      /*
      FNXC:ZeroCommitEmptyInputContentProof 2026-11-03-18:50 (RUFU-384, code-review P0):
      `getTaskHardMergeBlocker` is the exact evaluator the FN-9304 discharge arm consults for approval parity,
      so this is the fence-level half of the same negative: an `unavailable` diff that PROVES content exists
      (a streamed patch over 10 MiB) or may hold it (a git read that failed on a present checkout) must not be
      waived for a flagged card. If this ever reads approved, the fence could discharge a card whose real work
      was never reviewed — the FN-9234 class, one lane further down.
      */
      const blocker = getTaskHardMergeBlocker(wedgedCard(), {
        reviewColumns,
        requiredPreMergeStepIds: requiredGates,
        mergeContent: { kind: "singular", diff: { state: "unavailable", reason } },
      });

      expect(blocker).toContain(NO_PROVABLE_APPROVAL);
    },
  );

  it("still refuses when the card never asked to deliver zero commits", async () => {
    cleanZeroAheadEvidence();
    const store = storeFor(wedgedCard({ noCommitsExpected: undefined }));

    const result = await reconcile(fenceFor(store));

    expect(result).toEqual({ outcome: "not-landed", baseBranch: "main" });
    expect(store.row.mergeDetails?.mergeConfirmed).toBeUndefined();
  });

  it("still refuses a real-fingerprint approval over unavailable content (the FN-9234 stale-content class)", async () => {
    cleanZeroAheadEvidence();
    const store = storeFor(wedgedCard({
      // Same APPROVE, same unavailable diff, but bound to CONTENT — a vanished diff must stay a refusal.
      workflowStepResults: [{ workflowStepId: "code-review", status: "passed", verdict: "APPROVE", reviewInputFingerprint: "sha256:real-content" }],
    }));

    const result = await reconcile(fenceFor(store));

    expect(result).toEqual({ outcome: "not-landed", baseBranch: "main" });
    expect(getTaskHardMergeBlocker(store.row, {
      reviewColumns,
      requiredPreMergeStepIds: requiredGates,
      mergeContent: { kind: "singular", diff: { state: "unavailable", reason: "missing-worktree-or-base" } },
    })).toContain(NO_PROVABLE_APPROVAL);
  });

  it("still refuses when the branch is only missing from the local view (not proven gone)", async () => {
    cleanZeroAheadEvidence();
    const store = storeFor(wedgedCard());
    const manager = fenceFor(store, {
      isBranchTipMisboundToTask: vi.fn(async () => ({ misbound: false, branchMissing: false, branchTip: "deadbeef", landed: null })),
    });

    const result = await reconcile(manager);

    // The unlanded-content arms decide a surviving branch; this arm must never run for it.
    expect(result).not.toEqual(expect.objectContaining({ outcome: "zero-commit-discharged" }));
    expect(collectZeroCommitEvidence).not.toHaveBeenCalled();
  });

  it("still refuses when the required gate has no approving row", async () => {
    cleanZeroAheadEvidence();
    const store = storeFor(wedgedCard({
      workflowStepResults: [{ workflowStepId: "code-review", status: "failed", verdict: "REVISE", reviewInputFingerprint: EMPTY_REVIEW_DIFF_FINGERPRINT }],
    }));

    const result = await reconcile(fenceFor(store));

    // Stronger than `not-landed`: the fence's own approval pre-check refuses BEFORE the discharge arm runs,
    // so an empty-input marker can never stand in for an approval that was never given. No marker-shaped row
    // reaches the delivery door at all.
    expect(result).toEqual({ outcome: "ineligible", reason: "workflow-approval-blocked" });
    expect(collectZeroCommitEvidence).not.toHaveBeenCalled();
    expect(store.row.mergeDetails?.mergeConfirmed).toBeUndefined();
  });

  it("keeps the ordinary not-landed sentence at the door for an unflagged card", async () => {
    const blocker = getTaskMergeBlocker(wedgedCard({ noCommitsExpected: undefined }), {
      reviewColumns,
      requiredPreMergeStepIds: requiredGates,
      mergeContent: { kind: "singular", diff: { state: "unavailable", reason: "missing-worktree-or-base" } },
    });

    expect(blocker).toContain(NO_PROVABLE_APPROVAL);
  });
});
