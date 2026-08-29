import { describe, expect, it, vi } from "vitest";
import {
  decideApprovalRequest,
  markApprovalRequestCompleted,
} from "../async-stores/async-approval-request-store.js";
import type { AsyncDataLayer, DbTransaction } from "../postgres/data-layer.js";
import type { ApprovalRequestStatus } from "../types.js";

const REQUESTER = { actorId: "agent-1", actorType: "agent" as const, actorName: "Requester" };
const DECIDER = { actorId: "user-1", actorType: "user" as const, actorName: "Decider" };
const NOW = "2026-08-16T23:22:00.000Z";

/**
 * Build only the Drizzle chain surface exercised by the real transition helpers.
 * The stale read followed by an empty guarded-update returning result is the
 * production racer's state after another transaction commits between its read
 * and conditional update.
 */
function createRacingLayer(status: ApprovalRequestStatus, updateWins: boolean) {
  const auditInsert = vi.fn(async () => undefined);
  const row = {
    id: "apr-race",
    status,
    requesterActorId: REQUESTER.actorId,
    requesterActorType: REQUESTER.actorType,
    requesterActorName: REQUESTER.actorName,
    targetActionCategory: "other",
    targetActionOperation: "test",
    targetActionSummary: "test",
    targetResourceType: "task",
    targetResourceId: "FN-9138",
    targetContext: {},
    taskId: null,
    runId: null,
    requestedAt: "2026-08-16T23:00:00.000Z",
    decidedAt: status === "approved" ? "2026-08-16T23:01:00.000Z" : null,
    completedAt: null,
    createdAt: "2026-08-16T23:00:00.000Z",
    updatedAt: "2026-08-16T23:00:00.000Z",
  };
  const tx = {
    select: () => ({ from: () => ({ where: () => Promise.resolve([row]) }) }),
    update: () => ({
      set: () => ({
        where: () => ({ returning: () => Promise.resolve(updateWins ? [{ id: row.id }] : []) }),
      }),
    }),
    insert: () => ({ values: auditInsert }),
  } as unknown as DbTransaction;
  const layer = {
    projectId: "fn-9138-project",
    transactionImmediate: async <T>(fn: (transaction: DbTransaction) => Promise<T>) => fn(tx),
  } as AsyncDataLayer;
  return { layer, auditInsert };
}

/*
FNXC:ApprovalAuditIdentity 2026-08-16-23:22:
A same-millisecond same-type audit ID is safe only while the lifecycle writes at
most one successful transition of that type. This database-free seam simulates a
stale non-terminal racer: its guarded update returns no rows, so real helpers
throw the dashboard-mapped transition conflict before reaching the append-only
insert. Keep a successful control beside each losing case so this test fails if
its stub no longer exercises the production audit path.
*/
describe("approval audit deterministic-ID guarded-update race", () => {
  it.each([
    ["approved", "pending", "approved"] as const,
    ["denied", "pending", "denied"] as const,
    ["completed", "approved", "completed"] as const,
  ])("rejects a stale %s racer before it mints a second audit row", async (eventType, staleStatus, targetStatus) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW));
    try {
      const { layer, auditInsert } = createRacingLayer(staleStatus, false);

      const operation = eventType === "completed"
        ? markApprovalRequestCompleted(layer, "apr-race", { actor: DECIDER })
        : decideApprovalRequest(layer, "apr-race", targetStatus as "approved" | "denied", { actor: DECIDER });

      await expect(operation).rejects.toThrow(`Invalid approval request transition: ${staleStatus} -> ${targetStatus}`);
      expect(auditInsert).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["approved", "pending", "approved"] as const,
    ["denied", "pending", "denied"] as const,
    ["completed", "approved", "completed"] as const,
  ])("inserts one deterministic %s audit ID after a successful guarded update", async (eventType, staleStatus, targetStatus) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW));
    try {
      const { layer, auditInsert } = createRacingLayer(staleStatus, true);
      if (eventType === "completed") {
        await markApprovalRequestCompleted(layer, "apr-race", { actor: DECIDER });
      } else {
        await decideApprovalRequest(layer, "apr-race", targetStatus as "approved" | "denied", { actor: DECIDER });
      }

      expect(auditInsert).toHaveBeenCalledTimes(1);
      expect(auditInsert.mock.calls[0]?.[0]).toMatchObject({
        projectId: "fn-9138-project",
        id: `aprevt-${eventType}-apr-race-${NOW}`,
        requestId: "apr-race",
        eventType,
        createdAt: NOW,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
