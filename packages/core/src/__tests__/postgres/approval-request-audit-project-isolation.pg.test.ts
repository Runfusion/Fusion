import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import {
  createApprovalRequest,
  getApprovalAuditHistory,
} from "../../async-stores/async-approval-request-store.js";
import { ApprovalRequestStore } from "../../agents/approval-request-store.js";
import type { AsyncDataLayer } from "../../postgres/data-layer.js";
import * as schema from "../../postgres/schema/index.js";

pgDescribe("approval request audit project isolation", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_approval_audit_isolation",
  });
  const bind = (projectId: string): AsyncDataLayer => ({ ...h.layer(), projectId });
  const input = {
    requester: { actorId: "agent", actorType: "agent" as const, actorName: "Agent" },
    targetAction: {
      category: "other" as const,
      action: "test",
      summary: "Test approval audit ownership",
      resourceType: "task",
      resourceId: "FN-9003",
    },
  };

  beforeAll(h.beforeAll);
  afterAll(h.afterAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);

  it("models the live 0006 ownership shape exactly", async () => {
    const columns = await h.adminSql()<Array<{
      column_name: string;
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>>`
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'project'
        AND table_name = 'approval_request_audit_events'
        AND column_name = 'project_id'
    `;
    expect(columns).toEqual([expect.objectContaining({
      column_name: "project_id",
      data_type: "text",
      is_nullable: "NO",
      column_default: expect.stringContaining("current_setting"),
    })]);

    const keys = await h.adminSql()<Array<{ conname: string; columns: string[] }>>`
      SELECT c.conname, array_agg(a.attname ORDER BY k.ordinality) AS columns
      FROM pg_constraint c
      CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY k(attnum, ordinality)
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
      WHERE c.conrelid = 'project.approval_request_audit_events'::regclass
        AND c.contype = 'p'
      GROUP BY c.conname
    `;
    expect(keys).toEqual([{
      conname: "approval_request_audit_events_pkey",
      columns: ["project_id", "id"],
    }]);
    expect(await h.adminSql()<Array<{ polname: string }>>`
      SELECT polname FROM pg_policy
      WHERE polrelid = 'project.approval_request_audit_events'::regclass
    `).toEqual([{ polname: "fusion_project_isolation" }]);
    expect(await h.adminSql()<Array<{ tgname: string }>>`
      SELECT tgname FROM pg_trigger
      WHERE tgrelid = 'project.approval_request_audit_events'::regclass
        AND NOT tgisinternal
    `).toEqual([{ tgname: "fusion_assign_project_id" }]);
    expect(await h.adminSql()<Array<{ indexname: string }>>`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'project'
        AND tablename = 'approval_request_audit_events'
        AND indexname IN ('idxApprovalRequestAuditRequestCreatedAt', 'idxApprovalRequestAuditProjectCreatedAt')
      ORDER BY indexname
    `).toEqual([
      { indexname: "idxApprovalRequestAuditProjectCreatedAt" },
      { indexname: "idxApprovalRequestAuditRequestCreatedAt" },
    ]);
  });

  it("isolates colliding audit identities through helper and public store paths", async () => {
    /*
    FNXC:ApprovalAuditProjectIsolation 2026-08-12-15:37:
    Owner connections can bypass RLS. Deterministic event IDs can collide when requests share
    a creation instant, so make the two generated rows share an ID after creation. This proves
    both the physical composite key and public-store binding prevent an authorization-trail leak.
    */
    const projectA = bind("approval-audit-a");
    const projectB = bind("approval-audit-b");
    const sharedRequestId = "apr-audit-shared";
    await createApprovalRequest(projectA, { ...input, id: sharedRequestId });
    await createApprovalRequest(projectB, { ...input, id: sharedRequestId });

    const events = await h.adminDb().select({
      projectId: schema.project.approvalRequestAuditEvents.projectId,
      id: schema.project.approvalRequestAuditEvents.id,
    }).from(schema.project.approvalRequestAuditEvents)
      .where(eq(schema.project.approvalRequestAuditEvents.requestId, sharedRequestId));
    const aEvent = events.find((event) => event.projectId === projectA.projectId)!;
    const bEvent = events.find((event) => event.projectId === projectB.projectId)!;
    await h.adminDb().update(schema.project.approvalRequestAuditEvents).set({ id: aEvent.id })
      .where(and(
        eq(schema.project.approvalRequestAuditEvents.projectId, projectB.projectId!),
        eq(schema.project.approvalRequestAuditEvents.id, bEvent.id),
      ));
    const collidingEvents = await h.adminDb().select({
      projectId: schema.project.approvalRequestAuditEvents.projectId,
      id: schema.project.approvalRequestAuditEvents.id,
    }).from(schema.project.approvalRequestAuditEvents)
      .where(eq(schema.project.approvalRequestAuditEvents.requestId, sharedRequestId));
    expect(collidingEvents).toEqual([
      { projectId: "approval-audit-a", id: aEvent.id },
      { projectId: "approval-audit-b", id: aEvent.id },
    ]);

    expect((await getApprovalAuditHistory(projectA.db, sharedRequestId, projectA.projectId)).map((event) => event.id))
      .toEqual([aEvent.id]);
    expect((await getApprovalAuditHistory(projectB.db, sharedRequestId, projectB.projectId)).map((event) => event.id))
      .toEqual([aEvent.id]);
    expect(await getApprovalAuditHistory(bind("approval-audit-empty").db, sharedRequestId, "approval-audit-empty"))
      .toEqual([]);

    const storeA = new ApprovalRequestStore(null, { asyncLayer: projectA });
    const storeB = new ApprovalRequestStore(null, { asyncLayer: projectB });
    const unboundStore = new ApprovalRequestStore(null, {
      asyncLayer: { ...h.layer(), projectId: undefined },
    });
    expect((await storeA.getAuditHistory(sharedRequestId)).map((event) => event.actor.actorName))
      .toEqual(["Agent"]);
    expect((await storeB.getAuditHistory(sharedRequestId)).map((event) => event.actor.actorName))
      .toEqual(["Agent"]);
    const unboundEvents = await unboundStore.getAuditHistory(sharedRequestId);
    expect(unboundEvents).toHaveLength(2);
    expect(Object.keys(unboundEvents[0]!).sort()).toEqual([
      "actor", "createdAt", "eventType", "id", "note", "requestId",
    ]);
  });

  it("preserves unbound, whitespace, and ordering behavior", async () => {
    const unbound = { ...h.layer(), projectId: undefined };
    const empty = { ...h.layer(), projectId: "" };
    const whitespace = { ...h.layer(), projectId: "   " };
    await createApprovalRequest(unbound, { ...input, id: "apr-unbound" });
    await createApprovalRequest(empty, { ...input, id: "apr-empty" });
    await createApprovalRequest(whitespace, { ...input, id: "apr-whitespace" });

    const stored = await h.adminDb().select({
      requestId: schema.project.approvalRequestAuditEvents.requestId,
      projectId: schema.project.approvalRequestAuditEvents.projectId,
    }).from(schema.project.approvalRequestAuditEvents)
      .where(and(
        eq(schema.project.approvalRequestAuditEvents.eventType, "created"),
        eq(schema.project.approvalRequestAuditEvents.actorId, "agent"),
      ));
    expect(stored.find((row) => row.requestId === "apr-unbound")?.projectId).toBe("__legacy_unscoped__");
    expect(stored.find((row) => row.requestId === "apr-empty")?.projectId).toBe("__legacy_unscoped__");
    // The read helper trims, but the trigger's exact-'' NULLIF deliberately stores whitespace.
    expect(stored.find((row) => row.requestId === "apr-whitespace")?.projectId).toBe("   ");
    expect(stored.find((row) => row.requestId === "apr-whitespace")?.projectId).not.toBe("__legacy_unscoped__");

    expect(await getApprovalAuditHistory(unbound.db, "apr-unbound", unbound.projectId)).toHaveLength(1);
    expect(await getApprovalAuditHistory(empty.db, "apr-unbound", empty.projectId)).toHaveLength(1);
    expect(await getApprovalAuditHistory(whitespace.db, "apr-unbound", whitespace.projectId)).toHaveLength(1);

    await h.adminDb().insert(schema.project.approvalRequestAuditEvents).values([
      { projectId: "order-project", id: "b", requestId: "apr-order", eventType: "created", actorId: "agent", actorType: "agent", actorName: "Agent", createdAt: "2026-08-12T15:00:00.000Z" },
      { projectId: "order-project", id: "a", requestId: "apr-order", eventType: "approved", actorId: "agent", actorType: "agent", actorName: "Agent", createdAt: "2026-08-12T15:00:00.000Z" },
      { projectId: "order-project", id: "c", requestId: "apr-order", eventType: "completed", actorId: "agent", actorType: "agent", actorName: "Agent", createdAt: "2026-08-12T16:00:00.000Z" },
    ]);
    expect((await getApprovalAuditHistory(h.layer().db, "apr-order", "order-project")).map((event) => event.id))
      .toEqual(["b", "a", "c"]);
  });
});
