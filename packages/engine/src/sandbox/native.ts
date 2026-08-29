import { superviseSpawn } from "@fusion/core";

import type {
  SandboxBackend,
  SandboxCapabilities,
  SandboxPolicy,
  SandboxRunOptions,
  SandboxRunResult,
  SandboxRunStreamingOptions,
  SandboxStreamingResult,
} from "./types.js";

const FORCE_KILL_DELAY_MS = 5_000;
const NORMAL_CLEANUP_FORCE_KILL_DELAY_MS = 500;

export class NativeSandboxBackend implements SandboxBackend {
  capabilities(): SandboxCapabilities {
    return {
      id: "native",
      supportsNetworkPolicy: false,
      supportsFilesystemPolicy: false,
      supportsStreaming: true,
      platform: "any",
    };
  }

  async prepare(_policy: SandboxPolicy): Promise<void> {
    return Promise.resolve();
  }

  async run(command: string, options: SandboxRunOptions): Promise<SandboxRunResult> {
    if (options.signal?.aborted) {
      return {
        stdout: "",
        stderr: "",
        exitCode: null,
        signal: null,
        timedOut: false,
        bufferExceeded: false,
        spawnError: new Error("Command aborted before start"),
      };
    }

    return await new Promise((resolve) => {
      const supervised = superviseSpawn(command, [], {
        cwd: options.cwd,
        shell: options.shell ?? true,
        stdio: ["ignore", "pipe", "pipe"],
        ...(options.env !== undefined && { env: options.env }),
        maxLifetimeMs: options.timeoutMs > 0 ? options.timeoutMs + FORCE_KILL_DELAY_MS + 1_000 : undefined,
      });
      const child = supervised.child;

      const encoding = options.encoding ?? "utf-8";
      let stdout = "";
      let stderr = "";
      let bufferExceeded = false;
      let timedOut = false;
      let settled = false;
      let forceKillTimer: ReturnType<typeof setTimeout> | null = null;

      const killTree = (signal: NodeJS.Signals): void => {
        supervised.kill(signal);
      };

      const scheduleForceKill = (delayMs = FORCE_KILL_DELAY_MS): void => {
        if (forceKillTimer) return;
        forceKillTimer = setTimeout(() => {
          killTree("SIGKILL");
        }, delayMs);
        forceKillTimer.unref();
      };

      const killTreeForCommandFailure = (): void => {
        killTree("SIGTERM");
        scheduleForceKill();
      };

      const append = (current: string, chunk: Buffer): string => {
        if (bufferExceeded) return current;
        const text = chunk.toString(encoding);
        if (current.length + text.length <= options.maxBuffer) {
          return current + text;
        }
        bufferExceeded = true;
        const remaining = Math.max(0, options.maxBuffer - current.length);
        killTreeForCommandFailure();
        return current + text.slice(0, remaining);
      };

      const timeout = options.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            killTreeForCommandFailure();
          }, options.timeoutMs)
        : null;
      timeout?.unref();

      const onAbort = (): void => {
        killTreeForCommandFailure();
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });

      const finish = (spawnError: Error | null, exitCode: number | null, signal: NodeJS.Signals | null): void => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        if (forceKillTimer) clearTimeout(forceKillTimer);
        options.signal?.removeEventListener("abort", onAbort);

        if (!spawnError) {
          killTree("SIGTERM");
          scheduleForceKill(NORMAL_CLEANUP_FORCE_KILL_DELAY_MS);
        }

        resolve({
          stdout,
          stderr,
          exitCode,
          signal,
          timedOut,
          bufferExceeded,
          ...(spawnError ? { spawnError } : {}),
        });
      };

      child.stdout?.on("data", (chunk: Buffer) => {
        stdout = append(stdout, chunk);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr = append(stderr, chunk);
      });
      child.on("error", (error) => finish(error, null, null));
      child.on("close", (code, signal) => finish(null, code, signal));
    });
  }

  async runStreaming(command: string, options: SandboxRunStreamingOptions): Promise<SandboxStreamingResult> {
    if (options.signal?.aborted) {
      return {
        outcome: "aborted",
        phase: "pre-start",
        stdout: "",
        stderr: "",
      };
    }

    return await new Promise((resolve) => {
      const supervised = superviseSpawn(command, [], {
        cwd: options.cwd,
        shell: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
          ...(options.env ?? {}),
        },
        maxLifetimeMs: options.timeout + 6_000,
      });
      const child = supervised.child;

      let stdout = "";
      let stderr = "";
      let stdoutOverflow = false;
      let stderrOverflow = false;
      let timedOut = false;
      let aborted = false;
      let settled = false;
      let forceKillTimer: ReturnType<typeof setTimeout> | null = null;

      const killTree = (sig: NodeJS.Signals) => {
        supervised.kill(sig);
      };

      const scheduleForceKill = (delayMs = FORCE_KILL_DELAY_MS): void => {
        if (forceKillTimer) return;
        forceKillTimer = setTimeout(() => {
          killTree("SIGKILL");
        }, delayMs);
        forceKillTimer.unref();
      };

      const timer = setTimeout(() => {
        timedOut = true;
        killTree("SIGTERM");
        scheduleForceKill();
      }, options.timeout);
      timer.unref();

      const onAbort = () => {
        aborted = true;
        killTree("SIGTERM");
        scheduleForceKill();
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });

      child.stdout?.on("data", (chunk: Buffer) => {
        if (stdoutOverflow) return;
        if (stdout.length + chunk.length > options.maxBuffer) {
          stdoutOverflow = true;
          stdout += chunk.toString("utf-8", 0, options.maxBuffer - stdout.length);
          return;
        }
        stdout += chunk.toString("utf-8");
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        if (stderrOverflow) return;
        if (stderr.length + chunk.length > options.maxBuffer) {
          stderrOverflow = true;
          stderr += chunk.toString("utf-8", 0, options.maxBuffer - stderr.length);
          return;
        }
        stderr += chunk.toString("utf-8");
      });

      const finish = (err: NodeJS.ErrnoException | null, code: number | null, signal: NodeJS.Signals | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (forceKillTimer) clearTimeout(forceKillTimer);
        options.signal?.removeEventListener("abort", onAbort);

        if (aborted) {
          resolve({ outcome: "aborted", phase: "mid-flight", stdout, stderr });
          return;
        }

        if (timedOut) {
          resolve({ outcome: "timeout", timeoutMs: options.timeout, stdout, stderr });
          return;
        }

        if (err) {
          resolve({ outcome: "spawn-error", error: err, stdout, stderr });
          return;
        }

        if (code === 0) {
          killTree("SIGTERM");
          scheduleForceKill(NORMAL_CLEANUP_FORCE_KILL_DELAY_MS);
          resolve({
            outcome: "success",
            stdout,
            stderr,
            bufferOverflow: stdoutOverflow || stderrOverflow,
          });
          return;
        }

        resolve({
          outcome: "non-zero-exit",
          stdout,
          stderr,
          exitCode: code,
          signal,
        });
      };

      child.on("error", (err) => finish(err, null, null));
      child.on("close", (code, signal) => finish(null, code, signal));
    });
  }

  async dispose(): Promise<void> {
    return Promise.resolve();
  }
}
