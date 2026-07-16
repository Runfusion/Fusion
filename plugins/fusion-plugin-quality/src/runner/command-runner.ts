import { superviseSpawn } from "@fusion/core";
import type { QualityStoreApi } from "../store/quality-store-api.js";
import type { TestRun, TestRunStatus } from "../store/quality-types.js";

/*
FNXC:Quality 2026-07-14-21:45:
Supervised command runner for Quality TestRuns. Uses superviseSpawn (core + packaging shim).
Hard timeout with process-group kill; truncates logs; never accepts client command/cwd.

FNXC:QualityPostgres 2026-07-16-09:03:
Store mutations are async (PostgreSQL AsyncDataLayer). Never assume a sync SQLite store.

FNXC:Quality 2026-07-16-09:20:
PR #2230 review: register a cancel slot BEFORE the running write so cancel mid-await
still kills the eventual process; finalizeRun so a late cancel is not overwritten.
*/

const HARD_TIMEOUT_MS = 1_800_000;

type ActiveQualityRun = {
  kill: (signal?: NodeJS.Signals | number) => void;
};

const activeQualityRuns = new Map<string, ActiveQualityRun>();

function activeRunKey(projectId: string, runId: string): string {
  return `${projectId}:${runId}`;
}

/*
FNXC:Quality 2026-07-15-13:05:
Operator cancellation is a process-control action, not only a database update.
Keep each live supervisor by project/run so the cancel route can terminate its
process group, while the runner's final write preserves the cancelled terminal
state if the child closes after that request.
*/
export async function cancelQualityRun(
  store: QualityStoreApi,
  projectId: string,
  runId: string,
): Promise<TestRun | null> {
  const current = await store.getRun(projectId, runId);
  if (!current || (current.status !== "queued" && current.status !== "running")) return current;

  activeQualityRuns.get(activeRunKey(projectId, runId))?.kill("SIGTERM");
  return store.updateRun(projectId, runId, {
    status: "cancelled",
    finishedAt: new Date().toISOString(),
    errorMessage: "Cancelled by operator",
  });
}

export function __clearActiveQualityRunsForTests(): void {
  activeQualityRuns.clear();
}

export function __registerActiveQualityRunForTests(projectId: string, runId: string, run: ActiveQualityRun): void {
  activeQualityRuns.set(activeRunKey(projectId, runId), run);
}

export interface RunCommandOptions {
  store: QualityStoreApi;
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

export async function executeQualityRun(opts: RunCommandOptions): Promise<TestRun> {
  const { store, projectId, runId, command, cwd } = opts;
  const timeoutMs = Math.min(Math.max(opts.timeoutMs, 1_000), HARD_TIMEOUT_MS);
  const startedAt = new Date().toISOString();
  const key = activeRunKey(projectId, runId);

  /*
  Cancel slot must exist before the awaited running write. A cancel in that
  window sets a flag (and later kills the real supervisor once registered).
  */
  let cancelRequested = false;
  let supervised: ReturnType<typeof superviseSpawn> | undefined;
  activeQualityRuns.set(key, {
    kill: (signal) => {
      cancelRequested = true;
      supervised?.kill(signal);
    },
  });

  await store.updateRun(projectId, runId, { status: "running", startedAt });

  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let exitCode: number | null = null;
  let status: TestRunStatus = "error";
  let errorMessage: string | null = null;

  try {
    if (cancelRequested) {
      status = "cancelled";
      errorMessage = "Cancelled by operator";
    } else {
      supervised = superviseSpawn(command, [], {
        cwd,
        shell: opts.shell !== false,
        env: process.env,
      });
      activeQualityRuns.set(key, supervised);

      if (cancelRequested) {
        supervised.kill("SIGTERM");
      }

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
          supervised?.kill("SIGTERM");
          setTimeout(() => {
            supervised?.kill("SIGKILL");
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
      if (cancelRequested) {
        status = "cancelled";
        errorMessage = "Cancelled by operator";
      } else if (timedOut) {
        status = "timed_out";
        errorMessage = errorMessage ?? `Timed out after ${timeoutMs}ms`;
      } else if (errorMessage) {
        status = "error";
      } else if (exitCode === 0) {
        status = "passed";
      } else {
        status = "failed";
      }
    }
  } catch (err) {
    status = "error";
    errorMessage = err instanceof Error ? err.message : String(err);
  }

  const finishedAt = new Date().toISOString();
  const durationMs = Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt));
  const updated = await store.finalizeRun(projectId, runId, {
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
  activeQualityRuns.delete(key);
  return updated;
}

export function defaultTimeoutMs(verificationCommandTimeoutMs?: number): number {
  if (typeof verificationCommandTimeoutMs === "number" && verificationCommandTimeoutMs > 0) {
    return Math.min(verificationCommandTimeoutMs, HARD_TIMEOUT_MS);
  }
  return 300_000;
}
