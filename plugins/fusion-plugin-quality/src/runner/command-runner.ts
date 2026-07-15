import { superviseSpawn } from "@fusion/core";
import type { QualityStore } from "../store/quality-store.js";
import type { TestRun, TestRunStatus } from "../store/quality-types.js";

/*
FNXC:Quality 2026-07-14-21:45:
Supervised command runner for Quality TestRuns. Uses superviseSpawn (core + packaging shim).
Hard timeout with process-group kill; truncates logs; never accepts client command/cwd.
*/

const HARD_TIMEOUT_MS = 1_800_000;

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

export async function executeQualityRun(opts: RunCommandOptions): Promise<TestRun> {
  const { store, projectId, runId, command, cwd } = opts;
  const timeoutMs = Math.min(Math.max(opts.timeoutMs, 1_000), HARD_TIMEOUT_MS);
  const startedAt = new Date().toISOString();
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
