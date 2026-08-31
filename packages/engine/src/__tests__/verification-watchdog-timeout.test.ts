import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRunVerificationTool, runVerificationCommand, type RunVerificationPersistence } from "../execution/run-verification-tool.js";
import { getVerificationSemaphore, resetVerificationLimitRegistryForTests, setMaxConcurrentVerifications } from "../concurrency/verification-concurrency.js";

/*
FNXC:VerificationWriteAhead 2026-08-31-00:00 (EXAM-010):
Pre-fix behavior being pinned here: the slot-queue wait had NO timeout and no signal,
and the subprocess promise was resolve-only. A call whose child never emitted `close`
never settled while the 60s synthetic-heartbeat loop refreshed stuck-detector activity,
wedging the executor run for 51+ minutes (EXAM-002, 2026-08-31).

The watchdog bounds queue wait + subprocess END TO END. These tests assert:
  1. a never-settling command + short ceiling -> explicit timedOut failure within the ceiling
     and a terminal `failed` persisted record naming the watchdog
  2. a saturated semaphore (limit 1, first call never settles) + short ceiling -> the
     QUEUED call fails explicitly instead of hanging forever
  3. mid-run abort (external signal) settles the promise and kills the child
  4. success path still returns normal results with the watchdog armed
  5. onVerificationEnd fires exactly once per invocation across rapid sequential calls
*/

const itPosix = process.platform !== "win32" ? it : it.skip;

function makeTmpRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(root, "node_modules"), { recursive: true });
  writeFileSync(join(root, "node_modules", ".modules.yaml"), "layoutVersion: 5\n");
  return root;
}

function makePersistence() {
  const finishes: Array<{ requestId: string; status: string; reason?: string; result?: { timedOut: boolean } }> = [];
  const upserts: string[] = [];
  const persistence: RunVerificationPersistence = {
    upsert: async (input) => {
      upserts.push(input.requestId);
      return { claimed: true, request: { requestId: input.requestId, status: "running", startedAt: new Date().toISOString() } };
    },
    finish: async (_taskId, requestId, status, result, rejectionReason) => {
      finishes.push({ requestId, status, reason: rejectionReason, result });
      return null;
    },
    reclaimStale: async () => null,
  };
  return { persistence, finishes, upserts };
}

describe("fn_run_verification end-to-end watchdog (EXAM-010)", () => {
  beforeEach(() => {
    resetVerificationLimitRegistryForTests();
    setMaxConcurrentVerifications(1);
    getVerificationSemaphore().reconcileActiveCount(0);
    vi.useFakeTimers();
  });
  afterEach(() => {
    // Drain the semaphore so leaked waiters from a failed test cannot poison peers.
    getVerificationSemaphore().reconcileActiveCount(0);
    vi.useRealTimers();
  });

  itPosix("fails explicitly within the ceiling when the command never settles", async () => {
    const root = makeTmpRoot("fusion-verify-wd-hang-");
    const { persistence, finishes } = makePersistence();
    const warn: string[] = [];

    const tool = createRunVerificationTool({
      worktreePath: root,
      rootDir: root,
      taskId: "FN-WD-1",
      recordActivity: () => {},
      verificationPersistence: persistence,
      verificationWatchdogTimeoutMs: 500,
      onVerificationEnd: () => {},
      log: { info: () => {}, debug: () => {}, warn: (s) => warn.push(s), error: () => {} },
    });

    // `tail -f /dev/null` never exits on its own; without the watchdog this hangs forever.
    const pending = tool.execute!("wd-1", { command: "tail -f /dev/null", scope: "package", timeoutSec: 30 });
    const assertion = pending.then((result) => {
      expect(result.details).toMatchObject({ success: false, timedOut: true, killed: true });
      return result;
    });

    await vi.advanceTimersByTimeAsync(700);
    await assertion;

    expect(finishes).toHaveLength(1);
    expect(finishes[0]!.status).toBe("failed");
    expect(finishes[0]!.reason ?? "").toContain("watchdog");
  });

  itPosix("queued call fails explicitly when the semaphore is saturated by a never-settling holder", async () => {
    const root = makeTmpRoot("fusion-verify-wd-queue-");
    const first = runVerificationCommand({
      command: "tail -f /dev/null",
      cwd: root,
      timeoutMs: 60_000,
      onHeartbeat: () => {},
      // No watchdog: this call legitimately never settles; it holds the single slot.
    });
    void first.catch(() => {});
    // Let the first call acquire the slot.
    await vi.advanceTimersByTimeAsync(50);

    const { persistence, finishes } = makePersistence();
    const tool = createRunVerificationTool({
      worktreePath: root,
      rootDir: root,
      taskId: "FN-WD-2",
      recordActivity: () => {},
      verificationPersistence: persistence,
      verificationWatchdogTimeoutMs: 400,
      log: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
    });

    const pending = tool.execute!("wd-2", { command: "true", scope: "package" });
    const assertion = pending.then((result) => {
      // Pre-fix: this promise NEVER settled. Now it fails within the ceiling.
      expect(result.details).toMatchObject({ success: false, timedOut: true });
      return result;
    });
    await vi.advanceTimersByTimeAsync(600);
    await assertion;

    expect(finishes).toHaveLength(1);
    expect(finishes[0]!.status).toBe("failed");
    expect(finishes[0]!.reason ?? "").toContain("watchdog");

    // Unblock the first call for teardown.
    await vi.runAllTimersAsync();
    getVerificationSemaphore().reconcileActiveCount(0);
  });

  itPosix("an external mid-run abort settles the runner and kills the child (non-sandbox path)", async () => {
    const root = makeTmpRoot("fusion-verify-wd-abort-");
    const controller = new AbortController();

    const pending = runVerificationCommand({
      command: "tail -f /dev/null",
      cwd: root,
      timeoutMs: 60_000,
      onHeartbeat: () => {},
      signal: controller.signal,
    });
    // Pre-fix: aborting here did nothing — the promise stayed pending on `close`.
    const assertion = pending.then((result) => {
      expect(result.killed).toBe(true);
      expect(result.warnings.some((w) => w.includes("aborted"))).toBe(true);
      return result;
    });

    await vi.advanceTimersByTimeAsync(100);
    controller.abort();
    await assertion;
  });

  itPosix("success path still returns normal results with the watchdog armed", async () => {
    const root = makeTmpRoot("fusion-verify-wd-ok-");
    const { persistence, finishes } = makePersistence();

    const tool = createRunVerificationTool({
      worktreePath: root,
      rootDir: root,
      taskId: "FN-WD-4",
      recordActivity: () => {},
      verificationPersistence: persistence,
      verificationWatchdogTimeoutMs: 60_000,
      log: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
    });

    const result = await tool.execute!("wd-4", { command: "true", scope: "package" });
    expect(result.details).toMatchObject({ success: true, timedOut: false });
    expect(finishes).toHaveLength(1);
    expect(finishes[0]!.status).toBe("passed");
  });

  itPosix("onVerificationEnd fires exactly once per invocation across rapid sequential calls", async () => {
    const root = makeTmpRoot("fusion-verify-wd-once-");
    const { persistence } = makePersistence();
    const onVerificationEnd = vi.fn();
    const onVerificationStart = vi.fn();

    const tool = createRunVerificationTool({
      worktreePath: root,
      rootDir: root,
      taskId: "FN-WD-5",
      recordActivity: () => {},
      verificationPersistence: persistence,
      verificationWatchdogTimeoutMs: 30_000,
      onVerificationStart,
      onVerificationEnd,
      log: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
    });

    for (let i = 0; i < 4; i++) {
      const result = await tool.execute!(`wd5-${i}`, { command: "true", scope: "package" });
      expect(result.details).toMatchObject({ success: true });
    }
    expect(onVerificationStart).toHaveBeenCalledTimes(4);
    expect(onVerificationEnd).toHaveBeenCalledTimes(4);
  });

  itPosix("watchdog=0 preserves legacy unbounded semantics (escape hatch)", async () => {
    const root = makeTmpRoot("fusion-verify-wd-off-");
    const { persistence, finishes } = makePersistence();
    const tool = createRunVerificationTool({
      worktreePath: root,
      rootDir: root,
      taskId: "FN-WD-6",
      recordActivity: () => {},
      verificationPersistence: persistence,
      verificationWatchdogTimeoutMs: 0,
      log: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
    });
    const result = await tool.execute!("wd-6", { command: "true", scope: "package" });
    expect(result.details).toMatchObject({ success: true });
    expect(finishes).toHaveLength(1);
  });
});
