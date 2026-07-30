import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isUnplannedSeedPrompt } from "@fusion/core";
import { getPromptPath } from "../spec-staleness.js";

/*
FNXC:WorkflowLifecycleColumns 2026-07-30-12:05:
Shared release-leg fixture: give a seeded card a spec that FN-7648 accepts as PLANNED.

Why this exists as a helper rather than as a block copied into each E2E family: the same
fixture defect has now been diagnosed THREE times independently (#2634 in
workflow-lifecycle, #2643 in workflow-merged-board, and again in workflow-planning-lane),
and it presents as a scheduler bug rather than a fixture bug. `createTaskWithReservedId`
leaves a bootstrap seed ("# <id>\n\n<description>"), and `isUnplannedForExecution`
(hold-release.ts) refuses to move an unplanned card out of any intake- or hold-trait
column. The sweep therefore reports `held: [{ reason: "move-rejected-or-no-slot" }]` and
releases nothing — which is the GATE WORKING.

The contract is stated outright in
`docs/solutions/architecture-patterns/workflow-node-column-placement-and-graph-entry-contract.md`:
"Scheduler/release test fixtures must model a card that cleared the gate ... A held
unreviewed card is the gate working."

Dead ends recorded so a fourth worker does not re-walk them: adding
`maxConcurrent`/`maxWorktrees` to the E2E settings changes nothing (the in-transaction
capacity gate from #2488/#2499 is not the cause), a direct `moveTask(id, wip)` succeeds
(the move is not the blocker), and bisecting to #2613's task-creation.ts attributes the
change correctly but yields the wrong verdict — post-U11 a card created in `todo` genuinely
IS intake, so receiving a bootstrap seed is correct behaviour.
*/

/** The subset of TaskStore this fixture needs; keeps the helper usable from narrow PG fakes. */
type PlannedSpecStore = {
  getTasksDir(): string;
  taskCache?: { delete(id: string): void };
};

/**
 * Write a PROMPT.md that `isUnplannedSeedPrompt` classifies as a real spec, then PROVE it did.
 *
 * The verification is the point. A silent write would let a future change to the seed-detection
 * heuristic (or to the prompt shape below) reintroduce the exact failure this helper exists to
 * prevent, and the symptom would again surface as "the release sweep is broken" in whichever
 * E2E family happened to run. Instead the throw names the real cause at the seam that caused it.
 */
export function seedPlannedSpec(
  store: PlannedSpecStore,
  taskId: string,
  opts: { title?: string; description?: string; content?: string } = {},
): void {
  const promptPath = getPromptPath(store.getTasksDir(), taskId);
  /*
  `opts.content` exists so `_planned-spec-fixture.test.ts` can drive a KNOWN bootstrap seed
  through this function and prove the throw below fires. Without that seam the guard could only
  ever be observed passing, which is the "guard that reports success without checking anything"
  failure mode. Production fixtures must not pass it.
  */
  const content = opts.content
    ?? (`# ${taskId}\n\n## Context\nA planned spec, so the release sweep does not classify this card `
      + `as an unplanned seed.\n\n## Steps\n### Step 1\n- [ ] do the planned work\n`);

  mkdirSync(dirname(promptPath), { recursive: true });
  writeFileSync(promptPath, content, "utf-8");

  /*
  Self-check against the REAL predicate the release gate uses, not a restatement of it. If this
  fires, the fixture is no longer modelling a planned card and every release assertion downstream
  of it is testing the gate instead of the sweep.

  `title`/`description` are optional because the check is about SHAPE: both seed forms the
  classifier recognises are "<heading>\n\n<description>" with no section headings, so the spec
  above cannot equal either one for ANY description. Callers that have the real values may pass
  them to keep the comparison exact; omitting them cannot mask a positive.
  */
  if (isUnplannedSeedPrompt(content, taskId, opts.title, opts.description ?? "")) {
    throw new Error(
      `seedPlannedSpec(${taskId}): the spec written by this fixture is still classified as an `
      + `unplanned bootstrap seed by isUnplannedSeedPrompt, so isUnplannedForExecution will hold `
      + `the card and the release sweep will report "move-rejected-or-no-slot" while releasing `
      + `nothing. This is a FIXTURE defect, not a scheduler defect — update the prompt shape in `
      + `_planned-spec-fixture.ts to match the current seed-detection heuristic.`,
    );
  }

  // The store caches tasks; release-gate reads must see the on-disk spec.
  store.taskCache?.delete(taskId);
}
