/*
FNXC:TaskRecommendations 2026-08-13-04:59:
The aggregate Insights read pages completed task rows, not individual JSONB entries. Exercise the
production PostgreSQL store boundary so SQL-side empty-row filtering, stable row ordering, and the
page metadata cannot drift from the dashboard paging contract.
*/
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../__test-utils__/pg-test-harness.js";
import { applySchemaBaseline } from "../postgres/schema-applier.js";
import { insertTaskRow } from "../task-store/async/async-persistence.js";

function recommendation(id: string) {
  return {
    id,
    title: `Follow up ${id}`,
    description: `Track the separately scoped follow-up ${id}.`,
    category: "improvement" as const,
  };
}

async function insertRecommendationTask(
  h: SharedPgTaskStoreHarness,
  id: string,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  await insertTaskRow(h.layer(), {
    id,
    title: `Source ${id}`,
    description: `Completed source task ${id}.`,
    column: "complete",
    currentStep: 0,
    createdAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:00:00.000Z",
    recommendations: [recommendation(`rec-${id}`)],
    ...overrides,
  }, { lineageId: `lineage-${id}` });
}

pgDescribe("TaskStore.listTaskRecommendations", () => {
  const h = createSharedPgTaskStoreTestHarness({ prefix: "fusion_task_recommendations_list" });

  beforeAll(async () => {
    await h.beforeAll();
    await applySchemaBaseline(h.adminDb());
  });
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  it("filters to live completed non-empty source rows and pages them in stable updatedAt/id order", async () => {
    await insertRecommendationTask(h, "FN-A", {
      updatedAt: "2026-08-13T01:00:00.000Z",
      recommendations: [recommendation("first-a"), recommendation("second-a")],
    });
    await insertRecommendationTask(h, "FN-Z", {
      updatedAt: "2026-08-13T01:00:00.000Z",
    });
    await insertRecommendationTask(h, "FN-NEW", {
      updatedAt: "2026-08-13T02:00:00.000Z",
    });
    await insertRecommendationTask(h, "FN-EMPTY", {
      updatedAt: "2026-08-13T03:00:00.000Z",
      recommendations: [],
    });
    await insertRecommendationTask(h, "FN-TODO", {
      column: "todo",
      updatedAt: "2026-08-13T04:00:00.000Z",
    });
    await insertRecommendationTask(h, "FN-DELETED", {
      deletedAt: "2026-08-13T05:00:00.000Z",
      updatedAt: "2026-08-13T05:00:00.000Z",
    });

    const firstPage = await h.store().listTaskRecommendations({
      completeColumns: new Set(["complete"]),
      limit: 2,
      offset: 0,
    });
    expect(firstPage).toMatchObject({
      rowOffset: 0,
      rowLimit: 2,
      returnedRowCount: 2,
      totalRowCount: 3,
      hasMore: true,
    });
    expect(firstPage.items.map((item) => [item.taskId, item.recommendation.id])).toEqual([
      ["FN-NEW", "rec-FN-NEW"],
      ["FN-Z", "rec-FN-Z"],
    ]);

    const finalPage = await h.store().listTaskRecommendations({
      completeColumns: new Set(["complete"]),
      limit: 2,
      offset: firstPage.rowOffset + firstPage.returnedRowCount,
    });
    expect(finalPage).toMatchObject({
      rowOffset: 2,
      rowLimit: 2,
      returnedRowCount: 1,
      totalRowCount: 3,
      hasMore: false,
    });
    expect(finalPage.items.map((item) => [item.taskId, item.recommendation.id])).toEqual([
      ["FN-A", "first-a"],
      ["FN-A", "second-a"],
    ]);
  });

  it("uses the default row limit and clamps oversized row pages", async () => {
    await insertRecommendationTask(h, "FN-LIMIT");

    await expect(h.store().listTaskRecommendations({
      completeColumns: new Set(["complete"]),
    })).resolves.toMatchObject({
      rowOffset: 0,
      rowLimit: 50,
      returnedRowCount: 1,
      totalRowCount: 1,
      hasMore: false,
    });
    await expect(h.store().listTaskRecommendations({
      completeColumns: new Set(["complete"]),
      limit: 999,
    })).resolves.toMatchObject({
      rowOffset: 0,
      rowLimit: 200,
      returnedRowCount: 1,
      totalRowCount: 1,
      hasMore: false,
    });
  });
});
