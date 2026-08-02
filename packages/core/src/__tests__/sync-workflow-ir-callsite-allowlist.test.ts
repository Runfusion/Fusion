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

FNXC:WorkflowLifecycleColumns 2026-07-31-23:10 (CORRECTION — this note named ONE blocker; there are
TWO, and I am the author of several of the notes elsewhere that repeat the same undercount):
Fixing the selection reader alone would NOT un-inert this path for the boards this program exists
for. `resolveTaskWorkflowIrSyncImpl` loads a CUSTOM workflow's IR through `store.db.prepare(...)`,
and `TaskStore.db` (`dbImpl`, task-id-integrity.ts) is an UNCONDITIONAL throw with no mode branch —
so that read always throws into the surrounding `catch` and always yields the default IR. A built-in
workflow could resolve once the selection reader works; a CUSTOM one never can, and a renamed lane
is by definition a custom workflow.
A third constraint bounds the fix's shape: multiple nodes run their own engines against ONE shared
PostgreSQL (`docs/multi-project.md`), so a node-local sync cache of the selection goes stale when
another node writes one — confidently wrong, which is worse than today's uniformly-wrong default.
All three are proved and kept honest by `sync-workflow-ir-second-blocker.test.ts`.

FNXC:WorkflowLifecycleColumns 2026-08-01-05:01:
FN-8656 removed `scheduler.ts` from this list. Its synchronous `task:moved` prologue now consumes
emitter lanes over legacy defaults, while its post-await arms and agent-link rollback resolve lanes
asynchronously. Keeping the old exception would hide a reintroduced inert scheduler read.

That makes it the most dangerous tool in this conversion program. A guard written as

    resolveLifecycleColumns(store.resolveTaskWorkflowIrSync(id))?.hold

reads as converted, resolves an IR, asks for a trait — and is wrong for every custom workflow,
silently. The lifecycle-column census scores it as PROGRESS. An unconverted `=== "todo"` is strictly
better, because it is at least honest about being a literal.

So new call sites need a deliberate entry here rather than passing review on looking correct. This is
the same shape as the repo's other call-site allow-lists (the engine blocking-shellout list, and the
detached-spawn script guard under `scripts/`), and for the same reason: the primitive has a
legitimate narrow use and a plausible-looking wrong one.

(Those two names are deliberately not spelled literally here: the spawn guard matches on raw text
across `packages/**`, so quoting its banned token in prose trips it. A guard that greps rather than
parses cannot tell a mention from a use — which is the same lesson this file is about, one level up.)

TO ADD A SITE: prove the async resolver (`resolveTaskLifecycleColumns` /
`resolveWorkflowIrForTask`) is genuinely unreachable there — usually because you are inside a
synchronous event listener or a hot transaction — and say so in the entry. "It was easier" is not a
reason; a sync-resolved lifecycle guard is a guard that cannot fire.
*/

const ALLOWED_CALL_SITES: ReadonlyMap<string, string> = new Map([
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

/*
FNXC:WorkflowLifecycleColumns 2026-07-31-20:10 (PR #2759 review — greptile P2):
ALIASES COUNT. Matching only `<expr>.resolveTaskWorkflowIrSync(...)` left an opening: destructure or
rebind the method and the callee becomes a bare identifier, so a new synchronous resolution passes a
guard whose whole purpose is to catch it.

    const { resolveTaskWorkflowIrSync: resolveIr } = store;   // callee is now an identifier
    const ir = resolveIr(taskId);

`replan-target.ts` already proves the family is used through non-obvious call shapes — it reaches the
method via an optional-property cast, which is why the grep that seeded this list missed it. So the
detector tracks the NAME through local aliases as well as property access, and additionally refuses
the alias-creating forms outright, which is cheaper to reason about than chasing every rebinding.
*/
/** Call sites of the sync resolver, by property access OR through a local alias. Found by AST. */
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
      /* Local names bound to the method, so `const f = store.resolveTaskWorkflowIrSync; f(id)` counts. */
      const aliases = new Set<string>();
      const collectAliases = (node: ts.Node) => {
        if (ts.isVariableDeclaration(node) && node.initializer && ts.isIdentifier(node.name)) {
          const init = node.initializer;
          const isMethodRef = (ts.isPropertyAccessExpression(init) || ts.isNonNullExpression(init))
            && init.getText(sf).includes("resolveTaskWorkflowIrSync");
          if (isMethodRef) aliases.add(node.name.text);
        }
        /* Destructuring: `const { resolveTaskWorkflowIrSync: alias } = store`. */
        if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name)) {
          for (const element of node.name.elements) {
            const source = (element.propertyName ?? element.name);
            if (ts.isIdentifier(source) && source.text === "resolveTaskWorkflowIrSync"
              && ts.isIdentifier(element.name)) {
              aliases.add(element.name.text);
            }
          }
        }
        ts.forEachChild(node, collectAliases);
      };
      collectAliases(sf);

      const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node)) {
          const callee = node.expression;
          const isPropertyCall = ts.isPropertyAccessExpression(callee)
            && callee.name.text === "resolveTaskWorkflowIrSync";
          const isAliasCall = ts.isIdentifier(callee) && aliases.has(callee.text);
          if (isPropertyCall || isAliasCall) count += 1;
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
      /* An alias declared but never called still counts: it exists to be called. */
      if (count === 0 && aliases.size > 0) count = aliases.size;
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
