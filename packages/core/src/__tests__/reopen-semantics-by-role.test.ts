// @vitest-environment node
/*
FNXC:WorkflowLifecycleColumns 2026-07-30-08:20 (Phase C convergence — default-workflow-hooks.ts):

THE INVARIANT: a reopen is "live work (wip/review/complete) back into a planning lane
(intake/hold)", decided from the moving task's OWN workflow — not from the default
lineage's column names.

WHY THIS IS A SAFETY TEST AND NOT A TIDYING TEST. `default-workflow-hooks.ts` is named
for the default workflow but the store runs it on the flag-ON path for EVERY workflow
(the trait registry resolves each hook by trait id, not by workflow). Its reopen
predicates were lists of the default lineage's names, so on a renamed board every reopen
effect silently did nothing. One of those effects clears `workflowStepResults`, and
`getTaskMergeBlocker` reads exactly that: a card bounced out of review kept its OLD
review results, and a `passed` result satisfies the merge gate. So a renamed workflow
could merge with its re-review never run — the same regression the graph-owned-crossing
carve-out in `applyReopenFieldClears` exists to prevent, arriving through the other door.

The `todo`/`triage` names are the thing being removed here, which is why this file is
part of the triage-guard convergence and not a separate refactor: `default-workflow-hooks.ts`
held 4 of them and `moves.ts`'s flag-ON mirror held 1 more.

WHAT IS DELIBERATELY NOT CONVERTED: the flag-OFF inline block in `moves.ts` (~line 867).
That branch IS the legacy path and is kept verbatim on purpose so the two paths can be
parity-checked; converting it would erase the reference implementation.
*/
import { describe, it, expect, beforeEach } from "vitest";

import { __resetTraitRegistryForTests } from "../trait-registry.js";
import { registerBuiltinTraits } from "../builtin-traits.js";
import {
  __resetDefaultWorkflowHooksForTests,
  applyCompletionTimingEffects,
  applyDefaultWorkflowMoveEffects,
  applyInReviewEnterEffects,
  applyTimingEffects,
  isReopenIntoPlanning,
  registerDefaultWorkflowHooks,
  type DefaultWorkflowMoveContext,
} from "../default-workflow-hooks.js";
import { getTotalAgentActiveMs } from "../task-timing.js";
import { resolveLifecycleColumns } from "../workflow-lifecycle-traits.js";
import type { WorkflowIr } from "../workflow-ir-types.js";
import type { Task } from "../types.js";

/** A board whose columns carry the SAME traits under DIFFERENT names. */
const RENAMED_IR = {
  version: "v2",
  id: "wf-renamed",
  name: "renamed",
  nodes: [],
  edges: [],
  columns: [
    { id: "backlog", name: "Backlog", traits: [{ trait: "intake" }] },
    { id: "queued", name: "Queued", traits: [{ trait: "hold", config: { release: "capacity" } }] },
    { id: "building", name: "Building", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
    { id: "checking", name: "Checking", traits: [{ trait: "merge" }, { trait: "merge-blocker" }] },
    { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
  ],
} as unknown as WorkflowIr;

/** The post-U11 default lineage: `todo` is intake AND hold; `triage` is gone (#2515). */
const DEFAULT_IR = {
  version: "v2",
  id: "wf-default",
  name: "default",
  nodes: [],
  edges: [],
  columns: [
    { id: "todo", name: "Planning", traits: [{ trait: "intake" }, { trait: "hold", config: { release: "capacity" } }] },
    { id: "in-progress", name: "In Progress", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
    { id: "in-review", name: "In Review", traits: [{ trait: "merge" }, { trait: "merge-blocker" }] },
    { id: "done", name: "Done", traits: [{ trait: "complete" }] },
  ],
} as unknown as WorkflowIr;

function makeCtx(
  ir: WorkflowIr | undefined,
  fromColumn: string,
  toColumn: string,
  overrides: Partial<DefaultWorkflowMoveContext> = {},
): DefaultWorkflowMoveContext {
  const task = {
    id: "FN-1",
    column: toColumn,
    columnMovedAt: "2026-07-30T00:00:00.000Z",
    steps: [],
    dependencies: [],
    status: "failed",
    error: "boom",
    branch: "fusion/FN-1",
    summary: "old summary",
    workflowStepResults: [{ workflowStepId: "review", status: "passed" }],
  } as unknown as Task;
  return {
    task,
    fromColumn,
    toColumn,
    moveSource: "engine",
    bypassGuards: false,
    movedAt: "2026-07-30T00:00:01.000Z",
    settings: undefined,
    options: {},
    lifecycleColumns: ir ? resolveLifecycleColumns(ir) : undefined,
    resetSteps: () => {},
    ...overrides,
  };
}

function applyOn(ir: WorkflowIr | undefined, fromColumn: string, toColumn: string, overrides = {}) {
  const ctx = makeCtx(ir, fromColumn, toColumn, overrides);
  applyDefaultWorkflowMoveEffects(ctx);
  return ctx.task;
}

describe("a reopen is decided by lifecycle ROLE, not by the default lineage's names", () => {
  beforeEach(() => {
    __resetTraitRegistryForTests();
    __resetDefaultWorkflowHooksForTests();
    registerBuiltinTraits();
    registerDefaultWorkflowHooks();
  });

  it("clears stale review results when a RENAMED board bounces review -> hold", () => {
    // THE SAFETY CASE. Pre-fix: `checking`/`queued` matched none of the hard-coded
    // names, so the `passed` review result survived the bounce and `getTaskMergeBlocker`
    // would have let the card merge with its re-review never run.
    const task = applyOn(RENAMED_IR, "checking", "queued");

    expect(task.workflowStepResults).toBeUndefined();
    expect(task.branch).toBeUndefined();
    expect(task.summary).toBeUndefined();
  });

  it("clears the failure state when a RENAMED board bounces wip -> intake", () => {
    const task = applyOn(RENAMED_IR, "building", "backlog");

    expect(task.status).toBeUndefined();
    expect(task.error).toBeUndefined();
  });

  it("parks a user-source rebound into the renamed HOLD lane", () => {
    // Pre-fix the park never happened off the default lineage, so the scheduler
    // re-dispatched the card the operator had just pulled back.
    const task = applyOn(RENAMED_IR, "building", "queued", { moveSource: "user" as const });

    expect(task.userPaused).toBe(true);
  });

  it("still does the same on the DEFAULT lineage (the conversion is not a rename)", () => {
    const task = applyOn(DEFAULT_IR, "in-review", "todo");

    expect(task.workflowStepResults).toBeUndefined();
    expect(task.branch).toBeUndefined();
    expect(task.status).toBeUndefined();
  });

  it("does NOT treat a forward move into wip as a reopen on a renamed board", () => {
    // The paired negative: "clears everything always" must not be able to pass for
    // "reads the roles". A backlog -> building move keeps the card's own state.
    const task = applyOn(RENAMED_IR, "backlog", "building");

    expect(task.status).toBe("failed");
    expect(task.workflowStepResults).toHaveLength(1);
  });

  it("does NOT clear results on the graph's own review -> wip crossing (carve-out survives)", () => {
    const task = applyOn(RENAMED_IR, "checking", "building", {
      workflowMoveSource: "workflow-graph",
    });

    expect(task.workflowStepResults).toHaveLength(1);
  });

  it("DOES clear results on an operator-dragged review -> wip crossing", () => {
    const task = applyOn(RENAMED_IR, "checking", "building");

    expect(task.workflowStepResults).toBeUndefined();
  });
});

describe("no column vocabulary is the only case a legacy name is legitimate", () => {
  beforeEach(() => {
    __resetTraitRegistryForTests();
    __resetDefaultWorkflowHooksForTests();
    registerBuiltinTraits();
    registerDefaultWorkflowHooks();
  });

  it("falls back to the legacy names for a v1 / column-less IR", () => {
    // `resolveLifecycleColumns` returns undefined for the WHOLE struct here, which means
    // "no basis to decide" — not "declares no hold column". The legacy names are all
    // there is, and a pre-v2 row really does live in `in-review`/`todo`.
    const task = applyOn(undefined, "in-review", "todo");

    expect(task.workflowStepResults).toBeUndefined();
    expect(task.status).toBeUndefined();
  });

  it("does NOT substitute a legacy name for a role the workflow genuinely lacks", () => {
    // A workflow with intake but NO hold: `queued` is not a lane on this board, so a move
    // there is not a reopen. Substituting `todo` would invent a lane the operator removed.
    const holdlessIr = {
      version: "v2", id: "wf-no-hold", name: "no-hold", nodes: [], edges: [],
      columns: [
        { id: "backlog", name: "Backlog", traits: [{ trait: "intake" }] },
        { id: "building", name: "Building", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
      ],
    } as unknown as WorkflowIr;

    const lifecycle = resolveLifecycleColumns(holdlessIr);

    expect(isReopenIntoPlanning(lifecycle, "building", "todo")).toBe(false);
    expect(isReopenIntoPlanning(lifecycle, "building", "backlog")).toBe(true);
  });
});

describe("the store's reopen check and the hooks' cannot disagree", () => {
  beforeEach(() => {
    __resetTraitRegistryForTests();
    registerBuiltinTraits();
  });

  it("answers identically for every from/to pair on a renamed board", () => {
    /*
    `moves.ts` used to carry its own hand-written copy of this predicate, annotated
    "parity mirror". Two copies of one rule diverge on whichever the next edit misses;
    it now calls this function. This pins that there is ONE answer per pair, which is the
    property the mirror was trying to have.
    */
    const lifecycle = resolveLifecycleColumns(RENAMED_IR);
    const columns = ["backlog", "queued", "building", "checking", "shipped"];

    const reopens = columns.flatMap((from) =>
      columns.filter((to) => isReopenIntoPlanning(lifecycle, from, to)).map((to) => `${from}->${to}`),
    );

    expect(reopens.sort()).toEqual([
      "building->backlog",
      "building->queued",
      "checking->backlog",
      "checking->queued",
      "shipped->backlog",
      "shipped->queued",
    ]);
  });
});

/*
FNXC:WorkflowResolvedColumns 2026-07-31-04:40 (fleet phase — the same safety argument, applied to TIMING):
The header of this file explains why the reopen predicates had to stop naming the default lineage: these
hooks run on the flag-ON path for EVERY workflow, because the trait registry resolves each hook by trait
id, not by workflow. The timing, completion and in-review hooks had the same defect and were not part of
that conversion.

What it costs on a renamed board, none of it throwing:
  - `applyTimingEffects` accrues `cumulativeActiveMs` while a card sits in the WIP lane. With the lane
    named, the exit test never fires, so NO active time is accrued and every duration display —
    `productivity-analytics.ts`, `task-timing.ts` — reads zero.
  - `applyCompletionTimingEffects` never stamps `executionCompletedAt`, so a finished card looks
    unfinished to anything reading that field.
  - `applyInReviewEnterEffects` returns early, so the recovery counters it clears stay set.

THE HOOKS ARE CALLED DIRECTLY here, not through `applyDefaultWorkflowMoveEffects`. I wrote it through the
dispatcher first and all three cases failed on the DEFAULT lineage too: the dispatcher resolves hooks by
TRAIT, and neither test IR declares the `timing` trait, so those hooks never ran at all. Going through the
dispatcher would have tested the trait registry's wiring, not this conversion — and would have looked like
a conversion bug.

REVERT CHECK, measured (all three run): restoring the `in-progress` literals leaves `cumulativeActiveMs`
undefined on the renamed board; restoring the `done` literal leaves `executionCompletedAt` unset;
restoring the `in-review` literal leaves `recoveryRetryCount` at 3. Every case runs on BOTH lineages, and
the default one passes either way — which is the point of running it.
*/
describe("timing, completion and in-review effects are keyed on ROLES", () => {
  const LINEAGES = [
    { label: "default", ir: DEFAULT_IR, wip: "in-progress", review: "in-review", complete: "done" },
    { label: "renamed", ir: RENAMED_IR, wip: "building", review: "checking", complete: "shipped" },
  ] as const;

  it("accrues active time leaving the WIP lane on both lineages", () => {
    for (const { label, ir, wip, review } of LINEAGES) {
      const ctx = makeCtx(ir, wip, review, {
        task: {
          id: "FN-2",
          column: review,
          columnMovedAt: "2026-07-30T00:05:00.000Z",
          executionStartedAt: "2026-07-30T00:00:00.000Z",
          steps: [],
          dependencies: [],
          workflowStepResults: [],
        } as unknown as Task,
      });
      applyTimingEffects(ctx);
      expect(ctx.task.cumulativeActiveMs, `${label} lineage accrued no active time`).toBe(5 * 60_000);
    }
  });

  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-18:40 (#2842 review — greptile P1, "preserved segment start
  double-counts runtime"):

  THIS PINS A REAL DEFECT AND DOES NOT FIX IT. `applyTimingEffects` banks the segment on WIP EXIT but
  never clears `executionStartedAt`, and its re-entry arm is `if (!task.executionStartedAt)` — so the
  original start survives the round trip. Every later live-tail reader (`getTotalAgentActiveMs`, the
  planner metrics tool, the dashboard duration displays) then computes `now - originalStart`, which
  re-adds the banked segment PLUS all the non-WIP time in between.

  NOT A RENAMED-BOARD BUG, and that is why it is pinned rather than folded into a conversion PR: the
  case below runs the DEFAULT lineage, where every id is legacy. It is an accounting bug in core that
  predates this program, and correcting it changes numbers on `productivity-analytics.ts` and every
  duration display — a behaviour change that deserves its own review, not a line in a batch that says
  it only converts vocabulary.

  THE FIX, so it is not lost: clear `executionStartedAt` in the exit arm right after banking the
  segment. The re-entry arm already re-stamps it from `columnMovedAt`, so the next segment starts at
  the re-entry moment, which is the definition the field's own doc-comment gives.

  When that lands this expectation flips from 10 to 5 minutes and this note goes with it.
  */
  it("KNOWN DEFECT: a WIP round trip leaves the old executionStartedAt, so the live tail double-counts", () => {
    const { ir, wip, review } = LINEAGES[0];
    const task = {
      id: "FN-ROUNDTRIP",
      column: review,
      columnMovedAt: "2026-07-30T00:05:00.000Z",
      executionStartedAt: "2026-07-30T00:00:00.000Z",
      steps: [],
      dependencies: [],
      workflowStepResults: [],
    } as unknown as Task;

    /* Exit: five minutes of work is banked. */
    applyTimingEffects(makeCtx(ir, wip, review, { task }));
    expect(task.cumulativeActiveMs).toBe(5 * 60_000);

    /* Re-entry ten minutes later. The start should move to the re-entry moment; it does not. */
    task.column = wip;
    task.columnMovedAt = "2026-07-30T00:15:00.000Z";
    applyTimingEffects(makeCtx(ir, review, wip, { task }));
    expect(task.executionStartedAt).toBe("2026-07-30T00:00:00.000Z");

    /*
    The consequence, stated as the number an operator sees. At 00:20 the card has done 5 minutes of
    banked work plus 5 minutes of live work — 10 total. `getTotalAgentActiveMs` reports 20: the banked
    5, plus `now - 00:00` which is itself 20 minutes of wall-clock including the 10 minutes the card
    spent in review.
    */
    expect(getTotalAgentActiveMs(task, Date.parse("2026-07-30T00:20:00.000Z")))
      .toBe(5 * 60_000 + 20 * 60_000);
  });

  it("stamps executionCompletedAt on entry to the complete lane on both lineages", () => {
    for (const { label, ir, review, complete } of LINEAGES) {
      const ctx = makeCtx(ir, review, complete);
      applyCompletionTimingEffects(ctx);
      expect(ctx.task.executionCompletedAt, `${label} lineage did not stamp completion`).toBe(
        ctx.task.columnMovedAt,
      );
    }
  });

  it("clears the recovery counters on entry to the review lane on both lineages", () => {
    for (const { label, ir, wip, review } of LINEAGES) {
      const ctx = makeCtx(ir, wip, review, {
        task: {
          id: "FN-3",
          column: review,
          columnMovedAt: "2026-07-30T00:00:00.000Z",
          recoveryRetryCount: 3,
          steps: [],
          dependencies: [],
          workflowStepResults: [],
        } as unknown as Task,
      });
      applyInReviewEnterEffects(ctx);
      expect(ctx.task.recoveryRetryCount, `${label} lineage kept its recovery counter`).toBeUndefined();
    }
  });
});

/*
FNXC:WorkflowLifecycleColumns 2026-07-30-09:05 (PR #2734 review — greptile):
SECONDARY LANES. `LifecycleColumns` names one column per role by design (#2721 pinned that), so a
workflow declaring `countsTowardWip` on two columns had a second WIP lane the hooks did not recognise.

The timing consequence is the concrete one: a move BETWEEN two WIP lanes looked like an exit from WIP
followed by a re-entry, so `cumulativeActiveMs` closed and reopened a segment the card never left.
*/
describe("timing hooks honour EVERY lane carrying the role", () => {
  const ctx = (fromColumn: string, toColumn: string, sets?: { wip?: readonly string[] }) => {
    const task = {
      id: "FN-1",
      columnMovedAt: "2026-07-30T10:00:00.000Z",
      executionStartedAt: "2026-07-30T09:00:00.000Z",
      cumulativeActiveMs: 0,
    } as never as { cumulativeActiveMs?: number };
    return {
      task,
      ctx: {
        task,
        fromColumn,
        toColumn,
        movedAt: "2026-07-30T10:00:00.000Z",
        lifecycleColumns: { wip: "building", complete: "shipped" },
        lifecycleColumnSets: sets,
        resetSteps: () => {},
      } as never,
    };
  };

  it("does NOT close the active segment when a card moves between two WIP lanes", () => {
    const { task, ctx: c } = ctx("building", "building-two", { wip: ["building", "building-two"] });

    applyTimingEffects(c);

    // Still inside WIP, so no segment was accrued on the way out.
    expect(task.cumulativeActiveMs).toBe(0);
  });

  it("DOES close it when the card genuinely leaves every WIP lane", () => {
    const { task, ctx: c } = ctx("building", "signoff", { wip: ["building", "building-two"] });

    applyTimingEffects(c);

    expect(task.cumulativeActiveMs).toBeGreaterThan(0);
  });

  it("runs the review enter-effects for a humanReview-ONLY lane", () => {
    /*
    FNXC:WorkflowLifecycleColumns 2026-07-30-15:10 (PR #2734 review — greptile, on my own code):
    The producer built this set from `mergeOrchestration` alone, so a workflow hosting review on a
    `humanReview`- or `mergeBlocker`-only lane skipped `applyInReviewEnterEffects` entirely — the
    recovery counters it clears stayed set for a card plainly in review.

    Fixed by using core's `resolveReviewColumns` (#2730) rather than a fifth inline union. That is the
    BROAD set, which is right here: these hooks ASK the question and move nothing on the answer. A
    caller that admits and then MOVES wants the narrow single lane — #2750 documents the split.
    */
    const task = {
      id: "FN-HR",
      column: "signoff",
      columnMovedAt: "2026-07-30T00:00:00.000Z",
      recoveryRetryCount: 3,
      steps: [],
      dependencies: [],
      workflowStepResults: [],
    } as unknown as Task;

    applyInReviewEnterEffects({
      task,
      fromColumn: "building",
      toColumn: "signoff",
      movedAt: "2026-07-30T00:00:00.000Z",
      lifecycleColumns: { wip: "building" },
      lifecycleColumnSets: { review: ["signoff"] },
      resetSteps: () => {},
    } as never);

    expect(task.recoveryRetryCount).toBeUndefined();
  });

  it("treats an EMPTY set as 'no lane carries this role', not as a missing answer", () => {
    /*
    FNXC:WorkflowLifecycleColumns 2026-07-30-10:40 (PR #2734 review — greptile):
    `lifecycleColumnSets` is populated only when the caller resolved an IR, so an empty array means the
    board was READ and declares no WIP lane. The first version guarded on `length > 0` and fell back to
    the singular id and then the legacy name, so a traitless column merely NAMED `in-progress` accrued
    timing as though it were the WIP lane.

    Undefined means "could not read"; empty means "read, and the answer is none". Same distinction as
    #2731's `?? {}` and #2733's refusal to invent a complete column — which I applied in both of those
    and then got wrong here.
    */
    const { task, ctx: c } = ctx("in-progress", "signoff", { wip: [] });
    /*
    The singular role must be ABSENT for this to discriminate. With `lifecycleColumns.wip` set, the
    buggy fallback lands on that name and answers false anyway — my first version of this case did
    exactly that and passed with the defect in place. Only when the singular is absent does the bug
    reach the LEGACY name and treat a traitless `in-progress` column as WIP.
    */
    (c as unknown as { lifecycleColumns: Record<string, unknown> }).lifecycleColumns = { complete: "shipped" };

    applyTimingEffects(c);

    // No WIP lane exists, so leaving `in-progress` is not leaving WIP and nothing accrues.
    expect(task.cumulativeActiveMs).toBe(0);
  });

  it("falls back to the singular role when no set is supplied", () => {
    /* Additive: a caller that does not pass sets keeps exactly the previous behaviour. */
    const { task, ctx: c } = ctx("building", "signoff");

    applyTimingEffects(c);

    expect(task.cumulativeActiveMs).toBeGreaterThan(0);
  });
});
