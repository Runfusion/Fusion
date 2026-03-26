import { describe, it, expect, vi } from "vitest";
import { AgentSemaphore } from "./concurrency.js";

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
});
