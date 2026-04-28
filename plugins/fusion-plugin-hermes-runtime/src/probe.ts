/**
 * Hermes binary probe helper.
 *
 * Mirrors the probeClaudeCli pattern from packages/dashboard/src/claude-cli-probe.ts.
 * Never throws — all failures are captured as `available: false` with a reason.
 */

import { spawn } from "node:child_process";

/** Default probe timeout in milliseconds. */
const DEFAULT_PROBE_TIMEOUT_MS = 2000;

/**
 * Result of probing for the hermes binary.
 */
export interface HermesBinaryStatus {
  /** True if the binary was found and ran to completion successfully. */
  available: boolean;
  /** Absolute path resolved via `which`/`where`, if found. */
  binaryPath?: string;
  /** Version string from `hermes --version` stdout, if available. */
  version?: string;
  /** Human-readable failure reason when `available === false`. */
  reason?: string;
  /** Wall-clock duration of the probe in milliseconds. */
  probeDurationMs: number;
}

/**
 * Probe for the hermes binary.
 *
 * Runs `<binaryPath> --version` with a short timeout. Use this from
 * the dashboard status endpoint to check binary presence without crashing.
 *
 * @param opts.binaryPath - Override the binary path (default: "hermes").
 * @param opts.timeoutMs  - Override probe timeout in ms (default: 2000).
 */
export async function probeHermesBinary(opts?: {
  binaryPath?: string;
  timeoutMs?: number;
}): Promise<HermesBinaryStatus> {
  const startedAt = Date.now();
  const binary =
    typeof opts?.binaryPath === "string" && opts.binaryPath.trim().length > 0
      ? opts.binaryPath.trim()
      : "hermes";
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;

  const resolvedPath = await tryResolveBinaryPath(binary);

  return new Promise<HermesBinaryStatus>((resolvePromise) => {
    const finish = (result: Omit<HermesBinaryStatus, "probeDurationMs">): void => {
      resolvePromise({ ...result, probeDurationMs: Date.now() - startedAt });
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
          ? `\`${binary}\` not found on PATH`
          : err.message,
      });
    });

    child.on("close", (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        finish({
          available: true,
          version: stdout.trim() || undefined,
          binaryPath: resolvedPath,
        });
      } else {
        finish({
          available: false,
          binaryPath: resolvedPath,
          reason:
            stderr.trim() || `hermes --version exited with code ${String(code)}`,
        });
      }
    });
  });
}

/**
 * Best-effort path resolution via `which` (POSIX) or `where` (Windows).
 * Returns undefined on failure — the spawn above is the actual authority.
 */
async function tryResolveBinaryPath(binary: string): Promise<string | undefined> {
  return new Promise((resolvePromise) => {
    const which = process.platform === "win32" ? "where" : "which";
    const child = spawn(which, [binary], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf-8");
    });
    child.on("error", () => resolvePromise(undefined));
    child.on("close", (code: number | null) => {
      if (code === 0) {
        const first = out.trim().split(/\r?\n/)[0];
        resolvePromise(first?.length ? first : undefined);
      } else {
        resolvePromise(undefined);
      }
    });
  });
}
