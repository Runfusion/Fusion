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
detector moved the honest count from 10 unwired call sites across 8 files to 24 across 15.

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
    expect([...accepting.get("getSignal")!.names]).toContain("reviewColumns");
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

  it("still detects the inline type-literal and positional spellings", () => {
    const files = fixture(`
      export function inlineBag(task: string, opts: { terminalColumns?: ReadonlySet<string> }): string { return task; }
      export function positional(task: string, activeColumns: ReadonlySet<string>): string { return task; }
    `);
    const accepting = findLaneAcceptingFunctions(files);
    expect([...accepting.get("inlineBag")!.names]).toContain("terminalColumns");
    expect([...accepting.get("positional")!.positions]).toEqual([1]);
  });

  it("type aliases carry lane members too", () => {
    const files = fixture(`
      export type MergeContext = { completeColumns?: ReadonlySet<string> };
      export function canMerge(task: string, context: MergeContext): string { return task; }
    `);
    expect([...findLaneAcceptingFunctions(fixture("")).keys()]).toEqual([]);
    expect([...findLaneAcceptingFunctions(files).get("canMerge")!.names]).toContain("completeColumns");
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
