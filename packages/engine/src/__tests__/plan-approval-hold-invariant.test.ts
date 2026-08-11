/*
FNXC:PlanApprovalHold 2026-07-27-19:30 (U7 / R4, R12 — workflow-owned lifecycle):

THE INVARIANT: while a task is blocked on a pending human approval decision, no
AUTOMATED path advances it — not the capacity release, not the plan-review
continuation seed, not the continuation drain. `isTaskBlockedOnApproval`
(`packages/core/src/task-merge.ts`) already declares itself "the single shared
predicate core and engine code must consult before rebounding, requeuing,
resuming, re-planning, or otherwise advancing a task". Before this suite it had
exactly ONE production consumer (`overseer-human-control-policy.ts`), and the
planning lane's three advance surfaces each re-derived their own weaker version
of "may I advance this card" from `paused`/`userPaused` alone.

WHY THE PLANNING LANE IS WHERE THIS BIT: the manual plan-approval gate parks the
card by writing `status: "awaiting-approval"` and RETURNING EARLY from
`finalizeApprovedTask` — before the release move. `specifyTask` then calls
`onSpecifyComplete` unconditionally (triage.ts), so the parked card is announced
as specified. For a PLAN-IN-PLACE card — one whose column already equals the
plan-review node's column (Coding (Ideas), or any `needs-replan` revision
resting in the default workflow's `todo`) — the seed's `node.column ===
task.column` precondition holds, so a runnable plan-review continuation is
written for a plan the operator has not approved. The drain then dispatches it,
Plan Review runs, its evidence lands, and the capacity sweep releases the card
into implementation. The operator's gate is skipped end to end.

Surface enumeration (AGENTS.md — "Fix the invariant, not the repro"). Every
automated surface that can advance a held card, and where each is covered:
  1. capacity release  — `issueRelease`, the single choke point every release
     surface funnels through (sweep, `promoteHeldTask`, `releaseHeldTaskByEvent`,
     the scheduler's `reserveSlot` guard) — guarded there rather than inside
     `isUnplannedForExecution`, because an approval-held card is not "unplanned".
     Guarded again inside the `moveTaskIf` predicate so a park landing mid-sweep
     cannot lose the race. Operator force-promote (`allowUnplanned`) deliberately
     still passes: that IS a human decision about this card.   [describe #1]
  2. continuation seed — `seedPreReleasePlanReviewContinuation` (normal
     completion) and `evaluateStrandedHoldContinuation` (FN-8592 self-healing
     re-seed). Both seeders, not just the one on the reported path. [describe #2]
  3. continuation drain— `resolvePlanningContinuationCandidate`, the classifier
     that decides whether a due work item is dispatched. Skipped (HELD), never
     cancelled: the operator may still approve, and a cancelled item would need
     a second repair to come back.                              [describe #3]
Both approval HOLD SHAPES are exercised, because `isTaskBlockedOnApproval`
accepts either and a status-only check would silently miss the other:
`status: "awaiting-approval"` and `paused` + `pausedReason:"awaiting-approval"`.

Each test below FAILS on the pre-fix code — the fix is a guard, and a guard that
cannot be shown to fail on the original defect is not a guard.

──────────────────────────────────────────────────────────────────────────────
ADDED IN REVIEW ROUND 1 (PR #2491), because correctly HOLDING a card is not free:

  4. `resolveParkedContinuationDeferral` — the due poll is a FIFO batch, and a
     skipped item stays `runnable` and due, so it re-fills a slot every pass.
     Before the guard an approval-held item was DISPATCHED and so never
     accumulated; parking it correctly means 20 parked cards would starve every
     newer plan-review continuation. This starvation is INTRODUCED by the guard,
     so it is fixed here, not filed.                            [describe #4]
  5. `drainDuePlanningContinuations` — the pass that APPLIES the deferral. The
     loop was extracted from a private runtime method for this test to exist at
     all; deleting the `defer(...)` call now fails. The deferral also carries the
     state the poll OBSERVED as a compare-and-set, so it cannot reset a claim
     another node took mid-pass (`running` was not covered by the store's
     terminal-state check). The store-side guard is proven against real
     PostgreSQL in `packages/core/src/__tests__/workflow-work-item-cas.test.ts`.
                                                                [describe #5]
*/
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { Task, TaskStore, WorkflowIr, WorkflowWorkItem } from "@fusion/core";
import { AWAITING_APPROVAL_PAUSE_REASON, PLAN_REVIEW_GROUP_ID } from "@fusion/core";

import { runHoldReleaseSweep, resetHoldReleaseInstrumentation } from "../execution/hold-release.js";
import {
  evaluateStrandedHoldContinuation,
  resumeApprovedPlanReviewHandoff,
  seedPreReleasePlanReviewContinuation,
} from "../plan-review-continuation.js";
import {
  drainDuePlanningContinuations,
  PARKED_CONTINUATION_DEFER_MS,
  resolveParkedContinuationDeferral,
  resolvePlanningContinuationCandidate,
  wakeApprovedPlanningContinuations,
  InProcessRuntime,
  type DuePlanningContinuationDrainDeps,
} from "../runtimes/in-process-runtime.js";
import { schedulerLog } from "../logger.js";

const WF = "custom:planning-lane";

function task(over: Partial<Task> = {}): Task {
  return {
    id: "FN-1",
    title: "t",
    description: "",
    column: "todo",
    status: null,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    columnMovedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  } as Task;
}

/**
 * The two hold shapes `isTaskBlockedOnApproval` accepts. Driven as a table so a
 * fix that checks only `status` fails the second row rather than passing by
 * covering the reported case alone.
 *
 * MEASURED, not assumed: the two shapes were NOT equally broken. The
 * `paused`-flag shape was already refused by the release sweep and the drain,
 * because both happen to test `paused` — it was refused for the wrong stated
 * reason, not advanced. Every genuine ADVANCE gap is on the STATUS-only shape,
 * which is precisely the one the plan-approval gate writes
 * (`updatePlanningStateIfStillCurrent(task, { status: "awaiting-approval" })`,
 * no pause flag). Both shapes are asserted anyway: a fix that covered only the
 * reported shape would leave the predicate's other half unexercised.
 *
 * Attribution: an approval hold is reported as `awaiting-approval` on both
 * shapes — for the pause-flag shape the `pausedReason` says so outright, so
 * "paused" would be the less specific answer. The ORDINARY_PAUSE row below is
 * the counter-case that keeps the new check from swallowing every pause.
 */
const APPROVAL_HOLDS: ReadonlyArray<{ label: string; fields: Partial<Task> }> = [
  { label: "status: awaiting-approval", fields: { status: "awaiting-approval" } },
  {
    label: "paused + pausedReason: awaiting-approval",
    fields: { paused: true, pausedReason: AWAITING_APPROVAL_PAUSE_REASON },
  },
];

/** A pause that has nothing to do with approval. Must still be attributed to the
 *  pause, so the approval check cannot become a catch-all for operator parks. */
const ORDINARY_PAUSE: Partial<Task> = { paused: true, pausedReason: "usage-limit" };

// ─────────────────────────────────────────────────────────────────────────────
// #1 — the capacity release surface
// ─────────────────────────────────────────────────────────────────────────────

/** A hold column with a capacity release and a downstream wip column. No
 *  plan-review node: the release must be refused on the approval hold ALONE,
 *  not as a side effect of the pre-release plan-review gate. */
function releaseIr(): WorkflowIr {
  return {
    version: "v2",
    id: WF,
    nodes: [],
    edges: [],
    columns: [
      { id: "todo", label: "Todo", traits: [{ trait: "hold", config: { release: "capacity" } }] },
      { id: "in-progress", label: "In progress", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
      { id: "done", label: "Done", traits: [{ trait: "complete" }] },
    ],
  } as unknown as WorkflowIr;
}

/**
 * `onLockedRead` models the live row as the task lock sees it, which is NOT
 * necessarily the snapshot `runHoldReleaseSweep` loaded at the top of the pass.
 * Without it the fake would move unconditionally and the in-transaction recheck
 * would be dead code that no test could distinguish from its absence.
 */
function releaseStore(tasks: Task[], onLockedRead?: (live: Task) => Task): TaskStore {
  const selection = { workflowId: WF, stepIds: [] };
  const ir = releaseIr();
  return {
    getSettings: vi.fn(async () => ({ maxConcurrent: 2 })),
    listTasks: vi.fn(async () => tasks),
    getTask: vi.fn(async (id: string) => tasks.find((t) => t.id === id) ?? null),
    moveTaskIf: vi.fn(async (
      id: string,
      column: string,
      predicate: (live: Task) => boolean | Promise<boolean>,
    ) => {
      const cur = tasks.find((t) => t.id === id)!;
      // The predicate is the authoritative guard; the fake must consult it or the
      // in-lock recheck is untested (PR #2491 review — greptile P2 / CodeRabbit).
      const live = onLockedRead ? onLockedRead(cur) : cur;
      if (!(await predicate(live))) return { task: cur, moved: false };
      cur.column = column;
      return { task: cur, moved: true };
    }),
    logEntry: vi.fn(async () => undefined),
    recordRunAuditEvent: vi.fn(async () => undefined),
    getCompletionHandoffAcceptedMarker: vi.fn(async () => null),
    listWorkflowWorkItemsForTask: vi.fn(async () => []),
    getTaskWorkflowSelection: vi.fn(() => selection),
    getTaskWorkflowSelectionAsync: vi.fn(async () => selection),
    getWorkflowDefinition: vi.fn(async () => ({ ir })),
  } as unknown as TaskStore;
}

describe("#1 the capacity release never advances a card blocked on approval", () => {
  beforeEach(() => {
    resetHoldReleaseInstrumentation();
    vi.restoreAllMocks();
    vi.spyOn(schedulerLog, "log").mockImplementation(() => {});
    vi.spyOn(schedulerLog, "debug").mockImplementation(() => {});
    vi.spyOn(schedulerLog, "warn").mockImplementation(() => {});
  });

  it("releases an ordinary held card (the control — proves the fixture can release at all)", async () => {
    const held = task({ id: "OK" });
    const result = await runHoldReleaseSweep(releaseStore([held]), { now: () => 1_000_000 });

    expect(result.released).toContain("OK");
    expect(held.column).toBe("in-progress");
  });

  for (const hold of APPROVAL_HOLDS) {
    it(`holds a card parked on approval (${hold.label}) instead of releasing it into wip`, async () => {
      const held = task({ id: "HOLD", ...hold.fields });
      const result = await runHoldReleaseSweep(releaseStore([held]), { now: () => 1_000_000 });

      // The operator has not decided yet: the card must still be in the hold column.
      expect(held.column).toBe("todo");
      expect(result.released).not.toContain("HOLD");
    });

    it(`refuses IN THE LOCK when the hold (${hold.label}) lands after the sweep's snapshot`, async () => {
      // The snapshot is clean, so the pre-check passes and the sweep proceeds to
      // the move — the only thing that can still stop it is the predicate under
      // the task lock. This is the race the in-txn half exists for: a plan gate
      // (or an operator) parking the card mid-pass must win.
      const held = task({ id: "RACE" });
      const store = releaseStore([held], (live) => ({ ...live, ...hold.fields }));

      const result = await runHoldReleaseSweep(store, { now: () => 1_000_000 });

      expect(held.column).toBe("todo");
      expect(result.released).not.toContain("RACE");
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// #2 — the two continuation seeders
// ─────────────────────────────────────────────────────────────────────────────

/** Plan-in-place shape: the plan-review node sits in the SAME column the card
 *  rests in, which is the precondition both seeders require. */
function planInPlaceIr(): WorkflowIr {
  return {
    version: "v2",
    id: WF,
    name: WF,
    columns: [
      { id: "todo", label: "Todo", traits: [{ trait: "hold", config: { release: "capacity" } }] },
      { id: "in-progress", label: "In progress", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
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

function seedStore(): { store: TaskStore; seeded: () => number } {
  let seeds = 0;
  const store = {
    listWorkflowWorkItemsForTask: vi.fn(async () => [] as WorkflowWorkItem[]),
    replaceActiveTaskWorkflowContinuation: vi.fn(async () => {
      seeds += 1;
      return { id: "wi-1" } as WorkflowWorkItem;
    }),
    seedStrandedPlanReviewContinuation: vi.fn(async () => {
      seeds += 1;
      return { seeded: true, workItemId: "wi-1" };
    }),
  } as unknown as TaskStore;
  return { store, seeded: () => seeds };
}

describe("#2 neither continuation seeder arms a run for a card blocked on approval", () => {
  it("seeds for an ordinary specified card (the control)", async () => {
    const { store, seeded } = seedStore();
    const result = await seedPreReleasePlanReviewContinuation(store, task(), planInPlaceIr());

    expect(result.seeded).toBe(true);
    expect(seeded()).toBe(1);
  });

  for (const hold of APPROVAL_HOLDS) {
    it(`refuses the normal-completion seed (${hold.label})`, async () => {
      const { store, seeded } = seedStore();
      const result = await seedPreReleasePlanReviewContinuation(
        store,
        task({ ...hold.fields }),
        planInPlaceIr(),
      );

      expect(result.seeded).toBe(false);
      expect(result.reason).toBe("awaiting-approval");
      expect(seeded()).toBe(0);
    });

    it(`refuses the FN-8592 self-healing re-seed (${hold.label})`, () => {
      const verdict = evaluateStrandedHoldContinuation({
        task: task({ ...hold.fields }),
        columnFlags: { hold: true },
        ir: planInPlaceIr(),
        continuations: [],
        stepResults: [],
        effectiveSettings: {},
        enginePaused: false,
        promptContent: "# FN-1 real spec\n\nA genuine plan.\n",
        live: false,
        stalenessMs: 60 * 60 * 1000,
        graceMs: 1000,
      });

      // Not "stranded": the card is exactly where the operator's decision left it.
      expect(verdict.stranded).toBe(false);
      expect(verdict.reason).toBe("awaiting-approval");
    });
  }

  it("still attributes an ORDINARY pause to the pause, not to approval", async () => {
    const { store, seeded } = seedStore();
    const seed = await seedPreReleasePlanReviewContinuation(
      store,
      task({ ...ORDINARY_PAUSE }),
      planInPlaceIr(),
    );
    expect(seed.seeded).toBe(false);
    expect(seed.reason).toBe("paused");
    expect(seeded()).toBe(0);

    const verdict = evaluateStrandedHoldContinuation({
      task: task({ ...ORDINARY_PAUSE }),
      columnFlags: { hold: true },
      ir: planInPlaceIr(),
      continuations: [],
      stepResults: [],
      effectiveSettings: {},
      enginePaused: false,
      promptContent: "# FN-1 real spec\n\nA genuine plan.\n",
      live: false,
      stalenessMs: 60 * 60 * 1000,
      graceMs: 1000,
    });
    expect(verdict.reason).toBe("paused");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #2b — the approved-plan public handoff
// ─────────────────────────────────────────────────────────────────────────────

describe("#2b approved-plan handoff resumes only canonical graph work", () => {
  it("creates one atomic runnable Plan Review continuation for an approved plan", async () => {
    const { store } = seedStore();

    const result = await resumeApprovedPlanReviewHandoff(store, task(), planInPlaceIr());

    expect(result).toMatchObject({ resumed: true, reason: "seeded", workItemId: "wi-1" });
    expect(store.seedStrandedPlanReviewContinuation).toHaveBeenCalledOnce();
    expect(store.replaceActiveTaskWorkflowContinuation).not.toHaveBeenCalled();
  });

  it("does not duplicate an active continuation", async () => {
    const { store, seeded } = seedStore();
    (store.listWorkflowWorkItemsForTask as ReturnType<typeof vi.fn>).mockResolvedValue([
      dueItem({ state: "running" }),
    ]);

    await expect(resumeApprovedPlanReviewHandoff(store, task(), planInPlaceIr())).resolves.toEqual({
      resumed: false,
      reason: "active-continuation",
    });
    expect(seeded()).toBe(0);
  });

  it("does not replace satisfied Plan Review evidence", async () => {
    const { store, seeded } = seedStore();
    (store.seedStrandedPlanReviewContinuation as ReturnType<typeof vi.fn>).mockResolvedValue({
      seeded: false,
      reason: "plan-review-passed",
    });

    await expect(resumeApprovedPlanReviewHandoff(store, task(), planInPlaceIr())).resolves.toEqual({
      resumed: false,
      reason: "plan-review-passed",
    });
    expect(seeded()).toBe(0);
  });

  it.each([
    ["approval hold", task({ status: "awaiting-approval" })],
    ["pause", task({ paused: true })],
    ["dependency replan fence", task({ status: "needs-replan" })],
  ])("leaves %s to its existing lifecycle owner", async (_label, heldTask) => {
    const { store, seeded } = seedStore();

    const result = await resumeApprovedPlanReviewHandoff(store, heldTask, planInPlaceIr());

    expect(result.resumed).toBe(false);
    expect(seeded()).toBe(0);
  });

  it("uses a successor identity when terminal history is present", async () => {
    const terminal = dueItem({ state: "failed" });
    const { store } = seedStore();
    (store.listWorkflowWorkItemsForTask as ReturnType<typeof vi.fn>).mockResolvedValue([terminal]);

    await resumeApprovedPlanReviewHandoff(store, task(), planInPlaceIr());

    expect(store.seedStrandedPlanReviewContinuation).toHaveBeenCalledWith(expect.objectContaining({
      continuationSequence: 1,
      runId: expect.stringContaining(":1"),
    }));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #3 — the continuation drain
// ─────────────────────────────────────────────────────────────────────────────

const dueItem = (over: Partial<WorkflowWorkItem> = {}): WorkflowWorkItem =>
  ({
    id: "wi-1",
    taskId: "FN-1",
    nodeId: PLAN_REVIEW_GROUP_ID,
    kind: "task",
    state: "runnable",
    waitReason: "planning",
    ...over,
  } as WorkflowWorkItem);

describe("#3 the continuation drain holds, and never cancels, an approval-blocked item", () => {
  it("dispatches for an ordinary card (the control)", () => {
    expect(resolvePlanningContinuationCandidate(dueItem(), task()).kind).toBe("actionable");
  });

  /*
  FNXC:WorkflowResolvedColumns 2026-07-31-06:50 (fleet phase — the drain's TERMINAL test):
  `resolvePlanningContinuationCandidate` orphans a continuation whose task has reached a terminal lane.
  That test was `column === "archived" || column === "done"`, so on a renamed board it matched nothing and
  a FINISHED card's planning continuation was still handed to the executor — re-entering plan review on
  work that is already done.

  `lifecycle` is optional, so every case above keeps asserting the legacy-id behaviour unchanged; these
  two supply it. That is also why none of the existing 25 cases could have caught this.

  REVERT CHECK, measured: restoring the literals makes the renamed case fail — kind is "actionable"
  where it must be "orphan". The default-vocabulary case passes either way.
  */
  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-21:10 (adapted to main's API, which is the better one):
  Main converted this seam while my branch was open and chose `terminalColumns: ReadonlySet<string>` —
  MEMBERSHIP — where mine passed a `LifecycleColumns` and read `.complete` / `.archived`, i.e.
  first-per-role. A workflow with two complete lanes would have defeated mine. Same arity lesson as the
  routes review resolver, the FN-7720 bypass guard, and dependency satisfaction; main's shape wins and
  the case is rewritten against it rather than the other way round.
  */
  const RENAMED_TERMINAL_COLUMNS: ReadonlySet<string> = new Set(["shipped", "attic"]);

  it("orphans a continuation whose card reached a RENAMED terminal lane", () => {
    for (const column of ["shipped", "attic"]) {
      const resolved = resolvePlanningContinuationCandidate(
        dueItem(),
        task({ column } as never),
        { terminalColumns: RENAMED_TERMINAL_COLUMNS },
      );
      expect(resolved.kind, `${column} should be terminal`).toBe("orphan");
      if (resolved.kind === "orphan") expect(resolved.reason).toBe("task-terminal");
    }
  });

  it("still dispatches for a live card on that same renamed board", () => {
    // Non-vacuous: the terminal test must not swallow every column on a renamed board.
    const resolved = resolvePlanningContinuationCandidate(
      dueItem(),
      task({ column: "building" } as never),
      { terminalColumns: RENAMED_TERMINAL_COLUMNS },
    );
    expect(resolved.kind).toBe("actionable");
  });

  for (const hold of APPROVAL_HOLDS) {
    it(`skips dispatch (${hold.label}) and leaves the item claimable for after the decision`, () => {
      const resolved = resolvePlanningContinuationCandidate(dueItem(), task({ ...hold.fields }));

      expect(resolved.kind).toBe("skip");
      // Deliberately NOT "orphan": cancelling would terminalize the item, so an
      // approval landing later would have nothing left to resume.
      expect(resolved.kind === "skip" && resolved.reason).toBe("awaiting-approval");
    });
  }

  it("still attributes an ORDINARY pause to the pause, not to approval", () => {
    const resolved = resolvePlanningContinuationCandidate(dueItem(), task({ ...ORDINARY_PAUSE }));

    expect(resolved.kind).toBe("skip");
    expect(resolved.kind === "skip" && resolved.reason).toBe("paused");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #4 — the starvation the guard would otherwise introduce
// ─────────────────────────────────────────────────────────────────────────────

/*
FNXC:PlanApprovalHold 2026-07-27-21:30 (U7, PR #2491 review — greptile P1):
Skipping is not free. The due poll is a FIFO batch (`limit: 20`) and a skipped item
stays `runnable` and due, so it re-occupies a slot every pass. Before the approval
guard an approval-held item was DISPATCHED and therefore never accumulated — so
this starvation is a consequence the guard INTRODUCES, and it is fixed here rather
than noted. A parked item is pushed out of the due window instead.
*/
describe("#4 an operator-parked item leaves the due window instead of starving the batch", () => {
  const NOW = Date.parse("2026-07-27T12:00:00.000Z");

  for (const hold of APPROVAL_HOLDS) {
    it(`defers the approval-parked item (${hold.label})`, () => {
      const resolved = resolvePlanningContinuationCandidate(dueItem(), task({ ...hold.fields }));
      const deferral = resolveParkedContinuationDeferral(resolved, NOW);

      expect(deferral?.itemId).toBe("wi-1");
      // Pushed strictly into the future, so the next due poll does not return it.
      expect(Date.parse(deferral!.retryAfter)).toBe(NOW + PARKED_CONTINUATION_DEFER_MS);
      expect(Date.parse(deferral!.retryAfter)).toBeGreaterThan(NOW);
    });
  }

  it("defers an ordinary pause too — the same open-ended human wait", () => {
    const resolved = resolvePlanningContinuationCandidate(dueItem(), task({ ...ORDINARY_PAUSE }));

    expect(resolveParkedContinuationDeferral(resolved, NOW)?.itemId).toBe("wi-1");
  });

  it("never defers an ACTIONABLE item — deferring work that is ready would stall the lane", () => {
    const resolved = resolvePlanningContinuationCandidate(dueItem(), task());

    expect(resolved.kind).toBe("actionable");
    expect(resolveParkedContinuationDeferral(resolved, NOW)).toBeNull();
  });

  /*
  FNXC:WorkflowScheduling 2026-08-11-17:30:
  This case previously asserted that a `capacity` item is SKIPPED as "not-planning" because it
  "belongs to a different drain". No such drain exists, and that skip stranded eight cards for up to
  8h on 2026-08-11. The deferral outcome is unchanged (still null) but for the opposite reason: the
  item is actionable now, and deferring ready work would stall the lane.
  */
  it("never defers a non-planning item — it is actionable, and deferring ready work stalls the lane", () => {
    const resolved = resolvePlanningContinuationCandidate(
      dueItem({ waitReason: "capacity" }),
      task(),
    );

    expect(resolved.kind).toBe("actionable");
    expect(resolveParkedContinuationDeferral(resolved, NOW)).toBeNull();
  });

  it("never defers an ORPHAN — a cancelled item is terminal and must not be resurrected as runnable", () => {
    const resolved = resolvePlanningContinuationCandidate(dueItem(), null);

    expect(resolved.kind).toBe("orphan");
    expect(resolveParkedContinuationDeferral(resolved, NOW)).toBeNull();
  });
});

describe("#4b an approval decision removes the human-wait delay", () => {
  it("clears retryAfter on runnable planning continuations and kicks the drain", async () => {
    const transition = vi.fn().mockResolvedValue(undefined);
    const kick = vi.fn();
    const retryAfter = new Date(Date.now() + PARKED_CONTINUATION_DEFER_MS).toISOString();

    await expect(wakeApprovedPlanningContinuations({
      taskId: "FN-1",
      list: async () => [
        dueItem({ retryAfter }),
        dueItem({ id: "capacity", waitReason: "capacity", retryAfter }),
      ],
      transition,
      kick,
      warn: vi.fn(),
    })).resolves.toBe(1);

    expect(transition).toHaveBeenCalledWith("wi-1", "runnable", {
      expectedState: "runnable",
      retryAfter: null,
    });
    expect(transition).not.toHaveBeenCalledWith("capacity", expect.anything(), expect.anything());
    expect(kick).toHaveBeenCalledOnce();
  });

  it("keeps releasing after one transition fails and always kicks the drain", async () => {
    const retryAfter = new Date(Date.now() + PARKED_CONTINUATION_DEFER_MS).toISOString();
    const transition = vi.fn()
      .mockRejectedValueOnce(new Error("lost CAS"))
      .mockResolvedValueOnce(undefined);
    const warn = vi.fn();
    const kick = vi.fn();

    await expect(wakeApprovedPlanningContinuations({
      taskId: "FN-1",
      list: async () => [dueItem({ id: "first", retryAfter }), dueItem({ id: "second", retryAfter })],
      transition,
      kick,
      warn,
    })).resolves.toBe(1);

    expect(transition).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("first"));
    expect(kick).toHaveBeenCalledOnce();
  });

  it("wires an approval task update through the runtime to the deferred continuation", async () => {
    const retryAfter = new Date(Date.now() + PARKED_CONTINUATION_DEFER_MS).toISOString();
    const transitionWorkflowWorkItem = vi.fn().mockResolvedValue(undefined);
    const store = Object.assign(new EventEmitter(), {
      listWorkflowWorkItemsForTask: vi.fn().mockResolvedValue([dueItem({ retryAfter })]),
      transitionWorkflowWorkItem,
    });
    const runtime = new InProcessRuntime({
      projectId: "test-project",
      projectName: "Test",
      workingDirectory: "/test/project",
      isolationMode: "in-process",
    }, {} as never);
    (runtime as any).taskStore = store;
    const kick = vi.spyOn(runtime as any, "kickWorkflowContinuationProcessor").mockImplementation(() => undefined);
    (runtime as any).setupEventForwarding();

    store.emit("task:updated", task({ status: "awaiting-approval" }));
    store.emit("task:updated", task({ status: null, approvedPlanFingerprint: "approved" }));

    await vi.waitFor(() => expect(transitionWorkflowWorkItem).toHaveBeenCalledWith(
      "wi-1",
      "runnable",
      { expectedState: "runnable", retryAfter: null },
    ));
    expect(kick).toHaveBeenCalledOnce();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #5 — the drain PASS itself: the deferral is applied, and it is a compare-and-set
// ─────────────────────────────────────────────────────────────────────────────

/*
FNXC:PlanApprovalHold 2026-07-27-22:10 (U7, PR #2491 review — CodeRabbit + greptile P1):
#4 tests the deferral DECISION; these test that the pass actually applies it, which
is the half that was unprovable while the loop lived inside a private method of a
class whose construction attaches to the real project registry. Deleting the
`defer(...)` call from the pass now fails here.

The CAS case is the greptile P1 half: a blind write would reset a claim another node
took between the due poll and the write. The store's terminal-state check already
refuses cancelled/succeeded/failed, so `running` was the unguarded gap — deferral is
a fairness optimization and must never disturb live work to get it.
*/
function drainHarness(
  items: WorkflowWorkItem[],
  tasks: Record<string, Task>,
): {
  deps: DuePlanningContinuationDrainDeps;
  dispatched: string[];
  deferred: Array<{ itemId: string; expectedState: string; retryAfter: string }>;
  cancelled: Array<{ itemId: string; reason: string }>;
} {
  const dispatched: string[] = [];
  const deferred: Array<{ itemId: string; expectedState: string; retryAfter: string }> = [];
  const cancelled: Array<{ itemId: string; reason: string }> = [];
  return {
    dispatched,
    deferred,
    cancelled,
    deps: {
      listDue: async () => items,
      getTask: async (taskId) => tasks[taskId],
      cancelOrphan: async (item, reason) => { cancelled.push({ itemId: item.id, reason }); },
      defer: async (d) => { deferred.push(d); },
      dispatch: (task, item) => { dispatched.push(`${task.id}@${item.id}`); },
      nowMs: () => Date.parse("2026-07-27T12:00:00.000Z"),
      warn: () => {},
    },
  };
}

describe("#5 the drain pass applies the deferral and never starves a ready card", () => {
  it("defers the approval-parked item, dispatches the actionable one, and does not cancel either", async () => {
    const parked = dueItem({ id: "wi-parked", taskId: "FN-PARKED" });
    const ready = dueItem({ id: "wi-ready", taskId: "FN-READY" });
    const h = drainHarness([parked, ready], {
      "FN-PARKED": task({ id: "FN-PARKED", status: "awaiting-approval" }),
      "FN-READY": task({ id: "FN-READY" }),
    });

    await drainDuePlanningContinuations(h.deps);

    // The parked card leaves the due window; the ready card behind it still runs.
    expect(h.deferred.map((d) => d.itemId)).toEqual(["wi-parked"]);
    expect(h.dispatched).toEqual(["FN-READY@wi-ready"]);
    expect(h.cancelled).toEqual([]);
  });

  it("carries the OBSERVED state as the compare-and-set guard, so a claim taken mid-pass is not reset", async () => {
    // The due poll returns `runnable`; the write must be conditional on exactly
    // that, so a concurrent `running` claim makes the store's CAS a no-op.
    const parked = dueItem({ id: "wi-parked", taskId: "FN-PARKED", state: "runnable" });
    const h = drainHarness([parked], {
      "FN-PARKED": task({ id: "FN-PARKED", status: "awaiting-approval" }),
    });

    await drainDuePlanningContinuations(h.deps);

    expect(h.deferred).toHaveLength(1);
    expect(h.deferred[0].expectedState).toBe("runnable");
    expect(Date.parse(h.deferred[0].retryAfter)).toBe(
      Date.parse("2026-07-27T12:00:00.000Z") + PARKED_CONTINUATION_DEFER_MS,
    );
  });

  it("cancels an orphan WITHOUT deferring it — a terminal item must not be written back as runnable", async () => {
    const orphan = dueItem({ id: "wi-orphan", taskId: "FN-GONE" });
    const h = drainHarness([orphan], {});

    await drainDuePlanningContinuations(h.deps);

    expect(h.cancelled).toEqual([{ itemId: "wi-orphan", reason: "task-not-found" }]);
    expect(h.deferred).toEqual([]);
    expect(h.dispatched).toEqual([]);
  });

  it("a getTask throw is an orphan, not an aborted pass — later items still dispatch (FN-8470/FN-8471)", async () => {
    const bad = dueItem({ id: "wi-bad", taskId: "FN-THROWS" });
    const ready = dueItem({ id: "wi-ready", taskId: "FN-READY" });
    const h = drainHarness([bad, ready], { "FN-READY": task({ id: "FN-READY" }) });
    const deps: DuePlanningContinuationDrainDeps = {
      ...h.deps,
      getTask: async (taskId) => {
        if (taskId === "FN-THROWS") throw new Error("soft-deleted, no archive snapshot");
        return task({ id: "FN-READY" });
      },
    };

    await drainDuePlanningContinuations(deps);

    expect(h.cancelled).toEqual([{ itemId: "wi-bad", reason: "task-not-found" }]);
    expect(h.dispatched).toEqual(["FN-READY@wi-ready"]);
  });
});
