/**
 * CLI binary management routes.
 *
 *   GET  /system/fn-binary/status   — does the user have `fn`/`fusion` on PATH?
 *   POST /system/fn-binary/install  — run `npm install -g runfusion.ai`
 *
 * Used by the Settings → General → CLI Binary panel and the first-launch
 * banner. Install routes are intentionally synchronous-with-result rather
 * than streaming; npm global installs are short enough that polling for
 * completion isn't worth a websocket channel.
 */

import { spawn } from "node:child_process";
import {
  detectFnBinary,
  FN_INSTALL_CURL,
  FN_INSTALL_NPM,
  FN_NPM_PACKAGE,
  type FnBinaryStatus,
} from "@fusion/core";
import { ApiError } from "../api-error.js";
import { getCliPackageVersion } from "../cli-package-version.js";
import type { ApiRouteRegistrar } from "./types.js";

/** Hard cap on `npm install -g` runtime. */
const INSTALL_TIMEOUT_MS = 180_000;
/** Hard cap on captured npm output to keep responses small. */
const MAX_OUTPUT_BYTES = 64 * 1024;

interface InstallResult {
  success: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  command: string;
  durationMs: number;
  /** Hint surfaced to the UI when EACCES is detected. */
  permissionsHint?: string;
}

/**
 * Compose the status payload returned by GET /system/fn-binary/status.
 * Includes the expected version (read from this package's package.json),
 * the canonical install commands, and a derived state for the UI.
 */
function buildStatusPayload(binary: FnBinaryStatus, expectedVersion: string) {
  let state: "installed" | "missing" | "version-mismatch" = "missing";
  if (binary.installed) {
    state = binary.version && binary.version !== expectedVersion
      ? "version-mismatch"
      : "installed";
  }
  return {
    binary,
    expectedVersion,
    state,
    install: {
      npm: FN_INSTALL_NPM,
      curl: FN_INSTALL_CURL,
      package: FN_NPM_PACKAGE,
    },
  };
}

/**
 * Run `npm install -g runfusion.ai`, capturing output up to MAX_OUTPUT_BYTES
 * and timing out after INSTALL_TIMEOUT_MS. Always resolves; never rejects.
 */
function runNpmInstall(): Promise<InstallResult> {
  const startedAt = Date.now();
  const command = FN_INSTALL_NPM;
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    /*
     * FNXC:CliBinaryInstall 2026-07-03-03:00:
     * On Windows `npm` resolves to `npm.cmd`; Node refuses to spawn a .cmd/.bat without a shell
     * (spawn npm ENOENT / EINVAL since CVE-2024-27980), so the CLI-banner "Install with npm" button
     * failed with `spawn npm ENOENT`. Use a shell on win32. The command/args are fixed constants
     * (`npm install -g runfusion.ai`) with no caller-supplied input, so shell quoting is safe.
     */
    const child = spawn("npm", ["install", "-g", FN_NPM_PACKAGE], {
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
    });
    const timer = setTimeout(() => {
      timedOut = true;
      /*
       * FNXC:CliBinaryInstall 2026-07-03-05:00:
       * With shell:true on Windows the spawned child is cmd.exe; killing it leaves the underlying
       * npm.cmd/node running in the background. Kill the whole process tree via taskkill /T so a
       * timed-out install can't keep running detached. POSIX has no shell wrapper here, so SIGKILL
       * on the child suffices.
       */
      try {
        if (process.platform === "win32" && typeof child.pid === "number") {
          spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" }).on("error", () => {});
        } else {
          child.kill("SIGKILL");
        }
      } catch { /* ignore */ }
    }, INSTALL_TIMEOUT_MS);

    const append = (target: "stdout" | "stderr", chunk: Buffer): void => {
      const text = chunk.toString("utf8");
      if (target === "stdout") {
        if (stdout.length < MAX_OUTPUT_BYTES) {
          stdout += text.slice(0, MAX_OUTPUT_BYTES - stdout.length);
        }
      } else {
        if (stderr.length < MAX_OUTPUT_BYTES) {
          stderr += text.slice(0, MAX_OUTPUT_BYTES - stderr.length);
        }
      }
    };
    child.stdout?.on("data", (c: Buffer) => append("stdout", c));
    child.stderr?.on("data", (c: Buffer) => append("stderr", c));

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        success: false,
        exitCode: null,
        stdout,
        stderr: stderr || err.message,
        command,
        durationMs: Date.now() - startedAt,
      });
    });

    child.on("close", (exitCode) => {
      clearTimeout(timer);
      const combined = `${stdout}\n${stderr}`;
      const eaccesHit = /EACCES|permission denied|Operation not permitted/i.test(combined);
      const success = exitCode === 0 && !timedOut;
      resolve({
        success,
        exitCode,
        stdout,
        stderr: timedOut ? `${stderr}\n[install timed out after ${INSTALL_TIMEOUT_MS / 1000}s]` : stderr,
        command,
        durationMs: Date.now() - startedAt,
        permissionsHint: !success && eaccesHit
          ? "npm reported a permissions error. On macOS/Linux this usually means npm's global prefix needs `sudo` or a fix to your npm prefix (https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally)."
          : undefined,
      });
    });
  });
}

/**
 * Build a status payload for the case where the user has disabled the
 * fn-binary check via the global setting. We still return a well-formed
 * response (the UI consumes the same shape regardless) but skip the
 * subprocess probe entirely. `state: "skipped"` lets the dashboard hide
 * install / version-mismatch surfaces without inferring "missing".
 */
function buildSkippedStatusPayload(expectedVersion: string) {
  return {
    binary: {
      installed: false,
      invocation: FN_INSTALL_NPM,
    } satisfies FnBinaryStatus,
    expectedVersion,
    state: "skipped" as const,
    install: {
      npm: FN_INSTALL_NPM,
      curl: FN_INSTALL_CURL,
      package: FN_NPM_PACKAGE,
    },
  };
}

export const registerFnBinaryRoutes: ApiRouteRegistrar = (ctx) => {
  const { router, rethrowAsApiError, store } = ctx;

  async function isCheckEnabled(): Promise<boolean> {
    try {
      const settings = await store.getSettings();
      // Default true — only treat an explicit false as opt-out.
      return settings.fnBinaryCheckEnabled !== false;
    } catch {
      // If settings can't be read, fall back to the safe default and
      // perform the probe so the dashboard's onboarding banner still
      // renders.
      return true;
    }
  }

  /**
   * GET /system/fn-binary/status
   *
   * Probes PATH for `fn` then `fusion`, returning install state and the
   * canonical install commands. No auth — this is read-only introspection
   * the dashboard banner needs before the user signs in.
   *
   * Honours `fnBinaryCheckEnabled` (global setting, default true). When
   * disabled the route returns `state: "skipped"` without spawning a probe.
   */
  router.get("/system/fn-binary/status", async (_req, res) => {
    try {
      const expectedVersion = getCliPackageVersion();
      if (!(await isCheckEnabled())) {
        res.json(buildSkippedStatusPayload(expectedVersion));
        return;
      }
      const binary = await detectFnBinary();
      res.json(buildStatusPayload(binary, expectedVersion));
    } catch (err) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err);
    }
  });

  /**
   * POST /system/fn-binary/install
   *
   * Runs `npm install -g runfusion.ai`. Returns the install result and the
   * post-install probe so the UI can refresh its state in one round trip.
   * Disabled when `fnBinaryCheckEnabled` is false — install is the user
   * action that the status check informs, so it follows the same gate.
   */
  router.post("/system/fn-binary/install", async (_req, res) => {
    try {
      if (!(await isCheckEnabled())) {
        throw new ApiError(
          409,
          "fn-binary checks are disabled in global settings (fnBinaryCheckEnabled=false). Re-enable them to install via the dashboard.",
          { code: "FN_BINARY_CHECK_DISABLED" },
        );
      }
      const installResult = await runNpmInstall();
      // Re-probe even on failure — the binary may already exist from a
      // previous attempt and we want the UI to reflect reality.
      const binary = await detectFnBinary();
      const expectedVersion = getCliPackageVersion();
      const status = buildStatusPayload(binary, expectedVersion);
      res.json({ ...status, installResult });
    } catch (err) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err);
    }
  });
};
