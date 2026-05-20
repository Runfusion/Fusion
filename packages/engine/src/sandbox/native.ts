import { exec } from "node:child_process";
import { promisify } from "node:util";
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

const execAsync = promisify(exec);

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
    try {
      const execOptions: Parameters<typeof exec>[1] = {
        cwd: options.cwd,
        timeout: options.timeoutMs,
        maxBuffer: options.maxBuffer,
        ...(options.encoding !== undefined && { encoding: options.encoding }),
        ...(typeof options.shell === "string" && { shell: options.shell }),
        ...(options.env !== undefined && { env: options.env }),
        ...(options.signal !== undefined && { signal: options.signal }),
      };
      const { stdout, stderr } = await execAsync(command, execOptions);

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

      const killTree = (sig: NodeJS.Signals) => {
        supervised.kill(sig);
      };

      const timer = setTimeout(() => {
        timedOut = true;
        killTree("SIGTERM");
        setTimeout(() => {
          if (settled) return;
          killTree("SIGKILL");
        }, 5_000).unref();
      }, options.timeout);
      timer.unref();

      const onAbort = () => {
        aborted = true;
        killTree("SIGTERM");
        setTimeout(() => {
          if (settled) return;
          killTree("SIGKILL");
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
