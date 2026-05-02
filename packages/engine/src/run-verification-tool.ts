/**
 * fn_run_verification — a custom executor tool that wraps test/lint/build/typecheck
 * commands with heartbeat protection and timeout safety rails.
 *
 * Problem this solves: agents running `pnpm test` from an unbootstrapped workspace
 * root can sit silently for 20+ minutes, tripping the stuck-task-detector's
 * inactivity watchdog and killing the session. This tool:
 *
 *  - Streams stdout/stderr line-by-line and fires a heartbeat on every line so
 *    the watchdog sees continuous activity.
 *  - Emits a synthetic heartbeat every 60s even when the command is quiet.
 *  - Enforces a configurable hard timeout with SIGTERM → SIGKILL escalation.
 *  - Auto-detects a missing bootstrap (node_modules/.modules.yaml) and prepends
 *    a `pnpm install --prefer-offline` when the command is package-scoped.
 *  - Caps captured output at 200 KB, keeping head + tail on overflow.
 *
 * The core logic is in `runVerificationCommand` which is exported for unit-testing
 * without a full agent session.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { Type, type Static } from "@mariozechner/pi-ai";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { executorLog } from "./logger.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_OUTPUT_BYTES = 200 * 1024; // 200 KB
const QUIET_HEARTBEAT_INTERVAL_MS = 60_000; // emit synthetic heartbeat after 60s silence
const SIGKILL_GRACE_MS = 10_000;
const DEFAULT_TIMEOUT_PACKAGE_SEC = 300;
const DEFAULT_TIMEOUT_WORKSPACE_SEC = 900;
const MAX_TIMEOUT_SEC = 1800;

// ---------------------------------------------------------------------------
// Tool parameter schema
// ---------------------------------------------------------------------------

export const runVerificationParams = Type.Object({
  command: Type.String({
    description:
      "The shell command to run, e.g. \"pnpm --filter @fusion/droid-cli test\", \"pnpm lint\", \"pnpm build\"",
  }),
  cwd: Type.Optional(
    Type.String({
      description:
        "Working directory for the command. Defaults to the task worktree root if omitted or relative.",
    }),
  ),
  scope: Type.Union(
    [Type.Literal("package"), Type.Literal("workspace")],
    {
      description:
        "\"package\" for scoped commands like `pnpm --filter <pkg>`, \"workspace\" for root-level commands like `pnpm test`.",
    },
  ),
  timeoutSec: Type.Optional(
    Type.Number({
      description:
        "Override the default timeout in seconds. Default: 300 for package scope, 900 for workspace scope. Hard cap: 1800.",
    }),
  ),
  expectFailure: Type.Optional(
    Type.Boolean({
      description:
        "If true, a non-zero exit code is reported but not flagged as an error. Default: false.",
    }),
  ),
});

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export interface VerificationResult {
  success: boolean;
  exitCode: number | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  killed: boolean;
  command: string;
  cwd: string;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Output buffer helper — keeps head + tail within the byte cap
//
// Stores head/tail as chunk arrays rather than concatenated strings.
// The previous implementation re-encoded the entire ~100 KB tail through
// `Buffer.from(...).subarray(...).toString()` on *every* appended line once
// output crossed MAX_OUTPUT_BYTES — for a `pnpm test` run dumping 50k lines
// that produced gigabytes of GC churn and stalled the dashboard event loop.
// Now we just push chunks and only compact the tail when its byte size grows
// past 2× the cap, making the amortized cost per append O(1).
// ---------------------------------------------------------------------------

interface OutputBuffer {
  headChunks: string[];
  headBytes: number;
  tailChunks: string[];
  tailBytes: number;
  totalBytes: number;
}

function createBuffer(): OutputBuffer {
  return { headChunks: [], headBytes: 0, tailChunks: [], tailBytes: 0, totalBytes: 0 };
}

function appendToBuffer(buf: OutputBuffer, chunk: string): void {
  const chunkBytes = Buffer.byteLength(chunk, "utf8");
  buf.totalBytes += chunkBytes;

  if (buf.headBytes + chunkBytes <= MAX_OUTPUT_BYTES) {
    buf.headChunks.push(chunk);
    buf.headBytes += chunkBytes;
    return;
  }

  // Overflow: funnel into tail. Keep at most half the cap in tail, but only
  // compact when we're well over so per-line cost stays amortized O(1).
  const tailCap = MAX_OUTPUT_BYTES / 2;
  buf.tailChunks.push(chunk);
  buf.tailBytes += chunkBytes;
  if (buf.tailBytes > tailCap * 2) {
    // Drop oldest chunks until under the cap.
    while (buf.tailChunks.length > 1 && buf.tailBytes - Buffer.byteLength(buf.tailChunks[0], "utf8") >= tailCap) {
      const dropped = buf.tailChunks.shift() as string;
      buf.tailBytes -= Buffer.byteLength(dropped, "utf8");
    }
  }
}

function flattenBuffer(buf: OutputBuffer): string {
  const head = buf.headChunks.join("");
  if (buf.tailChunks.length === 0) return head;
  const tail = buf.tailChunks.join("");
  return (
    head +
    `\n\n[... output truncated — ${buf.totalBytes} bytes total, showing head + tail ...]\n\n` +
    tail
  );
}

// ---------------------------------------------------------------------------
// Core logic (exported for unit testing)
// ---------------------------------------------------------------------------

export interface RunVerificationOptions {
  command: string;
  cwd: string;
  timeoutMs: number;
  expectFailure?: boolean;
  onHeartbeat: () => void;
  onLine?: (line: string) => void;
}

/**
 * Spawns a shell command with heartbeat protection, quiet-interval synthetic
 * heartbeats, and hard timeout enforcement.
 *
 * Exported so tests can exercise the core logic without a full agent session.
 */
export async function runVerificationCommand(
  opts: RunVerificationOptions,
): Promise<VerificationResult> {
  const { command, cwd, timeoutMs, expectFailure = false, onHeartbeat, onLine } = opts;
  const startMs = Date.now();
  const warnings: string[] = [];

  const stdoutBuf = createBuffer();
  const stderrBuf = createBuffer();

  return new Promise<VerificationResult>((resolve) => {
    // Use shell: true so Node picks the platform default — /bin/sh on POSIX,
    // cmd.exe on Windows. SIGTERM/SIGKILL semantics still apply on POSIX;
    // on Windows the kill signals map to TerminateProcess.
    const child = spawn(command, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
      shell: true,
    });

    let timedOut = false;
    let killed = false;
    let settled = false;

    // ── Quiet-interval synthetic heartbeat ──────────────────────────────────
    let lastLineMs = Date.now();
    const quietTimer = setInterval(() => {
      const silenceMs = Date.now() - lastLineMs;
      if (silenceMs >= QUIET_HEARTBEAT_INTERVAL_MS) {
        executorLog.log(
          `[fn_run_verification] command quiet for ${Math.round(silenceMs / 1000)}s, still running... (${command})`,
        );
        onHeartbeat();
      }
    }, QUIET_HEARTBEAT_INTERVAL_MS);

    // ── Hard timeout ────────────────────────────────────────────────────────
    const hardTimer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      executorLog.warn(
        `[fn_run_verification] hard timeout (${timeoutMs / 1000}s) — sending SIGTERM to: ${command}`,
      );
      child.kill("SIGTERM");

      setTimeout(() => {
        if (!settled) {
          executorLog.warn(
            `[fn_run_verification] SIGTERM ignored — sending SIGKILL to: ${command}`,
          );
          child.kill("SIGKILL");
          killed = true;
        }
      }, SIGKILL_GRACE_MS);
    }, timeoutMs);

    // ── stdout ───────────────────────────────────────────────────────────────
    let stdoutRemainder = "";
    child.stdout.on("data", (chunk: Buffer) => {
      const text = stdoutRemainder + chunk.toString("utf8");
      const lines = text.split("\n");
      stdoutRemainder = lines.pop() ?? "";
      for (const line of lines) {
        const lineWithNewline = line + "\n";
        appendToBuffer(stdoutBuf, lineWithNewline);
        lastLineMs = Date.now();
        onHeartbeat();
        onLine?.(lineWithNewline);
      }
    });

    // ── stderr ───────────────────────────────────────────────────────────────
    let stderrRemainder = "";
    child.stderr.on("data", (chunk: Buffer) => {
      const text = stderrRemainder + chunk.toString("utf8");
      const lines = text.split("\n");
      stderrRemainder = lines.pop() ?? "";
      for (const line of lines) {
        const lineWithNewline = line + "\n";
        appendToBuffer(stderrBuf, lineWithNewline);
        lastLineMs = Date.now();
        onHeartbeat();
        onLine?.(lineWithNewline);
      }
    });

    // ── Process exit ─────────────────────────────────────────────────────────
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearInterval(quietTimer);
      clearTimeout(hardTimer);

      // Flush remainders
      if (stdoutRemainder) appendToBuffer(stdoutBuf, stdoutRemainder);
      if (stderrRemainder) appendToBuffer(stderrBuf, stderrRemainder);

      const exitCode = code ?? null;
      const durationMs = Date.now() - startMs;
      const zeroExit = exitCode === 0;
      const success = expectFailure ? true : zeroExit;

      if (!success && !timedOut) {
        executorLog.warn(
          `[fn_run_verification] command failed (exit=${exitCode}, signal=${signal ?? "none"}): ${command}`,
        );
      }

      resolve({
        success,
        exitCode,
        durationMs,
        stdout: flattenBuffer(stdoutBuf),
        stderr: flattenBuffer(stderrBuf),
        timedOut,
        killed,
        command,
        cwd,
        warnings,
      });
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearInterval(quietTimer);
      clearTimeout(hardTimer);
      const durationMs = Date.now() - startMs;
      warnings.push(`Spawn error: ${err.message}`);
      resolve({
        success: false,
        exitCode: null,
        durationMs,
        stdout: flattenBuffer(stdoutBuf),
        stderr: flattenBuffer(stderrBuf) + `\nSpawn error: ${err.message}`,
        timedOut: false,
        killed: false,
        command,
        cwd,
        warnings,
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

export interface CreateRunVerificationToolOpts {
  /** Root of the task's git worktree — used as the default cwd. */
  worktreePath: string;
  /** Repo root — used to check node_modules/.modules.yaml for bootstrap detection. */
  rootDir: string;
  taskId: string;
  /** Called on every output line AND on synthetic quiet-interval heartbeats. */
  recordActivity: () => void;
  log: {
    info: (s: string) => void;
    warn: (s: string) => void;
    error: (s: string) => void;
  };
}

/**
 * Build the `fn_run_verification` custom tool for the executor agent.
 *
 * Wire this into the `customTools` array alongside `createTaskDoneTool`.
 * Pass `recordActivity: () => stuckDetector?.recordActivity(task.id)`.
 */
export function createRunVerificationTool(
  opts: CreateRunVerificationToolOpts,
): ToolDefinition {
  const { worktreePath, rootDir, taskId, recordActivity, log } = opts;

  return {
    name: "fn_run_verification",
    label: "Run Verification",
    description:
      "Run a verification command (tests, lint, build, typecheck) with timeout and progress " +
      "heartbeat protection. Use this instead of bash for any pnpm/npm test/lint/build commands. " +
      "Prevents the inactivity watchdog from killing your session during long compiles.",
    parameters: runVerificationParams,
    execute: async (
      _toolCallId: string,
      params: Static<typeof runVerificationParams>,
    ) => {
      const { command, scope, expectFailure = false } = params;
      const warnings: string[] = [];

      // ── Scope / command mismatch warning ─────────────────────────────────
      if (scope === "workspace" && command.trimStart().startsWith("pnpm --filter")) {
        const msg =
          "scope is \"workspace\" but command starts with \"pnpm --filter\" — " +
          "consider using scope=\"package\" for scoped commands.";
        warnings.push(msg);
        log.warn(`[fn_run_verification] ${taskId}: ${msg}`);
      }

      // ── Resolve cwd ───────────────────────────────────────────────────────
      let resolvedCwd: string;
      if (params.cwd && isAbsolute(params.cwd)) {
        resolvedCwd = params.cwd;
      } else if (params.cwd) {
        resolvedCwd = join(worktreePath, params.cwd);
      } else {
        resolvedCwd = worktreePath;
      }

      // ── Resolve timeout ───────────────────────────────────────────────────
      const defaultTimeoutSec =
        scope === "package"
          ? DEFAULT_TIMEOUT_PACKAGE_SEC
          : DEFAULT_TIMEOUT_WORKSPACE_SEC;
      const rawTimeoutSec = params.timeoutSec ?? defaultTimeoutSec;
      const timeoutSec = Math.min(rawTimeoutSec, MAX_TIMEOUT_SEC);
      const timeoutMs = timeoutSec * 1000;

      if (rawTimeoutSec > MAX_TIMEOUT_SEC) {
        const msg = `timeoutSec ${rawTimeoutSec} exceeds hard cap of ${MAX_TIMEOUT_SEC}s — clamped.`;
        warnings.push(msg);
        log.warn(`[fn_run_verification] ${taskId}: ${msg}`);
      }

      // ── Bootstrap detection ───────────────────────────────────────────────
      // If the command is package-scoped and the workspace has no .modules.yaml,
      // prepend a pnpm install so the agent doesn't stall on missing node_modules.
      let effectiveCommand = command;
      if (command.trimStart().startsWith("pnpm --filter")) {
        const modulesYaml = join(rootDir, "node_modules", ".modules.yaml");
        if (!existsSync(modulesYaml)) {
          const installCmd = "pnpm install --prefer-offline";
          const msg =
            `node_modules/.modules.yaml not found in workspace root — ` +
            `auto-prepending \`${installCmd}\` before running the command.`;
          warnings.push(msg);
          log.warn(`[fn_run_verification] ${taskId}: ${msg}`);
          effectiveCommand = `${installCmd} && ${command}`;
        }
      }

      log.info(
        `[fn_run_verification] ${taskId}: scope=${scope} timeout=${timeoutSec}s cwd=${resolvedCwd} cmd=${effectiveCommand}`,
      );

      // ── Run ───────────────────────────────────────────────────────────────
      const result = await runVerificationCommand({
        command: effectiveCommand,
        cwd: resolvedCwd,
        timeoutMs,
        expectFailure,
        onHeartbeat: recordActivity,
      });

      // ── Merge warnings from auto-bootstrap / scope check ─────────────────
      const allWarnings = [...warnings, ...result.warnings];

      // ── Build the tool response text ──────────────────────────────────────
      const lines: string[] = [];

      if (allWarnings.length > 0) {
        lines.push(`Warnings:\n${allWarnings.map((w) => `  - ${w}`).join("\n")}\n`);
      }

      if (result.timedOut) {
        lines.push(
          `Command timed out after ${timeoutSec}s and was ${result.killed ? "killed (SIGKILL)" : "terminated (SIGTERM)"}.\n`,
        );
      }

      lines.push(`Exit code: ${result.exitCode ?? "null (signal)"}`);
      lines.push(`Duration: ${(result.durationMs / 1000).toFixed(1)}s`);
      lines.push(`Success: ${result.success}`);

      if (result.stdout.length > 0) {
        lines.push(`\n--- stdout ---\n${result.stdout}`);
      }
      if (result.stderr.length > 0) {
        lines.push(`\n--- stderr ---\n${result.stderr}`);
      }

      if (result.timedOut) {
        lines.push(
          "\nDo NOT blindly retry — investigate whether subprocesses are hung, " +
            "test loops are infinite, or dependencies are missing.",
        );
      }

      const text = lines.join("\n");

      log.info(
        `[fn_run_verification] ${taskId}: done exit=${result.exitCode} duration=${result.durationMs}ms success=${result.success}`,
      );

      return {
        content: [{ type: "text" as const, text }],
        details: {
          success: result.success,
          exitCode: result.exitCode,
          durationMs: result.durationMs,
          timedOut: result.timedOut,
          killed: result.killed,
          command: result.command,
          cwd: result.cwd,
        },
      };
    },
  };
}
