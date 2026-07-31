/*
FNXC:WorkflowLifecycleColumns 2026-07-31-16:40:

THE INVARIANT: a lane-resolution parameter that no production caller supplies is a build failure.

WHY THIS GUARD EXISTS, measured rather than asserted. This program repeatedly shipped conversions of
the shape "optional resolved answer, documented literal fallback" and then never passed the argument
from the production caller. **Five such parameters were live on `main` at once.** Auditing them found
that in FOUR the parameter was unreachable because the CALLER held a larger defect:

  - a bottleneck warning whose count was always zero, so it never printed at all;
  - analytics routes that never built the map, reporting 0 active beside correct cost totals;
  - a backfill that queried a column a renamed board does not have;
  - a store read returning archived cards as open assigned work.

None of that is visible to the lifecycle census: the literal sits behind a documented fallback, so
the site counts as converted. None of it is visible to the unit tests either, because they inject the
value by hand — one of my own test files stayed green when I removed the wiring, which is what
prompted this.

Two workers found the class independently (#2787's review and #2799). That is the argument for
detecting it mechanically rather than by sweep.

DELIBERATELY CONSERVATIVE, because a false positive here is worse than a miss: the response to a
noisy guard is to disable it. It reports only exported declarations, only optional parameters, only
names in the lane vocabulary, and treats a MENTION anywhere else as wired.
*/
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { findUnwiredLaneParameters, LANE_PARAMETER_NAMES } from "../../../../scripts/lib/unwired-lane-parameter.mjs";

const REPO_ROOT = resolve(import.meta.dirname, "../../../..");
/*
FNXC:WorkflowLifecycleColumns 2026-07-31-01:20:
`plugins` is scanned, and its absence was half of a real escape.

Plugins hold lane logic like anything else — the glasses plugin resolves workflow IRs, filters by
column, and decides what "finished" means for a notification — and this list simply did not look at
them. Combined with the inline-options blind spot below, an unwired `completeColumnsByTaskId` sat on
`main` unreported: the guard found 0 across 1753 files, and 0 again across 2114 once plugins were
added, because the shape was invisible too. Fixing either alone would still have missed it.
*/
const SCANNED_PACKAGES = ["packages/core/src", "packages/engine/src", "packages/dashboard/src", "packages/dashboard/app", "packages/cli/src", "plugins"];

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      /* Tests are excluded on purpose: a test passing the argument is exactly the false signal. */
      if (entry === "__tests__" || entry === "node_modules" || entry === "dist") continue;
      sourceFiles(full, acc);
      continue;
    }
    if (/\.(ts|tsx)$/.test(entry) && !/\.(test|spec)\.tsx?$/.test(entry)) acc.push(full);
  }
  return acc;
}

/*
FNXC:WorkflowLifecycleColumns 2026-07-31-01:35:
The KNOWN-UNWIRED baseline, and why a guard that reported `[]` is being changed to report 18.

This assertion used to be `toEqual([])` and it passed — because the mention rule it ran on ("the
parameter name appears in ANY other file") is satisfied by coincidence for every ordinarily-named
parameter. `completeColumns` alone is a local variable in 15 unrelated production files. The guard
was not clean; it was answering a question too weak to fail.

Tightening the rule to "the mention must come from a file that also names the declaring symbol"
surfaced these 18 at once. Spot-checked before recording rather than assumed: `buildUnblockWeightMap`
in `task-priority.ts` declares `terminalColumns` and `reviewColumns`, and the only files that pass
either are its own tests — the production caller uses the built-in `{done, archived}` default, which
is the inert-conversion shape this module exists to name.

Recorded as a RATCHET, in the shape `scripts/lifecycle-column-census.mjs` already uses here: a new
unwired declaration fails immediately, and each of these can only leave the list. Keyed on
file + parameter rather than line so an unrelated edit above them does not manufacture a failure.

Wiring them is not this change's job — they span core, engine and dashboard, i.e. three other
batches — and pretending they did not exist for another week is worse than listing them.
*/
/*
FNXC:WorkflowLifecycleColumns 2026-07-31-17:05:
`scheduler.ts isWipColumn` LEFT this list, which is the direction it is supposed to move.

It is supplied at both production call sites now — `self-healing.ts:4754` and `:5825` pass
`isWipColumn: completedWipColumns.has(blocker.column)` and the blocked-lane equivalent, wired by
#2975/#2987. The list was not shortened in the same change, so this assertion has been RED on `main`
since: 16 found against 17 allowed.

Removed rather than re-recorded wholesale, per this file's own instruction two paragraphs down —
"update the list only to shorten it". Nothing arrived; the delta is exactly this one departure.
*/
const KNOWN_UNWIRED = [
  "packages/core/src/blocker-fanout.ts escalationColumns",
  "packages/core/src/blocker-fanout.ts holdColumn",
  "packages/core/src/blocker-fanout.ts reviewColumns",
  "packages/core/src/blocker-fanout.ts terminalColumns",
  "packages/core/src/near-duplicate-canonical.ts columnFlags",
  "packages/core/src/node-override-guard.ts completeColumns",
  "packages/core/src/stale-paused-todo.ts holdColumn",
  "packages/core/src/task-merge.ts satisfactionColumnsByTaskId",
  "packages/core/src/task-priority.ts reviewColumns",
  "packages/core/src/task-priority.ts terminalColumns",
  "packages/core/src/team-analytics.ts columnFlagsByName",
  "packages/core/src/workflow-analytics.ts columnFlagsByName",
  "packages/dashboard/app/utils/taskActivity.ts columnFlags",
  "packages/dashboard/app/utils/taskTiming.ts columnFlags",
  "packages/engine/src/runtimes/in-process-runtime.ts terminalColumns",
  "packages/engine/src/scheduler.ts satisfactionColumnsByTaskId",
].sort();

describe("no lane-resolution parameter is left unwired", () => {
  it("reports exactly the known-unwired declarations, and no new ones", () => {
    const files = SCANNED_PACKAGES.flatMap((pkg) => sourceFiles(join(REPO_ROOT, pkg)));
    const unwired = findUnwiredLaneParameters(files, (f) => readFileSync(f, "utf8"));

    /* De-duplicated: `in-process-runtime.ts` declares `terminalColumns` on two separate options
       objects, and the ratchet is about which (file, parameter) pairs are unwired, not how many
       times each is spelled. */
    const described = [...new Set(
      unwired.map((d) => `${d.file.replace(`${REPO_ROOT}/`, "")} ${d.parameter}`),
    )].sort();

    expect(described, [
      "These declarations take a resolved lane answer that NO production file supplies.",
      "That is not a loose end — in four of five audited cases the caller held a larger defect.",
      "Either wire the caller, or make the parameter required so the compiler finds the call sites.",
      "A parameter LEAVING this list is the goal; one arriving is a regression — update the list only to shorten it.",
    ].join("\n")).toEqual(KNOWN_UNWIRED);
  });

  it("fires on the shape it exists to catch", () => {
    // A guard nobody has proven can fail is a number, not a check.
    const decl = "/repo/packages/core/src/thing.ts";
    const files = {
      [decl]: 'export function isThing(task: Task, reviewColumns?: ReadonlySet<string>) { return reviewColumns ? reviewColumns.has(task.column) : task.column === "in-review"; }',
      "/repo/packages/core/src/caller.ts": 'import { isThing } from "./thing.js"; isThing(task);',
    } as Record<string, string>;

    const unwired = findUnwiredLaneParameters(Object.keys(files), (f) => files[f]!);

    expect(unwired.map((d) => `${d.owner}(${d.parameter})`)).toEqual(["isThing(reviewColumns)"]);
  });

  it("stays quiet once a caller supplies the argument", () => {
    const decl = "/repo/packages/core/src/thing.ts";
    const files = {
      [decl]: 'export function isThing(task: Task, reviewColumns?: ReadonlySet<string>) { return reviewColumns?.has(task.column) ?? false; }',
      "/repo/packages/core/src/caller.ts": "isThing(task, reviewColumns);",
    } as Record<string, string>;

    expect(findUnwiredLaneParameters(Object.keys(files), (f) => files[f]!)).toEqual([]);
  });

  it("ignores a REQUIRED lane parameter — the compiler already finds those call sites", () => {
    const decl = "/repo/packages/core/src/thing.ts";
    const files = {
      [decl]: "export function isThing(task: Task, reviewColumns: ReadonlySet<string>) { return reviewColumns.has(task.column); }",
      "/repo/packages/core/src/caller.ts": "isThing(task);",
    } as Record<string, string>;

    expect(findUnwiredLaneParameters(Object.keys(files), (f) => files[f]!)).toEqual([]);
  });

  it("covers the options-object shape, not just positional parameters", () => {
    // Half the real cases arrived as an optional property on an exported options interface.
    const decl = "/repo/packages/core/src/thing.ts";
    const files = {
      [decl]: "export interface ThingOptions { escalationColumns?: ReadonlySet<string>; }",
      "/repo/packages/core/src/caller.ts": "computeThing(tasks, {});",
    } as Record<string, string>;

    expect(findUnwiredLaneParameters(Object.keys(files), (f) => files[f]!).map((d) => d.parameter)).toEqual(["escalationColumns"]);
  });

  /*
  FNXC:WorkflowLifecycleColumns 2026-07-31-01:20:
  The INLINE options-object shape — the third spelling, and the one that produced a real escape.

  `diffSnapshots` in the glasses plugin declared

      opts: { notifyOnColumns: ReadonlySet<ColumnId>; completeColumnsByTaskId?: ReadonlyMap<...> }

  and no file anywhere built that map, so its completion test fell through to the literal `"done"`
  on every real poll. The name was already in the vocabulary list and the declaration was exported
  and optional — it satisfied every condition the guard checks — yet the guard reported nothing,
  because the type is an anonymous `TypeLiteral` on the parameter rather than a named `interface`.

  Measured on `main` before the fix: 0 unwired parameters across 2114 files, that one included.

  The point of the case is that the three spellings must be equivalent. Whether a lane answer
  arrives as a bare parameter, an interface property, or an inline options field is a style choice,
  and a check evadable by a style choice is decorative.
  */
  it("covers an INLINE options-object type on a parameter", () => {
    const decl = "/repo/plugins/p/src/diff.ts";
    const files = {
      [decl]: "export function diffSnapshots(prev: S, next: T[], opts: { notifyOnColumns: ReadonlySet<string>; completeColumns?: ReadonlySet<string> }) { return opts; }",
      "/repo/plugins/p/src/caller.ts": "diffSnapshots(prev, next, { notifyOnColumns });",
    } as Record<string, string>;

    expect(findUnwiredLaneParameters(Object.keys(files), (f) => files[f]!).map((d) => d.parameter)).toEqual(["completeColumns"]);
  });

  it("does NOT report an inline options field that a caller mentions", () => {
    // The wired case must stay silent, or the guard becomes noise people learn to disable.
    const decl = "/repo/plugins/p/src/diff.ts";
    const files = {
      [decl]: "export function diffSnapshots(prev: S, opts: { completeColumns?: ReadonlySet<string> }) { return opts; }",
      "/repo/plugins/p/src/caller.ts": "diffSnapshots(prev, { completeColumns });",
    } as Record<string, string>;

    expect(findUnwiredLaneParameters(Object.keys(files), (f) => files[f]!)).toEqual([]);
  });

  it("ignores a REQUIRED inline options field — the compiler already finds those call sites", () => {
    const decl = "/repo/plugins/p/src/diff.ts";
    const files = {
      [decl]: "export function diffSnapshots(opts: { completeColumns: ReadonlySet<string> }) { return opts; }",
      "/repo/plugins/p/src/caller.ts": "diffSnapshots(other);",
    } as Record<string, string>;

    expect(findUnwiredLaneParameters(Object.keys(files), (f) => files[f]!)).toEqual([]);
  });

  it("keeps the vocabulary list explicit, so a new convention opts in deliberately", () => {
    expect(LANE_PARAMETER_NAMES).toContain("reviewColumns");
    expect(LANE_PARAMETER_NAMES).toContain("columnFlags");
  });
});
