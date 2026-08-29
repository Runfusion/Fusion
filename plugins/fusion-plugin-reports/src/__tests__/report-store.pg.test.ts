/**
 * FNXC:PostgresCutover 2026-07-04-00:00:
 * Integration test proving ReportStore works in backend mode (PostgreSQL via
 * AsyncDataLayer/Drizzle). Exercises every async sibling method against real
 * PostgreSQL. Auto-skipped via `pgDescribe` when PG is unreachable
 * (FUSION_PG_TEST_SKIP=1).
 */
import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  createTaskStoreForTest,
  pgDescribe,
} from "../../../../packages/core/src/__test-utils__/pg-test-harness.js";
import type { AsyncDataLayer } from "@fusion/core";
import { ReportStore } from "../store/report-store.js";
import type { ReportStatus } from "../store/report-types.js";
import type { CombinedReview } from "../review-types.js";

function projectLayer(layer: AsyncDataLayer, projectId = "reports-project-a"): AsyncDataLayer {
  return { ...layer, projectId };
}

pgDescribe("ReportStore (PostgreSQL / backend mode)", () => {
  it("reports table is materialized by the schema-init hook", async () => {
    const h = await createTaskStoreForTest({ prefix: "fusion_reports_schema" });
    try {
      const rows = (await h.adminDb.execute(sql`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'project' AND table_name = 'reports'
      `)) as unknown as Array<{ table_name: string }>;
      expect(rows.length).toBe(1);
      expect(rows[0].table_name).toBe("reports");
    } finally {
      await h.teardown();
    }
  });

  it("createReportAsync + getReportAsync round-trip", async () => {
    const h = await createTaskStoreForTest({ prefix: "fusion_reports_crud" });
    try {
      const store = new ReportStore(null, { asyncLayer: projectLayer(h.layer) });
      const created = await store.createReportAsync({
        cadence: "weekly",
        periodStart: "2026-07-01",
        periodEnd: "2026-07-07",
        title: "Weekly Integration Report",
        metadata: { agentIds: ["agent-1", "agent-2"] },
      });

      expect(created.id).toMatch(/^rep_/);
      expect(created.status).toBe("generating");
      expect(created.approvalState).toBe("not_required");

      const fetched = await store.getReportAsync(created.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.title).toBe("Weekly Integration Report");
      expect(fetched!.metadata).toEqual({ agentIds: ["agent-1", "agent-2"] });
    } finally {
      await h.teardown();
    }
  });

  it("isolates identical report ids and mutations between two bound projects", async () => {
    const h = await createTaskStoreForTest({ prefix: "fusion_reports_isolation" });
    try {
      const projectA = new ReportStore(null, { asyncLayer: projectLayer(h.layer, "reports-project-a") });
      const projectB = new ReportStore(null, { asyncLayer: projectLayer(h.layer, "reports-project-b") });
      const report = await projectA.createReportAsync({
        cadence: "daily",
        periodStart: "2026-07-14",
        periodEnd: "2026-07-14",
        title: "Project A",
      });
      await h.adminDb.execute(sql`
        INSERT INTO project.reports
        SELECT 'reports-project-b', id, cadence, period_start, period_end, 'Project B', status,
          generation_started_at, generation_completed_at, review_started_at, review_completed_at,
          approved_at, approved_by, published_at, archived_at, failure_reason, approval_state,
          approval_history, draft_markdown, rendered_html_path, rendered_html,
          rendered_html_generated_at, metadata_json, combined_review_json, created_at, updated_at
        FROM project.reports WHERE project_id='reports-project-a' AND id=${report.id}
      `);

      expect((await projectA.getReportAsync(report.id))?.title).toBe("Project A");
      expect((await projectB.getReportAsync(report.id))?.title).toBe("Project B");
      await projectB.updateReportAsync(report.id, { title: "Project B updated" });
      expect((await projectA.getReportAsync(report.id))?.title).toBe("Project A");
      expect((await projectB.getReportAsync(report.id))?.title).toBe("Project B updated");
    } finally {
      await h.teardown();
    }
  });

  it("getReportAsync returns null for unknown id", async () => {
    const h = await createTaskStoreForTest({ prefix: "fusion_reports_miss" });
    try {
      const store = new ReportStore(null, { asyncLayer: projectLayer(h.layer) });
      const fetched = await store.getReportAsync("rep_nonexistent");
      expect(fetched).toBeNull();
    } finally {
      await h.teardown();
    }
  });

  it("listReportsAsync with filters, ordering, and pagination", async () => {
    const h = await createTaskStoreForTest({ prefix: "fusion_reports_list" });
    try {
      const store = new ReportStore(null, { asyncLayer: projectLayer(h.layer) });
      for (let i = 0; i < 5; i++) {
        await store.createReportAsync({
          cadence: i < 3 ? "daily" : "weekly",
          periodStart: `2026-07-0${i + 1}`,
          periodEnd: `2026-07-0${i + 1}`,
          title: `Report ${i}`,
        });
      }

      // Filter by cadence
      const daily = await store.listReportsAsync({ cadence: "daily" });
      expect(daily.length).toBe(3);

      // Filter by statusIn
      const generating = await store.listReportsAsync({
        statusIn: ["generating", "review_pending"] as ReportStatus[],
      });
      expect(generating.length).toBe(5);

      // Pagination
      const page = await store.listReportsAsync({ limit: 2, offset: 0, orderBy: "createdAt", orderDir: "asc" });
      expect(page.length).toBe(2);

      // Period range filter
      const inRange = await store.listReportsAsync({
        periodStartFrom: "2026-07-02",
        periodStartTo: "2026-07-04",
      });
      expect(inRange.length).toBe(3);
    } finally {
      await h.teardown();
    }
  });

  it("setStatusAsync validates transitions and sets timestamps", async () => {
    const h = await createTaskStoreForTest({ prefix: "fusion_reports_status" });
    try {
      const store = new ReportStore(null, { asyncLayer: projectLayer(h.layer) });
      const created = await store.createReportAsync({
        cadence: "daily",
        periodStart: "2026-07-01",
        periodEnd: "2026-07-01",
        title: "Status Test",
      });

      const pending = await store.setStatusAsync(created.id, "review_pending");
      expect(pending.status).toBe("review_pending");
      expect(pending.generationCompletedAt).not.toBeNull();

      const inProgress = await store.setStatusAsync(created.id, "review_in_progress");
      expect(inProgress.status).toBe("review_in_progress");
      expect(inProgress.reviewStartedAt).not.toBeNull();

      // Invalid transition: review_in_progress -> published (skips approved)
      await expect(
        store.setStatusAsync(created.id, "published"),
      ).rejects.toThrow(/Invalid status transition/);
    } finally {
      await h.teardown();
    }
  });

  it("attachReviewAsync requires review_in_progress and stores combined review", async () => {
    const h = await createTaskStoreForTest({ prefix: "fusion_reports_review" });
    try {
      const store = new ReportStore(null, { asyncLayer: projectLayer(h.layer) });
      const created = await store.createReportAsync({
        cadence: "daily",
        periodStart: "2026-07-01",
        periodEnd: "2026-07-01",
        title: "Review Test",
      });
      await store.setStatusAsync(created.id, "review_pending");
      await store.setStatusAsync(created.id, "review_in_progress");

      const combined: CombinedReview = { overallVerdict: "approve", consensusSummary: "Good report", mergedHighlights: [], mergedLowlights: [], mergedSuggestions: [], individual: [], failures: [] };
      const reviewed = await store.attachReviewAsync(created.id, combined);
      expect(reviewed.status).toBe("review_complete");
      expect(reviewed.combinedReview).toEqual(combined);
      expect(reviewed.reviewCompletedAt).not.toBeNull();

      // Verify it persists across reads
      const refetched = await store.getReportAsync(created.id);
      expect(refetched!.combinedReview).toEqual(combined);
    } finally {
      await h.teardown();
    }
  });

  it("updateReportAsync + setRenderedHtmlAsync update fields", async () => {
    const h = await createTaskStoreForTest({ prefix: "fusion_reports_update" });
    try {
      const store = new ReportStore(null, { asyncLayer: projectLayer(h.layer) });
      const created = await store.createReportAsync({
        cadence: "daily",
        periodStart: "2026-07-01",
        periodEnd: "2026-07-01",
        title: "Original Title",
      });

      const updated = await store.updateReportAsync(created.id, { title: "Updated Title" });
      expect(updated.title).toBe("Updated Title");

      const rendered = await store.setRenderedHtmlAsync(created.id, "<html>rendered</html>");
      expect(rendered.renderedHtml).toBe("<html>rendered</html>");
      expect(rendered.renderedHtmlGeneratedAt).not.toBeNull();
    } finally {
      await h.teardown();
    }
  });

  it("deleteReportAsync removes the report", async () => {
    const h = await createTaskStoreForTest({ prefix: "fusion_reports_delete" });
    try {
      const store = new ReportStore(null, { asyncLayer: projectLayer(h.layer) });
      const created = await store.createReportAsync({
        cadence: "daily",
        periodStart: "2026-07-01",
        periodEnd: "2026-07-01",
        title: "Delete Me",
      });

      await store.deleteReportAsync(created.id);
      const fetched = await store.getReportAsync(created.id);
      expect(fetched).toBeNull();

      // Delete of non-existent id throws
      await expect(store.deleteReportAsync(created.id)).rejects.toThrow(/not found/);
    } finally {
      await h.teardown();
    }
  });
});
