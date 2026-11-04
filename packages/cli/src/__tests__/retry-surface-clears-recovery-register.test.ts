/*
FNXC:BranchConflictRecovery 2026-11-04-14:45 (RUFU-395) — the Retry-surface structural guard.

RUFU-395 gives the branch-conflict recovery a register of its own
(`sourceMetadata.branchConflictRecoveryEpisode.refusalCount`) and makes it the SOLE authority for the
terminal park. That makes the operator's Retry the only exit, and it makes the exit two-part: the pause
state (`paused: false`, which is what the engine's suppression predicate reads) and the register (which
is what decides `terminal` again). A Retry surface that clears only one half is worse than no fix at
all — clearing the pause alone releases the card visually and re-parks it on the next refusal, because
the surviving count still says the budget is spent.

All three surfaces reach the lift through `buildManualRetryResetPatch` / `buildManualRetryResetPatchIfCurrent`,
and core's own suite (`packages/core/src/__tests__/manual-retry-reset.test.ts`) pins that the builder
empties both halves. What that cannot catch is a surface that stops using the builder: a hand-rolled
`{ recoveryRetryCount: 0, paused: false }` at a call site typechecks, passes every other test, and
leaves a park that only looks liftable. This scan is the structural guard for exactly that — a
behavioral test cannot cover three transports and a dashboard route without three harnesses, and the
invariant is genuinely structural: one shared patch builder, no local reimplementations.
*/
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// packages/cli/src/__tests__ → the repo root is four levels up, and every path below is
// repo-relative so the guard keeps naming the file it scanned.
const REPO_ROOT = resolve(__dirname, "../../../..");

/** Every surface that can hand a parked card back to the dispatcher. */
const RETRY_SURFACES: Array<{ label: string; file: string }> = [
  { label: "fn task retry (CLI)", file: "packages/cli/src/commands/task.ts" },
  { label: "agent task retry tool (pi extension)", file: "packages/cli/src/extension.ts" },
  { label: "dashboard Retry route", file: "packages/dashboard/src/routes/register-task-workflow-routes.ts" },
];

describe("RUFU-395 — every Retry surface lifts through the one shared patch builder", () => {
  for (const surface of RETRY_SURFACES) {
    it(`${surface.label} routes its retry through the shared builder`, () => {
      const source = readFileSync(resolve(REPO_ROOT, surface.file), "utf8");
      expect(source).toMatch(/buildManualRetryResetPatch(IfCurrent)?\(/);
      /*
      The negative half is the point. A surface that wrote its own reset object would satisfy every
      behavioral test that does not specifically read the register, and the failure it produces is a
      card that re-parks after the operator has already retried it.
      */
      expect(source).not.toMatch(/paused:\s*false,[\s\S]{0,120}recoveryRetryCount:\s*0/);
    });
  }

  it("no engine lane zeroes the register by hand", () => {
    /*
    The register is written by exactly two places: the family's counter patch (advance) and core's
    Retry patch (clear). A third writer inventing a value is the borrowed-authority defect wearing a
    new name, and the RUFU-356 sweep that clears stale acquisition parks is the likeliest place someone
    would reach for it.
    */
    const sweep = readFileSync(resolve(REPO_ROOT, "packages/engine/src/self-healing.ts"), "utf8");
    expect(sweep).not.toMatch(/branchConflictRecoveryEpisode\s*:/);
    const retryPatch = readFileSync(resolve(REPO_ROOT, "packages/core/src/tasks/manual-retry-reset.ts"), "utf8");
    expect(retryPatch).toMatch(/BRANCH_CONFLICT_RECOVERY_EPISODE_METADATA_KEY\]:\s*null/);
  });
});
