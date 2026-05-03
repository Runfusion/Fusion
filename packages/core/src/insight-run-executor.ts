import { setTimeout as delay } from "node:timers/promises";
import type {
  InsightRun,
  InsightRunCreateInput,
  InsightRunFailureClass,
  InsightRunOutputMetadata,
  InsightRunTrigger,
  InsightRunUpdateInput,
} from "./insight-types.js";
import { InsightLifecycleError, InsightStore } from "./insight-store.js";

export interface InsightRunAttemptResult {
  summary?: string | null;
  insightsCreated: number;
  insightsUpdated: number;
  outputMetadata?: InsightRunOutputMetadata;
}

export interface InsightRunAttemptContext {
  run: InsightRun;
  attempt: number;
  maxAttempts: number;
  signal: AbortSignal;
}

export interface InsightRunExecutorOptions {
  store: InsightStore;
  projectId: string;
  input: InsightRunCreateInput;
  executeAttempt: (ctx: InsightRunAttemptContext) => Promise<InsightRunAttemptResult>;
  timeoutMs?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
  signal?: AbortSignal;
}

export interface InsightRunExecutorErrorClassification {
  failureClass: InsightRunFailureClass;
  retryable: boolean;
  terminalReason: "cancelled" | "failed" | "timed_out";
  terminalCause: string;
}

function isAbortLike(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function asErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function classifyInsightRunError(error: unknown): InsightRunExecutorErrorClassification {
  if (isAbortLike(error)) {
    return {
      failureClass: "cancelled",
      retryable: false,
      terminalReason: "cancelled",
      terminalCause: asErrorMessage(error),
    };
  }

  const message = asErrorMessage(error);
  if (/timeout|timed out|deadline/i.test(message)) {
    return {
      failureClass: "timed_out",
      retryable: true,
      terminalReason: "timed_out",
      terminalCause: message,
    };
  }

  if (/ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|429|5\d\d/i.test(message)) {
    return {
      failureClass: "retryable_transient",
      retryable: true,
      terminalReason: "failed",
      terminalCause: message,
    };
  }

  return {
    failureClass: "non_retryable",
    retryable: false,
    terminalReason: "failed",
    terminalCause: message,
  };
}

function composeSignal(timeoutMs: number | undefined, parent?: AbortSignal): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timeoutId = timeoutMs && timeoutMs > 0
    ? setTimeout(() => controller.abort(new Error(`Insight run timed out after ${timeoutMs}ms`)), timeoutMs)
    : undefined;

  const onAbort = () => {
    controller.abort(parent?.reason ?? new DOMException("Aborted", "AbortError"));
  };

  if (parent) {
    if (parent.aborted) onAbort();
    else parent.addEventListener("abort", onAbort, { once: true });
  }

  return {
    signal: controller.signal,
    clear: () => {
      if (timeoutId) clearTimeout(timeoutId);
      if (parent) parent.removeEventListener("abort", onAbort);
    },
  };
}

function patchForStatus(status: "completed" | "failed" | "cancelled", patch: InsightRunUpdateInput): InsightRunUpdateInput {
  if (status === "cancelled") {
    return {
      ...patch,
      cancelledAt: patch.cancelledAt ?? new Date().toISOString(),
    };
  }
  return patch;
}

async function executeExistingRun(
  store: InsightStore,
  run: InsightRun,
  options: Omit<InsightRunExecutorOptions, "input" | "projectId"> & { maxAttempts: number; retryDelayMs: number },
): Promise<InsightRun> {
  const started = store.updateRun(run.id, {
    status: "running",
    startedAt: run.startedAt ?? new Date().toISOString(),
    lifecycle: {
      ...run.lifecycle,
      maxAttempts: options.maxAttempts,
      attempt: run.lifecycle.attempt ?? 1,
    },
  });
  let active = started ?? run;
  store.appendRunEvent(active.id, { type: "status_changed", status: "running", message: "Run started" });

  for (let attempt = active.lifecycle.attempt ?? 1; attempt <= options.maxAttempts; attempt += 1) {
    const { signal, clear } = composeSignal(options.timeoutMs, options.signal);
    try {
      if (signal.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError");
      }

      store.appendRunEvent(active.id, {
        type: "info",
        message: `Attempt ${attempt}/${options.maxAttempts}`,
        metadata: { attempt, maxAttempts: options.maxAttempts },
      });

      const result = await options.executeAttempt({ run: active, attempt, maxAttempts: options.maxAttempts, signal });
      const completed = store.updateRun(active.id, {
        status: "completed",
        summary: result.summary ?? null,
        insightsCreated: result.insightsCreated,
        insightsUpdated: result.insightsUpdated,
        outputMetadata: result.outputMetadata,
        lifecycle: {
          ...active.lifecycle,
          attempt,
          maxAttempts: options.maxAttempts,
          terminalReason: "completed",
          retryable: false,
        },
      });
      if (!completed) throw new Error(`Run disappeared while completing: ${active.id}`);
      store.appendRunEvent(completed.id, { type: "status_changed", status: "completed", message: "Run completed" });
      return completed;
    } catch (error) {
      const classification = classifyInsightRunError(error);
      const canRetry = classification.retryable && attempt < options.maxAttempts;
      store.appendRunEvent(active.id, {
        type: canRetry ? "retry_scheduled" : "error",
        status: canRetry ? "running" : classification.terminalReason === "cancelled" ? "cancelled" : "failed",
        classification: classification.failureClass,
        message: canRetry
          ? `Attempt ${attempt} failed (${classification.failureClass}); retrying`
          : `Run failed (${classification.failureClass})`,
        metadata: { attempt, maxAttempts: options.maxAttempts, error: asErrorMessage(error) },
      });

      if (canRetry) {
        active = store.updateRun(active.id, {
          lifecycle: {
            ...active.lifecycle,
            attempt: attempt + 1,
            maxAttempts: options.maxAttempts,
            failureClass: classification.failureClass,
            retryable: true,
          },
        }) ?? active;
        if (options.retryDelayMs > 0) {
          await delay(options.retryDelayMs, undefined, { signal: options.signal });
        }
        continue;
      }

      const terminalStatus = classification.terminalReason === "cancelled" ? "cancelled" : "failed";
      const terminal = store.updateRun(active.id, patchForStatus(terminalStatus, {
        status: terminalStatus,
        error: asErrorMessage(error),
        lifecycle: {
          ...active.lifecycle,
          attempt,
          maxAttempts: options.maxAttempts,
          terminalReason: classification.terminalReason,
          terminalCause: classification.terminalCause,
          failureClass: classification.failureClass,
          retryable: classification.failureClass === "retryable_transient",
          timeoutAt: classification.failureClass === "timed_out" ? new Date().toISOString() : active.lifecycle.timeoutAt,
        },
      }));
      if (!terminal) throw new Error(`Run disappeared while failing: ${active.id}`);
      return terminal;
    } finally {
      clear();
    }
  }

  const failed = store.updateRun(active.id, {
    status: "failed",
    error: "Run exhausted attempts",
    lifecycle: {
      ...active.lifecycle,
      terminalReason: "failed",
      terminalCause: "Run exhausted attempts",
      failureClass: "non_retryable",
      retryable: false,
      attempt: options.maxAttempts,
      maxAttempts: options.maxAttempts,
    },
  });
  if (!failed) throw new Error(`Run disappeared after attempts exhausted: ${active.id}`);
  return failed;
}

export async function executeInsightRunLifecycle(options: InsightRunExecutorOptions): Promise<InsightRun> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 2);
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? 250);

  let run: InsightRun;
  try {
    run = options.store.createRunOrThrowConflict(options.projectId, {
      ...options.input,
      lifecycle: {
        ...options.input.lifecycle,
        attempt: options.input.lifecycle?.attempt ?? 1,
        maxAttempts,
        rootRunId: options.input.lifecycle?.rootRunId,
      },
    });
  } catch (error) {
    if (error instanceof InsightLifecycleError && error.code === "active_run_conflict") {
      throw error;
    }
    throw error;
  }

  options.store.appendRunEvent(run.id, {
    type: "status_changed",
    status: "pending",
    message: "Run created",
  });

  return executeExistingRun(options.store, run, {
    ...options,
    maxAttempts,
    retryDelayMs,
  });
}

export async function retryInsightRunLifecycle(
  options: Omit<InsightRunExecutorOptions, "input" | "projectId"> & { runId: string; trigger?: InsightRunTrigger; inputMetadata?: InsightRunCreateInput["inputMetadata"] },
): Promise<{ run: InsightRun; retryOf: InsightRun }> {
  const original = options.store.getRun(options.runId);
  if (!original) {
    throw new Error(`Insight run not found: ${options.runId}`);
  }
  if (original.status !== "failed") {
    throw new InsightLifecycleError(`Run ${original.id} must be failed to retry`, "not_retryable");
  }
  if (!original.lifecycle.retryable || original.lifecycle.failureClass !== "retryable_transient") {
    throw new InsightLifecycleError(`Run ${original.id} is non-retryable`, "not_retryable");
  }

  const run = await executeInsightRunLifecycle({
    ...options,
    projectId: original.projectId,
    input: {
      trigger: options.trigger ?? original.trigger,
      inputMetadata: options.inputMetadata ?? original.inputMetadata,
      lifecycle: {
        retryOfRunId: original.id,
        rootRunId: original.lifecycle.rootRunId ?? original.id,
        attempt: 1,
      },
    },
  });

  return { run, retryOf: original };
}
