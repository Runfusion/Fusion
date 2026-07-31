/*
FNXC:WorkflowBuiltins 2026-07-31-23:59 (close the class, not the third instance):

`BUILTIN_CODING_WORKFLOW_IR` READS LIKE THE DEFAULT AND IS THE LEGACY WORKFLOW. The catalog's default
is `builtin:coding` -> `resolveDefaultWorkflowIr()`; that constant is `builtin:legacy-coding`. Post-U11
they differ by one column, and it is the one a caller most often wants:

    default  todo, in-progress, in-review, done, archived
    legacy   triage, todo, in-progress, in-review, done, archived

THREE SEPARATE BUGS HAVE COME FROM REACHING FOR IT BY NAME:
  1. the two move-path resolvers disagreed about the no-selection default, so every flag-ON move threw
     "workflow move policy preflight is stale" (recorded in `resolveDefaultWorkflowIr`'s own header);
  2. the TUI board rendered a `triage` lane the default board does not have (#3178);
  3. `deleteWorkflow` re-homed every occupant of a deleted workflow into `triage` — a column the
     default board does not declare — and slipped past `moveTask`'s undeclared-target rejection
     because `triage` is a legacy id and the rehome runs under `recoveryRehome` (#3183).

Each was found after it shipped, by someone tracing a symptom. The name is the defect: it is the
obvious identifier to reach for, it type-checks, and on the default board's five shared columns it
behaves correctly — so the mistake only shows on the column that differs.

SO THIS IS A CALL-SITE ALLOW-LIST, the same shape the repo already uses for
`resolveTaskWorkflowIrSync`, the engine's blocking-shellout list, and the detached-spawn script guard,
and for the same reason: the primitive has a legitimate narrow use and a plausible-looking wrong one.

TO ADD A SITE: say why the LEGACY workflow specifically is correct there — not "the built-in
workflow", which is the confusion this guards. If you want the catalog default, call
`resolveDefaultWorkflowIr()`.
*/

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ALLOWED_CALL_SITES: ReadonlyMap<string, string> = new Map([
  [
    "packages/core/src/builtin-workflows.ts",
    "The catalog itself. It registers the constant AS `builtin:legacy-coding`, derives every linear "
      + "built-in's columns from it via `canonicalBuiltinWorkflowColumns()` (deliberate — merging a "
      + "column there propagates to all of them at once), and names it as the last-resort fallback "
      + "inside `resolveDefaultWorkflowIr()`. This file is where 'legacy' is the right answer.",
  ],
  [
    "packages/engine/src/workflow-graph-executor.ts",
    "`run()`'s default `ir`. Both production callers pass it explicitly, so the default is "
      + "unreachable in production — but `workflow-graph-executor-parity.test.ts`, in the engine-core "
      + "GATE suite, drives the method WITHOUT it to assert the historical seam sequence. Switching "
      + "to the catalog default rewrites what 'parity' means: measured, 6 gate tests fail with "
      + "\"expected 'failure' to be 'success'\". Tried, reverted, recorded here so the next reader "
      + "does not repeat the experiment.",
  ],
]);

/** The constant's own declaration and the barrel re-exports are not call sites. */
const EXCLUDED = [
  "packages/core/src/builtin-coding-workflow-ir.ts",
  "packages/core/src/index.ts",
  "packages/core/src/index.gate.ts",
];

const REPO_ROOT = resolve(__dirname, "../../../..");
const SCAN_ROOTS = [
  "packages/core/src",
  "packages/engine/src",
  "packages/dashboard/src",
  "packages/dashboard/app",
  "packages/cli/src",
];

function* walk(dir: string): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === "dist" || entry === "__tests__") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.tsx?$/.test(full)) yield full;
  }
}

/*
COMMENTS ARE STRIPPED FIRST, and that is load-bearing rather than tidiness. Several files discuss this
constant by name in FNXC notes explaining a past bug — `activity-analytics.ts` and
`TaskContextMenu.tsx` both do. Counting those would make the guard fire on files that mention the
hazard while correctly avoiding it, which trains readers to add allow-list entries for prose. The
sibling sync-resolver ratchet learned the same lesson.
*/
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

function findUses(): Map<string, number> {
  const byFile = new Map<string, number>();
  for (const root of SCAN_ROOTS) {
    for (const file of walk(join(REPO_ROOT, root))) {
      const rel = relative(REPO_ROOT, file).split("\\").join("/");
      if (EXCLUDED.includes(rel)) continue;
      const source = readFileSync(file, "utf8");
      if (!source.includes("BUILTIN_CODING_WORKFLOW_IR")) continue;
      const uses = (stripComments(source).match(/\bBUILTIN_CODING_WORKFLOW_IR\b/g) ?? []).length;
      if (uses > 0) byFile.set(rel, uses);
    }
  }
  return byFile;
}

describe("the legacy workflow IR is reachable only where legacy is the right answer", () => {
  it("has no unlisted call site", () => {
    const unlisted = [...findUses().keys()].filter((file) => !ALLOWED_CALL_SITES.has(file)).sort();

    expect(unlisted, [
      "",
      "`BUILTIN_CODING_WORKFLOW_IR` is the LEGACY workflow (`builtin:legacy-coding`), not the",
      "catalog default. It declares a `triage` column the default board does not have.",
      "",
      "If you want the no-selection default, call `resolveDefaultWorkflowIr()`.",
      "If you genuinely need the legacy workflow, add an entry to ALLOWED_CALL_SITES in this file",
      "saying why LEGACY specifically is correct there.",
      "",
      "Three shipped bugs came from reaching for this name: the move-path preflight mismatch,",
      "the TUI board's phantom `triage` lane (#3178), and workflow-delete re-homing cards into",
      "`triage` (#3183).",
      "",
    ].join("\n")).toEqual([]);
  });

  /*
  ANTI-VACUITY. The case above passes trivially if the scan stops finding anything — a renamed
  constant, a moved file, a broken walker. This pins that the one legitimate site is still seen.
  */
  it("still finds the catalog's own uses, so the scan is not silently empty", () => {
    const uses = findUses();

    expect(uses.get("packages/core/src/builtin-workflows.ts")).toBeGreaterThan(0);
  });

  /*
  The allow-list must not rot into a list of files that no longer touch the constant — a stale entry
  reads as "someone considered this", which is the decay every ledger in this repo has hit.
  */
  it("has no stale allow-list entry", () => {
    const uses = findUses();
    const stale = [...ALLOWED_CALL_SITES.keys()].filter((file) => !uses.has(file));

    expect(stale).toEqual([]);
  });
});
