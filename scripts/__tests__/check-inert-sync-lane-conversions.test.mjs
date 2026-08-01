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
FNXC:WorkflowResolvedColumns 2026-07-31-23:59:
THE INITIALIZER IS NOT ALWAYS THE CALL — the shape that evaded this gate, now pinned.

`syncLaneLocals` registered a local only when its initializer WAS a call expression, so the
payload-first/sync-fallback form slipped past entirely:

    const sync = payload ? undefined : localSync(store, id);
    return column === sync?.hold;          // inert, and counted as nothing

That matters more than the inline spelling the header already covers, because this shape is the one
authors are STEERED toward: falling back to the sync resolver is better than falling back to legacy
literals (it is best-effort under legacy SQLite; a literal can never be right on a renamed board), so
writing the guard well is what made it invisible. A ratchet that goes quiet exactly when the code
improves is worse than none.

Driven through a real file in the scanned tree rather than a unit call, because the bug was in which
nodes the scan VISITS — a helper-level assertion would have been written against the same wrong
mental model that produced the gap.

The two-hop form this case originally listed as an open gap — sync local -> object literal ->
comparison — is covered by the chained case below; the gap was closed in the same branch.
*/
test("counts a sync lane reached through a CONDITIONAL initializer, not just a direct call", () => {
  const probe = join(REPO_ROOT, "packages/engine/src/__probe-inert-conditional.ts");
  writeFileSync(probe, [
    `import { resolveTaskWorkflowIrSync } from "@fusion/core";`,
    `function localSync(store: unknown, id: string) { return resolveTaskWorkflowIrSync(store as never, id); }`,
    `export function probe(store: unknown, id: string, column: string, payload: { hold?: string } | undefined): boolean {`,
    `  const sync = payload ? undefined : localSync(store, id);`,
    `  return column === sync?.hold;`,
    `}`,
    "",
  ].join("\n"));
  try {
    const counts = liveCounts();
    assert.equal(
      counts.byFile["packages/engine/src/__probe-inert-conditional.ts"],
      1,
      "the conditional-initializer shape must be counted; before this fix the scan reported nothing for it",
    );
  } finally {
    rmSync(probe, { force: true });
  }
});

/*
FNXC:WorkflowResolvedColumns 2026-07-31-23:59:
THE SECOND HOP, which the case above explicitly left open.

A sync local laundered through an object literal reached the guards while the scan saw nothing:

    const sync  = payload ? undefined : localSync(store, id);
    const lanes = { hold: payload?.hold ?? sync?.hold ?? "todo" };
    if (from !== lanes.hold) …            // inert, counted as nothing

`executor.ts` is written exactly this way, and MEASURED it reported ZERO counted guards while the
sync resolver was still present and still answering with the default board whenever the payload is
absent. With the fix that file reports 2 — the two guards that genuinely remain after its dead
helper is deleted.

The chained case is in the probe on purpose: laundering can go `a -> b -> c`, and a single pass
would catch only the first link. That is the same one-pass mistake this file's earlier cases record,
made twice already in this scanner.
*/
test("counts a sync lane laundered through an object literal, including a chain", () => {
  const probe = join(REPO_ROOT, "packages/engine/src/__probe-inert-twohop.ts");
  writeFileSync(probe, [
    `import { resolveTaskWorkflowIrSync } from "@fusion/core";`,
    `function localSync(store: unknown, id: string) { return resolveTaskWorkflowIrSync(store as never, id); }`,
    `export function probe(store: unknown, id: string, from: string, payload: { hold?: string } | undefined): boolean {`,
    `  const sync = payload ? undefined : localSync(store, id);`,
    `  const lanes = { hold: payload?.hold ?? sync?.hold ?? "todo" };`,
    `  const relayed = { hold: lanes.hold };`,
    `  return from !== relayed.hold;`,
    `}`,
    "",
  ].join("\n"));
  try {
    const counts = liveCounts();
    assert.equal(
      counts.byFile["packages/engine/src/__probe-inert-twohop.ts"],
      1,
      "a sync lane rebuilt into an object (and relayed again) must still be counted",
    );
  } finally {
    rmSync(probe, { force: true });
  }
});

/*
FNXC:LifecycleColumnCensus 2026-07-31-23:59 (review finding on #3169):
A local named `$sync` could not be matched at all. The propagation step built `\b${name}\b` from raw
source text, so `$` was read as an ANCHOR and the pattern never fired — a laundered guard silently
uncounted, which is the exact failure this scanner exists to prevent. `_sync` is wrong for the
related reason that `\b` does not assert an identifier boundary next to `_`.

`$` is a legal and common identifier character, so this is a shape the codebase can produce today.
*/
test("matches a laundered sync local whose name contains regex metacharacters", () => {
  const probe = join(REPO_ROOT, "packages/engine/src/__probe-inert-dollar.ts");
  writeFileSync(probe, [
    `import { resolveTaskWorkflowIrSync } from "@fusion/core";`,
    `function localSync(store: unknown, id: string) { return resolveTaskWorkflowIrSync(store as never, id); }`,
    `export function probe(store: unknown, id: string, from: string, payload: { hold?: string } | undefined): boolean {`,
    `  const $sync = payload ? undefined : localSync(store, id);`,
    `  const lanes = { hold: payload?.hold ?? $sync?.hold ?? "todo" };`,
    `  return from !== lanes.hold;`,
    `}`,
    "",
  ].join("\n"));
  try {
    const counts = liveCounts();
    assert.equal(
      counts.byFile["packages/engine/src/__probe-inert-dollar.ts"],
      1,
      "a sync local named `$sync` must still be followed into the object it is laundered through",
    );
  } finally {
    rmSync(probe, { force: true });
  }
});

/*
FNXC:LifecycleColumnCensus 2026-07-31-23:59 (review finding on #3169 — OVER-approximation):
Propagation is PER PROPERTY, and these are the negative cases that prove it.

Marking a whole object sync-derived because its text mentioned a local counted guards that read a
sibling LITERAL (`{ hold: sync?.hold, review: "todo" }` made `lanes.review` inert) and matched a
local's NAME appearing as a KEY (`{ sync: "todo" }`) without anything reading it.

Over-counting is not the safe direction for this gate. It inflates the baseline — so the allowance
absorbs real inert conversions later — and it trains readers to skip the report, which this
program's learnings record as exactly how the next genuine finding gets missed.
*/
test("does NOT count a sibling literal in an object that also carries a sync lane", () => {
  const probe = join(REPO_ROOT, "packages/engine/src/__probe-inert-mixed.ts");
  writeFileSync(probe, [
    `import { resolveTaskWorkflowIrSync } from "@fusion/core";`,
    `function localSync(store: unknown, id: string) { return resolveTaskWorkflowIrSync(store as never, id); }`,
    `export function probe(store: unknown, id: string, from: string, payload: { hold?: string } | undefined): boolean {`,
    `  const sync = payload ? undefined : localSync(store, id);`,
    `  const lanes = { hold: payload?.hold ?? sync?.hold ?? "todo", review: "in-review" };`,
    `  return from !== lanes.review;`,
    `}`,
    "",
  ].join("\n"));
  try {
    /* `lanes.hold` IS sync-derived, but nothing reads it here; the only guard reads `lanes.review`,
       which is a literal. So the file must contribute nothing. */
    assert.equal(liveCounts().byFile["packages/engine/src/__probe-inert-mixed.ts"] ?? 0, 0);
  } finally {
    rmSync(probe, { force: true });
  }
});

test("does NOT count an object whose KEY merely shares a sync local's name", () => {
  const probe = join(REPO_ROOT, "packages/engine/src/__probe-inert-keyname.ts");
  writeFileSync(probe, [
    `import { resolveTaskWorkflowIrSync } from "@fusion/core";`,
    `function localSync(store: unknown, id: string) { return resolveTaskWorkflowIrSync(store as never, id); }`,
    `export function probe(store: unknown, id: string, from: string, payload: { hold?: string } | undefined): boolean {`,
    `  const sync = payload ? undefined : localSync(store, id);`,
    `  void sync;`,
    `  const lanes = { sync: "todo", hold: "todo" };`,
    `  return from !== lanes.hold;`,
    `}`,
    "",
  ].join("\n"));
  try {
    assert.equal(liveCounts().byFile["packages/engine/src/__probe-inert-keyname.ts"] ?? 0, 0);
  } finally {
    rmSync(probe, { force: true });
  }
});
