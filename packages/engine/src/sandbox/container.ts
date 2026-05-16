import * as childProcess from "node:child_process";
import { promisify } from "node:util";

import { buildContainerArgv } from "./container-argv.js";
import type {
  SandboxBackend,
  SandboxCapabilities,
  SandboxPolicy,
  SandboxRunOptions,
  SandboxRunResult,
  SandboxRunStreamingOptions,
  SandboxStreamingResult,
} from "./types.js";

function getExecAsync() {
  return promisify(childProcess.exec);
}

function getExecFileAsync() {
  return promisify((childProcess as { execFile: typeof import("node:child_process").execFile }).execFile);
}

/**
 * Experimental container-backed sandbox execution using Podman or Docker.
 */
export class ContainerSandboxBackend implements SandboxBackend {
  private readonly runtime: "podman" | "docker";

  private policy: SandboxPolicy = { allowNetwork: true };

  private probeCompleted = false;

  private runtimeAvailable = true;

  private runtimeProbeError: Error | undefined;

  constructor(options?: { runtime?: "podman" | "docker" }) {
    this.runtime = options?.runtime ?? "podman";
  }

  capabilities(): SandboxCapabilities {
    return {
      id: this.runtime,
      supportsNetworkPolicy: true,
      supportsFilesystemPolicy: false,
      supportsStreaming: true,
      platform: ["linux", "darwin"],
    };
  }

  async prepare(policy: SandboxPolicy): Promise<void> {
    this.policy = policy;
    if (this.probeCompleted) {
      return;
    }

    try {
      await getExecAsync()(`${this.runtime} --version`, { timeout: 5_000, maxBuffer: 1024 * 1024 });
      this.runtimeAvailable = true;
      this.runtimeProbeError = undefined;
    } catch (error) {
      this.runtimeAvailable = false;
      this.runtimeProbeError = error as Error;
    } finally {
      this.probeCompleted = true;
    }
  }

  async run(command: string, options: SandboxRunOptions): Promise<SandboxRunResult> {
    if (!this.probeCompleted) {
      await this.prepare(this.policy);
    }

    if (!this.runtimeAvailable) {
      return {
        stdout: "",
        stderr: "",
        exitCode: null,
        signal: null,
        timedOut: false,
        bufferExceeded: false,
        spawnError: this.runtimeProbeError,
      };
    }

    const argv = buildContainerArgv(this.runtime, command, options, this.policy);

    try {
      const execResult = await getExecFileAsync()(argv[0]!, argv.slice(1), {
        cwd: options.cwd,
        timeout: options.timeoutMs,
        maxBuffer: options.maxBuffer,
        encoding: options.encoding ?? "utf-8",
        signal: options.signal,
      });
      const stdout = typeof execResult === "object" && execResult && "stdout" in execResult ? execResult.stdout : execResult;
      const stderr = typeof execResult === "object" && execResult && "stderr" in execResult ? execResult.stderr : "";
      return {
        stdout: stdout?.toString?.() ?? "",
        stderr: stderr?.toString?.() ?? "",
        exitCode: 0,
        signal: null,
        timedOut: false,
        bufferExceeded: false,
      };
    } catch (error) {
      const errObj = error as Record<string, unknown>;
      const code = errObj.code;
      const status = typeof errObj.status === "number" ? errObj.status : null;
      const exitCode = typeof code === "number" ? code : status;
      const message = String(errObj.message ?? "");

      return {
        stdout: typeof (errObj.stdout as { toString?: unknown })?.toString === "function" ? String(errObj.stdout) : "",
        stderr: typeof (errObj.stderr as { toString?: unknown })?.toString === "function" ? String(errObj.stderr) : "",
        exitCode,
        signal: (errObj.signal as NodeJS.Signals | null | undefined) ?? null,
        bufferExceeded:
          code === "ENOBUFS"
          || code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
          || message.includes("maxBuffer"),
        timedOut:
          code === "ETIMEDOUT"
          || (errObj.killed === true && (errObj.signal === "SIGTERM" || message.includes("timed out"))),
        spawnError: code === "ENOENT" || code === "EACCES" ? (error as Error) : undefined,
      };
    }
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

    if (!this.probeCompleted) {
      await this.prepare(this.policy);
    }

    if (!this.runtimeAvailable) {
      return {
        outcome: "spawn-error",
        error: this.runtimeProbeError ?? new Error(`${this.runtime} unavailable`),
        stdout: "",
        stderr: "",
      };
    }

    const runOptions: SandboxRunOptions = {
      cwd: options.cwd,
      timeoutMs: options.timeout,
      maxBuffer: options.maxBuffer,
      env: options.env,
      signal: options.signal,
    };
    const argv = buildContainerArgv(this.runtime, command, runOptions, this.policy);

    return await new Promise((resolve) => {
      const child = childProcess.spawn(argv[0]!, argv.slice(1), {
        cwd: options.cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          ...(options.env ?? {}),
        },
      });

      let stdout = "";
      let stderr = "";
      let stdoutOverflow = false;
      let stderrOverflow = false;
      let timedOut = false;
      let aborted = false;
      let settled = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        setTimeout(() => {
          if (settled) return;
          child.kill("SIGKILL");
        }, 5_000).unref();
      }, options.timeout);
      timer.unref();

      const onAbort = () => {
        aborted = true;
        child.kill("SIGTERM");
        setTimeout(() => {
          if (settled) return;
          child.kill("SIGKILL");
        }, 5_000).unref();
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
          resolve({ outcome: "success", stdout, stderr, bufferOverflow: stdoutOverflow || stderrOverflow });
          return;
        }

        resolve({ outcome: "non-zero-exit", stdout, stderr, exitCode: code, signal });
      };

      child.on("error", (err) => finish(err, null, null));
      child.on("close", (code, signal) => finish(null, code, signal));
    });
  }

  async dispose(): Promise<void> {
    return Promise.resolve();
  }
}
