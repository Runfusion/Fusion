import type { Settings, Task, TaskStore, WorkflowIrNode, RunMutationContext } from "@fusion/core";
import { runExecutorDeterministicVerification } from "../executor/deterministic-verification.js";
import { truncateWithEllipsis } from "../execution/verification-utils.js";
import { runContextForTotal } from "../executor/run-context-for.js";

export type DeterministicVerificationGateDeps = {
  store: TaskStore;
  getRunContextFor?: (taskId: string) => RunMutationContext | undefined;
  runContextFor?: (taskId: string, fallbackAgentId?: string | null) => RunMutationContext;
  runVerification?: typeof runExecutorDeterministicVerification;
};

export type DeterministicVerificationGateResult = {
  outcome: "success" | "failure";
  value: "passed" | "failed" | "not-configured" | "verification-infrastructure-failure";
  contextPatch: Record<string, unknown>;
};

/**
 * FNXC:ReviewGatedVerification 2026-08-25-08:15:
 * Review-gated Verification is a measurement, never an agent claim: the verdict comes only from
 * command exit codes.
 *
 * It DELEGATES to `runExecutorDeterministicVerification`, the same primitive the in-progress
 * executor gate (FN-3345, run-implementation.ts) has always used. The previous revision re-derived
 * the command list and re-ran the loop itself — a second implementation of one rule, which is how
 * the two drifted: this copy treated "no command configured" as a hard failure while the executor
 * path treats it as not-applicable. Reusing the primitive means the timeout handling, per-command
 * logging, and settings precedence can only be fixed in one place.
 *
 * FNXC:WorkflowStepNotRun 2026-08-28-14:13:
 * FN-226 closes the false-green gap for an unconfigured gate. The success edge still advances the
 * graph, while the context patch records `not-configured`; graph recorders persist it as `skipped`
 * plus `notRunReason`. Pre-merge approval admits only non-code, non-plan not-run gates, preserving
 * the non-blocking default without presenting missing verification as a pass.
 */
export async function runDeterministicVerificationGate(
  deps: DeterministicVerificationGateDeps,
  _node: WorkflowIrNode,
  task: Task,
  settings: Settings,
  worktreePath: string,
): Promise<DeterministicVerificationGateResult> {
  if (!settings.testCommand?.trim() && !settings.buildCommand?.trim()) {
    return {
      outcome: "success",
      value: "not-configured",
      contextPatch: {
        notRunReason: "not-configured",
        output: "No test or build command is configured for this project — NOTHING WAS VERIFIED.",
      },
    };
  }

  const runVerification = deps.runVerification ?? runExecutorDeterministicVerification;
  const getRunContextFor = deps.getRunContextFor ?? (() => undefined);
  const result = await runVerification(
    {
      store: deps.store,
      getRunContextFor,
      runContextFor: deps.runContextFor ?? ((taskId, fallbackAgentId) => runContextForTotal(getRunContextFor, taskId, fallbackAgentId)),
    },
    task,
    worktreePath,
    settings,
  );

  if (result.allPassed) {
    return { outcome: "success", value: "passed", contextPatch: { output: "Verification passed." } };
  }

  const failed = result.failedCommand === "testCommand" ? result.testResult : result.buildResult;
  const label = result.failedCommand ?? "verification";
  /*
   * An infrastructure fault (timeout, abort, spawn failure) is NOT a failing test: it is the
   * absence of a measurement, and it routes separately so remediation is not asked to "fix" a
   * verification that never produced a verdict.
   */
  const infrastructureReason = failed?.timedOut
    ? "timed-out"
    : failed?.aborted
      ? "aborted"
      : failed?.executionError
        ? "execution-error"
        : undefined;
  const output = truncateWithEllipsis([failed?.stdout, failed?.stderr].filter(Boolean).join("\n"), 20_000);

  return {
    outcome: "failure",
    value: infrastructureReason ? "verification-infrastructure-failure" : "failed",
    contextPatch: {
      output: `${label}: ${infrastructureReason ?? `non-zero-exit${failed?.exitCode !== undefined ? ` (${failed.exitCode})` : ""}`}${output ? `\n${output}` : ""}`,
      verificationFailure: { commandLabel: label, ...(infrastructureReason ? { reason: infrastructureReason } : {}) },
    },
  };
}
