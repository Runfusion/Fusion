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

import { superviseSpawn, type SupervisedChild } from "@fusion/core";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { Type, type Static } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { executorLog } from "./logger.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_OUTPUT_BYTES = 200 * 1024; // 200 KB
const QUIET_HEARTBEAT_INTERVAL_MS = 60_000; // emit synthetic heartbeat after 60s silence
const SIGKILL_GRACE_MS = 10_000;
const NORMAL_EXIT_REAP_GRACE_MS = 500;
export const DEFAULT_TIMEOUT_PACKAGE_SEC = 300;
export const DEFAULT_TIMEOUT_WORKSPACE_SEC = 900;
export const MAX_TIMEOUT_SEC = 1800;

/*
FNXC:Verification 2026-06-21-12:05:
Verification must stay bounded — never run the full workspace test suite as the verification path.
A foundational-package edit reverse-expands a full run across the whole workspace and stalls the task (see FN-5048 + the test-changed reverse-dependent blast cap); scope verification to the changed files/package instead.
*/
export const BOUNDED_VERIFICATION_GUIDANCE =
  "Scope verification to the changed files: prefer a bounded targeted command such as `pnpm --filter <pkg> exec vitest run src/path/to/test.ts --silent=passed-only --reporter=dot`. Do NOT run the full workspace test suite (`pnpm test:full`, `pnpm verify:workspace`, or whole-package `pnpm --filter <pkg> test`) as verification.";
export const MARATHON_SOFT_CAP_SEC = 120;

const packageDirCache = new Map<string, string | null>();

function shellSplit(input: string): string[] | null {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;
  let escaped = false;

  for (const char of input) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (escaped) current += "\\";
  if (quote !== null) return null;
  if (current.length > 0) tokens.push(current);
  return tokens;
}

function isPnpmToken(token: string): boolean {
  return token === "pnpm" || token.endsWith("/pnpm");
}

function tokenLooksLikeTestFile(token: string): boolean {
  return /\.(test|spec)\.[cm]?[tj]sx?$/.test(token);
}

function tokenLooksLikeFileScopedVitest(tokens: string[]): boolean {
  const vitestIndex = tokens.findIndex((token) => token === "vitest" || token.endsWith("/vitest"));
  if (vitestIndex < 0) return false;
  const runIndex = tokens.indexOf("run", vitestIndex + 1);
  if (runIndex < 0) return false;
  return tokens.slice(runIndex + 1).some((token) => !token.startsWith("-") && tokenLooksLikeTestFile(token));
}

function tokenLooksLikeForwardedTestFile(tokens: string[]): boolean {
  const runIndex = tokens.indexOf("--run");
  if (runIndex < 0) return false;
  return tokens.slice(runIndex + 1).some((token) => !token.startsWith("-") && tokenLooksLikeTestFile(token));
}

function isRootPnpmTest(tokens: string[]): boolean {
  if (tokens.length < 2 || !isPnpmToken(tokens[0])) return false;
  const nonFlagTokens = tokens.slice(1).filter((token) => token !== "-w" && token !== "--workspace-root");
  return (nonFlagTokens.length === 1 && nonFlagTokens[0] === "test")
    || (nonFlagTokens.length === 2 && nonFlagTokens[0] === "run" && nonFlagTokens[1] === "test");
}

export interface MarathonDetection {
  isMarathon: boolean;
  reason?: string;
  guidance: string;
}

export function detectMarathonVerification(command: string, scope?: "package" | "workspace"): MarathonDetection {
  const guidance = `${BOUNDED_VERIFICATION_GUIDANCE} Use allowFullSuite: true only when a genuinely full run is required.`;
  const compact = command.replace(/\s+/g, " ").trim();
  const tokens = shellSplit(command) ?? [];

  /*
   * FNXC:Verification 2026-06-17-14:48:
   * Marathon detection is intentionally token/regex based so it catches the costly invocation shapes that caused stuck-loop requeues without executing shell expansions.
   * Positive patterns: root `pnpm test`/`pnpm -w test`, `test:full`, `verify:workspace`, whole-package `pnpm --filter <pkg> test`, and loop/repeat wrappers around pnpm/npm/vitest test runners.
   */
  if (tokens.length > 0 && isRootPnpmTest(tokens)) {
    return { isMarathon: true, reason: "root workspace test suite (`pnpm test`) is a marathon verification command", guidance };
  }

  if (/\bpnpm\b(?:\s+[-\w=:@/.]+)*\s+(?:run\s+)?(?:test:full|verify:workspace)\b/.test(compact)) {
    return { isMarathon: true, reason: "full workspace verification script is a marathon command", guidance };
  }

  const filterIndex = tokens.findIndex((token) => token === "--filter" || token === "-F");
  if (tokens.length > 0 && isPnpmToken(tokens[0]) && filterIndex >= 0) {
    const afterFilter = tokens.slice(filterIndex + 2);
    const scriptToken = afterFilter.find((token) => token !== "--");
    const runsTestScript = scriptToken === "test" || (afterFilter[0] === "run" && afterFilter[1] === "test");
    if (runsTestScript && !tokenLooksLikeFileScopedVitest(tokens) && !tokenLooksLikeForwardedTestFile(tokens)) {
      return { isMarathon: true, reason: "whole-package test script has no file-scoped vitest run filter", guidance };
    }
  }

  if (/\b(for|while)\b[\s\S]*\bdo\b[\s\S]*\b(pnpm|npm|vitest)\b[\s\S]*\b(test|vitest)\b/.test(command)) {
    return { isMarathon: true, reason: "shell loop repeats a test runner", guidance };
  }

  if (/\bseq\b[\s\S]*\|[\s\S]*\bxargs\b[\s\S]*\b(pnpm|npm|vitest)\b[\s\S]*\b(test|vitest)\b/.test(command)) {
    return { isMarathon: true, reason: "seq/xargs pipeline repeats a test runner", guidance };
  }

  const chainedTestRuns = compact.split(/\s*&&\s*/).filter((part) => /\b(pnpm|npm|vitest)\b.*\b(test|vitest)\b/.test(part));
  if (chainedTestRuns.length > 1) {
    return { isMarathon: true, reason: "&& chain repeats test runner invocations", guidance };
  }

  if (scope === "workspace" && /\bpnpm\b\s+(?:run\s+)?test\b/.test(compact) && !tokenLooksLikeFileScopedVitest(tokens)) {
    return { isMarathon: true, reason: "workspace-scoped test command is likely a full suite", guidance };
  }

  return { isMarathon: false, guidance };
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function findWorkspacePackageDir(rootDir: string, packageName: string): string | null {
  const cacheKey = `${rootDir}\0${packageName}`;
  if (packageDirCache.has(cacheKey)) return packageDirCache.get(cacheKey) ?? null;

  const lastSegment = packageName.split("/").pop();
  const candidates = [
    lastSegment ? `packages/${lastSegment}` : "",
    lastSegment === "fusion" ? "packages/cli" : "",
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const pkg = JSON.parse(readFileSync(join(rootDir, candidate, "package.json"), "utf8")) as { name?: string };
      if (pkg.name === packageName) {
        packageDirCache.set(cacheKey, candidate);
        return candidate;
      }
    } catch {
      // Keep looking.
    }
  }

  const queue: Array<{ dir: string; depth: number }> = [
    { dir: "packages", depth: 0 },
    { dir: "plugins", depth: 0 },
  ];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    const abs = join(rootDir, current.dir);
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      const child = join(current.dir, entry.name);
      try {
        const pkg = JSON.parse(readFileSync(join(rootDir, child, "package.json"), "utf8")) as { name?: string };
        if (pkg.name === packageName) {
          packageDirCache.set(cacheKey, child);
          return child;
        }
      } catch {
        if (current.depth < 3) queue.push({ dir: child, depth: current.depth + 1 });
      }
    }
  }

  packageDirCache.set(cacheKey, null);
  return null;
}

function toPackageRelativeFilter(token: string, rootDir: string, packageDir: string): string {
  const normalizedPackageDir = packageDir.replace(/\\/g, "/");
  const normalized = token.replace(/\\/g, "/").replace(/^\.\//, "");

  if (normalized.startsWith(`${normalizedPackageDir}/`)) {
    return normalized.slice(normalizedPackageDir.length + 1);
  }

  if (isAbsolute(token)) {
    const rel = relative(join(rootDir, packageDir), token).replace(/\\/g, "/");
    if (!rel.startsWith("../") && rel !== "..") return rel;
  }

  return token;
}

export function normalizeVerificationCommand(command: string, rootDir: string): { command: string; warnings: string[] } {
  const tokens = shellSplit(command);
  const warnings: string[] = [];
  if (!tokens) return { command, warnings };
  if (tokens[0] !== "pnpm") return { command, warnings };

  const filterIndex = tokens.findIndex((token) => token === "--filter" || token === "-F");
  if (filterIndex < 0 || !tokens[filterIndex + 1]) return { command, warnings };
  const packageName = tokens[filterIndex + 1]!;
  const separatorIndex = tokens.indexOf("--");
  if (separatorIndex < 0) return { command, warnings };

  const scriptTokens = tokens.slice(filterIndex + 2, separatorIndex);
  const runsTestScript =
    scriptTokens.includes("test")
    || (scriptTokens[0] === "run" && scriptTokens[1] === "test");
  if (!runsTestScript) return { command, warnings };

  const forwarded = tokens.slice(separatorIndex + 1);
  if (!forwarded.includes("--run")) return { command, warnings };

  const packageDir = findWorkspacePackageDir(rootDir, packageName);
  if (!packageDir) return { command, warnings };

  const vitestArgs = forwarded
    .filter((token) => token !== "--run")
    .map((token) => (
      token.startsWith("-")
        ? token
        : toPackageRelativeFilter(token, rootDir, packageDir)
    ));

  const hasReporter = vitestArgs.some((token) => token === "--reporter" || token.startsWith("--reporter="));
  const hasSilent = vitestArgs.some((token) => token === "--silent" || token.startsWith("--silent="));
  const pnpmGlobalFlags = tokens.slice(1, filterIndex);
  const normalizedTokens = [
    "pnpm",
    ...pnpmGlobalFlags,
    "--filter",
    packageName,
    "exec",
    "vitest",
    "run",
    ...vitestArgs,
    ...(hasSilent ? [] : ["--silent=passed-only"]),
    ...(hasReporter ? [] : ["--reporter=dot"]),
  ];
  const normalizedCommand = normalizedTokens.map(shellQuote).join(" ");

  if (normalizedCommand !== command) {
    warnings.push(
      "rewrote package test file filter to direct vitest execution so package test scripts do not expand into broad quality suites",
    );
  }

  return { command: normalizedCommand, warnings };
}

function killVerificationProcess(supervised: SupervisedChild, signal: NodeJS.Signals): void {
  supervised.kill(signal);
}

function reapVerificationProcessGroup(supervised: SupervisedChild): void {
  /*
   * FNXC:Verification 2026-06-21-10:00:
   * Verification commands may spawn background test/dev children and then let the shell exit cleanly.
   * Reap the process group after normal close so fn_run_verification does not report completion while orphaned test workers keep later task progress stuck.
   *
   * FNXC:Verification 2026-06-21-10:26:
   * Apply this reap to every non-timeout close, including externally signal-terminated exits.
   * The supervisor kill path tolerates already-gone process groups, and the extra reap keeps all non-timeout exits from leaking background verification workers.
   */
  killVerificationProcess(supervised, "SIGTERM");
  const forceKillTimer = setTimeout(() => {
    killVerificationProcess(supervised, "SIGKILL");
  }, NORMAL_EXIT_REAP_GRACE_MS);
  forceKillTimer.unref?.();
}

export function __testOnlyReapVerificationProcessGroup(supervised: SupervisedChild): void {
  reapVerificationProcessGroup(supervised);
}

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
        "Override the default timeout in seconds. Default: project verificationCommandTimeoutMs when set, otherwise 300 for package scope and 900 for workspace scope. Hard cap: 1800.",
    }),
  ),
  allowFullSuite: Type.Optional(
    Type.Boolean({
      description:
        "Explicit opt-in for marathon verification commands such as pnpm test, pnpm test:full, verify:workspace, whole-package tests, or repeat loops. Default: false; still respects the hard timeout.",
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
    const supervised = superviseSpawn(command, [], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        // Corepack otherwise prompts interactively before fetching a pinned
        // packageManager version, which hangs the non-TTY child until the
        // hard timeout. Disable the prompt so it proceeds (or errors fast).
        COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
      },
      shell: true,
      killGraceMs: SIGKILL_GRACE_MS,
      maxLifetimeMs: timeoutMs > 0 ? timeoutMs + SIGKILL_GRACE_MS + 1_000 : undefined,
    });
    const child = supervised.child;

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
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    const hardTimer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      executorLog.warn(
        `[fn_run_verification] hard timeout (${timeoutMs / 1000}s) — sending SIGTERM to: ${command}`,
      );
      killVerificationProcess(supervised, "SIGTERM");

      killTimer = setTimeout(() => {
        if (!settled) {
          executorLog.warn(
            `[fn_run_verification] SIGTERM ignored — sending SIGKILL to: ${command}`,
          );
          killVerificationProcess(supervised, "SIGKILL");
          killed = true;
        }
      }, SIGKILL_GRACE_MS);
    }, timeoutMs);

    // ── stdout ───────────────────────────────────────────────────────────────
    let stdoutRemainder = "";
    child.stdout?.on("data", (chunk: Buffer) => {
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
    child.stderr?.on("data", (chunk: Buffer) => {
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
      if (killTimer) clearTimeout(killTimer);

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
      if (!timedOut) {
        reapVerificationProcessGroup(supervised);
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
      if (killTimer) clearTimeout(killTimer);
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
  /** Project-level default timeout budget in milliseconds. Values <= 0 disable the override and preserve legacy per-scope defaults. */
  verificationCommandTimeoutMs?: number;
  /**
   * FNXC:Reliability 2026-06-17-16:12:
   * FN-6598 brackets fn_run_verification subprocesses so the stuck detector treats bounded, actively running verification as progress instead of no-progress loop churn.
   */
  onVerificationStart?: (timeoutMs: number) => void;
  /**
   * FNXC:Reliability 2026-06-17-16:12:
   * The end signal must fire from a finally block on success, failure, timeout, and spawn errors so detector suppression cannot leak after a verification command exits.
   */
  onVerificationEnd?: () => void;
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
  const { worktreePath, rootDir, taskId, recordActivity, verificationCommandTimeoutMs, onVerificationStart, onVerificationEnd, log } = opts;

  return {
    name: "fn_run_verification",
    label: "Run Verification",
    description:
      "Run a verification command (tests, lint, build, typecheck) with timeout and progress " +
      "heartbeat protection. Verification is bounded by default: project verificationCommandTimeoutMs when set, " +
      "otherwise 300s for package scope and 900s for workspace scope, with an 1800s hard cap. " +
      "Marathon invocations (pnpm test, test:full, verify:workspace, whole-package tests, repeat loops) " +
      "are soft-capped unless allowFullSuite=true is explicitly provided. Use this instead of bash for any " +
      "pnpm/npm test/lint/build commands.",
    parameters: runVerificationParams,
    execute: async (
      _toolCallId: string,
      params: Static<typeof runVerificationParams>,
    ) => {
      const { command, scope, allowFullSuite = false, expectFailure = false } = params;
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
      /*
       * FNXC:Verification 2026-06-17-14:31:
       * Engine-level default verification budgets replace per-task "Verification Bounds" prose.
       * A positive project setting overrides both scope defaults; undefined or 0 preserves the legacy package/workspace defaults so existing builds do not silently lose runtime.
       */
      const scopeDefaultTimeoutSec =
        scope === "package"
          ? DEFAULT_TIMEOUT_PACKAGE_SEC
          : DEFAULT_TIMEOUT_WORKSPACE_SEC;
      const configuredDefaultTimeoutSec =
        typeof verificationCommandTimeoutMs === "number" && verificationCommandTimeoutMs > 0
          ? Math.ceil(verificationCommandTimeoutMs / 1000)
          : undefined;
      const defaultTimeoutSec = configuredDefaultTimeoutSec ?? scopeDefaultTimeoutSec;
      let rawTimeoutSec = params.timeoutSec ?? defaultTimeoutSec;
      const marathon = detectMarathonVerification(command, scope);
      if (marathon.isMarathon && !allowFullSuite && rawTimeoutSec > MARATHON_SOFT_CAP_SEC) {
        const msg = `marathon verification detected (${marathon.reason}); soft-capping timeout to ${MARATHON_SOFT_CAP_SEC}s. ${marathon.guidance}`;
        warnings.push(msg);
        log.warn(`[fn_run_verification] ${taskId}: ${msg}`);
        rawTimeoutSec = MARATHON_SOFT_CAP_SEC;
      } else if (marathon.isMarathon && allowFullSuite) {
        const msg = `allowFullSuite=true acknowledged for marathon verification (${marathon.reason}); subprocess still sends verification heartbeats and respects the ${MAX_TIMEOUT_SEC}s hard cap.`;
        warnings.push(msg);
        log.warn(`[fn_run_verification] ${taskId}: ${msg}`);
      }
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
      const normalized = normalizeVerificationCommand(effectiveCommand, rootDir);
      if (normalized.command !== effectiveCommand) {
        effectiveCommand = normalized.command;
        warnings.push(...normalized.warnings);
      }

      if (effectiveCommand.trimStart().startsWith("pnpm --filter")) {
        const modulesYaml = join(rootDir, "node_modules", ".modules.yaml");
        if (!existsSync(modulesYaml)) {
          const installCmd = "pnpm install --prefer-offline";
          const msg =
            `node_modules/.modules.yaml not found in workspace root — ` +
            `auto-prepending \`${installCmd}\` before running the command.`;
          warnings.push(msg);
          log.warn(`[fn_run_verification] ${taskId}: ${msg}`);
          effectiveCommand = `${installCmd} && ${effectiveCommand}`;
        }
      }

      log.info(
        `[fn_run_verification] ${taskId}: scope=${scope} timeout=${timeoutSec}s cwd=${resolvedCwd} cmd=${effectiveCommand}`,
      );

      // ── Run ───────────────────────────────────────────────────────────────
      onVerificationStart?.(timeoutMs);
      const result = await (async () => {
        try {
          return await runVerificationCommand({
            command: effectiveCommand,
            cwd: resolvedCwd,
            timeoutMs,
            expectFailure,
            onHeartbeat: recordActivity,
          });
        } finally {
          onVerificationEnd?.();
        }
      })();

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
            "test loops are infinite, or dependencies are missing. " +
            BOUNDED_VERIFICATION_GUIDANCE,
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
