/*
FNXC:PlanningClaimSingleWriter 2026-07-28-15:00 (U7 / R4, R12 — workflow-owned lifecycle):

THE RATCHET: the task planning CLAIM — `status: "planning"` — has exactly ONE
writer module, and every write of it goes through the guarded helper.

WHY THIS SPECIFIC INVARIANT. The plan names FN-8504 as U7's acceptance case: a
store-open sweep cleared a live planner's status because two owners wrote planning
lifecycle state. The unit's stated verification is "a grep-level assertion that
planning status literals have one writer module". This is that assertion.

`status: "planning"` is the CLAIM on a card — it means "a planner owns this task
right now". It is also load-bearing well beyond triage: `isUnplannedForExecution`
treats it as dispatch-blocking, rediscovery skips cards carrying it, and two
self-healing sweeps plus two triage sweeps exist solely to clear it when a planner
dies. A second writer does not announce itself; it produces a card that looks
claimed to every reader while nothing is actually planning it.

WHAT THIS DOES NOT ASSERT, so the guard is not mistaken for more than it is:

  - It says nothing about who CLEARS the status. Eleven modules write
    `status: null` for unrelated reasons (merge, execution, mission autopilot), so
    "one clearer" would be false, and asserting it would mean weakening it into
    something that passes — the worst kind of guard.
  - `needs-replan` is deliberately NOT covered. Post-U3 it is the graph's own
    durable replan signal (AGENTS.md), written by the plan-review → plan-replan
    seam AND the stale-spec guards that feed the same loop. Multiple writers there
    are the design, not a defect.
  - Mission `status: "planning"` is a different entity on a different table. The
    scan is scoped so a mission-store write can never satisfy or trip this.

The two self-healing sweeps that READ `status === "planning"` for orphan recovery
are the compensating machinery FN-8504 produced. They are readers plus a
CAS-guarded clear, not claimants, so they do not violate this — and if U7's later
work makes them unreachable, that is a deletion, not a change to this contract.

Cheap by construction (FN-5048): grep-level over production source, no engine boot.
*/
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "../../../..");

/** Production source roots. Test files legitimately name the literal. */
const SOURCE_ROOTS = [
  "packages/core/src",
  "packages/engine/src",
  "packages/dashboard/src",
  "packages/cli/src",
];

/**
 * The single module permitted to claim a task for planning.
 *
 * Adding an entry here is the reviewable act this ratchet exists to force: it
 * means a second owner now writes the claim, which is the FN-8504 shape. If that
 * is genuinely intended, the justification belongs beside the new entry.
 */
const PLANNING_CLAIM_WRITERS = ["packages/engine/src/triage.ts"];

/**
 * Mission planning is a different entity with its own `status` column. Excluded by
 * path rather than by pattern, because a pattern loose enough to tell them apart is
 * a pattern loose enough to miss a real task write.
 */
const NON_TASK_STATUS_MODULES = [
  "packages/core/src/mission-store.ts",
  "packages/core/src/async-mission-store.ts",
];

function sourceFiles(root: string, base: string = REPO_ROOT): string[] {
  const abs = join(base, root);
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry === "__tests__" || entry === "node_modules" || entry === "dist") continue;
        walk(full);
        continue;
      }
      if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) out.push(full);
    }
  };
  walk(abs);
  return out;
}

/** Strip comments so an explanatory FNXC note naming the literal is not a hit. */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

const executableSource = (file: string): string => stripComments(readFileSync(file, "utf-8"));

/** A WRITE, not a comparison: `status: "planning"` inside an object literal. */
const CLAIM_WRITE = /status:\s*"planning"/;

/**
 * Every module under `roots` whose EXECUTABLE source writes the planning claim.
 *
 * Parameterised on `base` so the injection test below can run this exact function
 * over a fixture tree. Re-implementing the scan in the test would prove only that
 * the copy works — which is the failure mode this whole program keeps finding.
 */
function planningClaimWriters(roots: readonly string[] = SOURCE_ROOTS, base: string = REPO_ROOT): string[] {
  const writers: string[] = [];
  for (const root of roots) {
    for (const file of sourceFiles(root, base)) {
      const rel = file.slice(base.length + 1);
      if (NON_TASK_STATUS_MODULES.includes(rel)) continue;
      if (CLAIM_WRITE.test(executableSource(file))) writers.push(rel);
    }
  }
  return writers.sort();
}

describe("the planning claim has a single writer (U7 / FN-8504)", () => {
  it("is written by exactly the allowlisted module", () => {
    expect(planningClaimWriters()).toEqual([...PLANNING_CLAIM_WRITERS].sort());
  });

  it("writes the claim only through the planning-stage-guarded helper", () => {
    /*
    The claim must never be a bare `store.updateTask`. FN-7977 and FN-8361 are both
    that bug: a write that does not re-check the planning stage under the task lock
    stamps `planning` onto a card the scheduler has already advanced, and the card
    then looks claimed to every reader while nothing is planning it.
    */
    const source = executableSource(join(REPO_ROOT, "packages/engine/src/triage.ts"));
    const claims = [...source.matchAll(/status:\s*"planning"/g)];
    expect(claims).toHaveLength(1);

    // The single claim sits inside an `updatePlanningStateIfStillCurrent(...)` call.
    const claimLine = source
      .split("\n")
      .find((line) => /status:\s*"planning"/.test(line));
    expect(claimLine).toMatch(/updatePlanningStateIfStillCurrent/);
  });

  /*
  A ratchet that cannot be shown to fail on the defect it names is not a ratchet.
  These run the REAL `planningClaimWriters` over a fixture tree — not a
  re-implementation of it — so a scan that silently stopped looking would be caught.
  */
  describe("the detector itself", () => {
    let fixtureRoot = "";

    const fixture = (relative: string, contents: string): void => {
      const full = join(fixtureRoot, relative);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, contents);
    };

    afterEach(() => {
      if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
      fixtureRoot = "";
    });

    const newFixtureRoot = (): string => {
      fixtureRoot = mkdtempSync(join(tmpdir(), "fusion-claim-ratchet-"));
      return fixtureRoot;
    };

    it("FINDS an injected second writer", () => {
      const base = newFixtureRoot();
      fixture("pkg/src/innocent.ts", "export const x = 1;\n");
      fixture("pkg/src/sneaky.ts", 'await store.updateTask(id, { status: "planning" });\n');

      expect(planningClaimWriters(["pkg/src"], base)).toEqual(["pkg/src/sneaky.ts"]);
    });

    it("is not fooled by a comment that merely names the literal", () => {
      // Prose describing the claim must survive — every deletion on this program
      // leaves an explanatory tombstone — without being read as a writer.
      const base = newFixtureRoot();
      fixture("pkg/src/documented.ts", '/* FNXC: triage writes status: "planning" here */\nconst x = 1;\n');
      fixture("pkg/src/line-comment.ts", '// status: "planning" is claimed by triage\nconst y = 2;\n');

      expect(planningClaimWriters(["pkg/src"], base)).toEqual([]);
    });

    it("ignores test files, which legitimately name the claim", () => {
      const base = newFixtureRoot();
      fixture("pkg/src/__tests__/a.test.ts", 'expect(t).toEqual({ status: "planning" });\n');

      expect(planningClaimWriters(["pkg/src"], base)).toEqual([]);
    });
  });
});
