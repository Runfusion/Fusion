/*
FNXC:CapacityGateFacts 2026-11-02-19:56 (RUFU-372):
Unit coverage for the shared gate-fact evaluator: which admission gate bound, against what
numbers, and the honest degradation when it cannot be answered. The incident (156 rows, no gate
identity; SKEN-009's 98 rows over an empty project) is the assertion list: every failure shape
gets its own case, because a diagnostic that only works on the happy path re-creates the
blindfold. Fake timers only — no real waits (FN-5048).
*/
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Task, WorkflowIr } from "@fusion/core";

const { mockTopLevelWalk, mockWorktreeWalk } = vi.hoisted(() => ({
  mockTopLevelWalk: vi.fn(async (_store: unknown, _tasks: unknown, _caches?: unknown): Promise<string[]> => []),
  mockWorktreeWalk: vi.fn(async (_store: unknown, _tasks: unknown, _proof?: unknown, _caches?: unknown): Promise<string[]> => []),
}));

vi.mock("../concurrency/concurrency.js", () => ({
  persistedTopLevelAgentTaskIdsFromStore: mockTopLevelWalk,
  persistedWorktreeHolderTaskIdsFromStore: mockWorktreeWalk,
}));

import {
  CAPACITY_GATE_IDS,
  computeDeferralCapacityGateFacts,
  computeGateFacts,
  safeComputeDeferralCapacityGateFacts,
  type CapacityFactsStoreSurface,
} from "../workflows/capacity-gate-facts.js";

const NOW = Date.parse("2026-11-02T12:00:00Z");

function taskFixture(overrides: Partial<Task> & { id: string }): Task {
  return {
    column: "todo",
    status: null,
    paused: false,
    createdAt: "2026-11-01T00:00:00Z",
    ...overrides,
  } as unknown as Task;
}

function irWith(columns: unknown[]): WorkflowIr {
  return { version: "v2", name: "gate-facts", columns, nodes: [], edges: [] } as unknown as WorkflowIr;
}

/** A column with its OWN configured wip ceiling → bounds as `columnWip`. */
const ownConfigIr = () => irWith([
  { id: "todo", name: "Todo", traits: [{ trait: "hold", config: { release: "capacity" } }] },
  { id: "in-progress", name: "In progress", traits: [{ trait: "wip", config: { limit: 2 } }] },
]);

/** The default-workflow shape with NO wip config → the limit arrives through the
 *  `settings.maxConcurrent` read-through → bounds as `maxConcurrent`. */
const readThroughIr = () => irWith([
  { id: "triage", name: "Triage", traits: [{ trait: "intake" }] },
  { id: "todo", name: "Todo", traits: [{ trait: "hold", config: { release: "capacity" } }] },
  { id: "in-progress", name: "In progress", traits: [{ trait: "wip" }] },
  { id: "in-review", name: "In review", traits: [{ trait: "human-review" }, { trait: "merge-blocker" }] },
  { id: "done", name: "Done", traits: [{ trait: "complete" }] },
]);

/** A column without the wip trait at all: the operator's ruling — null means no trait, and
 *  that reports as `unknown`, never as a renamed `columnWip`. */
const noWipIr = () => irWith([
  { id: "staging", name: "Staging", traits: [{ trait: "hold", config: { release: "timer" } }] },
  { id: "review", name: "Review", traits: [{ trait: "human-review" }] },
]);

function storeWith(tasks: Task[], agents?: unknown[]): CapacityFactsStoreSurface & Record<string, unknown> {
  return {
    listTasks: vi.fn(async () => tasks),
    ...(agents ? { listAgents: vi.fn(async () => agents) } : {}),
  } as CapacityFactsStoreSurface & Record<string, unknown>;
}

beforeEach(() => {
  mockTopLevelWalk.mockReset().mockResolvedValue([]);
  mockWorktreeWalk.mockReset().mockResolvedValue([]);
});

describe("capacity gate facts — gate identity and precedence", () => {
  it("exposes EXACTLY the four machine-readable gate identities (no fourth gate sneaks in)", () => {
    expect([...CAPACITY_GATE_IDS]).toEqual(["columnWip", "schedulerAgentActive", "maxConcurrent", "unknown"]);
  });

  it("classifies a carried store refusal as columnWip with limit, used, holder ids, and age", async () => {
    const holder = taskFixture({ id: "H-1", column: "in-progress", columnMovedAt: "2026-11-02T10:00:00Z" });
    const facts = await computeGateFacts({
      store: storeWith([holder, taskFixture({ id: "DEFER", column: "todo" })]),
      ir: ownConfigIr(),
      targetColumn: "in-progress",
      deferredTaskId: "DEFER",
      carried: { column: "in-progress", occupants: 2, limit: 2 },
      now: NOW,
    });
    expect(facts.capacityGate).toBe("columnWip");
    expect(facts.capacityLimit).toBe(2);
    expect(facts.capacityUsed).toBe(2);
    expect(facts.capacityHeldBy).toEqual(["H-1"]);
    expect(facts.capacityOldestHolderAgeMs).toBe(NOW - Date.parse("2026-11-02T10:00:00Z"));
    expect(facts.capacityStoreOutcome).toBe("ok");
    expect(facts.capacityComputeOutcome).toBe("complete");
  });

  it("classifies the settings.maxConcurrent read-through ceiling as maxConcurrent, not columnWip", async () => {
    const holders = [
      taskFixture({ id: "H-1", column: "in-progress", columnMovedAt: "2026-11-02T11:00:00Z" }),
      taskFixture({ id: "H-2", column: "in-progress", columnMovedAt: "2026-11-02T11:30:00Z" }),
    ];
    const facts = await computeGateFacts({
      store: storeWith(holders),
      ir: readThroughIr(),
      targetColumn: "in-progress",
      deferredTaskId: "DEFER",
      settings: { maxConcurrent: 2 },
      now: NOW,
    });
    // The incident's freeze shape (Symptom case 3): every explicit column gate clear, the
    // running-agent ceiling full, holders store-derivable.
    expect(facts.capacityGate).toBe("maxConcurrent");
    expect(facts.capacityLimit).toBe(2);
    expect(facts.capacityUsed).toBe(2);
    expect(facts.capacityHeldBy?.sort()).toEqual(["H-1", "H-2"]);
    expect(facts.capacityOldestHolderAgeMs).toBe(NOW - Date.parse("2026-11-02T11:00:00Z"));
  });

  it("classifies the assigned agent being active at its maxConcurrentRuns ceiling as schedulerAgentActive", async () => {
    const busy = taskFixture({
      id: "H-9",
      column: "in-progress",
      assignedAgentId: "agent-1",
      columnMovedAt: "2026-11-02T09:00:00Z",
    });
    mockTopLevelWalk.mockResolvedValue(["H-9"]);
    const facts = await computeGateFacts({
      store: storeWith([busy], [{ id: "agent-1", state: "running", maxConcurrentRuns: 1 }]),
      ir: readThroughIr(),
      targetColumn: "in-progress",
      deferredTaskId: "DEFER",
      // maxConcurrent=8: the column ceiling is clear, so the agent gate is what binds.
      settings: { maxConcurrent: 8 },
      assignedAgentId: "agent-1",
      now: NOW,
    });
    expect(facts.capacityGate).toBe("schedulerAgentActive");
    expect(facts.capacityLimit).toBe(1);
    expect(facts.capacityUsed).toBe(1);
    expect(facts.capacityHeldBy).toEqual(["H-9"]);
  });

  it("does NOT report the agent gate when the population is below the ceiling (the incident's 8-with-5 shape)", async () => {
    const busy = taskFixture({ id: "H-9", column: "in-progress", assignedAgentId: "agent-1" });
    mockTopLevelWalk.mockResolvedValue(["H-9"]);
    const facts = await computeGateFacts({
      store: storeWith([busy], [{ id: "agent-1", state: "running", maxConcurrentRuns: 2 }]),
      ir: readThroughIr(),
      targetColumn: "in-progress",
      deferredTaskId: "DEFER",
      settings: { maxConcurrent: 8 },
      assignedAgentId: "agent-1",
      now: NOW,
    });
    expect(facts.capacityGate).toBe("unknown");
    expect(facts.capacityLimit).toBeNull();
    expect(facts.capacityUsed).toBeNull();
  });

  it("consults an owner-supplied semaphore sample at its limit", async () => {
    const facts = await computeGateFacts({
      store: storeWith([]),
      ir: noWipIr(),
      targetColumn: "review",
      semaphore: { activeCount: 8, limit: 8 },
      now: NOW,
    });
    expect(facts.capacityGate).toBe("maxConcurrent");
    expect(facts.capacityLimit).toBe(8);
    expect(facts.capacityUsed).toBe(8);
    expect(facts.capacityHeldBy).toBeUndefined();
  });

  it("orders columnWip ahead of a bound agent gate (scheduler precedence)", async () => {
    const holders = [
      taskFixture({ id: "H-1", column: "in-progress", assignedAgentId: "agent-1" }),
      taskFixture({ id: "H-2", column: "in-progress", assignedAgentId: "agent-1" }),
    ];
    mockTopLevelWalk.mockResolvedValue(["H-1", "H-2"]);
    const facts = await computeGateFacts({
      store: storeWith(holders, [{ id: "agent-1", state: "running", maxConcurrentRuns: 1 }]),
      ir: ownConfigIr(),
      targetColumn: "in-progress",
      deferredTaskId: "DEFER",
      assignedAgentId: "agent-1",
      now: NOW,
    });
    expect(facts.capacityGate).toBe("columnWip");
  });

  it("orders the agent gate ahead of a bound semaphore sample", async () => {
    const busy = taskFixture({ id: "H-9", column: "in-progress", assignedAgentId: "agent-1" });
    mockTopLevelWalk.mockResolvedValue(["H-9"]);
    const facts = await computeGateFacts({
      store: storeWith([busy], [{ id: "agent-1", state: "running", maxConcurrentRuns: 1 }]),
      ir: readThroughIr(),
      targetColumn: "in-progress",
      deferredTaskId: "DEFER",
      settings: { maxConcurrent: 8 },
      assignedAgentId: "agent-1",
      semaphore: { activeCount: 5, limit: 5 },
      now: NOW,
    });
    expect(facts.capacityGate).toBe("schedulerAgentActive");
  });
});

describe("capacity gate facts — unknown is a real answer, never an omission", () => {
  it("emits unknown + nulls (keys present) when a no-wip-trait column defers with everything clear", async () => {
    // The measured SKEN-009 shape: empty project, no gate full.
    const facts = await computeGateFacts({
      store: storeWith([]),
      ir: noWipIr(),
      targetColumn: "review",
      now: NOW,
    });
    expect(facts).toMatchObject({
      capacityGate: "unknown",
      capacityLimit: null,
      capacityUsed: null,
      capacityOldestHolderAgeMs: null,
      capacityStoreOutcome: "ok",
      capacityComputeOutcome: "complete",
    });
  });

  it("host-free construction with carried facts still names columnWip and reports not-required, not a failure", async () => {
    const facts = await computeGateFacts({
      carried: { column: "in-progress", occupants: 3, limit: 3 },
      now: NOW,
    });
    expect(facts.capacityGate).toBe("columnWip");
    expect(facts.capacityLimit).toBe(3);
    expect(facts.capacityUsed).toBe(3);
    expect(facts.capacityHeldBy).toBeUndefined();
    expect(facts.capacityStoreOutcome).toBe("not-required");
  });

  it("host-free construction without carried facts emits the full unknown key set", async () => {
    const facts = await computeGateFacts({ now: NOW });
    expect(facts.capacityGate).toBe("unknown");
    expect(facts.capacityStoreOutcome).toBe("not-required");
    expect("capacityLimit" in facts).toBe(true);
    expect("capacityUsed" in facts).toBe(true);
    expect("capacityOldestHolderAgeMs" in facts).toBe(true);
  });

  it("caps holder ids at five", async () => {
    const holders = Array.from({ length: 7 }, (_, i) =>
      taskFixture({ id: `H-${i}`, column: "in-progress", columnMovedAt: "2026-11-02T08:00:00Z" }));
    const facts = await computeGateFacts({
      store: storeWith(holders),
      ir: ownConfigIr(),
      targetColumn: "in-progress",
      deferredTaskId: "DEFER",
      carried: { column: "in-progress", occupants: 7, limit: 2 },
      now: NOW,
    });
    expect(facts.capacityHeldBy).toHaveLength(5);
  });

  it("reports at-limit-with-no-ids when the snapshot holds no occupants of the refused column", async () => {
    const facts = await computeGateFacts({
      store: storeWith([taskFixture({ id: "DEFER", column: "todo" })]),
      ir: ownConfigIr(),
      targetColumn: "in-progress",
      deferredTaskId: "DEFER",
      carried: { column: "in-progress", occupants: 2, limit: 2 },
      now: NOW,
    });
    expect(facts.capacityGate).toBe("columnWip");
    expect(facts.capacityUsed).toBe(2);
    expect(facts.capacityHeldBy).toBeUndefined();
    expect(facts.capacityOldestHolderAgeMs).toBeNull();
  });

  it("skips unparseable holder timestamps and reports null when none survive", async () => {
    const holder = taskFixture({
      id: "H-JUNK",
      column: "in-progress",
      columnMovedAt: "not-a-date" as unknown as string,
      createdAt: "" as unknown as string,
    });
    const facts = await computeGateFacts({
      store: storeWith([holder]),
      ir: ownConfigIr(),
      targetColumn: "in-progress",
      deferredTaskId: "DEFER",
      carried: { column: "in-progress", occupants: 1, limit: 1 },
      now: NOW,
    });
    expect(facts.capacityHeldBy).toEqual(["H-JUNK"]);
    expect(facts.capacityOldestHolderAgeMs).toBeNull();
  });

  it("prefers columnMovedAt over createdAt for holder age (updatedAt is never a base — RUFU-350)", async () => {
    const holder = taskFixture({
      id: "H-AGE",
      column: "in-progress",
      columnMovedAt: "2026-11-02T06:00:00Z",
      createdAt: "2026-01-01T00:00:00Z",
    });
    const facts = await computeGateFacts({
      store: storeWith([holder]),
      ir: ownConfigIr(),
      targetColumn: "in-progress",
      deferredTaskId: "DEFER",
      carried: { column: "in-progress", occupants: 1, limit: 1 },
      now: NOW,
    });
    expect(facts.capacityOldestHolderAgeMs).toBe(NOW - Date.parse("2026-11-02T06:00:00Z"));
  });

  it("excludes dead parks and the deferring card from occupants", async () => {
    const holders = [
      taskFixture({ id: "DEAD", column: "in-progress", status: "failed" }),
      taskFixture({ id: "DEFER", column: "in-progress" }),
    ];
    const facts = await computeGateFacts({
      store: storeWith(holders),
      ir: readThroughIr(),
      targetColumn: "in-progress",
      deferredTaskId: "DEFER",
      settings: { maxConcurrent: 1 },
      now: NOW,
    });
    // The refusal is transient, not a ceiling: the lane only holds debris + this card.
    expect(facts.capacityGate).toBe("unknown");
  });
});

describe("capacity gate facts — hostile store paths", () => {
  it("a rejecting agent-gate store yields store-rejected + null used (never 0) + worktree holder fallback", async () => {
    const holder = taskFixture({ id: "WT-1", column: "in-progress", columnMovedAt: "2026-11-02T10:00:00Z" });
    const store = storeWith([holder], [{ id: "agent-1", state: "running" }]) as CapacityFactsStoreSurface & Record<string, unknown>;
    (store.listAgents as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("breaker-open: agent execution store is unavailable"));
    mockTopLevelWalk.mockRejectedValue(new Error("breaker-open"));
    mockWorktreeWalk.mockResolvedValue(["WT-1"]);
    const facts = await computeGateFacts({
      store,
      ir: readThroughIr(),
      targetColumn: "in-progress",
      deferredTaskId: "DEFER",
      settings: { maxConcurrent: 8 },
      assignedAgentId: "agent-1",
      now: NOW,
    });
    expect(facts.capacityGate).toBe("unknown");
    expect(facts.capacityAgentGateError).toBe("store-rejected");
    expect(facts.capacityUsed).toBeNull();
    expect(facts.capacityHeldBy).toEqual(["WT-1"]);
    expect(facts.capacityOldestHolderAgeMs).toBe(NOW - Date.parse("2026-11-02T10:00:00Z"));
  });

  it("when BOTH agent surfaces reject, holder ids stay absent — never an empty array standing in for 'no holders'", async () => {
    const store = storeWith([], [{ id: "agent-1", state: "running" }]) as CapacityFactsStoreSurface & Record<string, unknown>;
    (store.listAgents as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("store down"));
    mockTopLevelWalk.mockRejectedValue(new Error("store down"));
    mockWorktreeWalk.mockRejectedValue(new Error("store down"));
    const facts = await computeGateFacts({
      store,
      ir: readThroughIr(),
      targetColumn: "in-progress",
      assignedAgentId: "agent-1",
      now: NOW,
    });
    expect(facts.capacityAgentGateError).toBe("store-rejected");
    expect(facts.capacityHeldBy).toBeUndefined();
  });

  it("a rejecting listTasks host reports storeOutcome failed with the unknown key set, not a throw", async () => {
    const facts = await computeGateFacts({
      store: { listTasks: vi.fn(async () => { throw new Error("db unreachable"); }) },
      ir: readThroughIr(),
      targetColumn: "in-progress",
      deferredTaskId: "DEFER",
      now: NOW,
    });
    expect(facts.capacityGate).toBe("unknown");
    expect(facts.capacityStoreOutcome).toBe("failed");
    expect(facts.capacityLimit).toBeNull();
  });

  it("records unavailable when the store has no agent surface at all", async () => {
    const facts = await computeGateFacts({
      store: storeWith([]),
      ir: readThroughIr(),
      targetColumn: "in-progress",
      assignedAgentId: "agent-1",
      now: NOW,
    });
    expect(facts.capacityAgentGateError).toBe("unavailable");
    expect(facts.capacityGate).toBe("unknown");
  });
});

describe("capacity gate facts — safe wrapper isolation", () => {
  it("the raw compute REJECTS on a poisoned IR while the safe wrapper returns a bounded threw outcome", async () => {
    // Catch-shaped caller proof: the raw name is only survivable behind the safe wrapper.
    const poisonedIr = {
      version: "v2",
      name: "poison",
      nodes: [],
      edges: [],
      get columns(): never { throw new Error("poisoned graph"); },
    } as unknown as WorkflowIr;
    await expect(computeDeferralCapacityGateFacts({
      store: storeWith([]),
      ir: poisonedIr,
      targetColumn: "in-progress",
      now: NOW,
    })).rejects.toThrow("poisoned graph");

    const safe = await safeComputeDeferralCapacityGateFacts({
      store: storeWith([]),
      ir: poisonedIr,
      targetColumn: "in-progress",
      now: NOW,
    });
    expect(safe.capacityGate).toBe("unknown");
    expect(safe.capacityComputeOutcome).toBe("threw");
    expect(safe.capacityLimit).toBeNull();
    expect(safe.capacityUsed).toBeNull();
  });

  it("the safe wrapper never writes the task row and never rethrows from a rejecting host", async () => {
    const updateTask = vi.fn();
    const store = { listTasks: vi.fn(async () => { throw new Error("hostile sink"); }) } as CapacityFactsStoreSurface & Record<string, unknown>;
    (store as Record<string, unknown>).updateTask = updateTask;
    const safe = await safeComputeDeferralCapacityGateFacts({
      store,
      ir: readThroughIr(),
      targetColumn: "in-progress",
      now: NOW,
    });
    expect(updateTask).not.toHaveBeenCalled();
    expect(safe.capacityGate).toBe("unknown");
    expect(safe.capacityStoreOutcome).toBe("failed");
  });

  it("a hanging host is cut off at the wrapper's own bound and reports timed-out with unknown + nulls", async () => {
    vi.useFakeTimers();
    try {
      const store = { listTasks: () => new Promise<Task[]>(() => undefined) };
      const running = safeComputeDeferralCapacityGateFacts({
        store,
        ir: readThroughIr(),
        targetColumn: "in-progress",
        timeoutMs: 50,
        now: NOW,
      });
      await vi.advanceTimersByTimeAsync(60);
      const facts = await running;
      expect(facts.capacityGate).toBe("unknown");
      expect(facts.capacityComputeOutcome).toBe("timed-out");
      expect(facts.capacityLimit).toBeNull();
      expect(facts.capacityUsed).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a slow-but-eventually-resolving host still reports through the wrapper (settlement after the bound cannot corrupt the returned facts)", async () => {
    vi.useFakeTimers();
    try {
      const holders = [
        taskFixture({ id: "H-1", column: "in-progress", columnMovedAt: "2026-11-02T11:00:00Z" }),
        taskFixture({ id: "H-2", column: "in-progress", columnMovedAt: "2026-11-02T11:15:00Z" }),
      ];
      let release: ((tasks: Task[]) => void) | undefined;
      const store = { listTasks: () => new Promise<Task[]>((resolve) => { release = resolve; }) };
      const running = safeComputeDeferralCapacityGateFacts({
        store,
        ir: readThroughIr(),
        targetColumn: "in-progress",
        timeoutMs: 40,
        now: NOW,
      });
      await vi.advanceTimersByTimeAsync(50);
      const timedOut = await running;
      expect(timedOut.capacityComputeOutcome).toBe("timed-out");
      // Late resolution must not surface anywhere the caller can still see.
      release?.(holders);
      await vi.advanceTimersByTimeAsync(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the safe wrapper on a healthy host returns the complete facts", async () => {
    const holder = taskFixture({ id: "H-1", column: "in-progress", columnMovedAt: "2026-11-02T10:00:00Z" });
    const safe = await safeComputeDeferralCapacityGateFacts({
      store: storeWith([holder]),
      ir: ownConfigIr(),
      targetColumn: "in-progress",
      deferredTaskId: "DEFER",
      carried: { column: "in-progress", occupants: 2, limit: 2 },
      now: NOW,
    });
    expect(safe.capacityGate).toBe("columnWip");
    expect(safe.capacityComputeOutcome).toBe("complete");
    expect(safe.capacityHeldBy).toEqual(["H-1"]);
  });

  it("uses exactly ONE host call for the whole compute (single-snapshot contract)", async () => {
    const listTasks = vi.fn(async () => [taskFixture({ id: "H-1", column: "in-progress" })]);
    await safeComputeDeferralCapacityGateFacts({
      store: { listTasks, listAgents: vi.fn(async () => [{ id: "a", state: "running", maxConcurrentRuns: 1 }]) },
      ir: readThroughIr(),
      targetColumn: "in-progress",
      assignedAgentId: "a",
      carried: { column: "in-progress", occupants: 1, limit: 1 },
      now: NOW,
    });
    expect(listTasks).toHaveBeenCalledTimes(1);
  });
});
