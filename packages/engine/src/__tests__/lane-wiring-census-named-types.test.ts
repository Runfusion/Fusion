// @vitest-environment node

/*
FNXC:WorkflowLifecycleColumns 2026-07-30-23:50:
THE LANE-WIRING CENSUS MUST SEE NAMED CONTEXT TYPES, not only inline type literals.

`scripts/lib/lane-wiring-census.mjs` recognises a lane-accepting function so its call sites can be
checked for a resolved-lane argument. Its first version matched only `param.type` being a
`TypeLiteralNode`, so a parameter typed by an INTERFACE was invisible — and that is how the real
code is written:

  export function getInReviewStallReason(task: …, context: InReviewStallContext = {})

The consequence was not academic. The census shipped unable to detect #2956 — the first case listed
in its own header — and re-introducing that defect left it reporting "none added". Fixing the
detector moved the honest count from 10 unwired call sites across 8 files to 18 across 14.

The first draft of that fix reported 24, because detecting these functions also exposed a SECOND bug
(the `satisfies` case below) that had been hidden while they were invisible: six of those "new" hits
were correct code. Both fixes ship together, or the baseline records six sites nobody can act on.

Fixtures rather than the live tree: a test asserting counts over real source would fail every time
someone legitimately wires or adds a call site, which is the churn the baseline exists to absorb.
These pin the DETECTOR's shape instead. The final case is the anti-vacuity check — it asserts the
real corpus still exercises the named-type arm, so the fixtures cannot pass while the tool has
silently stopped applying to this codebase.
*/

import { mkdtempSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { findLaneAcceptingFunctions, findUnwiredCallSites } from "../../../../scripts/lib/lane-wiring-census.mjs";

function fixture(source: string): string[] {
  const dir = mkdtempSync(join(tmpdir(), "fusion-lane-census-"));
  const file = join(dir, "fixture.ts");
  writeFileSync(file, source);
  return [file];
}

const REPO_ROOT = resolve(__dirname, "../../../..");

describe("the lane-wiring census recognises how lane arguments are actually declared", () => {
  it("detects a lane member on a NAMED context interface (the #2956 shape)", () => {
    const files = fixture(`
      export interface StallContext { now?: number; reviewColumns?: ReadonlySet<string>; }
      export function getSignal(task: string, context: StallContext = {}): string { return task; }
    `);
    const accepting = findLaneAcceptingFunctions(files);
    expect(accepting.has("getSignal")).toBe(true);
    expect([...accepting.get("getSignal")!.namesByIndex.get(1)!]).toContain("reviewColumns");
  });

  it("counts a call site that omits the lane argument on that named-type function", () => {
    const files = fixture(`
      export interface StallContext { reviewColumns?: ReadonlySet<string>; }
      export function getSignal(task: string, context: StallContext = {}): string { return task; }
      export function wired() { return getSignal("a", { reviewColumns: new Set<string>() }); }
      export function unwired() { return getSignal("b", { now: 1 } as never); }
    `);
    const unwired = findUnwiredCallSites(files, findLaneAcceptingFunctions(files));
    expect(unwired.map((hit) => hit.fn)).toEqual(["getSignal"]);
  });

  /*
  FNXC:WorkflowLifecycleColumns 2026-07-30-22:25:
  `satisfies` must not hide a wired call. #2956 annotated four wired `reads.ts` call sites with
  `satisfies InReviewStalledContext`, and a bare `isObjectLiteralExpression` check reported every one
  as unwired — the wrapper node is not the literal. Six false positives, all in correct code.

  This case exists because a census that flags correct code inflates its own baseline with entries
  nobody can act on, and the first person to check one stops trusting the number.
  */
  it("treats a `satisfies`-annotated options bag as wired", () => {
    const files = fixture(`
      export interface StallContext { reviewColumns?: ReadonlySet<string>; }
      export function getSignal(task: string, context: StallContext = {}): string { return task; }
      export function wired() {
        return getSignal("a", { reviewColumns: new Set<string>() } satisfies StallContext);
      }
    `);
    expect(findUnwiredCallSites(files, findLaneAcceptingFunctions(files))).toEqual([]);
  });

  it("still detects the inline type-literal and positional spellings", () => {
    const files = fixture(`
      export function inlineBag(task: string, opts: { terminalColumns?: ReadonlySet<string> }): string { return task; }
      export function positional(task: string, activeColumns: ReadonlySet<string>): string { return task; }
    `);
    const accepting = findLaneAcceptingFunctions(files);
    expect([...accepting.get("inlineBag")!.namesByIndex.get(1)!]).toContain("terminalColumns");
    expect([...accepting.get("positional")!.positions]).toEqual([1]);
  });

  /*
  FNXC:WorkflowLifecycleColumns 2026-07-30-23:20 (#2974 review — coderabbitai): THE TWO FALSE-GREEN
  HOLES, PINNED. Both errors pointed the same way — MORE sites counted as wired — which for a ratchet
  means unwired seams vanish and the gate passes with nothing to report.
  */
  it("does NOT count a lane key that appears in the wrong argument as wired", () => {
    /*
    The options bag is parameter 1. Passing `reviewColumns` on the parameter-0 `task` object and an
    EMPTY bag means the function receives no lane answer at all. Before the index was retained, the
    call-site check scanned every argument and scored this wired.
    */
    const files = fixture(`
      export function needsLanes(task: { id: string }, opts: { reviewColumns?: ReadonlySet<string> }): string { return ""; }
      export function caller(): string { return needsLanes({ id: "x", reviewColumns: new Set() } as never, {}); }
    `);
    const unwired = findUnwiredCallSites(files, findLaneAcceptingFunctions(files));

    expect(unwired.map((u) => u.fn)).toContain("needsLanes");
  });

  it("still counts the SAME key as wired when it is in the declaring argument", () => {
    /* Paired positive: the fix must not make every options-bag call look unwired. */
    const files = fixture(`
      export function needsLanes(task: { id: string }, opts: { reviewColumns?: ReadonlySet<string> }): string { return ""; }
      export function caller(): string { return needsLanes({ id: "x" }, { reviewColumns: new Set() }); }
    `);
    const unwired = findUnwiredCallSites(files, findLaneAcceptingFunctions(files));

    expect(unwired.map((u) => u.fn)).not.toContain("needsLanes");
  });

  it("refuses to merge two same-named lane-carrying types instead of unioning them silently", () => {
    /*
    Resolution is by NAME with no type checker, so two `Ctx` declarations would union their lane
    members and let a call that supplies only the OTHER file's key count as wired. Throwing names both
    paths; the previous behaviour returned a quietly wrong answer.
    */
    const files = fixture(`
      export interface Ctx { reviewColumns?: ReadonlySet<string>; }
    `).concat(
      fixture(`
        export interface Ctx { completeColumns?: ReadonlySet<string>; }
      `),
    );

    expect(() => findLaneAcceptingFunctions(files)).toThrow(/two files declare a lane-carrying type named "Ctx"/);
  });

  it("type aliases carry lane members too", () => {
    const files = fixture(`
      export type MergeContext = { completeColumns?: ReadonlySet<string> };
      export function canMerge(task: string, context: MergeContext): string { return task; }
    `);
    expect([...findLaneAcceptingFunctions(fixture("")).keys()]).toEqual([]);
    expect([...findLaneAcceptingFunctions(files).get("canMerge")!.namesByIndex.get(1)!]).toContain("completeColumns");
  });

  /*
  ANTI-VACUITY against the live tree. The fixtures above would keep passing if the named-type arm
  stopped mattering here — if every context interface were inlined, or the census stopped being
  pointed at core. This asserts the arm is still load-bearing on real source.
  */
  it("resolves a real named-context function in the live tree", () => {
    function sources(dir: string, out: string[] = []): string[] {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) {
          if (entry === "__tests__" || entry === "node_modules" || entry === "dist") continue;
          sources(path, out);
        } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts") && !entry.includes(".test.")) {
          out.push(path);
        }
      }
      return out;
    }
    const accepting = findLaneAcceptingFunctions(sources(join(REPO_ROOT, "packages/core/src")));
    expect(accepting.size).toBeGreaterThan(5);
    // Declared as `context: InReviewStallContext` — invisible to the census before this arm existed.
    expect(accepting.has("getInReviewStallReason")).toBe(true);
  });
});
