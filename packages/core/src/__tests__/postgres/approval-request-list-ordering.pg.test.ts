import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import {
  getApprovalAuditHistory,
  listApprovalRequests,
} from "../../async-stores/async-approval-request-store.js";
import * as schema from "../../postgres/schema/index.js";

/*
FNXC:ApprovalRequestOrdering 2026-08-16-23:07:
Approval-request IDs are random and convey neither lifecycle nor recency. This adversarial
fixture inserts same-timestamp IDs opposite their id-DESC contract order, so its literal
assertions pin newest-first pagination without borrowing audit-event ordering semantics.
*/
pgDescribe("approval request list ordering (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_approval_list_order",
  });

  const PROJECT_ID = "approval-order-project";
  const NEWEST_AT = "2026-08-16T23:10:00.000Z";
  const TIED_AT = "2026-08-16T23:09:00.000Z";
  const OLDEST_AT = "2026-08-16T23:08:00.000Z";
  const EXPECTED_IDS = ["apr-newest", "apr-tie-c", "apr-tie-b", "apr-tie-a", "apr-oldest"];
  const INVERTED_TIE_IDS = ["apr-newest", "apr-tie-a", "apr-tie-b", "apr-tie-c", "apr-oldest"];

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  async function seedOrderingFixture(): Promise<void> {
    const requester = { actorId: "agent-order", actorType: "agent", actorName: "Ordering Agent" };
    const targetAction = {
      category: "other",
      operation: "ordering-test",
      summary: "Pin approval request ordering",
      resourceType: "test",
      resourceId: "approval-ordering",
      context: { approvalDedupeKey: "approval-ordering" },
    };
    const row = (id: string, createdAt: string) => ({
      projectId: PROJECT_ID,
      id,
      status: "pending",
      requesterActorId: requester.actorId,
      requesterActorType: requester.actorType,
      requesterActorName: requester.actorName,
      targetActionCategory: targetAction.category,
      targetActionOperation: targetAction.operation,
      targetActionSummary: targetAction.summary,
      targetResourceType: targetAction.resourceType,
      targetResourceId: targetAction.resourceId,
      targetContext: targetAction.context,
      taskId: "FN-9137",
      runId: "run-approval-ordering",
      requestedAt: createdAt,
      decidedAt: null,
      completedAt: null,
      createdAt,
      updatedAt: createdAt,
    });

    await h.adminDb().insert(schema.project.approvalRequests).values([
      row("apr-newest", NEWEST_AT),
      // Reverse the contract order physically: ctid ASC must see a, b, c.
      row("apr-tie-a", TIED_AT),
      row("apr-tie-b", TIED_AT),
      row("apr-tie-c", TIED_AT),
      row("apr-oldest", OLDEST_AT),
    ]);
    await h.adminDb().insert(schema.project.approvalRequestAuditEvents).values({
      projectId: PROJECT_ID,
      id: "aprevt-created-apr-newest",
      requestId: "apr-newest",
      eventType: "created",
      actorId: requester.actorId,
      actorType: requester.actorType,
      actorName: requester.actorName,
      createdAt: NEWEST_AT,
    });
  }

  const listIds = async (input = {}, projectId: string | undefined = PROJECT_ID) =>
    (await listApprovalRequests(h.layer().db, input, projectId)).map((request) => request.id);

  it("returns exact newest-first order and repeats it for identical reads", async () => {
    await seedOrderingFixture();

    expect(await listIds()).toEqual(EXPECTED_IDS);
    expect(await listIds()).toEqual(EXPECTED_IDS);
  });

  it("keeps exact ordering across default, count-shaped, and one-row pages", async () => {
    await seedOrderingFixture();

    expect(await listIds({})).toEqual(EXPECTED_IDS);
    expect(await listIds({ limit: Number.MAX_SAFE_INTEGER, offset: 0 })).toEqual(EXPECTED_IDS);

    const pages: string[] = [];
    for (let offset = 0; offset < EXPECTED_IDS.length; offset += 1) {
      pages.push(...await listIds({ limit: 1, offset }));
    }
    expect(pages).toEqual(EXPECTED_IDS);
  });

  it("composes exact ordering with filters and bound or unbound project reads", async () => {
    await seedOrderingFixture();

    for (const input of [
      { status: "pending" as const },
      { requesterActorId: "agent-order" },
      { taskId: "FN-9137" },
      { runId: "run-approval-ordering" },
    ]) {
      expect(await listIds(input)).toEqual(EXPECTED_IDS);
    }
    expect(await listIds({}, undefined)).toEqual(EXPECTED_IDS);
    expect(await listIds({}, "")).toEqual(EXPECTED_IDS);
    expect(await listIds({}, "   ")).toEqual(EXPECTED_IDS);
  });

  it("returns exact empty and single-row results", async () => {
    expect(await listIds()).toEqual([]);

    await h.adminDb().insert(schema.project.approvalRequests).values({
      projectId: PROJECT_ID,
      id: "apr-single",
      status: "pending",
      requesterActorId: "agent-order",
      requesterActorType: "agent",
      requesterActorName: "Ordering Agent",
      targetActionCategory: "other",
      targetActionOperation: "ordering-test",
      targetActionSummary: "Pin approval request ordering",
      targetResourceType: "test",
      targetResourceId: "approval-ordering",
      requestedAt: TIED_AT,
      createdAt: TIED_AT,
      updatedAt: TIED_AT,
    });
    expect(await listIds()).toEqual(["apr-single"]);
  });

  it("fixture separates contract order from an inverted tiebreak", async () => {
    await seedOrderingFixture();

    const rows = await h.adminSql()<Array<{ id: string }>>`
      SELECT id FROM project.approval_requests
      WHERE project_id = ${PROJECT_ID}
      ORDER BY created_at DESC, id ASC
    `;
    expect(rows.map((row) => row.id)).toEqual(INVERTED_TIE_IDS);
    expect(INVERTED_TIE_IDS).not.toEqual(EXPECTED_IDS);
  });

  it("fixture separates contract order from a tiebreak-free physical-order scan", async () => {
    await seedOrderingFixture();

    /*
    FNXC:ApprovalRequestOrdering 2026-08-16-23:07:
    ctid ASC deterministically stands in for heap order when the product tiebreak is absent.
    It is valid only because this fixture never UPDATEs a seeded tuple, which could move ctid.
    */
    const rows = await h.adminSql()<Array<{ id: string }>>`
      SELECT id FROM project.approval_requests
      WHERE project_id = ${PROJECT_ID}
      ORDER BY created_at DESC, ctid ASC
    `;
    expect(rows.map((row) => row.id)).toEqual(INVERTED_TIE_IDS);
    expect(INVERTED_TIE_IDS).not.toEqual(EXPECTED_IDS);
  });

  it("leaves approval audit history ordering untouched", async () => {
    await seedOrderingFixture();

    expect((await getApprovalAuditHistory(h.layer().db, "apr-newest", PROJECT_ID)).map((event) => event.id))
      .toEqual(["aprevt-created-apr-newest"]);
  });
});
