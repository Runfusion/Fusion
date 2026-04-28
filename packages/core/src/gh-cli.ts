import { execFileSync, execFile } from "node:child_process";
import type { ExecFileException } from "node:child_process";

export interface GhError extends Error {
  code: string | number | null;
  stderr: string;
  stdout: string;
}

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
}

const DEFAULT_GH_TIMEOUT_MS = 30_000;

function normalizeRunGhOptions(opts: string | RunGhOptions | undefined): RunGhOptions {
  if (typeof opts === "string") return { cwd: opts };
  return opts ?? {};
}

/**
 * Check if the `gh` CLI is installed and available.
 */
export function isGhAvailable(): boolean {
  try {
    execFileSync("gh", ["--version"], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if the `gh` CLI is authenticated with GitHub.
 * Returns true if authenticated, false if not.
 */
export function isGhAuthenticated(): boolean {
  try {
    const result = execFileSync("gh", ["auth", "status"], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
    });
    // gh auth status returns 0 and outputs "Logged in" if authenticated
    return result.includes("Logged in") || result.includes("Authenticated");
  } catch {
    return false;
  }
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
  const { cwd, signal: externalSignal, timeoutMs = DEFAULT_GH_TIMEOUT_MS } =
    normalizeRunGhOptions(cwdOrOptions);

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

    execFile(
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

/**
 * Execute a gh CLI command and parse the JSON output.
 * Requires the command to support --json flag.
 */
export function runGhJson<T>(args: string[], cwd?: string): T {
  const jsonArgs = args.includes("--json") ? args : [...args, "--json"];
  const output = runGh(jsonArgs, cwd);
  try {
    return JSON.parse(output) as T;
  } catch (err) {
    throw new Error(`Failed to parse gh JSON output: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Execute a gh CLI command asynchronously and parse the JSON output.
 * Requires the command to support --json flag.
 *
 * Forwards `signal` / `timeoutMs` to the underlying `runGhAsync` so callers
 * can bound the call from outside (e.g. an AI tool's `signal` argument).
 */
export async function runGhJsonAsync<T>(args: string[], cwdOrOptions?: string | RunGhOptions): Promise<T> {
  const jsonArgs = args.includes("--json") ? args : [...args, "--json"];
  const output = await runGhAsync(jsonArgs, cwdOrOptions);
  try {
    return JSON.parse(output) as T;
  } catch (err) {
    throw new Error(`Failed to parse gh JSON output: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Get a human-readable error message from a gh CLI error.
 * Extracts the most relevant error information.
 */
export function getGhErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    // Check for common gh CLI error patterns
    const message = error.message;
    
    // Authentication errors
    if (message.includes("not logged into") || message.includes("authentication required")) {
      return "GitHub CLI is not authenticated. Run 'gh auth login' to authenticate.";
    }
    
    // Not found errors
    if (message.includes("not found") || message.includes("404")) {
      return "Resource not found. Check that the repository, PR, or issue exists and you have access.";
    }
    
    // Rate limit errors
    if (message.includes("rate limit") || message.includes("403")) {
      return "GitHub API rate limit exceeded. Please try again later.";
    }
    
    return message;
  }
  
  return String(error);
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
