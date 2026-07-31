/*
FNXC:WorkflowLifecycleColumns 2026-07-31-17:08 (close the third inert-conversion mechanism at zero):

A TASK-SCOPED LANE RESOLVER CALLED WITH A STRING LITERAL RESOLVES THE DEFAULT BOARD, ALWAYS.

`resolveTaskLifecycleColumns(store, taskId)` and its siblings resolve the workflow bound to THAT
task. Hand one a literal — `""`, `"unknown"`, a synthetic id — and there is no task to read a
selection for, so the resolver falls back to the default board and answers with full confidence. The
call type-checks, reads as a completed conversion, and is correct on every board Fusion ships,
because the default board is the answer it returns.

THIS SHIPPED. `triage.ts`'s startup sweep called `resolvePlannerLanes(this.store, "")` and built its
swept-column set from the result (#2806 measured it, #3201 fixed it). It is a SWEEP-WIDE defect
rather than a per-card one: the sweep resolved once for the whole board and could not be right for
any workflow but the default, so a card parked in a RENAMED hold column with a stale `planning`
status was never swept and held a planning admission slot permanently.

WHY A GUARD AND NOT JUST THE E2E. The existing proof
(`workflow-sweep-sentinel-task-id-live-e2e.pg.test.ts`) covers the ONE triage site and lives in the
`.pg` lane, so it is skipped whenever no PostgreSQL is reachable — including the merge gate. The
defect is the ARGUMENT, which means it is visible in the source text without a database, without a
running engine, and without knowing what the resolver does. That is what this file checks.

THE POPULATION IS ZERO TODAY, and a zero-population ratchet is the point rather than a weakness: it
cannot fail until someone reintroduces the defect, and it costs one source scan. Note the asymmetry
this ratchet takes, which is the one `check-inert-sync-lane-conversions` settled on: a NEW entry has
an author and must FAIL, because a person just wrote it. There is no auto-widening branch here —
nothing legitimately grows this set.

WHAT THIS DOES NOT CATCH, said plainly so it is not mistaken for full coverage: a sentinel that
arrives through a VARIABLE (`const sweepId = ""; resolve(store, sweepId)`) is invisible to a text
scan. The literal form is what shipped and what the next person is most likely to write; the
variable form needs the E2E above. Two instruments, different reach.
*/

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/**
 * Resolvers whose SECOND argument is a task id. All share `(store, taskId, cache?)`.
 *
 * `resolveReboundTarget(ir)` and `resolveLifecycleColumns(ir)` are deliberately absent: they are
 * IR-scoped, take no task id, and including them would make the scanner flag correct code.
 */
const TASK_SCOPED_RESOLVERS = [
  "resolveTaskLifecycleColumns",
  "resolveReboundTargetForTask",
  "resolveWipTargetForTask",
  "resolveArchiveTargetForTask",
  "resolveWorkflowIrForTask",
  "resolvePlannerLanes",
  "resolvePlannerLanesForTask",
  "resolvePlannerLanesForTaskAsync",
] as const;

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
COMMENTS ARE STRIPPED FIRST, and here that is not tidiness — it is required for the guard to be
usable at all. `triage.ts` documents its own fixed bug by quoting the offending call verbatim:

    `resolvePlannerLanes(this.store, "")` was called with an EMPTY task id — there is no task here

Counting that would make this guard fire on the file that correctly explains the hazard, which
teaches readers to silence the guard rather than heed it. `#3185`'s allow-list and the sync-resolver
ratchet both learned this; measured here, it is the difference between one false hit and zero.
*/
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

/**
 * Call sites whose task-id argument is a string LITERAL rather than an expression.
 *
 * Matches `resolver(<anything-without-a-comma>, "…")` — the first argument is the store, the second
 * is the sentinel. Template literals and both quote styles count; an interpolated template is still
 * not a row id read from a task.
 */
function findLiteralTaskIdCallSites(scan: (source: string) => string = stripComments): string[] {
  const pattern = new RegExp(
    String.raw`\b(${TASK_SCOPED_RESOLVERS.join("|")})\s*\(\s*[^,()]+,\s*(["'\`])`,
    "g",
  );
  const hits: string[] = [];
  for (const root of SCAN_ROOTS) {
    for (const file of walk(join(REPO_ROOT, root))) {
      const rel = relative(REPO_ROOT, file).split("\\").join("/");
      const source = readFileSync(file, "utf8");
      if (!TASK_SCOPED_RESOLVERS.some((name) => source.includes(name))) continue;
      const scanned = scan(source);
      for (const match of scanned.matchAll(pattern)) {
        const line = scanned.slice(0, match.index).split("\n").length;
        hits.push(`${rel}:${line} — ${match[1]}`);
      }
    }
  }
  return hits.sort();
}

describe("task-scoped lane resolvers are never handed a literal task id", () => {
  it("has no call site passing a string literal where a row id belongs", () => {
    expect(findLiteralTaskIdCallSites(), [
      "",
      "A task-scoped lane resolver was called with a string literal instead of a real task id.",
      "",
      "There is no task with that id, so no workflow selection can be read for it and the resolver",
      "returns the DEFAULT board — confidently, and wrongly, for every custom workflow. The call",
      "type-checks and looks like a finished conversion.",
      "",
      "This is what shipped as `resolvePlannerLanes(this.store, \"\")` in triage's startup sweep",
      "(#2806 measured it, #3201 fixed it): a sweep-wide defect that skipped every renamed board.",
      "",
      "Pass the id of a real row. If you need the PROJECT's lane vocabulary rather than one card's,",
      "use `resolveProjectColumnsForRoles(store, roles)` — that is the helper for a board-wide",
      "question, and it does not need a task at all.",
      "",
    ].join("\n")).toEqual([]);
  });

  /*
  ANTI-VACUITY, and the case that actually earns this file. Everything above is a scan that reports
  success by finding nothing, which is indistinguishable from a scanner that finds nothing because it
  is broken — a renamed resolver, a moved directory, a regex that never matches. This feeds the
  matcher the exact text that shipped and requires it to fire.
  */
  it("the matcher DOES flag the historical bug shape", () => {
    const historical = `const sweepLanes = resolvePlannerLanes(this.store, "");`;
    const flagged = findLiteralTaskIdCallSites(() => historical);

    expect(flagged.length).toBeGreaterThan(0);
    expect(flagged[0]).toContain("resolvePlannerLanes");
  });

  /*
  The paired negative: a matcher that flagged every call would also "fire on the bug shape" and pass
  the case above while making the guard unusable. Real call sites pass `task.id`, `taskId`, `row.id`
  — none may be flagged.
  */
  it("does NOT flag the ordinary call shapes that fill the codebase", () => {
    const ordinary = [
      `await resolveTaskLifecycleColumns(store, task.id, irCache)`,
      `await resolveTaskLifecycleColumns(this.store, taskId)`,
      `await resolveWipTargetForTask(store, row.id)`,
      `resolvePlannerLanes(this.store, dep.id)`,
    ].join("\n");

    expect(findLiteralTaskIdCallSites(() => ordinary)).toEqual([]);
  });

  /*
  The scan must still be REACHING production source — the assertions above all run against synthetic
  strings, so they would pass against an empty repository. This pins that the walker finds the real
  resolver calls, which is what makes the zero in the first case meaningful.
  */
  it("still sees the real call sites, so the zero above is a measurement", () => {
    let callSites = 0;
    for (const root of SCAN_ROOTS) {
      for (const file of walk(join(REPO_ROOT, root))) {
        const body = stripComments(readFileSync(file, "utf8"));
        callSites += (body.match(/\bresolveTaskLifecycleColumns\s*\(/g) ?? []).length;
      }
    }

    /* Dozens today across core, engine and dashboard; the floor guards against a broken walk. */
    expect(callSites).toBeGreaterThan(20);
  });
});
