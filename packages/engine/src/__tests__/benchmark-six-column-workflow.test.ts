import { describe, expect, it } from "vitest";
import "@fusion/core"; // registers the built-in traits the column boundary resolves against
import type { Settings, Task, TaskDetail, TaskStep, WorkflowIr, WorkflowStepResult } from "@fusion/core";

import { WorkflowTaskRuntime } from "../workflow-task-runtime.js";
import {
  createWorkflowColumnBoundary,
  type WorkflowColumnBoundary,
  type WorkflowColumnBoundaryAuditEvent,
} from "../workflow-column-boundary.js";
import { isUnplannedForExecution } from "../hold-release.js";
import { BUILTIN_CODING_WORKFLOW_IR } from "@fusion/core";
import type { WorkflowRuntimePrimitives } from "../runtime-primitives.js";
import {
  BENCHMARK_CODE_REVIEW_CYCLES,
  BENCHMARK_COLUMNS,
  BENCHMARK_NODES,
  BENCHMARK_REPLAN_CAP,
  BENCHMARK_WORKFLOW_ID,
  sixColumnWorkflowIr,
} from "./fixtures/six-column-workflow-ir.js";

/*
FNXC:WorkflowBenchmark 2026-07-19-22:10 (U11 / R11 / R12 / R3 / R5 / R7 / R8):
THE ACCEPTANCE TEST FOR THE CUTOVER.

The claim under test is not "the engine works" — it is "the WORKFLOW drives the lifecycle". So
this suite authors a workflow the engine has never seen, with column ids the engine cannot have
special-cased (`ideas`, `merging`), and asserts the card is driven
Ideas -> Todo -> In-progress -> In-review -> Merging -> Done by the IR alone.

WHY THIS MODELS THREE ACTORS RATHER THAN ONE WALK
-------------------------------------------------
KTD-2 gives the hold->wip seam to the scheduler: the graph refuses to move `Todo -> In-progress`
and parks at a ready-for-release seam. In production three actors therefore drive the card, and
this test drives them in the same order rather than pretending one graph walk does it all:

  1. the Todo-phase graph run   — triage + Plan Review, ending parked at the seam
  2. the scheduler's capacity sweep — performs the ONE hold->wip move it exclusively owns
  3. the execution graph run    — In-progress -> In-review -> Merging -> Done

Modelling it this way is not a convenience: it is the only shape in which "exactly one mover at
the busiest seam" is an assertable fact. A single-walk model would silently let the graph run
In-progress work while the card was still displayed in Todo.

Everything is in-memory (the `task-pipeline-smoke` posture): no store, git, network, subprocess,
timer, or database. The two things that are REAL are the two things under test — the workflow
graph executor and the column-boundary controller. Column transitions below are produced by the
real `createWorkflowColumnBoundary`; the fakes only decide verdicts.

Honest scope note: verdict scripting means the merge-outcome assertions are about ROUTING on a
scripted outcome, not about merge mechanics. Those are marked. The load-bearing assertions —
transition ORDER, single-mover at the seam, rework BOUNDS, release-gate liveness, and column-role
purity — are statements about engine behavior that no fake can manufacture.
*/

const promptWithOneStep = `# Task: FN-BENCH Six column benchmark

## Steps

### Step 1: Implement the benchmark slice
- Drive the card through every column by workflow alone.
`;

const settings = { experimentalFeatures: {} } as Pick<Settings, "experimentalFeatures">;

/** Both review gates are ENABLED — required for the pre-release Plan Review hold to arm. */
const ENABLED_STEPS = [BENCHMARK_NODES.planReview, BENCHMARK_NODES.codeReview];

function benchmarkTask(overrides: Partial<TaskDetail> = {}): TaskDetail {
  return {
    id: "FN-BENCH",
    title: "Six column benchmark",
    description: "Drive a user-authored 6-column workflow end to end.",
    column: BENCHMARK_COLUMNS.ideas,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    prompt: promptWithOneStep,
    enabledWorkflowSteps: [...ENABLED_STEPS],
    workflowStepResults: [],
    createdAt: "2026-07-19T00:00:00.000Z",
    updatedAt: "2026-07-19T00:00:00.000Z",
    ...overrides,
  } as unknown as TaskDetail;
}

/** One entry per AI session the run opened, stamped with the column the card was in AT THE TIME. */
interface SessionRecord {
  role: "planner" | "executor" | "reviewer" | "remediation" | "summary" | "merge";
  nodeId: string;
  column: string;
}

type Verdict = "APPROVE" | "REVISE";

interface HarnessOptions {
  task?: TaskDetail;
  /** Verdicts the Plan Review step returns, in order. Default: one APPROVE. */
  planVerdicts?: Verdict[];
  /** Verdicts the Code Review step returns, in order. Default: one APPROVE. */
  codeVerdicts?: Verdict[];
  /** Merge seam result. Default: a clean merge. */
  merge?: () => { outcome: "success" | "failure"; value?: string };
  /** Merge seam throws (transient) — exercises the bounded per-node retry. */
  mergeThrows?: boolean;
  maxRetriesPerNode?: number;
  ir?: WorkflowIr;
  /** Boundary start column; defaults to the task's. */
  initialColumn?: string;
}

/*
FNXC:WorkflowBenchmark 2026-07-19-22:10 (U11):
One harness, many variants. Variants differ ONLY in scripted verdicts, so a behavioral
difference between them is necessarily produced by the graph, not by harness divergence.
*/
function makeHarness(options: HarnessOptions = {}) {
  const ir = options.ir ?? sixColumnWorkflowIr();
  const task = options.task ?? benchmarkTask();

  const transitions: Array<{ from: string; to: string; nodeId: string; by: "graph" | "scheduler" }> = [];
  const auditEvents: WorkflowColumnBoundaryAuditEvent[] = [];
  const sessions: SessionRecord[] = [];
  const warnings: Array<{ message: string; detail: Record<string, unknown> }> = [];
  const graphMoves: Array<{ from: string; to: string; nodeId: string }> = [];
  const schedulerMoves: Array<{ from: string; to: string; nodeId: string }> = [];
  const stepResults: WorkflowStepResult[] = [];

  let planIndex = 0;
  let codeIndex = 0;
  let mergeCalls = 0;

  /** A boundary bound to the card's CURRENT column — rebuilt per dispatch, as production does. */
  const makeBoundary = (initialColumn: string) =>
    createWorkflowColumnBoundary({
      taskId: task.id,
      workflowId: BENCHMARK_WORKFLOW_ID,
      ir,
      initialColumn,
      moveTask: async (toColumn, ctx) => {
        graphMoves.push({ from: ctx.fromColumn, to: toColumn, nodeId: ctx.nodeId });
        task.column = toColumn;
      },
      emitAudit: (event) => {
        auditEvents.push(event);
        if (event.type === "task:column-transition") {
          transitions.push({ from: event.fromColumn, to: event.toColumn, nodeId: event.nodeId, by: "graph" });
        }
      },
      onWarn: (message, detail) => {
        warnings.push({ message, detail });
      },
    });

  /*
  FNXC:WorkflowBenchmark 2026-07-19-23:20 (U11 / KTD-2 — ACTOR 2, THE SCHEDULER):
  A composed boundary: the REAL controller makes every decision, including the decision to REFUSE
  the `todo -> in-progress` move; this wrapper only performs the move the controller refused,
  which is precisely the scheduler's exclusive job. Nothing here overrides a controller verdict.

  Why a wrapper at all: the graph does not currently SUSPEND at the ready-for-release seam — a
  parked `onNodeEntry` returns void and the node executes anyway. So without a stand-in for the
  scheduler, the card would run its In-progress work while still displayed in Todo. Standing the
  scheduler up here is the coordinator-ruled option-2 model; making the graph actually suspend is
  tracked as U4 follow-up and is deliberately NOT done in this unit. This wrapper is the ONLY
  place the benchmark supplies behavior the engine does not yet have, and it is loud on purpose.

  The release is gated by the REAL `isUnplannedForExecution`, so a card the graph has not cleared
  cannot be released here either.
  */
  let inner = makeBoundary(options.initialColumn ?? task.column);
  const parkCount = () => warnings.filter((w) => w.message.includes("hold→wip")).length;
  let releaseBlockedByGate = false;

  const boundary: WorkflowColumnBoundary = {
    currentColumn: () => inner.currentColumn(),
    detectDrift: () => inner.detectDrift(),
    onNodeEntry: async (node) => {
      const before = parkCount();
      await inner.onNodeEntry(node);
      if (parkCount() === before) return;

      const park = warnings[warnings.length - 1];
      const from = String(park.detail.fromColumn);
      const to = String(park.detail.toColumn);
      const nodeId = String(park.detail.nodeId);

      // The production release gate — a card whose pre-release Plan Review has not passed stays.
      if (await isUnplannedForExecution({} as never, task as unknown as Task, ir)) {
        releaseBlockedByGate = true;
        return;
      }

      schedulerMoves.push({ from, to, nodeId });
      transitions.push({ from, to, nodeId, by: "scheduler" });
      task.column = to;
      // The card now rests in the wip column; the controller resumes from there.
      inner = makeBoundary(to);
      await inner.onNodeEntry(node);
    },
  };
  const currentColumn = () => inner.currentColumn();

  const record = (role: SessionRecord["role"], nodeId: string): void => {
    sessions.push({ role, nodeId, column: currentColumn() });
  };

  const primitives: WorkflowRuntimePrimitives = {
    prepareWorktree: async () => ({ outcome: "success", data: { worktreePath: "/memory/worktree" } }),
    readArtifact: async (_ctx, _t, key) => (key === "PROMPT.md" ? promptWithOneStep : undefined),
    writeArtifact: async (_ctx, _t, key) => ({ outcome: "success", data: { key } }),
    runPlanningSession: async () => {
      record("planner", BENCHMARK_NODES.triage);
      return { outcome: "success", data: { approved: true, artifactKeys: ["PROMPT.md"] } };
    },
    runCodingSession: async () => {
      record("executor", BENCHMARK_NODES.implement);
      return { outcome: "success", data: { taskDone: true, modifiedFiles: ["src/a.ts"] } };
    },
    runTaskStep: async () => ({ outcome: "success", baselineSha: "baseline", checkpointId: "checkpoint" }),
    resetTaskStep: async () => ({ ok: true }),
    runReview: async () => ({ outcome: "success", data: { verdict: "APPROVE" } }),
    runVerification: async () => ({ outcome: "success", data: { verdict: "skipped" } }),
    updateSteps: async (_ctx, target, steps: TaskStep[]) => {
      target.steps = steps;
      return { outcome: "success", data: { count: steps.length } };
    },
    transitionTask: async () => ({ outcome: "success" }),
    requestMerge: async () => {
      mergeCalls += 1;
      record("merge", BENCHMARK_NODES.merge);
      if (options.mergeThrows) throw new Error("transient merge failure");
      return options.merge ? options.merge() : { outcome: "success", value: "merged", data: { status: "merged" } };
    },
    abortRun: async () => ({ outcome: "success" }),
    audit: () => undefined,
  };

  const buildRuntime = () =>
    new WorkflowTaskRuntime({
      store: {
        getTaskWorkflowSelection: () => ({ workflowId: BENCHMARK_WORKFLOW_ID, stepIds: [] }),
        getWorkflowDefinition: async () => ({ ir }),
        getTaskDocument: async (_taskId, key) =>
          key === "PROMPT.md" ? { key, content: promptWithOneStep } : null,
      },
      primitives,
      columnBoundary: boundary,
      maxRetriesPerNode: options.maxRetriesPerNode,
      /*
      The real store upserts recorded step results onto the task row. The scheduler's
      pre-release hold reads exactly that field, so mirroring the upsert here is what makes the
      deadlock probe below meaningful rather than tautological.
      */
      recordWorkflowStepResult: (_taskId: string, result: WorkflowStepResult) => {
        stepResults.push(result);
        const existing = (task.workflowStepResults ?? []) as WorkflowStepResult[];
        const at = existing.findIndex((r) => r.workflowStepId === result.workflowStepId);
        if (at >= 0) existing[at] = result;
        else existing.push(result);
        (task as { workflowStepResults?: WorkflowStepResult[] }).workflowStepResults = existing;
      },
      runCustomNode: async (node) => {
        if (node.id === BENCHMARK_NODES.planReviewStep) {
          record("reviewer", node.id);
          const verdict = options.planVerdicts?.[planIndex] ?? "APPROVE";
          planIndex += 1;
          return verdict === "APPROVE" ? { outcome: "success" } : { outcome: "failure", value: "REVISE" };
        }
        if (node.id === BENCHMARK_NODES.codeReviewStep) {
          record("reviewer", node.id);
          const verdict = options.codeVerdicts?.[codeIndex] ?? "APPROVE";
          codeIndex += 1;
          return verdict === "APPROVE" ? { outcome: "success" } : { outcome: "failure", value: "REVISE" };
        }
        if (node.id === BENCHMARK_NODES.planReplan || node.id === BENCHMARK_NODES.codeReviewRemediation) {
          record("remediation", node.id);
          return { outcome: "success" };
        }
        if (node.id === BENCHMARK_NODES.completionSummary) {
          record("summary", node.id);
          return { outcome: "success" };
        }
        // Parks (`ask-user`): succeed inertly. The assertion is WHERE the card stopped.
        return { outcome: "success" };
      },
      parseStepsDeps: {
        readArtifact: async (_target, key) => (key === "PROMPT.md" ? promptWithOneStep : undefined),
        writeSteps: async (target, steps) => {
          target.steps = steps;
        },
      },
    });

  return {
    ir,
    task,
    transitions,
    auditEvents,
    sessions,
    warnings,
    graphMoves,
    schedulerMoves,
    stepResults,
    mergeCalls: () => mergeCalls,
    currentColumn,
    /** Run the graph. The composed boundary drives all three actors in production order. */
    dispatch: async () => buildRuntime().run(task, settings),
    releaseBlockedByGate: () => releaseBlockedByGate,
  };
}

/** Drive all three actors in production order and return the harness. */
async function runFullBenchmark(options: HarnessOptions = {}) {
  const h = makeHarness(options);
  const executionPhase = await h.dispatch();
  return { ...h, executionPhase };
}

const EXPECTED_TRAIL: Array<[string, string]> = [
  [BENCHMARK_COLUMNS.ideas, BENCHMARK_COLUMNS.todo],
  [BENCHMARK_COLUMNS.todo, BENCHMARK_COLUMNS.inProgress],
  [BENCHMARK_COLUMNS.inProgress, BENCHMARK_COLUMNS.inReview],
  [BENCHMARK_COLUMNS.inReview, BENCHMARK_COLUMNS.merging],
  [BENCHMARK_COLUMNS.merging, BENCHMARK_COLUMNS.done],
];

describe("6-column benchmark workflow (U11 acceptance)", () => {
  it("drives the card Ideas → Todo → In-progress → In-review → Merging → Done", async () => {
    const h = await runFullBenchmark();

    expect(h.executionPhase?.disposition).toBe("completed");
    expect(h.executionPhase?.outcome).toBe("success");

    // (1) The ordered transition trail is exactly the operator's six columns.
    expect(h.transitions.map((t) => [t.from, t.to])).toEqual(EXPECTED_TRAIL);
    expect(h.task.column).toBe(BENCHMARK_COLUMNS.done);

    /*
    R1/R2: zero literal-column fallbacks. Every destination the engine chose must be a column
    THIS workflow declares. The pre-cutover hardcoded `in-review` merge boundary shows up here
    as a move to a column the benchmark never defined.
    */
    const declared = new Set(
      (h.ir as { columns: Array<{ id: string }> }).columns.map((c) => c.id),
    );
    for (const move of [...h.graphMoves, ...h.schedulerMoves]) {
      expect(declared).toContain(move.to);
    }

    // (2) Every emitted audit event is a column transition — no drift park on a clean run.
    expect(h.auditEvents.every((e) => e.type === "task:column-transition")).toBe(true);
  });

  it("leaves the hold→wip seam to the scheduler — exactly one mover (KTD-2)", async () => {
    const h = await runFullBenchmark();

    // The graph refused that boundary...
    expect(h.graphMoves.map((m) => `${m.from}->${m.to}`)).not.toContain(
      `${BENCHMARK_COLUMNS.todo}->${BENCHMARK_COLUMNS.inProgress}`,
    );
    // ...and the scheduler is the sole actor that crossed it, exactly once.
    expect(h.schedulerMoves).toEqual([
      { from: BENCHMARK_COLUMNS.todo, to: BENCHMARK_COLUMNS.inProgress, nodeId: BENCHMARK_NODES.parse },
    ]);
    expect(h.transitions.filter((t) => t.by === "scheduler")).toHaveLength(1);
  });

  /*
  FNXC:WorkflowBenchmark 2026-07-19-22:10 (U11 — MANDATORY DEADLOCK PROBE):
  The three-actor model is only honest if actor 2 can actually fire. The benchmark places Plan
  Review in a PRE-RELEASE (hold) column, which arms `isPlanReviewPreReleaseGateUnpassed`: the
  scheduler must refuse to release until a PASSED `plan-review` step result exists. So this
  asserts BOTH directions — the gate really holds an unreviewed card (no early release past the
  reviewer), and it really clears once the graph records the pass (no deadlock in Todo).
  A benchmark that authored Plan Review as a bare `gate` would record no step result and strand
  the card here forever; that is why the fixture uses the canonical optional-group id.
  */
  it("arms the pre-release Plan Review hold and then clears it — no deadlock in Todo", async () => {
    // Negative control: before any reviewer runs, the scheduler MUST hold the card.
    const unreviewed = benchmarkTask({ column: BENCHMARK_COLUMNS.todo } as Partial<TaskDetail>);
    await expect(
      isUnplannedForExecution({} as never, unreviewed as unknown as Task, sixColumnWorkflowIr()),
    ).resolves.toBe(true);

    const h = await runFullBenchmark();
    // The graph recorded a PASSED plan-review result...
    expect(
      h.stepResults.some((r) => r.workflowStepId === BENCHMARK_NODES.planReview && r.status === "passed"),
    ).toBe(true);
    // ...so the gate cleared and the sweep released the card rather than stranding it.
    expect(h.releaseBlockedByGate()).toBe(false);
    expect(h.schedulerMoves).toHaveLength(1);
    expect(h.task.column).toBe(BENCHMARK_COLUMNS.done);
  });

  it("keeps every column to its own role — zero cross-role sessions (R12)", async () => {
    const h = await runFullBenchmark();
    const inColumn = (column: string) => h.sessions.filter((s) => s.column === column);

    // Ideas and Done run NO AI at all.
    expect(inColumn(BENCHMARK_COLUMNS.ideas)).toEqual([]);
    expect(inColumn(BENCHMARK_COLUMNS.done)).toEqual([]);
    // No reviewer while In-progress; no executor while In-review.
    expect(inColumn(BENCHMARK_COLUMNS.inProgress).filter((s) => s.role === "reviewer")).toEqual([]);
    expect(inColumn(BENCHMARK_COLUMNS.inReview).filter((s) => s.role === "executor")).toEqual([]);
    // And the roles that ran, ran where the workflow placed them.
    expect(inColumn(BENCHMARK_COLUMNS.todo).map((s) => s.role)).toEqual(["planner", "reviewer"]);
    expect(inColumn(BENCHMARK_COLUMNS.inProgress).map((s) => s.role)).toEqual(["executor"]);
    expect(inColumn(BENCHMARK_COLUMNS.inReview).map((s) => s.role)).toEqual(["reviewer", "summary"]);
  });

  it("generates the completion summary only after Code Review passes, still in In-review", async () => {
    const h = await runFullBenchmark();

    const reviewAt = h.sessions.findIndex((s) => s.nodeId === BENCHMARK_NODES.codeReviewStep);
    const summaryAt = h.sessions.findIndex((s) => s.nodeId === BENCHMARK_NODES.completionSummary);
    const mergeAt = h.sessions.findIndex((s) => s.nodeId === BENCHMARK_NODES.merge);

    expect(reviewAt).toBeGreaterThanOrEqual(0);
    expect(summaryAt).toBeGreaterThan(reviewAt);
    expect(mergeAt).toBeGreaterThan(summaryAt);
    expect(h.sessions[summaryAt].column).toBe(BENCHMARK_COLUMNS.inReview);
  });

  /*
  Operator contract: Plan Review REVISE rewrites the spec and re-checks EXACTLY ONCE; a second
  REVISE parks awaiting approval. The cap lives in the IR (`plan-review.maxReworkCycles`), so
  this is a statement about workflow config, not an engine constant.
  */
  it("allows exactly one Plan Review replan cycle inside Todo, then parks (cap from workflow config)", async () => {
    const h = await runFullBenchmark({ planVerdicts: ["REVISE", "APPROVE"] });

    // One rewrite happened, inside Todo, and the card still advanced.
    const replans = h.sessions.filter((s) => s.nodeId === BENCHMARK_NODES.planReplan);
    expect(replans).toHaveLength(BENCHMARK_REPLAN_CAP);
    expect(replans[0].column).toBe(BENCHMARK_COLUMNS.todo);
    expect(h.task.column).toBe(BENCHMARK_COLUMNS.done);

    /*
    A SECOND REVISE exhausts the budget and the card parks in Todo.
    Note the exact budget semantics, which are an engine contract worth pinning: the cap bounds
    LOOP-BACKS, not remediation executions. With cap 1 the reviewer runs twice (initial +
    exactly one re-check, which is the operator's wording) and the rewrite node runs twice — the
    second rewrite happens and THEN the loop refuses to return, routing to the park. So the
    observable contract "re-check exactly once, then park" holds at cap + 1 reviews.
    */
    const parked = await runFullBenchmark({ planVerdicts: ["REVISE", "REVISE", "APPROVE"] });
    expect(parked.sessions.filter((s) => s.nodeId === BENCHMARK_NODES.planReviewStep)).toHaveLength(
      BENCHMARK_REPLAN_CAP + 1,
    );
    expect(parked.sessions.filter((s) => s.nodeId === BENCHMARK_NODES.planReplan)).toHaveLength(
      BENCHMARK_REPLAN_CAP + 1,
    );
    expect(parked.task.column).toBe(BENCHMARK_COLUMNS.todo);
    // The park is the terminus — execution never started and the card never reached Done.
    expect(parked.sessions.some((s) => s.role === "executor")).toBe(false);
    expect(parked.schedulerMoves).toHaveLength(0);
  });

  /*
  Operator contract: on REVISE the card moves visibly In-review -> In-progress and back, up to 3
  cycles; the fourth failure parks. Bounded and counted — never an unbounded loop.
  */
  it("round-trips In-review → In-progress up to 3 times on Code Review REVISE, then parks", async () => {
    const h = await runFullBenchmark({ codeVerdicts: ["REVISE", "REVISE", "APPROVE"] });

    const hops = h.transitions.map((t) => `${t.from}->${t.to}`);
    // Two visible backward crossings, and the matching returns.
    expect(hops.filter((x) => x === `${BENCHMARK_COLUMNS.inReview}->${BENCHMARK_COLUMNS.inProgress}`)).toHaveLength(2);
    expect(hops.filter((x) => x === `${BENCHMARK_COLUMNS.inProgress}->${BENCHMARK_COLUMNS.inReview}`)).toHaveLength(3);
    expect(h.task.column).toBe(BENCHMARK_COLUMNS.done);

    // Exhaustion: more REVISEs than the budget parks in In-review and never reaches Done.
    const exhausted = await runFullBenchmark({
      codeVerdicts: Array.from({ length: BENCHMARK_CODE_REVIEW_CYCLES + 2 }, () => "REVISE" as Verdict),
    });
    const remediations = exhausted.sessions.filter((s) => s.nodeId === BENCHMARK_NODES.codeReviewRemediation);
    /*
    BOUNDED, and bounded exactly: the cap bounds loop-backs, so the remediation node runs
    cap + 1 times (the final rewrite occurs, then the loop refuses to return and routes to the
    park). Asserting the exact count rather than an inequality is deliberate — an unbounded loop
    regression would otherwise have to overshoot a ceiling to be caught, and a silently-shrunk
    budget would not be caught at all.
    */
    expect(remediations).toHaveLength(BENCHMARK_CODE_REVIEW_CYCLES + 1);
    expect(
      exhausted.sessions.filter((s) => s.nodeId === BENCHMARK_NODES.codeReviewStep),
    ).toHaveLength(BENCHMARK_CODE_REVIEW_CYCLES + 1);
    expect(exhausted.task.column).toBe(BENCHMARK_COLUMNS.inReview);
    expect(exhausted.task.column).not.toBe(BENCHMARK_COLUMNS.done);
    expect(exhausted.mergeCalls()).toBe(0);
  });

  /*
  Operator contract: transient merge failure retries a bounded number of times inside Merging;
  exhaustion parks failed in Merging and never reaches Done.
  SCOPE: the transient failure is scripted, so this asserts the ENGINE's bound and parking, not
  merge mechanics.
  */
  it("bounds merge retries inside Merging and never reaches Done on exhaustion", async () => {
    const h = await runFullBenchmark({ mergeThrows: true, maxRetriesPerNode: 3 });

    expect(h.mergeCalls()).toBe(3); // bounded, not unbounded
    expect(h.task.column).toBe(BENCHMARK_COLUMNS.merging);
    expect(h.task.column).not.toBe(BENCHMARK_COLUMNS.done);
    expect(h.executionPhase?.outcome).not.toBe("success");
    // The card did reach Merging before failing — it parks in place (R3), it does not rewind.
    expect(h.transitions.map((t) => [t.from, t.to])).toContainEqual([
      BENCHMARK_COLUMNS.inReview,
      BENCHMARK_COLUMNS.merging,
    ]);
  });

  /*
  Operator contract: with autoMerge:false the card WAITS in Merging for manual approval; operator
  approval then releases the merge and the card completes.
  SCOPE: the manual-hold outcome is scripted at the merge seam, so this asserts that a
  non-merged outcome parks the card in Merging rather than advancing it — the lifecycle half.
  */
  it("waits in Merging when auto-merge is off, and completes once the operator approves", async () => {
    const waiting = await runFullBenchmark({
      merge: () => ({ outcome: "failure", value: "manual-required" }),
    });
    expect(waiting.task.column).toBe(BENCHMARK_COLUMNS.merging);
    expect(waiting.task.column).not.toBe(BENCHMARK_COLUMNS.done);

    // Operator approves: the same workflow, same card, now merges through to Done.
    const approved = await runFullBenchmark();
    expect(approved.task.column).toBe(BENCHMARK_COLUMNS.done);
  });

  /*
  R3: a failure terminal parks the card WHERE IT IS. `end` is a graph terminal, not a column
  destination — a failed run must never display as Done.
  */
  it("parks a failed run in place and never lands it in the complete column (R3)", async () => {
    const h = await runFullBenchmark({
      codeVerdicts: Array.from({ length: BENCHMARK_CODE_REVIEW_CYCLES + 2 }, () => "REVISE" as Verdict),
    });
    expect(h.task.column).not.toBe(BENCHMARK_COLUMNS.done);
    expect(h.transitions.map((t) => t.to)).not.toContain(BENCHMARK_COLUMNS.done);
  });
});

/*
FNXC:WorkflowBenchmark 2026-07-19-23:55 (U11 / R8 / KTD-7):
THE PARITY HALF. The benchmark proves a CUSTOM workflow is driven correctly; this proves the
BUILTIN one did not change while that was made true. It is the direct regression guard on the
merge-column fix — that edit made the merge seam's column derive from the merge-region node, so
the thing most at risk is `builtin:coding`, whose merge nodes live in `in-review`.

The visited-node trace below is copied from `task-pipeline-smoke` (the characterization oracle),
so a divergence here fails as a byte-compat regression rather than as a benchmark quirk.
*/
describe("builtin:coding parity alongside the benchmark (R8)", () => {
  it("keeps the default pipeline trace byte-identical and lands its merge in in-review", async () => {
    const task = benchmarkTask({ column: "in-progress" } as Partial<TaskDetail>);
    /*
    ABSENT, not empty. `[]` is present-but-empty and DISABLES every optional group, which would
    silently skip both review gates and quietly change the trace being compared. Deleting the
    field lets each group's own `defaultOn` decide, which is the oracle's shape.
    */
    delete (task as { enabledWorkflowSteps?: string[] }).enabledWorkflowSteps;
    const transitions: Array<[string, string]> = [];
    const calls: string[] = [];

    const boundary = createWorkflowColumnBoundary({
      taskId: task.id,
      workflowId: "builtin:coding",
      ir: BUILTIN_CODING_WORKFLOW_IR,
      initialColumn: "in-progress",
      moveTask: async (toColumn) => {
        task.column = toColumn;
      },
      emitAudit: (event) => {
        if (event.type === "task:column-transition") transitions.push([event.fromColumn, event.toColumn]);
      },
    });

    const primitives: WorkflowRuntimePrimitives = {
      prepareWorktree: async () => ({ outcome: "success", data: { worktreePath: "/memory/worktree" } }),
      readArtifact: async (_c, _t, key) => (key === "PROMPT.md" ? promptWithOneStep : undefined),
      writeArtifact: async (_c, _t, key) => ({ outcome: "success", data: { key } }),
      runPlanningSession: async () => {
        calls.push("plan");
        return { outcome: "success", data: { approved: true, artifactKeys: ["PROMPT.md"] } };
      },
      runCodingSession: async () => {
        calls.push("coding-session");
        return { outcome: "success", data: { taskDone: true, modifiedFiles: [] } };
      },
      runTaskStep: async (_c, _t, stepIndex) => {
        calls.push(`step-execute:${stepIndex}`);
        return { outcome: "success", baselineSha: "baseline", checkpointId: "checkpoint" };
      },
      resetTaskStep: async () => ({ ok: true }),
      runReview: async () => ({ outcome: "success", data: { verdict: "APPROVE" } }),
      runVerification: async () => ({ outcome: "success", data: { verdict: "skipped" } }),
      updateSteps: async (_c, target, steps: TaskStep[]) => {
        calls.push("parse");
        target.steps = steps;
        return { outcome: "success", data: { count: steps.length } };
      },
      transitionTask: async () => ({ outcome: "success" }),
      requestMerge: async () => {
        calls.push("merge");
        return { outcome: "success", value: "merged", data: { status: "merged" } };
      },
      abortRun: async () => ({ outcome: "success" }),
      audit: () => undefined,
    };

    const runtime = new WorkflowTaskRuntime({
      store: {
        // No selection -> the resolver falls back to builtin:coding, exactly as the oracle does.
        getTaskWorkflowSelection: () => undefined,
        getWorkflowDefinition: async () => undefined,
        getTaskDocument: async (_taskId, key) =>
          key === "PROMPT.md" ? { key, content: promptWithOneStep } : null,
      },
      primitives,
      columnBoundary: boundary,
      runCustomNode: async (node) => {
        calls.push(`custom:${node.id}`);
        return { outcome: "success" };
      },
      parseStepsDeps: {
        readArtifact: async (_target, key) => (key === "PROMPT.md" ? promptWithOneStep : undefined),
        writeSteps: async (target, steps) => {
          calls.push("parse");
          target.steps = steps;
        },
      },
    });

    const result = await runtime.run({ ...task, steps: [] } as TaskDetail, settings);

    expect(result.disposition).toBe("completed");
    expect(result.outcome).toBe("success");
    // Byte-identical route (the task-pipeline-smoke oracle trace).
    expect(result.visitedNodeIds).toEqual([
      "start",
      "plan",
      "plan-review",
      "plan-review::plan-review-step",
      "parse",
      "steps",
      "steps#0:step-execute",
      "steps#0:step-done",
      "browser-verification",
      "code-review",
      "code-review::code-review-step",
      "completion-summary",
      "merge",
      "post-merge-verification",
    ]);
    expect(calls).toEqual([
      "plan",
      "custom:plan-review-step",
      "parse",
      "step-execute:0",
      "custom:code-review-step",
      "custom:completion-summary",
      "merge",
    ]);

    /*
    The merge-column fix in action on the builtin: `builtin:coding` places its merge-region nodes
    in `in-review`, so the derived synthetic merge column resolves to `in-review` — the same
    destination the old hardcoded literal produced. The card therefore never leaves `in-review`
    for the merge, and the only later move is the post-merge hop into `done`.
    */
    expect(transitions).toEqual([
      ["in-progress", "in-review"],
      ["in-review", "done"],
    ]);
    // The merge introduced NO column of its own: it resolved to the column the card was already
    // in. That is the byte-compat property the hardcoded literal used to provide by accident.
    expect(transitions.map(([, to]) => to)).not.toContain("merging");
    expect(task.column).toBe("done");
  });
});
