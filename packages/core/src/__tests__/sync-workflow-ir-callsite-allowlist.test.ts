import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";

/*
FNXC:WorkflowLifecycleColumns 2026-07-31-18:00 (fleet — stop the inert-conversion class growing):

`resolveTaskWorkflowIrSync` returns the DEFAULT workflow IR for EVERY task in production. Proven in
`postgres/sync-workflow-ir-is-always-default.pg.test.ts`: the sync selection reader is a
PostgreSQL-cutover stub that answers `undefined` unconditionally, so the resolver always takes its
`!workflowId` branch. Its return type is non-optional, so no caller can detect the substitution.

That makes it the most dangerous tool in this conversion program. A guard written as

    resolveLifecycleColumns(store.resolveTaskWorkflowIrSync(id))?.hold

reads as converted, resolves an IR, asks for a trait — and is wrong for every custom workflow,
silently. The lifecycle-column census scores it as PROGRESS. An unconverted `=== "todo"` is strictly
better, because it is at least honest about being a literal.

So new call sites need a deliberate entry here rather than passing review on looking correct. This is
the same shape as the repo's other call-site allow-lists (`engine-no-blocking-shellout`,
`check-no-nohup`), and for the same reason: the primitive has a legitimate narrow use and a
plausible-looking wrong one.

TO ADD A SITE: prove the async resolver (`resolveTaskLifecycleColumns` /
`resolveWorkflowIrForTask`) is genuinely unreachable there — usually because you are inside a
synchronous event listener or a hot transaction — and say so in the entry. "It was easier" is not a
reason; a sync-resolved lifecycle guard is a guard that cannot fire.
*/

const ALLOWED_CALL_SITES: ReadonlyMap<string, string> = new Map([
  [
    "packages/core/src/task-store/branch-and-pr-entities.ts",
    "Inside a synchronous store entity read.",
  ],
  [
    "packages/core/src/task-store/lifecycle-ops.ts",
    "Synchronous lifecycle bookkeeping inside a transaction.",
  ],
  [
    "packages/core/src/task-store/task-store-helpers.ts",
    "Synchronous helper shared by txn-hot paths.",
  ],
  [
    "packages/core/src/task-store/workflow-task-create-ops.ts",
    "Task creation runs before any selection exists, so the default IR is the correct answer here.",
  ],
  [
    "packages/engine/src/replan-target.ts",
    "`resolvePlannerLanes`, a synchronous planner-lane read. FOUND BY THIS RATCHET, not by the grep "
      + "that seeded the list — it calls through an optional-property cast "
      + "(`(store as { resolveTaskWorkflowIrSync?: ... }).resolveTaskWorkflowIrSync?.(id)`), which no "
      + "textual search for `store.resolveTaskWorkflowIrSync` matches. Its hazard is the sharpest of "
      + "the six: it returns `resolvedFromWorkflow: true` whenever an IR came back, so on a renamed "
      + "board a caller branching on that flag is told the lanes are workflow-resolved while being "
      + "handed the DEFAULT ones.",
  ],
  [
    "packages/engine/src/scheduler.ts",
    "`resolveTaskParkedColumnsSync`, called from synchronous `task:moved` / `task:updated` listeners "
      + "where introducing an await would reorder handlers against a synchronous emitter.",
  ],
]);

/** The declaration and the resolver's own module are not call sites. */
const EXCLUDED = [
  "packages/core/src/store.ts",
  "packages/core/src/task-store/workflow-definitions.ts",
  "packages/core/src/workflow-ir-resolver.ts",
];

const REPO_ROOT = resolve(__dirname, "../../../..");
const SCAN_ROOTS = [
  "packages/core/src",
  "packages/engine/src",
  "packages/dashboard/src",
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

/** Call sites of `<expr>.resolveTaskWorkflowIrSync(...)`, found by AST rather than by grep. */
function findCallSites(): Map<string, number> {
  const byFile = new Map<string, number>();

  for (const root of SCAN_ROOTS) {
    for (const file of walk(join(REPO_ROOT, root))) {
      const rel = relative(REPO_ROOT, file).split("\\").join("/");
      if (EXCLUDED.includes(rel)) continue;
      const source = readFileSync(file, "utf8");
      if (!source.includes("resolveTaskWorkflowIrSync")) continue;

      const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      let count = 0;
      const visit = (node: ts.Node) => {
        if (
          ts.isCallExpression(node)
          && ts.isPropertyAccessExpression(node.expression)
          && node.expression.name.text === "resolveTaskWorkflowIrSync"
        ) {
          count += 1;
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
      if (count > 0) byFile.set(rel, count);
    }
  }
  return byFile;
}

describe("resolveTaskWorkflowIrSync call sites are allow-listed", () => {
  /*
  Completeness: the allow-list is worthless if the scan finds nothing (a moved directory, a renamed
  method). This fails loudly instead of passing vacuously.
  */
  it("finds the known call sites", () => {
    const found = findCallSites();

    expect(found.size, "expected to find the documented sync-resolution call sites").toBeGreaterThan(0);
  });

  it("has no call site outside the allow-list", () => {
    const found = findCallSites();
    const unlisted = [...found.keys()].filter((file) => !ALLOWED_CALL_SITES.has(file)).sort();

    expect(
      unlisted,
      "resolveTaskWorkflowIrSync returns the DEFAULT workflow IR for every task, so a lifecycle "
        + "guard resolved through it CANNOT fire correctly on a custom workflow — and reads as "
        + "converted while doing it. Use the async resolver, or add an entry with the reason the "
        + "async path is unreachable.",
    ).toEqual([]);
  });

  /*
  The other direction: an allow-list that outlives its entries rots into permission nobody reviewed.
  A site that stops using the primitive should lose its entry in the same change.
  */
  it("has no stale allow-list entry", () => {
    const found = findCallSites();
    const stale = [...ALLOWED_CALL_SITES.keys()].filter((file) => !found.has(file)).sort();

    expect(stale, "remove allow-list entries for files that no longer resolve synchronously").toEqual([]);
  });
});
