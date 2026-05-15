import { exec } from "node:child_process";
import { promisify } from "node:util";

import type { SandboxBackend, SandboxCapabilities, SandboxPolicy, SandboxRunOptions, SandboxRunResult } from "./types.js";

const execAsync = promisify(exec);

export class NativeSandboxBackend implements SandboxBackend {
  capabilities(): SandboxCapabilities {
    return {
      id: "native",
      supportsNetworkPolicy: false,
      supportsFilesystemPolicy: false,
      platform: "any",
    };
  }

  async prepare(_policy: SandboxPolicy): Promise<void> {
    return Promise.resolve();
  }

  async run(command: string, options: SandboxRunOptions): Promise<SandboxRunResult> {
    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: options.cwd,
        timeout: options.timeoutMs,
        maxBuffer: options.maxBuffer,
        ...(options.encoding !== undefined && { encoding: options.encoding }),
        ...(options.shell !== undefined && { shell: options.shell }),
        ...(options.env !== undefined && { env: options.env }),
        ...(options.signal !== undefined && { signal: options.signal }),
      });

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

  async dispose(): Promise<void> {
    return Promise.resolve();
  }
}
