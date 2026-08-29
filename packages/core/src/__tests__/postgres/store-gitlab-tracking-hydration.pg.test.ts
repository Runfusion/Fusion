import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import type { TaskGitLabTrackedItem } from "../../types.js";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";

/*
FNXC:GitLabTracking 2026-07-16-13:00:
GitLab import provenance must round-trip through every shared TaskStore read path
and archive/restore. Missing tracking remains undefined, while a populated item
must retain its full payload so imports can be reconciled after restoration.
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

  it("round-trips GitLab tracking across every live read and archive restore", async () => {
    const store = h.store();
    const modifiedSince = "1970-01-01T00:00:00.000Z";
    const sourceIssue = {
      provider: "gitlab" as const,
      repository: "acme/app",
      externalIssueId: "42",
      issueNumber: 2,
      url: item.url,
    };
    const tracked = await store.createTask({
      description: "Tracked GitLab task",
      sourceIssue,
      gitlabTracking: { item },
    });
    const absent = await store.createTask({ description: "Absent GitLab tracking" });

    expect((await store.getTask(tracked.id))?.gitlabTracking?.item).toEqual(item);
    expect((await store.getTask(tracked.id))?.sourceIssue).toEqual(sourceIssue);
    expect((await store.getTask(absent.id))?.gitlabTracking).toBeUndefined();

    for (const slim of [false, true]) {
      const listed = await store.listTasks({ slim });
      const listedTask = listed.find((task) => task.id === tracked.id);
      expect(listedTask?.gitlabTracking?.item).toEqual(item);
      if (slim) expect(listedTask?.log).toEqual([]);
    }

    const searched = await store.searchTasks("Tracked GitLab task", { slim: true });
    expect(searched.find((task) => task.id === tracked.id)?.gitlabTracking?.item).toEqual(item);

    const modified = await store.listTasksModifiedSince(modifiedSince);
    expect(modified.tasks.find((task) => task.id === tracked.id)?.gitlabTracking?.item).toEqual(item);

    await store.moveTask(tracked.id, "todo");
    await store.moveTask(tracked.id, "in-progress");
    await store.moveTask(tracked.id, "done");
    await store.archiveTask(tracked.id, false);
    const restored = await store.unarchiveTask(tracked.id);

    expect(restored.gitlabTracking?.item).toEqual(item);
    expect((await store.getTask(tracked.id))?.gitlabTracking?.item).toEqual(item);
  });
});
