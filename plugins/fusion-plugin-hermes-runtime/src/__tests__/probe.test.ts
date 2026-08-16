import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";

// ── Mock node:child_process ────────────────────────────────────────────────

const { mockSpawn } = vi.hoisted(() => ({ mockSpawn: vi.fn() }));

vi.mock("node:child_process", () => ({ spawn: mockSpawn }));

import { probeHermesBinary } from "../probe.js";
import { __resetHermesLaunchCacheForTests } from "../windows-binary-launch.js";

// ── Helpers ────────────────────────────────────────────────────────────────

/** Yields to the microtask and I/O queue so awaited code can continue. */
function setPlatform(platform: NodeJS.Platform): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  return () => Object.defineProperty(process, "platform", descriptor!);
}

function flushAsync(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function makeFakeChild(): {
  child: ChildProcess;
  emitStdout: (data: string) => void;
  emitStderr: (data: string) => void;
  emitError: (err: NodeJS.ErrnoException) => void;
  emitClose: (code: number | null) => void;
} {
  const main = new EventEmitter() as ChildProcess;
  const stdoutEmitter = new EventEmitter();
  const stderrEmitter = new EventEmitter();
  (main as any).stdout = stdoutEmitter;
  (main as any).stderr = stderrEmitter;
  (main as any).kill = vi.fn();

  return {
    child: main,
    emitStdout: (data) => stdoutEmitter.emit("data", Buffer.from(data)),
    emitStderr: (data) => stderrEmitter.emit("data", Buffer.from(data)),
    emitError: (err) => main.emit("error", err),
    emitClose: (code) => main.emit("close", code),
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("probeHermesBinary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetHermesLaunchCacheForTests();
  });

  it("launches a Windows .cmd probe through cmd.exe and reports the Hermes shim", async () => {
    const restorePlatform = setPlatform("win32");
    try {
      const whereChild = makeFakeChild();
      const versionChild = makeFakeChild();
      mockSpawn.mockReturnValueOnce(whereChild.child).mockReturnValueOnce(versionChild.child);
      const promise = probeHermesBinary({ timeoutMs: 500 });
      await flushAsync();
      whereChild.emitStdout("C:\\shims\\hermes.cmd\r\n");
      whereChild.emitClose(0);
      await flushAsync();

      const [command, args, options] = mockSpawn.mock.calls[1]!;
      expect(command).toBe("cmd.exe");
      expect(args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
      expect(args[3]).toContain("C:\\shims\\hermes.cmd");
      expect(options.windowsVerbatimArguments).toBe(true);
      versionChild.emitStdout("Hermes Agent v1.2.3\n");
      versionChild.emitClose(0);

      await expect(promise).resolves.toMatchObject({
        available: true,
        binaryPath: "C:\\shims\\hermes.cmd",
      });
    } finally {
      restorePlatform();
    }
  });

  it("launches a Windows .exe probe directly and reports that executable", async () => {
    const restorePlatform = setPlatform("win32");
    try {
      const whereChild = makeFakeChild();
      const versionChild = makeFakeChild();
      mockSpawn.mockReturnValueOnce(whereChild.child).mockReturnValueOnce(versionChild.child);
      const promise = probeHermesBinary({ timeoutMs: 500 });
      await flushAsync();
      whereChild.emitStdout("C:\\shims\\hermes.exe\n");
      whereChild.emitClose(0);
      await flushAsync();
      expect(mockSpawn.mock.calls[1]![0]).toBe("C:\\shims\\hermes.exe");
      expect(mockSpawn.mock.calls[1]![1]).toEqual(["--version"]);
      versionChild.emitClose(0);
      await expect(promise).resolves.toMatchObject({ binaryPath: "C:\\shims\\hermes.exe" });
    } finally {
      restorePlatform();
    }
  });

  it("returns available: false with not-found reason on ENOENT", async () => {
    // probeHermesBinary first awaits tryResolveBinaryPath (which/where spawn),
    // then spawns the --version process. We must drive them sequentially.
    const whichChild = makeFakeChild();
    const versionChild = makeFakeChild();

    mockSpawn
      .mockReturnValueOnce(whichChild.child) // which hermes
      .mockReturnValueOnce(versionChild.child); // hermes --version

    const promise = probeHermesBinary({ timeoutMs: 500 });
    await flushAsync();

    // Settle the `which` call — which causes tryResolveBinaryPath to resolve.
    whichChild.emitClose(1);

    // Yield so the awaited tryResolveBinaryPath continuation runs and spawns
    // the version child before we emit its error.
    await flushAsync();

    const enoent = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    versionChild.emitError(enoent);

    const result = await promise;

    expect(result.available).toBe(false);
    expect(result.reason).toMatch(/not found on PATH/);
    expect(result.probeDurationMs).toBeGreaterThanOrEqual(0);
  });

  it("returns available: true with parsed version on success", async () => {
    const whichChild = makeFakeChild();
    const versionChild = makeFakeChild();

    mockSpawn
      .mockReturnValueOnce(whichChild.child)
      .mockReturnValueOnce(versionChild.child);

    const promise = probeHermesBinary({ binaryPath: "hermes", timeoutMs: 500 });
    await flushAsync();

    whichChild.emitStdout("/usr/local/bin/hermes\n");
    whichChild.emitClose(0);

    await flushAsync();

    versionChild.emitStdout("Hermes Agent v1.2.3\n");
    versionChild.emitClose(0);

    const result = await promise;

    expect(result.available).toBe(true);
    expect(result.version).toBe("Hermes Agent v1.2.3");
    expect(result.binaryPath).toBe("/usr/local/bin/hermes");
    expect(result.reason).toBeUndefined();
    expect(result.probeDurationMs).toBeGreaterThanOrEqual(0);
  });

  it("returns available: false when version exits non-zero", async () => {
    const whichChild = makeFakeChild();
    const versionChild = makeFakeChild();

    mockSpawn
      .mockReturnValueOnce(whichChild.child)
      .mockReturnValueOnce(versionChild.child);

    const promise = probeHermesBinary({ timeoutMs: 500 });
    await flushAsync();

    whichChild.emitClose(1);

    await flushAsync();

    versionChild.emitStderr("error: something went wrong");
    versionChild.emitClose(2);

    const result = await promise;

    expect(result.available).toBe(false);
    expect(result.reason).toContain("error: something went wrong");
  });

  it("uses custom binaryPath when provided", async () => {
    const whichChild = makeFakeChild();
    const versionChild = makeFakeChild();

    mockSpawn
      .mockReturnValueOnce(whichChild.child)
      .mockReturnValueOnce(versionChild.child);

    const promise = probeHermesBinary({ binaryPath: "/opt/bin/hermes", timeoutMs: 500 });
    await flushAsync();

    whichChild.emitClose(1);

    await flushAsync();

    versionChild.emitStdout("Hermes Agent v2.0.0\n");
    versionChild.emitClose(0);

    const result = await promise;

    expect(result.available).toBe(true);
    expect(result.version).toBe("Hermes Agent v2.0.0");

    // Verify the version spawn used our custom path.
    const versionSpawnArgs = mockSpawn.mock.calls[1]!;
    expect(versionSpawnArgs[0]).toBe("/opt/bin/hermes");
    expect(versionSpawnArgs[1]).toEqual(["--version"]);
  });
});
