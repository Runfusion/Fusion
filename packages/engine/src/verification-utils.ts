/**
 * Shared verification utilities for running deterministic test/build commands.
 * Used by both the merger and executor verification gates.
 */
import { spawn } from "node:child_process";
import type { TaskStore, AgentRole } from "@fusion/core";

// ── Constants ──────────────────────────────────────────────────────────

export const VERIFICATION_COMMAND_MAX_BUFFER = 50 * 1024 * 1024;
export const VERIFICATION_COMMAND_TIMEOUT_MS = 600_000;
export const VERIFICATION_LOG_MAX_CHARS = 20_000;

// ── Types ──────────────────────────────────────────────────────────────

/** Result of running a single verification command */
export interface VerificationCommandResult {
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  success: boolean;
}

/** Result of running all verification commands */
export interface VerificationResult {
  testResult?: VerificationCommandResult;
  buildResult?: VerificationCommandResult;
  allPassed: boolean;
  failedCommand?: string;
}

// ── Process group exec ─────────────────────────────────────────────────

/**
 * Run a verification command with a wallclock timeout that reaps the whole
 * process group on expiry. Node's exec timeout only kills the immediate shell;
 * vitest/pnpm workers can survive and accumulate across retries. Using
 * detached + negative-pid signal terminates the full tree.
 */
export async function execWithProcessGroup(
  command: string,
  options: { cwd: string; timeout: number; maxBuffer: number; signal?: AbortSignal },
): Promise<{ stdout: string; stderr: string; bufferOverflow: boolean; aborted?: boolean }> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(Object.assign(
        new Error(`Command aborted before start: ${command}`),
        { code: "ABORT_ERR", aborted: true, stdout: "", stderr: "" },
      ));
      return;
    }

    const useProcessGroup = process.platform !== "win32";

    const child = spawn(command, {
      cwd: options.cwd,
      shell: true,
      detached: useProcessGroup,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let stdoutOverflow = false;
    let stderrOverflow = false;
    let timedOut = false;
    let aborted = false;
    let settled = false;

    const killTree = (sig: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        if (useProcessGroup) {
          process.kill(-child.pid, sig);
        } else {
          child.kill(sig);
        }
      } catch { /* group may already be gone */ }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree("SIGTERM");
      setTimeout(() => {
        if (settled) return;
        killTree("SIGKILL");
      }, 5_000).unref();
    }, options.timeout);
    timer.unref();

    const onAbort = () => {
      aborted = true;
      killTree("SIGTERM");
      setTimeout(() => {
        if (settled) return;
        killTree("SIGKILL");
      }, 5_000).unref();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdoutOverflow) return;
      if (stdout.length + chunk.length > options.maxBuffer) {
        stdoutOverflow = true;
        stdout += chunk.toString("utf-8", 0, options.maxBuffer - stdout.length);
        return;
      }
      stdout += chunk.toString("utf-8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderrOverflow) return;
      if (stderr.length + chunk.length > options.maxBuffer) {
        stderrOverflow = true;
        stderr += chunk.toString("utf-8", 0, options.maxBuffer - stderr.length);
        return;
      }
      stderr += chunk.toString("utf-8");
    });

    const finish = (err: NodeJS.ErrnoException | null, code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);

      if (aborted) {
        reject(Object.assign(
          new Error(`Command aborted: ${command}`),
          { code: "ABORT_ERR", aborted: true, stdout, stderr, killed: true },
        ));
        return;
      }
      if (timedOut) {
        reject(Object.assign(
          new Error(`Command timed out after ${options.timeout}ms: ${command}`),
          { code: "ETIMEDOUT", stdout, stderr, killed: true },
        ));
        return;
      }
      if (err) {
        reject(Object.assign(err, { stdout, stderr }));
        return;
      }
      if (code === 0) {
        resolve({ stdout, stderr, bufferOverflow: stdoutOverflow || stderrOverflow });
        return;
      }
      reject(Object.assign(
        new Error(`Command failed (exit ${code ?? signal ?? "unknown"}): ${command}`),
        { code: code ?? undefined, status: code, stdout, stderr },
      ));
    };

    child.on("error", (err) => finish(err, null, null));
    child.on("close", (code, signal) => finish(null, code, signal));
  });
}

// ── Output summarization ───────────────────────────────────────────────

export function truncateWithEllipsis(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n... (truncated)`;
}

function truncateOutput(output: string): string {
  if (output.length <= VERIFICATION_LOG_MAX_CHARS) return output;
  return `... output truncated to last ${VERIFICATION_LOG_MAX_CHARS} characters ...\n${output.slice(-VERIFICATION_LOG_MAX_CHARS)}`;
}

/**
 * Summarize verification command output for concise task log entries.
 * Extracts test failure names and summary statistics from common test runners.
 */
export function summarizeVerificationOutput(output: string, type: "test" | "build"): string {
  const lines = output.split("\n");
  let summaryLine: string | null = null;
  const failureNames = new Set<string>();

  // 1. Extract summary line
  for (const line of lines) {
    // vitest/jest: "Tests: 2 failed, 48 passed, 50 total"
    const testsMatch = line.match(/^Tests:\s*(\d+)\s+failed,\s*(\d+)\s+passed(?:,\s*(\d+)\s+total)?/i);
    if (testsMatch) {
      const failed = testsMatch[1];
      const passed = testsMatch[2];
      const total = testsMatch[3] ? `, ${testsMatch[3]} total` : "";
      summaryLine = `Tests: ${failed} failed, ${passed} passed${total}`;
      break;
    }

    // Generic: "X tests failed, Y passed, Z total"
    const genericMatch = line.match(/^(\d+)\s+tests?\s+failed,\s*(\d+)\s+passed,\s*(\d+)\s+total/i);
    if (genericMatch) {
      summaryLine = `${genericMatch[1]} tests failed, ${genericMatch[2]} passed, ${genericMatch[3]} total`;
      break;
    }

    // Various runners: "X failing" / "X failures" / "X failed"
    const failCountMatch = line.match(/^(\d+)\s+(failings?|failures?|failed)/i);
    if (failCountMatch) {
      summaryLine = `${failCountMatch[1]} ${failCountMatch[2]}`;
      break;
    }
  }

  // 2. Extract failure names (up to 5 unique names)
  const markerLines: string[] = [];
  const failLines: string[] = [];

  for (const line of lines) {
    const failMatch = line.match(/^(FAIL)\s+(.+)/);
    if (failMatch) {
      failLines.push(failMatch[2].trim());
      continue;
    }

    const trimmedLine = line.trimStart();

    const crossMatch = trimmedLine.match(/^[✗✕×]\s*(.+)/);
    if (crossMatch) {
      markerLines.push(crossMatch[1].trim());
      continue;
    }

    const bulletMatch = trimmedLine.match(/^●\s*(.+)/);
    if (bulletMatch) {
      markerLines.push(bulletMatch[1].trim());
      continue;
    }

    const dashMatch = trimmedLine.match(/^-\s+(\S[\s\S]*?)$/);
    if (dashMatch) {
      const potential = dashMatch[1].trim();
      if (/[\s›>]|(should|cannot|does|doesn|to|not|throws)/i.test(potential)) {
        markerLines.push(potential);
      }
      continue;
    }

    const assertionMatch = trimmedLine.match(/^(AssertionError|AssertionError:.*)$/i);
    if (assertionMatch) {
      markerLines.push(assertionMatch[1]);
    }
  }

  for (const name of markerLines) {
    const truncated = name.length > 120 ? name.slice(0, 120) : name;
    failureNames.add(truncated);
  }

  for (const name of failLines) {
    const truncated = name.length > 120 ? name.slice(0, 120) : name;
    failureNames.add(truncated);
  }

  // 3. Build the summary string
  const footer = "(full output available in engine logs)";

  if (type === "build") {
    const buildError = output.length > 500 ? `${output.slice(0, 500)}\n... (truncated)` : output;
    return `Build output:\n${buildError}\n${footer}`;
  }

  const parts: string[] = [];

  if (summaryLine) {
    parts.push(summaryLine);
  }

  if (failureNames.size > 0) {
    const names = Array.from(failureNames);
    if (names.length <= 5) {
      for (const name of names) {
        parts.push(`  • ${name}`);
      }
    } else {
      for (let i = 0; i < 5; i++) {
        parts.push(`  • ${names[i]}`);
      }
      parts.push(`  • ... and ${names.length - 5} more failures`);
    }
  }

  if (parts.length === 0) {
    if (output.trim().length === 0) {
      return `no output\n${footer}`;
    }
    return `${truncateOutput(output)}\n${footer}`;
  }

  return parts.join("\n") + `\n${footer}`;
}

// ── Single command runner ──────────────────────────────────────────────

/**
 * Run a single verification command (test or build) and return the result.
 * Logs progress to the task store. Uses logger for structured output.
 */
export async function runVerificationCommand(
  store: TaskStore,
  rootDir: string,
  taskId: string,
  command: string,
  type: "test" | "build",
  signal: AbortSignal | undefined,
  /** Optional logger — defaults to console */
  log?: { log: (message: string, ...args: unknown[]) => void; error: (message: string, ...args: unknown[]) => void; warn: (message: string, ...args: unknown[]) => void },
  /** Optional agent label for store log entries (e.g. "merger", "executor") */
  agentLabel?: string,
): Promise<VerificationCommandResult> {
  const logger = log ?? { log: console.log, error: console.error, warn: console.warn };
  const label = (agentLabel ?? "merger") as AgentRole;

  if (signal?.aborted) {
    throw Object.assign(
      new Error(`Command aborted before start: ${command}`),
      { code: "ABORT_ERR", aborted: true },
    );
  }

  logger.log(`${taskId}: running ${type} command: ${command}`);
  await store.logEntry(taskId, `[verification] Running ${type} command: ${command}`);
  await store.appendAgentLog(taskId, `Running ${type} command`, "tool", command, label);

  const result: VerificationCommandResult = {
    command,
    exitCode: null,
    stdout: "",
    stderr: "",
    success: false,
  };

  const verificationStartedAt = Date.now();
  try {
    const { stdout, stderr, bufferOverflow } = await execWithProcessGroup(command, {
      cwd: rootDir,
      timeout: VERIFICATION_COMMAND_TIMEOUT_MS,
      maxBuffer: VERIFICATION_COMMAND_MAX_BUFFER,
      signal,
    });

    if (signal?.aborted) {
      throw Object.assign(
        new Error(`Command aborted: ${command}`),
        { code: "ABORT_ERR", aborted: true },
      );
    }

    result.stdout = stdout?.toString?.() || "";
    result.stderr = stderr?.toString?.() || "";
    result.exitCode = 0;
    result.success = true;

    const verificationDurationMs = Date.now() - verificationStartedAt;
    const timingDetail = `${verificationDurationMs}ms`;
    if (bufferOverflow) {
      logger.log(`${taskId}: ${type} command succeeded (exit 0, output exceeded buffer) in ${verificationDurationMs}ms`);
      await store.logEntry(
        taskId,
        `[timing] [verification] ${type} command succeeded (exit 0, output exceeded buffer) in ${verificationDurationMs}ms`,
      );
      await store.appendAgentLog(
        taskId,
        `${type} command succeeded (exit 0)`,
        "tool_result",
        timingDetail,
        label,
      );
    } else {
      logger.log(`${taskId}: ${type} command succeeded in ${verificationDurationMs}ms`);
      await store.logEntry(taskId, `[timing] [verification] ${type} command succeeded (exit 0) in ${verificationDurationMs}ms`);
      await store.appendAgentLog(
        taskId,
        `${type} command succeeded (exit 0)`,
        "tool_result",
        timingDetail,
        label,
      );
    }
    return result;
  } catch (error: unknown) {
    if (signal?.aborted) {
      throw Object.assign(
        new Error(`Command aborted: ${command}`),
        { code: "ABORT_ERR", aborted: true },
      );
    }
    const verificationDurationMs = Date.now() - verificationStartedAt;
    const err = error as { stdout?: string | Buffer; stderr?: string | Buffer; status?: number; code?: number | string; message?: string };
    result.stdout = err?.stdout?.toString?.() || "";
    result.stderr = err?.stderr?.toString?.() || "";
    result.exitCode = typeof err?.status === "number"
      ? err.status
      : (typeof err?.code === "number" ? err.code : null);

    const maxBufferExceeded = err?.code === "ENOBUFS"
      || err?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
      || String(err?.message ?? "").includes("maxBuffer");
    result.success = maxBufferExceeded && result.exitCode === 0;

    if (result.success) {
      logger.log(`${taskId}: ${type} command succeeded (exit 0, output exceeded buffer) in ${verificationDurationMs}ms`);
      await store.logEntry(
        taskId,
        `[timing] [verification] ${type} command succeeded (exit 0, output exceeded buffer) in ${verificationDurationMs}ms`,
      );
      await store.appendAgentLog(
        taskId,
        `${type} command succeeded (exit 0)`,
        "tool_result",
        `${verificationDurationMs}ms`,
        label,
      );
      return result;
    }

    const output = result.stderr || result.stdout || err?.message || "Unknown error";
    const summary = summarizeVerificationOutput(output, type);
    logger.error(`${taskId}: ${type} command failed (exit ${result.exitCode}) in ${verificationDurationMs}ms; output captured in task log`);
    await store.logEntry(
      taskId,
      `[timing] [verification] ${type} command failed (exit ${result.exitCode}) after ${verificationDurationMs}ms:\n${summary}`,
    );
    await store.appendAgentLog(
      taskId,
      `${type} command failed (exit ${result.exitCode})`,
      "tool_error",
      summary,
      label,
    );
  }

  return result;
}
