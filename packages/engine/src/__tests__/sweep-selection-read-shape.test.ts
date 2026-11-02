/*
FNXC:SweepSelectionBatching 2026-11-01-23:58 (RUFU-312 step 3):
Structural ratchet against a per-card workflow-selection read in the engine's board-wide sweeps.

Why a shape guard and not a behaviour test: one card costs one selection read whether or not the sweep batches,
so every per-card test stays green while a board of 500 cards turns a maintenance pass into 500 identical
`select "workflow_id", "step_ids" from "project"."task_workflow_selection" where "task_id" = $1` queries. That
fan-out was measured on the production board (82-131 concurrent identical selection SELECTs with 0 tasks
executing, from engines running sweeps while nothing executed) and removing it is this task's third step. A
refactor that drops a cache argument changes no observable per-card behaviour — only the query count — so the
query-producing CALL SHAPE is what has to be asserted.

This is a code-construct guard in the family of `legacy-tombstones.test.ts` and
`self-healing-selection-read-shape.test.ts`: comments are stripped before matching, so it can only ever match
executable code and never asserts that a comment exists.

The audited scope is the two files that walk the whole board repeatedly: `self-healing.ts` (maintenance batch 1
and 2, startup recovery) and `scheduler.ts` (every scheduling pass). Step 3 converted every card-loop in them to
the file's own sweep-scoped batch prefetch (`newSelectionCache` / `prefetchWorkflowSelections`) plus a shared IR
cache, so a pass costs ONE selection query per page plus ONE definition read per distinct workflow. That is why
the negative assertions below are file-wide rather than per-loop: after the audit there is no legitimate
2-argument resolver call left in either file, and a new one is by definition a per-card read.
*/
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** Removes block and line comments so the scan can only ever match executable code. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** Collapses whitespace runs so a call is matched as a call, not as a formatting accident. */
function normalize(source: string): string {
  return stripComments(source).replace(/\s+/g, " ");
}

const selfHealing = normalize(
  readFileSync(new URL("../self-healing.ts", import.meta.url).pathname, "utf8"),
);
const scheduler = normalize(
  readFileSync(new URL("../scheduler.ts", import.meta.url).pathname, "utf8"),
);

/**
 * A resolver call whose second argument is a card OBJECT's id and whose last argument is that id — the
 * 2-argument shape that reads per card. The `X.id` restriction is deliberate, not a regex shortcut: a sweep
 * obtains its cards by iterating a list (`for (const task of …)` → `task.id`), while a per-EVENT handler receives
 * a single `taskId` parameter and legitimately resolves once for the one card that event named (e.g. the
 * mission-advance handler for a task that just moved to its complete column). Widening this pattern to bare
 * `taskId` would fail on correct code.
 */
const CACHE_LESS = /resolveWorkflowIrForTask(WithProvenance)?\(\s*(?:this\.)?[A-Za-z_.]*store,\s*[A-Za-z_.]+\.id\s*\)/g;

/*
FNXC:SweepSelectionBatching 2026-11-01-22:20 (RUFU-312 step 3, second audit):
Passing an IR cache is NOT what removes the fan-out. The resolver reads the task's workflow SELECTION first,
before any IR cache can help (`workflow-ir-resolver.ts`), so a call that hands over only `xIrCache` still
issues one `task_workflow_selection` SELECT per card. The first pass of this step converted the loops written
as `xById` lane classifiers and asserted only the 2-argument shape above; re-running the guard found a
second family — `resolveWorkflowIrForTaskWithProvenance(this.store, task.id, noOpIrCache)` in the
no-op-finalize, merge-evidence, mergeable, failed-step, interrupted, deadlock, already-merged, orphan, limbo
and missing-worktree sweeps, plus four generic `irCache` loops and the acquisition-conflict helper. Sixteen
calls, each one read per candidate card, invisible to the 2-argument pattern.

So the invariant in `self-healing.ts` is now the stronger one: EVERY resolver call carries a selection cache.
A board sweep prefills that cache once for its candidate set (`newSelectionCache` / a per-page
`prefetchWorkflowSelections`); a per-EVENT path passes a lazily-filled `Map` so the ids it consults are read
once per pass. Single-card entry points outside this file (`evaluateTaskReleaseGate`, `promoteHeldTask`, the
scheduler's mission-advance handler) stay cache-less by contract — one card, one read is the right shape, and
that is why this pattern is scoped to `self-healing.ts`.

The COUNT side of the same contract — ≤1 batched read and 0 singles for a 50-card pass — is asserted in
`mission-state-reconcile.test.ts`; a pattern can only prove the call shape, never the query count.
*/
const IR_CACHE_ONLY =
  /resolveWorkflowIrForTask(WithProvenance)?\(\s*(?:this\.)?[A-Za-z_.]*store,\s*[A-Za-z_.]+(?:\.id)?\s*,\s*[A-Za-z_.]+\s*\)/g;

describe("board sweeps resolve workflow selections in one batch, not once per card", () => {
  it("self-healing contains no cache-less resolver call", () => {
    expect(selfHealing.match(CACHE_LESS) ?? []).toEqual([]);
  });

  it("the scheduler contains no cache-less resolver call", () => {
    expect(scheduler.match(CACHE_LESS) ?? []).toEqual([]);
  });

  it("the completed-in-WIP sweep passes both caches to the provenance resolver", () => {
    expect(selfHealing).toContain(
      "resolveWorkflowIrForTaskWithProvenance( this.store, task.id, stuckIrCache, stuckSelectionCache, )",
    );
    // The selection cache must be built ONCE for the pass, from the whole card set — never inside the loop.
    expect(selfHealing).toContain("this.newSelectionCache(tasks.map((task) => task.id))");
  });

  it("the scheduler mission-symbol renewal passes both caches to the resolver", () => {
    expect(scheduler).toContain(
      "resolveWorkflowIrForTask(this.store, task.id, irCache, selectionCache)",
    );
    expect(scheduler).toContain(
      "prefetchWorkflowSelections(this.store, tasks.map((task) => task.id), selectionCache)",
    );
  });

  it("self-healing passes a selection cache at EVERY resolver call, not just the ones the first audit found", () => {
    // An IR cache without a selection cache is the fan-out wearing a costume: the selection SELECT happens first.
    expect(selfHealing.match(IR_CACHE_ONLY) ?? []).toEqual([]);
  });

  it("every sweep that classifies lanes per card pre-fetches selections for its candidate set", () => {
    /*
    Six sweeps in self-healing classify a whole candidate set (phantom-binding reclaim, dependency-blocked
    classification, merged review/hold lanes, review-wedge lanes, contamination lanes, undeclared-column
    rehoming). Each must own a `newSelectionCache(...)` built from that set; adding a seventh lane classifier
    without one re-creates the fan-out this pins out.
    */
    for (const cache of [
      "reclaimSelectionCache",
      "blockedSelectionCache",
      "mergedSelectionCache",
      "wedgeSelectionCache",
      "contaminationSelectionCache",
      "rehomingSelectionCache",
      // Second audit (2026-11-01): the IR-cache-only family, one prefetch per candidate set.
      "noOpSelectionCache",
      "perTaskSelectionCache",
      "mergeableSelectionCache",
      "failedStepSelectionCache",
      "interruptedSelectionCache",
      "deadlockSelectionCache",
      "reviewSelectionCache",
      "orphanSelectionCache",
      "limboSelectionCache",
      "recoverySelectionCache",
      "strandedTodoSelectionCache",
      "laneSelectionCache",
      "revisionSelectionCache",
      "agentBindingSelectionCache",
    ]) {
      expect(selfHealing).toContain(`const ${cache} = await this.newSelectionCache(`);
    }
    // Two paginated sweeps own a pass-scoped cache that each page pre-fills instead of building one per page.
    for (const cache of ["holdEvidenceSelectionCache", "acquisitionSelectionCache"]) {
      expect(selfHealing).toContain(`const ${cache}: WorkflowSelectionCache = new Map();`);
      expect(selfHealing).toContain(`prefetchWorkflowSelections(this.store, tasks.map((entry) => entry.id), ${cache})`);
    }
  });
});
