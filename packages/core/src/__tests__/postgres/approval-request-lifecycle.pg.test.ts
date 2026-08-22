import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import { ApprovalRequestStore } from "../../agents/approval-request-store.js";
import type { AsyncDataLayer } from "../../postgres/data-layer.js";
import * as schema from "../../postgres/schema/index.js";
import {
  PG_AVAILABLE,
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";

/*
FNXC:PgTestHarnessAdoption 2026-08-16-03:45:
Migrated off the hand-rolled per-test CREATE DATABASE + applySchemaBaseline scaffolding
(~3-4s of DDL per test) onto the shared PG harness: one template-cloned database per file
with TRUNCATE-based reset per test. The database setup here was scaffolding, not the
subject under test (the approval-request transition guards are), and every assertion is
unchanged.
*/
interface StoreTestCtx {
  layer: AsyncDataLayer;
}

/*
FNXC:ApprovalLifecycleSecurity 2026-07-30-13:10 (ported from the deleted sync branch):
These assertions arrived with the approval-hardening work as `approval-request-store-lifecycle.test.ts`,
which drove the store's SYNC SQLite branch through an in-memory double. The PostgreSQL migration deleted
that branch, so the original file tested code that no longer exists — and deleting it outright would have
left the hardening (atomic guarded decide/complete, lazy TTL expiry, requester-ownership on redemption)
with no coverage at all on the path that actually runs.

Same contract, re-pointed at the async/PG implementation.

WHAT THESE DO AND DO NOT COVER, measured by reverting each guard in turn rather than assumed:
  - transition rules (replay, approve-then-deny, complete-while-pending) -> 3 of 6 fail when removed
  - requester-ownership on redemption                                    -> 1 of 6 fails when removed
  - the `AND status = ?` guard on the UPDATE                             -> 0 fail when removed

The guarded `AND status = ?` update is now pinned by the always-running
`approval-request-audit-id-race.test.ts` stale-read simulation and the barrier-overlapped
PostgreSQL double-decision/double-completion probes below. The pure test proves the exact
empty-returning branch; PostgreSQL may validly serialize its loser to the transition matrix.
*/
describe("approval request lifecycle PostgreSQL availability", () => {
  it("fails closed when a required PostgreSQL probe would otherwise be skipped", () => {
    if (process.env.FUSION_PG_REQUIRED === "1") {
      expect(PG_AVAILABLE).toBe(true);
    }
  });
});

pgDescribe("approval request lifecycle security (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_sat_test",
  });
  let ctx: StoreTestCtx;

  beforeAll(h.beforeAll);
  beforeEach(async () => {
    await h.beforeEach();
    ctx = { layer: h.layer() };
  });
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  const REQUESTER = { actorId: "agent-1", actorType: "agent" as const, actorName: "Bot" };
  const DECIDER = { actorId: "user-1", actorType: "user" as const, actorName: "Admin" };

  async function seed(id: string) {
    const store = await import("../../async-stores/async-approval-request-store.js");
    await store.createApprovalRequest(ctx!.layer, {
      id,
      requester: REQUESTER,
      targetAction: { category: "shell", action: "exec", summary: "run cmd", resourceType: "host", resourceId: "local", context: { cmd: "ls" } },
    });
    return store;
  }

  it("orders audit history by lifecycle within timestamp ties across store surfaces", async () => {
    const store = await import("../../async-stores/async-approval-request-store.js");
    const publicStore = new ApprovalRequestStore(null, { asyncLayer: ctx.layer });
    const targetAction = { category: "shell", action: "exec", summary: "run cmd", resourceType: "host", resourceId: "local", context: { cmd: "ls" } };
    const assertHistory = async (id: string, expectedTypes: string[]) => {
      const moduleHistory = await store.getApprovalAuditHistory(ctx.layer.db, id);
      const delegatedHistory = await publicStore.getAuditHistory(id);
      expect(moduleHistory.map((event) => event.eventType)).toEqual(expectedTypes);
      expect(delegatedHistory.map((event) => event.eventType)).toEqual(expectedTypes);
    };
    const create = (id: string) => store.createApprovalRequest(ctx.layer, { id, requester: REQUESTER, targetAction });

    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const tiedAt = new Date("2026-08-16T22:26:00.000Z");
      vi.setSystemTime(tiedAt);
      await create("apr-tied-approved");
      await store.decideApprovalRequest(ctx.layer, "apr-tied-approved", "approved", { actor: DECIDER });
      const tiedApproved = await store.getApprovalAuditHistory(ctx.layer.db, "apr-tied-approved");
      expect(tiedApproved.map((event) => event.createdAt)).toEqual([tiedAt.toISOString(), tiedAt.toISOString()]);
      await assertHistory("apr-tied-approved", ["created", "approved"]);

      await create("apr-tied-denied");
      await store.decideApprovalRequest(ctx.layer, "apr-tied-denied", "denied", { actor: DECIDER });
      await assertHistory("apr-tied-denied", ["created", "denied"]);

      await create("apr-tied-completed");
      await store.decideApprovalRequest(ctx.layer, "apr-tied-completed", "approved", { actor: DECIDER });
      await store.markApprovalRequestCompleted(ctx.layer, "apr-tied-completed", { actor: DECIDER });
      await assertHistory("apr-tied-completed", ["created", "approved", "completed"]);

      vi.setSystemTime(new Date("2026-08-16T22:27:00.000Z"));
      await create("apr-distinct");
      vi.setSystemTime(new Date("2026-08-16T22:28:00.000Z"));
      await store.decideApprovalRequest(ctx.layer, "apr-distinct", "approved", { actor: DECIDER });
      vi.setSystemTime(new Date("2026-08-16T22:29:00.000Z"));
      await store.markApprovalRequestCompleted(ctx.layer, "apr-distinct", { actor: DECIDER });
      await assertHistory("apr-distinct", ["created", "approved", "completed"]);

      vi.setSystemTime(new Date("2026-08-16T22:30:00.000Z"));
      await create("apr-mixed");
      await store.decideApprovalRequest(ctx.layer, "apr-mixed", "approved", { actor: DECIDER });
      vi.setSystemTime(new Date("2026-08-16T22:31:00.000Z"));
      await store.markApprovalRequestCompleted(ctx.layer, "apr-mixed", { actor: DECIDER });
      await assertHistory("apr-mixed", ["created", "approved", "completed"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a same-verdict replay is rejected as an invalid transition", async () => {
    const store = await seed("apr-replay");
    await store.decideApprovalRequest(ctx.layer, "apr-replay", "approved", { actor: DECIDER });

    await expect(
      store.decideApprovalRequest(ctx.layer, "apr-replay", "approved", { actor: DECIDER }),
    ).rejects.toThrow(/Invalid approval request transition/);
  });

  it("a replay does not re-stamp decidedAt or append a duplicate audit event", async () => {
    const store = await seed("apr-nodup");
    const first = await store.decideApprovalRequest(ctx.layer, "apr-nodup", "approved", { actor: DECIDER });
    const auditBefore = await store.getApprovalAuditHistory(ctx.layer.db, "apr-nodup");

    await expect(
      store.decideApprovalRequest(ctx.layer, "apr-nodup", "approved", { actor: DECIDER }),
    ).rejects.toThrow(/Invalid approval request transition/);

    const after = await store.getApprovalRequest(ctx.layer.db, "apr-nodup");
    expect(after?.decidedAt).toBe(first.decidedAt);
    expect(await store.getApprovalAuditHistory(ctx.layer.db, "apr-nodup")).toHaveLength(auditBefore.length);
  });

  it("approve then deny is rejected — the first decision stands", async () => {
    const store = await seed("apr-flip");
    await store.decideApprovalRequest(ctx.layer, "apr-flip", "approved", { actor: DECIDER });

    await expect(
      store.decideApprovalRequest(ctx.layer, "apr-flip", "denied", { actor: DECIDER }),
    ).rejects.toThrow(/Invalid approval request transition/);
    expect((await store.getApprovalRequest(ctx.layer.db, "apr-flip"))?.status).toBe("approved");
  });

  it("deciding a request that does not exist reports not-found", async () => {
    const store = await import("../../async-stores/async-approval-request-store.js");

    await expect(
      store.decideApprovalRequest(ctx.layer, "apr-missing", "approved", { actor: DECIDER }),
    ).rejects.toThrow(/not found/);
  });

  it("markCompleted on a still-pending request is rejected", async () => {
    const store = await seed("apr-pending");

    await expect(
      store.markApprovalRequestCompleted(ctx.layer, "apr-pending", { actor: DECIDER }),
    ).rejects.toThrow(/Invalid approval request transition/);
  });

  it("a grant can only be redeemed by the actor it was issued to", async () => {
    /*
    The ownership check is the containment that matters: without it any caller who learned a request id
    could redeem someone else's approved grant.
    */
    const store = await seed("apr-owner");
    await store.decideApprovalRequest(ctx.layer, "apr-owner", "approved", { actor: DECIDER });

    await expect(
      store.markApprovalRequestCompleted(ctx.layer, "apr-owner", { actor: DECIDER, expectedRequesterActorId: "someone-else" }),
    ).rejects.toThrow(/requester mismatch/);
    expect((await store.getApprovalRequest(ctx.layer.db, "apr-owner"))?.status).toBe("approved");

    const completed = await store.markApprovalRequestCompleted(ctx.layer, "apr-owner", {
      actor: DECIDER,
      expectedRequesterActorId: REQUESTER.actorId,
    });
    expect(completed.status).toBe("completed");
  });

  it("rejects an exact same-millisecond audit primary-key duplicate", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const tiedAt = new Date("2026-08-16T23:22:00.000Z");
      vi.setSystemTime(tiedAt);
      const store = await seed("apr-audit-primary-key");
      const [created] = await store.getApprovalAuditHistory(ctx.layer.db, "apr-audit-primary-key");
      expect(created).toBeDefined();
      const duplicateError = await h.adminDb().insert(schema.project.approvalRequestAuditEvents).values({
        projectId: "__legacy_unscoped__",
        id: created!.id,
        requestId: created!.requestId,
        eventType: created!.eventType,
        actorId: created!.actor.actorId,
        actorType: created!.actor.actorType,
        actorName: created!.actor.actorName,
        note: created!.note ?? null,
        createdAt: created!.createdAt,
      }).then(() => null, (error: unknown) => error as { cause?: unknown });
      expect(duplicateError).toMatchObject({ cause: { code: "23505" } });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["pending double approve", "approved", "approved"] as const,
    ["pending double deny", "denied", "denied"] as const,
    ["pending approve versus deny", "approved", "denied"] as const,
  ])("runs overlapping %s decisions without duplicate audit IDs", async (_name, first, second) => {
    const store = await seed(`apr-race-${first}-${second}`);
    const requestId = `apr-race-${first}-${second}`;
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-08-16T23:22:00.000Z"));
      let release!: () => void;
      const barrier = new Promise<void>((resolve) => { release = resolve; });
      const windows: Array<{ started: number; settled: number }> = [];
      const racer = async (status: "approved" | "denied") => {
        await barrier;
        const window = { started: performance.now(), settled: Number.NaN };
        windows.push(window);
        try {
          return await store.decideApprovalRequest(ctx.layer, requestId, status, { actor: DECIDER });
        } finally {
          window.settled = performance.now();
        }
      };
      const racers = [racer(first), racer(second)];
      await Promise.resolve();
      release();
      const outcomes = await Promise.allSettled(racers);
      expect(windows).toHaveLength(2);
      expect(Math.max(...windows.map((window) => window.started))).toBeLessThan(
        Math.min(...windows.map((window) => window.settled)),
      );
      expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
      const loser = outcomes.find((outcome) => outcome.status === "rejected") as PromiseRejectedResult;
      expect(String(loser.reason)).toMatch(/Invalid approval request transition/);
      expect(String(loser.reason)).not.toMatch(/duplicate key|unique constraint/i);
      const winner = outcomes.find((outcome) => outcome.status === "fulfilled") as PromiseFulfilledResult<{ status: string }>;
      expect((await store.getApprovalRequest(ctx.layer.db, requestId))?.status).toBe(winner.value.status);
      const history = await store.getApprovalAuditHistory(ctx.layer.db, requestId);
      expect(history.filter((event) => event.eventType === winner.value.status)).toHaveLength(1);
      expect(new Set(history.map((event) => `${event.eventType}:${event.createdAt}`)).size).toBe(history.length);
    } finally {
      vi.useRealTimers();
    }
  });

  it("runs overlapping approved double completion without duplicate audit IDs", async () => {
    const store = await seed("apr-race-completed");
    await store.decideApprovalRequest(ctx.layer, "apr-race-completed", "approved", { actor: DECIDER });
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-08-16T23:22:00.000Z"));
      let release!: () => void;
      const barrier = new Promise<void>((resolve) => { release = resolve; });
      const windows: Array<{ started: number; settled: number }> = [];
      const racer = async () => {
        await barrier;
        const window = { started: performance.now(), settled: Number.NaN };
        windows.push(window);
        try {
          return await store.markApprovalRequestCompleted(ctx.layer, "apr-race-completed", { actor: DECIDER });
        } finally {
          window.settled = performance.now();
        }
      };
      const outcomes = [racer(), racer()];
      await Promise.resolve();
      release();
      const settled = await Promise.allSettled(outcomes);
      expect(Math.max(...windows.map((window) => window.started))).toBeLessThan(
        Math.min(...windows.map((window) => window.settled)),
      );
      expect(settled.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
      expect(settled.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
      const loser = settled.find((outcome) => outcome.status === "rejected") as PromiseRejectedResult;
      expect(String(loser.reason)).toMatch(/Invalid approval request transition/);
      expect(String(loser.reason)).not.toMatch(/duplicate key|unique constraint/i);
      expect((await store.getApprovalRequest(ctx.layer.db, "apr-race-completed"))?.status).toBe("completed");
      const history = await store.getApprovalAuditHistory(ctx.layer.db, "apr-race-completed");
      expect(history.filter((event) => event.eventType === "completed")).toHaveLength(1);
      expect(new Set(history.map((event) => `${event.eventType}:${event.createdAt}`)).size).toBe(history.length);
    } finally {
      vi.useRealTimers();
    }
  });

});
