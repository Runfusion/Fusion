import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";

// ── Mock node:child_process ────────────────────────────────────────────────

const { mockSpawn } = vi.hoisted(() => ({ mockSpawn: vi.fn() }));

vi.mock("node:child_process", () => ({ spawn: mockSpawn }));

import { probeHermesBinary } from "../probe.js";

// ── Helpers ────────────────────────────────────────────────────────────────

/** Yields to the microtask and I/O queue so awaited code can continue. */
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
