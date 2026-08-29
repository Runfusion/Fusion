import { beforeEach, describe, expect, it, vi } from "vitest";

import * as containerArgv from "../container-argv.js";
import { ContainerSandboxBackend } from "../container.js";

const { mockExec, mockExecFile } = vi.hoisted(() => ({
  mockExec: vi.fn(),
  mockExecFile: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    exec: mockExec,
    execFile: mockExecFile,
    spawn: vi.fn(),
  };
});

describe("ContainerSandboxBackend", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExec.mockImplementation((_command: string, _options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
      callback(null, "podman version", "");
      return {} as never;
    });
  });

  it("returns success result when command succeeds", async () => {
    mockExecFile.mockImplementation(
      (_file: string, _args: string[], _options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
        callback(null, { stdout: "ok", stderr: "" } as unknown as string, "");
        return {} as never;
      },
    );
    const backend = new ContainerSandboxBackend({ runtime: "podman" });
    await backend.prepare({ allowNetwork: true });

    const result = await backend.run("echo ok", { cwd: "/tmp/work", timeoutMs: 1000, maxBuffer: 1024 });

    expect(result).toMatchObject({
      stdout: "ok",
      stderr: "",
      exitCode: 0,
      timedOut: false,
      bufferExceeded: false,
    });
  });

  it("maps non-zero exit without throwing", async () => {
    mockExecFile.mockImplementation(
      (_file: string, _args: string[], _options: unknown, callback: (error: Error) => void) => {
        callback({ code: 2, stdout: "", stderr: "bad" } as unknown as Error);
        return {} as never;
      },
    );
    const backend = new ContainerSandboxBackend({ runtime: "podman" });

    const result = await backend.run("false", { cwd: "/tmp/work", timeoutMs: 1000, maxBuffer: 1024 });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe("bad");
  });

  it("maps timeout errors", async () => {
    mockExecFile.mockImplementation(
      (_file: string, _args: string[], _options: unknown, callback: (error: Error) => void) => {
        callback({ killed: true, signal: "SIGTERM", message: "Command timed out" } as unknown as Error);
        return {} as never;
      },
    );
    const backend = new ContainerSandboxBackend({ runtime: "podman" });

    const result = await backend.run("sleep 10", { cwd: "/tmp/work", timeoutMs: 1000, maxBuffer: 1024 });

    expect(result.timedOut).toBe(true);
    expect(result.signal).toBe("SIGTERM");
  });

  it("maps maxBuffer errors", async () => {
    mockExecFile.mockImplementation(
      (_file: string, _args: string[], _options: unknown, callback: (error: Error) => void) => {
        callback({ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", message: "maxBuffer" } as unknown as Error);
        return {} as never;
      },
    );
    const backend = new ContainerSandboxBackend({ runtime: "podman" });

    const result = await backend.run("cat big", { cwd: "/tmp/work", timeoutMs: 1000, maxBuffer: 10 });

    expect(result.bufferExceeded).toBe(true);
  });

  it("returns structured spawnError when runtime probe fails", async () => {
    const runtimeError = Object.assign(new Error("not found"), { code: "ENOENT" });
    mockExec.mockImplementation((_command: string, _options: unknown, callback: (error: Error) => void) => {
      callback(runtimeError);
      return {} as never;
    });
    const argvSpy = vi.spyOn(containerArgv, "buildContainerArgv");

    const backend = new ContainerSandboxBackend({ runtime: "podman" });
    const result = await backend.run("echo ok", { cwd: "/tmp/work", timeoutMs: 1000, maxBuffer: 1024 });

    expect(result.exitCode).toBeNull();
    expect(result.spawnError).toBe(runtimeError);
    expect(mockExecFile).not.toHaveBeenCalled();
    expect(argvSpy).not.toHaveBeenCalled();
  });

  it("reports configured runtime through capabilities", () => {
    const backend = new ContainerSandboxBackend({ runtime: "docker" });
    expect(backend.capabilities().id).toBe("docker");
  });
});
