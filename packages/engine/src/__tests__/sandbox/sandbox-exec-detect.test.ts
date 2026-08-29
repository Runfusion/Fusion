import { promisify } from "node:util";
import { beforeEach, describe, expect, it, vi } from "vitest";

const execMock = vi.fn();

vi.mock("node:child_process", () => ({
  exec: execMock,
  execFile: vi.fn(),
}));

const originalPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform });
}

describe("detectSandboxExec", () => {
  beforeEach(async () => {
    execMock.mockReset();
    (execMock as unknown as Record<symbol, unknown>)[promisify.custom] = vi.fn();
    vi.resetModules();
    setPlatform(originalPlatform);
  });

  it("detects sandbox-exec on darwin", async () => {
    setPlatform("darwin");
    ((execMock as unknown as Record<symbol, unknown>)[promisify.custom] as ReturnType<typeof vi.fn>).mockResolvedValue({
      stdout: "/usr/bin/sandbox-exec\n",
      stderr: "",
    });

    const { detectSandboxExec } = await import("../../sandbox/sandbox-exec-detect.js");
    const result = await detectSandboxExec();

    expect(result).toEqual({ available: true, path: "/usr/bin/sandbox-exec" });
    expect(((execMock as unknown as Record<symbol, unknown>)[promisify.custom] as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
  });

  it("returns unavailable when sandbox-exec check throws", async () => {
    setPlatform("darwin");
    ((execMock as unknown as Record<symbol, unknown>)[promisify.custom] as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("ENOENT"));

    const { detectSandboxExec } = await import("../../sandbox/sandbox-exec-detect.js");
    const result = await detectSandboxExec();

    expect(result).toEqual({ available: false, reason: "not-installed" });
  });

  it("short-circuits on non-darwin", async () => {
    setPlatform("linux");

    const { detectSandboxExec } = await import("../../sandbox/sandbox-exec-detect.js");
    const result = await detectSandboxExec();

    expect(result).toEqual({ available: false, reason: "not-darwin" });
    expect(((execMock as unknown as Record<symbol, unknown>)[promisify.custom] as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it("uses cache until reset", async () => {
    setPlatform("darwin");
    const execAsyncMock = (execMock as unknown as Record<symbol, unknown>)[promisify.custom] as ReturnType<typeof vi.fn>;
    execAsyncMock.mockResolvedValue({
      stdout: "/usr/bin/sandbox-exec\n",
      stderr: "",
    });

    const { detectSandboxExec, resetSandboxExecDetectCache } = await import("../../sandbox/sandbox-exec-detect.js");
    const first = await detectSandboxExec();
    const second = await detectSandboxExec();

    expect(first).toEqual(second);
    expect(execAsyncMock).toHaveBeenCalledTimes(1);

    resetSandboxExecDetectCache();
    execAsyncMock.mockResolvedValue({ stdout: "/opt/homebrew/bin/sandbox-exec\n", stderr: "" });

    const third = await detectSandboxExec();
    expect(third.path).toBe("/opt/homebrew/bin/sandbox-exec");
    expect(execAsyncMock).toHaveBeenCalledTimes(2);
  });
});
