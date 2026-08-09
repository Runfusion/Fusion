/**
 * FNXC:CodeOrganization 2026-08-03-18:40:
 * runExecutorDeterministicVerification peeled from TaskExecutor (U4).
 * Runs configured testCommand + buildCommand in the task worktree.
 *
 * FNXC:EngineDiagnostics 2026-07-26-09:33:
 * Green path verification start/pass is expected work — debug so failures stay prominent.
 */
import type { Settings, Task, TaskStore } from "@fusion/core";
import {
  runVerificationCommand,
  type VerificationResult,
} from "../execution/verification-utils.js";
import { executorLog } from "../logger.js";
import type { EngineRunContext } from "../util/run-audit.js";

export type DeterministicVerificationDeps = {
  store: TaskStore;
  getRunContextFor: (taskId: string) => EngineRunContext | undefined;
};

export async function runExecutorDeterministicVerification(
  deps: DeterministicVerificationDeps,
  task: Task,
  worktreePath: string,
  settings: Settings,
  extraEnv?: NodeJS.ProcessEnv,
): Promise<VerificationResult> {
  const testCommand = settings.testCommand?.trim();
  const buildCommand = settings.buildCommand?.trim();

  if (!testCommand && !buildCommand) {
    executorLog.debug(`${task.id}: no test/build commands configured — skipping verification`);
    return { allPassed: true };
  }

  const parts: string[] = [];
  if (testCommand) parts.push(`test: ${testCommand}`);
  if (buildCommand) parts.push(`build: ${buildCommand}`);
  // FNXC:EngineDiagnostics 2026-07-26-09:33: green path verification start/pass is expected work — debug so failures stay prominent.
  executorLog.debug(`${task.id}: [verification] running deterministic verification (${parts.join(", ")})`);
  await deps.store.logEntry(
    task.id,
    `[verification] Running deterministic verification (${parts.join(", ")})`,
    undefined,
    deps.getRunContextFor(task.id),
  );

  const result: VerificationResult = { allPassed: true };

  // Run test command first if configured
  if (testCommand) {
    const testResult = await runVerificationCommand(
      deps.store, worktreePath, task.id, testCommand, "test", undefined, executorLog, "executor", extraEnv, settings.verificationCommandTimeoutMs,
    );
    result.testResult = testResult;

    if (!testResult.success) {
      result.allPassed = false;
      result.failedCommand = "testCommand";
      executorLog.log(`${task.id}: [verification] test failed (exit ${testResult.exitCode})`);
      return result;
    }
  }

  // Run build command second if configured
  if (buildCommand) {
    const buildResult = await runVerificationCommand(
      deps.store, worktreePath, task.id, buildCommand, "build", undefined, executorLog, "executor", extraEnv, settings.verificationCommandTimeoutMs,
    );
    result.buildResult = buildResult;

    if (!buildResult.success) {
      result.allPassed = false;
      result.failedCommand = "buildCommand";
      executorLog.log(`${task.id}: [verification] build failed (exit ${buildResult.exitCode})`);
      return result;
    }
  }

  executorLog.debug(`${task.id}: [verification] passed`);
  await deps.store.logEntry(
    task.id,
    `[verification] Deterministic verification passed`,
    undefined,
    deps.getRunContextFor(task.id),
  );
  return result;
}
