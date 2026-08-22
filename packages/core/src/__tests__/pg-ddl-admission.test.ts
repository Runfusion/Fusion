import { describe, expect, it, vi } from "vitest";
import {
  createPgDdlAdmissionGate,
  type PgDdlAdmissionSession,
} from "../__test-utils__/pg-ddl-admission.js";

class CountedSession implements PgDdlAdmissionSession {
  readonly counts = new Map<number, number>();
  async tryLock(slot: number): Promise<boolean> {
    this.counts.set(slot, (this.counts.get(slot) ?? 0) + 1);
    return true; // PostgreSQL grants a repeated same-session advisory lock.
  }
  async unlock(slot: number): Promise<boolean> {
    const count = this.counts.get(slot) ?? 0;
    if (!count) return false;
    if (count === 1) this.counts.delete(slot);
    else this.counts.set(slot, count - 1);
    return true;
  }
  async close(): Promise<void> {}
}

const defer = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
};

/**
 * FNXC:PgTestDdlAdmission 2026-08-16-21:23:
 * Model distinct fork sessions because only PostgreSQL's server-side advisory
 * locks, rather than a process-local ledger, prove the cross-fork K-slot bound.
 */
class SharedAdvisoryLockCluster {
  private readonly locks = new Map<number, { owner: number; count: number }>();

  createSession(owner: number): PgDdlAdmissionSession {
    return {
      tryLock: async (slot) => {
        const held = this.locks.get(slot);
        if (held && held.owner !== owner) return false;
        this.locks.set(slot, { owner, count: (held?.count ?? 0) + 1 });
        return true;
      },
      unlock: async (slot) => {
        const held = this.locks.get(slot);
        if (!held || held.owner !== owner) return false;
        if (held.count === 1) this.locks.delete(slot);
        else this.locks.set(slot, { ...held, count: held.count - 1 });
        return true;
      },
      close: async () => {
        for (const [slot, held] of this.locks) {
          if (held.owner === owner) this.locks.delete(slot);
        }
      },
    };
  }
}

describe("pg DDL admission", () => {
  it("models PostgreSQL counted same-session locks", async () => {
    const session = new CountedSession();
    expect(await session.tryLock(0)).toBe(true);
    expect(await session.tryLock(0)).toBe(true);
    expect(await session.unlock(0)).toBe(true);
    expect(session.counts.get(0)).toBe(1);
    await session.unlock(0);
    expect(session.counts.has(0)).toBe(false);
  });

  it("bounds a 20-region cross-fork burst to the server slot count", async () => {
    const cluster = new SharedAdvisoryLockCluster();
    const gates = Array.from({ length: 4 }, (_, owner) => createPgDdlAdmissionGate({
      available: () => true,
      createSession: async () => cluster.createSession(owner),
      maxConcurrency: 4,
      acquireTimeoutMs: 500,
      random: () => 0,
    }));
    const entered = defer<void>();
    const release = defer<void>();
    let current = 0;
    let maximum = 0;
    const jobs = Array.from({ length: 20 }, (_, index) => gates[index % gates.length]!.run(async () => {
      current += 1;
      maximum = Math.max(maximum, current);
      if (maximum === 4) entered.resolve();
      await release.promise;
      current -= 1;
    }));
    await entered.promise;
    expect(maximum).toBe(4);
    expect(gates.every((gate) => gate.observe().observedMaxAdmittedConcurrency <= 4)).toBe(true);
    release.resolve();
    await Promise.all(jobs);
    expect(gates.flatMap((gate) => gate.observe().ledger)).toEqual([]);
  });

  it("never double-books an in-process slot and releases every owner", async () => {
    const session = new CountedSession();
    const gate = createPgDdlAdmissionGate({
      available: () => true,
      createSession: async () => session,
      maxConcurrency: 2,
      acquireTimeoutMs: 500,
      random: () => 0,
    });
    const started = defer<void>();
    const release = defer<void>();
    let entered = 0;
    const jobs = Array.from({ length: 6 }, () => gate.run(async () => {
      entered += 1;
      if (entered === 2) started.resolve();
      await release.promise;
    }));
    await started.promise;
    expect(gate.observe().ledger).toEqual([0, 1]);
    expect(gate.observe().observedMaxAdmittedConcurrency).toBe(2);
    expect([...session.counts.values()]).toEqual([1, 1]);
    release.resolve();
    await Promise.all(jobs);
    expect(gate.observe().ledger).toEqual([]);
    expect(session.counts.size).toBe(0);
  });

  it("rejects sequential and spawned reentrant regions instead of sharing one slot", async () => {
    const session = new CountedSession();
    const gate = createPgDdlAdmissionGate({
      available: () => true,
      createSession: async () => session,
      maxConcurrency: 1,
      acquireTimeoutMs: 100,
      random: () => 0,
    });
    let childCallbacks = 0;

    await gate.run(async () => {
      await expect(gate.run(async () => { childCallbacks += 1; })).rejects.toThrow(
        "pg DDL admission regions cannot be nested",
      );

      const spawned = Array.from({ length: 4 }, () => gate.run(async () => {
        childCallbacks += 1;
      }));
      await expect(Promise.all(spawned)).rejects.toThrow(
        "pg DDL admission regions cannot be nested",
      );
      expect(gate.observe().admittedDepth).toBe(1);
      expect(gate.observe().observedMaxAdmittedConcurrency).toBe(1);
    });

    expect(childCallbacks).toBe(0);
    expect(gate.observe().ledger).toEqual([]);
    expect(session.counts.size).toBe(0);
  });

  it("releases its own slot after mixed success, rejection, and admission timeout", async () => {
    const session = new CountedSession();
    const gate = createPgDdlAdmissionGate({
      available: () => true,
      createSession: async () => session,
      maxConcurrency: 2,
      acquireTimeoutMs: 20,
      random: () => 0,
    });
    await Promise.all(Array.from({ length: 100 }, async (_, index) => {
      if (index % 3 === 0) {
        await expect(gate.run(async () => { throw new Error("expected"); })).rejects.toThrow("expected");
      } else {
        await gate.run(async () => {});
      }
    }));
    expect(gate.observe().ledger).toEqual([]);
    expect(session.counts.size).toBe(0);

    const timeoutGate = createPgDdlAdmissionGate({
      available: () => true,
      createSession: async () => new CountedSession(),
      maxConcurrency: 1,
      acquireTimeoutMs: 20,
      random: () => 0,
    });
    const held = defer<void>();
    const owner = timeoutGate.run(async () => { await held.promise; });
    while (timeoutGate.observe().ledger.length !== 1) await new Promise((resolve) => setTimeout(resolve, 1));
    await timeoutGate.run(async () => {});
    expect(timeoutGate.observe().degradedCount["acquire-timeout"]).toBe(1);
    expect(timeoutGate.observe().ledger).toEqual([0]);
    held.resolve();
    await owner;
    expect(timeoutGate.observe().ledger).toEqual([]);
  });

  it("reclassifies a lost admission session and clears every local slot", async () => {
    class LostSession extends CountedSession {
      failUnlock = false;
      override async unlock(slot: number): Promise<boolean> {
        if (this.failUnlock) throw new Error("connection lost");
        return super.unlock(slot);
      }
    }
    const first = new LostSession();
    const replacement = new CountedSession();
    let calls = 0;
    const gate = createPgDdlAdmissionGate({
      available: () => true,
      createSession: async () => (++calls === 1 ? first : replacement),
      maxConcurrency: 2,
      random: () => 0,
    });
    await gate.run(async () => { first.failUnlock = true; });
    expect(gate.observe().degradedCount["session-lost"]).toBe(1);
    expect(gate.observe().admittedDepth).toBe(0);
    expect(gate.observe().ledger).toEqual([]);
    await gate.run(async () => {});
    expect(gate.observe().sessionCount).toBe(2);
    expect(gate.observe().reconnectCount).toBe(1);
  });

  it("does not claim a slot while waiting for outer work or double-count degraded nesting", async () => {
    const session = new CountedSession();
    const gate = createPgDdlAdmissionGate({ available: () => true, createSession: async () => session });
    const outerLock = defer<void>();
    const pending = (async () => {
      await outerLock.promise;
      await gate.run(async () => {});
    })();
    expect(gate.observe().admittedDepth).toBe(0);
    expect(gate.observe().ledger).toEqual([]);
    outerLock.resolve();
    await pending;

    const degraded = createPgDdlAdmissionGate({
      available: () => true,
      createSession: async () => { throw new Error("offline"); },
      warn: vi.fn(),
    });
    await degraded.run(async () => {});
    expect(degraded.observe().degradedCount["connect-failed"]).toBe(1);
    expect(degraded.observe().ledger).toEqual([]);
  });

  it("counts and warns on acquisition failures but executes fail-open work", async () => {
    const warn = vi.fn();
    const gate = createPgDdlAdmissionGate({
      available: () => true,
      createSession: async () => { throw new Error("offline"); },
      warn,
      acquireTimeoutMs: 20,
    });
    const result = await gate.run(async () => "executed");
    expect(result).toBe("executed");
    expect(gate.observe().degradedCount["connect-failed"]).toBe(1);
    expect(gate.observe().admittedDepth).toBe(0);
    expect(gate.observe().ledger).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("waits locally when every ledger index is claimed", async () => {
    const session = new CountedSession();
    const tryLock = vi.spyOn(session, "tryLock");
    const gate = createPgDdlAdmissionGate({
      available: () => true,
      createSession: async () => session,
      maxConcurrency: 1,
      acquireTimeoutMs: 100,
      random: () => 0,
    });
    const held = defer<void>();
    const owner = gate.run(async () => { await held.promise; });
    while (gate.observe().ledger.length !== 1) await new Promise((resolve) => setTimeout(resolve, 1));
    const waiter = gate.run(async () => {});
    await new Promise((resolve) => setTimeout(resolve, 20));
    /*
     * FNXC:PgTestDdlAdmission 2026-08-16-21:29:
     * A full ledger has already proved no local candidate exists; polling the
     * single maintenance session would only serialize sibling waiters.
     */
    expect(tryLock).toHaveBeenCalledTimes(1);
    held.resolve();
    await Promise.all([owner, waiter]);
    expect(gate.observe().ledger).toEqual([]);
  });

  it("is inert when PostgreSQL is unavailable", async () => {
    const createSession = vi.fn(async () => new CountedSession());
    const gate = createPgDdlAdmissionGate({ available: () => false, createSession });
    await gate.run(async () => {});
    expect(createSession).not.toHaveBeenCalled();
    expect(gate.observe().ledger).toEqual([]);
    expect(Object.values(gate.observe().degradedCount)).toEqual([0, 0, 0, 0]);
  });
});
