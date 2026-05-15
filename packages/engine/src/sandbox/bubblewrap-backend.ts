import { exec } from "node:child_process";
import { promisify } from "node:util";

import { detectBwrap } from "./bubblewrap-detect.js";
import { policyToBwrapArgs, type BubblewrapPolicy } from "./bubblewrap-policy.js";
import { NativeSandboxBackend } from "./native.js";
import type { SandboxBackend, SandboxCapabilities, SandboxPolicy, SandboxRunOptions, SandboxRunResult } from "./types.js";

const execAsync = promisify(exec);

type FailureMode = "fail-hard" | "fallback-native";

export class SandboxUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxUnavailableError";
  }
}

function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export class BubblewrapBackend implements SandboxBackend {
  private policy: BubblewrapPolicy = { allowNetwork: true };
  private useNativeFallback = false;

  constructor(private readonly nativeBackend: SandboxBackend = new NativeSandboxBackend()) {}

  capabilities(): SandboxCapabilities {
    return {
      id: "bubblewrap",
      supportsNetworkPolicy: true,
      supportsFilesystemPolicy: true,
      platform: ["linux"],
    };
  }

  async prepare(policy: SandboxPolicy): Promise<void> {
    this.policy = policy as BubblewrapPolicy;

    const detect = await detectBwrap();
    if (detect.available) return;

    const failureMode = (this.policy as BubblewrapPolicy & { failureMode?: FailureMode }).failureMode ?? "fail-hard";
    if (failureMode === "fallback-native") {
      this.useNativeFallback = true;
      await this.nativeBackend.prepare(policy);
      return;
    }

    throw new SandboxUnavailableError(
      `bubblewrap backend unavailable (${detect.reason ?? "unknown"}). Install bubblewrap and retry.`,
    );
  }

  async run(command: string, options: SandboxRunOptions): Promise<SandboxRunResult> {
    if (this.useNativeFallback) {
      return this.nativeBackend.run(command, options);
    }

    const detect = await detectBwrap();
    if (!detect.available) {
      const failureMode = (this.policy as BubblewrapPolicy & { failureMode?: FailureMode }).failureMode ?? "fail-hard";
      if (failureMode === "fallback-native") {
        return this.nativeBackend.run(command, options);
      }
      throw new SandboxUnavailableError(
        `bubblewrap backend unavailable (${detect.reason ?? "unknown"}). Install bubblewrap and retry.`,
      );
    }

    const pnpmStorePath = await this.resolvePnpmStorePath(options.cwd);
    const args = policyToBwrapArgs(this.policy, {
      worktreePath: options.cwd,
      repoRootPath: options.cwd,
      pnpmStorePath,
      nodeBinPath: process.execPath,
      homeDir: process.env.HOME ?? "",
      envSource: options.env ?? process.env,
    });

    const bwrapPath = detect.path ?? "bwrap";
    const shellCommand = `${quote(bwrapPath)} ${args.map(quote).join(" ")} -- /bin/sh -lc ${quote(command)}`;

    try {
      const { stdout, stderr } = await execAsync(shellCommand, {
        cwd: options.cwd,
        timeout: options.timeoutMs,
        maxBuffer: options.maxBuffer,
        ...(options.encoding !== undefined && { encoding: options.encoding }),
        ...(options.env !== undefined && { env: options.env }),
        ...(options.signal !== undefined && { signal: options.signal }),
      } as any);

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
    this.useNativeFallback = false;
  }

  private async resolvePnpmStorePath(cwd: string): Promise<string> {
    try {
      const { stdout } = await execAsync("pnpm store path --silent", {
        cwd,
        timeout: 10_000,
        maxBuffer: 256 * 1024,
        encoding: "utf-8",
      });
      const path = stdout.trim();
      return path || `${process.env.HOME ?? ""}/.local/share/pnpm`;
    } catch {
      return `${process.env.HOME ?? ""}/.local/share/pnpm`;
    }
  }
}
