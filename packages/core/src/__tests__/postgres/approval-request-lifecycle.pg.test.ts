import { it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import type { AsyncDataLayer } from "../../postgres/data-layer.js";
import {
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

That last line is the honest limit. The in-transaction re-read already rejects a replay single-threaded,
so the guard only earns its keep against a racer committing BETWEEN the read and the write — which needs
two concurrent transactions these tests do not create. The guard stays because the race is real; it is
simply not what is verified here. Do not read a green run as proof of it.
*/
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
});
