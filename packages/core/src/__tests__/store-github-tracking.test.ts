import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { TaskGithubTrackedIssue } from "../types.js";
import { TaskStore } from "../store.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "kb-store-github-tracking-test-"));
}

describe("TaskStore github tracking", () => {
  let rootDir: string;
  let globalDir: string;
  let store: TaskStore;

  beforeEach(async () => {
    rootDir = makeTmpDir();
    globalDir = makeTmpDir();
    store = new TaskStore(rootDir, globalDir, { inMemoryDb: true });
    await store.init();
  });

  afterEach(async () => {
    store.close();
    await rm(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    await rm(globalDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  async function reopenDiskBackedStore(
    setup: (diskStore: TaskStore) => Promise<void>,
    assertions: (reloadedStore: TaskStore) => Promise<void>,
  ): Promise<void> {
    const diskRoot = makeTmpDir();
    const diskGlobal = makeTmpDir();

    try {
      const firstStore = new TaskStore(diskRoot, diskGlobal);
      await firstStore.init();
      await setup(firstStore);
      firstStore.close();

      const reloadedStore = new TaskStore(diskRoot, diskGlobal);
      await reloadedStore.init();
      try {
        await assertions(reloadedStore);
      } finally {
        reloadedStore.close();
      }
    } finally {
      await rm(diskRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      await rm(diskGlobal, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }

  const issue: TaskGithubTrackedIssue = {
    owner: "octocat",
    repo: "hello-world",
    number: 42,
    url: "https://github.com/octocat/hello-world/issues/42",
    createdAt: "2026-05-09T00:00:00.000Z",
  };

  it("round-trips githubTracking through updateGithubTracking", async () => {
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

  it("links and unlinks tracked issue while preserving other tracking fields", async () => {
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
    const task = await store.createTask({ description: "No-op" });
    const updatedEvents: string[] = [];
    store.on("task:updated", (t) => updatedEvents.push(t.id));

    const tracking = { enabled: true, repoOverride: "octocat/hello-world" };
    await store.updateGithubTracking(task.id, tracking);
    await store.updateGithubTracking(task.id, tracking);

    expect(updatedEvents).toEqual([task.id]);
  });

  it("omits githubTracking in slim list paths", async () => {
    const task = await store.createTask({ description: "Slim list" });
    await store.updateGithubTracking(task.id, { enabled: true, repoOverride: "octocat/hello-world" });

    const tasks = await store.listTasks({ slim: true });
    const listed = tasks.find((entry) => entry.id === task.id);

    expect(listed?.githubTracking).toBeUndefined();
  });

  it("preserves githubTracking through archive and restore", async () => {
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

  it("persists githubTracking across store restart for detail and non-slim listings", async () => {
    await reopenDiskBackedStore(
      async (diskStore) => {
        const created = await diskStore.createTask({ description: "Restart tracking" });
        await diskStore.updateGithubTracking(created.id, {
          enabled: true,
          repoOverride: "octocat/hello-world",
          issue,
        });
      },
      async (reloadedStore) => {
        const reloadedTask = (await reloadedStore.listTasks()).find((task) => task.description === "Restart tracking");
        expect(reloadedTask?.githubTracking).toEqual({
          enabled: true,
          repoOverride: "octocat/hello-world",
          issue,
        });

        const fetched = await reloadedStore.getTask(reloadedTask!.id);
        expect(fetched.githubTracking).toEqual({
          enabled: true,
          repoOverride: "octocat/hello-world",
          issue,
        });

        const slim = await reloadedStore.listTasks({ slim: true });
        expect(slim.find((task) => task.id === reloadedTask!.id)?.githubTracking).toBeUndefined();
      },
    );
  });

  it("persists disabled state, repo override, and issue mutations across repeated restarts", async () => {
    const diskRoot = makeTmpDir();
    const diskGlobal = makeTmpDir();

    try {
      let firstStore = new TaskStore(diskRoot, diskGlobal);
      await firstStore.init();
      const created = await firstStore.createTask({ description: "Restart tracking mutations" });
      await firstStore.updateGithubTracking(created.id, {
        enabled: false,
        repoOverride: "octocat/hello-world",
        issue,
      });
      firstStore.close();

      let secondStore = new TaskStore(diskRoot, diskGlobal);
      await secondStore.init();
      // FN-4161 repro: SQLite restart hydration is intact; downstream dashboard layers receive the correct value from core.
      expect((await secondStore.getTask(created.id)).githubTracking).toEqual({
        enabled: false,
        repoOverride: "octocat/hello-world",
        issue,
      });
      expect((await secondStore.listTasks()).find((task) => task.id === created.id)?.githubTracking).toEqual({
        enabled: false,
        repoOverride: "octocat/hello-world",
        issue,
      });

      await secondStore.unlinkGithubIssue(created.id);
      expect((await secondStore.getTask(created.id)).githubTracking?.issue).toBeUndefined();
      secondStore.close();

      let thirdStore = new TaskStore(diskRoot, diskGlobal);
      await thirdStore.init();
      const afterUnlink = await thirdStore.getTask(created.id);
      expect(afterUnlink.githubTracking?.enabled).toBe(false);
      expect(afterUnlink.githubTracking?.repoOverride).toBe("octocat/hello-world");
      expect(afterUnlink.githubTracking?.issue).toBeUndefined();
      expect(afterUnlink.githubTracking?.unlinkedAt).toBeTruthy();

      await thirdStore.linkGithubIssue(created.id, issue);
      await thirdStore.updateGithubTracking(created.id, {
        enabled: false,
        repoOverride: "octocat/renamed-repo",
        issue,
      });
      thirdStore.close();

      const fourthStore = new TaskStore(diskRoot, diskGlobal);
      await fourthStore.init();
      try {
        const fetched = await fourthStore.getTask(created.id);
        expect(fetched.githubTracking).toEqual({
          enabled: false,
          repoOverride: "octocat/renamed-repo",
          issue,
        });
        expect((await fourthStore.listTasks({ slim: true })).find((task) => task.id === created.id)?.githubTracking).toBeUndefined();
      } finally {
        fourthStore.close();
      }
    } finally {
      await rm(diskRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      await rm(diskGlobal, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});
