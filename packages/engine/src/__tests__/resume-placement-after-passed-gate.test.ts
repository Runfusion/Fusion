/*
FNXC:ResumePlacement 2026-11-01-17:40, restructured 2026-11-01-20:20 (RUFU-300):
SYMPTOM VERIFICATION for "resume a run AFTER a passed gate".

Live instance RUFU-292 carried exactly one `workflowStepResults` row — `plan-review`,
`status: "passed"`, `verdict: "APPROVE_WITH_NOTES"` — while `column: "todo"`, its pin said
`workflowIrPinNodeId: "parse"` / `workflowIrPinColumnId: "in-progress"`, its 9 parsed steps all
stayed `pending` with `currentStep: 0`, and `updatedAt` moved for ~6h33m with ZERO new
`agent-log.jsonl` lines (i.e. no agent session ever started).

These legs assert the outcome at the seams that actually own each half (KTD-2 — the graph records the
ready-for-release seam; `hold-release.ts` is the sole hold→wip mover), on the harness this repo already
owns. No real AI, no real worktree, no real network, no timers. The release half of the chain lives in
`hold-release-resume-after-released-gate.test.ts`.
*/
import { describe, expect, it } from "vitest";
import {
  resetResumePlacementEpisodeForTesting,
  type ResumePlacementSinks,
} from "../workflows/resume-placement.js";
import {
  codingIr,
  PINNED_STEPS,
  rufu292Task,
  settingsOn,
  wiredHarness,
} from "./fixtures/resume-placement-harness.js";
import { WorkflowGraphExecutor } from "../workflows/workflow-graph-executor.js";
import { recordingPrimitives, parseStepsDeps } from "./fixtures/resume-placement-harness.js";

describe("RUFU-300 (a) — a released gate is never replayed by an automatic re-entry", () => {
  it("resumes a card parked at `parse` without re-entering the planning prologue", async () => {
    const calls: string[] = [];
    const executor = new WorkflowGraphExecutor({
      primitives: recordingPrimitives(calls),
      parseStepsDeps: parseStepsDeps(),
    } as never);

    // The continuation-reclaim shape: the durable work item names `parse`.
    const result = await executor.run(rufu292Task(), settingsOn(), codingIr, "parse");

    expect(result.visitedNodeIds[0]).toBe("parse");
    expect(result.visitedNodeIds).not.toContain("start");
    expect(result.visitedNodeIds).not.toContain("plan");
    expect(result.visitedNodeIds).not.toContain("plan-review");
    expect(calls).not.toContain("plan");
    expect(calls).not.toContain("review");
  });

  it("resumes a continuation-LESS run after the released gate instead of re-running the prologue", async () => {
    const calls: string[] = [];
    const executor = new WorkflowGraphExecutor({
      primitives: recordingPrimitives(calls),
      parseStepsDeps: parseStepsDeps(),
    } as never);

    // No continuation node id: the column-contract fallback path, which before this change answered
    // `start` and replayed the whole planning prologue behind a gate that had already passed.
    const result = await executor.run(rufu292Task(), settingsOn(), codingIr);

    /*
     * In the shipped coding IR `plan-review` sits BETWEEN `plan` and `parse`
     * (`planReviewOptionalGroupNode("todo")` + `{ from: "plan-review", to: "parse", condition:
     * "success" }`), so `parse` is the REQUIRED placement for this shape — the invariant is that
     * the released gate and the planning prologue are never visited, not that `parse` is avoided.
     */
    expect(result.visitedNodeIds[0]).toBe("parse");
    expect(result.visitedNodeIds).not.toContain("start");
    expect(result.visitedNodeIds).not.toContain("plan");
    expect(result.visitedNodeIds).not.toContain("plan-review");
    expect(calls).not.toContain("plan");
    expect(calls).not.toContain("review");
  });

  it("records on the card WHY the released gate did not run, and says it once per placement", async () => {
    /*
     * Before RUFU-300 the graph entered the released gate and its per-node pre-merge gate wrote
     * `[pre-merge] Workflow step already satisfied: <name>`. Placement now skips the node entirely, so
     * the skip has to be written where it happens or "why didn't Plan Review run?" stops being
     * answerable from the card — the observability this change must not trade away for correctness.
     */
    resetResumePlacementEpisodeForTesting();
    const logs: string[] = [];
    const sinks = { logEntry: async (_id: string, message: string) => { logs.push(message); } };

    await wiredHarness(rufu292Task(), { resumePlacementSinks: sinks })
      .executor.run(rufu292Task(), settingsOn(), codingIr);
    const skips = logs.filter((line) => line.includes("resume skipped released gate(s)"));
    expect(skips).toHaveLength(1);
    expect(skips[0]).toContain("plan-review");
    expect(skips[0]).toContain("[workflow-graph]");

    // A resume into the same placement is the same fact: the second pass must not re-announce it.
    await wiredHarness(rufu292Task(), { resumePlacementSinks: sinks })
      .executor.run(rufu292Task(), settingsOn(), codingIr);
    expect(logs.filter((line) => line.includes("resume skipped released gate(s)"))).toHaveLength(1);
  });

  it("still runs the planning prologue for a card with NO released-gate evidence (control)", async () => {
    const calls: string[] = [];
    const executor = new WorkflowGraphExecutor({
      primitives: recordingPrimitives(calls),
      parseStepsDeps: parseStepsDeps(),
    } as never);

    const unplanned = rufu292Task({
      workflowStepResults: [],
      workflowIrPin: undefined,
      workflowIrPinNodeId: undefined,
      workflowIrPinColumnId: undefined,
    });
    const result = await executor.run(unplanned, settingsOn(), codingIr);

    // The non-vacuous control: the prologue runs when nothing released it. Placement never advances a
    // card that has no released-gate or pin evidence.
    expect(result.visitedNodeIds[0]).toBe("start");
    expect(result.visitedNodeIds).toContain("plan");
  });
});

describe("RUFU-300 (b-1) — the graph parks AT the release seam and moves nothing (KTD-2)", () => {
  it("returns the ready-for-release suspension with ZERO graph column moves", async () => {
    const h = wiredHarness(rufu292Task());

    const result = await h.executor.run(rufu292Task(), settingsOn(), codingIr);

    expect(result.suspended).toMatchObject({
      /*
      FNXC:RunAuditCapacityDiagnostic 2026-11-03-15:15 (RUFU-300 merge repair):
      RUFU-372's second slice split the one `capacity` word into `capacity` (a transient pool refusal)
      versus `scheduler-owned-seam` (a structural hold→wip crossing only the release sweep may make).
      This leg pins the SEAM park, so it names the seam. The release contract this task depends on is
      unchanged: the continuation's `waitReason` stays `capacity`, so `hold-release` still moves the card.
      */
      reason: "scheduler-owned-seam",
      nodeId: "parse",
      fromColumn: "todo",
      toColumn: "in-progress",
      source: "scheduler-seam",
    });
    // KTD-2: the graph records the seam and never crosses it.
    expect(h.moves).toHaveLength(0);
    expect(h.audit.filter((event) => event.type === "task:column-transition")).toHaveLength(0);
    // The released gate and its prologue are not reached on the way to the seam.
    expect(result.visitedNodeIds).not.toContain("start");
    expect(result.visitedNodeIds).not.toContain("plan");
    expect(result.visitedNodeIds).not.toContain("plan-review");
    expect(h.calls).not.toContain("plan");
    expect(h.calls).not.toContain("review");
    // The pin already names the seam — it is the seam's evidence, not a bug to clear.
    expect(h.pins.at(-1)).toMatchObject({ nodeId: "parse", columnId: "in-progress" });
  });

  it("preserves the parsed step ledger across the re-entry (no re-parse, no re-zero)", async () => {
    const h = wiredHarness(rufu292Task());
    const task = rufu292Task();

    await h.executor.run(task, settingsOn(), codingIr);

    expect(task.steps).toHaveLength(9);
    expect(task.steps.map((step) => step.status)).toEqual(PINNED_STEPS.map((step) => step.status));
    expect(task.currentStep).toBe(0);
  });
});

/*
FNXC:ResumePlacement 2026-11-01-19:55 (RUFU-300):
The other half of "never reset durable progress", measured on the runner rather than on the resolver.
`parse-steps` rebuilds every step as `{ name, status: "pending" }` and the production write seam
patches `steps` wholesale, so a re-entry that lands a progressed card back on `parse` silently rolls
finished work back. This is the shape a continuation-less re-dispatch after a checkout reclaim actually
arrives in, which is why the guard belongs to placement and not to a retry path.
*/
describe("RUFU-300 (b-4) — a re-entry never rolls a progressed ledger back", () => {
  it("resumes a progressed card at the step region without entering the ledger-rewriting node", async () => {
    const task = rufu292Task();
    task.steps = PINNED_STEPS.map((step, index) => ({
      ...step,
      status: index < 3 ? "done" as const : "pending" as const,
    }));
    task.currentStep = 3;
    const h = wiredHarness(task, { initialColumn: "in-progress" });

    const result = await h.executor.run(task, settingsOn(), codingIr);

    expect(result.visitedNodeIds).not.toContain("parse");
    expect(result.visitedNodeIds).not.toContain("plan-review");
    expect(result.visitedNodeIds).toContain("steps#3:step-execute");
    expect(task.steps).toHaveLength(PINNED_STEPS.length);
    expect(task.steps.slice(0, 3).every((step) => step.status === "done")).toBe(true);
    expect(task.currentStep).toBe(3);
  });

  it("still enters `parse` for an untouched ledger — the guard refines placement, it does not skip parsing", async () => {
    const task = rufu292Task();
    const h = wiredHarness(task, { initialColumn: "in-progress" });

    const result = await h.executor.run(task, settingsOn(), codingIr);

    expect(result.visitedNodeIds[0]).toBe("parse");
    expect(result.visitedNodeIds).toContain("steps");
  });
});

describe("RUFU-300 (c) — silent churn is impossible", () => {
  it("announces a repeated re-entry that changed no durable state, at most once per episode", async () => {
    resetResumePlacementEpisodeForTesting();
    const logs: Array<[string, string]> = [];
    const audits: Array<Record<string, unknown>> = [];
    const sinks: ResumePlacementSinks = {
      logEntry: async (id: string, message: string) => { logs.push([id, message]); },
      emitAudit: (event) => { audits.push(event as unknown as Record<string, unknown>); },
    };
    const task = rufu292Task();
    const makeExecutor = () => wiredHarness(task, { resumePlacementSinks: sinks }).executor;

    /*
     * Pass 1 is the pass that must not be silent. RUFU-292's `updatedAt` moved for ~6h33m with ZERO
     * new `agent-log.jsonl` lines precisely because the seam-park shape looked legal and was therefore
     * recorded nowhere: the ABSENCE of any row is the defect this leg guards.
     */
    const first = await makeExecutor().run(rufu292Task(), settingsOn(), codingIr);
    expect(first.suspended?.nodeId).toBe("parse");
    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0]![1]).toContain("[workflow-graph]");
    expect(audits.length).toBeGreaterThan(0);
    // The seeded disagreement is the LEGAL seam park, so it announces as one, never as incoherence.
    expect(audits[0]).toMatchObject({
      mutationType: "task:resume-placement-mismatch",
      mismatchKind: "pin-at-release-seam",
      outcome: "awaiting-scheduler-release",
    });

    /*
     * Passes 2 and 3 start from the SAME durable state the previous pass left behind (the third differs
     * only in `updatedAt`, which is not durable progress). Neither may add a row: that bound is what
     * keeps the notice from dying the way an unbounded per-poll announcement would.
     */
    const afterFirst = logs.length + audits.length;
    const afterFirstAudits = audits.length;
    await makeExecutor().run(rufu292Task(), settingsOn(), codingIr);
    await makeExecutor().run(rufu292Task({ updatedAt: new Date().toISOString() }), settingsOn(), codingIr);
    expect(logs.length + audits.length).toBe(afterFirst);

    // The bound is per EPISODE, not per card forever: a genuinely different wedge must announce.
    await makeExecutor().run(
      rufu292Task({ workflowIrPinColumnId: "in-review", workflowIrPinNodeId: "browser-verification" }),
      settingsOn(),
      codingIr,
    );
    expect(audits.length).toBeGreaterThan(afterFirstAudits);
    expect(audits.at(-1)).toMatchObject({ mismatchKind: "pin-ahead-of-column", outcome: "announced" });

    /*
     * The metadata contract (AGENTS.md): ids and fixed enums only. A task id IS permitted; what must
     * never reach run-audit is the card's own content — the verdict text and the prompt body.
     */
    for (const row of audits) {
      for (const value of Object.values(row)) {
        if (typeof value !== "string") continue;
        expect(value).not.toContain("APPROVE_WITH_NOTES");
        expect(value).not.toContain("### Step");
      }
    }
  });
});
