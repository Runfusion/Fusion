/*
FNXC:WorkflowLifecycleColumns 2026-07-28-11:10 (shared E2E vocabulary fixture):

ONE definition of the renamed-vs-default vocabularies and ONE workflow builder,
shared by every live-engine E2E in this directory.

Extracted (a pure move — the lifecycle suite it came from is unchanged) the moment
a SECOND suite needed it. Two copies of a differential fixture is the failure this
whole program keeps hitting: the copies drift, and then a renamed-workflow test
passes for a reason that has nothing to do with the code under test. The
differential only means anything while both vocabularies come from one builder and
differ ONLY in their four column ids.
*/
import type { WorkflowIr } from "@fusion/core";

/** Staleness threshold declared by the hold column's U4 recovery policy. */
export const HOLD_STALENESS_MS = 60 * 60_000;

/** The four lifecycle roles this program's guards are supposed to resolve by TRAIT, not by id. */
export interface Vocabulary {
  /*
  FNXC:WorkflowLifecycleColumns 2026-07-29-15:45 (fixture correction):
  Before this field `lifecycleIr` emitted NO intake trait for a non-merged board, so the
  SEPARATE-LANES shape this fixture is supposed to provide did not exist. Every renamed-versus-
  merged differential built on it compared "no intake" against "intake and hold on one column",
  not "two distinct lanes" against "one".

  That let assertions pass for the wrong reason: `expect(lifecycle?.intake).not.toBe(hold)` is
  vacuously true when `intake` is `undefined`, so it would pass against a resolver that never
  resolved intake at all. `undefined` is no longer reachable from this fixture.

  `mergedIntakeAndHold` remains the way a caller forces the merged shape; a vocabulary whose
  `intake` equals its `hold` now implies it too, so the merged vocabularies cannot silently lose
  their intake trait to a forgotten option.
  */
  readonly intake: string;
  readonly hold: string;
  readonly wip: string;
  readonly review: string;
  readonly complete: string;
}

/** The legacy ids. A guard keyed on a string literal passes here for the wrong reason. */
export const DEFAULT_VOCAB: Vocabulary = {
  intake: "triage",
  hold: "todo",
  wip: "in-progress",
  review: "in-review",
  complete: "done",
};

/** No id overlaps the legacy enum. A guard keyed on a string literal goes silent here. */
export const RENAMED_VOCAB: Vocabulary = {
  intake: "inbox",
  hold: "backlog",
  wip: "building",
  review: "checking",
  complete: "shipped",
};

/**
 * ONE workflow shape, two vocabularies. Structurally identical down to node ids and edges so a
 * behavioral delta between the two runs can only come from the column ids.
 *
 * The shape is the lifecycle spine: a hold column that the scheduler releases on capacity, a WIP
 * column that holds the slot, a review column, and a terminal complete column.
 */
export interface LifecycleIrOptions {
  /* Adds the `merge` trait (flag `mergeOrchestration`) to the review column, which
     is what `resolveMergeOrchestrationColumn` keys on. OPT-IN so the lifecycle
     suite's IR stays byte-identical to what it was written against — a shared
     fixture must not silently change an existing suite's subject. */
  readonly mergeOrchestration?: boolean;
  /* FNXC:MergedPlanningColumn 2026-07-29-23:50 (U9 E2E evidence — the merged board):
     Adds the `intake` trait to the HOLD column, so ONE column carries intake + hold —
     which is exactly the shape U11 shipped on the default lineage (Planning, id `todo`,
     no `triage` column at all). Until now every E2E here drove a board with intake and
     hold as SEPARATE columns, so nothing proved the merged shape end-to-end; a guard
     that silently keys on "the column that is only a hold" passes on the default and
     renamed vocabularies and goes wrong only here.

     OPT-IN for the same reason as `mergeOrchestration`: a shared fixture must not
     silently change an existing suite's subject. */
  readonly mergedIntakeAndHold?: boolean;
  /* FNXC:ReviewRework 2026-07-30-01:10 (U9 E2E evidence — the review half):
     Adds the `review --failure--> exec` rework edge, so a REVISE verdict routes the
     card BACK to the wip column. Without it the review node has only a success edge
     and every E2E here drives review as a pass-through, which means the plan's
     `InReview --> InProgress: review requests changes` transition had no live-engine
     evidence on ANY board.

     Opt-in like the other options: this changes the graph's reachable shape, and a
     shared fixture must not alter an existing suite's subject. */
  readonly reviewRework?: boolean;
}

/**
 * The MERGED board: intake and hold are one column, as on the operator's real default
 * workflow after U11. Ids deliberately overlap the legacy enum (`todo` is genuinely the
 * merged Planning id there) so this is not a rename test — it isolates the merge of two
 * ROLES onto one column from any change of vocabulary.
 */
export const MERGED_VOCAB: Vocabulary = {
  /*
  FNXC:WorkflowLifecycleColumns 2026-07-31-00:10 (fix-forward, surfaced by a typecheck that reaches here):
  `intake` was MISSING, which is a type error `Vocabulary` already forbade — invisible because the engine
  tsconfig has `exclude: ["src/__tests__/**"]`, so nothing in this directory is typechecked. It surfaced
  only when a test OUTSIDE that directory (`src/notification/__tests__/`) imported this fixture.

  Not cosmetic. `lifecycleIr` derives `merged` from `options.mergedIntakeAndHold === true || v.intake ===
  v.hold`; with `intake` undefined the second test was false, so MERGED_VOCAB alone produced a SEPARATE
  intake column whose `id` was `undefined` — a malformed IR, and precisely the "assertions pass for the
  wrong reason" failure the note at the top of this file warns about.

  `todo` is the correct value: this vocabulary documents itself as the board where intake and hold are one
  column, and `todo` is genuinely the merged Planning id after U11. Behaviour-neutral for every current
  caller — all four pass `mergedIntakeAndHold: true`, so `merged` was already true and `v.intake` was
  never read. It now also holds for a caller that forgets the option.
  */
  intake: "todo",
  hold: "todo",
  wip: "in-progress",
  review: "in-review",
  complete: "done",
};

/** A merged board that ALSO renames: both variables move at once, which is the shape a
 *  custom workflow author actually produces. */
export const MERGED_RENAMED_VOCAB: Vocabulary = {
  intake: "planning",
  hold: "planning",
  wip: "building",
  review: "checking",
  complete: "shipped",
};

export function lifecycleIr(v: Vocabulary, id: string, options: LifecycleIrOptions = {}): WorkflowIr {
  /* Merged when the caller says so OR when the vocabulary collapses the two roles onto one id. */
  const merged = options.mergedIntakeAndHold === true || v.intake === v.hold;
  return {
    version: "v2",
    id,
    name: `lifecycle-${id}`,
    columns: [
      /* The SEPARATE intake lane, for a non-merged vocabulary only. On a merged one
         `v.intake === v.hold`, so declaring it here would duplicate the id — the hold column
         carries both traits instead. */
      ...(merged ? [] : [{ id: v.intake, name: "Intake", traits: [{ trait: "intake" as const }] }]),
      {
        id: v.hold,
        name: "Hold",
        traits: [
          ...(merged ? [{ trait: "intake" }] : []),
          { trait: "hold", config: { release: "capacity" } },
        ],
        /* U4 workflow-declared recovery policy (#2478). Declared on the HOLD column of both
           vocabularies from the one builder, so the reconciler's role resolution is exercised
           against a renamed column with nothing else differing. */
        recovery: { stalenessMs: HOLD_STALENESS_MS, onStale: { action: "surface", code: "e2e-stale-hold" } },
      },
      {
        id: v.wip,
        name: "Wip",
        traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent", countPending: true } }, { trait: "timing" }],
      },
      {
        id: v.review,
        name: "Review",
        traits: [
          { trait: "human-review" },
          { trait: "merge-blocker" },
          ...(options.mergeOrchestration ? [{ trait: "merge" }] : []),
        ],
      },
      { id: v.complete, name: "Complete", traits: [{ trait: "complete" }] },
    ],
    nodes: [
      { id: "start", kind: "start", column: v.hold },
      { id: "plan", kind: "prompt", column: v.hold, config: { seam: "planning" } },
      {
        id: "exec",
        kind: "prompt",
        column: v.wip,
        /* `reworkRegion` is required by the IR validator for any rework-edge TARGET
           ("only legal ... into a top-level rework region head") — the same shape the
           builtin coding IR uses on `merge-attempt`. Declared only when the rework edge
           exists, so the non-rework IR stays byte-identical. */
        config: options.reviewRework
          ? { seam: "execute", reworkRegion: true, maxReworkCycles: 3 }
          : { seam: "execute" },
      },
      { id: "review", kind: "prompt", column: v.review, config: { seam: "review" } },
      /* A real merge-class node. The IR validator REFUSES a `merge-blocker` column with no
         reachable merge-class node ("the gate can never clear without one") — discovered by this
         file, and worth keeping: it means the review column here is a genuinely gated one rather
         than a decorative label. `merge-gate` itself is pure policy (reads autoMerge, emits
         auto-on/auto-off) so it needs no git. */
      { id: "merge-gate", kind: "merge-gate", column: v.review, config: { gate: "auto-merge" } },
      { id: "end", kind: "end", column: v.complete },
    ],
    edges: [
      { from: "start", to: "plan" },
      { from: "plan", to: "exec", condition: "success" },
      { from: "exec", to: "review", condition: "success" },
      { from: "review", to: "merge-gate", condition: "success" },
      { from: "merge-gate", to: "end", condition: "success" },
      ...(options.reviewRework
        ? [{ from: "review", to: "exec", condition: "failure", kind: "rework" }]
        : []),
    ],
  } as WorkflowIr;
}


