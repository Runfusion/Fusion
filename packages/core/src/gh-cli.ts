import { execFileSync, execFile } from "node:child_process";
import type { ExecFileException } from "node:child_process";

export interface GhError extends Error {
  code: string | number | null;
  stderr: string;
  stdout: string;
}

export type GhErrorCode =
  | "not-installed"
  | "not-authenticated"
  | "rate-limited"
  | "not-found"
  | "network"
  | "permission"
  | "merge-conflict"
  | "validation"
  | "timeout"
  | "unknown";

export interface StructuredGhError {
  code: GhErrorCode;
  message: string;
  hint?: string;
  action?: { kind: "shell"; command: string } | { kind: "retry" } | { kind: "open"; url: string };
  retryable: boolean;
  retryAfterMs?: number;
  cause?: {
    stderr?: string;
    stdout?: string;
    exitCode?: string | number | null;
  };
}

export const MAX_GH_STDIN_INPUT_BYTES = 8 * 1024 * 1024;

export interface RunGhOptions {
  cwd?: string;
  /** External abort signal — propagated to the spawned `gh` process. */
  signal?: AbortSignal;
  /**
   * Hard ceiling on `gh` runtime in milliseconds. The child process is killed
   * when exceeded and the returned promise rejects with a `GhError`. Defaults
   * to 30_000 (30 s); set to `0` or a negative value to disable.
   *
   * Without this, an upstream hang (network stall, hung credential helper,
   * gh waiting on stdin) can leave the call pending forever — which in turn
   * pins any AI session's `prompt()` that triggered the tool call.
   */
  timeoutMs?: number;
  /**
   * Optional UTF-8 request body streamed to child stdin. Limited to 8 MiB so
   * callers can send bounded Contents API payloads without argv overflow.
   */
  input?: string;
}

const DEFAULT_GH_TIMEOUT_MS = 30_000;

function normalizeRunGhOptions(opts: string | RunGhOptions | undefined): RunGhOptions {
  if (typeof opts === "string") return { cwd: opts };
  return opts ?? {};
}

// Both isGhAvailable() and isGhAuthenticated() are deterministic for the
// lifetime of a process (the gh binary doesn't get uninstalled, and the
// auth state doesn't change without explicit user action) but they each
// shell out via execFileSync — `gh auth status` in particular performs a
// network roundtrip to GitHub. At startup the GitHubTrackingReconciler
// scans up to 200 done tasks and calls hasGhAuth() per-task, producing
// hundreds of synchronous spawns that pin the event loop for ~60s and
// make the dashboard unresponsive during cold start.
//
// Cache the result with a short TTL so callers still notice if the user
// runs `gh auth login` mid-session, but a tight loop of N callers in the
// same second pays for at most one spawn.
const GH_CHECK_TTL_MS = 60_000;

let cachedAvailable: { value: boolean; at: number } | undefined;
let cachedAuthenticated: { value: boolean; at: number } | undefined;

/**
 * Reset the in-memory cache. Call after operations that legitimately change
 * gh auth state (login/logout) so the next check observes the new state
 * without waiting for the TTL.
 */
export function resetGhAvailabilityCache(): void {
  cachedAvailable = undefined;
  cachedAuthenticated = undefined;
}

/**
 * Check if the `gh` CLI is installed and available.
 */
export function isGhAvailable(): boolean {
  if (cachedAvailable && Date.now() - cachedAvailable.at < GH_CHECK_TTL_MS) {
    return cachedAvailable.value;
  }
  let value = false;
  try {
    execFileSync("gh", ["--version"], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
    });
    value = true;
  } catch {
    value = false;
  }
  cachedAvailable = { value, at: Date.now() };
  return value;
}

/**
 * Check if the `gh` CLI is authenticated with GitHub.
 * Returns true if authenticated, false if not.
 */
export function isGhAuthenticated(): boolean {
  if (cachedAuthenticated && Date.now() - cachedAuthenticated.at < GH_CHECK_TTL_MS) {
    return cachedAuthenticated.value;
  }
  let value = false;
  try {
    const result = execFileSync("gh", ["auth", "status"], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
    });
    // gh auth status returns 0 and outputs "Logged in" if authenticated
    value = result.includes("Logged in") || result.includes("Authenticated");
  } catch {
    value = false;
  }
  cachedAuthenticated = { value, at: Date.now() };
  return value;
}

/**
 * Execute a gh CLI command synchronously.
 * Throws GhError on failure with parsed error details.
 */
export function runGh(args: string[], cwd?: string): string {
  try {
    const result = execFileSync("gh", args, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      cwd,
    });
    return result;
  } catch (err: unknown) {
    const execErr = err as ExecFileException & { stdout?: Buffer | string; stderr?: Buffer | string };
    const error = new Error(`gh command failed: ${execErr.message}`) as GhError;
    error.code = execErr.code ?? null;
    error.stdout = execErr.stdout?.toString() ?? "";
    error.stderr = execErr.stderr?.toString() ?? "";
    throw error;
  }
}

/**
 * Execute a gh CLI command asynchronously.
 *
 * Returns a promise that resolves with the output or rejects with `GhError`.
 *
 * `cwdOrOptions` accepts either a string (cwd, legacy form) or a `RunGhOptions`
 * object. The options form supports an external `AbortSignal` and a
 * `timeoutMs` ceiling — both default to safe values that prevent indefinite
 * hangs when `gh` stalls on the network or a credential helper.
 */
export function runGhAsync(args: string[], cwdOrOptions?: string | RunGhOptions): Promise<string> {
  const { cwd, signal: externalSignal, timeoutMs = DEFAULT_GH_TIMEOUT_MS, input } =
    normalizeRunGhOptions(cwdOrOptions);
  if (input !== undefined && Buffer.byteLength(input, "utf8") > MAX_GH_STDIN_INPUT_BYTES) {
    return Promise.reject(makeGhError(`gh stdin input exceeds ${MAX_GH_STDIN_INPUT_BYTES} byte limit`, "INPUT_TOO_LARGE"));
  }

  return new Promise((resolve, reject) => {
    if (externalSignal?.aborted) {
      reject(makeGhError(`gh command aborted: ${describeAbortReason(externalSignal.reason)}`, "ABORT_ERR"));
      return;
    }

    // Compose the abort sources so we can distinguish timeout from external
    // abort in the rejection. Using a private controller keeps signal
    // ownership inside this function.
    const controller = new AbortController();
    let timedOut = false;
    let externalAborted = false;

    const onExternalAbort = () => {
      externalAborted = true;
      controller.abort();
    };
    if (externalSignal) {
      externalSignal.addEventListener("abort", onExternalAbort, { once: true });
    }

    const timer = timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, timeoutMs)
      : undefined;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (externalSignal) externalSignal.removeEventListener("abort", onExternalAbort);
    };

    const child = execFile(
      "gh",
      args,
      {
        encoding: "utf-8",
        cwd,
        signal: controller.signal,
      },
      (error, stdout, stderr) => {
        cleanup();
        if (error) {
          const isAbort = (error as ExecFileException & { code?: string | number | null }).code === "ABORT_ERR"
            || error.name === "AbortError";
          let message: string;
          if (timedOut) {
            message = `gh command timed out after ${timeoutMs}ms`;
          } else if (isAbort && externalAborted) {
            message = `gh command aborted: ${describeAbortReason(externalSignal?.reason)}`;
          } else if (isAbort) {
            message = "gh command aborted";
          } else {
            message = `gh command failed: ${error.message}`;
          }
          const ghError = new Error(message) as GhError;
          ghError.code = (error as ExecFileException).code ?? (isAbort ? "ABORT_ERR" : null);
          ghError.stdout = stdout ?? "";
          ghError.stderr = stderr ?? "";
          reject(ghError);
        } else {
          resolve(stdout ?? "");
        }
      }
    );
    /*
    FNXC:GhCliStdin 2026-07-19-12:00:
    GitHub Contents API image bodies can contain several megabytes of base64.
    Keep that payload on stdin because operating-system argv limits are much
    smaller and can otherwise reject a valid bounded report screenshot.
    */
    if (input !== undefined) child.stdin?.end(input);
  });
}

function makeGhError(message: string, code: string | number | null): GhError {
  const err = new Error(message) as GhError;
  err.code = code;
  err.stdout = "";
  err.stderr = "";
  return err;
}

function describeAbortReason(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  if (typeof reason === "string") return reason;
  return "aborted";
}

function shouldAutoAppendJsonFlag(args: string[]): boolean {
  return args[0] !== "api" && !args.includes("--json");
}

/**
 * Execute a gh CLI command and parse the JSON output.
 * Auto-appends `--json` except for `gh api`, which emits JSON natively and rejects that flag.
 */
export function runGhJson<T>(args: string[], cwd?: string): T {
  const jsonArgs = shouldAutoAppendJsonFlag(args) ? [...args, "--json"] : args;
  const output = runGh(jsonArgs, cwd);
  try {
    return JSON.parse(output) as T;
  } catch (err) {
    throw new Error(`Failed to parse gh JSON output: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Execute a gh CLI command asynchronously and parse the JSON output.
 * Auto-appends `--json` except for `gh api`, which emits JSON natively and rejects that flag.
 *
 * Forwards `signal` / `timeoutMs` to the underlying `runGhAsync` so callers
 * can bound the call from outside (e.g. an AI tool's `signal` argument).
 */
export async function runGhJsonAsync<T>(args: string[], cwdOrOptions?: string | RunGhOptions): Promise<T> {
  const jsonArgs = shouldAutoAppendJsonFlag(args) ? [...args, "--json"] : args;
  const output = await runGhAsync(jsonArgs, cwdOrOptions);
  try {
    return JSON.parse(output) as T;
  } catch (err) {
    throw new Error(`Failed to parse gh JSON output: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function parseRetryAfterMs(content: string): number | undefined {
  const retryAfterMatch = content.match(/retry-after\s*[:=]\s*(\d+)/i);
  if (retryAfterMatch) {
    return Number.parseInt(retryAfterMatch[1], 10) * 1000;
  }

  const resetMatch = content.match(/x-ratelimit-reset\s*[:=]\s*(\d{10,})/i);
  if (resetMatch) {
    const resetEpochMs = Number.parseInt(resetMatch[1], 10) * 1000;
    return Math.max(0, resetEpochMs - Date.now());
  }

  const waitMatch = content.match(/(?:try again|retry)\s+in\s+(\d+)\s*(second|seconds|sec|s|minute|minutes|min|m)/i);
  if (waitMatch) {
    const amount = Number.parseInt(waitMatch[1], 10);
    const unit = waitMatch[2].toLowerCase();
    if (unit.startsWith("m")) return amount * 60_000;
    return amount * 1000;
  }

  return undefined;
}

function normalizeGhErrorParts(error: unknown): { message: string; stderr: string; stdout: string; exitCode: string | number | null } {
  if (error && typeof error === "object") {
    const withDetails = error as { message?: unknown; code?: unknown; stderr?: unknown; stdout?: unknown };
    const rawMessage = withDetails.message;
    return {
      message: rawMessage && typeof rawMessage === "object" && rawMessage instanceof Error
        ? rawMessage.message
        : String(rawMessage ?? error),
      stderr: String(withDetails.stderr ?? ""),
      stdout: String(withDetails.stdout ?? ""),
      exitCode: (withDetails.code as string | number | null | undefined) ?? null,
    };
  }

  return { message: String(error), stderr: "", stdout: "", exitCode: null };
}

export function classifyGhError(error: unknown): StructuredGhError {
  const parts = normalizeGhErrorParts(error);
  const haystack = `${parts.message}\n${parts.stderr}\n${parts.stdout}`.toLowerCase();
  const baseCause = {
    stderr: parts.stderr || undefined,
    stdout: parts.stdout || undefined,
    exitCode: parts.exitCode,
  };

  const withCause = (result: Omit<StructuredGhError, "cause">): StructuredGhError => ({ ...result, cause: baseCause });

  if (haystack.includes("not logged into") || haystack.includes("authentication required") || /\b401\b/.test(haystack)) {
    return withCause({
      code: "not-authenticated",
      message: "GitHub CLI is not authenticated. Run 'gh auth login' to authenticate.",
      hint: "Run 'gh auth login' to authenticate with GitHub.",
      action: { kind: "shell", command: "gh auth login" },
      retryable: true,
    });
  }

  if (haystack.includes("rate limit") || (/\b403\b/.test(haystack) && haystack.includes("rate"))) {
    return withCause({
      code: "rate-limited",
      message: "GitHub API rate limit exceeded. Please try again later.",
      retryable: true,
      action: { kind: "retry" },
      retryAfterMs: parseRetryAfterMs(`${parts.stderr}\n${parts.message}`),
    });
  }

  if (haystack.includes("command not found") || haystack.includes("gh cli is not available") || haystack.includes("enoent") || parts.exitCode === "ENOENT") {
    return withCause({
      code: "not-installed",
      message: "GitHub CLI (gh) is not installed. Install it from https://github.com/cli/cli#installation",
      hint: "Install GitHub CLI from https://github.com/cli/cli#installation",
      action: { kind: "open", url: "https://github.com/cli/cli#installation" },
      retryable: false,
    });
  }

  if (haystack.includes("etimedout") || haystack.includes("econnreset") || haystack.includes("enotfound") || haystack.includes("eai_again") || haystack.includes("getaddrinfo") || haystack.includes("network")) {
    return withCause({
      code: "network",
      message: "Network error while talking to GitHub. Check connectivity and retry.",
      action: { kind: "retry" },
      retryable: true,
    });
  }

  if (haystack.includes("timed out") || (parts.exitCode === "ABORT_ERR" && haystack.includes(`${DEFAULT_GH_TIMEOUT_MS}`))) {
    return withCause({
      code: "timeout",
      message: parts.message,
      action: { kind: "retry" },
      retryable: true,
    });
  }

  if (haystack.includes("merge conflict") || haystack.includes("not mergeable")) {
    return withCause({
      code: "merge-conflict",
      message: "Pull request cannot be merged due to conflicts.",
      retryable: false,
    });
  }

  if (haystack.includes("validation failed") || /\b422\b/.test(haystack)) {
    return withCause({
      code: "validation",
      message: "GitHub rejected the request due to validation errors.",
      retryable: false,
    });
  }

  if (haystack.includes("permission") || /\b403\b/.test(haystack)) {
    return withCause({
      code: "permission",
      message: "GitHub denied access to this resource.",
      retryable: false,
    });
  }

  if (haystack.includes("not found") || /\b404\b/.test(haystack)) {
    return withCause({
      code: "not-found",
      message: "Resource not found. Check that the repository, PR, or issue exists and you have access.",
      retryable: false,
    });
  }

  return withCause({
    code: "unknown",
    message: parts.message,
    retryable: true,
    action: { kind: "retry" },
  });
}

/**
 * Get a human-readable error message from a gh CLI error.
 * Extracts the most relevant error information.
 */
export function getGhErrorMessage(error: unknown): string {
  return classifyGhError(error).message;
}

/**
 * Verify gh CLI is available and authenticated.
 * Throws an error with helpful instructions if not.
 */
export function ensureGhAuth(): void {
  if (!isGhAvailable()) {
    throw new Error(
      "GitHub CLI (gh) is not installed. " +
      "Install it from https://github.com/cli/cli#installation"
    );
  }
  
  if (!isGhAuthenticated()) {
    throw new Error(
      "GitHub CLI (gh) is not authenticated. " +
      "Run 'gh auth login' to authenticate with GitHub."
    );
  }
}

/**
 * Extract owner/repo from a GitHub remote URL.
 * Used to determine the current repository context.
 */
export function parseRepoFromRemote(remoteUrl: string): { owner: string; repo: string } | null {
  // HTTPS: https://github.com/owner/repo.git or https://github.com/owner/repo
  const httpsMatch = remoteUrl.match(/github\.com\/([^/]+)\/([^/.]+)(?:\.git)?$/);
  if (httpsMatch) {
    return { owner: httpsMatch[1], repo: httpsMatch[2] };
  }

  // SSH: git@github.com:owner/repo.git or git@github.com:owner/repo
  const sshMatch = remoteUrl.match(/github\.com:([^/]+)\/([^/.]+)(?:\.git)?$/);
  if (sshMatch) {
    return { owner: sshMatch[1], repo: sshMatch[2] };
  }

  return null;
}

/**
 * Get the current repository context from git remote.
 * Returns null if not in a git repository or no GitHub remote.
 */
export function getCurrentRepo(cwd?: string): { owner: string; repo: string } | null {
  try {
    const remoteUrl = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
    }).trim();

    return parseRepoFromRemote(remoteUrl);
  } catch {
    return null;
  }
}
