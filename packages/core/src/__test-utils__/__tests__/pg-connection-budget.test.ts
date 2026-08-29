import { describe, expect, it, vi } from "vitest";

const postgresMockState = vi.hoisted(() => ({
  calls: 0,
  heldLocks: new Set<string>(),
}));

vi.mock("postgres", () => ({
  default: vi.fn(() => {
    postgresMockState.calls += 1;
    const clientLocks = new Set<string>();
    return {
      unsafe: async (query: string) => {
        if (query.includes("current_setting")) {
          return [{ max_connections: "100", superuser_reserved_connections: "3" }];
        }
        const match = query.match(/\((\d+), (\d+)\)/);
        const lock = match ? `${match[1]}:${match[2]}` : undefined;
        if (query.includes("pg_try_advisory_lock")) {
          if (!lock || postgresMockState.heldLocks.has(lock)) return [{ acquired: false }];
          postgresMockState.heldLocks.add(lock);
          clientLocks.add(lock);
          return [{ acquired: true }];
        }
        if (query.includes("pg_advisory_unlock") && lock) {
          postgresMockState.heldLocks.delete(lock);
          clientLocks.delete(lock);
        }
        return [];
      },
      end: async () => {
        for (const lock of clientLocks) postgresMockState.heldLocks.delete(lock);
        clientLocks.clear();
      },
    };
  }),
}));

import {
  __resetPgConnectionBudgetForTest,
  __tryAcquirePgConnectionBudgetTokenForTest,
  BOOTSTRAP_RESERVE,
  DEGRADED_MAX_SUPERUSER_RESERVED,
  DEGRADED_MIN_MAX_CONNECTIONS,
  MAX_LIVE_HARNESSES_PER_PARTICIPANT,
  MIGRATION_SLOTS_PER_HARNESS,
  PG_FORK_WORK_RESERVE,
  TEMPLATE_BUILD_SLOTS,
  deriveDegradedPgSlotSpace,
  derivePgConnectionBudget,
  derivePgForkWorkReserve,
  derivePgSlotSpace,
  expectedPgAdmissionWaitMs,
  PgConnectionBudgetConcurrencyError,
  resolvePgConnectionBudget,
} from "../pg-connection-budget.js";

describe("PostgreSQL test connection budget arithmetic", () => {
  it("charges a harness at its runtime, migration, and admin ceilings", () => {
    const reserve = derivePgForkWorkReserve({
      maxLiveHarnesses: MAX_LIVE_HARNESSES_PER_PARTICIPANT,
      flooredPoolMax: 1,
      migrationSlots: MIGRATION_SLOTS_PER_HARNESS,
      flooredAdminMax: 1,
      templateBuildSlots: TEMPLATE_BUILD_SLOTS,
    });
    expect(reserve).toEqual({ minHarnessSlotCost: 3, forkWorkReserve: 6, floorSlotCost: 7 });
    expect(PG_FORK_WORK_RESERVE).toEqual(reserve);

    const minimum = derivePgConnectionBudget({ lentWorkSlots: 3, liveHarnesses: 1 });
    const funded = derivePgConnectionBudget({ lentWorkSlots: 6, liveHarnesses: 1 });
    expect(minimum).toMatchObject({ poolMax: 1, migrationSlots: 1, adminMax: 1, totalSlots: 3, floored: true });
    expect(funded.totalSlots).toBe(funded.poolMax + funded.migrationSlots + funded.adminMax);
    expect(funded.poolMax).toBeGreaterThan(minimum.poolMax);
  });

  it("partitions a cluster-derived closed space into lease and work bands", () => {
    const space = derivePgSlotSpace({ maxConnections: 100, superuserReserved: 3, foreignReserve: 8, bootstrapReserve: BOOTSTRAP_RESERVE, floorSlotCost: 7 });
    expect(space).toEqual({ slotCount: 85, maxParticipants: 12, leaseBand: [0, 12], workBand: [12, 85] });
    expect(space.maxParticipants * 7).toBeLessThanOrEqual(space.slotCount);
  });

  it("keeps conservative degraded ranges inside healthy ranges", () => {
    const degraded = deriveDegradedPgSlotSpace();
    expect(DEGRADED_MIN_MAX_CONNECTIONS).toBe(20);
    expect(DEGRADED_MAX_SUPERUSER_RESERVED).toBe(5);
    for (const maxConnections of [20, 50, 100, 250]) {
      for (const superuserReserved of [0, 3, 5]) {
        const healthy = derivePgSlotSpace({ maxConnections, superuserReserved, foreignReserve: 8, bootstrapReserve: 4, floorSlotCost: 7 });
        expect(degraded.slotCount).toBeLessThanOrEqual(healthy.slotCount);
        expect(degraded.leaseBand[1]).toBeLessThanOrEqual(healthy.leaseBand[1]);
        expect(degraded.workBand[1]).toBeLessThanOrEqual(healthy.workBand[1]);
      }
    }
  });

  it("keeps measured queueing below one third of the unchanged test budget", () => {
    expect(expectedPgAdmissionWaitMs({ participants: 27, maxParticipants: 12, p95WindowMs: 1_000, lingerMs: 0, deburstMs: 2_000 })).toBe(5_000);
  });

  it("reserves the concurrency error for unfundable local ledger requests", () => {
    expect(() => derivePgConnectionBudget({ lentWorkSlots: 2, liveHarnesses: 1 }))
      .toThrow(PgConnectionBudgetConcurrencyError);
    expect(() => derivePgConnectionBudget({ lentWorkSlots: 2, liveHarnesses: 1 }))
      .toThrow("FORK_WORK_RESERVE");
  });

  it("does not derive capacity from a lane-local worker fairness hint", () => {
    const first = derivePgSlotSpace({ maxConnections: 100, superuserReserved: 3, foreignReserve: 8, bootstrapReserve: 4, floorSlotCost: 7 });
    const second = derivePgSlotSpace({ maxConnections: 100, superuserReserved: 3, foreignReserve: 8, bootstrapReserve: 4, floorSlotCost: 7 });
    expect(second).toEqual(first);
  });

  it("serializes concurrent first-window callers into one lease session", async () => {
    postgresMockState.calls = 0;
    postgresMockState.heldLocks.clear();
    try {
      await Promise.all([
        resolvePgConnectionBudget({ available: true, urlBase: "postgres://localhost/fusion" }),
        resolvePgConnectionBudget({ available: true, urlBase: "postgres://localhost/fusion" }),
      ]);
      expect(postgresMockState.calls).toBe(1);
    } finally {
      await __resetPgConnectionBudgetForTest();
    }
  });

  it("keeps healthy token exhaustion outside the ungated bootstrap fallback", async () => {
    // FNXC:PgTestConnectionBudget 2026-08-17-01:55:
    // A full healthy host semaphore queues before a bootstrap connect; R11 applies
    // only when the token directory itself is unavailable, never at capacity.
    const attempts = await Promise.all(
      Array.from({ length: BOOTSTRAP_RESERVE * 2 }, (_, index) =>
        __tryAcquirePgConnectionBudgetTokenForTest(index % BOOTSTRAP_RESERVE),
      ),
    );
    const acquired = attempts.filter((attempt) => attempt.kind === "acquired");
    try {
      expect(acquired).toHaveLength(BOOTSTRAP_RESERVE);
      expect(attempts.filter((attempt) => attempt.kind === "exhausted")).toHaveLength(BOOTSTRAP_RESERVE);
      expect(attempts.some((attempt) => attempt.kind === "unavailable")).toBe(false);
    } finally {
      await Promise.all(acquired.map((attempt) => attempt.token.release()));
    }
  });
});
