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
  readonly hold: string;
  readonly wip: string;
  readonly review: string;
  readonly complete: string;
}

/** The legacy ids. A guard keyed on a string literal passes here for the wrong reason. */
export const DEFAULT_VOCAB: Vocabulary = {
  hold: "todo",
  wip: "in-progress",
  review: "in-review",
  complete: "done",
};

/** No id overlaps the legacy enum. A guard keyed on a string literal goes silent here. */
export const RENAMED_VOCAB: Vocabulary = {
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
}

export function lifecycleIr(v: Vocabulary, id: string, options: LifecycleIrOptions = {}): WorkflowIr {
  return {
    version: "v2",
    id,
    name: `lifecycle-${id}`,
    columns: [
      {
        id: v.hold,
        name: "Hold",
        traits: [{ trait: "hold", config: { release: "capacity" } }],
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
      { id: "exec", kind: "prompt", column: v.wip, config: { seam: "execute" } },
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
    ],
  } as WorkflowIr;
}


