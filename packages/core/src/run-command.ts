import { spawn } from "node:child_process";

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

    const child = spawn(command, {
      cwd: options.cwd,
      env: options.env,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

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
          child.kill("SIGTERM");
          setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) {
              child.kill("SIGKILL");
            }
          }, 5_000).unref();
        }, options.timeoutMs)
      : null;

    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
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
