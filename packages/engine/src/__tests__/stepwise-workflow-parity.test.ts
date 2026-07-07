// ─────────────────────────────────────────────────────────────────────────────
// PARITY SUBJECT (test-file ownership, U7 / KTD-9):
//   This suite owns the STEPWISE PER-STEP parity + invariant coverage: it compares
//   the `updateStep` TRAJECTORY and the MERGE-BLOCKER WINDOWS of the legacy
//   step-session path against the inverted stepwise foreach graph driven by the
//   built-in `builtin:stepwise-coding` IR.
//
//   The legacy step-session path (runStepsInNewSessions ON) is the deterministic
//   per-step ORACLE here — the agent-paced monolithic path is NOT deterministically
//   comparable (see plan U7) and stays covered by the default-workflow byte-identity
//   suite `workflow-graph-executor-parity.test.ts`. Both paths in this file are
//   driven by the SAME scripted reviewer/seams so the only variable is the path.
//
//   The graph side wires the REAL substrate seams (`runTaskStep`,
//   `resetStepToBaseline`, `makeAncestryBlastRadiusGuard`) exactly as the executor
//   does (executor.ts createGraphSeams / applyGraphRethinkReset), against a fake
//   store that records the projection trajectory — so the comparison exercises the
//   production reset/blast-radius/projection code, not a re-implementation.
//
//   It also exercises the non-configurable lifecycle invariants (FN-5147
//   terminal-until-merged, hard-cancel, file-scope guard) and the flag posture
//   (pinned-at-dispatch, OFF-rollback recovery) on the stepwise path.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, expect, it } from "vitest";
import {
  BUILTIN_STEPWISE_CODING_WORKFLOW_IR,
  type StepStatus,
  type TaskDetail,
  type TaskStep,
  type WorkflowIr,
} from "@fusion/core";

import { WorkflowGraphExecutor, type WorkflowNodeResult } from "../workflow-graph-executor.js";
import {
  FOREACH_ACTIVE_CONTEXT_KEY,
  type ForeachActiveContext,
  type StepReviewSeamResult,
  type WorkflowLegacySeams,
} from "../workflow-node-handlers.js";
import {
  makeAncestryBlastRadiusGuard,
  resetStepToBaseline,
  runTaskStep,
  type StepRunnerTask,
} from "../step-runner.js";

const settingsOn = () => ({ experimentalFeatures: { workflowGraphExecutor: true } });
const settingsOff = () => ({ experimentalFeatures: { workflowGraphExecutor: false } });

type Verdict = StepReviewSeamResult["verdict"];

/** One recorded projection write — the unit of trajectory comparison (KTD-7). */
interface TrajectoryEntry {
  step: number;
  status: StepStatus;
  source?: "graph";
}

/**
 * A minimal fake store recording the `updateStep` projection trajectory and
 * applying each write to an in-memory `steps[]` so the blast-radius guard's
 * "later step already done" probe and the merge-blocker reads see real state.
 * Implements only the surface `runTaskStep` / `resetStepToBaseline` touch.
 */
function makeFakeStore(steps: TaskStep[]) {
  const trajectory: TrajectoryEntry[] = [];
  return {
    trajectory,
    steps,
    updateStep: async (
      _id: string,
      stepIndex: number,
      status: StepStatus,
      options?: { source?: "graph" },
    ) => {
      trajectory.push({ step: stepIndex, status, ...(options?.source ? { source: options.source } : {}) });
      if (steps[stepIndex]) steps[stepIndex] = { ...steps[stepIndex], status };
      return {} as never;
    },
    logEntry: async () => {},
  };
}

/** Build a TaskDetail with N pending steps and an optional enabled-group set. */
function taskWithSteps(n: number, enabledWorkflowSteps?: string[]): TaskDetail {
  const steps: TaskStep[] = Array.from({ length: n }, (_, i) => ({
    name: `Step ${i + 1}`,
    status: "pending" as const,
  }));
  return {
    id: "FN-STEPWISE",
    steps,
    ...(enabledWorkflowSteps ? { enabledWorkflowSteps } : {}),
  } as unknown as TaskDetail;
}

/**
 * The legacy step-session ORACLE (KTD-9). Deterministic per-step loop modeling the
 * in-session `fn_review_step` policy: for each step, mark in-progress, run, review;
 * APPROVE → done, REVISE → re-run in place (no reset), RETHINK → reset to pending +
 * re-run. Bounded by maxReworkCycles. Records the same TrajectoryEntry shape the
 * graph side records — the legacy side never uses `source:"graph"`.
 */
async function runLegacyStepSession(
  stepCount: number,
  scripts: Verdict[][],
  maxReworkCycles = 3,
): Promise<TrajectoryEntry[]> {
  const trajectory: TrajectoryEntry[] = [];
  const steps: TaskStep[] = Array.from({ length: stepCount }, (_, i) => ({
    name: `Step ${i + 1}`,
    status: "pending" as const,
  }));
  for (let i = 0; i < stepCount; i++) {
    const verdicts = scripts[i] ?? ["APPROVE"];
    let cursor = 0;
    let rework = 0;
    for (;;) {
      // run step i (mark in-progress)
      trajectory.push({ step: i, status: "in-progress" });
      steps[i] = { ...steps[i], status: "in-progress" };
      const verdict = verdicts[Math.min(cursor, verdicts.length - 1)];
      cursor++;
      if (verdict === "APPROVE") {
        trajectory.push({ step: i, status: "done" });
        steps[i] = { ...steps[i], status: "done" };
        break;
      }
      if (verdict === "RETHINK") {
        // reset to baseline: step → pending, then re-run.
        trajectory.push({ step: i, status: "pending" });
        steps[i] = { ...steps[i], status: "pending" };
      }
      // REVISE: re-run in place (no extra projection write — step stays in-progress
      // on the next loop's in-progress write).
      rework++;
      if (rework > maxReworkCycles) {
        // rework exhausted — step stays non-done (escalates). Mirror the graph's
        // exhaustion: leave the last in-progress write as the terminal state.
        break;
      }
    }
  }
  return trajectory;
}

/**
 * Drive the stepwise foreach graph (the REAL builtin IR) and capture the projection
 * trajectory. Wires the substrate seams exactly as the executor does:
 *   - stepExecute → runTaskStep (markDoneOnSuccess driven by deferDoneToReview);
 *   - stepReview  → scripted verdict; APPROVE marks the step done via updateStep
 *     (the projection authority, like createGraphSeams);
 *   - onReworkReset → resetStepToBaseline with the shared-isolation blast guard.
 */
async function runStepwiseGraph(
  stepCount: number,
  scripts: Verdict[][],
  opts: {
    maxReworkCycles?: number;
    signal?: AbortSignal;
    onReset?: (active: ForeachActiveContext) => void;
    captureResetResult?: (ok: boolean, reason?: string) => void;
    workflowStep?: WorkflowLegacySeams["workflowStep"];
    // U6: ids of optional-group nodes enabled for this task (e.g.
    // "browser-verification"); seeds task.enabledWorkflowSteps.
    enabledWorkflowSteps?: string[];
    // U6: handler for non-seam custom nodes — the browser-verification
    // optional-group's inner prompt node runs through this.
    runCustomNode?: (nodeId: string) => Promise<WorkflowNodeResult>;
  } = {},
): Promise<{ trajectory: TrajectoryEntry[]; outcome: string; result: Awaited<ReturnType<WorkflowGraphExecutor["run"]>> }> {
  const task = taskWithSteps(stepCount, opts.enabledWorkflowSteps);
  const fake = makeFakeStore(task.steps as TaskStep[]);
  const reviewCursor = new Map<number, number>();

  const seams: WorkflowLegacySeams = {
    planning: async () => ({ outcome: "success" }),
    review: async () => ({ outcome: "success" }),
    merge: async () => ({ outcome: "success" }),
    schedule: async () => ({ outcome: "success" }),
    execute: async () => ({ outcome: "success" }),
    ...(opts.workflowStep ? { workflowStep: opts.workflowStep } : {}),
    stepExecute: async (_t, ctx) => {
      const active = ctx[FOREACH_ACTIVE_CONTEXT_KEY] as ForeachActiveContext;
      const result = await runTaskStep(
        {
          store: fake as never,
          worktreePath: "/fake/worktree",
          runStep: async () => ({ success: true }),
          // Deterministic per-step baseline (substrate-captured, KTD-2). HEAD at
          // instance start postdates steps 0..i-1's commits.
          gitRevParse: async () => `sha-baseline-${active.stepIndex}`,
          captureCheckpointId: () => `ckpt-${active.stepIndex}`,
        },
        { id: task.id, steps: task.steps } as StepRunnerTask,
        active.stepIndex,
        { markDoneOnSuccess: active.deferDoneToReview !== true },
      );
      active.baselineSha = result.baselineSha;
      active.checkpointId = result.checkpointId;
      return {
        outcome: result.outcome,
        value: "step-done",
        contextPatch: { [FOREACH_ACTIVE_CONTEXT_KEY]: active },
      };
    },
    stepReview: async (_t, ctx, _config) => {
      const active = ctx[FOREACH_ACTIVE_CONTEXT_KEY] as ForeachActiveContext;
      const verdicts = scripts[active.stepIndex] ?? ["APPROVE"];
      const cursor = reviewCursor.get(active.stepIndex) ?? 0;
      reviewCursor.set(active.stepIndex, cursor + 1);
      const verdict = verdicts[Math.min(cursor, verdicts.length - 1)];
      // APPROVE: the seam is the projection authority for done (createGraphSeams).
      if (verdict === "APPROVE") {
        await fake.updateStep(task.id, active.stepIndex, "done", { source: "graph" });
      }
      return { verdict };
    },
  };

  const executor = new WorkflowGraphExecutor({
    seams,
    signal: opts.signal,
    // U6: non-seam custom nodes (the browser-verification optional-group's inner
    // prompt node) route here. Default: success no-op.
    runCustomNode: async (node) =>
      opts.runCustomNode ? opts.runCustomNode(node.id) : { outcome: "success" },
    getTaskSteps: () => task.steps as TaskStep[],
    // parse-steps reads PROMPT.md; produce headings matching the step count so the
    // real builtin chain runs end-to-end. writeSteps is a no-op (steps pre-set).
    parseStepsDeps: {
      readArtifact: async () =>
        Array.from({ length: stepCount }, (_, i) => `### Step ${i + 1}: do ${i + 1}\n`).join("\n"),
      writeSteps: async (_t, parsed) => {
        // Mirror production: project the parsed list (all pending). Keep the
        // in-memory steps array length authoritative for the run.
        task.steps = parsed.length > 0 ? parsed : (task.steps as TaskStep[]);
      },
    },
    onReworkReset: async (active) => {
      opts.onReset?.(active);
      const res = await resetStepToBaseline(
        {
          store: fake as never,
          worktreePath: "/fake/worktree",
          sessionRef: { current: null },
          reviewType: "code",
          blastRadiusGuard: makeAncestryBlastRadiusGuard({
            worktreePath: "/fake/worktree",
            task: { id: task.id, steps: task.steps } as StepRunnerTask,
            stepIndex: active.stepIndex,
            // Deterministic ancestry: the captured baseline is always an ancestor
            // of HEAD on a clean scripted run.
            isAncestor: async () => true,
          }),
        },
        { id: task.id, steps: task.steps } as StepRunnerTask,
        active.stepIndex,
        active.baselineSha,
        active.checkpointId,
      );
      opts.captureResetResult?.(res.ok, res.reason);
    },
  });

  const ir: WorkflowIr = BUILTIN_STEPWISE_CODING_WORKFLOW_IR;
  // Override maxReworkCycles when the scenario needs a tighter budget.
  const runIr =
    opts.maxReworkCycles !== undefined ? withForeachMaxRework(ir, opts.maxReworkCycles) : ir;

  const result = await executor.run(task, settingsOn(), runIr);
  return { trajectory: fake.trajectory, outcome: result.outcome, result };
}

/** Clone the IR with the foreach node's maxReworkCycles overridden (test only). */
function withForeachMaxRework(ir: WorkflowIr, max: number): WorkflowIr {
  const cloned = JSON.parse(JSON.stringify(ir)) as WorkflowIr;
  for (const node of cloned.nodes) {
    if (node.kind === "foreach" && node.config) {
      (node.config as { maxReworkCycles?: number }).maxReworkCycles = max;
    }
  }
  return cloned;
}

/** Strip the `source` marker so the legacy (no-source) and graph trajectories are
 *  compared on (step, status) only — the projection content the merge-blocker and
 *  dashboard read (KTD-7). The graph side additionally carries `source:"graph"`. */
function normalize(t: TrajectoryEntry[]): Array<{ step: number; status: StepStatus }> {
  return t.map(({ step, status }) => ({ step, status }));
}

describe("stepwise workflow parity (U7 / KTD-9)", () => {
  // ── Trajectory parity vs the legacy step-session oracle ────────────────────

  it("identical updateStep trajectory: 3-step approve-all (legacy step-session vs stepwise graph)", async () => {
    const scripts: Verdict[][] = [["APPROVE"], ["APPROVE"], ["APPROVE"]];
    const legacy = await runLegacyStepSession(3, scripts);
    const { trajectory, outcome } = await runStepwiseGraph(3, scripts);

    expect(outcome).toBe("success");
    expect(normalize(trajectory)).toEqual(normalize(legacy));
    // Concretely: each step in-progress then done, in order.
    expect(normalize(trajectory)).toEqual([
      { step: 0, status: "in-progress" },
      { step: 0, status: "done" },
      { step: 1, status: "in-progress" },
      { step: 1, status: "done" },
      { step: 2, status: "in-progress" },
      { step: 2, status: "done" },
    ]);
  });

  it("revise-then-approve trajectory parity (revise re-runs in place, no reset)", async () => {
    // Step 0: REVISE once then APPROVE. Step 1: APPROVE.
    const scripts: Verdict[][] = [["REVISE", "APPROVE"], ["APPROVE"]];
    const legacy = await runLegacyStepSession(2, scripts);
    const { trajectory, outcome } = await runStepwiseGraph(2, scripts);

    expect(outcome).toBe("success");
    expect(normalize(trajectory)).toEqual(normalize(legacy));
    // No `pending` write for step 0 (revise never resets).
    expect(trajectory.some((e) => e.step === 0 && e.status === "pending")).toBe(false);
    // Step 0 ran twice (in-progress ×2) then done once.
    expect(trajectory.filter((e) => e.step === 0 && e.status === "in-progress").length).toBe(2);
  });

  it("RETHINK trajectory parity incl. reset to pending and baseline == agent-equivalent baseline (KTD-2)", async () => {
    // Step 0: RETHINK once (resets) then APPROVE.
    const scripts: Verdict[][] = [["RETHINK", "APPROVE"]];
    const legacy = await runLegacyStepSession(1, scripts);
    const resetSeen: ForeachActiveContext[] = [];
    const { trajectory, outcome } = await runStepwiseGraph(1, scripts, {
      onReset: (active) => resetSeen.push({ ...active }),
    });

    expect(outcome).toBe("success");
    expect(normalize(trajectory)).toEqual(normalize(legacy));
    // A RETHINK resets to pending before re-execute.
    expect(trajectory.some((e) => e.step === 0 && e.status === "pending")).toBe(true);
    // The reset fired exactly once, with the substrate-captured baseline. KTD-2:
    // HEAD-at-instance-start (`sha-baseline-0`) is exactly the agent-equivalent
    // baseline (the boundary after steps 0..-1 = the start). Asserted here.
    expect(resetSeen.length).toBe(1);
    expect(resetSeen[0].baselineSha).toBe("sha-baseline-0");
    expect(resetSeen[0].checkpointId).toBe("ckpt-0");
  });

  // ── RETHINK blast-radius guard (KTD-2) ─────────────────────────────────────

  it("RETHINK blast-radius guard REFUSES when a later step is already done", async () => {
    // Directly exercise the production guard the graph wires: a reset for step 0
    // when step 1 is already `done` must be refused (would destroy approved work).
    const steps: TaskStep[] = [
      { name: "Step 1", status: "pending" },
      { name: "Step 2", status: "done" }, // a LATER step already completed
    ];
    const fake = makeFakeStore(steps);
    const guard = makeAncestryBlastRadiusGuard({
      worktreePath: "/fake/worktree",
      task: { id: "FN-STEPWISE", steps } as StepRunnerTask,
      stepIndex: 0,
      isAncestor: async () => true,
    });
    const res = await resetStepToBaseline(
      {
        store: fake as never,
        worktreePath: "/fake/worktree",
        sessionRef: { current: null },
        reviewType: "code",
        blastRadiusGuard: guard,
      },
      { id: "FN-STEPWISE", steps } as StepRunnerTask,
      0,
      "sha-baseline-0",
      "ckpt-0",
    );

    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/later step/i);
    // Refusal mutates NOTHING (no projection write at all).
    expect(fake.trajectory.length).toBe(0);
  });

  // ── Lifecycle invariants on the stepwise path (R14) ────────────────────────

  it("FN-5147 terminal-until-merged: stepwise run with merge failure stays out of done", async () => {
    // autoMerge:false → the merge seam fails (manual-merge-required); the task
    // never routes to merge success, so it stays terminal-in-review until merged.
    const task = taskWithSteps(1);
    const fake = makeFakeStore(task.steps as TaskStep[]);
    const seams: WorkflowLegacySeams = {
      planning: async () => ({ outcome: "success" }),
      execute: async () => ({ outcome: "success" }),
      review: async () => ({ outcome: "success" }),
      // FN-5147: autoMerge:false surfaces as a merge-blocking failure value.
      merge: async () => ({ outcome: "failure", value: "manual-merge-required" }),
      schedule: async () => ({ outcome: "success" }),
      stepExecute: async (_t, ctx) => {
        const active = ctx[FOREACH_ACTIVE_CONTEXT_KEY] as ForeachActiveContext;
        await runTaskStep(
          {
            store: fake as never,
            worktreePath: "/fake/worktree",
            runStep: async () => ({ success: true }),
            gitRevParse: async () => "sha",
            captureCheckpointId: () => "ckpt",
          },
          { id: task.id, steps: task.steps } as StepRunnerTask,
          active.stepIndex,
          { markDoneOnSuccess: active.deferDoneToReview !== true },
        );
        return { outcome: "success", value: "step-done" };
      },
      stepReview: async (_t, ctx) => {
        const active = ctx[FOREACH_ACTIVE_CONTEXT_KEY] as ForeachActiveContext;
        await fake.updateStep(task.id, active.stepIndex, "done", { source: "graph" });
        return { verdict: "APPROVE" } as StepReviewSeamResult;
      },
    };
    const executor = new WorkflowGraphExecutor({
      seams,
      getTaskSteps: () => task.steps as TaskStep[],
      parseStepsDeps: {
        readArtifact: async () => "### Step 1: do it\n",
        writeSteps: async () => {},
      },
      // FNXC:WorkflowGraphCutover 2026-07-07-09:05: stepwise-coding gained a default-on plan-review optional-group (and always-on completion-summary) before the foreach; wire the custom-node runner (success) so those auxiliary nodes pass through and the foreach/step invariant under test is actually reached (mirrors production executor.ts runCustomNode + runStepwiseGraph).
      runCustomNode: async () => ({ outcome: "success" }),
    });
    const result = await executor.run(task, settingsOn(), BUILTIN_STEPWISE_CODING_WORKFLOW_IR);

    expect(result.outcome).toBe("failure");
    // The walk never reached `end` through merge — terminal-until-merged preserved.
    expect(result.visitedNodeIds).not.toContain("end");
    // All step work completed (the step is done) — the blocker is the merge, not steps.
    expect((task.steps as TaskStep[])[0].status).toBe("done");
  });

  it("hard-cancel mid-instance: abort signal halts the foreach cleanly (no further step work)", async () => {
    const controller = new AbortController();
    const ran: number[] = [];
    const task = taskWithSteps(3);
    const fake = makeFakeStore(task.steps as TaskStep[]);
    const seams: WorkflowLegacySeams = {
      planning: async () => ({ outcome: "success" }),
      execute: async () => ({ outcome: "success" }),
      review: async () => ({ outcome: "success" }),
      merge: async () => ({ outcome: "success" }),
      schedule: async () => ({ outcome: "success" }),
      stepExecute: async (_t, ctx) => {
        const active = ctx[FOREACH_ACTIVE_CONTEXT_KEY] as ForeachActiveContext;
        ran.push(active.stepIndex);
        await fake.updateStep(task.id, active.stepIndex, "in-progress", { source: "graph" });
        // Simulate a hard-cancel (moveTask in-progress→todo) mid-first-instance.
        if (active.stepIndex === 0) controller.abort();
        return { outcome: "success", value: "step-done" };
      },
      stepReview: async () => ({ verdict: "APPROVE" }) as StepReviewSeamResult,
    };
    const executor = new WorkflowGraphExecutor({
      seams,
      signal: controller.signal,
      getTaskSteps: () => task.steps as TaskStep[],
      parseStepsDeps: {
        readArtifact: async () => "### Step 1: a\n### Step 2: b\n### Step 3: c\n",
        writeSteps: async () => {},
      },
      runCustomNode: async () => ({ outcome: "success" }),
    });
    const result = await executor.run(task, settingsOn(), BUILTIN_STEPWISE_CODING_WORKFLOW_IR);

    expect(result.outcome).toBe("failure");
    // Only the first instance started; later instances never ran (clean cancel).
    expect(ran).toEqual([0]);
  });

  it("file-scope guard fires inside step-execute: a step-execute failure value propagates (no merge)", async () => {
    // The file-scope guard surfaces as a step-execute failure (the session commit
    // is rejected). The foreach must route failure — NOT silently approve/merge.
    const task = taskWithSteps(2);
    const fake = makeFakeStore(task.steps as TaskStep[]);
    const seams: WorkflowLegacySeams = {
      planning: async () => ({ outcome: "success" }),
      execute: async () => ({ outcome: "success" }),
      review: async () => ({ outcome: "success" }),
      merge: async () => ({ outcome: "success" }),
      schedule: async () => ({ outcome: "success" }),
      stepExecute: async (_t, ctx) => {
        const active = ctx[FOREACH_ACTIVE_CONTEXT_KEY] as ForeachActiveContext;
        await fake.updateStep(task.id, active.stepIndex, "in-progress", { source: "graph" });
        // Step 0 violates file scope.
        if (active.stepIndex === 0) {
          return { outcome: "failure", value: "FileScopeViolationError" };
        }
        return { outcome: "success", value: "step-done" };
      },
      stepReview: async () => ({ verdict: "APPROVE" }) as StepReviewSeamResult,
    };
    const executor = new WorkflowGraphExecutor({
      seams,
      getTaskSteps: () => task.steps as TaskStep[],
      parseStepsDeps: {
        readArtifact: async () => "### Step 1: a\n### Step 2: b\n",
        writeSteps: async () => {},
      },
      runCustomNode: async () => ({ outcome: "success" }),
    });
    const result = await executor.run(task, settingsOn(), BUILTIN_STEPWISE_CODING_WORKFLOW_IR);

    expect(result.outcome).toBe("failure");
    // Step 0 never reached `done` (the guard blocked it); step 1 never ran.
    expect((task.steps as TaskStep[])[0].status).toBe("in-progress");
    expect((task.steps as TaskStep[])[1].status).toBe("pending");
    expect(result.visitedNodeIds).not.toContain("merge");
  });

  // ── Flag posture (R10) ─────────────────────────────────────────────────────

  it("graduated graph executor ignores stale false experimental flag", async () => {
    /*
    FNXC:WorkflowSettings 2026-06-23-22:28:
    workflowGraphExecutor graduated from Experimental; stale persisted false values are ignored so the graph attempts authoritative execution rather than silently rolling back to the legacy path.
    This fixture still lacks parse-step dependencies, so the graph fails before step execution.
    */
    const task = taskWithSteps(2);
    let stepExecuteCalls = 0;
    const seams: WorkflowLegacySeams = {
      planning: async () => ({ outcome: "success" }),
      execute: async () => ({ outcome: "success" }),
      review: async () => ({ outcome: "success" }),
      merge: async () => ({ outcome: "success" }),
      schedule: async () => ({ outcome: "success" }),
      stepExecute: async () => {
        stepExecuteCalls++;
        return { outcome: "success", value: "step-done" };
      },
    };
    const executor = new WorkflowGraphExecutor({ seams });
    const result = await executor.run(task, settingsOff(), BUILTIN_STEPWISE_CODING_WORKFLOW_IR);

    expect(result.executed).toBe(true);
    expect(result.outcome).toBe("failure");
    expect(stepExecuteCalls).toBe(0);
  });

  it("graduated graph executor preserves steps[] truth while running with stale false flag", async () => {
    /*
    FNXC:WorkflowSettings 2026-06-23-22:28:
    Stale workflowGraphExecutor=false no longer disables the graph. If required graph dependencies are absent, rollback safety means the existing git-reconcilable steps[] projection remains the surviving truth.
    */
    const task = taskWithSteps(2);
    // Simulate a partially-progressed legacy projection (step 0 done by legacy).
    (task.steps as TaskStep[])[0] = { name: "Step 1", status: "done" };
    const executor = new WorkflowGraphExecutor({ seams: undefined });
    const result = await executor.run(task, settingsOff(), BUILTIN_STEPWISE_CODING_WORKFLOW_IR);

    expect(result.executed).toBe(true);
    expect((task.steps as TaskStep[])[0].status).toBe("done");
    expect((task.steps as TaskStep[])[1].status).toBe("pending");
  });

  // ── Zero-step task (R8) ────────────────────────────────────────────────────

  it("zero-step task on stepwise merges without step work (no-steps outcome path)", async () => {
    let stepExecuteCalls = 0;
    const task = taskWithSteps(0);
    const seams: WorkflowLegacySeams = {
      planning: async () => ({ outcome: "success" }),
      execute: async () => ({ outcome: "success" }),
      review: async () => ({ outcome: "success" }),
      merge: async () => ({ outcome: "success" }),
      schedule: async () => ({ outcome: "success" }),
      stepExecute: async () => {
        stepExecuteCalls++;
        return { outcome: "success", value: "step-done" };
      },
    };
    const executor = new WorkflowGraphExecutor({
      seams,
      getTaskSteps: () => [],
      parseStepsDeps: {
        // No headings → zero steps → parse-steps routes outcome:no-steps → foreach
        // no-ops through its success edge (R8).
        readArtifact: async () => "no steps here, just prose",
        writeSteps: async () => {},
      },
      runCustomNode: async () => ({ outcome: "success" }),
    });
    const result = await executor.run(task, settingsOn(), BUILTIN_STEPWISE_CODING_WORKFLOW_IR);

    expect(result.outcome).toBe("success");
    expect(stepExecuteCalls).toBe(0);
    // The foreach was reached but expanded zero instances.
    expect(result.visitedNodeIds).toContain("steps");
    expect(result.visitedNodeIds.some((id) => id.startsWith("steps#"))).toBe(false);
    // Merge ran (the task merges with no step work).
    expect(result.visitedNodeIds).toContain("merge");
  });

  // ── Pre-merge browser-verification optional-group (U6, R-3 run-once) ────────

  const BROWSER_VERIFICATION_STEP_VISITED_ID = "browser-verification::browser-verification-step";

  it("runs the pre-merge browser-verification optional-group EXACTLY ONCE after the foreach when enabled", async () => {
    // R-3 run-once guarantee + dead-toggle guard: the optional-group sits on the
    // post-foreach success path. A stepwise task whose enabledWorkflowSteps
    // includes the group id runs the inner browser-verification prompt node ONCE
    // after all step instances complete — never per step-instance.
    let browserVerificationCalls = 0;
    const { outcome, result } = await runStepwiseGraph(
      3,
      [["APPROVE"], ["APPROVE"], ["APPROVE"]],
      {
        enabledWorkflowSteps: ["browser-verification"],
        runCustomNode: async (nodeId) => {
          if (nodeId === "browser-verification-step") browserVerificationCalls++;
          return { outcome: "success" };
        },
      },
    );

    expect(outcome).toBe("success");
    // ONCE post-foreach — not per step-instance (3 steps here).
    expect(browserVerificationCalls).toBe(1);
    expect(result.visitedNodeIds).toContain("browser-verification");
    expect(result.visitedNodeIds).toContain(BROWSER_VERIFICATION_STEP_VISITED_ID);
    // FNXC:WorkflowGraphCutover 2026-07-07-09:10:
    // FN-7265 removed the post-foreach `review` node; the pre-merge gate is now the default-on `code-review` optional-group (browser-verification → code-review → completion-summary → merge-gate). The R-3 run-once ordering invariant is therefore: all step instances finish before the browser-verification inner step, which precedes the code-review gate.
    const groupStepIdx = result.visitedNodeIds.indexOf(BROWSER_VERIFICATION_STEP_VISITED_ID);
    const codeReviewIdx = result.visitedNodeIds.indexOf("code-review");
    const lastStepIdx = result.visitedNodeIds.map((id) => id.startsWith("steps#")).lastIndexOf(true);
    expect(lastStepIdx).toBeLessThan(groupStepIdx);
    expect(groupStepIdx).toBeLessThan(codeReviewIdx);
  });

  it("bypasses the browser-verification optional-group (inert) when it is not enabled", async () => {
    // Disabled (no enabledWorkflowSteps): the group node is traversed but its
    // template body never runs — the inner prompt node is not visited and the
    // custom-node runner is never invoked for it. Routes straight to the
    // code-review gate.
    // FNXC:WorkflowGraphCutover 2026-07-07-09:10: FN-7265 removed the `review` node; the post-foreach gate this inert path reaches is now `code-review`.
    let browserVerificationCalls = 0;
    const { outcome, result } = await runStepwiseGraph(2, [["APPROVE"], ["APPROVE"]], {
      runCustomNode: async (nodeId) => {
        if (nodeId === "browser-verification-step") browserVerificationCalls++;
        return { outcome: "success" };
      },
    });
    expect(outcome).toBe("success");
    expect(browserVerificationCalls).toBe(0);
    expect(result.visitedNodeIds).toContain("browser-verification");
    expect(result.visitedNodeIds).not.toContain(BROWSER_VERIFICATION_STEP_VISITED_ID);
    expect(result.visitedNodeIds).toContain("code-review");
  });
});
