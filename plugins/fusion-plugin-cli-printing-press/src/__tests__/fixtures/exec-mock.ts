import { execSync } from "node:child_process";
import { expect, vi } from "vitest";

type ExecResult = {
  stdout?: string;
  stderr?: string;
  code?: number;
  timeoutAfterMs?: number;
};

type ExecCall = {
  command: string;
  options: Record<string, unknown>;
};

const calls: ExecCall[] = [];
const queue: ExecResult[] = [];

vi.mock("node:child_process", () => {
  const execMock = vi.fn((command: string, options: Record<string, unknown>, callback: (err: Error | null, stdout: string, stderr: string) => void) => {
    calls.push({ command, options });
    const next = queue.shift() ?? { stdout: "", stderr: "", code: 0 };
    if (next.timeoutAfterMs) {
      const err = new Error(`Command timed out after ${next.timeoutAfterMs}ms`) as Error & { killed?: boolean; signal?: string };
      err.killed = true;
      err.signal = "SIGTERM";
      callback(err, next.stdout ?? "", next.stderr ?? "");
      return { kill: () => true };
    }
    if ((next.code ?? 0) !== 0) {
      const err = new Error(next.stderr || `Command failed with code ${next.code}`) as Error & {
        code?: number;
        stdout?: string;
        stderr?: string;
      };
      err.code = next.code;
      err.stdout = next.stdout ?? "";
      err.stderr = next.stderr ?? "";
      callback(err, next.stdout ?? "", next.stderr ?? "");
      return { kill: () => true };
    }
    callback(null, next.stdout ?? "", next.stderr ?? "");
    return { kill: () => true };
  });

  execMock[Symbol.for("nodejs.util.promisify.custom")] = (command: string, options: Record<string, unknown>) =>
    new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      execMock(command, options, (error: Error | null, stdout: string, stderr: string) => {
        if (error) {
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      });
    });

  return {
    exec: execMock,
    execSync: vi.fn(() => {
      throw new Error("execSync should never be called");
    }),
  };
});

export function installExecMock() {
  calls.length = 0;
  queue.length = 0;

  return {
    setNextResult(result: ExecResult) {
      queue.push(result);
    },
    getCalls() {
      return [...calls];
    },
    assertExecSyncUnused() {
      expect(execSync).not.toHaveBeenCalled();
    },
  };
}
