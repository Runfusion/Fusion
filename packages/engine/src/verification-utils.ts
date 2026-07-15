/**
 * Shared verification utilities for running deterministic test/build commands.
 * Used by both the merger and executor verification gates.
 */
import type { TaskStore, AgentRole } from "@fusion/core";
import { resolveSandboxBackend } from "./sandbox/index.js";
import type { SandboxBackend, SandboxRunStreamingOptions, SandboxStreamingResult } from "./sandbox/index.js";
import {
  setMaxConcurrentVerifications,
  withVerificationSlot,
} from "./verification-concurrency.js";

// ── Constants ──────────────────────────────────────────────────────────

export const VERIFICATION_COMMAND_MAX_BUFFER = 50 * 1024 * 1024;
/**
 * Legacy flat default. Retained for back-compat; the merger/executor gate now
 * derives its default from command scope (see VERIFICATION_TIMEOUT_*_MS below).
 */
export const VERIFICATION_COMMAND_TIMEOUT_MS = 600_000;
export const VERIFICATION_COMMAND_HARD_CAP_MS = 1_800_000;
export const VERIFICATION_LOG_MAX_CHARS = 20_000;

/*
FNXC:Verification 2026-06-25-13:55:
The merger/executor verification gate used a flat 10-min default for ANY configured
test/build command, while the fn_run_verification tool already derived its default
from command scope. A workspace-scoped command (a full suite, ~10+ min) hit the flat
10-min wall and was killed as an infra timeout; a package-scoped command got a too-
generous bound. Make the shared runner scope-aware to match the tool: a package-scoped
command (pnpm --filter/-F ...) defaults to 300s, anything else (root/workspace command)
to 900s. An explicit project verificationCommandTimeoutMs still overrides, and the 30-min
hard cap (VERIFICATION_COMMAND_HARD_CAP_MS) still clamps the result. These mirror
run-verification-tool's DEFAULT_TIMEOUT_PACKAGE_SEC (300) / DEFAULT_TIMEOUT_WORKSPACE_SEC (900).
*/
export const VERIFICATION_TIMEOUT_PACKAGE_MS = 300_000;
export const VERIFICATION_TIMEOUT_WORKSPACE_MS = 900_000;

/**
 * Classify a configured verification command by scope. A command that targets a
 * single workspace package via pnpm's `--filter`/`-F` is "package"-scoped; every
 * other shape (a root-level command such as `pnpm test`) is "workspace"-scoped.
 */
export function classifyVerificationScope(command: string): "package" | "workspace" {
  const tokens = command.split(/\s+/).filter(Boolean);
  return tokens.some((token) => token === "--filter" || token === "-F") ? "package" : "workspace";
}

/**
 * The default per-command verification budget for a command when no explicit
 * project `verificationCommandTimeoutMs` override is provided — scope-aware,
 * matching the fn_run_verification tool.
 */
export function defaultVerificationTimeoutMs(command: string): number {
  return classifyVerificationScope(command) === "package"
    ? VERIFICATION_TIMEOUT_PACKAGE_MS
    : VERIFICATION_TIMEOUT_WORKSPACE_MS;
}

// ── Types ──────────────────────────────────────────────────────────────

/** Result of running a single verification command */
export interface VerificationCommandResult {
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  success: boolean;
  /** True when this result was satisfied from the verification cache rather than running the command. */
  cached?: boolean;
  /**
   * True when the command was terminated by the wallclock timeout rather than
   * producing a real test/build verdict. Lets callers tell an *infrastructure*
   * failure (timeout) apart from a genuinely failing test (`success === false`
   * with a real exit code).
   */
  timedOut?: boolean;
  /**
   * True when the command was aborted via the supplied `AbortSignal`. Like
   * {@link timedOut}, this is an infra outcome, not behavioral evidence.
   */
  aborted?: boolean;
  /**
   * True when the command could not be executed at all (spawn/setup failure,
   * sandbox error) — distinct from a command that ran and exited non-zero. An
   * infra outcome, not behavioral evidence.
   */
  executionError?: boolean;
}

/** Result of running all verification commands */
export interface VerificationResult {
  testResult?: VerificationCommandResult;
  buildResult?: VerificationCommandResult;
  allPassed: boolean;
  failedCommand?: string;
  environmentFault?: {
    kind: "missing-workspace-entry";
    packageName: string;
    recovered: boolean;
  };
}

// ── Process group exec ─────────────────────────────────────────────────

/**
 * Run a verification command with a wallclock timeout that reaps the whole
 * process group on expiry. Node's exec timeout only kills the immediate shell;
 * vitest/pnpm workers can survive and accumulate across retries. Using
 * detached + negative-pid signal terminates the full tree.
 */
function getSandboxBackend(): SandboxBackend {
  return resolveSandboxBackend();
}

function toLegacyExecResult(
  command: string,
  streamingResult: SandboxStreamingResult,
): { stdout: string; stderr: string; bufferOverflow: boolean; aborted?: boolean } {
  if (streamingResult.outcome === "success") {
    return {
      stdout: streamingResult.stdout,
      stderr: streamingResult.stderr,
      bufferOverflow: streamingResult.bufferOverflow,
    };
  }

  if (streamingResult.outcome === "non-zero-exit") {
    throw Object.assign(
      new Error(`Command failed (exit ${streamingResult.exitCode ?? streamingResult.signal ?? "unknown"}): ${command}`),
      {
        code: streamingResult.exitCode ?? undefined,
        status: streamingResult.exitCode,
        stdout: streamingResult.stdout,
        stderr: streamingResult.stderr,
      },
    );
  }

  if (streamingResult.outcome === "timeout") {
    throw Object.assign(
      new Error(`Command timed out after ${streamingResult.timeoutMs}ms: ${command}`),
      {
        code: "ETIMEDOUT",
        stdout: streamingResult.stdout,
        stderr: streamingResult.stderr,
        killed: true,
      },
    );
  }

  if (streamingResult.outcome === "aborted") {
    if (streamingResult.phase === "pre-start") {
      throw Object.assign(
        new Error(`Command aborted before start: ${command}`),
        { code: "ABORT_ERR", aborted: true, stdout: "", stderr: "" },
      );
    }

    throw Object.assign(
      new Error(`Command aborted: ${command}`),
      {
        code: "ABORT_ERR",
        aborted: true,
        stdout: streamingResult.stdout,
        stderr: streamingResult.stderr,
        killed: true,
      },
    );
  }

  throw Object.assign(streamingResult.error, {
    stdout: streamingResult.stdout,
    stderr: streamingResult.stderr,
  });
}

/**
 * Run a verification command with a wallclock timeout that reaps the whole
 * process group on expiry. Node's exec timeout only kills the immediate shell;
 * vitest/pnpm workers can survive and accumulate across retries. Using
 * detached + negative-pid signal terminates the full tree.
 */
export async function execWithProcessGroup(
  command: string,
  options: SandboxRunStreamingOptions,
  /**
   * Explicit sandbox backend to run under. When omitted, falls back to the
   * process-global resolution. Callers that must pin an isolating backend under
   * concurrency (e.g. mission behavioral verification) pass it explicitly so they
   * never depend on mutable global state.
   */
  backend: SandboxBackend = getSandboxBackend(),
): Promise<{ stdout: string; stderr: string; bufferOverflow: boolean; aborted?: boolean }> {
  const result = await backend.runStreaming(command, options);
  return toLegacyExecResult(command, result);
}

// ── Output summarization ───────────────────────────────────────────────

export function truncateWithEllipsis(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n... (truncated)`;
}

export function detectMissingWorkspaceEntry(stderr: string, stdout?: string): { packageName: string } | null {
  const pattern = /Failed to resolve entry for package\s+"(@fusion\/[a-z0-9-]+|@fusion-plugin-examples\/[a-z0-9-]+)"/;
  const stderrMatch = stderr.match(pattern);
  if (stderrMatch) {
    return { packageName: stderrMatch[1] };
  }

  if (stdout) {
    const stdoutMatch = stdout.match(pattern);
    if (stdoutMatch) {
      return { packageName: stdoutMatch[1] };
    }
  }

  return null;
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
  /** Optional extra environment variables to inject into the child process (merged over process.env). */
  extraEnv?: NodeJS.ProcessEnv,
  /** Optional project-level per-command timeout override in milliseconds. Values <= 0 preserve the legacy default. */
  timeoutMsOverride?: number,
  /**
   * Optional explicit sandbox backend. When omitted, the process-global backend
   * is resolved. Pass this to pin an isolating backend without mutating global
   * state (required for safe concurrent verification — see mission-verification).
   */
  backend?: SandboxBackend,
): Promise<VerificationCommandResult> {
  /*
  FNXC:VerificationConcurrency 2026-07-15-03:35:
  Merge/mission verification shares the process-wide verification slot with fn_run_verification so stacked monorepo builds cannot run unbounded across concurrent tasks.
  */
  try {
    const settings = await store.getSettings();
    setMaxConcurrentVerifications(settings.maxConcurrentVerifications ?? 1);
  } catch {
    // Best-effort; keep default limit 1.
  }
  return withVerificationSlot(() =>
    runVerificationCommandUnlocked(
      store,
      rootDir,
      taskId,
      command,
      type,
      signal,
      log,
      agentLabel,
      extraEnv,
      timeoutMsOverride,
      backend,
    ),
  );
}

async function runVerificationCommandUnlocked(
  store: TaskStore,
  rootDir: string,
  taskId: string,
  command: string,
  type: "test" | "build",
  signal: AbortSignal | undefined,
  log?: { log: (message: string, ...args: unknown[]) => void; error: (message: string, ...args: unknown[]) => void; warn: (message: string, ...args: unknown[]) => void },
  agentLabel?: string,
  extraEnv?: NodeJS.ProcessEnv,
  timeoutMsOverride?: number,
  backend?: SandboxBackend,
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
  /*
   * FNXC:Verification 2026-06-17-14:38:
   * Configured test/build commands share the same project verification budget as fn_run_verification so merge/step verification cannot run marathon subprocesses outside the engine-level guardrail.
   * FNXC:Verification 2026-06-25-13:55:
   * The default is now scope-aware (defaultVerificationTimeoutMs): package-scoped commands get 300s, workspace-scoped 900s — matching the tool — instead of a flat 10-min budget that killed workspace-scoped suites as infra timeouts.
   */
  const rawTimeoutMs = typeof timeoutMsOverride === "number" && timeoutMsOverride > 0
    ? timeoutMsOverride
    : defaultVerificationTimeoutMs(command);
  const timeoutMs = Math.min(rawTimeoutMs, VERIFICATION_COMMAND_HARD_CAP_MS);
  try {
    const { stdout, stderr, bufferOverflow } = await execWithProcessGroup(
      command,
      {
        cwd: rootDir,
        timeout: timeoutMs,
        maxBuffer: VERIFICATION_COMMAND_MAX_BUFFER,
        signal,
        ...(extraEnv !== undefined && { env: extraEnv }),
      },
      backend ?? getSandboxBackend(),
    );

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

    // Classify infra outcomes so callers can tell a timeout/abort/setup failure
    // apart from a real failing test (a command that ran and exited non-zero).
    // A real test failure carries a numeric exit code; these do not.
    if (!result.success && !maxBufferExceeded) {
      const errish = err as { code?: number | string; killed?: boolean; aborted?: boolean };
      if (errish.code === "ETIMEDOUT" || (errish.killed && result.exitCode === null)) {
        result.timedOut = true;
      } else if (errish.code === "ABORT_ERR" || errish.aborted) {
        result.aborted = true;
      } else if (result.exitCode === null) {
        // No exit code and not a recognized success → the command could not be
        // run to a real verdict (spawn/setup/sandbox error), not a test failure.
        result.executionError = true;
      }
    }

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
