/**
 * FNXC:CodeOrganization 2026-08-03-11:50:
 * runGraphTaskStep peeled from TaskExecutor (U4).
 *
 * Step-inversion per-step driver (KTD-2/KTD-8, closes the U3 interim gap).
 * The U3 stand-in ran `runImplementationPhase` once per foreach instance, which
 * re-ran the whole implementation for every step. The real driver:
 *   1. Pins step-session physics only when the workflow needs a discrete per-step
 *      boundary before a step-review node. Final-review coding lets
 *      `runStepsInNewSessions` choose between one reused executor session and
 *      fresh per-step sessions.
 *   2. Drives the implementation phase exactly ONCE per run, memoized by task id.
 *      Each foreach instance's `runTaskStep` observes projection truth for its step
 *      rather than re-running the agent per step.
 *
 * FNXC:WorkflowStepSessions 2026-06-30-00:00:
 * Default Coding reuses executor session unless runStepsInNewSessions; step-review workflows pin StepSessionExecutor.
 *
 * FNXC:WorkflowExecutionOwnership 2026-07-29-14:10 (U8 / R4):
 * Carry pass ending on success returns too so pending-review parks remain reachable for deferDoneToReview shapes.
 */
import type { Task, TaskStore, ThinkingLevel } from "@fusion/core";
import { executorLog } from "../logger.js";
import type { ImplementationExit } from "./implementation-exit.js";

export type ImplementationPhaseResult = {
  taskDone: boolean;
  modifiedFiles: string[];
  exit?: ImplementationExit;
};

export type RunGraphTaskStepDeps = {
  store: TaskStore;
  foreachActiveForTask: (taskId: string, instanceId?: string) => { deferDoneToReview?: boolean } | undefined | null;
  graphStepSessionPinned: Set<string>;
  graphStepRunOnce: Map<string, Promise<ImplementationPhaseResult>>;
  graphSeamGoverningNodeId: Map<string, string>;
  graphSeamThinkingLevel: Map<string, ThinkingLevel>;
  graphSeamSkillName: Map<string, string>;
  runImplementationPhase: (task: Task) => Promise<ImplementationPhaseResult>;
};

export async function runGraphTaskStep(
  deps: RunGraphTaskStepDeps,
  task: Task,
  stepIndex: number,
  instanceId?: string,
  governingNodeId?: string,
  thinkingLevel?: ThinkingLevel,
  skillName?: string,
): Promise<{ success: boolean; error?: string; exit?: ImplementationExit }> {
  const active = deps.foreachActiveForTask(task.id, instanceId);
  /*
  FNXC:WorkflowStepSessions 2026-06-30-00:00:
  Default Coding is graph-owned stepwise execution without per-step review. It should reuse the existing executor session when the workflow setting `runStepsInNewSessions` is false, and create fresh step sessions only when that setting is true. Workflows with a step-review node still pin StepSessionExecutor because review must run between step execution and done-marking.
  */
  if (active?.deferDoneToReview === true) {
    deps.graphStepSessionPinned.add(task.id);
  }

  // Single-flight per attempt (KTD-2/KTD-8): the implementation phase runs once
  // per run, memoized by task id, so each foreach instance's `runStep` observes
  // the projection rather than re-running the agent. A REJECTED phase must NOT
  // poison later attempts: a rework cycle re-enters `runStep` and would otherwise
  // re-await the same stored rejection forever, so the implementation is never
  // retried. On rejection we therefore clear the memo entry so the NEXT call
  // (the rework re-run) re-invokes the implementation phase. Concurrent
  // in-flight callers within a single attempt still share the one promise.
  let phase = deps.graphStepRunOnce.get(task.id);
  if (!phase) {
    // Column-agent governing-node ownership (PR #1432 review): the slot is
    // written ONLY by the caller that CREATES the memoized pass, and cleared
    // when that pass settles. One step-session pass serves every foreach
    // instance, so the session-identity binding is the pass-INITIATING
    // instance's — deterministic, instead of concurrent seam invocations
    // racing set/delete on a shared per-task slot (parallel foreach could
    // otherwise stamp another instance's node mid-build or clear it before
    // the session resolved the binding).
    if (typeof governingNodeId === "string") {
      deps.graphSeamGoverningNodeId.set(task.id, governingNodeId);
    }
    if (thinkingLevel) {
      deps.graphSeamThinkingLevel.set(task.id, thinkingLevel);
    }
    if (skillName) {
      deps.graphSeamSkillName.set(task.id, skillName);
    }
    phase = deps.runImplementationPhase(task);
    deps.graphStepRunOnce.set(task.id, phase);
    void phase
      .catch(() => undefined)
      .finally(() => {
        // Clear only our own stamp — a rework re-run may have installed a new one.
        if (typeof governingNodeId === "string" && deps.graphSeamGoverningNodeId.get(task.id) === governingNodeId) {
          deps.graphSeamGoverningNodeId.delete(task.id);
        }
        if (thinkingLevel && deps.graphSeamThinkingLevel.get(task.id) === thinkingLevel) {
          deps.graphSeamThinkingLevel.delete(task.id);
        }
        if (skillName && deps.graphSeamSkillName.get(task.id) === skillName) {
          deps.graphSeamSkillName.delete(task.id);
        }
      });
  }
  /*
  FNXC:WorkflowExecutionOwnership 2026-07-29-11:20 (U8 / R4):
  The memoized pass's result was awaited and DISCARDED here — which is exactly where the
  implementation exit died. One pass serves every foreach instance, so the exit is a property
  of the pass, not of a step: each instance reports the same ending, which is correct because
  the ending is what stopped the whole session.
  */
  let phaseResult: { taskDone: boolean; modifiedFiles: string[]; exit?: ImplementationExit } | undefined;
  try {
    phaseResult = await phase;
  } catch (err) {
    // Clear the poisoned memo so a rework cycle can retry the implementation
    // (only if it is still the same rejected promise — do not clobber a fresh
    // attempt another caller may have already installed).
    if (deps.graphStepRunOnce.get(task.id) === phase) {
      deps.graphStepRunOnce.delete(task.id);
    }
    /*
    FNXC:WorkflowExecution 2026-06-29-09:01:
    Stepwise graph execution is projection-driven: a shared implementation pass can complete every task step and pass deterministic verification without using the legacy monolithic `task_done` sentinel. If the target step is already terminal in Task.steps[], the workflow node succeeds and the graph continues to its review/merge nodes instead of converting stale legacy completion failure into `steps#N:step-execute`.
    */
    try {
      const live = await deps.store.getTask(task.id);
      const status = live.steps[stepIndex]?.status;
      if (status === "done" || status === "skipped") {
        executorLog.warn(
          `${task.id}: graph step ${stepIndex} completed in projection despite implementation-pass error; continuing workflow (${err instanceof Error ? err.message : String(err)})`,
        );
        return { success: true };
      }
    } catch {
      // Fall through to the original failure value below.
    }
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }

  // Consult the projection (the single source of truth, KTD-7) for this step's
  // terminal state. The step-session pass marks each step done/skipped as it
  // completes; a step-review node (when present) decides done-ness instead.
  try {
    const live = await deps.store.getTask(task.id);
    if (!live || live.id !== task.id) {
      return {
        success: false,
        error: `step ${stepIndex} live task unavailable after implementation pass`,
      };
    }
    const status = live.steps[stepIndex]?.status;
    /*
    FNXC:WorkflowExecutionOwnership 2026-07-29-14:10 (U8 / R4, PR #2546 review — greptile P2):
    Carry the pass's ending on the SUCCESS returns too. One pass serves every foreach instance,
    so "this step completed" and "the pass stopped on a pending-review block" are independent
    facts and both can hold. Reporting only on failure made the exit branch-dependent: with
    `deferDoneToReview` every instance returns success, so the ending would never reach the seam
    and the graph-owned park would be unreachable for that shape.

    The seam still routes it only on FAILURE — a genuinely completed step must not be diverted
    to the park — so this is inert today and correct once the seam flip lands.
    */
    if (status === "done" || status === "skipped") return { success: true, exit: phaseResult?.exit };
    // Step not terminal after the pass: when a review will author done-ness
    // (deferDoneToReview), the pass having RUN is the success signal — the review
    // gates the projection write. Otherwise the implementation pass failed to
    // complete this step, so report failure rather than masking it (FIX 3: the
    // prior code returned success on both branches, hiding step-session failures).
    if (active?.deferDoneToReview === true) return { success: true, exit: phaseResult?.exit };
    return {
      success: false,
      exit: phaseResult?.exit,
      error: `step ${stepIndex} not completed by implementation pass (status: ${status ?? "unknown"})`,
    };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
