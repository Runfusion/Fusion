import { describe, it, expect, vi } from "vitest";
import { AgentSemaphore, PRIORITY_MERGE, PRIORITY_EXECUTE, PRIORITY_SPECIFY } from "./concurrency.js";

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
