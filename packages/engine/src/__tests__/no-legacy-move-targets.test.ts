// @vitest-environment node

/*
FNXC:WorkflowResolvedColumns 2026-07-31-23:59:
A MOVE TARGET IS AN ARGUMENT, SO NO EXISTING GATE COUNTS IT.

The lifecycle-column census counts COMPARISONS against legacy ids. `moveTask(task.id, "todo")` contains
no comparison, so the census reported zero while 25 such targets sat in `self-healing.ts` alone and 31
across the tree.

The failure mode is worse than a stale guard's. `moveTaskInternal` REJECTS a target the workflow does
not declare — `TransitionRejectionError: unknown-column` — which `task-store/moves.ts` documents after
a completion handoff was found THROWING on every renamed board. A guard that fails to match degrades to
"no rescue"; a target that throws is "no rescue, plus an exception in the sweep", and every one of these
sites is a recovery path.

So this ratchet exists because the population was invisible, not because it was large. Fixing it once
without a guard means it is invisible again the moment someone adds the next one.

WHAT IS AND IS NOT A TARGET. Only the SECOND argument of a `moveTask(...)` call counts. A legacy id as
a FALLBACK (`resolveReboundTargetForTask` returning `"todo"`, or `lifecycle?.complete ?? "done"`) is
the degraded answer every resolver in this program is required to have, and is not flagged — the
resolver is what makes the call correct, and its fallback is what keeps default boards working.

BASELINE, NOT ZERO. Files outside the converted set keep their current counts so this can land without
blocking other lanes; the ratchet fails on any INCREASE, and on a decrease that was not re-recorded —
a stale allowance is a hole the same guards can regrow through.
*/

import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../../../..");

/** Legacy lifecycle column ids, as move TARGETS. */
const LEGACY = "(?:todo|triage|in-progress|in-review|done|archived)";
const MOVE_TARGET = new RegExp(`moveTask\\s*\\(\\s*[^,()]+,\\s*["']${LEGACY}["']`, "g");

/*
Files that still hold literal targets, with the count each is allowed. `self-healing.ts` is absent
because it is now zero — the whole point of the change this guards.
*/
const ALLOWED: Record<string, number> = {
  "packages/cli/src/extension.ts": 1,
  "packages/core/src/task-store/branch-and-pr-entities.ts": 1,
  /* One CALL. An earlier raw scan counted 2 here by matching the interface DECLARATION
     (`moveTask(taskId: string, column: "todo", …)`) as a call site — the stale-allowance case below
     caught that, which is what it is for. */
  "packages/dashboard/src/server.ts": 1,
  "packages/engine/src/agent-tools.ts": 1,
};

function sourceFiles(): string[] {
  return execFileSync(
    "git",
    ["ls-files", "packages/*/src/**/*.ts", "packages/*/src/*.ts", "packages/*/app/**/*.ts", "packages/*/app/**/*.tsx"],
    { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  )
    .split("\n")
    .filter((f) => f && !f.includes("__tests__") && !/\.(test|spec)\.tsx?$/.test(f));
}

/** Blank comments in place so prose describing a past call is not counted as one. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, "");
}

function countByFile(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const file of sourceFiles()) {
    let source: string;
    try {
      source = readFileSync(resolve(REPO_ROOT, file), "utf8");
    } catch {
      continue;
    }
    const hits = stripComments(source).match(MOVE_TARGET);
    if (hits && hits.length > 0) counts[file] = hits.length;
  }
  return counts;
}

describe("moveTask targets resolve the board's own lane", () => {
  /*
  ANTI-VACUITY. A scan that silently matched nothing would pass forever, including after `moveTask`
  is renamed or this glob stops resolving. Prove the corpus is real and the matcher still finds the
  sites the allow-list documents.
  */
  it("scans a real corpus and still finds the allow-listed sites", () => {
    expect(sourceFiles().length).toBeGreaterThan(200);
    expect(Object.keys(countByFile()).length).toBeGreaterThan(0);
  });

  /* The matcher is covered, because the scan is only as good as it: each case is a real shape. */
  it.each<[source: string, shouldFlag: boolean, why: string]>([
    ['await store.moveTask(task.id, "todo");', true, "the plain form"],
    ['await this.store.moveTask(taskId, "archived", { moveSource: "engine" });', true, "with options"],
    ["await store.moveTask(id, 'done');", true, "single quotes"],
    ['await store.moveTask(task.id, await resolveReboundTargetForTask(store, task.id));', false, "resolved"],
    ['await store.moveTask(task.id, completeLane);', false, "resolved via a local"],
    ['const target = lifecycle?.complete ?? "done";', false, "a FALLBACK is not a target"],
    ['return resolveReboundTarget(ir) ?? "todo";', false, "a resolver's own degraded answer"],
    ['if (task.column === "todo") return;', false, "a comparison — the census owns that class"],
  ])("matcher: %s -> %s (%s)", (source, shouldFlag) => {
    expect(new RegExp(MOVE_TARGET.source).test(source)).toBe(shouldFlag);
  });

  it("self-healing.ts has NO literal move targets", () => {
    /* The file this ratchet was written for: 25 sites, now zero. Asserted by name because a
       regression here is a recovery path that throws on a renamed board. */
    expect(countByFile()["packages/engine/src/self-healing.ts"] ?? 0).toBe(0);
  });

  it("no file exceeds its recorded allowance", () => {
    const counts = countByFile();
    const violations: string[] = [];
    for (const [file, count] of Object.entries(counts)) {
      const allowed = ALLOWED[file] ?? 0;
      if (count > allowed) violations.push(`${file}: ${count} literal move target(s), allowed ${allowed}`);
    }
    expect(
      violations,
      "A moveTask target the workflow does not declare is REJECTED (TransitionRejectionError: "
      + "unknown-column), so this throws on a renamed board rather than degrading.\n"
      + "Resolve the target (resolveReboundTargetForTask / resolveArchiveTargetForTask /\n"
      + "resolveTaskLifecycleColumns) — a legacy id is fine as the resolver's FALLBACK, not as the "
      + "argument:\n" + violations.join("\n"),
    ).toEqual([]);
  });

  it("no allowance is stale", () => {
    /* A recorded allowance that exceeds the tree is a hole the same targets can regrow through —
       the same reason the census baseline fails on an unrecorded DROP. */
    const counts = countByFile();
    const stale = Object.entries(ALLOWED)
      .filter(([file, allowed]) => (counts[file] ?? 0) < allowed)
      .map(([file, allowed]) => `${file}: allows ${allowed}, tree has ${counts[file] ?? 0}`);
    expect(stale, `Lower the allowance to match the tree:\n${stale.join("\n")}`).toEqual([]);
  });
});
