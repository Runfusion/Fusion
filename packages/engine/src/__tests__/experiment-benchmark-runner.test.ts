import { rm, stat } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn, type ChildProcess } from "node:child_process";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runBenchmark } from "../experiment/benchmark-runner.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

/*
FNXC:BenchmarkTestVelocity 2026-10-15-00:08:
Timeout, abort, and progress contracts must advance on a controlled clock rather
than waiting for shell startup and child-process intervals. Keep real subprocess
coverage for successful commands and output-file truncation; fake only the child
event boundary for timing assertions, including exact throttle and cleanup checks.
*/
function fakeChild() {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  });
  vi.mocked(spawn).mockReturnValueOnce(child as unknown as ChildProcess);
  return child;
}

describe("runBenchmark", () => {
  const tempFiles: string[] = [];

  afterEach(async () => {
    vi.useRealTimers();
    vi.clearAllMocks();
    await Promise.all(
      tempFiles.map(async (file) => {
        try {
          await rm(file, { force: true, recursive: true });
        } catch {
          // ignore cleanup failures
        }
      }),
    );
    tempFiles.length = 0;
  });

  it("runs command successfully", async () => {
    const result = await runBenchmark({
      command: `${process.execPath} -e "console.log('METRIC accuracy=0.91')"`,
      cwd: process.cwd(),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("METRIC accuracy=0.91");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.timedOut).toBe(false);
  });

  it("times out long-running process", async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const promise = runBenchmark({
      command: "controlled-benchmark",
      cwd: process.cwd(),
      timeoutMs: 100,
    });

    await vi.advanceTimersByTimeAsync(99);
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    child.emit("close", null, "SIGTERM");
    const result = await promise;
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
    await vi.advanceTimersByTimeAsync(2000);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("truncates oversized stdout and writes full output to temp file", async () => {
    const result = await runBenchmark({
      command: `${process.execPath} -e "process.stdout.write('x'.repeat(2048))"`,
      cwd: process.cwd(),
      maxBufferBytes: 256,
      sessionId: "EXP-1",
    });

    expect(result.truncated).toBe(true);
    expect(result.truncatedTempFile).toBeTruthy();
    if (result.truncatedTempFile) {
      tempFiles.push(result.truncatedTempFile);
      const stats = await stat(result.truncatedTempFile);
      expect(stats.size).toBeGreaterThan(256);
    }
    expect(result.stdout.length).toBeLessThanOrEqual(64 * 1024);
  });

  it("supports abort signal", async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const controller = new AbortController();
    const runPromise = runBenchmark({
      command: "controlled-benchmark",
      cwd: process.cwd(),
      abortSignal: controller.signal,
    });
    expect(spawn).toHaveBeenCalledWith("controlled-benchmark", expect.objectContaining({
      signal: controller.signal,
    }));
    controller.signal.addEventListener("abort", () => {
      child.emit("error", Object.assign(new Error("aborted"), { name: "AbortError" }));
    }, { once: true });
    controller.abort();

    const result = await runPromise;
    expect(result.exitCode).not.toBe(0);
    expect(result.timedOut).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("throttles progress callbacks and stops after completion", async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const onProgress = vi.fn();

    const promise = runBenchmark({
      command: "controlled-benchmark",
      cwd: process.cwd(),
      onProgress,
    });
    child.stdout.emit("data", "first");
    child.stdout.emit("data", " second");
    child.stderr.emit("data", "warning");
    await vi.advanceTimersByTimeAsync(499);
    expect(onProgress).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onProgress).toHaveBeenNthCalledWith(1, {
      stdoutChunk: "first second", stderrChunk: "warning", elapsedMs: 500,
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(onProgress).toHaveBeenCalledTimes(1);
    child.stdout.emit("data", "final");
    child.emit("close", 0, null);
    const result = await promise;
    expect(onProgress).toHaveBeenNthCalledWith(2, {
      stdoutChunk: "final", stderrChunk: undefined, elapsedMs: 1000,
    });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(1000);

    expect(result.exitCode).toBe(0);
    expect(onProgress).toHaveBeenCalledTimes(2);
  });
});
