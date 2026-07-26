/**
 * FNXC:ApprovalLifecycleSecurity 2026-07-26-12:45:
 * Sync-mode ApprovalRequestStore lifecycle tests: replay conflicts, atomic guarded-update decide/complete,
 * lazy TTL expiry, and the markCompleted requester-ownership check.
 *
 * Harness note: the real `Database` class in db.ts is a throwing stub (VAL-REMOVAL-005 removed the SQLite
 * runtime), so these tests drive the store's sync branch through a minimal in-memory `node:sqlite`-backed
 * double that implements exactly the surface the store uses (prepare / transaction / bumpLastModified).
 * This keeps the sync branch's new security semantics honestly executable without any real DB file,
 * network, or timers.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "../sqlite-adapter.js";
import { ApprovalRequestStore } from "../approval-request-store.js";
import type { Database } from "../db.js";
import type { ApprovalRequestActorSnapshot, ApprovalRequestCreateInput } from "../types/agents.js";

const DDL = `
CREATE TABLE approval_requests (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  requesterActorId TEXT NOT NULL,
  requesterActorType TEXT NOT NULL,
  requesterActorName TEXT NOT NULL,
  targetActionCategory TEXT NOT NULL,
  targetActionOperation TEXT NOT NULL,
  targetActionSummary TEXT NOT NULL,
  targetResourceType TEXT NOT NULL,
  targetResourceId TEXT NOT NULL,
  targetContext TEXT,
  taskId TEXT,
  runId TEXT,
  requestedAt TEXT NOT NULL,
  decidedAt TEXT,
  completedAt TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
CREATE TABLE approval_request_audit_events (
  id TEXT PRIMARY KEY,
  requestId TEXT NOT NULL,
  eventType TEXT NOT NULL,
  actorId TEXT NOT NULL,
  actorType TEXT NOT NULL,
  actorName TEXT NOT NULL,
  note TEXT,
  createdAt TEXT NOT NULL
);
`;

interface TestDb {
  db: Database;
  raw: DatabaseSync;
  /** When set, runs once immediately before the next UPDATE approval_requests statement executes. */
  setBeforeUpdateHook(hook: (() => void) | null): void;
  close(): void;
}

function createTestDb(): TestDb {
  const raw = new DatabaseSync(":memory:");
  raw.exec(DDL);
  let beforeUpdateHook: (() => void) | null = null;
  const dbLike = {
    prepare(sql: string) {
      const stmt = raw.prepare(sql);
      if (!sql.includes("UPDATE approval_requests")) return stmt;
      return {
        all: (...params: unknown[]) => stmt.all(...params),
        get: (...params: unknown[]) => stmt.get(...params),
        run: (...params: unknown[]) => {
          if (beforeUpdateHook) {
            const hook = beforeUpdateHook;
            beforeUpdateHook = null;
            hook();
          }
          return stmt.run(...params);
        },
      };
    },
    transaction<T>(fn: () => T): T {
      raw.exec("BEGIN IMMEDIATE");
      try {
        const result = fn();
        raw.exec("COMMIT");
        return result;
      } catch (error) {
        raw.exec("ROLLBACK");
        throw error;
      }
    },
    transactionImmediate<T>(fn: () => T): T {
      return this.transaction(fn);
    },
    bumpLastModified(): void {
      // no-op in the test double
    },
    exec(sql: string): void {
      raw.exec(sql);
    },
  };
  return {
    db: dbLike as unknown as Database,
    raw,
    setBeforeUpdateHook: (hook) => {
      beforeUpdateHook = hook;
    },
    close: () => raw.close(),
  };
}

const requester: ApprovalRequestActorSnapshot = {
  actorId: "agent-alpha",
  actorType: "agent",
  actorName: "Alpha",
};

const approver: ApprovalRequestActorSnapshot = {
  actorId: "user-op",
  actorType: "user",
  actorName: "Operator",
};

function createInput(): ApprovalRequestCreateInput {
  return {
    requester,
    targetAction: {
      category: "command_execution",
      action: "rm -rf build",
      summary: "Delete the build directory",
      resourceType: "path",
      resourceId: "/repo/build",
    },
    taskId: "FN-1",
  };
}

describe("ApprovalRequestStore sync-mode lifecycle security", () => {
  let harness: TestDb;
  let store: ApprovalRequestStore;

  beforeEach(() => {
    harness = createTestDb();
    store = new ApprovalRequestStore(harness.db);
  });

  afterEach(() => {
    harness.close();
  });

  it("same-verdict replay approve -> approve throws invalid transition (409 message shape)", async () => {
    const request = await store.create(createInput());
    await store.decide(request.id, "approved", { actor: approver });
    await expect(store.decide(request.id, "approved", { actor: approver })).rejects.toThrow(
      "Invalid approval request transition: approved -> approved",
    );
  });

  it("replay does not re-stamp decidedAt or append a duplicate audit event", async () => {
    const request = await store.create(createInput());
    const approved = await store.decide(request.id, "approved", { actor: approver });
    await expect(store.decide(request.id, "approved", { actor: approver })).rejects.toThrow(
      "Invalid approval request transition",
    );
    const after = await store.get(request.id);
    expect(after?.decidedAt).toBe(approved.decidedAt);
    const history = await store.getAuditHistory(request.id);
    expect(history.map((event) => event.eventType)).toEqual(["created", "approved"]);
  });

  it("approve then deny throws invalid transition", async () => {
    const request = await store.create(createInput());
    await store.decide(request.id, "approved", { actor: approver });
    await expect(store.decide(request.id, "denied", { actor: approver })).rejects.toThrow(
      "Invalid approval request transition: approved -> denied",
    );
  });

  it("decide on a nonexistent request throws not-found", async () => {
    await expect(store.decide("apr-missing", "approved", { actor: approver })).rejects.toThrow(
      "Approval request apr-missing not found",
    );
  });

  it("markCompleted on a pending request throws invalid transition", async () => {
    const request = await store.create(createInput());
    await expect(store.markCompleted(request.id, { actor: requester })).rejects.toThrow(
      "Invalid approval request transition: pending -> completed",
    );
  });

  it("markCompleted with mismatched expectedRequesterActorId throws and does not change the row", async () => {
    const request = await store.create(createInput());
    await store.decide(request.id, "approved", { actor: approver });
    await expect(
      store.markCompleted(request.id, {
        actor: { actorId: "agent-beta", actorType: "agent", actorName: "Beta" },
        expectedRequesterActorId: "agent-beta",
      }),
    ).rejects.toThrow(`Approval request ${request.id} requester mismatch`);
    const after = await store.get(request.id);
    expect(after?.status).toBe("approved");
    expect(after?.completedAt).toBeUndefined();
    const history = await store.getAuditHistory(request.id);
    expect(history.map((event) => event.eventType)).toEqual(["created", "approved"]);
  });

  it("markCompleted with matching expectedRequesterActorId succeeds", async () => {
    const request = await store.create(createInput());
    await store.decide(request.id, "approved", { actor: approver });
    const completed = await store.markCompleted(request.id, {
      actor: requester,
      expectedRequesterActorId: requester.actorId,
    });
    expect(completed.status).toBe("completed");
    expect(completed.completedAt).toBeDefined();
  });

  it("decide on an expired pending request (requestedAt 25h ago) throws expired", async () => {
    const request = await store.create(createInput());
    const staleRequestedAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    harness.raw
      .prepare(`UPDATE approval_requests SET requestedAt = ? WHERE id = ?`)
      .run(staleRequestedAt, request.id);
    await expect(store.decide(request.id, "approved", { actor: approver })).rejects.toThrow(
      `Approval request ${request.id} expired`,
    );
    const after = await store.get(request.id);
    expect(after?.status).toBe("pending");
  });

  it("markCompleted on an expired approved grant (decidedAt 16min ago) throws expired", async () => {
    const request = await store.create(createInput());
    await store.decide(request.id, "approved", { actor: approver });
    const staleDecidedAt = new Date(Date.now() - 16 * 60 * 1000).toISOString();
    harness.raw
      .prepare(`UPDATE approval_requests SET decidedAt = ? WHERE id = ?`)
      .run(staleDecidedAt, request.id);
    await expect(store.markCompleted(request.id, { actor: requester })).rejects.toThrow(
      `Approval request ${request.id} expired`,
    );
    const after = await store.get(request.id);
    expect(after?.status).toBe("approved");
  });

  it("guarded-update race: a status flip between the in-transaction read and the UPDATE yields a conflict", async () => {
    const request = await store.create(createInput());
    // Simulate the lost-update race: after decide() has re-read the pending row inside its transaction,
    // a concurrent writer flips the status before decide()'s guarded UPDATE executes. The guard
    // (`WHERE id = ? AND status = 'pending'`) then matches 0 rows and decide() must throw the conflict
    // instead of silently overwriting the concurrent decision.
    harness.setBeforeUpdateHook(() => {
      harness.raw
        .prepare(`UPDATE approval_requests SET status = 'denied', decidedAt = ? WHERE id = ?`)
        .run(new Date().toISOString(), request.id);
    });
    await expect(store.decide(request.id, "approved", { actor: approver })).rejects.toThrow(
      "Invalid approval request transition",
    );
    // Note: the simulated concurrent flip runs on the same test connection, inside the store's own
    // transaction, so the store's ROLLBACK reverts it too and the row lands back on "pending". In a real
    // cross-connection race the concurrent writer's commit would survive; what this test proves is the
    // store-side contract: guarded UPDATE matched 0 rows -> conflict thrown, nothing forged.
    const after = await store.get(request.id);
    expect(after?.status).toBe("pending");
    // The store's transaction rolled back: no forged "approved" audit event exists.
    const history = await store.getAuditHistory(request.id);
    expect(history.map((event) => event.eventType)).toEqual(["created"]);
  });

  it("unit: the guarded UPDATE with a stale status makes 0 changes", async () => {
    const request = await store.create(createInput());
    await store.decide(request.id, "approved", { actor: approver });
    const result = harness.raw
      .prepare(
        `UPDATE approval_requests SET status = ?, decidedAt = ?, updatedAt = ? WHERE id = ? AND status = ?`,
      )
      .run("denied", new Date().toISOString(), new Date().toISOString(), request.id, "pending");
    expect(Number(result.changes)).toBe(0);
    const after = await store.get(request.id);
    expect(after?.status).toBe("approved");
  });

  it("full happy path pending -> approved -> completed still works with clean audit history", async () => {
    const request = await store.create(createInput());
    const approved = await store.decide(request.id, "approved", { actor: approver, note: "ok" });
    expect(approved.status).toBe("approved");
    const completed = await store.markCompleted(request.id, { actor: requester });
    expect(completed.status).toBe("completed");
    const history = await store.getAuditHistory(request.id);
    expect(history.map((event) => event.eventType)).toEqual(["created", "approved", "completed"]);
  });
});
