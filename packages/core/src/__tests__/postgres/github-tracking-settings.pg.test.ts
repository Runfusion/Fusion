/**
 * FNXC:SqliteFinalRemoval 2026-06-25:
 * PostgreSQL-backed counterpart of github-tracking-settings.test.ts (persistence portion).
 *
 * The first two describe blocks (resolveTaskGithubTracking precedence tests)
 * are pure-function tests with no DB dependency, so they are NOT duplicated
 * here — they already run in the SQLite test file without any store. Only the
 * "github tracking task persistence" block is mirrored against PostgreSQL,
 * exercising createTask + updateGithubTracking + getTask backend-mode paths.
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

pgTest("github tracking task persistence (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_gh_tracking_settings",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  it("defaults new tasks to tracking off when no override exists", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "Default tracking off" });
    expect(task.githubTracking).toBeUndefined();
  });

  it("round-trips per-task githubTracking through create, load, and update", async () => {
    const store = h.store();
    const issue: TaskGithubTrackedIssue = {
      owner: "octocat",
      repo: "hello-world",
      number: 42,
      url: "https://github.com/octocat/hello-world/issues/42",
      createdAt: "2026-05-09T00:00:00.000Z",
    };

    const created = await store.createTask({
      description: "Track this",
      githubTracking: {
        enabled: true,
        repoOverride: "octocat/hello-world",
        issue,
      },
    });

    const loaded = await store.getTask(created.id);
    expect(loaded?.githubTracking).toEqual({
      enabled: true,
      repoOverride: "octocat/hello-world",
      issue,
    });

    await store.updateGithubTracking(created.id, {
      enabled: false,
      repoOverride: "octocat/updated-repo",
      issue,
    });

    const updated = await store.getTask(created.id);
    expect(updated?.githubTracking).toEqual({
      enabled: false,
      repoOverride: "octocat/updated-repo",
      issue,
    });
  });
});
