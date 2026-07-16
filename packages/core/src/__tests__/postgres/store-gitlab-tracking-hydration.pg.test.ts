import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import type { TaskGitLabTrackedItem } from "../../types.js";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";

/*
FNXC:GitLabTracking 2026-07-16-05:38:
GitLab tracking must round-trip through the shared TaskStore registry on every
live and soft-deleted read surface. A persisted empty object means not filed
for analytics and must remain distinct from absent tracking, which hydrates as undefined.
*/
pgDescribe("TaskStore GitLab tracking hydration (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_gitlab_tracking_hydration",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  const item: TaskGitLabTrackedItem = {
    kind: "project_issue",
    id: 42,
    projectId: 7,
    iid: 2,
    projectPath: "acme/app",
    groupPath: "acme",
    url: "https://gitlab.example.com/acme/app/-/issues/2",
    instanceUrl: "https://gitlab.example.com",
    host: "gitlab.example.com",
    title: "Persisted GitLab issue",
    state: "opened",
    createdAt: "2026-07-16T00:00:00.000Z",
  };

  it("round-trips GitLab tracking across live and soft-deleted task reads", async () => {
    const store = h.store();
    const tracked = await store.createTask({
      description: "Tracked GitLab task",
      sourceIssue: {
        provider: "gitlab",
        repository: "acme/app",
        externalIssueId: "42",
        issueNumber: 2,
        url: item.url,
      },
      gitlabTracking: { item },
    });
    const empty = await store.createTask({ description: "Empty GitLab tracking", gitlabTracking: {} });
    const absent = await store.createTask({ description: "Absent GitLab tracking" });

    expect((await store.getTask(tracked.id))?.gitlabTracking?.item).toEqual(item);
    expect((await store.getTask(tracked.id))?.sourceIssue).toEqual({
      provider: "gitlab",
      repository: "acme/app",
      externalIssueId: "42",
      issueNumber: 2,
      url: item.url,
    });

    for (const slim of [false, true]) {
      const listed = await store.listTasks({ slim });
      const listedTask = listed.find((task) => task.id === tracked.id);
      expect(listedTask?.gitlabTracking?.item).toEqual(item);
      if (slim) expect(listedTask?.log).toEqual([]);
    }

    expect((await store.getTask(empty.id))?.gitlabTracking).toEqual({});
    expect((await store.listTasks({ slim: false })).find((task) => task.id === empty.id)?.gitlabTracking).toEqual({});
    expect((await store.getTask(absent.id))?.gitlabTracking).toBeUndefined();

    await store.deleteTask(tracked.id);

    for (const slim of [false, true]) {
      const deleted = await store.listTasks({ includeDeleted: true, slim });
      expect(deleted.find((task) => task.id === tracked.id)?.gitlabTracking?.item).toEqual(item);
    }
    expect((await store.getTask(tracked.id, { includeDeleted: true }))?.gitlabTracking?.item).toEqual(item);
    expect((await store.listTasksForGitlabTrackingReconcile()).tasks.find((task) => task.id === tracked.id)?.gitlabTracking?.item).toEqual(item);
  });
});
