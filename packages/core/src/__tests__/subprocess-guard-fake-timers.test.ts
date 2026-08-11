import { exec, execFile, fork, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { __fusionSubprocessGuardTestHooks as guard } from "../__test-utils__/vitest-setup";

const temporaryPaths: string[] = [];

function waitForClose(proc: ChildProcess): Promise<void> {
  return once(proc, "close").then(() => undefined);
}

function waitForRealTime(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function startShortChild(): ChildProcess {
  return spawn(process.execPath, ["-e", "0"]);
}

function startHangingChild(): ChildProcess {
  return spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
}

afterEach(() => {
  vi.useRealTimers();
  guard.setSubprocessTimeoutMsForTests(null);
  expect(guard.peekForeignSubprocessFailureCount()).toBe(0);
  expect(guard.takeOwnedSubprocessFailures()).toEqual([]);
  for (const path of temporaryPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("subprocess guard watchdog timers", () => {
  it.each([
    ["spawn", () => spawn(process.execPath, ["-e", "0"])],
    ["exec", () => exec(`${JSON.stringify(process.execPath)} -e "0"`)],
    ["execFile", () => execFile(process.execPath, ["-e", "0"])],
    ["fork", () => {
      const directory = mkdtempSync(join(tmpdir(), "fn-subprocess-guard-"));
      temporaryPaths.push(directory);
      const modulePath = join(directory, "child.cjs");
      writeFileSync(modulePath, "process.exit(0);\n");
      return fork(modulePath);
    }],
  ])("S1 ignores virtual elapsed time for %s", async (_name, start) => {
    vi.useFakeTimers();
    const before = vi.getTimerCount();
    const proc = start();
    const after = vi.getTimerCount();

    await vi.advanceTimersByTimeAsync(guard.getSubprocessTimeoutMs() * 2);
    vi.useRealTimers();
    await waitForClose(proc);

    expect(guard.takeOwnedSubprocessFailures()).toEqual([]);
    expect(after).toBe(before);
  });

  it("S2 ignores virtual elapsed time installed after spawn", async () => {
    const proc = startShortChild();
    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(guard.getSubprocessTimeoutMs() * 2);
    vi.useRealTimers();
    await waitForClose(proc);

    expect(guard.takeOwnedSubprocessFailures()).toEqual([]);
    expect(guard.getTrackedSubprocessCount()).toBe(0);
  });

  it("S3 retains the real-timer baseline", async () => {
    const proc = startShortChild();
    await waitForClose(proc);

    expect(guard.takeOwnedSubprocessFailures()).toEqual([]);
    expect(guard.getTrackedSubprocessCount()).toBe(0);
    expect(guard.getSubprocessTimeoutMs()).toSatisfy((ms: number) => Number.isFinite(ms) && ms >= 1_000);
  });

  it("S4 reports and kills a genuinely hung child", async () => {
    guard.setSubprocessTimeoutMsForTests(150);
    const proc = startHangingChild();
    await waitForClose(proc);

    expect(guard.takeOwnedSubprocessFailures()).toEqual([expect.stringMatching(/Timed out after 150ms/)]);
    expect(proc.signalCode).toBe("SIGKILL");
    expect(guard.getTrackedSubprocessCount()).toBe(0);
  });

  it("S5 cleanup cancels its real watchdog", async () => {
    guard.setSubprocessTimeoutMsForTests(150);
    const proc = startShortChild();
    await waitForClose(proc);
    await waitForRealTime(450);

    expect(guard.takeOwnedSubprocessFailures()).toEqual([]);
    expect(guard.getTrackedSubprocessCount()).toBe(0);
  });

  it("S6 duplicate registration does not orphan a watchdog", async () => {
    guard.setSubprocessTimeoutMsForTests(150);
    const proc = startShortChild();
    guard.registerTrackedSubprocessForTests(proc, "duplicate-registration-probe");
    await waitForClose(proc);
    await waitForRealTime(450);

    // The map is keyed by proc, so only absence of a fabricated failure proves cleanup.
    expect(guard.takeOwnedSubprocessFailures()).toEqual([]);
    expect(guard.getTrackedSubprocessCount()).toBe(0);
  });

  it("S7 leaves a foreign-only failure queued", () => {
    expect(guard.takeOwnedSubprocessFailures()).toEqual([]);
    expect(guard.peekForeignSubprocessFailureCount()).toBe(0);

    const message = "Timed out after 1ms: synthetic-foreign";
    guard.recordSubprocessFailureForTests("FN-8937 synthetic sibling test", message);
    expect(guard.takeOwnedSubprocessFailures()).toEqual([]);
    expect(guard.peekForeignSubprocessFailureCount()).toBe(1);
    expect(guard.removeStagedFailureForTests(message)).toBe(true);
    expect(guard.peekForeignSubprocessFailureCount()).toBe(0);
  });

  it("S8 drains owned failures while preserving foreign order", async () => {
    guard.setSubprocessTimeoutMsForTests(150);
    guard.recordSubprocessFailureForTests("FN-8937 synthetic sibling A", "synthetic-F1");
    const proc = startHangingChild();
    await waitForClose(proc);
    expect(guard.peekForeignSubprocessFailureCount()).toBe(1);
    guard.recordSubprocessFailureForTests("FN-8937 synthetic sibling B", "synthetic-F2");

    expect(guard.takeOwnedSubprocessFailures()).toEqual([expect.stringMatching(/Timed out after 150ms/)]);
    expect(guard.peekForeignSubprocessFailureCount()).toBe(2);
    expect(guard.listForeignSubprocessFailureMessages()).toEqual(["synthetic-F1", "synthetic-F2"]);
    expect(guard.removeStagedFailureForTests("synthetic-F1")).toBe(true);
    expect(guard.removeStagedFailureForTests("synthetic-F2")).toBe(true);
    expect(guard.peekForeignSubprocessFailureCount()).toBe(0);
  });
});
