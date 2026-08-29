import { superviseSpawn } from "@fusion/core";

export interface ComputerExecOptions {
  /** Every OS command is bounded; callers select a named COMPUTER_TIMEOUTS value. */
  timeoutMs: number;
  stdin?: string;
}

export interface ComputerExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

export interface ComputerExecSeam {
  run(file: string, args: readonly string[], options: ComputerExecOptions): Promise<ComputerExecResult>;
}

/**
 * FNXC:ComputerUse 2026-08-11-03:34:
 * OS automation is asynchronous, shell-free, and bounded by the fixed C10.2 timeout defaults.
 * The seam keeps tests off the host desktop while preventing synchronous exec, shell interpolation,
 * or a child that can wait forever; stdin is written once and then closed.
 */
export const defaultComputerExecSeam: ComputerExecSeam = {
  async run(file, args, options) {
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
      throw new Error("Computer exec timeoutMs must be a positive finite number");
    }

    const supervised = superviseSpawn(file, args, {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      maxLifetimeMs: options.timeoutMs,
    });
    const { child } = supervised;
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr?.on("data", (chunk: string) => { stderr += chunk; });

    if (options.stdin !== undefined) child.stdin?.write(options.stdin);
    child.stdin?.end();

    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      supervised.kill("SIGTERM");
    }, options.timeoutMs);
    timeout.unref();
    try {
      const exited = await supervised.waitExit();
      return { stdout, stderr, exitCode: exited.code, timedOut };
    } finally {
      clearTimeout(timeout);
    }
  },
};
