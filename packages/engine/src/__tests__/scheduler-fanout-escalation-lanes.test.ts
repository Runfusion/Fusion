// @vitest-environment node
/*
FNXC:WorkflowLifecycleColumns 2026-07-31-11:10:

THE INVARIANT: the overlap-bottleneck warning ages a blocker using the board's OWN active lanes.

WIRING AN OPTION NOTHING FILLED. `computeBlockerFanoutMap`'s `escalationColumns` was added as an
optional resolved answer and its only production caller — `emitHighOverlapFanoutWarnings` — passed
nothing. On a renamed board `shouldEscalate` was false for every blocker, so a long-standing
bottleneck was reported as `temporary` forever.

The fan-out COUNT was correct throughout. That is what makes this quiet: the message names a real
problem and mis-states its age, so it reads as a fresh contention spike rather than a stuck card.

This is the class I audited my own merged work for after #2787's review — five conversions whose
production callers passed nothing — and this is the first of them wired. The test drives
`emitHighOverlapFanoutWarnings` through the real prototype rather than re-asserting
`computeBlockerFanoutMap`, because the defect was never in the map; it was in the caller.

REVERT PROOF, measured: stop passing `escalationColumns` and the renamed case below logs
`(temporary)` instead of `(long-lived)`.
*/
import { describe, expect, it, vi } from "vitest";
import type { Task, TaskStore } from "@fusion/core";

import { Scheduler } from "../scheduler.js";

const RENAMED_IR = {
  version: "v2", id: "wf-renamed", name: "renamed", nodes: [], edges: [],
  columns: [
    { id: "backlog", name: "Backlog", traits: [{ trait: "intake" }, { trait: "hold" }] },
    { id: "building", name: "Building", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
    { id: "signoff", name: "Sign-off", traits: [{ trait: "merge" }] },
    { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
  ],
};

const SIX_HOURS_AGO = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();

function card(id: string, column: string, extra: Record<string, unknown> = {}): Task {
  return {
    id, column, dependencies: [], steps: [], log: [], status: null,
    createdAt: SIX_HOURS_AGO, updatedAt: SIX_HOURS_AGO, columnMovedAt: SIX_HOURS_AGO, ...extra,
  } as unknown as Task;
}

function harness(blockerColumn: string, ir: unknown, holdColumn = "backlog") {
  const selection = { workflowId: "wf-renamed", stepIds: [] as string[] };
  const logged: string[] = [];
  const store = {
    logEntry: vi.fn(async (_id: string, message: string) => { logged.push(message); }),
    getTaskWorkflowSelection: () => (ir ? selection : undefined),
    getTaskWorkflowSelectionAsync: async () => (ir ? selection : undefined),
    getWorkflowDefinition: async () => (ir ? { ir } : undefined),
  } as unknown as TaskStore;

  const tasks: Task[] = [
    card("B", blockerColumn),
    ...[1, 2, 3, 4, 5].map((n) => card(`D${n}`, holdColumn, { blockedBy: "B" })),
  ];

  const self = { store, lastHighOverlapFanoutWarningKey: new Map<string, string>() };
  const run = () =>
    (Scheduler.prototype as unknown as {
      emitHighOverlapFanoutWarnings: (this: unknown, t: Task[]) => Promise<void>;
    }).emitHighOverlapFanoutWarnings.call(self, tasks);

  return { run, logged };
}

describe("the overlap-bottleneck warning ages blockers by resolved lane", () => {
  it("reports a stale blocker in a RENAMED wip lane as long-lived", async () => {
    // Pre-fix: `building` was in no literal set, so escalation never fired and this said "temporary".
    const { run, logged } = harness("building", RENAMED_IR);

    await run();

    expect(logged.join("\n")).toContain("(long-lived)");
  });

  it("still reports a blocker outside the active lanes as temporary", async () => {
    // The escalation must stay conditional — labelling everything long-lived is its own bug.
    const { run, logged } = harness("backlog", RENAMED_IR);

    await run();

    expect(logged.join("\n")).toContain("(temporary)");
  });

  it("keeps the legacy behaviour when no workflow resolves", async () => {
    /*
    The dependents must sit in the LEGACY hold column here. My first draft left them in `backlog`,
    so `overlapBlockedTodoCount` was zero, the threshold check skipped the blocker, and the case
    asserted a missing message rather than a legacy one — green for the wrong reason had the
    expectation been negative. Same shape as every other harness mistake in this sweep: the fixture
    has to match the branch under test.
    */
    const { run, logged } = harness("in-progress", undefined, "todo");

    await run();

    expect(logged.join("\n")).toContain("(long-lived)");
  });
});

/*
FNXC:WorkflowLifecycleColumns 2026-07-31-18:40:
The REVIEW half of the same call, wired after the escalation half — and found only by auditing the
flat-set class by hand, not by any guard.

`computeBlockerFanoutMap` feeds `reviewColumns` to `isStaleBlockedByBlocker`, which decides whether a
paused or retry-exhausted review blocker still counts as blocking its dependents. This call site
already passed `classify`, `escalationClassify` and `escalationColumns`; it did not pass this one, so
that half ran on the legacy `{in-review}` beside three resolved neighbours — the half-converted-pair
shape inside a call site I had converted twice already.

My own unwired-parameter guard is blind to it: `reviewColumns` is mentioned in `task-priority.ts`, so
the name reads as used. Recorded here and in the guard's header rather than quietly patched.

STRUCTURAL, and labelled: the consequence lives inside `isStaleBlockedByBlocker`'s classification of
a paused blocker, which this suite's harness does not construct. What is pinned is the WIRING — the
gap was that the argument was absent, not that the predicate was wrong.
*/
describe("the fan-out call forwards the resolved review lanes too", () => {
  it("passes reviewColumns alongside the escalation and classify answers", () => {
    const source = readFileSync(new URL("../scheduler.ts", import.meta.url), "utf8");

    expect(source).toContain("...(blockerReviewColumns.size > 0 ? { reviewColumns: blockerReviewColumns } : {}),");
    // Built from the same IR loop, so the two halves cannot resolve from different reads.
    expect(source).toContain('for (const id of columnsWithFlag(ir, "humanReview")) blockerReviewColumns.add(id);');
  });
});

import { readFileSync } from "node:fs";
