/**
 * Public helper for probing the locally-installed OpenClaw CLI binary.
 *
 * Used by dashboards, health checks, and onboarding flows to determine
 * whether `openclaw` is available before attempting any agent session.
 *
 * Design choices mirror the Claude CLI probe in packages/dashboard:
 * - No caching. PATH can change between requests.
 * - Short timeout. A misbehaving shim must not block callers.
 * - Never throws. Any failure is captured in the returned status object.
 */

import { spawn } from "node:child_process";

/** Default timeout for the version probe. */
const DEFAULT_PROBE_TIMEOUT_MS = 2_000;

/**
 * Structured result from probing the OpenClaw CLI binary.
 */
export interface OpenClawBinaryStatus {
  /** `true` if the binary was found on PATH and completed successfully. */
  available: boolean;
  /** Resolved binary path (from `which`/`where`), if determinable. */
  binaryPath?: string;
  /** Trimmed version string from `openclaw --version`, e.g. `"OpenClaw 2026.4.26 (be8c246)"`. */
  version?: string;
  /** Human-readable failure reason when `available === false`. */
  reason?: string;
  /** Wall-clock milliseconds consumed by the probe. */
  probeDurationMs: number;
}

/**
 * Spawn `openclaw --version` and return a structured availability status.
 *
 * Never throws — failures are represented as `available: false` with a
 * descriptive `reason` so HTTP handlers can render provider cards safely.
 *
 * @param opts.binaryPath - Override the binary path. Defaults to `"openclaw"`.
 * @param opts.timeoutMs  - Max milliseconds to wait. Defaults to 2,000.
 */
export async function probeOpenClawBinary(
  opts: { binaryPath?: string; timeoutMs?: number } = {},
): Promise<OpenClawBinaryStatus> {
  const startedAt = Date.now();
  const binary = opts.binaryPath ?? "openclaw";
  const timeoutMs = opts.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;

  const resolvedPath = await tryResolveBinaryPath(binary);

  return new Promise<OpenClawBinaryStatus>((resolvePromise) => {
    const finish = (
      partial: Omit<OpenClawBinaryStatus, "probeDurationMs">,
    ): void => {
      resolvePromise({ ...partial, probeDurationMs: Date.now() - startedAt });
    };

    let settled = false;

    const child = spawn(resolvedPath ?? binary, ["--version"], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // Process already gone.
      }
      finish({
        available: false,
        binaryPath: resolvedPath,
        reason: `Probe timed out after ${timeoutMs}ms`,
      });
    }, timeoutMs);

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });

    child.on("error", (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const isNotFound = err.code === "ENOENT";
      finish({
        available: false,
        binaryPath: resolvedPath,
        reason: isNotFound
          ? `\`${binary}\` not found on PATH — install via: npm install -g openclaw`
          : err.message,
      });
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        finish({
          available: true,
          binaryPath: resolvedPath,
          version: stdout.trim() || undefined,
        });
      } else {
        finish({
          available: false,
          binaryPath: resolvedPath,
          reason:
            stderr.trim() ||
            `openclaw --version exited with code ${String(code)}`,
        });
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Attempt to resolve the absolute path to a binary via `which` (POSIX) or
 * `where` (Windows). Returns `undefined` on failure — the probe above is the
 * real authority.
 */
async function tryResolveBinaryPath(binary: string): Promise<string | undefined> {
  return new Promise<string | undefined>((resolvePromise) => {
    const which = process.platform === "win32" ? "where" : "which";
    const child = spawn(which, [binary], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf-8");
    });
    child.on("error", () => resolvePromise(undefined));
    child.on("close", (code) => {
      if (code === 0) {
        const first = out.trim().split(/\r?\n/)[0];
        resolvePromise(first?.length ? first : undefined);
      } else {
        resolvePromise(undefined);
      }
    });
  });
}
