import { afterEach, beforeAll, beforeEach, afterAll, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { TaskGitLabTrackedItem } from "../types.js";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../__test-utils__/pg-test-harness.js";

const pgTest = pgDescribe;

const gitlabItem: TaskGitLabTrackedItem = {
  kind: "project_issue",
  url: "https://gitlab.com/acme/app/-/issues/42",
  instanceUrl: "https://gitlab.com",
  host: "gitlab.com",
  iid: 42,
  projectPath: "acme/app",
  title: "Tracked GitLab issue",
  state: "opened",
};

/*
 * FNXC:GitLabReconcile 2026-07-12-00:00:
 * listTasksForGitlabTrackingReconcile returns soft-deleted tasks with
 * gitlab_tracking JSONB through the same shared row mapper as normal task reads.
 * The test seeds the column directly via adminDb to exercise reconciliation of
 * externally persisted tracking metadata. Archived tasks are a separate async
 * subsystem not surfaced through this API (same limitation as the GitHub reconcile).
 */
pgTest("TaskStore.listTasksForGitlabTrackingReconcile", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_gitlab_reconcile",
  });

  beforeAll(h.beforeAll);
  afterAll(h.afterAll);
  beforeEach(async () => {
    await h.beforeEach();
  });
  afterEach(async () => {
    await h.afterEach();
  });

  it("returns soft-deleted tasks with GitLab tracking, excludes active and non-tracked", async () => {
    const store = h.store();
    const softDeleted = await store.createTask({ description: "soft deleted" });
    // Seed externally persisted gitlab_tracking directly for reconcile coverage.
    await h.adminDb().execute(
      sql`UPDATE project.tasks SET gitlab_tracking = ${JSON.stringify({ item: gitlabItem })}::jsonb WHERE id = ${softDeleted.id}`,
    );
    await store.deleteTask(softDeleted.id);

    const activeTracked = await store.createTask({ description: "active tracked" });
    await h.adminDb().execute(
      sql`UPDATE project.tasks SET gitlab_tracking = ${JSON.stringify({ item: gitlabItem })}::jsonb WHERE id = ${activeTracked.id}`,
    );

    const githubDeleted = await store.createTask({
      description: "github deleted",
      githubTracking: { enabled: true, repoOverride: "octo/repo" },
    });
    await store.deleteTask(githubDeleted.id);

    const { tasks, hasMore } = await store.listTasksForGitlabTrackingReconcile();
    const byId = new Map(tasks.map((task) => [task.id, task]));

    expect(byId.has(softDeleted.id)).toBe(true);
    expect(byId.get(softDeleted.id)?.gitlabTracking?.item).toEqual(gitlabItem);
    expect(byId.has(activeTracked.id)).toBe(false);
    expect(byId.has(githubDeleted.id)).toBe(false);
    expect(hasMore).toBe(false);
  });

  it("returns empty results when nothing matches", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "no gitlab tracking" });
    await store.moveTask(task.id, "todo");

    await expect(store.listTasksForGitlabTrackingReconcile()).resolves.toEqual({ tasks: [], hasMore: false });
  });

  it("paginates across soft-deleted GitLab tracked entries", async () => {
    const store = h.store();
    for (let i = 0; i < 3; i += 1) {
      const task = await store.createTask({ description: `deleted ${i}` });
      await h.adminDb().execute(
        sql`UPDATE project.tasks SET gitlab_tracking = ${JSON.stringify({ item: { ...gitlabItem, iid: 100 + i } })}::jsonb WHERE id = ${task.id}`,
      );
      await store.deleteTask(task.id);
    }

    const page1 = await store.listTasksForGitlabTrackingReconcile({ offset: 0, limit: 2 });
    const page2 = await store.listTasksForGitlabTrackingReconcile({ offset: 2, limit: 2 });

    expect(page1.tasks).toHaveLength(2);
    expect(page2.tasks).toHaveLength(1);
    expect(new Set([...page1.tasks, ...page2.tasks].map((task) => task.id)).size).toBe(3);
    expect(page1.hasMore).toBe(true);
    expect(page2.hasMore).toBe(false);
  });
});
