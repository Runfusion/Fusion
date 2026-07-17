import { describe, it, expect, vi } from "vitest";
import type { Task } from "@fusion/core";
import {
  AgentSemaphore,
  ScopedAgentSemaphore,
  PRIORITY_MERGE,
  PRIORITY_EXECUTE,
  PRIORITY_SPECIFY,
  clearPreHeldExecutorSlotsForTests,
  computeTopLevelConcurrencyClaimed,
  dropPreHeldExecutorSlot,
  hasPreHeldExecutorSlot,
  persistedTopLevelAgentSlots,
  recoverIdleSemaphoreLeakCandidate,
  registerPreHeldExecutorSlot,
  takePreHeldExecutorSlot,
} from "../concurrency.js";

describe("ScopedAgentSemaphore", () => {
  it("returns only this scope's residual slots without clobbering other scopes", async () => {
    const shared = new AgentSemaphore(3);
    const projectA = new ScopedAgentSemaphore(shared);
    const projectB = new ScopedAgentSemaphore(shared);

    await projectA.acquire(PRIORITY_EXECUTE);
    await projectA.acquire(PRIORITY_MERGE);
    await projectB.acquire(PRIORITY_SPECIFY);

    expect(shared.activeCount).toBe(3);
    expect(projectA.heldCount).toBe(2);
    expect(projectB.heldCount).toBe(1);

    expect(projectA.returnAllHeldSlots()).toBe(2);

    expect(projectA.heldCount).toBe(0);
    expect(projectB.heldCount).toBe(1);
    expect(shared.activeCount).toBe(1);
    expect(shared.availableCount).toBe(2);

    projectB.release();
    expect(shared.activeCount).toBe(0);
  });

  it("is idempotent for zero-held and double residual returns without excess warnings", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const shared = new AgentSemaphore(2);
      const scope = new ScopedAgentSemaphore(shared);

      expect(scope.returnAllHeldSlots()).toBe(0);
      expect(scope.tryAcquire()).toBe(true);
      expect(scope.heldCount).toBe(1);
      expect(scope.returnAllHeldSlots()).toBe(1);
      expect(scope.returnAllHeldSlots()).toBe(0);
      scope.release();

      expect(shared.activeCount).toBe(0);
      expect(shared.availableCount).toBe(2);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("tracks run and runNested slots, and late finally releases are no-ops after residual return", async () => {
    const shared = new AgentSemaphore(4);
    const scope = new ScopedAgentSemaphore(shared);
    let releaseRun!: () => void;
    let releaseNested!: () => void;

    const runPromise = scope.run(
      () => new Promise<void>((resolve) => {
        releaseRun = resolve;
      }),
      PRIORITY_EXECUTE,
    );
    await Promise.resolve();

    const nestedPromise = scope.runNested(
      () => new Promise<void>((resolve) => {
        releaseNested = resolve;
      }),
    );
    await Promise.resolve();

    expect(scope.heldCount).toBe(2);
    expect(shared.activeCount).toBe(2);
    expect(scope.returnAllHeldSlots()).toBe(2);
    expect(shared.activeCount).toBe(0);

    releaseRun();
    releaseNested();
    await Promise.all([runPromise, nestedPromise]);

    expect(scope.heldCount).toBe(0);
    expect(shared.activeCount).toBe(0);
  });

  it("delegates queued acquisition priority through the shared pool", async () => {
    const shared = new AgentSemaphore(1);
    const low = new ScopedAgentSemaphore(shared);
    const high = new ScopedAgentSemaphore(shared);
    const order: string[] = [];

    await low.acquire(PRIORITY_SPECIFY);
    const lowWaiter = low.acquire(PRIORITY_SPECIFY).then(() => order.push("low"));
    const highWaiter = high.acquire(PRIORITY_MERGE).then(() => order.push("high"));
    await Promise.resolve();

    low.release();
    await highWaiter;
    expect(order).toEqual(["high"]);
    expect(high.heldCount).toBe(1);

    high.release();
    await lowWaiter;
    expect(order).toEqual(["high", "low"]);
    low.release();
    expect(shared.activeCount).toBe(0);
  });

  it("honors live global-limit changes across scoped project semaphores on the next acquire", async () => {
    let globalLimit = 2;
    const shared = new AgentSemaphore(() => globalLimit);
    const projectA = new ScopedAgentSemaphore(shared);
    const projectB = new ScopedAgentSemaphore(shared);

    await projectA.acquire(PRIORITY_EXECUTE);
    await projectB.acquire(PRIORITY_MERGE);
    expect(shared.snapshot()).toEqual({ activeCount: 2, waitingCount: 0, availableCount: 0, limit: 2 });

    globalLimit = 1;
    let acquired = false;
    const waiter = projectA.acquire(PRIORITY_EXECUTE).then(() => {
      acquired = true;
    });
    await Promise.resolve();

    expect(acquired).toBe(false);
    expect(shared.snapshot()).toEqual({ activeCount: 2, waitingCount: 1, availableCount: 0, limit: 1 });

    projectA.release();
    await Promise.resolve();
    expect(acquired).toBe(false);
    expect(shared.snapshot()).toEqual({ activeCount: 1, waitingCount: 1, availableCount: 0, limit: 1 });

    globalLimit = 2;
    projectB.release();
    await waiter;

    expect(acquired).toBe(true);
    expect(projectA.heldCount).toBe(1);
    expect(projectB.heldCount).toBe(0);
    expect(shared.snapshot()).toEqual({ activeCount: 1, waitingCount: 0, availableCount: 1, limit: 2 });

    projectA.release();
    expect(shared.activeCount).toBe(0);
  });

  it("reconciles only this scope's slots when another project still holds global capacity", async () => {
    const shared = new AgentSemaphore(3);
    const idleProject = new ScopedAgentSemaphore(shared);
    const activeProject = new ScopedAgentSemaphore(shared);

    await idleProject.acquire(PRIORITY_EXECUTE);
    await idleProject.acquire(PRIORITY_EXECUTE);
    await activeProject.acquire(PRIORITY_MERGE);

    const result = idleProject.reconcileActiveCount(0);

    expect(result).toEqual({ before: 2, after: 0, changed: true });
    expect(idleProject.heldCount).toBe(0);
    expect(activeProject.heldCount).toBe(1);
    expect(shared.activeCount).toBe(1);
    expect(shared.availableCount).toBe(2);

    activeProject.release();
    expect(shared.activeCount).toBe(0);
  });
});

describe("AgentSemaphore", () => {
  it("allows immediate acquire when under limit", async () => {
    const sem = new AgentSemaphore(2);
    await sem.acquire();
    expect(sem.activeCount).toBe(1);
    expect(sem.availableCount).toBe(1);
    sem.release();
    expect(sem.activeCount).toBe(0);
    expect(sem.availableCount).toBe(2);
  });

  it("FN-6423: clamps excess slot returns without breaking future acquires", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const sem = new AgentSemaphore(2);
      await sem.acquire();
      sem.release();
      sem.release();
      sem.release();

      expect(sem.activeCount).toBe(0);
      expect(sem.availableCount).toBe(2);
      expect(sem.snapshot()).toEqual({
        activeCount: 0,
        waitingCount: 0,
        availableCount: 2,
        limit: 2,
      });
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0]?.[0])).toContain("AgentSemaphore excess slot return ignored from release");

      expect(sem.tryAcquire()).toBe(true);
      expect(sem.activeCount).toBe(1);
      sem.release();
      await sem.acquire();
      expect(sem.activeCount).toBe(1);
      sem.release();
      expect(sem.activeCount).toBe(0);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("queues waiters when at capacity and unblocks FIFO", async () => {
    const sem = new AgentSemaphore(1);
    await sem.acquire(); // slot taken

    const order: number[] = [];

    const p1 = sem.acquire().then(() => order.push(1));
    const p2 = sem.acquire().then(() => order.push(2));

    // Both should be waiting
    expect(sem.activeCount).toBe(1);

    // Release — first waiter should be unblocked
    sem.release();
    await p1;
    expect(order).toEqual([1]);
    expect(sem.activeCount).toBe(1);

    // Release again — second waiter
    sem.release();
    await p2;
    expect(order).toEqual([1, 2]);
    expect(sem.activeCount).toBe(1);

    sem.release();
    expect(sem.activeCount).toBe(0);
  });

  it("run() releases on success", async () => {
    const sem = new AgentSemaphore(1);
    const result = await sem.run(async () => {
      expect(sem.activeCount).toBe(1);
      return 42;
    });
    expect(result).toBe(42);
    expect(sem.activeCount).toBe(0);
  });

  it("run() releases on error", async () => {
    const sem = new AgentSemaphore(1);
    await expect(
      sem.run(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(sem.activeCount).toBe(0);
  });

  it("respects dynamic limit changes on next acquire", async () => {
    let limit = 2;
    const sem = new AgentSemaphore(() => limit);

    await sem.acquire();
    await sem.acquire();
    expect(sem.activeCount).toBe(2);
    expect(sem.availableCount).toBe(0);

    // Increase the limit — next acquire should succeed immediately
    limit = 3;
    expect(sem.availableCount).toBe(1);
    await sem.acquire();
    expect(sem.activeCount).toBe(3);

    sem.release();
    sem.release();
    sem.release();
  });

  it("blocks new acquires when limit is reduced below activeCount", async () => {
    let limit = 3;
    const sem = new AgentSemaphore(() => limit);

    await sem.acquire();
    await sem.acquire();
    expect(sem.activeCount).toBe(2);

    // Reduce limit below current active count
    limit = 1;
    expect(sem.availableCount).toBe(0);

    let acquired = false;
    const p = sem.acquire().then(() => {
      acquired = true;
    });

    // Should not have acquired yet
    await Promise.resolve(); // tick
    expect(acquired).toBe(false);

    // Release one slot — active goes from 2 to 1, still >= limit (1), so still blocked
    sem.release();
    await Promise.resolve();
    expect(acquired).toBe(false);

    // Release again — active drops to 0, which is < limit (1), so waiter unblocks
    sem.release();
    await p;
    expect(acquired).toBe(true);
    expect(sem.activeCount).toBe(1);

    sem.release();
  });

  it("activeCount and availableCount are accurate under load", async () => {
    const sem = new AgentSemaphore(3);
    expect(sem.activeCount).toBe(0);
    expect(sem.availableCount).toBe(3);
    expect(sem.limit).toBe(3);

    await sem.acquire();
    expect(sem.activeCount).toBe(1);
    expect(sem.availableCount).toBe(2);

    await sem.acquire();
    await sem.acquire();
    expect(sem.activeCount).toBe(3);
    expect(sem.availableCount).toBe(0);

    sem.release();
    expect(sem.activeCount).toBe(2);
    expect(sem.availableCount).toBe(1);

    sem.release();
    sem.release();
    expect(sem.activeCount).toBe(0);
    expect(sem.availableCount).toBe(3);
  });

  it("reports waitingCount and diagnostic snapshot", async () => {
    const sem = new AgentSemaphore(1);
    await sem.acquire();

    const waiter = sem.acquire();
    await Promise.resolve();

    expect(sem.waitingCount).toBe(1);
    expect(sem.snapshot()).toEqual({
      activeCount: 1,
      waitingCount: 1,
      availableCount: 0,
      limit: 1,
    });

    sem.release();
    await waiter;
    expect(sem.waitingCount).toBe(0);
    sem.release();
  });

  it("reconciles stale active counts down to persisted active work", async () => {
    const sem = new AgentSemaphore(2);
    await sem.acquire();
    await sem.acquire();

    const result = sem.reconcileActiveCount(0);

    expect(result).toEqual({ before: 2, after: 0, changed: true });
    expect(sem.activeCount).toBe(0);
    expect(sem.availableCount).toBe(2);
  });

  it("does not increase active counts during reconciliation", async () => {
    const sem = new AgentSemaphore(2);
    await sem.acquire();

    const result = sem.reconcileActiveCount(3);

    expect(result).toEqual({ before: 1, after: 1, changed: false });
    expect(sem.activeCount).toBe(1);
    sem.release();
  });

  it("counts persisted top-level slots with the shared in-review running-agent predicate", () => {
    const tasks = [
      { column: "in-progress" },
      { column: "triage", status: "planning", paused: false },
      { column: "triage", status: "planning", paused: true },
      { column: "in-review", status: "reviewing", paused: false },
      { column: "in-review", status: "merging", paused: false },
      { column: "in-review", status: "merging-pr", paused: false },
      { column: "in-review", status: "merging-fix", paused: false },
      { column: "in-review", status: "fixing", paused: false },
      { column: "in-review", status: "reviewing", paused: true },
      { column: "todo" },
    ] as Task[];

    expect(persistedTopLevelAgentSlots(tasks)).toBe(7);
  });

  it("claims top-level concurrency as max(live running agents, semaphore active, pending specify)", () => {
    const tasks = [
      { column: "in-progress" },
      { column: "triage", status: "planning", paused: false },
      { column: "triage", status: "planning", paused: false },
      { column: "triage", status: "planning", paused: false },
      { column: "triage", status: "planning", paused: false },
      { column: "todo" },
    ] as Task[];

    // 4 planning + 1 in-progress = 5 live holders (the reported over-cap symptom).
    expect(computeTopLevelConcurrencyClaimed({ tasks })).toBe(5);
    // Prefer the larger of live holders and in-memory activeCount.
    expect(computeTopLevelConcurrencyClaimed({ tasks, semaphoreActiveCount: 2 })).toBe(5);
    expect(computeTopLevelConcurrencyClaimed({ tasks: [], semaphoreActiveCount: 3, pendingSpecifyCount: 2 })).toBe(3);
    expect(computeTopLevelConcurrencyClaimed({ tasks: [], semaphoreActiveCount: 1, pendingSpecifyCount: 2 })).toBe(2);
  });

  it("hands off pre-held executor slots without double-registering", () => {
    clearPreHeldExecutorSlotsForTests();
    const sem = new AgentSemaphore(2);
    expect(sem.tryAcquire()).toBe(true);
    registerPreHeldExecutorSlot("FN-1");
    expect(hasPreHeldExecutorSlot("FN-1")).toBe(true);

    expect(takePreHeldExecutorSlot("FN-1")).toBe(true);
    expect(hasPreHeldExecutorSlot("FN-1")).toBe(false);
    expect(takePreHeldExecutorSlot("FN-1")).toBe(false);

    // Failed dispatch path releases both the registry entry and the semaphore slot.
    expect(sem.tryAcquire()).toBe(true);
    registerPreHeldExecutorSlot("FN-2");
    dropPreHeldExecutorSlot("FN-2", sem);
    expect(hasPreHeldExecutorSlot("FN-2")).toBe(false);
    expect(sem.activeCount).toBe(1);
    sem.release();
    clearPreHeldExecutorSlotsForTests();
  });

  /*
  FNXC:GlobalConcurrencyControls 2026-07-15-02:55:
  Graph fallback re-registers a scheduler pre-held slot for the legacy execute path. That registration must always be either take()n (legacy agent work under runWithExecutorSemaphore) or drop()ped on early exits. A re-register without a subsequent take/drop is the permanent global-capacity leak Greptile P1 (PR #2107) caught: activeCount stays inflated while the task is no longer holding work.
  */
  it("treats graph→legacy re-register as a leak unless take or drop follows", () => {
    clearPreHeldExecutorSlotsForTests();
    const sem = new AgentSemaphore(1);
    expect(sem.tryAcquire()).toBe(true);
    // Scheduler reserved the slot before todo→in-progress.
    registerPreHeldExecutorSlot("FN-LEGACY-HANDOFF");

    // Graph claims then re-registers for legacy (transferPreHeldToLegacy).
    expect(takePreHeldExecutorSlot("FN-LEGACY-HANDOFF")).toBe(true);
    registerPreHeldExecutorSlot("FN-LEGACY-HANDOFF");
    expect(hasPreHeldExecutorSlot("FN-LEGACY-HANDOFF")).toBe(true);
    expect(sem.activeCount).toBe(1);

    // Authoritative / work-engine / heartbeat-defer early returns must drop, not leave the registration.
    dropPreHeldExecutorSlot("FN-LEGACY-HANDOFF", sem);
    expect(hasPreHeldExecutorSlot("FN-LEGACY-HANDOFF")).toBe(false);
    expect(sem.activeCount).toBe(0);

    // Happy path: re-register then take + release (runWithExecutorSemaphore contract).
    expect(sem.tryAcquire()).toBe(true);
    registerPreHeldExecutorSlot("FN-LEGACY-TAKE");
    expect(takePreHeldExecutorSlot("FN-LEGACY-TAKE")).toBe(true);
    expect(hasPreHeldExecutorSlot("FN-LEGACY-TAKE")).toBe(false);
    sem.release();
    expect(sem.activeCount).toBe(0);
    // Second drop after take is a no-op — safe for execute()'s outer finally belt-and-suspenders.
    dropPreHeldExecutorSlot("FN-LEGACY-TAKE", sem);
    expect(sem.activeCount).toBe(0);
    clearPreHeldExecutorSlotsForTests();
  });

  /*
  FNXC:GlobalConcurrencyControls 2026-07-15-03:50:
  Scheduler hold/release: tryAcquire + register before the column move; if the move fails the
  prep release() lambda must dropPreHeldExecutorSlot so activeCount returns to zero. Without
  that cleanup a failed dispatch permanently shrinks global capacity.
  */
  it("releases pre-held semaphore when scheduler dispatch prep release() runs (move failure)", () => {
    clearPreHeldExecutorSlotsForTests();
    const sem = new AgentSemaphore(2);
    expect(sem.tryAcquire()).toBe(true);
    registerPreHeldExecutorSlot("FN-MOVE-FAIL");
    expect(hasPreHeldExecutorSlot("FN-MOVE-FAIL")).toBe(true);
    expect(sem.activeCount).toBe(1);

    // Mirrors scheduler.ts prep.release() after a failed/aborted hold release.
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      dropPreHeldExecutorSlot("FN-MOVE-FAIL", sem);
    };
    release();
    release(); // idempotent

    expect(hasPreHeldExecutorSlot("FN-MOVE-FAIL")).toBe(false);
    expect(sem.activeCount).toBe(0);
    clearPreHeldExecutorSlotsForTests();
  });

  it("recovers idle semaphore leaks only after a stable persisted-idle window", async () => {
    const sem = new AgentSemaphore(2);
    await sem.acquire();
    const tasks: Task[] = [];

    const first = recoverIdleSemaphoreLeakCandidate({
      semaphore: sem,
      tasks,
      candidateSinceMs: null,
      nowMs: 1_000,
    });
    expect(first).toEqual({ candidateSinceMs: 1_000 });
    expect(sem.activeCount).toBe(1);

    const early = recoverIdleSemaphoreLeakCandidate({
      semaphore: sem,
      tasks,
      candidateSinceMs: first.candidateSinceMs,
      nowMs: 5_000,
    });
    expect(early).toEqual({ candidateSinceMs: 1_000 });
    expect(sem.activeCount).toBe(1);

    const repaired = recoverIdleSemaphoreLeakCandidate({
      semaphore: sem,
      tasks,
      candidateSinceMs: early.candidateSinceMs,
      nowMs: 6_001,
    });
    expect(repaired).toEqual({
      candidateSinceMs: null,
      reconciliation: { before: 1, after: 0, changed: true },
    });
    expect(sem.activeCount).toBe(0);
  });

  it("does not recover while callers report in-flight work not yet persisted", async () => {
    const sem = new AgentSemaphore(2);
    await sem.acquire();

    const result = recoverIdleSemaphoreLeakCandidate({
      semaphore: sem,
      tasks: [],
      candidateSinceMs: Date.now() - 6_000,
      inFlightCount: 1,
      nowMs: Date.now(),
    });

    expect(result).toEqual({ candidateSinceMs: null });
    expect(sem.activeCount).toBe(1);
    sem.release();
  });

  /*
  FNXC:GlobalConcurrencyControls 2026-07-16-00:00:
  The idle-only valve never fired when a few zombie in-progress rows kept
  persistedActive nonzero, so slots leaked by abnormal teardown accumulated
  until activeCount pinned the limit and the engine sat idle until restart.
  The generalized valve clamps to the persisted+in-flight bound after the
  (long) stale-excess window while leaving legitimate nested overshoot alone.
  */
  it("recovers stale excess above the persisted bound after the stale-excess window", async () => {
    const sem = new AgentSemaphore(8);
    for (let i = 0; i < 6; i++) await sem.acquire();
    // Two genuinely running tasks persist; four held slots are leaked.
    const tasks = [
      { column: "in-progress" },
      { column: "in-progress" },
    ] as Task[];

    const first = recoverIdleSemaphoreLeakCandidate({
      semaphore: sem,
      tasks,
      candidateSinceMs: null,
      nowMs: 1_000,
    });
    expect(first).toEqual({ candidateSinceMs: 1_000 });
    expect(sem.activeCount).toBe(6);

    // Idle 5s window elapsed — but bound > 0, so the long window governs.
    const early = recoverIdleSemaphoreLeakCandidate({
      semaphore: sem,
      tasks,
      candidateSinceMs: first.candidateSinceMs,
      nowMs: 6_001,
    });
    expect(early).toEqual({ candidateSinceMs: 1_000 });
    expect(sem.activeCount).toBe(6);

    const repaired = recoverIdleSemaphoreLeakCandidate({
      semaphore: sem,
      tasks,
      candidateSinceMs: early.candidateSinceMs,
      nowMs: 1_000 + 600_001,
    });
    expect(repaired).toEqual({
      candidateSinceMs: null,
      reconciliation: { before: 6, after: 2, changed: true },
    });
    expect(sem.activeCount).toBe(2);
  });

  it("resets the stale-excess candidate when the excess clears (nested overshoot ends)", async () => {
    const sem = new AgentSemaphore(4);
    await sem.acquire();
    sem.acquireNestedSlot(); // legitimate nested overshoot: active=2, persisted=1
    const tasks = [{ column: "in-progress" }] as Task[];

    const candidate = recoverIdleSemaphoreLeakCandidate({
      semaphore: sem,
      tasks,
      candidateSinceMs: null,
      nowMs: 1_000,
    });
    expect(candidate).toEqual({ candidateSinceMs: 1_000 });

    sem.releaseNestedSlot(); // nested run finishes; excess is gone

    const reset = recoverIdleSemaphoreLeakCandidate({
      semaphore: sem,
      tasks,
      candidateSinceMs: candidate.candidateSinceMs,
      nowMs: 1_000 + 600_001,
    });
    expect(reset).toEqual({ candidateSinceMs: null });
    expect(sem.activeCount).toBe(1);
    sem.release();
  });

  it("counts caller in-flight sessions into the stale-excess bound", async () => {
    const sem = new AgentSemaphore(4);
    await sem.acquire();
    await sem.acquire();
    // One persisted running task + one triage in-flight session account for
    // both held slots — no excess, no candidate.
    const result = recoverIdleSemaphoreLeakCandidate({
      semaphore: sem,
      tasks: [{ column: "in-progress" }] as Task[],
      candidateSinceMs: 999,
      inFlightCount: 1,
      nowMs: 700_000,
    });
    expect(result).toEqual({ candidateSinceMs: null });
    expect(sem.activeCount).toBe(2);
    sem.release();
    sem.release();
  });

  it("run() gates concurrent calls", async () => {
    const sem = new AgentSemaphore(2);
    let concurrent = 0;
    let maxConcurrent = 0;

    const task = () =>
      sem.run(async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        // Yield to allow other tasks to attempt to run
        await new Promise((r) => setTimeout(r, 10));
        concurrent--;
      });

    await Promise.all([task(), task(), task(), task(), task()]);
    expect(maxConcurrent).toBe(2);
    expect(sem.activeCount).toBe(0);
  });

  it("integration: simulates triage-like usage with semaphore.run()", async () => {
    const sem = new AgentSemaphore(1);
    let concurrent = 0;
    let maxConcurrent = 0;

    // Simulate two specifyTask-like calls that would normally run in parallel
    const specifyTask = async () => {
      const agentWork = async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 10));
        concurrent--;
      };
      await sem.run(agentWork);
    };

    await Promise.all([specifyTask(), specifyTask(), specifyTask()]);
    expect(maxConcurrent).toBe(1);
    expect(sem.activeCount).toBe(0);
  });

  it("integration: simulates merge-like usage with semaphore.run()", async () => {
    const sem = new AgentSemaphore(1);
    let concurrent = 0;
    let maxConcurrent = 0;

    // Simulate serialized merge queue where each merge also goes through semaphore
    const rawMerge = async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 10));
      concurrent--;
    };
    const onMerge = () => sem.run(rawMerge);

    await Promise.all([onMerge(), onMerge(), onMerge()]);
    expect(maxConcurrent).toBe(1);
    expect(sem.activeCount).toBe(0);
  });

  it("keeps executor-style write sections within the configured execute concurrency", async () => {
    const sem = new AgentSemaphore(2);
    let concurrentWrites = 0;
    let maxConcurrentWrites = 0;

    const performWrite = (taskId: string) =>
      sem.run(async () => {
        concurrentWrites += 1;
        maxConcurrentWrites = Math.max(maxConcurrentWrites, concurrentWrites);
        await new Promise((resolve) => setTimeout(resolve, 10));
        concurrentWrites -= 1;
        return taskId;
      }, PRIORITY_EXECUTE);

    const completed = await Promise.all([
      performWrite("FN-1"),
      performWrite("FN-2"),
      performWrite("FN-3"),
      performWrite("FN-4"),
    ]);

    expect(completed).toEqual(["FN-1", "FN-2", "FN-3", "FN-4"]);
    expect(maxConcurrentWrites).toBe(2);
    expect(sem.activeCount).toBe(0);
  });

  it("integration: shared semaphore limits triage + execution + merge together", async () => {
    const sem = new AgentSemaphore(2);
    let concurrent = 0;
    let maxConcurrent = 0;

    const simulateAgent = () =>
      sem.run(async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 10));
        concurrent--;
      });

    // Simulate mixed activity: 2 triage + 2 execution + 2 merge = 6 total
    await Promise.all([
      simulateAgent(), // triage
      simulateAgent(), // triage
      simulateAgent(), // execution
      simulateAgent(), // execution
      simulateAgent(), // merge
      simulateAgent(), // merge
    ]);

    // Should never exceed 2 concurrent despite 6 tasks
    expect(maxConcurrent).toBe(2);
    expect(sem.activeCount).toBe(0);
  });

  it("integration: semaphore is optional (no-op when absent)", async () => {
    const opts: { semaphore?: AgentSemaphore } = {};
    let ran = false;

    const agentWork = async () => {
      ran = true;
    };

    if (opts.semaphore) {
      await opts.semaphore.run(agentWork);
    } else {
      await agentWork();
    }

    expect(ran).toBe(true);
  });

  // ── Priority scheduling tests ──────────────────────────────────────

  it("priority: highest-priority waiter is served first when slot is released", async () => {
    const sem = new AgentSemaphore(1);
    await sem.acquire(); // fill the single slot

    const order: string[] = [];

    // Queue three waiters in non-priority order: specify, merge, execute
    const pSpecify = sem.acquire(PRIORITY_SPECIFY).then(() => order.push("specify"));
    const pMerge = sem.acquire(PRIORITY_MERGE).then(() => order.push("merge"));
    const pExecute = sem.acquire(PRIORITY_EXECUTE).then(() => order.push("execute"));

    // Release slots one at a time and observe drain order
    sem.release();
    await pMerge;
    expect(order).toEqual(["merge"]);

    sem.release();
    await pExecute;
    expect(order).toEqual(["merge", "execute"]);

    sem.release();
    await pSpecify;
    expect(order).toEqual(["merge", "execute", "specify"]);

    sem.release(); // cleanup
    expect(sem.activeCount).toBe(0);
  });

  it("priority: FIFO order is preserved among equal-priority waiters", async () => {
    const sem = new AgentSemaphore(1);
    await sem.acquire(); // fill the slot

    const order: number[] = [];

    const p1 = sem.acquire(PRIORITY_EXECUTE).then(() => order.push(1));
    const p2 = sem.acquire(PRIORITY_EXECUTE).then(() => order.push(2));
    const p3 = sem.acquire(PRIORITY_EXECUTE).then(() => order.push(3));

    sem.release();
    await p1;
    sem.release();
    await p2;
    sem.release();
    await p3;

    expect(order).toEqual([1, 2, 3]);
    sem.release();
  });

  it("priority: run() forwards priority to acquire()", async () => {
    const sem = new AgentSemaphore(1);
    await sem.acquire(); // fill the slot

    const order: string[] = [];

    const pLow = sem.run(async () => { order.push("low"); }, PRIORITY_SPECIFY);
    const pHigh = sem.run(async () => { order.push("high"); }, PRIORITY_MERGE);

    // Release — high priority should go first, then its run() releases the
    // slot automatically, allowing the low-priority waiter to proceed.
    sem.release();
    await pHigh;
    await pLow;
    expect(order).toEqual(["high", "low"]);
    expect(sem.activeCount).toBe(0);
  });

  it("priority: mixed-priority integration — 1 slot, arbitrary enqueue order, correct drain", async () => {
    const sem = new AgentSemaphore(1);
    await sem.acquire(); // hold the single slot

    const order: string[] = [];

    // Enqueue in a scrambled order: execute, specify, merge, specify, execute, merge
    const promises = [
      sem.acquire(PRIORITY_EXECUTE).then(() => { order.push("execute-1"); }),
      sem.acquire(PRIORITY_SPECIFY).then(() => { order.push("specify-1"); }),
      sem.acquire(PRIORITY_MERGE).then(() => { order.push("merge-1"); }),
      sem.acquire(PRIORITY_SPECIFY).then(() => { order.push("specify-2"); }),
      sem.acquire(PRIORITY_EXECUTE).then(() => { order.push("execute-2"); }),
      sem.acquire(PRIORITY_MERGE).then(() => { order.push("merge-2"); }),
    ];

    // Expected drain order:
    // merge-1, merge-2 (highest, FIFO within),
    // execute-1, execute-2 (middle, FIFO within),
    // specify-1, specify-2 (lowest, FIFO within)
    for (let i = 0; i < 6; i++) {
      sem.release();
      // Wait for the next promise to settle
      await Promise.resolve();
      await Promise.resolve();
    }

    await Promise.all(promises);

    expect(order).toEqual([
      "merge-1", "merge-2",
      "execute-1", "execute-2",
      "specify-1", "specify-2",
    ]);

    sem.release(); // cleanup
    expect(sem.activeCount).toBe(0);
  });

  it("priority constants have correct values", () => {
    expect(PRIORITY_MERGE).toBe(2);
    expect(PRIORITY_EXECUTE).toBe(1);
    expect(PRIORITY_SPECIFY).toBe(0);
    expect(PRIORITY_MERGE).toBeGreaterThan(PRIORITY_EXECUTE);
    expect(PRIORITY_EXECUTE).toBeGreaterThan(PRIORITY_SPECIFY);
  });

  it("priority: default priority (no argument) behaves as PRIORITY_SPECIFY (0)", async () => {
    const sem = new AgentSemaphore(1);
    await sem.acquire(); // fill the slot

    const order: string[] = [];

    // acquire() with no priority arg — should be treated as 0
    const pDefault = sem.acquire().then(() => order.push("default"));
    const pMerge = sem.acquire(PRIORITY_MERGE).then(() => order.push("merge"));

    sem.release();
    await pMerge;
    expect(order).toEqual(["merge"]);

    sem.release();
    await pDefault;
    expect(order).toEqual(["merge", "default"]);

    sem.release();
  });
});

// ─── Semaphore Resilience Tests (FN-978) ─────────────────────────────────────
describe("AgentSemaphore resilience (FN-978)", () => {
  it("defaults to limit=1 when getter returns undefined", () => {
    const sem = new AgentSemaphore(() => undefined as any);
    // Should use minimum limit of 1
    expect(sem.limit).toBe(1);
    // availableCount returns 0 for invalid limits (defensive)
    expect(sem.availableCount).toBe(0);
  });

  it("defaults to limit=1 when getter returns 0", () => {
    const sem = new AgentSemaphore(0);
    expect(sem.limit).toBe(1);
    expect(sem.availableCount).toBe(0);
  });

  it("defaults to limit=1 when getter returns negative", () => {
    const sem = new AgentSemaphore(-1);
    expect(sem.limit).toBe(1);
    expect(sem.availableCount).toBe(0);
  });

  it("defaults to limit=1 when getter returns NaN", () => {
    const sem = new AgentSemaphore(() => NaN);
    expect(sem.limit).toBe(1);
    expect(sem.availableCount).toBe(0);
  });

  it("allows acquire even when limit getter returns undefined", async () => {
    const sem = new AgentSemaphore(() => undefined as any);
    // Should not block indefinitely
    await sem.acquire();
    expect(sem.activeCount).toBe(1);
    sem.release();
    expect(sem.activeCount).toBe(0);
  });

  it("drains waiters correctly when limit changes from invalid to valid", async () => {
    let limit = 0;
    const sem = new AgentSemaphore(() => limit);

    // With limit=0, availableCount should be 0 (raw limit is invalid)
    expect(sem.limit).toBe(1); // guarded getter returns min 1
    expect(sem.availableCount).toBe(0); // raw limit is 0, so 0

    // But acquire uses the guarded limit (1), so it should work
    await sem.acquire();
    expect(sem.activeCount).toBe(1);
    sem.release();
    expect(sem.activeCount).toBe(0);
  });

  it("handles limit changing dynamically", async () => {
    let limit = 2;
    const sem = new AgentSemaphore(() => limit);

    // Acquire 2 slots
    await sem.acquire();
    await sem.acquire();
    expect(sem.activeCount).toBe(2);

    // Reduce limit to 1
    limit = 1;
    // Available should be 0 (1-2, clamped to 0)
    expect(sem.availableCount).toBe(0);

    // Release one — active goes from 2 to 1, drain checks limit=1, active=1 → no more drain
    sem.release();
    expect(sem.activeCount).toBe(1);

    // Release the second one
    sem.release();
    expect(sem.activeCount).toBe(0);
  });
});
