import { exec } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { detectSandboxExec } from "./sandbox-exec-detect.js";
import {
  fusionWorktreePreset,
  policyToSbplProfile,
  type SandboxExecContext,
  type SandboxExecPolicy,
} from "./sandbox-exec-policy.js";
import { NativeSandboxBackend } from "./native.js";
import type { SandboxBackend, SandboxCapabilities, SandboxPolicy, SandboxRunOptions, SandboxRunResult } from "./types.js";
import { createLogger } from "../logger.js";

const execAsync = promisify(exec);
const log = createLogger("sandbox-exec");

export class SandboxUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxUnavailableError";
  }
}

function shEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export class SandboxExecBackend implements SandboxBackend {
  private currentPolicy: SandboxExecPolicy = { allowNetwork: true };
  private ctx: SandboxExecContext | null = null;
  private useNativeFallback = false;
  private fallbackAlerted = false;

  constructor(private readonly nativeBackend: SandboxBackend = new NativeSandboxBackend()) {}

  capabilities(): SandboxCapabilities {
    return {
      id: "sandbox-exec",
      supportsNetworkPolicy: true,
      supportsFilesystemPolicy: true,
      platform: ["darwin"],
    };
  }

  async prepare(policy: SandboxPolicy): Promise<void> {
    const nextPolicy = policy as SandboxExecPolicy;
    const policyChanged = JSON.stringify(this.currentPolicy) !== JSON.stringify(nextPolicy);
    if (!policyChanged && this.ctx) {
      return;
    }

    this.currentPolicy = nextPolicy;

    const detect = await detectSandboxExec();
    if (!detect.available) {
      if ((nextPolicy.failureMode ?? "fail-hard") === "fallback-native") {
        this.useNativeFallback = true;
        if (!this.fallbackAlerted) {
          log.warn(`[event:sandbox:fallback] backend=sandbox-exec reason=${detect.reason ?? "unknown"}`);
          this.fallbackAlerted = true;
        }
        await this.nativeBackend.prepare(policy);
        return;
      }
      throw new SandboxUnavailableError(
        "sandbox-exec not available on this host; install Xcode Command Line Tools or set sandbox.failureMode='fallback-native'",
      );
    }

    this.useNativeFallback = false;

    const worktreePath = this.currentPolicy.allowedWritePaths?.[0] ?? process.cwd();
    const repoRootPath = process.cwd();

    let pnpmStorePath = path.join(os.homedir(), "Library/pnpm/store");
    try {
      const { stdout } = await execAsync("pnpm store path --silent", {
        cwd: worktreePath,
        timeout: 10_000,
        maxBuffer: 256 * 1024,
        encoding: "utf-8",
      });
      pnpmStorePath = stdout.trim() || pnpmStorePath;
    } catch {
      // fallback
    }

    this.ctx = {
      worktreePath,
      repoRootPath,
      pnpmStorePath,
      nodeBinPath: process.execPath,
      homeDir: os.homedir(),
      tmpDirOverride: os.tmpdir(),
    };

    log.log("[event:sandbox:prepare] backend=sandbox-exec");
  }

  async run(command: string, options: SandboxRunOptions): Promise<SandboxRunResult> {
    const startedAt = Date.now();

    if (this.useNativeFallback) {
      return this.nativeBackend.run(command, options);
    }

    if (!this.ctx) {
      this.ctx = {
        worktreePath: options.cwd,
        repoRootPath: options.cwd,
        pnpmStorePath: path.join(os.homedir(), "Library/pnpm/store"),
        nodeBinPath: process.execPath,
        homeDir: os.homedir(),
        tmpDirOverride: os.tmpdir(),
      };
    }

    const basePolicy = this.currentPolicy.allowedWritePaths || this.currentPolicy.allowedReadPaths
      ? this.currentPolicy
      : fusionWorktreePreset(this.ctx);
    const profile = policyToSbplProfile(basePolicy, this.ctx);

    const wrappedCommand = `sandbox-exec -p ${shEscape(profile)} /bin/sh -c ${shEscape(command)}`;
    log.log(`[event:sandbox:run] backend=sandbox-exec cmd=${JSON.stringify(command)}`);

    try {
      const execOptions: Parameters<typeof exec>[1] = {
        cwd: options.cwd,
        timeout: options.timeoutMs,
        maxBuffer: options.maxBuffer,
        env: options.env,
        signal: options.signal,
        ...(options.encoding !== undefined && { encoding: options.encoding }),
        ...(typeof options.shell === "string" && { shell: options.shell }),
      };
      const { stdout, stderr } = await execAsync(wrappedCommand, execOptions);

      const result: SandboxRunResult = {
        stdout: stdout?.toString?.() ?? "",
        stderr: stderr?.toString?.() ?? "",
        exitCode: 0,
        signal: null,
        timedOut: false,
        bufferExceeded: false,
      };
      log.log(`[event:sandbox:run] backend=sandbox-exec durationMs=${Date.now() - startedAt} exitCode=0`);
      return result;
    } catch (error) {
      const errObj = error as Record<string, unknown>;
      const code = errObj.code;
      const status = typeof errObj.status === "number" ? errObj.status : null;
      const exitCode = typeof code === "number" ? code : status;
      const message = String(errObj.message ?? "");

      log.warn(`[event:sandbox:failure] backend=sandbox-exec durationMs=${Date.now() - startedAt} exitCode=${String(exitCode)}`);
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
    this.ctx = null;
    this.useNativeFallback = false;
  }
}
