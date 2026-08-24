import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskStore } from "../store.js";
import { CORE_RUN_AUDIT_EMIT_TIMEOUT_MS } from "../run-audit/emit-bounded-run-audit.js";

const audit = vi.hoisted(() => ({ sink: undefined as undefined | (() => unknown) }));
const mocks = vi.hoisted(() => ({
  register: vi.fn(), active: vi.fn(), acquire: vi.fn(), readCursor: vi.fn(), bounds: vi.fn(), list: vi.fn(),
  receipt: vi.fn(), acknowledge: vi.fn(), advance: vi.fn(), renew: vi.fn(), retry: vi.fn(), park: vi.fn(), release: vi.fn(),
}));

vi.mock("../postgres/data-layer.js", () => ({ recordRunAuditEvent: vi.fn(() => audit.sink?.()) }));
vi.mock("../task-store/task-lifecycle-consumer-registry.js", () => ({
  registerTaskLifecycleConsumer: mocks.register, setTaskLifecycleConsumerActive: mocks.active,
  acquireTaskLifecycleLease: mocks.acquire, readTaskLifecycleConsumerCursor: mocks.readCursor,
  readTaskLifecycleEventBounds: mocks.bounds, listTaskLifecycleEvents: mocks.list,
  hasTaskLifecycleConsumerReceipt: mocks.receipt, acknowledgeTaskLifecycleEvent: mocks.acknowledge,
  advanceTaskLifecycleConsumerCursor: mocks.advance, renewTaskLifecycleLease: mocks.renew,
  setTaskLifecycleConsumerRetry: mocks.retry, parkTaskLifecycleConsumerDeadLetter: mocks.park,
  releaseTaskLifecycleLease: mocks.release,
}));

import { TaskDeletedOutboxConsumer } from "../task-store/task-deleted-outbox-consumer.js";

type SinkMode = "absent" | "throw" | "reject" | "never" | "late";
const cursor = (lastAckedSeq = 0n) => ({ lastAckedSeq, retryAttempts: 0, retryBackoffUntil: null, updatedAt: new Date().toISOString() });
const event = { eventId: "event-1", seq: 1n, eventType: "task:deleted", taskId: "FN-9180", occurredAt: "2026-08-20T00:00:00.000Z", payload: { taskId: "FN-9180", previousColumn: "done", previousStatus: null, deletedAt: "2026-08-20T00:00:00.000Z", allowResurrection: false, githubIssueAction: null, closureContext: null, deletedBy: null } };

function configure(mode: SinkMode): () => void {
  let settle: (() => void) | undefined;
  audit.sink = mode === "absent" ? undefined : () => {
    if (mode === "throw") throw new Error("hostile audit");
    if (mode === "reject") return Promise.reject(new Error("hostile audit"));
    if (mode === "never") return new Promise(() => undefined);
    if (mode === "late") return new Promise<void>((resolve) => { settle = resolve; });
  };
  return () => settle?.();
}

async function settle<T>(promise: Promise<T>, mode: SinkMode, late: () => void): Promise<T> {
  // Lease fencing can be followed by the batch catch-up row; advance enough bounded windows for
  // both awaited class-A emits while keeping the production timeout itself unchanged.
  if (mode === "never" || mode === "late") await vi.advanceTimersByTimeAsync(CORE_RUN_AUDIT_EMIT_TIMEOUT_MS * 3);
  late();
  return await promise;
}

function makeConsumer(hasCachedTask = true) {
  const store = { asyncLayer: { projectId: "project-9180", db: { select: vi.fn() } }, consumerId: "consumer-9180", taskCache: hasCachedTask ? new Map([["FN-9180", { id: "FN-9180" }]]) : new Map(), emitObservedTaskDeleted: vi.fn() } as unknown as TaskStore;
  const consumer = new TaskDeletedOutboxConsumer(store);
  (consumer as unknown as { running: boolean }).running = true;
  return consumer;
}

beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks();
  mocks.register.mockResolvedValue(undefined); mocks.active.mockResolvedValue(undefined);
  mocks.acquire.mockResolvedValue({ token: "lease", fencingToken: 1n, expiresAt: "2026-08-20T00:01:00.000Z" });
  mocks.readCursor.mockResolvedValue(cursor()); mocks.bounds.mockResolvedValue({ oldestSeq: null, oldestOccurredAt: null, headSeq: 1n });
  mocks.list.mockResolvedValue([]); mocks.receipt.mockResolvedValue(false); mocks.acknowledge.mockResolvedValue(true);
  mocks.release.mockResolvedValue(undefined); mocks.renew.mockResolvedValue(true); mocks.advance.mockResolvedValue(true);
});
afterEach(() => { audit.sink = undefined; vi.useRealTimers(); });

/*
FNXC:RunAudit 2026-08-20-06:50:
FN-9180 drives the real outbox poll through every class-A audit branch. A bounded awaited emit must
preserve post-cursor ordering while hostile telemetry cannot change delivery's active/idle result.
*/
describe("TaskDeletedOutboxConsumer bounded audit health", () => {
  it.each(["absent", "throw", "reject", "never", "late"] as const)("keeps catch-up delivery active for a %s audit sink", async (mode) => {
    const late = configure(mode); mocks.list.mockResolvedValue([event]);
    const consumer = makeConsumer();
    await expect(settle(consumer.poll(), mode, late)).resolves.toBe("active");
    expect(mocks.active.mock.invocationCallOrder[0]).toBeGreaterThan(0);
  });

  it.each(["absent", "throw", "reject", "never", "late"] as const)("keeps reconciliation delivery idle for a %s audit sink after cursor advance", async (mode) => {
    for (const hasCachedTask of [false, true]) {
      const late = configure(mode); mocks.readCursor.mockResolvedValue(cursor(0n)); mocks.bounds.mockResolvedValue({ oldestSeq: 2n, oldestOccurredAt: null, headSeq: 4n });
      const consumer = makeConsumer(hasCachedTask);
      const layer = (consumer as unknown as { store: TaskStore }).store.asyncLayer! as unknown as { db: { select: ReturnType<typeof vi.fn> } };
      layer.db.select.mockReturnValue({ from: () => ({ where: async () => [] }) });
      await expect(settle(consumer.poll(), mode, late)).resolves.toBe("idle");
      expect(mocks.advance).toHaveBeenCalledTimes(hasCachedTask ? 2 : 1);
    }
  });

  it.each(["absent", "throw", "reject", "never", "late"] as const)("keeps lease-fenced delivery active for a %s audit sink", async (mode) => {
    const late = configure(mode); mocks.list.mockResolvedValue([event]); mocks.acknowledge.mockResolvedValue(false);
    const consumer = makeConsumer();
    await expect(settle(consumer.poll(), mode, late)).resolves.toBe("active");
    expect(mocks.readCursor).toHaveBeenCalledTimes(3);
  });

  it("keeps audit attempts after cursor advance and before consumer activation", async () => {
    const order: string[] = [];
    audit.sink = () => { order.push("audit"); };
    mocks.active.mockImplementation(async () => { order.push("active"); });
    mocks.advance.mockImplementation(async () => { order.push("advance"); return true; });
    mocks.readCursor.mockResolvedValue(cursor(0n)); mocks.bounds.mockResolvedValue({ oldestSeq: 2n, oldestOccurredAt: null, headSeq: 4n });
    const reconciliationConsumer = makeConsumer();
    const layer = (reconciliationConsumer as unknown as { store: TaskStore }).store.asyncLayer! as unknown as { db: { select: ReturnType<typeof vi.fn> } };
    layer.db.select.mockReturnValue({ from: () => ({ where: async () => [] }) });
    await expect(reconciliationConsumer.poll()).resolves.toBe("idle");
    expect(order).toEqual(["advance", "audit", "active"]);

    order.length = 0; mocks.bounds.mockResolvedValue({ oldestSeq: null, oldestOccurredAt: null, headSeq: 1n }); mocks.readCursor.mockResolvedValue(cursor()); mocks.list.mockResolvedValue([event]);
    await expect(makeConsumer().poll()).resolves.toBe("active");
    expect(order).toEqual(["audit", "active"]);
  });

  it("does not emit catch-up telemetry for an empty batch", async () => {
    const sink = vi.fn(); audit.sink = sink;
    await expect(makeConsumer().poll()).resolves.toBe("idle");
    expect(sink).not.toHaveBeenCalled();
  });
});
