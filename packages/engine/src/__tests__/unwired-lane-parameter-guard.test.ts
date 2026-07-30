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
const SCANNED_PACKAGES = ["packages/core/src", "packages/engine/src", "packages/dashboard/src", "packages/dashboard/app", "packages/cli/src"];

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

describe("no lane-resolution parameter is left unwired", () => {
  it("every optional lane parameter is supplied by at least one other file", () => {
    const files = SCANNED_PACKAGES.flatMap((pkg) => sourceFiles(join(REPO_ROOT, pkg)));
    const unwired = findUnwiredLaneParameters(files, (f) => readFileSync(f, "utf8"));

    const described = unwired.map((d) => `${d.file.replace(`${REPO_ROOT}/`, "")}:${d.line} ${d.owner}(${d.parameter})`);

    expect(described, [
      "These declarations take a resolved lane answer that NO production file supplies.",
      "That is not a loose end — in four of five audited cases the caller held a larger defect.",
      "Either wire the caller, or make the parameter required so the compiler finds the call sites.",
    ].join("\n")).toEqual([]);
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

  it("keeps the vocabulary list explicit, so a new convention opts in deliberately", () => {
    expect(LANE_PARAMETER_NAMES).toContain("reviewColumns");
    expect(LANE_PARAMETER_NAMES).toContain("columnFlags");
  });
});
