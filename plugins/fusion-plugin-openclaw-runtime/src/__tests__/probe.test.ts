/**
 * Tests for the probeOpenClawBinary helper.
 *
 * All tests mock `node:child_process.spawn` so no real subprocess is started.
 *
 * Execution order within probeOpenClawBinary:
 *   1. spawn(<which>, [binary])  — resolves the binary path (awaited first)
 *   2. spawn(binary, ["--version"]) — actual version probe
 *
 * Strategy: use a call-index counter inside the mock so each spawn call
 * returns a pre-built fake child. The `which` child is settled asynchronously
 * via `setImmediate` so the Promise chain advances before the tests drive the
 * version child.
 */

import { EventEmitter } from "node:events";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { probeOpenClawBinary } from "../probe.js";

// ---------------------------------------------------------------------------
// Child process mock
// ---------------------------------------------------------------------------

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
}

function makeFakeChild(): FakeChild {
  const c = new EventEmitter() as FakeChild;
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  c.kill = vi.fn();
  return c;
}

const spawnMock = vi.fn();

vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

// ---------------------------------------------------------------------------
// Helper: settle the `which` child, then yield until the version probe has
// been created, then return the version child for the test to drive.
// ---------------------------------------------------------------------------

/**
 * Set up the spawn mock to return pre-created fake children by call order.
 * The `which` child is auto-settled inside the mock so by the time the
 * probeOpenClawBinary Promise is waiting on the version spawn, it is already
 * registered in spawnMock.mock.calls.
 *
 * Returns the version-child for callers to drive.
 */
function setupSpawnPair(whichStdout: string, whichCode: number): FakeChild {
  const whichChild = makeFakeChild();
  const versionChild = makeFakeChild();
  let callIndex = 0;

  spawnMock.mockImplementation(() => {
    callIndex++;
    if (callIndex === 1) {
      // `which`/`where` call — auto-settle after current micro-task queue drains
      setImmediate(() => {
        if (whichStdout) {
          whichChild.stdout.emit("data", Buffer.from(whichStdout));
        }
        whichChild.emit("close", whichCode);
      });
      return whichChild;
    }
    return versionChild;
  });

  return versionChild;
}

/** Wait for the version probe spawn to be registered (call index 2). */
async function waitForVersionSpawn(): Promise<void> {
  // The `which` close fires via setImmediate; we need to give Node's event
  // loop at least one full round-trip so the Promise chain inside
  // tryResolveBinaryPath resolves and probeOpenClawBinary proceeds to
  // spawn the version check.
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("probeOpenClawBinary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns available=true when the binary exits 0 with version output", async () => {
    const versionChild = setupSpawnPair("/opt/homebrew/bin/openclaw\n", 0);

    const probePromise = probeOpenClawBinary({ binaryPath: "openclaw", timeoutMs: 2000 });

    await waitForVersionSpawn();

    versionChild.stdout.emit("data", Buffer.from("OpenClaw 2026.4.26 (be8c246)\n"));
    versionChild.emit("close", 0);

    const result = await probePromise;

    expect(result.available).toBe(true);
    expect(result.version).toBe("OpenClaw 2026.4.26 (be8c246)");
    expect(result.binaryPath).toBe("/opt/homebrew/bin/openclaw");
    expect(result.probeDurationMs).toBeGreaterThanOrEqual(0);
  });

  it("returns available=false with ENOENT reason when binary is not found", async () => {
    const versionChild = setupSpawnPair("", 1);

    const probePromise = probeOpenClawBinary({ binaryPath: "openclaw", timeoutMs: 2000 });

    await waitForVersionSpawn();

    const enoentError = Object.assign(new Error("spawn openclaw ENOENT"), { code: "ENOENT" });
    versionChild.emit("error", enoentError);

    const result = await probePromise;

    expect(result.available).toBe(false);
    expect(result.reason).toContain("not found on PATH");
    expect(result.probeDurationMs).toBeGreaterThanOrEqual(0);
  });

  it("returns available=false with the stderr reason when exit code is non-zero", async () => {
    const versionChild = setupSpawnPair("", 1);

    const probePromise = probeOpenClawBinary({ binaryPath: "openclaw", timeoutMs: 2000 });

    await waitForVersionSpawn();

    versionChild.stderr.emit("data", Buffer.from("command not recognized\n"));
    versionChild.emit("close", 1);

    const result = await probePromise;

    expect(result.available).toBe(false);
    expect(result.reason).toContain("command not recognized");
  });

  it("returns available=false with a timeout reason when the process hangs", async () => {
    // Very short timeout; the version child never emits close
    setupSpawnPair("", 1);

    const result = await probeOpenClawBinary({ binaryPath: "openclaw", timeoutMs: 30 });

    expect(result.available).toBe(false);
    expect(result.reason).toContain("timed out");
  });

  it("uses the custom binaryPath when spawning the version check", async () => {
    const versionChild = setupSpawnPair("", 1);

    const probePromise = probeOpenClawBinary({
      binaryPath: "/opt/homebrew/bin/openclaw",
      timeoutMs: 2000,
    });

    await waitForVersionSpawn();

    versionChild.stdout.emit("data", Buffer.from("OpenClaw 2026.4.26 (be8c246)\n"));
    versionChild.emit("close", 0);

    await probePromise;

    // Second spawn call must use the custom path
    const versionSpawnArgs = spawnMock.mock.calls[1] as [string, string[]];
    expect(versionSpawnArgs[0]).toBe("/opt/homebrew/bin/openclaw");
    expect(versionSpawnArgs[1]).toContain("--version");
  });
});
