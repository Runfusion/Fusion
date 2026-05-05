import { describe, expect, it, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

import { probeDroidBinary, resolveDroidBinaryPath } from "../probe.js";

describe("probeDroidBinary", () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  it("returns unavailable when binary is missing", async () => {
    spawnMock.mockImplementationOnce(() => {
      const proc = new EventEmitter() as any;
      proc.stdout = new PassThrough();
      proc.stderr = new PassThrough();
      queueMicrotask(() => proc.emit("error", Object.assign(new Error("not found"), { code: "ENOENT" })));
      return proc;
    });

    const result = await probeDroidBinary({ timeoutMs: 10 });
    expect(result.available).toBe(false);
    expect(result.reason).toContain("Binary not found or not executable");
  });

  it("returns available and version on success", async () => {
    spawnMock.mockImplementationOnce(() => {
      const proc = new EventEmitter() as any;
      proc.stdout = new PassThrough();
      proc.stderr = new PassThrough();
      queueMicrotask(() => {
        proc.stdout.write("droid 1.2.3\n");
        proc.emit("close", 0);
      });
      return proc;
    });

    const result = await probeDroidBinary();
    expect(result.available).toBe(true);
    expect(result.version).toBe("droid 1.2.3");
  });

  it("uses binary path from plugin settings", async () => {
    spawnMock.mockImplementationOnce(() => {
      const proc = new EventEmitter() as any;
      proc.stdout = new PassThrough();
      proc.stderr = new PassThrough();
      queueMicrotask(() => proc.emit("close", 1));
      return proc;
    });

    await probeDroidBinary({ settings: { droidBinaryPath: " /custom/from-settings " } });
    expect(spawnMock).toHaveBeenCalledWith("/custom/from-settings", ["--version"], expect.anything());
  });

  it("uses custom binary path", async () => {
    spawnMock.mockImplementationOnce(() => {
      const proc = new EventEmitter() as any;
      proc.stdout = new PassThrough();
      proc.stderr = new PassThrough();
      queueMicrotask(() => proc.emit("close", 1));
      return proc;
    });

    await probeDroidBinary({ binaryPath: "/custom/droid" });
    expect(spawnMock).toHaveBeenCalledWith("/custom/droid", ["--version"], expect.anything());
  });

  it("falls back to droid when plugin setting is missing or blank", () => {
    expect(resolveDroidBinaryPath()).toBe("droid");
    expect(resolveDroidBinaryPath({})).toBe("droid");
    expect(resolveDroidBinaryPath({ droidBinaryPath: "   " })).toBe("droid");
  });
});
