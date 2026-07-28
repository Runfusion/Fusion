/*
FNXC:MovePathConvergence 2026-07-27-18:30 (Phase A2 — workflow-owned lifecycle):
DIFFERENTIAL CHARACTERIZATION of the two move-side-effect implementations in
`moveTaskInternalImpl`, run through ONE shared fixture.

WHY THIS SUITE EXISTS. `moves.ts` branches on `useWorkflow` =
`isWorkflowColumnsCompatibilityFlagEnabled(settings)`, which reads the RAW
`experimentalFeatures.workflowColumns` key. Nothing in production writes that
key, so:

  - the INLINE branch is the LIVE path for essentially every project;
  - `default-workflow-hooks.ts` (the trait-hook path) is DEAD.

`moves.ts` says so itself at the flag-OFF adjacency branch. Only one
implementation runs in production, so equivalence CANNOT be observed by running
the suite normally — the dead path is never entered. Each case here therefore
FORCES both paths explicitly through the same fixture:

    flag ABSENT              → the production shape (inline branch)
    workflowColumns: true    → the hooks path

and asserts on observable state, not on which functions were called. Equivalence
asserted by reading code is not equivalence.

SCOPE NOTE. The `useWorkflow` flag gates far more than the side-effect block:
validation, in-transaction capacity, the transitionPending marker, and plugin
column gates are all inside it. Those divergences are characterized in the
companion describe at the bottom, which is what makes the convergence decision an
operator call rather than a refactor.
*/

import { afterEach, beforeEach, expect, it, beforeAll, afterAll } from "vitest";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import type { Task } from "../../types.js";

const pgTest = pgDescribe;

/** The observable surface a move can change. Compared field-by-field so a
 *  divergence names the field rather than dumping two task objects. */
interface MoveObservation {
  column: string;
  status: string | undefined;
  error: string | undefined;
  paused: boolean | undefined;
  userPaused: boolean | undefined;
  pausedReason: string | undefined;
  blockedBy: string | undefined;
  overlapBlockedBy: string | undefined;
  worktree: string | undefined;
  branch: string | undefined;
  summary: string | undefined;
  baseCommitSha: string | undefined;
  /*
  Timestamps are compared by PRESENCE, not value. The two paths necessarily run
  at different wall-clock instants (same fixture, two sequential runs), so the
  ISO strings differ by milliseconds every time. What must match is whether the
  path stamped the field at all — a path that forgets to set
  `executionCompletedAt`, or wrongly clears `firstExecutionAt`, still fails here.
  */
  executionStartedAtSet: boolean;
  executionCompletedAtSet: boolean;
  firstExecutionAtSet: boolean;
  /*
  FNXC:MovePathEquivalence 2026-07-27-08:20 (PR #2468 review — greptile P2):
  A boolean "is it a number" stays green when the two paths compute DIFFERENT durations, which is
  exactly the accounting bug this case exists to catch. The absolute value is wall-clock dependent,
  so compare a QUANTISED bucket: both paths must land in the same 100ms bucket for the same seeded
  segment, which is stable against scheduling jitter while still failing when one path drops or
  double-counts a segment.
  */
  cumulativeActiveMsBucket: number | undefined;
  recoveryRetryCount: number | undefined;
  nextRecoveryAtSet: boolean;
  stepStatuses: string[];
  workflowStepResultCount: number | undefined;
}

function observe(task: Task): MoveObservation {
  return {
    column: task.column,
    status: task.status,
    error: task.error,
    paused: task.paused,
    userPaused: task.userPaused,
    pausedReason: task.pausedReason,
    blockedBy: task.blockedBy,
    overlapBlockedBy: task.overlapBlockedBy,
    worktree: task.worktree,
    branch: task.branch,
    summary: task.summary,
    baseCommitSha: task.baseCommitSha,
    executionStartedAtSet: task.executionStartedAt !== undefined,
    executionCompletedAtSet: task.executionCompletedAt !== undefined,
    firstExecutionAtSet: task.firstExecutionAt !== undefined,
    cumulativeActiveMsBucket:
      typeof task.cumulativeActiveMs === "number" ? Math.floor(task.cumulativeActiveMs / 100) : undefined,
    recoveryRetryCount: task.recoveryRetryCount,
    nextRecoveryAtSet: task.nextRecoveryAt !== undefined,
    stepStatuses: (task.steps ?? []).map((s) => s.status),
    workflowStepResultCount: task.workflowStepResults?.length,
  };
}

pgTest("move-path equivalence — side effects (Phase A2)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_move_equiv",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  /*
  Force the path. Absent key = production shape (inline); `true` = hooks.

  MUST be updateGlobalSettings, NOT updateSettings. `experimentalFeatures` is a
  GLOBAL-scoped key, and `moves.ts` reads it through `getSettingsFast()` (merged
  global + project) for exactly that reason. Writing it via the project store is
  silently accepted and never reaches `useWorkflow` — the first version of this
  suite did that and reported NINE passing "equivalence" cases while running the
  inline path twice. Hence `assertPathActive` below: a forcing mechanism that can
  fail silently makes every assertion downstream worthless.
  */
  async function setPath(path: "inline" | "hooks"): Promise<void> {
    const store = h.store();
    await store.updateGlobalSettings(
      path === "hooks"
        ? { experimentalFeatures: { workflowColumns: true } }
        // Explicit `false`, NOT `{}`: updateGlobalSettings MERGES, so an empty
        // object leaves a previously-set `true` in place and the next case runs
        // the hooks path while believing it is on inline. `assertPathActive`
        // caught exactly that leak across seven cases.
        : { experimentalFeatures: { workflowColumns: false } },
    );
    await assertPathActive(path);
  }

  /*
  Prove the flip took effect, using a behavior only ONE path produces: an
  undeclared target column. The inline path validates against the legacy
  `VALID_TRANSITIONS` map and reports "Valid targets: …"; the flag-ON path
  validates against the task's workflow and reports "Unknown column for this
  workflow." A path-selection regression therefore fails HERE, loudly, instead of
  turning every equivalence case into a tautology.
  */
  async function assertPathActive(path: "inline" | "hooks"): Promise<void> {
    const store = h.store();
    const probe = await store.createTask({ description: `path probe ${path}` });
    const err = await store
      .moveTask(probe.id, "not-a-column-any-workflow-declares")
      .then(() => null, (e: unknown) => e as Error);
    expect(err, `${path}: probe move should have been rejected`).toBeInstanceOf(Error);
    if (path === "hooks") {
      expect(err!.message, "hooks path not active — check updateGlobalSettings").toContain(
        "Unknown column for this workflow",
      );
    } else {
      expect(err!.message, "inline path not active").toContain("Valid targets:");
    }
    await store.deleteTask(probe.id);
  }

  /**
   * Run `scenario` once per path over a FRESH task each time, and return both
   * observations. The scenario receives the task id so it can drive whatever
   * move sequence the case needs.
   */
  async function bothPaths(
    seed: () => Promise<string>,
    scenario: (taskId: string) => Promise<void>,
  ): Promise<{ inline: MoveObservation; hooks: MoveObservation }> {
    const store = h.store();

    await setPath("inline");
    const inlineId = await seed();
    await scenario(inlineId);
    const inline = observe((await store.getTask(inlineId))!);

    await setPath("hooks");
    const hooksId = await seed();
    await scenario(hooksId);
    const hooks = observe((await store.getTask(hooksId))!);

    return { inline, hooks };
  }

  /** A task parked in `in-progress` with timing + progress state on it. */
  async function seedInProgress(): Promise<string> {
    const store = h.store();
    const task = await store.createTask({ description: "equivalence fixture" });
    await store.moveTask(task.id, "todo");
    await store.moveTask(task.id, "in-progress");
    return task.id;
  }

  it("EQUIVALENCE: in-progress → todo reopen (user) clears the same fields on both paths", async () => {
    const store = h.store();
    const { inline, hooks } = await bothPaths(seedInProgress, async (id) => {
      await store.updateTask(id, { status: "failed", error: "boom", blockedBy: "FN-9" });
      await store.moveTask(id, "todo", { moveSource: "user" });
    });

    // The whole point: field-by-field, not "it moved".
    expect(hooks).toEqual(inline);
    // Pin the behavior itself so a change that breaks BOTH paths identically
    // still fails here (equal-but-wrong is not equivalence worth having).
    expect(inline.status).toBeUndefined();
    expect(inline.error).toBeUndefined();
    expect(inline.blockedBy).toBeUndefined();
    expect(inline.userPaused).toBe(true); // user-source reopen to todo parks
  });

  it("EQUIVALENCE: engine-source reopen does NOT set userPaused on either path", async () => {
    const store = h.store();
    const { inline, hooks } = await bothPaths(seedInProgress, async (id) => {
      await store.moveTask(id, "todo", { moveSource: "engine" });
    });
    expect(hooks).toEqual(inline);
    expect(inline.userPaused).toBeUndefined();
  });

  it("EQUIVALENCE: preserveStatus keeps status/error on both paths", async () => {
    const store = h.store();
    const { inline, hooks } = await bothPaths(seedInProgress, async (id) => {
      await store.updateTask(id, { status: "failed", error: "branch conflict" });
      await store.moveTask(id, "todo", { preserveStatus: true });
    });
    expect(hooks).toEqual(inline);
    expect(inline.status).toBe("failed");
    expect(inline.error).toBe("branch conflict");
  });

  it("EQUIVALENCE: preservePause keeps an operator park through a teardown move (FN-7851)", async () => {
    const store = h.store();
    const { inline, hooks } = await bothPaths(seedInProgress, async (id) => {
      await store.updateTask(id, { paused: true, pausedReason: "operator" });
      await store.moveTask(id, "todo", { moveSource: "engine", preservePause: true });
    });
    expect(hooks).toEqual(inline);
    expect(inline.paused).toBe(true);
    expect(inline.pausedReason).toBe("operator");
  });

  it("EQUIVALENCE: timing accounting runs identically on in-progress exit and re-entry", async () => {
    const store = h.store();
    const { inline, hooks } = await bothPaths(seedInProgress, async (id) => {
      await store.moveTask(id, "todo", { moveSource: "engine" });
      await store.moveTask(id, "in-progress");
    });
    expect(hooks).toEqual(inline);
    // Both paths accounted the SAME segment, not merely "some number".
    expect(inline.cumulativeActiveMsBucket).toBeTypeOf("number");
    expect(hooks.cumulativeActiveMsBucket).toBe(inline.cumulativeActiveMsBucket);
    expect(inline.firstExecutionAtSet).toBe(true);
    expect(inline.executionStartedAtSet).toBe(true);
  });

  /*
  FNXC:MovePathEquivalence 2026-07-27-08:20 (PR #2468 review — greptile P2):
  Seed NON-DEFAULT progress before the move. With default steps, both paths observe the same empty
  progress and the case passes without characterising `preserveResumeState` at all — two paths that
  both wiped progress would agree just as happily. Seeding a mixed done/in-progress/pending shape
  plus a workflow-step result means equality now asserts that the progress SURVIVED, and the
  explicit post-conditions fail loudly if either path resets it.
  */
  it("EQUIVALENCE: preserveProgress/preserveResumeState keep step progress on both paths", async () => {
    const store = h.store();
    const { inline, hooks } = await bothPaths(seedInProgress, async (id) => {
      await store.updateTask(id, {
        steps: [
          { name: "Step 0", status: "done" },
          { name: "Step 1", status: "in-progress" },
          { name: "Step 2", status: "pending" },
        ],
        currentStep: 1,
        workflowStepResults: [
          {
            workflowStepId: "plan-review",
            workflowStepName: "Plan Review",
            status: "passed",
            source: "node",
            phase: "pre-merge",
          },
        ],
      } as never);
      await store.moveTask(id, "todo", { moveSource: "engine", preserveResumeState: true });
    });
    expect(hooks).toEqual(inline);
    // Post-conditions, so "equal" cannot mean "both wiped it".
    expect(inline.stepStatuses).toEqual(["done", "in-progress", "pending"]);
    expect(inline.workflowStepResultCount).toBe(1);
  });

  it("EQUIVALENCE: preserveWorktree keeps the worktree on both paths", async () => {
    const store = h.store();
    const { inline, hooks } = await bothPaths(seedInProgress, async (id) => {
      await store.updateTask(id, { worktree: "/tmp/wt/FN-X" });
      await store.moveTask(id, "todo", { moveSource: "engine", preserveWorktree: true });
    });
    expect(hooks).toEqual(inline);
    expect(inline.worktree).toBe("/tmp/wt/FN-X");
  });

  it("EQUIVALENCE: worktree is CLEARED by default on reopen on both paths", async () => {
    const store = h.store();
    const { inline, hooks } = await bothPaths(seedInProgress, async (id) => {
      await store.updateTask(id, { worktree: "/tmp/wt/FN-Y" });
      await store.moveTask(id, "todo", { moveSource: "engine" });
    });
    expect(hooks).toEqual(inline);
    expect(inline.worktree).toBeUndefined();
  });
});

pgTest("move-path equivalence — the flag gates MORE than side effects (Phase A2)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_move_diverge",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  async function setPath(path: "inline" | "hooks"): Promise<void> {
    // See the note on the sibling setPath: GLOBAL settings, not project.
    await h.store().updateGlobalSettings(
      path === "hooks"
        ? { experimentalFeatures: { workflowColumns: true } }
        : { experimentalFeatures: { workflowColumns: false } },
    );
  }

  /*
  These are NOT equivalence assertions — they are the measured divergences that
  make convergence an operator decision rather than a mechanical refactor. Each
  one is a behavior that would turn ON for every project the moment the hooks
  path becomes authoritative.
  */

  it("DIVERGENCE: rejection TYPE and MESSAGE differ — the legacy bare-Error contract is inline-only", async () => {
    const store = h.store();

    await setPath("inline");
    const a = await store.createTask({ description: "reject shape inline" });
    const inlineErr = await store
      .moveTask(a.id, "not-a-column-any-workflow-declares")
      .then(() => null, (e: unknown) => e as Error);

    await setPath("hooks");
    const b = await store.createTask({ description: "reject shape hooks" });
    const hooksErr = await store
      .moveTask(b.id, "not-a-column-any-workflow-declares")
      .then(() => null, (e: unknown) => e as Error);

    // Both reject — but not with the same type or the same message. The inline
    // path validates against the legacy VALID_TRANSITIONS map and throws a BARE
    // Error; the hooks path validates against the task's own workflow and throws
    // a typed TransitionRejectionError carrying a machine-readable `rejection`.
    expect(inlineErr).toBeInstanceOf(Error);
    expect(hooksErr).toBeInstanceOf(Error);
    expect((inlineErr as unknown as { rejection?: unknown }).rejection).toBeUndefined();
    expect((hooksErr as unknown as { rejection?: unknown }).rejection).toBeDefined();
    expect(inlineErr!.message).toContain("Valid targets:");
    expect(hooksErr!.message).toContain("Unknown column for this workflow");
  });

  it("UNPROVEN: in-transaction column capacity did NOT reject on EITHER path in this fixture", async () => {
    /*
    HONEST NEGATIVE RESULT — recorded rather than dropped, because the code gate
    is real and the practical impact is not what reading it suggests.

    STRUCTURALLY, `moves.ts` wraps the whole in-transaction capacity block in
    `if (useWorkflow && workflowIr && fromColumn !== toColumn)`, so it cannot run
    on the LIVE inline path at all. The obvious inference is "converging onto the
    hooks path turns store-level capacity rejection ON for every project" — a
    serious blast radius, since `capacity-exhausted` is a code the graph column
    boundary parks on and the promote route surfaces to operators.

    EMPIRICALLY that inference does not hold up: with `maxConcurrent: 1` and a
    wip column already occupied, the second move was ACCEPTED on both paths. So
    something further in (`resolveColumnCapacity`'s limit resolution, or what
    `countActiveInCapacitySlotAsync` counts as an occupant — a task with no
    session/agent may not count) keeps the check from firing even when the flag
    is on. This suite does not establish which.

    Consequence for the convergence decision: the capacity blast radius is
    UNQUANTIFIED, not absent. It needs its own investigation before either path
    is made authoritative — this test pins today's observed behavior so that
    investigation starts from a fact instead of the code reading.
    */
    const store = h.store();
    await store.updateSettings({ maxConcurrent: 1 });

    async function fillThenMoveSecond(): Promise<Error | null> {
      const first = await store.createTask({ description: "capacity holder" });
      await store.moveTask(first.id, "todo");
      await store.moveTask(first.id, "in-progress");
      const second = await store.createTask({ description: "capacity contender" });
      await store.moveTask(second.id, "todo");
      return store.moveTask(second.id, "in-progress").then(() => null, (e: unknown) => e as Error);
    }

    await setPath("inline");
    expect(await fillThenMoveSecond()).toBeNull();

    await setPath("hooks");
    // If a future change makes this reject, that is the capacity gate coming
    // alive — and this failure is the signal to re-open the blast-radius question.
    expect(await fillThenMoveSecond()).toBeNull();
  });
});
