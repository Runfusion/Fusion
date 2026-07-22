import type { RunMutationContext, Task, TaskStore, WorktrunkSettings } from "@fusion/core";
import type { RunAuditor } from "../util/run-audit.js";
import { createLogger } from "../logger.js";

const log = createLogger("worktrunk-failure-handler");
const MAX_STDERR_PREVIEW_CHARS = 4096;

export type WorktrunkOpName = "create" | "sync" | "prune" | "remove" | "install" | "resolve-binary";

export interface WorktrunkOperationFailure {
  op: WorktrunkOpName;
  cause: Error;
  stderr?: string;
  exitCode?: number | null;
  durationMs?: number;
  binaryPath?: string;
  worktreePath?: string;
}

export type WorktreeOperationResult = { path: string; branch: string } | { skipped: boolean } | void;

export interface WorktrunkFailureNotification {
  kind: "worktrunk-fallback-native";
  task: Task;
  op: WorktrunkOpName;
  stderr?: string;
}

export interface HandleFailureParams {
  failure: WorktrunkOperationFailure;
  task: Task;
  settings: WorktrunkSettings;
  store: Pick<TaskStore, "pauseTask" | "updateTask">;
  runContext?: RunMutationContext;
  runAudit?: Pick<RunAuditor, "git">;
  notify: (event: WorktrunkFailureNotification) => Promise<void> | void;
  nativeFallback?: () => Promise<WorktreeOperationResult>;
}

export type WorktrunkDisposition =
  | { kind: "paused"; pausedReason: "worktrunk_operation_failed" }
  | { kind: "fallback-native"; result: WorktreeOperationResult; alerted: boolean };

function toStderrPreview(stderr?: string): string | undefined {
  if (!stderr) return undefined;
  return stderr.length > MAX_STDERR_PREVIEW_CHARS
    ? `${stderr.slice(0, MAX_STDERR_PREVIEW_CHARS)}…`
    : stderr;
}

async function pauseTaskWithFailure(
  params: Omit<HandleFailureParams, "nativeFallback" | "notify">,
): Promise<WorktrunkDisposition> {
  const { task, store, runContext, failure, runAudit } = params;
  const attemptedAt = new Date().toISOString();
  await store.pauseTask(task.id, true, runContext);
  await store.updateTask(task.id, {
    pausedReason: "worktrunk_operation_failed",
    worktrunkFailure: {
      op: failure.op,
      stderr: failure.stderr,
      exitCode: failure.exitCode ?? null,
      attemptedAt,
    },
  }, runContext);

  await runAudit?.git({
    type: "worktree:worktrunk-failure",
    target: task.id,
    metadata: {
      taskId: task.id,
      runId: runContext?.runId,
      op: failure.op,
      exitCode: failure.exitCode ?? null,
      stderrPreview: toStderrPreview(failure.stderr),
      binaryPath: failure.binaryPath,
      worktreePath: failure.worktreePath,
      durationMs: failure.durationMs,
    },
  });

  log.error(`${task.id}: worktrunk ${failure.op} failed; pausing task`);
  return { kind: "paused", pausedReason: "worktrunk_operation_failed" };
}

/**
 * Handles delegated worktrunk failures using the configured `worktrunk.onFailure` policy.
 * Throws the original error for fail-hard outcomes.
 */
export async function handleWorktrunkOperationFailure(params: HandleFailureParams): Promise<WorktrunkDisposition> {
  const { failure, task, settings, store, runContext, runAudit, notify, nativeFallback } = params;
  const mode = settings.onFailure ?? "fail";

  if (mode === "fallback-native") {
    if (!nativeFallback) {
      log.warn(`${task.id}: fallback-native requested for ${failure.op} but no native fallback provided; failing hard`);
      await pauseTaskWithFailure({ failure, task, settings, store, runContext, runAudit });
      throw failure.cause;
    }

    const alreadyAlerted = Boolean(task.worktrunkFallbackAlertedAt);
    let alerted = false;
    if (alreadyAlerted) {
      log.log(`${task.id}: notify-skipped for worktrunk ${failure.op}; fallback alert already sent`);
    } else {
      const alertedAt = new Date().toISOString();
      await store.updateTask(task.id, { worktrunkFallbackAlertedAt: alertedAt }, runContext);
      await notify({ kind: "worktrunk-fallback-native", task, op: failure.op, stderr: failure.stderr });
      alerted = true;
      log.warn(`${task.id}: worktrunk ${failure.op} failed; falling back to native backend`);
    }

    await runAudit?.git({
      type: "worktree:worktrunk-fallback-native",
      target: task.id,
      metadata: {
        taskId: task.id,
        runId: runContext?.runId,
        op: failure.op,
        exitCode: failure.exitCode ?? null,
        stderrPreview: toStderrPreview(failure.stderr),
        binaryPath: failure.binaryPath,
        worktreePath: failure.worktreePath,
        durationMs: failure.durationMs,
        alerted,
      },
    });

    try {
      const result = await nativeFallback();
      return { kind: "fallback-native", result, alerted };
    } catch (fallbackError) {
      log.error(`${task.id}: native-fallback-error for ${failure.op}: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`);
      throw fallbackError;
    }
  }

  await pauseTaskWithFailure({ failure, task, settings, store, runContext, runAudit });
  throw failure.cause;
}

export function truncateWorktrunkStderr(stderr?: string): string | undefined {
  return toStderrPreview(stderr);
}
