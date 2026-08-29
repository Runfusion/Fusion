import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

import { validateCliAuthAsync, validateCliPresenceAsync } from "../process-manager.js";

function makeProbeProc() {
  const proc = new EventEmitter() as any;
  proc.killed = false;
  proc.kill = vi.fn(() => {
    proc.killed = true;
  });
  return proc;
}

describe("Droid startup validation probes", () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("resolves unavailable when `droid --version` emits ENOENT", async () => {
    spawnMock.mockImplementationOnce(() => {
      const proc = makeProbeProc();
      queueMicrotask(() => proc.emit("error", Object.assign(new Error("not found"), { code: "ENOENT" })));
      return proc;
    });

    await expect(validateCliPresenceAsync()).resolves.toMatchObject({ ok: false });
    expect(spawnMock).toHaveBeenCalledWith("droid", ["--version"], expect.objectContaining({ stdio: "ignore" }));
    const options = spawnMock.mock.calls[0]?.[2] as { stdio: string };
    expect(options.stdio).not.toBe("inherit");
  });

  it("resolves ok when `droid --version` exits 0 without inheriting stdio", async () => {
    spawnMock.mockImplementationOnce(() => {
      const proc = makeProbeProc();
      queueMicrotask(() => proc.emit("exit", 0));
      return proc;
    });

    await expect(validateCliPresenceAsync()).resolves.toEqual({ ok: true });
    expect(spawnMock).toHaveBeenCalledWith("droid", ["--version"], expect.objectContaining({ stdio: "ignore" }));
  });

  it("SIGKILLs and resolves unavailable when `droid --version` hangs", async () => {
    vi.useFakeTimers();
    const proc = makeProbeProc();
    spawnMock.mockImplementationOnce(() => proc);

    const pending = validateCliPresenceAsync();
    await vi.advanceTimersByTimeAsync(45_001);

    await expect(pending).resolves.toMatchObject({ ok: false });
    expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("resolves false when `droid auth status` exits non-zero", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    spawnMock.mockImplementationOnce(() => {
      const proc = makeProbeProc();
      queueMicrotask(() => proc.emit("exit", 1));
      return proc;
    });

    await expect(validateCliAuthAsync()).resolves.toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("not authenticated"));
    expect(spawnMock).toHaveBeenCalledWith("droid", ["auth", "status"], expect.objectContaining({ stdio: "ignore" }));
  });

  it("resolves false instead of rejecting when auth spawn throws synchronously", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    spawnMock.mockImplementationOnce(() => {
      throw new Error("Real AI CLI launch blocked during tests: droid auth status");
    });

    await expect(validateCliAuthAsync()).resolves.toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("not authenticated"));
  });
});
