import { spawn } from "node:child_process";
import { access, constants } from "node:fs/promises";

export interface AgentBrowserProbeResult {
  available: boolean;
  binaryPath?: string;
  version?: string;
  reason?: string;
  notFound?: boolean;
}

export async function probeAgentBrowserBinary(opts?: { binaryPath?: string; timeoutMs?: number }): Promise<AgentBrowserProbeResult> {
  const binary = opts?.binaryPath?.trim() || "agent-browser";
  const timeoutMs = opts?.timeoutMs ?? 2000;
  const resolvedPath = await tryResolveBinaryPath(binary);

  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(resolvedPath ?? binary, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      resolve({ available: false, binaryPath: resolvedPath, reason: `Probe timed out after ${timeoutMs}ms` });
    }, timeoutMs);

    child.stdout?.on("data", (c: Buffer) => (stdout += c.toString("utf-8")));
    child.stderr?.on("data", (c: Buffer) => (stderr += c.toString("utf-8")));
    child.on("error", (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        available: false,
        binaryPath: resolvedPath,
        reason: err.code === "ENOENT" ? "`agent-browser` not found on PATH" : err.message,
        notFound: err.code === "ENOENT",
      });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve({ available: true, binaryPath: resolvedPath, version: stdout.trim() || undefined });
      } else {
        resolve({
          available: false,
          binaryPath: resolvedPath,
          reason: stderr.trim() || `agent-browser --version exited with code ${String(code)}`,
        });
      }
    });
  });
}

// ── Chromium/Chrome executable discovery (for the verification driver) ─────────
//
// The app/browser driver (U8) drives a Chromium engine via playwright-core, which
// does NOT bundle or download a browser. It launches an EXISTING Chrome/Chromium
// discovered on the host. When no executable can be found the driver must report
// itself unavailable so the verification run resolves the assertion to
// INCONCLUSIVE (never a false pass/fail).

export interface BrowserExecutableProbeResult {
  /** True only when a usable Chrome/Chromium executable was located. */
  available: boolean;
  /** Absolute (or PATH-resolvable) executable path, when found. */
  executablePath?: string;
  /** Human-readable reason the executable is unavailable. */
  reason?: string;
}

/**
 * Well-known Chrome/Chromium executable locations, by platform. Checked in
 * order; the first that exists wins. Env overrides take precedence over these.
 */
function candidateBrowserPaths(env: NodeJS.ProcessEnv): string[] {
  const fromEnv = [env.FUSION_BROWSER_EXECUTABLE, env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, env.CHROME_PATH]
    .map((v) => v?.trim())
    .filter((v): v is string => !!v && v.length > 0);

  if (process.platform === "darwin") {
    return [
      ...fromEnv,
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ];
  }
  if (process.platform === "win32") {
    const programFiles = env["PROGRAMFILES"] ?? "C:\\Program Files";
    const programFilesX86 = env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)";
    return [
      ...fromEnv,
      `${programFiles}\\Google\\Chrome\\Application\\chrome.exe`,
      `${programFilesX86}\\Google\\Chrome\\Application\\chrome.exe`,
      `${programFilesX86}\\Microsoft\\Edge\\Application\\msedge.exe`,
    ];
  }
  return [
    ...fromEnv,
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
  ];
}

/** PATH-resolvable executable names to fall back to when no fixed path exists. */
const BROWSER_BINARY_NAMES = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome"];

/**
 * Locate a Chrome/Chromium executable the verification driver can launch.
 *
 * Resolution order: explicit `opts.executablePath` → env overrides
 * (`FUSION_BROWSER_EXECUTABLE` / `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` /
 * `CHROME_PATH`) → well-known platform paths → PATH lookup of common binary
 * names. Returns `available: false` (with a reason) when nothing is found, so
 * the caller degrades to INCONCLUSIVE rather than failing the assertion.
 */
export async function probeBrowserExecutable(opts?: {
  executablePath?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<BrowserExecutableProbeResult> {
  const env = opts?.env ?? process.env;
  const explicit = opts?.executablePath?.trim();
  if (explicit) {
    if (await isExecutableFile(explicit)) return { available: true, executablePath: explicit };
    return { available: false, reason: `configured browser executable not found: ${explicit}` };
  }

  for (const candidate of candidateBrowserPaths(env)) {
    if (await isExecutableFile(candidate)) return { available: true, executablePath: candidate };
  }

  for (const name of BROWSER_BINARY_NAMES) {
    const resolved = await tryResolveBinaryPath(name);
    if (resolved && (await isExecutableFile(resolved))) {
      return { available: true, executablePath: resolved };
    }
  }

  return {
    available: false,
    reason:
      "no Chrome/Chromium executable found (checked FUSION_BROWSER_EXECUTABLE / CHROME_PATH, well-known paths, and PATH)",
  };
}

async function isExecutableFile(p: string): Promise<boolean> {
  try {
    await access(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function tryResolveBinaryPath(binary: string): Promise<string | undefined> {
  return new Promise((resolvePromise) => {
    const which = process.platform === "win32" ? "where" : "which";
    const child = spawn(which, [binary], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // ignored
      }
      resolvePromise(undefined);
    }, 2000);

    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf-8");
    });
    child.on("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(undefined);
    });
    child.on("close", (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        const first = out.trim().split(/\r?\n/)[0];
        resolvePromise(first?.length ? first : undefined);
      } else {
        resolvePromise(undefined);
      }
    });
  });
}
