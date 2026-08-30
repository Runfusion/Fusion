import type { Settings, Task, TaskStore, WorkflowIrNode } from "@fusion/core";
import { runExecutorDeterministicVerification } from "../executor/deterministic-verification.js";
import { truncateWithEllipsis } from "../execution/verification-utils.js";
import type { EngineRunContext } from "../util/run-audit.js";

export type DeterministicVerificationGateDeps = {
  store: TaskStore;
  getRunContextFor?: (taskId: string) => EngineRunContext | undefined;
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
 * KNOWN GAP (FN-189): with no command configured and none inferable, this returns success and the
 * card still shows a green "completed" for a check that never ran. The step OUTPUT says so in
 * capitals, which is the honest signal available without changing merge gating. Recording it as
 * `skipped` is the correct answer and was attempted here: `pre-merge-approval` then refuses a
 * `skipped` step that carries no operator bypass, so every task on a project without a test command
 * became unmergeable. That belongs to FN-189 with its own coverage, not to a follow-on edit here.
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
      contextPatch: { output: "No test or build command is configured for this project — NOTHING WAS VERIFIED." },
    };
  }

  const runVerification = deps.runVerification ?? runExecutorDeterministicVerification;
  const result = await runVerification(
    { store: deps.store, getRunContextFor: deps.getRunContextFor ?? (() => undefined) },
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
