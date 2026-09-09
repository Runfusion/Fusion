/*
FNXC:WorkflowLifecycleColumns 2026-08-02-18:45 (fleet: the pure lifecycle predicates):

THE INVARIANT: a pure predicate answers with the lanes its CALLER resolved, and keeps the legacy ids when the
caller supplies none.

Three of these have a failure mode worth naming separately, because none of them errors:

  - `getTaskAgeStalenessSignal` returned `undefined` for every card, so **age-staleness silently reported
    nothing**. A monitoring signal that goes quiet is indistinguishable from health — the board looks fine
    while cards sit for days.
  - `isStaleBlockedByBlocker` answered "not stale" for a blocker that was finished, paused in review, or
    permanently failed, so the blocked card **waited forever** with no signal.
  - `areAllDependenciesDone` is the third place "satisfied" is asked; it now gives the same answer as the
    store's `blockedBy` computation (#2720) and the merge blocker. Three surfaces, one rule.

THE OPTIONAL PARAMETER IS THE DESIGN, and both halves are asserted for each: supplying lanes makes a renamed
board work, omitting them preserves every existing caller. A required parameter would have compiled
everywhere and then answered "not active" / "not stale" / "not satisfied" for everything — the silent
direction, and the one a type checker cannot catch.
*/
import { describe, expect, it } from "vitest";
import type { Task } from "../types.js";

import { getTaskAgeStalenessSignal } from "../tasks/task-age-staleness.js";
import { isStaleBlockedByBlocker } from "../tasks/blocker-fanout.js";

function task(overrides: Partial<Task>): Task {
  return {
    id: "FN-1", column: "building", dependencies: [], steps: [], currentStep: 0,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    columnMovedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as unknown as Task;
}

const NOW = Date.parse("2026-01-08T00:00:00.000Z"); // a week later — well past any threshold

/*
FNXC:WorkflowLifecycleColumns 2026-08-02-21:30 (rebase onto #2746 — another worker landed the same fix):
THE CONTEXT SHAPE IS THEIRS, not mine. #2746 converted `task-age-staleness.ts` while this PR was open, with a
`lifecycle: { wip, review }` context field where I had used two flat fields. Theirs is on main and is the better
shape — one field for one resolved struct, so a third lane cannot arrive as a third parameter — so my
conversion of that file is dropped and these cases were rewritten against their API.

Kept rather than deleted: the cases assert the INVARIANT (a renamed board produces a signal; a card outside the
active lanes does not; omitting lanes keeps the legacy ids), and #2746 has no case for the third of those.
*/
describe("age staleness follows the caller's active lanes", () => {
  it("produces a signal for a renamed WIP lane", () => {
    // Pre-fix: `building` matched neither literal, so the signal was undefined and the board looked healthy.
    const signal = getTaskAgeStalenessSignal(task({ column: "building" }), {
      now: NOW,
      lifecycle: { wip: "building", review: "signoff" },
    });

    expect(signal).toBeDefined();
  });

  it("produces a signal for a renamed REVIEW lane", () => {
    expect(getTaskAgeStalenessSignal(task({ column: "signoff" }), {
      now: NOW, lifecycle: { wip: "building", review: "signoff" },
    })).toBeDefined();
  });

  it("stays silent for a card in neither active lane", () => {
    // The paired negative: intake and terminal cards have no age-staleness signal by design.
    expect(getTaskAgeStalenessSignal(task({ column: "backlog" }), {
      now: NOW, lifecycle: { wip: "building", review: "signoff" },
    })).toBeUndefined();
  });

  it("keeps the LEGACY lanes when the caller supplies none", () => {
    expect(getTaskAgeStalenessSignal(task({ column: "in-progress" }), { now: NOW })).toBeDefined();
    expect(getTaskAgeStalenessSignal(task({ column: "in-review" }), { now: NOW })).toBeDefined();
    // And a renamed lane is NOT recognised without them — which is why the board list wires a resolver.
    expect(getTaskAgeStalenessSignal(task({ column: "building" }), { now: NOW })).toBeUndefined();
  });
});

describe("blocker staleness follows the caller's lanes", () => {
  const lanes = { terminal: new Set(["shipped"]), review: new Set(["signoff"]) };

  it("treats a blocker in the board's COMPLETE lane as stale", () => {
    // Pre-fix: the blocked card kept waiting on a finished blocker, forever, with no signal.
    expect(isStaleBlockedByBlocker(task({ column: "shipped" }), 3, lanes)).toBe(true);
  });

  it("treats a PAUSED blocker in the board's review lane as stale", () => {
    expect(isStaleBlockedByBlocker(task({ column: "signoff", paused: true }), 3, lanes)).toBe(true);
  });

  it("treats a retry-exhausted review blocker as stale", () => {
    expect(isStaleBlockedByBlocker(
      task({ column: "signoff", status: "failed", mergeRetries: 5 }), 3, lanes,
    )).toBe(true);
  });

  it("does NOT treat a healthy blocker as stale", () => {
    // The paired negative: a live blocker must still block.
    expect(isStaleBlockedByBlocker(task({ column: "building" }), 3, lanes)).toBe(false);
    expect(isStaleBlockedByBlocker(task({ column: "signoff" }), 3, lanes)).toBe(false);
  });

  it("keeps the built-in Done id when the caller supplies no lanes", () => {
    expect(isStaleBlockedByBlocker(task({ column: "done" }), 3)).toBe(true);
    expect(isStaleBlockedByBlocker(task({ column: "shipped" }), 3)).toBe(false);
  });
});

/*
FNXC:WorkflowLifecycleColumns 2026-08-02-20:55 (PR #2745 review — greptile P1 x2, and the shape is worth its
own name):

A CAPABILITY WITH NO CALLER IS A HALF-CONVERSION TOO.

Both findings were the same: I added the optional lane parameters and did not wire the production callers. The
census would have shown converted sites and a renamed board would have behaved exactly as before — a branch-
group task depending on a card that landed in a workflow-specific complete lane stayed excluded from dispatch,
and a review row stranded by a missing-worktree session start stayed parked for a human.

That is not the familiar direction (a gate reading the wrong board); it is the parameter existing and nobody
passing it. It cannot be caught by testing the predicate — the predicate is correct — so this asserts the
CALL SITES, which is the same reason #2728's classifier needed a structural case.
*/
describe("the production callers actually supply the lanes", () => {
  it("branch-group dispatch resolves a satisfied set and passes it", async () => {
    const { readFile } = await import("node:fs/promises");
    const code = (await readFile(new URL("../task-store/branch-group-ops.ts", import.meta.url), "utf8"))
      .replace(/\/\*[\s\S]*?\*\//g, "");

    // It must RESOLVE lanes, not merely accept a parameter…
    expect(code).toContain("resolveTaskLifecycleColumns");
    // …and every areAllDependenciesDone call must pass the set it resolved.
    const calls = [...code.matchAll(/areAllDependenciesDone\(([^)]*)\)/g)];
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call[1], "areAllDependenciesDone called without satisfiedColumns").toContain("satisfiedColumns");
    }
  });

  it("the missing-worktree recovery sweep passes a resolved review set to all three classifiers", async () => {
    const { readFile } = await import("node:fs/promises");
    const code = (await readFile(new URL("../../../engine/src/self-healing.ts", import.meta.url), "utf8"))
      .replace(/\/\*[\s\S]*?\*\//g, "");

    /*
    All three classifiers, by name: converting the sweep's admission and leaving the merge-active
    classification on the legacy id would make the stage/audit labels disagree with the admission — which is
    the defect one level down from the one the reviewer found.
    */
    for (const name of [
      "isRecoverableMissingWorktreeReviewFailureWithProgress",
      "isRecoverableMissingWorktreeReviewFailureNoProgress",
      "isMergeActiveMissingWorktreeSessionStartFailure",
    ]) {
      const call = code.match(new RegExp(`${name}\\(([^)]*)\\)`));
      expect(call, `${name} is not called in self-healing`).toBeTruthy();
      expect(call?.[1], `${name} called without a resolved review set`).toContain("reviewColumns");
    }
  });
});
