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

describe("detectBwrap", () => {
  beforeEach(async () => {
    execMock.mockReset();
    (execMock as unknown as Record<symbol, unknown>)[promisify.custom] = vi.fn();
    vi.resetModules();
    setPlatform(originalPlatform);
  });

  it("detects bubblewrap on linux and parses version/path", async () => {
    setPlatform("linux");
    ((execMock as unknown as Record<symbol, unknown>)[promisify.custom] as ReturnType<typeof vi.fn>).mockResolvedValue({
      stdout: "/usr/bin/bwrap\nbubblewrap 0.9.0\n",
      stderr: "",
    });

    const { detectBwrap } = await import("../../sandbox/bubblewrap-detect.js");
    const result = await detectBwrap();

    expect(result).toEqual({ available: true, path: "/usr/bin/bwrap", version: "0.9.0" });
    expect(((execMock as unknown as Record<symbol, unknown>)[promisify.custom] as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
  });

  it("returns unavailable when bwrap is missing", async () => {
    setPlatform("linux");
    ((execMock as unknown as Record<symbol, unknown>)[promisify.custom] as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("command not found"));

    const { detectBwrap } = await import("../../sandbox/bubblewrap-detect.js");
    const result = await detectBwrap();

    expect(result.available).toBe(false);
    expect(result.reason).toBe("not-installed");
  });

  it("short-circuits on non-linux platforms", async () => {
    setPlatform("darwin");

    const { detectBwrap } = await import("../../sandbox/bubblewrap-detect.js");
    const result = await detectBwrap();

    expect(result).toEqual({ available: false, reason: "not-linux" });
    expect(((execMock as unknown as Record<symbol, unknown>)[promisify.custom] as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it("uses cached result until reset", async () => {
    setPlatform("linux");
    ((execMock as unknown as Record<symbol, unknown>)[promisify.custom] as ReturnType<typeof vi.fn>).mockResolvedValue({
      stdout: "/usr/bin/bwrap\nbwrap 1.0.0\n",
      stderr: "",
    });

    const { detectBwrap, resetBwrapDetectCache } = await import("../../sandbox/bubblewrap-detect.js");
    const first = await detectBwrap();
    const second = await detectBwrap();

    expect(first).toEqual(second);
    expect(((execMock as unknown as Record<symbol, unknown>)[promisify.custom] as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);

    resetBwrapDetectCache();
    ((execMock as unknown as Record<symbol, unknown>)[promisify.custom] as ReturnType<typeof vi.fn>).mockResolvedValue({
      stdout: "/opt/bin/bwrap\nbwrap 2.0.0\n",
      stderr: "",
    });

    const third = await detectBwrap();
    expect(third.path).toBe("/opt/bin/bwrap");
    expect(((execMock as unknown as Record<symbol, unknown>)[promisify.custom] as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(2);
  });
});
