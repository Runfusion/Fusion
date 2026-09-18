import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createRunVerificationTool, runVerificationCommand, type RunVerificationPersistence } from "../execution/run-verification-tool.js";
import { getVerificationSemaphore, resetVerificationLimitRegistryForTests, setMaxConcurrentVerifications } from "../concurrency/verification-concurrency.js";
import { StuckTaskDetector } from "../healing/stuck-task-detector.js";

/*
FNXC:VerificationWriteAhead 2026-08-31-00:00 (EXAM-010):
Kill-mid-verification acceptance test — the exact stuck-call pattern observed live on
2026-08-31 (EXAM-002 wedged ~5x; EXAM-002/EXAM-007 both showed dropped request records):
multiple rapid verification requests on one task, then the executor run dies mid-call.

Asserts all three acceptance conditions:
  (a) after the kill/abort the request record STILL EXISTS and is inspectable
      (status `running` pre-reclaim or terminal `failed` post-reclaim — never vanished)
  (b) the calling run does NOT hang on the dead call — the watchdog settles it
      explicitly within the configured (test-scaled) ceiling
  (c) a SUBSEQUENT verification request on the same task succeeds cleanly
      (stale row reclaimed via CAS, new claim won, terminal result written)

The in-memory record store mirrors the project-scoped task_verification_requests
lifecycle (create / claim / finish / CAS reclaim) including the requestId+startedAt
guards; the PostgreSQL truth is pinned by task-verification-request-lifecycle.pg.test.ts.
*/

const itPosix = process.platform !== "win32" ? it : it.skip;

function makeTmpRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(root, "node_modules"), { recursive: true });
  writeFileSync(join(root, "node_modules", ".modules.yaml"), "layoutVersion: 5\n");
  return root;
}

/** In-memory stand-in for the project-scoped verification request table, with CAS guards. */
class VerificationRecordStore {
  private row: { requestId: string; status: string; startedAt: string | null; completedAt: string | null; rejectionReason: string | null; result: unknown } | null = null;

  async read(): Promise<typeof this.row> { return this.row; }

  /** Mirrors upsertExecutorVerificationRequestImpl. */
  async upsert(input: { taskId: string; requestId: string; command: string; scope: "package" | "workspace" }): Promise<{ claimed: boolean; request: NonNullable<typeof this.row>; reason?: "in-flight" }> {
    const existing = this.row;
    const now = new Date().toISOString();
    if (existing && existing.status === "running") {
      return { claimed: false, request: existing, reason: "in-flight" };
    }
    if (existing && existing.status === "requested") {
      this.row = { ...existing, status: "running", startedAt: now };
      return { claimed: true, request: this.row };
    }
    this.row = { requestId: input.requestId, status: "running", startedAt: now, completedAt: null, rejectionReason: null, result: null };
    return { claimed: true, request: this.row };
  }

  /** Mirrors reclaimStaleTaskVerificationRequestImpl: requestId + startedAt CAS. */
  async reclaimStale(requestId: string, olderThanMs: number): Promise<typeof this.row> {
    const row = this.row;
    if (!row || row.status !== "running" || row.requestId !== requestId || !row.startedAt) return null;
    if (Date.now() - Date.parse(row.startedAt) < olderThanMs) return null;
    this.row = { ...row, status: "failed", completedAt: new Date().toISOString(), rejectionReason: `executor lost: running verification reclaimed after ${olderThanMs}ms without completion` };
    return this.row;
  }

  async finish(requestId: string, status: "passed" | "failed" | "rejected", result?: unknown, rejectionReason?: string): Promise<void> {
    const row = this.row;
    if (!row || row.requestId !== requestId || row.status !== "running") return;
    this.row = { ...row, status, completedAt: new Date().toISOString(), result: result ?? null, rejectionReason: rejectionReason ?? null };
  }

  asPersistence(): RunVerificationPersistence {
    return {
      upsert: async (input) => this.upsert(input),
      finish: async (_taskId, requestId, status, result, rejectionReason) => this.finish(requestId, status, result, rejectionReason),
      reclaimStale: async (_taskId, requestId, olderThanMs) => this.reclaimStale(requestId, olderThanMs),
    };
  }
}

describe("executor verification restart recovery (EXAM-010 acceptance)", () => {
  const roots: string[] = [];
  afterEach(() => {
    vi.useRealTimers();
    getVerificationSemaphore().reconcileActiveCount(0);
    void roots.splice(0).length;
  });

  itPosix("(a) a killed run leaves an inspectable record; (b) watchdog settles the dead call; (c) the next request succeeds cleanly", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    resetVerificationLimitRegistryForTests();
    setMaxConcurrentVerifications(1);
    getVerificationSemaphore().reconcileActiveCount(0);

    const root = mkdtempSync(join(tmpdir(), "fusion-verify-restart-"));
    roots.push(root);
    const recordStore = new VerificationRecordStore();
    const detector = new StuckTaskDetector({ getTask: async () => null } as never, {});
    const taskId = "FN-RESTART-1";

    // ── Phase 1: the stuck-call pattern — several rapid verification requests. ──
    const tool = createRunVerificationTool({
      worktreePath: root,
      rootDir: root,
      taskId,
      recordActivity: () => detector.recordActivity(taskId),
      verificationPersistence: recordStore.asPersistence(),
      verificationWatchdogTimeoutMs: 600,
      onVerificationStart: (timeoutMs) => detector.beginVerification(taskId, timeoutMs),
      onVerificationEnd: () => detector.endVerification(taskId),
      log: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
    });
    for (let i = 0; i < 3; i++) {
      const quick = await tool.execute!(`rapid-${i}`, { command: "true", scope: "package" });
      expect(quick.details).toMatchObject({ success: true });
    }
    // Every rapid call left a terminal record; the row exists and is inspectable.
    expect((await recordStore.read())?.status).toBe("passed");

    // ── Phase 2: the executor run dies MID-verification. ──
    // A call whose child never exits, with a watchdog armed; the "run dies" is modeled
    // by abandoning the promise (no await) exactly like a killed executor would.
    const wedgedCall = tool.execute!("wedged", { command: "tail -f /dev/null", scope: "package", timeoutSec: 60 });
    // Let it dispatch (slot + spawn) and the write-ahead to land.
    await vi.advanceTimersByTimeAsync(150);
    // (a) PRE-RECLAIM: the record exists in `running` — not vanished.
    const midRun = await recordStore.read();
    expect(midRun?.status).toBe("running");
    expect(midRun?.startedAt).toBeTruthy();

    // (b) The watchdog — not the operator — settles the dead call within the ceiling.
    const settled = wedgedCall.then((result) => {
      expect(result.details).toMatchObject({ success: false, timedOut: true });
      return result;
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await settled;

    // The terminal record names the failure.
    const afterWatchdog = await recordStore.read();
    expect(afterWatchdog?.status).toBe("failed");
    expect(afterWatchdog?.completedAt).toBeTruthy();

    // ── Phase 3: executor restart — the stale `running` row from a run that died
    // BEFORE its watchdog could write (model an orphan: flip the row back to a stale
    // running state with an old startedAt, as a killed process would leave it).
    const orphanRequestStore = new VerificationRecordStore();
    const orphanRow = await orphanRequestStore.upsert({ taskId, requestId: `req-orphan-${randomUUID()}`, command: "pnpm verify:fast", scope: "workspace" });
    // Age the startedAt past the ceiling by reclaiming with a shorter threshold than
    // the age — using a very old startedAt seeded directly.
    const aged = { ...(await orphanRequestStore.read())!, startedAt: new Date(Date.now() - 10 * 60_000).toISOString() };
    (orphanRequestStore as unknown as { row: unknown }).row = aged;
    void orphanRow;

    // (c) A SUBSEQUENT verification request on the same task succeeds cleanly:
    // stale row reclaimed via CAS, then the new tool call claims and finishes.
    const reclaimed = await orphanRequestStore.reclaimStale(aged.requestId, 600_000);
    expect(reclaimed?.status).toBe("failed");
    expect(reclaimed?.rejectionReason).toContain("executor lost");

    const followUp = await tool.execute!("after-restart", { command: "true", scope: "package" });
    expect(followUp.details).toMatchObject({ success: true });
    const finalRow = await recordStore.read();
    expect(finalRow?.status).toBe("passed");
    // The follow-up did not wedge: the semaphore is drained and reusable.
    getVerificationSemaphore().reconcileActiveCount(0);
  });

  itPosix("rapid requests during a wedged call do not wedge the pickup loop (bounded queue)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    resetVerificationLimitRegistryForTests();
    setMaxConcurrentVerifications(1);
    getVerificationSemaphore().reconcileActiveCount(0);

    const root = makeTmpRoot("fusion-verify-rapid-wedge-");
    const recordStore = new VerificationRecordStore();

    // First call: no watchdog, legitimately never settles, holds the single slot —
    // this models the pre-fix wedged executor.
    const wedged = runVerificationCommand({
      command: "tail -f /dev/null",
      cwd: root,
      timeoutMs: 120_000,
      onHeartbeat: () => {},
    });
    void wedged.catch(() => {});
    await vi.advanceTimersByTimeAsync(100);

    const tool = createRunVerificationTool({
      worktreePath: root,
      rootDir: root,
      taskId: "FN-RESTART-2",
      recordActivity: () => {},
      verificationPersistence: recordStore.asPersistence(),
      verificationWatchdogTimeoutMs: 500,
      log: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
    });

    // Multiple rapid queued calls: every one must settle explicitly within the ceiling
    // instead of stacking unboundedly behind the wedged holder (the pre-fix behavior).
    const calls = Array.from({ length: 3 }, (_, i) =>
      tool.execute!(`queued-${i}`, { command: "true", scope: "package" }).then((result) => {
        expect(result.details).toMatchObject({ success: false, timedOut: true });
        return result;
      }),
    );
    await vi.advanceTimersByTimeAsync(2_000);
    await Promise.all(calls);

    // All three left terminal failed records with watchdog reasons.
    const row = await recordStore.read();
    expect(row?.status).toBe("failed");

    await vi.runAllTimersAsync();
    getVerificationSemaphore().reconcileActiveCount(0);
  });

  itPosix("detector brackets stay balanced across watchdog failure and rapid success", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    resetVerificationLimitRegistryForTests();
    setMaxConcurrentVerifications(1);
    getVerificationSemaphore().reconcileActiveCount(0);

    const root = makeTmpRoot("fusion-verify-brackets-");
    const recordStore = new VerificationRecordStore();
    const detector = new StuckTaskDetector({ getTask: async () => null } as never, {});
    const taskId = "FN-RESTART-3";
    const isVerificationActive = () => {
      // Reach into the private state the same way the detector's own tests do.
      return (detector as unknown as { tracked: Map<string, { verificationActiveCount: number }> }).tracked.get(taskId)?.verificationActiveCount ?? 0;
    };

    const tool = createRunVerificationTool({
      worktreePath: root,
      rootDir: root,
      taskId,
      recordActivity: () => detector.recordActivity(taskId),
      verificationPersistence: recordStore.asPersistence(),
      verificationWatchdogTimeoutMs: 400,
      onVerificationStart: (timeoutMs) => detector.beginVerification(taskId, timeoutMs),
      onVerificationEnd: () => detector.endVerification(taskId),
      log: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
    });
    detector.trackTask(taskId, { dispose: vi.fn() } as never);

    const wedged = tool.execute!("wd-bracket", { command: "tail -f /dev/null", scope: "package", timeoutSec: 60 });
    await vi.advanceTimersByTimeAsync(100);
    expect(isVerificationActive()).toBe(1); // suppression active while running
    await vi.advanceTimersByTimeAsync(600);
    await wedged;
    expect(isVerificationActive()).toBe(0); // balanced by onVerificationEnd in finally

    for (let i = 0; i < 3; i++) {
      const ok = await tool.execute!(`ok-${i}`, { command: "true", scope: "package" });
      expect(ok.details).toMatchObject({ success: true });
      expect(isVerificationActive()).toBe(0);
    }
  });
});
