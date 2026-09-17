// @vitest-environment node
/*
FN-457 — anti-drift census for durable paused-time accounting.

Pause is subtracted from the card's clock chip, and that subtraction is only sound while EVERY seam
that writes a task's pause state routes through `tasks/task-pause-accounting.ts`. A ninth seam added
later would silently open or strand a segment and quietly corrupt every card's displayed total —
exactly the failure mode that is invisible in review because the new seam looks unrelated to timing.

This is a CODE-CONSTRUCT guard (allowed by AGENTS.md), not a prose assertion: it scans production
source for pause-state writes and requires the set of owning files to equal the documented
allow-list. It never searches for a comment, an FNXC stamp, or a date.
*/
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const CORE_SRC = resolve(__dirname, "..");
const REPO_ROOT = resolve(CORE_SRC, "../../..");

/*
Seams that MUTATE a task's pause state in place. Each is wired to the shared accounting helper (or
carries a tested exemption, noted below).
*/
const DIRECT_PAUSE_MUTATORS = [
  "packages/core/src/task-store/branch-group-ops.ts",
  "packages/core/src/task-store/task-update.ts",
  "packages/core/src/task-store/task-artifacts-ops.ts",
  "packages/core/src/task-store/reset-lifecycle.ts",
  "packages/core/src/workflows/default-workflow-hooks.ts",
  /* Exempt by construction, locked by a negative control in pause-active-time-accounting.test.ts:
     the in-review stall observer only ever patches a REVIEW-lane card and never un-pauses, so it
     has no segment to open and none to bank. */
  "packages/core/src/task-store/task-mutation-ops.ts",
] as const;

/*
Seams that PRODUCE a pause patch applied through `updateTask`, which owns the single accounting seam
and is the only place that can resolve the card's wip lane.
*/
const PAUSE_PATCH_PRODUCERS = [
  "packages/core/src/tasks/task-external-block.ts",
  "packages/core/src/tasks/manual-retry-reset.ts",
  "packages/core/src/merge/task-merge.ts",
  "packages/core/src/db/legacy-adoption.ts",
] as const;

const ALLOWED = new Set<string>([...DIRECT_PAUSE_MUTATORS, ...PAUSE_PATCH_PRODUCERS]);

/** `task.paused = X`, `paused: true/false`, `patch.paused = X`, `values.paused = X`. */
const PAUSE_WRITE = /(?:^|[^A-Za-z])(?:paused\s*:\s*(?:true|false)|[A-Za-z_$][\w$]*\.paused\s*=(?!=))/;

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (entry === "__tests__" || entry === "__test-utils__" || entry === "dist" || entry === "node_modules") continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (path.endsWith(".ts") && !path.endsWith(".d.ts")) yield path;
  }
}

/** Strip comments so documentation prose can never satisfy or trip this scan. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function collectPauseWriters(): string[] {
  const found: string[] = [];
  for (const path of walk(CORE_SRC)) {
    const body = stripComments(readFileSync(path, "utf8"));
    const hit = body.split("\n").some((line) => {
      if (line.includes("userPaused")) return false;
      return PAUSE_WRITE.test(line);
    });
    if (hit) found.push(relative(REPO_ROOT, path));
  }
  return found.sort();
}

describe("pause-accounting writer census", () => {
  it("finds pause-state writers only in the documented allow-list", () => {
    const unexpected = collectPauseWriters().filter((path) => !ALLOWED.has(path));
    expect(
      unexpected,
      "A new seam writes task pause state without routing through tasks/task-pause-accounting.ts. "
        + "Wire it to applyPauseAccounting/computePauseAccountingPatch (or record a tested exemption) "
        + "and add it to this census, or the task card's clock chip silently mis-reports worked time.",
    ).toEqual([]);
  });

  it("keeps every allow-listed file a real, still-present pause writer", () => {
    // A stale entry is as dangerous as a missing one: it makes the census look tighter than it is.
    const writers = new Set(collectPauseWriters());
    for (const path of ALLOWED) {
      expect(writers.has(path), `${path} is allow-listed but no longer writes pause state`).toBe(true);
    }
  });

  it("keeps every direct pause mutator importing the shared accounting seam or a tested exemption", () => {
    const EXEMPT = new Set<string>(["packages/core/src/task-store/task-mutation-ops.ts"]);
    for (const path of DIRECT_PAUSE_MUTATORS) {
      if (EXEMPT.has(path)) continue;
      const body = stripComments(readFileSync(join(REPO_ROOT, path), "utf8"));
      expect(
        /task-pause-accounting\.js/.test(body),
        `${path} mutates pause state without importing tasks/task-pause-accounting.js`,
      ).toBe(true);
    }
  });
});
