/**
 * FNXC:SqliteFinalRemoval 2026-06-25:
 * PostgreSQL-backed counterpart of store-github-tracking.test.ts (non-disk-reopen tests).
 *
 * Mirrors the githubTracking round-trip, updateTask patch, link/unlink, slim
 * list, archive/restore, and event-emission tests against PostgreSQL. The
 * disk-reopen tests from the original file are NOT duplicated because PG
 * persistence lives in the database, not on the filesystem — a PG "reopen"
 * is just a new connection against the same DB, which the shared harness
 * already exercises across beforeEach resets.
 *
 * The original SQLite test remains until SQLite is fully removed; this PG twin
 * is auto-skipped in CI without PostgreSQL (pgDescribe).
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import type { TaskGithubTrackedIssue } from "../../types.js";

const pgTest = pgDescribe;

pgTest("TaskStore github tracking (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_gh_tracking",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  const issue: TaskGithubTrackedIssue = {
    owner: "octocat",
    repo: "hello-world",
    number: 42,
    url: "https://github.com/octocat/hello-world/issues/42",
    createdAt: "2026-05-09T00:00:00.000Z",
  };

  it("round-trips githubTracking through updateGithubTracking", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "Track issue" });

    await store.updateGithubTracking(task.id, {
      enabled: true,
      repoOverride: "octocat/hello-world",
    });

    const updated = await store.getTask(task.id);
    expect(updated?.githubTracking).toEqual({
      enabled: true,
      repoOverride: "octocat/hello-world",
    });
  });

  it("persists githubTracking through generic updateTask patch flow", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "Patch issue" });

    await store.updateTask(task.id, {
      githubTracking: {
        enabled: true,
        repoOverride: "octocat/hello-world",
      },
    });

    const updated = await store.getTask(task.id);
    expect(updated?.githubTracking).toEqual({
      enabled: true,
      repoOverride: "octocat/hello-world",
    });
  });

  it("disables tracking via updateTask by unlinking issue and preserving repoOverride", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "Disable tracking patch" });

    await store.updateGithubTracking(task.id, {
      enabled: true,
      repoOverride: "octocat/hello-world",
      issue,
    });

    await store.updateTask(task.id, {
      githubTracking: { enabled: false },
    });

    const updated = await store.getTask(task.id);
    expect(updated?.githubTracking?.enabled).toBe(false);
    expect(updated?.githubTracking?.issue).toBeUndefined();
    expect(updated?.githubTracking?.repoOverride).toBe("octocat/hello-world");
    expect(updated?.githubTracking?.unlinkedAt).toBeTruthy();
  });

  it("re-enables tracking via updateTask without dropping repoOverride", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "Enable tracking patch" });

    await store.updateGithubTracking(task.id, {
      enabled: false,
      repoOverride: "octocat/hello-world",
    });

    await store.updateTask(task.id, {
      githubTracking: { enabled: true },
    });

    const updated = await store.getTask(task.id);
    expect(updated?.githubTracking).toEqual({
      enabled: true,
      repoOverride: "octocat/hello-world",
    });
  });

  it("clears githubTracking completely when updateTask receives null", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "Clear tracking patch" });

    await store.updateGithubTracking(task.id, {
      enabled: true,
      repoOverride: "octocat/hello-world",
      issue,
    });

    await store.updateTask(task.id, {
      githubTracking: null,
    });

    const updated = await store.getTask(task.id);
    expect(updated?.githubTracking).toBeUndefined();
  });

  it("links and unlinks tracked issue while preserving other tracking fields", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "Link issue" });

    await store.linkGithubIssue(task.id, issue);
    let updated = await store.getTask(task.id);
    expect(updated?.githubTracking?.enabled).toBe(true);
    expect(updated?.githubTracking?.issue).toEqual(issue);

    await store.updateGithubTracking(task.id, {
      enabled: false,
      repoOverride: "octocat/hello-world",
      issue,
    });
    await store.linkGithubIssue(task.id, issue);

    updated = await store.getTask(task.id);
    expect(updated?.githubTracking?.enabled).toBe(false);

    await store.unlinkGithubIssue(task.id);
    updated = await store.getTask(task.id);

    expect(updated?.githubTracking?.issue).toBeUndefined();
    expect(updated?.githubTracking?.unlinkedAt).toBeTruthy();
    expect(updated?.githubTracking?.enabled).toBe(false);
    expect(updated?.githubTracking?.repoOverride).toBe("octocat/hello-world");
  });

  it("does not emit task:updated for idempotent updateGithubTracking writes", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "No-op" });
    const updatedEvents: string[] = [];
    store.on("task:updated", (t) => updatedEvents.push(t.id));

    const tracking = { enabled: true, repoOverride: "octocat/hello-world" };
    await store.updateGithubTracking(task.id, tracking);
    await store.updateGithubTracking(task.id, tracking);

    expect(updatedEvents).toEqual([task.id]);
  });

  it("includes githubTracking in slim list paths", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "Slim list" });
    await store.updateGithubTracking(task.id, {
      enabled: true,
      repoOverride: "octocat/hello-world",
      issue,
    });

    const tasks = await store.listTasks({ slim: true });
    const listed = tasks.find((entry) => entry.id === task.id);

    expect(listed?.githubTracking?.enabled).toBe(true);
    expect(listed?.githubTracking?.repoOverride).toBe("octocat/hello-world");
    expect(listed?.githubTracking?.issue).toEqual(issue);

    const searched = await store.searchTasks("Slim list", { slim: true });
    expect(searched.find((entry) => entry.id === task.id)?.githubTracking?.issue).toEqual(issue);

    const modifiedSince = await store.listTasksModifiedSince("1970-01-01T00:00:00.000Z");
    expect(modifiedSince.tasks.find((entry) => entry.id === task.id)?.githubTracking?.issue).toEqual(issue);
  });

  it("preserves githubTracking through archive and restore", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "Archive tracking" });
    await store.updateGithubTracking(task.id, {
      enabled: true,
      repoOverride: "octocat/hello-world",
      issue,
    });

    await store.moveTask(task.id, "todo");
    await store.moveTask(task.id, "in-progress");
    await store.moveTask(task.id, "done");
    await store.archiveTask(task.id, false);
    const restored = await store.unarchiveTask(task.id);

    expect(restored.githubTracking).toEqual({
      enabled: true,
      repoOverride: "octocat/hello-world",
      issue,
    });
  });

  it("emits githubIssueAction metadata on task:deleted", async () => {
    const store = h.store();
    const taskWithExplicitAction = await store.createTask({ description: "Delete tracking metadata explicit" });
    const taskWithDefaultAction = await store.createTask({ description: "Delete tracking metadata default" });
    const deletedEvents: Array<{ id: string; action: string | undefined }> = [];

    store.on("task:deleted", (deletedTask, meta) => {
      deletedEvents.push({ id: deletedTask.id, action: meta?.githubIssueAction });
    });

    await store.deleteTask(taskWithExplicitAction.id, { githubIssueAction: "delete" });
    await store.deleteTask(taskWithDefaultAction.id);

    expect(deletedEvents).toEqual([
      { id: taskWithExplicitAction.id, action: "delete" },
      { id: taskWithDefaultAction.id, action: "auto" },
    ]);
  });
});
