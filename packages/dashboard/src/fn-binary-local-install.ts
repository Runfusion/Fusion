/*
FNXC:SystemPanelFnBinary 2026-07-15-09:54:
System panel operators need to (1) build the standalone `fn` binary from a Fusion
source checkout and install it as the default PATH binary, and (2) switch back to
the published global npm install. These helpers encode the install layout and
process steps used by POST /system/fn-binary/link-local and
POST /system/fn-binary/use-global so the route can stream every step into the
shared System job log viewer.
*/

import { spawn } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { FN_INSTALL_NPM, FN_NPM_PACKAGE } from "@fusion/core";

/** Hard cap on build/install child processes (full workspace + bun compile is long). */
export const FN_BINARY_JOB_MAX_MS = 30 * 60_000;
/** Hard cap on `npm install -g` alone. */
export const FN_BINARY_NPM_MAX_MS = 180_000;
const MAX_OUTPUT_BYTES = 64 * 1024;

export type FnBinaryLogStream = "stdout" | "stderr" | "system";
export type FnBinaryLogFn = (stream: FnBinaryLogStream, text: string) => void;

export interface FnBinaryLocalPaths {
  /** `~/.local/share/fusion` — binary + client + runtime co-located here. */
  installDir: string;
  /** `~/.local/bin` — earlier than Homebrew on typical macOS PATH. */
  binDir: string;
  binaryPath: string;
  fnShimPath: string;
  fusionShimPath: string;
}

export function resolveFnBinaryLocalPaths(home = homedir()): FnBinaryLocalPaths {
  const installDir = join(home, ".local", "share", "fusion");
  const binDir = join(home, ".local", "bin");
  return {
    installDir,
    binDir,
    binaryPath: join(installDir, "fn"),
    fnShimPath: join(binDir, "fn"),
    fusionShimPath: join(binDir, "fusion"),
  };
}

export interface ChildRunResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  command: string;
}

/**
 * Run a command, streaming line-oriented output through `onLog`. Never throws
 * for non-zero exits — caller inspects exitCode. Uses shell only on win32 so
 * `.cmd` shims (npm/pnpm/bun) resolve, matching the CLI-binary install path.
 */
export function runStreamingCommand(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs: number;
    onLog: FnBinaryLogFn;
    shell?: boolean;
  },
): Promise<ChildRunResult> {
  const startedAt = Date.now();
  const commandLabel = [command, ...args].join(" ");
  options.onLog("system", `$ ${commandLabel}`);

  return new Promise((resolvePromise) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let partialOut = "";
    let partialErr = "";

    const flushLines = (target: "stdout" | "stderr", chunk: string): void => {
      const bucket = target === "stdout" ? partialOut : partialErr;
      const combined = bucket + chunk;
      const parts = combined.split(/\r?\n/);
      const nextPartial = parts.pop() ?? "";
      if (target === "stdout") partialOut = nextPartial;
      else partialErr = nextPartial;
      for (const line of parts) {
        options.onLog(target, line);
        if (target === "stdout") {
          if (stdout.length < MAX_OUTPUT_BYTES) {
            stdout += `${line}\n`.slice(0, MAX_OUTPUT_BYTES - stdout.length);
          }
        } else if (stderr.length < MAX_OUTPUT_BYTES) {
          stderr += `${line}\n`.slice(0, MAX_OUTPUT_BYTES - stderr.length);
        }
      }
    };

    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: options.shell ?? process.platform === "win32",
    });

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (process.platform === "win32" && typeof child.pid === "number") {
          spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" }).on("error", () => {});
        } else {
          child.kill("SIGKILL");
        }
      } catch {
        // Best-effort kill only.
      }
    }, options.timeoutMs);
    timer.unref?.();

    child.stdout?.on("data", (chunk: Buffer) => flushLines("stdout", chunk.toString("utf8")));
    child.stderr?.on("data", (chunk: Buffer) => flushLines("stderr", chunk.toString("utf8")));

    child.on("error", (err) => {
      clearTimeout(timer);
      options.onLog("stderr", err.message);
      resolvePromise({
        exitCode: null,
        signal: null,
        timedOut,
        stdout,
        stderr: stderr || err.message,
        command: commandLabel,
      });
    });

    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      if (partialOut) {
        options.onLog("stdout", partialOut);
        partialOut = "";
      }
      if (partialErr) {
        options.onLog("stderr", partialErr);
        partialErr = "";
      }
      if (timedOut) {
        options.onLog("system", `Command timed out after ${Math.round(options.timeoutMs / 1000)}s`);
      }
      options.onLog(
        "system",
        `Exit ${exitCode ?? signal ?? "unknown"} (${Date.now() - startedAt}ms)`,
      );
      resolvePromise({
        exitCode,
        signal,
        timedOut,
        stdout,
        stderr,
        command: commandLabel,
      });
    });
  });
}

/** Prefer an explicit path, then common bun install locations, then PATH. */
export function resolveBunExecutable(): string {
  if (process.env.BUN_INSTALL) {
    const candidate = join(process.env.BUN_INSTALL, "bin", process.platform === "win32" ? "bun.exe" : "bun");
    if (existsSync(candidate)) return candidate;
  }
  const homeBun = join(homedir(), ".bun", "bin", process.platform === "win32" ? "bun.exe" : "bun");
  if (existsSync(homeBun)) return homeBun;
  return "bun";
}

/**
 * Copy the built standalone binary + co-located client/runtime assets into
 * `~/.local/share/fusion` and point `~/.local/bin/{fn,fusion}` at it.
 */
export function installLocalFnBinary(
  distDir: string,
  onLog: FnBinaryLogFn,
  paths: FnBinaryLocalPaths = resolveFnBinaryLocalPaths(),
): void {
  const srcBinary = join(distDir, process.platform === "win32" ? "fn.exe" : "fn");
  const srcClient = join(distDir, "client");
  const srcRuntime = join(distDir, "runtime");

  if (!existsSync(srcBinary)) {
    throw new Error(`Built binary missing at ${srcBinary}. Did the Bun compile step fail?`);
  }
  if (!existsSync(srcClient)) {
    throw new Error(`Dashboard client assets missing at ${srcClient}.`);
  }

  mkdirSync(paths.installDir, { recursive: true });
  mkdirSync(paths.binDir, { recursive: true });

  onLog("system", `Installing binary → ${paths.binaryPath}`);
  cpSync(srcBinary, paths.binaryPath);
  try {
    chmodSync(paths.binaryPath, 0o755);
  } catch {
    // Windows / restricted FS — ignore.
  }

  onLog("system", `Installing client assets → ${join(paths.installDir, "client")}`);
  rmSync(join(paths.installDir, "client"), { recursive: true, force: true });
  cpSync(srcClient, join(paths.installDir, "client"), { recursive: true });

  if (existsSync(srcRuntime)) {
    onLog("system", `Installing runtime assets → ${join(paths.installDir, "runtime")}`);
    rmSync(join(paths.installDir, "runtime"), { recursive: true, force: true });
    cpSync(srcRuntime, join(paths.installDir, "runtime"), { recursive: true });
  }

  for (const shim of [paths.fnShimPath, paths.fusionShimPath]) {
    try {
      if (existsSync(shim) || isSymlink(shim)) {
        unlinkSync(shim);
      }
    } catch {
      // Replace below; a missing prior shim is fine.
    }
    onLog("system", `Link ${shim} → ${paths.binaryPath}`);
    symlinkSync(paths.binaryPath, shim);
  }

  onLog("system", `Default fn is now ${paths.fnShimPath} (PATH should prefer ~/.local/bin).`);
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Remove PATH shims that point at our local install so a later entry (Homebrew
 * npm global, etc.) becomes the default again.
 */
export function removeLocalFnShims(
  onLog: FnBinaryLogFn,
  paths: FnBinaryLocalPaths = resolveFnBinaryLocalPaths(),
): { removed: string[] } {
  const removed: string[] = [];
  const installReal = resolve(paths.binaryPath);

  for (const shim of [paths.fnShimPath, paths.fusionShimPath]) {
    try {
      if (!existsSync(shim) && !isSymlink(shim)) {
        onLog("system", `No shim at ${shim}`);
        continue;
      }
      if (isSymlink(shim)) {
        const target = resolve(dirname(shim), readlinkSync(shim));
        if (target === installReal || target.startsWith(paths.installDir + "/") || target === paths.installDir) {
          unlinkSync(shim);
          removed.push(shim);
          onLog("system", `Removed local shim ${shim}`);
          continue;
        }
        onLog("system", `Leaving ${shim} (points at ${target}, not the local Fusion install)`);
        continue;
      }
      // Non-symlink binary in ~/.local/bin — only remove if identical path under installDir.
      if (resolve(shim) === installReal) {
        unlinkSync(shim);
        removed.push(shim);
        onLog("system", `Removed ${shim}`);
      } else {
        onLog("system", `Leaving ${shim} (not a local Fusion install shim)`);
      }
    } catch (err) {
      onLog("stderr", `Failed to inspect/remove ${shim}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { removed };
}

/**
 * Full link-local pipeline: workspace full build → bun compile → install under
 * ~/.local. Requires a Fusion source checkout root.
 */
export async function runLinkLocalFnBinary(
  sourceRoot: string,
  onLog: FnBinaryLogFn,
): Promise<{ success: boolean; error?: string }> {
  const buildScript = join(sourceRoot, "scripts", "build-workspace.mjs");
  const cliBuild = join(sourceRoot, "packages", "cli", "build.ts");
  const distDir = join(sourceRoot, "packages", "cli", "dist");

  if (!existsSync(buildScript)) {
    return { success: false, error: `Build script missing: ${buildScript}` };
  }
  if (!existsSync(cliBuild)) {
    return { success: false, error: `CLI build entry missing: ${cliBuild}` };
  }

  onLog("system", "Step 1/3 — full workspace package build…");
  const build = await runStreamingCommand(process.execPath, [buildScript, "--full"], {
    cwd: sourceRoot,
    timeoutMs: FN_BINARY_JOB_MAX_MS,
    onLog,
    shell: false,
    env: { ...process.env, FUSION_SKIP_STARTUP_UPDATE_PREFLIGHT: "1", FORCE_COLOR: "0" },
  });
  if (build.timedOut || build.exitCode !== 0) {
    return {
      success: false,
      error: `Workspace build failed (exit ${build.exitCode ?? build.signal ?? "timeout"})`,
    };
  }

  onLog("system", "Step 2/3 — compile standalone fn binary with Bun…");
  const bun = resolveBunExecutable();
  const compile = await runStreamingCommand(bun, ["run", cliBuild], {
    cwd: sourceRoot,
    timeoutMs: FN_BINARY_JOB_MAX_MS,
    onLog,
    shell: process.platform === "win32",
    env: { ...process.env, FORCE_COLOR: "0" },
  });
  if (compile.timedOut || compile.exitCode !== 0) {
    return {
      success: false,
      error: `Bun compile failed (exit ${compile.exitCode ?? compile.signal ?? "timeout"}). Is bun installed?`,
    };
  }

  onLog("system", "Step 3/3 — install as default local fn…");
  try {
    installLocalFnBinary(distDir, onLog);
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }

  onLog("system", "Local fn binary is ready. Open a new shell if `which fn` still points at npm.");
  return { success: true };
}

/**
 * Remove local-build PATH shims, then reinstall the published package globally
 * so PATH falls back to the npm global binary.
 */
export async function runUseGlobalFnBinary(
  onLog: FnBinaryLogFn,
): Promise<{ success: boolean; error?: string; permissionsHint?: string }> {
  onLog("system", "Step 1/2 — remove local-build shims from ~/.local/bin…");
  removeLocalFnShims(onLog);

  onLog("system", `Step 2/2 — ${FN_INSTALL_NPM}…`);
  const install = await runStreamingCommand("npm", ["install", "-g", FN_NPM_PACKAGE], {
    timeoutMs: FN_BINARY_NPM_MAX_MS,
    onLog,
    shell: process.platform === "win32",
  });

  if (install.timedOut || install.exitCode !== 0) {
    const combined = `${install.stdout}\n${install.stderr}`;
    const eaccesHit = /EACCES|permission denied|Operation not permitted/i.test(combined);
    return {
      success: false,
      error: `npm install failed (exit ${install.exitCode ?? install.signal ?? "timeout"})`,
      permissionsHint: eaccesHit
        ? "npm reported a permissions error. On macOS/Linux this usually means npm's global prefix needs `sudo` or a fix to your npm prefix (https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally)."
        : undefined,
    };
  }

  onLog("system", "Global npm fn install complete. Verify with `which fn` / `fn --version`.");
  return { success: true };
}
