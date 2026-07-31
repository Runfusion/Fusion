// Exit-code coverage for the inert-sync-lane ratchet: a RISE fails, and an unrecorded DROP fails too.
/*
FNXC:WorkflowResolvedColumns 2026-07-31-23:45:
A RATCHET THAT ONLY TIGHTENS ON REQUEST DOES NOT RATCHET, and nothing tested this one's exit codes.

The rise path was always an error. The DROP path only warned and exited 0, which leaves the
allowance stale-high and the gate slack by exactly the size of the drop.

Measured, and the example is mine: #3065 replaced three
`to === parked.complete || to === parked.archived` guards with `parked.terminal.has(to)` and took the
count 20 -> 18. I did not re-record, nothing failed, and `main` then carried a baseline of 20 against
a real count of 18 — two free slots in the gate whose whole purpose is to stop this class growing.
Two new inert conversions would have passed.

Its sibling `check-lane-wiring.mjs` already exits 1 on an unrecorded drop and says why. These two
gates guard the same program and must not disagree about how seriously they take their own ledger.

Driven by RUNNING the script against a temp baseline, not by importing a helper: the exit code IS the
contract — a version that printed the right warning and still exited 0 would satisfy any assertion
about its output.
*/
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const SCRIPT = join(REPO_ROOT, "scripts/check-inert-sync-lane-conversions.mjs");
const BASELINE = join(REPO_ROOT, "scripts/lib/inert-sync-lane-baseline.json");

function runGate() {
  return spawnSync(process.execPath, [SCRIPT], { cwd: REPO_ROOT, encoding: "utf8" });
}

/** The gate's own view of the tree, so cases start from reality rather than the committed file. */
function liveCounts() {
  const backup = join(mkdtempSync(join(tmpdir(), "inert-gate-")), "baseline.json");
  copyFileSync(BASELINE, backup);
  try {
    spawnSync(process.execPath, [SCRIPT, "--update-baseline"], { cwd: REPO_ROOT, encoding: "utf8" });
    return JSON.parse(readFileSync(BASELINE, "utf8"));
  } finally {
    copyFileSync(backup, BASELINE);
  }
}

/**
 * Swaps in a baseline derived from the LIVE counts, runs the gate, restores the real file.
 * Deriving from live counts is what keeps these cases independent of whatever the committed
 * baseline currently says.
 */
function withBaseline(mutate, fn) {
  const backup = join(mkdtempSync(join(tmpdir(), "inert-gate-")), "baseline.json");
  copyFileSync(BASELINE, backup);
  try {
    writeFileSync(BASELINE, JSON.stringify(mutate(liveCounts()), null, 2) + "\n");
    return fn();
  } finally {
    copyFileSync(backup, BASELINE);
  }
}

/*
FNXC:WorkflowResolvedColumns 2026-07-31-23:50:
DELIBERATELY NOT "the committed baseline matches the tree". That asserts a property of the REPO at a
moment, not of this gate, so it goes red whenever someone else lands an unrecorded change — which is
exactly what happened here: #3114 took `triage.ts` 7 -> 8 and my first version of this file failed for
a reason that has nothing to do with the code under test.

CI already runs the gate itself; a unit test that duplicates that check only adds a second, more
confusing way to learn the same thing. Every case below drives the gate against a baseline it
constructs, so they pass or fail on the gate's behaviour alone.
*/
test("a baseline that matches the tree exactly passes", () => {
  const result = withBaseline((baseline) => baseline, runGate);
  /* Constructed from the live counts rather than the committed file, so an unrelated unrecorded
     change elsewhere in the repo cannot turn this red. */
  assert.equal(result.status, 0, `gate should pass on a matching baseline:\n${result.stdout}${result.stderr}`);
});

test("an unrecorded DROP fails, so the allowance cannot stay stale-high", () => {
  const result = withBaseline(
    (baseline) => ({
      ...baseline,
      total: baseline.total + 2,
      byFile: Object.fromEntries(Object.entries(baseline.byFile).map(([f, n]) => [f, n + 2])),
    }),
    runGate,
  );

  assert.equal(result.status, 1, "a baseline higher than the real count must fail, not warn");
  /* The message has to name the fix, or the failure is just noise to whoever hits it. */
  assert.match(`${result.stdout}${result.stderr}`, /--update-baseline/);
});

test("a RISE still fails, and names the file it rose in", () => {
  /*
  FNXC:WorkflowResolvedColumns 2026-07-31-23:55:
  The expected filename is DERIVED, not written down. My first version asserted `scheduler.ts`, which
  #3128 then took to zero inert guards — so the case failed for a reason unrelated to the gate. The
  same coupling mistake as asserting the committed baseline matches the tree, one line lower.
  */
  const live = liveCounts();
  const [someFile] = Object.keys(live.byFile);
  const result = withBaseline(
    (baseline) => ({
      ...baseline,
      total: Math.max(0, baseline.total - 1),
      byFile: Object.fromEntries(Object.entries(baseline.byFile).map(([f, n]) => [f, Math.max(0, n - 1)])),
    }),
    runGate,
  );

  assert.equal(result.status, 1, "more inert conversions than the baseline must fail");
  assert.match(`${result.stdout}${result.stderr}`, new RegExp(someFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

/*
ANTI-VACUITY. The two cases above mutate the baseline, so they would both keep passing if the gate
stopped scanning any source at all and simply compared a number to itself. This asserts the scan
still finds the guards it is supposed to be counting.
*/
test("the gate is still actually scanning source, not just comparing numbers", () => {
  const result = runGate();
  assert.match(`${result.stdout}${result.stderr}`, /guard\(s\) consuming a sync-resolved lane/);
  assert.ok(JSON.parse(readFileSync(BASELINE, "utf8")).total > 0, "baseline should not be empty");
});

/*
FNXC:LifecycleColumnCensus 2026-07-31-23:59 (review finding on #3122):
WRAPPER TAINT IS EXACTLY ONE LEVEL, and these two cases pin both sides of that boundary.

The implementation recursed while its own comment said "One level, deliberately" — so the scope was
whatever the code happened to do. Measured at the time: both forms report the same 20 guards on this
tree, so recursion detected nothing and the contradiction was the only real defect.

One level is now the contract: a sync call as a DIRECT argument taints; a sync call nested inside
another wrapper does not. The second case is a deliberate, documented blind spot rather than an
accident — deeper nesting is where a wrapper is likelier to discard its argument, and a false positive
there would be absorbed into the baseline. If a real nested shape appears, widen it with a failing
case first.
*/
test("taints a wrapper whose DIRECT argument is a sync call", () => {
  const probe = join(REPO_ROOT, "packages/engine/src/__probe-inert-wrap1.ts");
  writeFileSync(probe, [
    `import { resolveTaskWorkflowIrSync } from "@fusion/core";`,
    `function localSync(store: unknown, id: string) { return resolveTaskWorkflowIrSync(store as never, id); }`,
    `function merge(a: unknown, b: unknown) { return (a ?? b) as { hold?: string }; }`,
    `export function probe(store: unknown, id: string, from: string): boolean {`,
    `  const lanes = merge(localSync(store, id), { hold: "todo" });`,
    `  return from !== lanes.hold;`,
    `}`,
    "",
  ].join("\n"));
  try {
    assert.equal(liveCounts().byFile["packages/engine/src/__probe-inert-wrap1.ts"], 1);
  } finally {
    rmSync(probe, { force: true });
  }
});

test("does NOT taint through a second wrapper level (documented blind spot)", () => {
  const probe = join(REPO_ROOT, "packages/engine/src/__probe-inert-wrap2.ts");
  writeFileSync(probe, [
    `import { resolveTaskWorkflowIrSync } from "@fusion/core";`,
    `function localSync(store: unknown, id: string) { return resolveTaskWorkflowIrSync(store as never, id); }`,
    `function inner(a: unknown) { return a as { hold?: string }; }`,
    `function outer(a: unknown) { return a as { hold?: string }; }`,
    `export function probe(store: unknown, id: string, from: string): boolean {`,
    `  const lanes = outer(inner(localSync(store, id)));`,
    `  return from !== lanes.hold;`,
    `}`,
    "",
  ].join("\n"));
  try {
    assert.equal(liveCounts().byFile["packages/engine/src/__probe-inert-wrap2.ts"] ?? 0, 0);
  } finally {
    rmSync(probe, { force: true });
  }
});
