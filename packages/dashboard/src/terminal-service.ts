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
// The node-pty native-asset loader (lazy-load, prebuild resolution, dlopen
// fallback, and permission repair) lives in @fusion/engine so PTY owners share
// one implementation. See packages/engine/src/pty-native.ts.
import { loadPtyModule } from "@fusion/engine";

// Maximum scrollback buffer size (characters)
const MAX_SCROLLBACK_SIZE = 50000; // ~50KB per terminal

// Session limit constants
const MIN_MAX_SESSIONS = 1;
const MAX_MAX_SESSIONS = 100;
const DEFAULT_MAX_SESSIONS = 10;

// Throttle output to prevent overwhelming WebSocket under heavy load.
// 16ms = 60fps, plenty for terminal redraw while leaving event-loop budget
// for the rest of the dashboard. Larger flush cap keeps `pnpm test`-class
// floods from generating thousands of timer-driven micro-flushes.
const OUTPUT_THROTTLE_MS = 16;
const OUTPUT_BATCH_SIZE = 64 * 1024; // 64KB per WebSocket frame

/*
FNXC:TerminalReadiness 2026-06-17-17:38:
Programmatic command injection into a brand-new PTY must wait until the shell has emitted initial output and then stayed quiet, because login shell rc/profile startup can otherwise drop or interleave leading command bytes.
Use a short quiet window to avoid writing into an actively streaming prompt/banner and a bounded timeout so silent shells never hang script execution.
*/
export const READY_QUIET_WINDOW_MS = 150;
export const READY_TIMEOUT_MS = 5_000;

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
  /**
   * Pending output chunks awaiting flush to clients. Stored as an array
   * (not a single concatenated string) so heavy bursts — e.g. a `pnpm test`
   * run inside an embedded terminal — don't trigger O(N²) string copies on
   * every flush tick, which previously caused multi-second event-loop stalls.
   */
  outputChunks: string[];
  outputBytes: number;
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
  resizeSuppressedChunks: string[];
  ready: boolean;
  firstOutputSeen: boolean;
  lastOutputAt: number | null;
  readyWaiters: Array<() => void>;
  readyTimeout: NodeJS.Timeout | null;
  readyQuietTimeout: NodeJS.Timeout | null;
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
   * Resolve all readiness waiters exactly once and clear readiness timers.
   */
  private resolveReady(session: TerminalSession): void {
    if (session.readyTimeout) {
      clearTimeout(session.readyTimeout);
      session.readyTimeout = null;
    }
    if (session.readyQuietTimeout) {
      clearTimeout(session.readyQuietTimeout);
      session.readyQuietTimeout = null;
    }

    if (!session.ready) {
      session.ready = true;
    }

    const waiters = session.readyWaiters.splice(0);
    for (const resolve of waiters) {
      resolve();
    }
  }

  /**
   * Observe PTY output for readiness using first-output plus quiet-window semantics.
   */
  private observeReadinessOutput(session: TerminalSession): void {
    if (session.ready) return;

    session.firstOutputSeen = true;
    session.lastOutputAt = Date.now();

    if (session.readyQuietTimeout) {
      clearTimeout(session.readyQuietTimeout);
    }
    session.readyQuietTimeout = setTimeout(() => {
      session.readyQuietTimeout = null;
      this.resolveReady(session);
    }, READY_QUIET_WINDOW_MS);
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
      outputChunks: [],
      outputBytes: 0,
      flushTimeout: null,
      resizeInProgress: false,
      resizeDebounceTimeout: null,
      resizeSuppressedChunks: [],
      ready: false,
      firstOutputSeen: false,
      lastOutputAt: null,
      readyWaiters: [],
      readyTimeout: null,
      readyQuietTimeout: null,
      _flushOutput: null,
    };

    session.readyTimeout = setTimeout(() => {
      session.readyTimeout = null;
      this.resolveReady(session);
    }, READY_TIMEOUT_MS);

    this.sessions.set(id, session);

    // Flush buffered output to clients (throttled).
    // Drains chunks from the front of the queue up to OUTPUT_BATCH_SIZE bytes
    // per frame. Using an array avoids the O(N) string-slice that the previous
    // implementation paid on every tick under heavy load.
    const flushOutput = () => {
      // Guard against firing after session was killed
      if (!this.sessions.has(id)) {
        session.flushTimeout = null;
        return;
      }

      if (session.outputChunks.length === 0) {
        session.outputBytes = 0;
        session.flushTimeout = null;
        return;
      }

      const drained: string[] = [];
      let drainedBytes = 0;
      while (session.outputChunks.length > 0 && drainedBytes < OUTPUT_BATCH_SIZE) {
        const next = session.outputChunks.shift() as string;
        drained.push(next);
        drainedBytes += next.length;
      }
      session.outputBytes = Math.max(0, session.outputBytes - drainedBytes);

      if (session.outputChunks.length > 0) {
        // More to send — schedule another flush after the throttle window.
        session.flushTimeout = setTimeout(flushOutput, OUTPUT_THROTTLE_MS);
      } else {
        session.flushTimeout = null;
      }

      const dataToSend = drained.length === 1 ? drained[0] : drained.join("");
      this.dataCallbacks.forEach((cb) => cb(id, dataToSend));
      this.emit("data", id, dataToSend);
    };

    // Store reference so the resize debounce can trigger a flush of
    // suppressed output through the same throttled path.
    session._flushOutput = flushOutput;

    // Forward data events with throttling
    ptyProcess.onData((data: string) => {
      this.observeReadinessOutput(session);

      // Always append to scrollback buffer so no output is lost
      session.scrollbackBuffer += data;
      if (session.scrollbackBuffer.length > MAX_SCROLLBACK_SIZE) {
        session.scrollbackBuffer = session.scrollbackBuffer.slice(-MAX_SCROLLBACK_SIZE);
      }

      // During resize, buffer to scrollback only — suppress immediate delivery
      // to avoid rendering artifacts, but queue the data so it is flushed to
      // clients once the resize debounce completes (no data loss).
      if (session.resizeInProgress) {
        session.resizeSuppressedChunks.push(data);
        return;
      }

      // Buffer output for throttled delivery
      session.outputChunks.push(data);
      session.outputBytes += data.length;

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
      this.resolveReady(session);
      session._flushOutput = null;
      session.resizeSuppressedChunks.length = 0;
      session.outputChunks.length = 0;
      session.outputBytes = 0;
      this.sessions.delete(id);
      this.exitCallbacks.forEach((cb) => cb(id, exitCode ?? 0));
      this.emit("exit", id, exitCode ?? 0);
    });

    console.info(`Session ${id} created successfully`);
    return { success: true, session };
  }

  /**
   * Wait until a fresh PTY shell has produced initial output and quieted.
   * Programmatic callers use this before sending a command; user keystrokes still call write() directly.
   */
  waitForReady(sessionId: string): Promise<void> {
    if (!this.isValidSessionId(sessionId)) {
      return Promise.resolve();
    }

    const session = this.sessions.get(sessionId);
    if (!session || session.ready) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      session.readyWaiters.push(resolve);
    });
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
          if (session.resizeSuppressedChunks.length > 0) {
            for (const chunk of session.resizeSuppressedChunks) {
              session.outputChunks.push(chunk);
              session.outputBytes += chunk.length;
            }
            session.resizeSuppressedChunks.length = 0;
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
          this.resolveReady(session);
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
      this.resolveReady(session);
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

    session.outputChunks.length = 0;
    session.outputBytes = 0;
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
        this.resolveReady(session);
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
