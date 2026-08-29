import { rm, stat } from "node:fs/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runBenchmark } from "../experiment/benchmark-runner.js";

describe("runBenchmark", () => {
  const tempFiles: string[] = [];

  afterEach(async () => {
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
      command: `${process.execPath} -e \"console.log('METRIC accuracy=0.91')\"`,
      cwd: process.cwd(),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("METRIC accuracy=0.91");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.timedOut).toBe(false);
  });

  it("times out long-running process", async () => {
    const result = await runBenchmark({
      command: `${process.execPath} -e \"setTimeout(() => console.log('done'), 2000)\"`,
      cwd: process.cwd(),
      timeoutMs: 100,
    });

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
  });

  it("truncates oversized stdout and writes full output to temp file", async () => {
    const result = await runBenchmark({
      command: `${process.execPath} -e \"process.stdout.write('x'.repeat(2048))\"`,
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
    const controller = new AbortController();
    const runPromise = runBenchmark({
      command: `${process.execPath} -e \"setInterval(() => process.stdout.write('tick\\n'), 50)\"`,
      cwd: process.cwd(),
      abortSignal: controller.signal,
    });

    setTimeout(() => controller.abort(), 120);

    const result = await runPromise;
    expect(result.exitCode).not.toBe(0);
    expect(result.timedOut).toBe(false);
  });

  it("throttles progress callbacks and stops after completion", async () => {
    vi.useFakeTimers();
    const onProgress = vi.fn();

    const promise = runBenchmark({
      command: `${process.execPath} -e \"let i=0; const t=setInterval(()=>{console.log(i++); if(i===5){clearInterval(t); process.exit(0);} }, 50)\"`,
      cwd: process.cwd(),
      onProgress,
    });

    await vi.advanceTimersByTimeAsync(1500);
    const result = await promise;
    const callsAtFinish = onProgress.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1000);

    expect(result.exitCode).toBe(0);
    expect(callsAtFinish).toBeGreaterThan(0);
    expect(onProgress.mock.calls.length).toBe(callsAtFinish);
    for (const call of onProgress.mock.calls) {
      expect(call[0].elapsedMs).toBeGreaterThanOrEqual(0);
    }

    vi.useRealTimers();
  });
});
