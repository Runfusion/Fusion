import { superviseSpawn, type SupervisedChild } from "@fusion/core";
import type { QualityStore } from "../store/quality-store.js";
import type { TestRun, TestRunStatus } from "../store/quality-types.js";

/*
FNXC:Quality 2026-07-14-21:45:
Supervised command runner for Quality TestRuns. Uses superviseSpawn (core + packaging shim).
Hard timeout with process-group kill; truncates logs; never accepts client command/cwd.

FNXC:Quality 2026-07-14-22:10:
PR review: cancel must kill the live supervised child and completion must not overwrite
operator-cancelled status (Greptile P1 on create-routes cancel path).
*/

const HARD_TIMEOUT_MS = 1_800_000;

/** Live supervised children keyed by projectId::runId for cancel. */
const activeChildren = new Map<string, SupervisedChild>();

function activeKey(projectId: string, runId: string): string {
  return `${projectId}::${runId}`;
}

export interface RunCommandOptions {
  store: QualityStore;
  projectId: string;
  runId: string;
  command: string;
  cwd: string;
  timeoutMs: number;
  logTruncateKb: number;
  shell?: boolean;
}

function truncate(text: string, maxKb: number): string {
  const max = Math.max(1, maxKb) * 1024;
  if (text.length <= max) return text;
  return text.slice(text.length - max);
}

/**
 * Kill a live Quality run's process group and mark the row cancelled.
 * Returns the updated run, or null if not found / not active.
 */
export function cancelQualityRun(
  store: QualityStore,
  projectId: string,
  runId: string,
): TestRun | null {
  const existing = store.getRun(projectId, runId);
  if (!existing) return null;
  if (existing.status !== "queued" && existing.status !== "running") {
    return existing;
  }

  const supervised = activeChildren.get(activeKey(projectId, runId));
  if (supervised) {
    supervised.kill("SIGTERM");
    setTimeout(() => {
      supervised.kill("SIGKILL");
    }, 2_000);
    activeChildren.delete(activeKey(projectId, runId));
  }

  return store.updateRun(projectId, runId, {
    status: "cancelled",
    finishedAt: new Date().toISOString(),
    errorMessage: "Cancelled by operator",
  });
}

export async function executeQualityRun(opts: RunCommandOptions): Promise<TestRun> {
  const { store, projectId, runId, command, cwd } = opts;
  const timeoutMs = Math.min(Math.max(opts.timeoutMs, 1_000), HARD_TIMEOUT_MS);
  const startedAt = new Date().toISOString();

  // Operator may have cancelled while still queued.
  const pre = store.getRun(projectId, runId);
  if (pre?.status === "cancelled") {
    return pre;
  }

  store.updateRun(projectId, runId, { status: "running", startedAt });

  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let exitCode: number | null = null;
  let status: TestRunStatus = "error";
  let errorMessage: string | null = null;

  try {
    const supervised = superviseSpawn(command, [], {
      cwd,
      shell: opts.shell !== false,
      env: process.env,
    });
    activeChildren.set(activeKey(projectId, runId), supervised);

    const child = supervised.child;
    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout = truncate(stdout + String(chunk), opts.logTruncateKb);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr = truncate(stderr + String(chunk), opts.logTruncateKb);
    });

    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      const timer = setTimeout(() => {
        timedOut = true;
        supervised.kill("SIGTERM");
        setTimeout(() => {
          supervised.kill("SIGKILL");
        }, 2_000);
      }, timeoutMs);

      child.on("close", (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal });
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        errorMessage = err instanceof Error ? err.message : String(err);
        resolve({ code: null, signal: null });
      });
    });

    exitCode = result.code;
    if (timedOut) {
      status = "timed_out";
      errorMessage = errorMessage ?? `Timed out after ${timeoutMs}ms`;
    } else if (errorMessage) {
      status = "error";
    } else if (exitCode === 0) {
      status = "passed";
    } else {
      status = "failed";
    }
  } catch (err) {
    status = "error";
    errorMessage = err instanceof Error ? err.message : String(err);
  } finally {
    activeChildren.delete(activeKey(projectId, runId));
  }

  // Do not overwrite an operator cancel that raced with process exit.
  const current = store.getRun(projectId, runId);
  if (current?.status === "cancelled") {
    return store.updateRun(projectId, runId, {
      stdout,
      stderr,
      // keep cancelled status / finishedAt / errorMessage
    }) ?? current;
  }

  const finishedAt = new Date().toISOString();
  const durationMs = Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt));
  const updated = store.updateRun(projectId, runId, {
    status,
    exitCode,
    errorMessage,
    finishedAt,
    durationMs,
    stdout,
    stderr,
  });
  if (!updated) {
    throw new Error(`Quality run ${runId} missing after execution`);
  }
  return updated;
}

export function defaultTimeoutMs(verificationCommandTimeoutMs?: number): number {
  if (typeof verificationCommandTimeoutMs === "number" && verificationCommandTimeoutMs > 0) {
    return Math.min(verificationCommandTimeoutMs, HARD_TIMEOUT_MS);
  }
  return 300_000;
}

/** Test helper: clear live child registry. */
export function __clearActiveQualityRunsForTests(): void {
  activeChildren.clear();
}
