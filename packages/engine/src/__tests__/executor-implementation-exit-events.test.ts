/*
FNXC:WorkflowExecutionOwnership 2026-07-28-20:40 (U8 / R4, R5, R12 — workflow-owned lifecycle):

The execute seam tells the graph one bit: `result.taskDone`. The endings that bit cannot express
are exactly the ones the implementation phase transitions ITSELF — a session that paused after
the work was complete, and a session that stopped on a pending-review block. Both hand the card
to review inline; the graph then sees `taskDone === false`, reports `implementation-incomplete`,
and `handleGraphFailure` compensates with `alreadyFinalizedToReview`. Until now nothing anywhere
recorded which of those happened: an out-of-band transition and a genuine implementation failure
were indistinguishable in logs, in events, and in tests.

These tests pin the properties that make the exit signal safe to build the routing move on:

  1. Every exit the phase reports is forwarded with its own id, AND every id in the enum has a
     real call site in `runImplementation`. The second half is not pedantry: these tests stub
     `runImplementationPhase`, so without it deleting a `reportImplementationExit(...)` call
     leaves all of them green — verified by deleting one. A stubbed seam can only prove the seam.
  2. ROUTING IS UNCHANGED. For every exit the seam returns byte-identically what it returned
     before, so this PR cannot move a card. That is the property that lets the reporting and the
     routing land as separate, independently revertable changes.
  3. DROPPING EVERY SUBSCRIBER CHANGES NO OUTCOME (R5, and a named U8 scenario). An exit id is a
     reaction; if anything downstream ever depends on one arriving, the bus has quietly become a
     second source of truth, which is the failure mode this whole program exists to remove.
*/
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { Settings, Task } from "@fusion/core";
import {
  getWorkflowEventBus,
  resetWorkflowEventBusForTesting,
  type WorkflowLifecycleEvent,
} from "@fusion/core";
import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import { createMockStore, resetExecutorMocks } from "./executor-test-helpers.js";
import {
  OUT_OF_BAND_IMPLEMENTATION_EXITS,
  isOutOfBandImplementationExit,
  type ImplementationExit,
} from "../executor/implementation-exit.js";

const SEAM_TASK = { id: "FN-U8-EXIT", title: "exit vocabulary", column: "in-progress" } as Task;

/**
 * Drive the execute seam with a stubbed implementation phase. Stubbing the phase rather than
 * running a real agent session is the only way to exercise all six exits deterministically; the
 * exits themselves are wired at their real call sites in `runImplementation` and covered by the
 * completion/handoff suites.
 */
function seamHarness(phaseResult: { taskDone: boolean; modifiedFiles: string[]; exit?: ImplementationExit }) {
  const store = createMockStore();
  store.getTask.mockResolvedValue({ ...SEAM_TASK, paused: false });
  const executor = new TaskExecutor(store, "/tmp/test");
  const runImplementationPhase = vi
    .spyOn(executor as never as { runImplementationPhase: () => unknown }, "runImplementationPhase")
    .mockResolvedValue(phaseResult);
  const seams = executor.createAuthoritativeWorkflowSeams({} as Settings);
  return { executor, store, seams, runImplementationPhase };
}

function captureEvents(): { events: WorkflowLifecycleEvent[]; drain: () => Promise<void> } {
  const events: WorkflowLifecycleEvent[] = [];
  getWorkflowEventBus().subscribe((event) => { events.push(event); }, { name: "exit-test" });
  return { events, drain: () => getWorkflowEventBus().drain() };
}

/** Every exit, with the outcome/value the seam returned for it BEFORE this change. */
const EXITS: Array<{
  exit: ImplementationExit;
  taskDone: boolean;
  expected: { outcome: string; value: string };
}> = [
  { exit: "complete", taskDone: true, expected: { outcome: "success", value: "implemented" } },
  { exit: "complete-after-retry", taskDone: true, expected: { outcome: "success", value: "implemented" } },
  { exit: "complete-from-live-files", taskDone: true, expected: { outcome: "success", value: "implemented" } },
  { exit: "review-handoff-paused-after-completion", taskDone: false, expected: { outcome: "failure", value: "implementation-incomplete" } },
  { exit: "review-handoff-pending-review", taskDone: false, expected: { outcome: "failure", value: "implementation-incomplete" } },
];

describe("execute seam announces the implementation phase's exit", () => {
  beforeEach(() => {
    resetExecutorMocks();
    resetWorkflowEventBusForTesting();
  });
  afterEach(() => resetWorkflowEventBusForTesting());

  it.each(EXITS)("reports $exit on the lifecycle bus", async ({ exit, taskDone }) => {
    const { seams } = seamHarness({ taskDone, modifiedFiles: [], exit });
    const bus = captureEvents();

    await seams.execute!(SEAM_TASK, undefined);
    await bus.drain();

    const completed = bus.events.filter((e) => e.type === "NodeCompleted");
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({
      type: "NodeCompleted",
      taskId: SEAM_TASK.id,
      nodeId: "execute",
      outcome: taskDone ? "success" : "failure",
      exit,
    });
  });

  /*
  The property that makes this PR safe to land ahead of the routing move: naming an exit must not
  reroute anything. If any of these drift, a card is moving somewhere new and that belongs in the
  PR that adds the IR edge, not in this one.
  */
  it.each(EXITS)("returns the pre-existing routing outcome for $exit", async ({ exit, taskDone, expected }) => {
    const { seams } = seamHarness({ taskDone, modifiedFiles: [], exit });

    await expect(seams.execute!(SEAM_TASK, undefined)).resolves.toEqual(expected);
  });

  it("returns the same outcome when the phase reports no exit at all", async () => {
    /* The ~22 uninstrumented dispositions still report nothing; they must be unaffected. */
    const { seams } = seamHarness({ taskDone: false, modifiedFiles: [] });
    const bus = captureEvents();

    const outcome = await seams.execute!(SEAM_TASK, undefined);
    await bus.drain();

    expect(outcome).toEqual({ outcome: "failure", value: "implementation-incomplete" });
    const completed = bus.events.filter((e) => e.type === "NodeCompleted");
    expect(completed).toHaveLength(1);
    expect(completed[0]).not.toHaveProperty("exit");
  });

  /*
  R5, and a named U8 test scenario: "A dropped event subscriber changes no execution outcome
  (proves reactions are non-authoritative)."
  */
  it("produces identical outcomes with NO subscribers at all", async () => {
    for (const { exit, taskDone, expected } of EXITS) {
      resetWorkflowEventBusForTesting();
      const { seams } = seamHarness({ taskDone, modifiedFiles: [], exit });
      expect(getWorkflowEventBus().subscriberCount()).toBe(0);

      await expect(seams.execute!(SEAM_TASK, undefined)).resolves.toEqual(expected);
    }
  });

  it("is not derailed by a throwing subscriber", async () => {
    const { seams } = seamHarness({ taskDone: true, modifiedFiles: [], exit: "complete" });
    getWorkflowEventBus().subscribe(() => { throw new Error("subscriber blew up"); }, { name: "boom" });

    await expect(seams.execute!(SEAM_TASK, undefined)).resolves.toEqual({
      outcome: "success",
      value: "implemented",
    });
    await getWorkflowEventBus().drain();
  });

  /*
  FNXC:WorkflowExecutionOwnership 2026-07-28-21:05 (U8 / R12):
  The wiring ratchet. Everything above drives a STUBBED implementation phase, which is the only
  way to reach all six exits deterministically — but it means the real call sites are not
  exercised. Deleting `reportImplementationExit?.("review-handoff-pending-review")` from
  `runImplementation` left this whole file green (measured, not assumed), so the enum would have
  drifted into a vocabulary that describes endings nothing actually reports. This asserts each id
  is wired, and that the two out-of-band ids sit with the handoff they describe.
  */
  it("every exit id has a real call site in runImplementation", () => {
    /*
    FNXC:CodeOrganization 2026-08-03-16:20 (U4 runImplementation peel):
    Call sites live in executor/run-implementation.ts free function, not the thin facade.
    Scan the peel (deps.markCompletionFinalized / deps.handoffTaskToReview after transform).
    */
    const source = readFileSync(new URL("../executor/run-implementation.ts", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
    const ALL_EXITS: ImplementationExit[] = [
      "complete",
      "complete-after-retry",
      "complete-from-live-files",
      "review-handoff-paused-after-completion",
      "review-handoff-pending-review",
    ];
    const missing = ALL_EXITS.filter((exit) => !source.includes(`reportImplementationExit?.("${exit}")`));
    expect(missing).toEqual([]);
    /* Each out-of-band id must accompany an inline review handoff — that pairing IS its meaning. */
    for (const exit of OUT_OF_BAND_IMPLEMENTATION_EXITS) {
      const occurrences = [...source.matchAll(new RegExp(`reportImplementationExit\\?\\.\\("${exit}"\\)`, "g"))];
      expect(occurrences.length, `${exit} should be reported at every site that performs it`).toBeGreaterThan(0);
      for (const match of occurrences) {
        const idx = match.index ?? 0;
        /*
        FNXC:WorkflowExecutionOwnership 2026-07-30-10:25 (PR #2599 review — greptile):
        WINDOW-FREE. A fixed 400-character lookaround was wrong in both directions: an unrelated
        occurrence inside it let a missing marker pass, and harmless intervening instrumentation
        pushed a valid pairing out of range. Ordering is asserted by INDEX instead — the marker
        that precedes this report must be nearer to it than any earlier handoff is, which is what
        "this site's own marker" means, and the handoff must follow the report.
        */
        const markerIdx = Math.max(
          source.lastIndexOf("markCompletionFinalized(", idx),
          source.lastIndexOf("deps.markCompletionFinalized(", idx),
        );
        const priorHandoffIdx = Math.max(
          source.lastIndexOf("handoffTaskToReview(", idx),
          source.lastIndexOf("deps.handoffTaskToReview(", idx),
        );
        expect(markerIdx, `${exit} must set the durable completion-finalize marker before handing off`).toBeGreaterThan(-1);
        expect(
          markerIdx,
          `${exit}'s completion-finalize marker must belong to this site, not an earlier one`,
        ).toBeGreaterThan(priorHandoffIdx);
        const handoffAfter = (() => {
          const a = source.indexOf("handoffTaskToReview(", idx);
          const b = source.indexOf("deps.handoffTaskToReview(", idx);
          if (a === -1) return b;
          if (b === -1) return a;
          return Math.min(a, b);
        })();
        expect(
          handoffAfter,
          `${exit} must be followed by the review handoff it describes`,
        ).toBeGreaterThan(idx);
      }
    }
  });

  it("lists exactly the endings the implementation phase still transitions itself", () => {
    /*
    The ledger this unit closes: an out-of-band exit is one where the EXECUTOR moved the card.
    If a third appears without a routing move, U8 has gone backwards.
    */
    expect([...OUT_OF_BAND_IMPLEMENTATION_EXITS]).toEqual([
      "review-handoff-paused-after-completion",
    ]);
    expect(isOutOfBandImplementationExit("complete")).toBe(false);
    expect(isOutOfBandImplementationExit(undefined)).toBe(false);
  });
});
