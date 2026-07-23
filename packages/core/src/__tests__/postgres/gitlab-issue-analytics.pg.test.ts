/**
 * FNXC:PostgresCutover 2026-07-04-00:00:
 * PostgreSQL-backed coverage for aggregateGitlabIssueAnalytics, which was
 * ported to the AsyncDataLayer (Database | AsyncDataLayer dual-path) to mirror
 * aggregateGithubIssueAnalytics. The sync SQLite companion test was removed
 * with the SQLite runtime (VAL-REMOVAL-005); this file is the PG replacement.
 *
 * Exercises both the empty-project shape (no throw, zeroed result) and seeded
 * project.tasks rows (filed gitlab_tracking item + fixed gitlab source issue)
 * to prove the PG queries read the real jsonb / snake_case columns and produce
 * the correct filed/fixed/daily/byProject/resolved semantics.
 *
 * Runs in the blocking gate (`@fusion/core test:pg-gate`) and auto-skips via
 * pgDescribe when PostgreSQL is unavailable.
 */

import { it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import { sql } from "drizzle-orm";

import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import { aggregateGitlabIssueAnalytics } from "../../board/gitlab-issue-analytics.js";

const pgTest = pgDescribe;

const FROM = "2026-06-01T00:00:00.000Z";
const TO = "2026-06-30T23:59:59.999Z";
const IN_RANGE = "2026-06-15T12:00:00.000Z";

pgTest("GitLab issue analytics aggregator (PostgreSQL backend mode)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_cc_gitlab",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  // ── Empty project: aggregator resolves with a zero/empty shape ─────────────

  it("resolves (no throw) against an empty project", async () => {
    const layer = h.layer();
    const range = { from: FROM, to: TO };

    const gitlab = await aggregateGitlabIssueAnalytics(layer, range);
    expect(gitlab.filed).toBe(0);
    expect(gitlab.fixed).toBe(0);
    expect(gitlab.net).toBe(0);
    expect(gitlab.daily).toEqual([]);
    expect(gitlab.byProject).toEqual([]);
    expect(gitlab.resolved).toEqual([]);
  });

  // ── Seeded project: aggregator reflects real project.* rows ────────────────

  it("aggregates filed/fixed GitLab totals, daily buckets, projects, and resolved rows", async () => {
    const store = h.store();
    const adminDb = h.adminDb();

    // A filed GitLab tracked item (project_issue) — gitlab_tracking jsonb.
    await store.createTaskWithReservedId(
      { description: "filed a gitlab issue", column: "in-progress" },
      { taskId: "FN-GL-1", createdAt: IN_RANGE, updatedAt: IN_RANGE, applyDefaultWorkflowSteps: false },
    );
    await adminDb.execute(sql`
      UPDATE project.tasks SET
        gitlab_tracking = ${JSON.stringify({
          item: { iid: 10, projectPath: "acme/alpha", createdAt: IN_RANGE },
        })}::jsonb
      WHERE id = 'FN-GL-1'
    `);

    // A fixed GitLab source issue (done) with an exact closedAt timestamp.
    await store.createTaskWithReservedId(
      { description: "fixed a gitlab source issue", column: "done" },
      { taskId: "FN-GL-2", createdAt: IN_RANGE, updatedAt: IN_RANGE, applyDefaultWorkflowSteps: false },
    );
    await adminDb.execute(sql`
      UPDATE project.tasks SET
        source_issue_provider = 'gitlab',
        source_issue_repository = 'acme/beta',
        source_issue_number = 21,
        source_issue_url = 'https://gitlab.example.test/acme/beta/-/issues/21',
        source_issue_closed_at = ${IN_RANGE}
      WHERE id = 'FN-GL-2'
    `);

    const layer = h.layer();
    const range = { from: FROM, to: TO };

    const gitlab = await aggregateGitlabIssueAnalytics(layer, range);
    expect(gitlab.filed).toBe(1);
    expect(gitlab.fixed).toBe(1);
    expect(gitlab.net).toBe(0);
    expect(gitlab.byProject.map((p) => p.project)).toEqual(expect.arrayContaining(["acme/alpha", "acme/beta"]));
    expect(gitlab.resolved).toHaveLength(1);
    expect(gitlab.resolved[0].taskId).toBe("FN-GL-2");
    expect(gitlab.resolved[0].project).toBe("acme/beta");
    expect(gitlab.resolved[0].issueNumber).toBe(21);
    expect(gitlab.resolved[0].url).toBe("https://gitlab.example.test/acme/beta/-/issues/21");
    expect(gitlab.resolved[0].resolvedAtExact).toBe(true);
  });
});
