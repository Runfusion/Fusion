import { superviseSpawn } from "./process-supervisor.js";

export interface RunCommandOptions {
  cwd?: string;
  timeoutMs?: number;
  /**
   * Maximum bytes captured per stream. Output beyond this is dropped and
   * `bufferExceeded` is set — the child process is NOT killed, so commands
   * that produce huge output (e.g. test runners) still complete normally.
   */
  maxBuffer?: number;
  env?: NodeJS.ProcessEnv;
}

export interface RunCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  bufferExceeded: boolean;
  timedOut: boolean;
  spawnError?: Error;
}

const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024;
const FORCE_KILL_DELAY_MS = 5_000;
const NORMAL_CLEANUP_FORCE_KILL_DELAY_MS = 500;

/**
 * Run a shell command without blocking the Node.js event loop.
 *
 * Use this anywhere a long-running external process is invoked from a path
 * reachable by HTTP/WebSocket handlers — execSync would freeze every concurrent
 * request for the full duration of the child process. spawn yields back to
 * the event loop while the child runs.
 *
 * The promise always resolves (never rejects) so callers can branch on
 * `spawnError`, `timedOut`, and `exitCode` without try/catch.
 */
export function runCommandAsync(
  command: string,
  options: RunCommandOptions = {},
): Promise<RunCommandResult> {
  return new Promise((resolve) => {
    const maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER;
    let stdout = "";
    let stderr = "";
    let bufferExceeded = false;
    let timedOut = false;
    let forceKillTimer: NodeJS.Timeout | null = null;

    const supervised = superviseSpawn(command, [], {
      cwd: options.cwd,
      env: options.env,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      maxLifetimeMs: (options.timeoutMs ?? 0) > 0 ? options.timeoutMs! + FORCE_KILL_DELAY_MS + 1_000 : undefined,
    });
    const child = supervised.child;

    const signalProcessGroup = (signal: NodeJS.Signals): void => {
      supervised.kill(signal);
    };

    const scheduleForceKill = (delayMs: number): void => {
      if (forceKillTimer) return;
      forceKillTimer = setTimeout(() => {
        signalProcessGroup("SIGKILL");
      }, delayMs);
      forceKillTimer.unref();
    };

    const append = (current: string, chunk: Buffer): string => {
      const s = chunk.toString("utf-8");
      if (current.length + s.length > maxBuffer) {
        const remaining = Math.max(0, maxBuffer - current.length);
        bufferExceeded = true;
        return current + s.slice(0, remaining);
      }
      return current + s;
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });

    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          signalProcessGroup("SIGTERM");
          scheduleForceKill(FORCE_KILL_DELAY_MS);
        }, options.timeoutMs)
      : null;

    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
        forceKillTimer = null;
      }
      resolve({
        stdout,
        stderr,
        exitCode: null,
        signal: null,
        bufferExceeded,
        timedOut,
        spawnError: err,
      });
    });

    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
        forceKillTimer = null;
      }
      // A shell command can exit successfully while leaving background children
      // in its process group (for example test runners, qmd indexers, or dev
      // servers launched with `&`). Clean the group after every run so Fusion
      // agents do not leak processes beyond the command lifecycle.
      signalProcessGroup("SIGTERM");
      scheduleForceKill(NORMAL_CLEANUP_FORCE_KILL_DELAY_MS);
      resolve({
        stdout,
        stderr,
        exitCode: code,
        signal,
        bufferExceeded,
        timedOut,
      });
    });
  });
}
