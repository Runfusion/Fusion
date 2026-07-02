import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

import { spawn } from "node:child_process";
import { runCursorCommand } from "../cli-spawn.js";

function mockPlatform(platform: NodeJS.Platform) {
  return vi.spyOn(process, "platform", "get").mockReturnValue(platform);
}

function createMockChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn();
  vi.mocked(spawn).mockReturnValue(child as never);
  return child;
}

describe("runCursorCommand", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("uses the Windows shell so PATH .cmd and .bat Cursor shims can run", async () => {
    mockPlatform("win32");
    const child = createMockChild();

    const resultPromise = runCursorCommand("cursor-agent", ["--version"], 1000);

    expect(spawn).toHaveBeenCalledWith("cursor-agent", ["--version"], {
      stdio: ["ignore", "pipe", "pipe"],
      shell: true,
    });

    child.stdout.write("cursor-agent 1.2.3\n");
    child.stderr.write("diagnostic\n");
    child.emit("close", 0);

    await expect(resultPromise).resolves.toEqual({
      code: 0,
      stdout: "cursor-agent 1.2.3\n",
      stderr: "diagnostic\n",
    });
  });

  it("keeps non-Windows Cursor invocations on direct spawn", async () => {
    mockPlatform("darwin");
    const child = createMockChild();

    const resultPromise = runCursorCommand("cursor-agent", ["--version"], 1000);

    expect(spawn).toHaveBeenCalledWith("cursor-agent", ["--version"], {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });

    child.emit("close", 0);
    await expect(resultPromise).resolves.toMatchObject({ code: 0 });
  });

  it("returns spawn errors with diagnostics instead of empty stderr", async () => {
    mockPlatform("win32");
    const child = createMockChild();

    const resultPromise = runCursorCommand("cursor-agent", ["--version"], 1000);
    child.emit("error", Object.assign(new Error("spawn cursor-agent ENOENT"), { code: "ENOENT" }));

    const result = await resultPromise;
    expect(result.code).toBe(127);
    expect(result.stderr).toContain("spawn error: ENOENT: spawn cursor-agent ENOENT");
  });

  it("kills timed-out Cursor commands best-effort and resolves once", async () => {
    vi.useFakeTimers();
    mockPlatform("linux");
    const child = createMockChild();

    const resultPromise = runCursorCommand("cursor-agent", ["models", "--json"], 25);
    child.stdout.write("partial");

    await vi.advanceTimersByTimeAsync(25);

    await expect(resultPromise).resolves.toEqual({ code: 124, stdout: "partial", stderr: "" });
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");

    child.emit("close", 0);
    await expect(resultPromise).resolves.toMatchObject({ code: 124 });
  });
});
