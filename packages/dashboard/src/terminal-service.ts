/**
 * Terminal Service
 *
 * Manages PTY (pseudo-terminal) sessions using node-pty.
 * Supports cross-platform shell detection and secure session management.
 */

// Static type-only import for types (no runtime code)
import type { IPty, IPtyForkOptions, IWindowsPtyForkOptions } from "node-pty";
import { EventEmitter } from "events";
import * as os from "os";
import * as path from "path";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import { join, dirname } from "node:path";

// Detect if we're running as a Bun-compiled binary
// @ts-expect-error - Bun global is only available in Bun runtime
const isBunBinary = typeof Bun !== "undefined" && !!Bun.embeddedFiles;

// Lazy-loaded node-pty module (only loaded when terminal is actually used)
let ptyModule: typeof import("node-pty") | null = null;
let ptyLoadError: Error | null = null;

const require = createRequire(import.meta.url);

/**
 * Find the staged native assets directory for Bun-compiled binaries.
 * Looks for runtime/<platform-arch>/ next to the binary.
 *
 * NOTE: The fs.existsSync() calls in this function run during service initialization
 * (when terminal is first used). This is acceptable as it only executes once per
 * service lifetime, not per-request.
 */
function getNativePrebuildName(): string {
  const platform = process.platform === "darwin" ? "darwin" :
                   process.platform === "linux" ? "linux" :
                   process.platform === "win32" ? "win32" : "unknown";
  const arch = process.arch === "arm64" ? "arm64" :
               process.arch === "x64" ? "x64" : "unknown";
  return `${platform}-${arch}`;
}

function findInstalledNodePtyNativeDir(): string | null {
  try {
    const packageJsonPath = require.resolve("node-pty/package.json");
    const pkgRoot = dirname(packageJsonPath);

    // @homebridge/node-pty-prebuilt-multiarch (aliased as node-pty) places the binary
    // in build/Release/pty.node after prebuild-install runs at install time.
    // Prefer this location as it is the fork's standard output path.
    const releaseDir = join(pkgRoot, "build", "Release");
    if (fs.existsSync(join(releaseDir, "pty.node"))) {
      return releaseDir;
    }

    // Fallback: check the old prebuilds/<plat-arch>/ layout (upstream node-pty style).
    const prebuildDir = join(pkgRoot, "prebuilds", getNativePrebuildName());
    if (fs.existsSync(join(prebuildDir, "pty.node"))) {
      return prebuildDir;
    }

    return null;
  } catch {
    return null;
  }
}

function ensureNodePtyNativePermissions(): void {
  if (process.platform === "win32") {
    return;
  }

  const candidateDirs = new Set<string>();
  const envNativeDir = process.env.NODE_PTY_SPAWN_HELPER_DIR || process.env.FUSION_NATIVE_ASSETS_PATH;
  if (envNativeDir) {
    candidateDirs.add(envNativeDir);
  }

  const stagedNativeDir = findStagedNativeDir();
  if (stagedNativeDir) {
    candidateDirs.add(stagedNativeDir);
  }

  const installedNativeDir = findInstalledNodePtyNativeDir();
  if (installedNativeDir) {
    candidateDirs.add(installedNativeDir);
  }

  for (const nativeDir of candidateDirs) {
    const helperPath = join(nativeDir, "spawn-helper");
    const nativeModulePath = join(nativeDir, "pty.node");

    try {
      fs.chmodSync(helperPath, 0o755);
    } catch {
      // Best-effort permission repair; helper may not exist in some layouts.
    }

    try {
      fs.chmodSync(nativeModulePath, 0o755);
    } catch (err) {
      // Keep diagnostics for the native module path since missing/invalid perms
      // here are more likely to prevent PTY startup.
      console.warn("[terminal] Failed to repair node-pty native permissions:", {
        nativeDir,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

function findStagedNativeDir(): string | null {
  const prebuildName = getNativePrebuildName();

  // Check FUSION_RUNTIME_DIR env var first
  if (process.env.FUSION_RUNTIME_DIR) {
    const envPath = join(process.env.FUSION_RUNTIME_DIR, prebuildName);
    if (fs.existsSync(join(envPath, "pty.node"))) {
      return envPath;
    }
  }

  // Look next to the executable
  const execDir = dirname(process.execPath);
  const nextToBinary = join(execDir, "runtime", prebuildName);
  if (fs.existsSync(join(nextToBinary, "pty.node"))) {
    return nextToBinary;
  }

  return null;
}

async function loadPtyModule(): Promise<typeof import("node-pty")> {
  ensureNodePtyNativePermissions();

  if (ptyModule) {
    return ptyModule;
  }

  if (ptyLoadError) {
    throw ptyLoadError;
  }

  // For Bun-compiled binary, set up native paths before loading
  if (isBunBinary) {
    const nativeDir = findStagedNativeDir();
    if (nativeDir) {
      // Set spawn-helper directory
      if (process.platform !== "win32") {
        process.env.NODE_PTY_SPAWN_HELPER_DIR = nativeDir;
      }
      // Store reference for debugging
      process.env.FUSION_NATIVE_ASSETS_PATH = nativeDir;

      // Try to pre-load the native module using process.dlopen
      // This can help when the normal require() path fails
      const nativePath = join(nativeDir, "pty.node");
      if (fs.existsSync(nativePath)) {
        try {
          const nativeModule: { exports?: unknown } = { exports: {} };
          // process.dlopen is a Node internal API
          process.dlopen(nativeModule, nativePath);
          console.log("[terminal] Pre-loaded native module via dlopen");
        } catch (dlopenErr) {
          // dlopen failed - log but continue, normal import might still work
          console.log("[terminal] dlopen pre-load failed (continuing):", dlopenErr);
        }
      }
    }
  }

  try {
    // Standard import path - the native-patch setup should have created
    // the necessary symlink structure for node-pty to find the module
    const mod = await import("node-pty");
    ptyModule = mod;
    return ptyModule as typeof import("node-pty");
  } catch (err) {
    ptyLoadError = err instanceof Error ? err : new Error(String(err));
    throw ptyLoadError;
  }
}

// Maximum scrollback buffer size (characters)
const MAX_SCROLLBACK_SIZE = 50000; // ~50KB per terminal

// Session limit constants
const MIN_MAX_SESSIONS = 1;
const MAX_MAX_SESSIONS = 100;
const DEFAULT_MAX_SESSIONS = 10;

// Throttle output to prevent overwhelming WebSocket under heavy load
const OUTPUT_THROTTLE_MS = 4; // ~250fps max update rate for responsive input
const OUTPUT_BATCH_SIZE = 4096; // Smaller batches for lower latency

// Stale session threshold: sessions inactive for more than 5 minutes are eligible for eviction
export const STALE_SESSION_THRESHOLD_MS = 300_000; // 5 minutes

// Valid session ID pattern (alphanumeric and dashes only)
const SESSION_ID_PATTERN = /^[a-zA-Z0-9-]+$/;

// Allowed shell paths for security
const ALLOWED_SHELL_PATHS: Record<string, string[]> = {
  darwin: ["/bin/bash", "/bin/zsh", "/bin/sh", "/usr/local/bin/bash", "/usr/local/bin/zsh"],
  linux: ["/bin/bash", "/bin/zsh", "/bin/sh", "/usr/bin/bash", "/usr/bin/zsh", "/usr/bin/sh"],
  win32: [
    "C:\\Windows\\System32\\cmd.exe",
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    "powershell.exe",
    "cmd.exe",
  ],
};

// Environment variables to strip from user shells
const STRIP_ENV_VARS = [
  "PORT",
  "DATA_DIR",
  "AUTOMAKER_API_KEY",
  "NODE_PATH",
  "GITHUB_TOKEN",
  "FUSION_API_KEY",
];

export interface TerminalSession {
  id: string;
  pty: IPty;
  cwd: string;
  createdAt: Date;
  lastActivityAt: Date;
  shell: string;
  scrollbackBuffer: string;
  outputBuffer: string;
  flushTimeout: NodeJS.Timeout | null;
  resizeInProgress: boolean;
  resizeDebounceTimeout: NodeJS.Timeout | null;
  /**
   * PTY output queued during resize suppression.
   * Instead of discarding data that arrives while `resizeInProgress` is true,
   * we buffer it here and flush it to clients once the resize debounce completes.
   * This prevents the initial shell prompt (and other output) from being lost
   * when it falls inside the 150 ms resize-suppression window.
   */
  resizeSuppressedBuffer: string;
  /** Internal flush callback set by createSession; used by resize debounce */
  _flushOutput: (() => void) | null;
}

export interface TerminalOptions {
  cwd?: string;
  shell?: string;
  cols?: number;
  rows?: number;
  env?: Record<string, string>;
}

export type CreateSessionErrorCode =
  | "max_sessions"
  | "invalid_shell"
  | "pty_load_failed"
  | "pty_spawn_failed";

export type CreateSessionResult =
  | { success: true; session: TerminalSession }
  | { success: false; error: string; code: CreateSessionErrorCode };

type DataCallback = (sessionId: string, data: string) => void;
type ExitCallback = (sessionId: string, exitCode: number) => void;

export class TerminalService extends EventEmitter {
  private sessions: Map<string, TerminalSession> = new Map();
  private dataCallbacks: Set<DataCallback> = new Set();
  private exitCallbacks: Set<ExitCallback> = new Set();
  private isWindows = os.platform() === "win32";
  private projectRoot: string;
  private maxSessions: number;

  constructor(projectRoot: string, maxSessions: number = DEFAULT_MAX_SESSIONS) {
    super();
    this.projectRoot = path.resolve(projectRoot);
    this.maxSessions = Math.max(MIN_MAX_SESSIONS, Math.min(maxSessions, MAX_MAX_SESSIONS));
  }

  /**
   * Kill a PTY process with platform-specific handling.
   * Windows doesn't support Unix signals like SIGTERM/SIGKILL.
   */
  private killPtyProcess(ptyProcess: IPty, signal: string = "SIGTERM"): void {
    if (this.isWindows) {
      ptyProcess.kill();
    } else {
      ptyProcess.kill(signal);
    }
  }

  /**
   * Get the default allowed shells for the current platform
   */
  private getAllowedShells(): string[] {
    const platform = os.platform();
    return ALLOWED_SHELL_PATHS[platform] || ALLOWED_SHELL_PATHS.linux;
  }

  /**
   * Validate that a shell path is allowed
   */
  private isAllowedShell(shellPath: string): boolean {
    const allowed = this.getAllowedShells();
    const normalized = this.isWindows ? shellPath.toLowerCase() : shellPath;
    return allowed.some((s) => (this.isWindows ? s.toLowerCase() : s) === normalized);
  }

  /**
   * Detect the best shell for the current platform
   */
  detectShell(): { shell: string; args: string[] } {
    const platform = os.platform();
    const allowedShells = this.getAllowedShells();

    // Helper to get basename handling both path separators
    const getBasename = (shellPath: string): string => {
      const lastSep = Math.max(shellPath.lastIndexOf("/"), shellPath.lastIndexOf("\\"));
      return lastSep >= 0 ? shellPath.slice(lastSep + 1) : shellPath;
    };

    // Helper to get shell args based on shell name
    const getShellArgs = (shell: string): string[] => {
      const shellName = getBasename(shell).toLowerCase().replace(".exe", "");
      // PowerShell and cmd don't need --login
      if (shellName === "powershell" || shellName === "pwsh" || shellName === "cmd") {
        return [];
      }
      // sh doesn't support --login in all implementations
      if (shellName === "sh") {
        return [];
      }
      // bash, zsh, and other POSIX shells support --login
      return ["--login"];
    };

    // First try user's shell from env if it's allowed
    const userShell = process.env.SHELL;
    if (userShell && platform !== "win32") {
      const normalizedUserShell = this.isWindows ? userShell.toLowerCase() : userShell;
      for (const allowed of allowedShells) {
        const normalizedAllowed = this.isWindows ? allowed.toLowerCase() : allowed;
        if (normalizedAllowed === normalizedUserShell && fs.existsSync(allowed)) {
          return { shell: allowed, args: getShellArgs(allowed) };
        }
      }
    }

    // Iterate through allowed shell paths and return first existing one
    for (const shell of allowedShells) {
      if (fs.existsSync(shell)) {
        return { shell, args: getShellArgs(shell) };
      }
    }

    // Ultimate fallbacks based on platform
    if (platform === "win32") {
      return { shell: "cmd.exe", args: [] };
    }
    return { shell: "/bin/sh", args: [] };
  }

  /**
   * Build concise diagnostics for PTY launch failures without logging the full environment.
   */
  private getSpawnDiagnostics(
    requestedShell: string | undefined,
    detectedShell: string,
    detectedArgs: string[],
    cwd: string,
  ): Record<string, unknown> {
    return {
      platform: os.platform(),
      projectRoot: this.projectRoot,
      cwd,
      requestedShell: requestedShell ?? null,
      detectedShell,
      detectedArgs,
      envShell: process.env.SHELL ?? null,
      allowedShells: this.getAllowedShells().filter((shellPath) => fs.existsSync(shellPath)),
    };
  }

  /**
   * Validate and resolve a working directory path
   */
  private async resolveWorkingDirectory(requestedCwd?: string): Promise<string> {
    // If no cwd requested, use project root
    if (!requestedCwd) {
      return this.projectRoot;
    }

    // Clean up the path
    let cwd = requestedCwd.trim();

    // Reject paths with null bytes (could bypass path checks)
    if (cwd.includes("\0")) {
      console.warn(`Rejecting path with null byte: ${cwd.replace(/\0/g, "\\0")}`);
      return this.projectRoot;
    }

    // Normalize the path to resolve . and .. segments
    cwd = path.resolve(this.projectRoot, cwd);

    // Ensure path is within project root (path traversal protection)
    const relativeToProjectRoot = path.relative(this.projectRoot, cwd);
    if (
      relativeToProjectRoot.startsWith("..") ||
      path.isAbsolute(relativeToProjectRoot)
    ) {
      console.warn(`Path traversal attempt blocked: ${requestedCwd}`);
      return this.projectRoot;
    }

    // Check if path exists and is a directory
    try {
      const stat = await import("node:fs/promises").then((fs) => fs.stat(cwd));
      if (stat.isDirectory()) {
        return cwd;
      }
    } catch {
      // Path doesn't exist, fall back to project root
      console.warn(`Working directory does not exist: ${cwd}`);
    }

    return this.projectRoot;
  }

  /**
   * Validate session ID format
   */
  private isValidSessionId(sessionId: string): boolean {
    return SESSION_ID_PATTERN.test(sessionId);
  }

  /**
   * Get current session count
   */
  getSessionCount(): number {
    return this.sessions.size;
  }

  /**
   * Get maximum allowed sessions
   */
  getMaxSessions(): number {
    return this.maxSessions;
  }

  /**
   * Set maximum allowed sessions
   */
  setMaxSessions(limit: number): void {
    if (limit >= MIN_MAX_SESSIONS && limit <= MAX_MAX_SESSIONS) {
      this.maxSessions = limit;
    }
  }

  /**
   * Update the last activity timestamp for a session
   */
  updateActivity(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastActivityAt = new Date();
    }
  }

  /**
   * Get sessions that have been inactive for longer than the given threshold
   * @param thresholdMs Inactivity threshold in milliseconds
   * @returns Array of stale sessions sorted by lastActivityAt (oldest first)
   */
  getStaleSessions(thresholdMs: number): TerminalSession[] {
    const now = Date.now();
    const stale: TerminalSession[] = [];
    for (const session of this.sessions.values()) {
      if (now - session.lastActivityAt.getTime() > thresholdMs) {
        stale.push(session);
      }
    }
    // Sort oldest first
    stale.sort((a, b) => a.lastActivityAt.getTime() - b.lastActivityAt.getTime());
    return stale;
  }

  /**
   * Evict stale sessions that have been inactive beyond the threshold.
   * Kills sessions sorted by oldest activity first, stopping once below the target count.
   * @param thresholdMs Inactivity threshold in milliseconds (default: STALE_SESSION_THRESHOLD_MS)
   * @returns Number of sessions evicted
   */
  evictStaleSessions(thresholdMs: number = STALE_SESSION_THRESHOLD_MS): number {
    const staleSessions = this.getStaleSessions(thresholdMs);
    let evicted = 0;
    const targetCount = Math.floor(this.maxSessions * 0.8);

    for (const session of staleSessions) {
      if (this.sessions.size <= targetCount) break;
      const idleDuration = Date.now() - session.lastActivityAt.getTime();
      console.info(
        `Evicting stale session ${session.id} (idle for ${Math.round(idleDuration / 1000)}s)`,
      );
      this.killSession(session.id);
      evicted++;
    }

    return evicted;
  }

  /**
   * Create a new terminal session
   */
  async createSession(options: TerminalOptions = {}): Promise<CreateSessionResult> {
    // Auto-evict stale sessions when at 80% of limit
    if (this.sessions.size >= Math.floor(this.maxSessions * 0.8)) {
      this.evictStaleSessions();
    }

    // Check session limit
    if (this.sessions.size >= this.maxSessions) {
      console.error(`Max sessions (${this.maxSessions}) reached, refusing new session`);
      return {
        success: false,
        code: "max_sessions",
        error: "Maximum terminal sessions reached. Please close an existing terminal and try again.",
      };
    }

    const id = `term-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;

    const { shell: detectedShell, args: shellArgs } = this.detectShell();
    const shell = options.shell || detectedShell;

    // Validate shell is allowed
    if (!this.isAllowedShell(shell)) {
      console.error(`Shell not allowed: ${shell}`);
      return {
        success: false,
        code: "invalid_shell",
        error: "Shell not allowed. Please use a supported shell (bash, zsh, sh, cmd, powershell).",
      };
    }

    // Validate and resolve working directory
    const cwd = await this.resolveWorkingDirectory(options.cwd);
    const spawnDiagnostics = this.getSpawnDiagnostics(options.shell, detectedShell, shellArgs, cwd);

    // Build environment with stripped sensitive vars
    const cleanEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && !STRIP_ENV_VARS.includes(key)) {
        cleanEnv[key] = value;
      }
    }

    const env: Record<string, string> = {
      ...cleanEnv,
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      TERM_PROGRAM: "fn-terminal",
      LANG: process.env.LANG || "en_US.UTF-8",
      LC_ALL: process.env.LC_ALL || process.env.LANG || "en_US.UTF-8",
      ...options.env,
    };

    console.info(`[createSession] Creating session ${id}`, {
      ...spawnDiagnostics,
      selectedShell: shell,
      selectedArgs: shell === detectedShell ? shellArgs : [],
    });

    // Lazy-load node-pty module with proper error handling
    let pty: typeof import("node-pty");
    try {
      pty = await loadPtyModule();
    } catch (loadErr) {
      console.error(`[terminal] Failed to load PTY module: ${loadErr}`);
      return {
        success: false,
        code: "pty_load_failed",
        error: "Terminal service unavailable. The PTY module could not be loaded.",
      };
    }

    // Build PTY spawn options
    const ptyOptions: IPtyForkOptions = {
      name: "xterm-256color",
      cols: options.cols || 80,
      rows: options.rows || 24,
      cwd,
      env,
    };

    // On Windows, use winpty instead of ConPTY for compatibility
    if (this.isWindows) {
      (ptyOptions as IWindowsPtyForkOptions).useConpty = false;
    }

    const attemptedSpawns = new Set<string>();
    const spawnAttempts: Array<{ shell: string; args: string[]; reason: string }> = [];
    const addSpawnAttempt = (shellPath: string, args: string[], reason: string): void => {
      const key = `${shellPath}\0${args.join("\0")}`;
      if (attemptedSpawns.has(key)) return;
      attemptedSpawns.add(key);
      spawnAttempts.push({ shell: shellPath, args, reason });
    };

    addSpawnAttempt(shell, shellArgs, "primary");

    if (shellArgs.length > 0) {
      addSpawnAttempt(shell, [], "retry-without-login");
    }

    for (const allowedShell of this.getAllowedShells()) {
      if (allowedShell === shell || !fs.existsSync(allowedShell)) continue;
      const shellName = path.basename(allowedShell).toLowerCase().replace(".exe", "");
      const fallbackArgs = shellName === "bash" || shellName === "zsh" ? [] : [];
      addSpawnAttempt(allowedShell, fallbackArgs, "allowed-fallback");
    }

    let ptyProcess: IPty | undefined;
    let lastSpawnError: unknown;
    for (const attempt of spawnAttempts) {
      try {
        console.info(
          `[createSession] Spawning terminal via ${attempt.reason}: ${attempt.shell} ${attempt.args.join(" ")} in ${cwd}`,
        );
        ptyProcess = pty.spawn(attempt.shell, attempt.args, ptyOptions);
        break;
      } catch (spawnError) {
        lastSpawnError = spawnError;
        console.error(
          `[createSession] PTY spawn failed (${attempt.reason}) for ${attempt.shell} ${attempt.args.join(" ")}:`,
          spawnError,
          spawnDiagnostics,
        );
      }
    }

    if (!ptyProcess) {
      console.error(`[createSession] All PTY spawn attempts failed`, lastSpawnError, spawnDiagnostics);
      return {
        success: false,
        code: "pty_spawn_failed",
        error: "Failed to start terminal shell process.",
      };
    }

    const session: TerminalSession = {
      id,
      pty: ptyProcess,
      cwd,
      createdAt: new Date(),
      lastActivityAt: new Date(),
      shell,
      scrollbackBuffer: "",
      outputBuffer: "",
      flushTimeout: null,
      resizeInProgress: false,
      resizeDebounceTimeout: null,
      resizeSuppressedBuffer: "",
      _flushOutput: null,
    };

    this.sessions.set(id, session);

    // Flush buffered output to clients (throttled)
    const flushOutput = () => {
      // Guard against firing after session was killed
      if (!this.sessions.has(id)) {
        session.flushTimeout = null;
        return;
      }

      if (session.outputBuffer.length === 0) {
        session.flushTimeout = null;
        return;
      }

      let dataToSend = session.outputBuffer;
      if (dataToSend.length > OUTPUT_BATCH_SIZE) {
        dataToSend = session.outputBuffer.slice(0, OUTPUT_BATCH_SIZE);
        session.outputBuffer = session.outputBuffer.slice(OUTPUT_BATCH_SIZE);
        session.flushTimeout = setTimeout(flushOutput, OUTPUT_THROTTLE_MS);
      } else {
        session.outputBuffer = "";
        session.flushTimeout = null;
      }

      this.dataCallbacks.forEach((cb) => cb(id, dataToSend));
      this.emit("data", id, dataToSend);
    };

    // Store reference so the resize debounce can trigger a flush of
    // suppressed output through the same throttled path.
    session._flushOutput = flushOutput;

    // Forward data events with throttling
    ptyProcess.onData((data: string) => {
      // Always append to scrollback buffer so no output is lost
      session.scrollbackBuffer += data;
      if (session.scrollbackBuffer.length > MAX_SCROLLBACK_SIZE) {
        session.scrollbackBuffer = session.scrollbackBuffer.slice(-MAX_SCROLLBACK_SIZE);
      }

      // During resize, buffer to scrollback only — suppress immediate delivery
      // to avoid rendering artifacts, but queue the data so it is flushed to
      // clients once the resize debounce completes (no data loss).
      if (session.resizeInProgress) {
        session.resizeSuppressedBuffer += data;
        return;
      }

      // Buffer output for throttled delivery
      session.outputBuffer += data;

      if (!session.flushTimeout) {
        session.flushTimeout = setTimeout(flushOutput, OUTPUT_THROTTLE_MS);
      }
    });

    // Handle exit
    ptyProcess.onExit(({ exitCode }: { exitCode: number; signal?: number }) => {
      console.info(`Session exited with code ${exitCode ?? 0} (${id})`);
      // Clean up timers before removing session
      if (session.flushTimeout) {
        clearTimeout(session.flushTimeout);
        session.flushTimeout = null;
      }
      if (session.resizeDebounceTimeout) {
        clearTimeout(session.resizeDebounceTimeout);
        session.resizeDebounceTimeout = null;
      }
      session._flushOutput = null;
      session.resizeSuppressedBuffer = "";
      this.sessions.delete(id);
      this.exitCallbacks.forEach((cb) => cb(id, exitCode ?? 0));
      this.emit("exit", id, exitCode ?? 0);
    });

    console.info(`Session ${id} created successfully`);
    return { success: true, session };
  }

  /**
   * Write data to a terminal session
   */
  write(sessionId: string, data: string): boolean {
    if (!this.isValidSessionId(sessionId)) {
      return false;
    }

    const session = this.sessions.get(sessionId);
    if (!session) {
      console.warn(`Session ${sessionId} not found`);
      return false;
    }

    // Reject data with null bytes
    if (data.includes("\0")) {
      console.warn(`Rejecting input with null byte to session ${sessionId}`);
      return false;
    }

    session.pty.write(data);
    this.updateActivity(sessionId);
    return true;
  }

  /**
   * Alias for write() for backward compatibility
   */
  writeInput(sessionId: string, data: string): boolean {
    return this.write(sessionId, data);
  }

  /**
   * Resize a terminal session
   */
  resize(sessionId: string, cols: number, rows: number, suppressOutput: boolean = true): boolean {
    if (!this.isValidSessionId(sessionId)) {
      return false;
    }

    const session = this.sessions.get(sessionId);
    if (!session) {
      console.warn(`Session ${sessionId} not found for resize`);
      return false;
    }

    try {
      if (suppressOutput) {
        session.resizeInProgress = true;
        if (session.resizeDebounceTimeout) {
          clearTimeout(session.resizeDebounceTimeout);
        }
      }

      session.pty.resize(cols, rows);

      if (suppressOutput) {
        session.resizeDebounceTimeout = setTimeout(() => {
          session.resizeInProgress = false;
          session.resizeDebounceTimeout = null;

          // Flush any data that was suppressed during the resize window.
          // This ensures the initial shell prompt (and any other output that
          // landed inside the suppression window) is delivered to clients
          // rather than being silently dropped.
          if (session.resizeSuppressedBuffer.length > 0) {
            session.outputBuffer += session.resizeSuppressedBuffer;
            session.resizeSuppressedBuffer = "";
            if (!session.flushTimeout && session._flushOutput) {
              session.flushTimeout = setTimeout(session._flushOutput, OUTPUT_THROTTLE_MS);
            }
          }
        }, 150);
      }

      return true;
    } catch (error) {
      console.error(`Error resizing session ${sessionId}:`, error);
      session.resizeInProgress = false;
      return false;
    }
  }

  /**
   * Kill a terminal session
   */
  killSession(sessionId: string): boolean {
    if (!this.isValidSessionId(sessionId)) {
      return false;
    }

    const session = this.sessions.get(sessionId);
    if (!session) {
      return false;
    }

    try {
      // Clean up flush timeout
      if (session.flushTimeout) {
        clearTimeout(session.flushTimeout);
        session.flushTimeout = null;
      }

      if (session.resizeDebounceTimeout) {
        clearTimeout(session.resizeDebounceTimeout);
        session.resizeDebounceTimeout = null;
      }

      // First try graceful SIGTERM
      console.info(`Session ${sessionId} sending SIGTERM`);
      this.killPtyProcess(session.pty, "SIGTERM");

      // Schedule SIGKILL fallback
      setTimeout(() => {
        if (this.sessions.has(sessionId)) {
          console.info(`Session ${sessionId} still alive after SIGTERM, sending SIGKILL`);
          // Clean up timers before removing session
          if (session.flushTimeout) {
            clearTimeout(session.flushTimeout);
            session.flushTimeout = null;
          }
          if (session.resizeDebounceTimeout) {
            clearTimeout(session.resizeDebounceTimeout);
            session.resizeDebounceTimeout = null;
          }
          try {
            this.killPtyProcess(session.pty, "SIGKILL");
          } catch {
            // Process may have already exited
          }
          this.sessions.delete(sessionId);
        }
      }, 1000);

      return true;
    } catch (error) {
      console.error(`Error killing session ${sessionId}:`, error);
      this.sessions.delete(sessionId);
      return false;
    }
  }

  /**
   * Get a session by ID
   */
  getSession(sessionId: string): TerminalSession | undefined {
    if (!this.isValidSessionId(sessionId)) {
      return undefined;
    }
    return this.sessions.get(sessionId);
  }

  /**
   * Get scrollback buffer for a session
   */
  getScrollback(sessionId: string): string | null {
    if (!this.isValidSessionId(sessionId)) {
      return null;
    }
    const session = this.sessions.get(sessionId);
    return session?.scrollbackBuffer || null;
  }

  /**
   * Get scrollback and clear pending output buffer
   */
  getScrollbackAndClearPending(sessionId: string): string | null {
    if (!this.isValidSessionId(sessionId)) {
      return null;
    }
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    session.outputBuffer = "";
    if (session.flushTimeout) {
      clearTimeout(session.flushTimeout);
      session.flushTimeout = null;
    }

    return session.scrollbackBuffer || null;
  }

  /**
   * Get all active sessions
   */
  getAllSessions(): Array<{ id: string; cwd: string; createdAt: Date; lastActivityAt: Date; shell: string }> {
    return Array.from(this.sessions.values()).map((s) => ({
      id: s.id,
      cwd: s.cwd,
      createdAt: s.createdAt,
      lastActivityAt: s.lastActivityAt,
      shell: s.shell,
    }));
  }

  /**
   * Subscribe to data events
   */
  onData(callback: DataCallback): () => void {
    this.dataCallbacks.add(callback);
    return () => this.dataCallbacks.delete(callback);
  }

  /**
   * Subscribe to exit events
   */
  onExit(callback: ExitCallback): () => void {
    this.exitCallbacks.add(callback);
    return () => this.exitCallbacks.delete(callback);
  }

  /**
   * Clean up all sessions
   */
  cleanup(): void {
    console.info(`Cleaning up ${this.sessions.size} sessions`);
    this.sessions.forEach((session, id) => {
      try {
        if (session.flushTimeout) {
          clearTimeout(session.flushTimeout);
          session.flushTimeout = null;
        }
        if (session.resizeDebounceTimeout) {
          clearTimeout(session.resizeDebounceTimeout);
          session.resizeDebounceTimeout = null;
        }
        this.killPtyProcess(session.pty);
      } catch {
        // Ignore errors during cleanup
      }
      this.sessions.delete(id);
    });
  }
}

// Per-project service instances (keyed by resolved project root)
const terminalServices: Map<string, TerminalService> = new Map();

export function getTerminalService(projectRoot?: string, maxSessions?: number): TerminalService {
  if (!projectRoot) {
    // Fallback: return the first available instance or throw
    const first = terminalServices.values().next();
    if (first.done) {
      throw new Error("TerminalService requires projectRoot for initialization");
    }
    return first.value;
  }
  const resolvedRoot = path.resolve(projectRoot);
  const existing = terminalServices.get(resolvedRoot);
  if (existing) {
    return existing;
  }
  const service = new TerminalService(resolvedRoot, maxSessions);
  terminalServices.set(resolvedRoot, service);
  return service;
}
