/**
 * FNXC:SqliteFinalRemoval 2026-06-25:
 * PostgreSQL-backed counterpart of the updatePrInfo subset of
 * store-comments.test.ts.
 *
 * Exercises the backend-mode (asyncLayer) path for PR info persistence
 * (stored in the tasks.pr_info jsonb column). Covers add/update/clear,
 * event emission, conflict-diagnostics round-trip, and concurrent
 * serialization.
 *
 * The original SQLite test remains until SQLite is fully removed; this PG
 * twin is auto-skipped in CI without PostgreSQL (pgDescribe).
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";

const pgTest = pgDescribe;

pgTest("TaskStore updatePrInfo (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_pr_info",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  it("adds PR info to a task without existing PR", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "pr link" });
    const prInfo = {
      url: "https://github.com/owner/repo/pull/42",
      number: 42,
      status: "open" as const,
      title: "Fix the bug",
      headBranch: "kb-001-fix-bug",
      baseBranch: "main",
      commentCount: 0,
    };

    const updated = await store.updatePrInfo(task.id, prInfo);

    expect(updated.prInfo).toEqual(prInfo);
    expect(updated.log.some((l) => l.action === "PR linked" && l.outcome?.includes("#42"))).toBe(true);
  });

  it("keeps PR number/url after moving task to done", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "pr to done" });
    const prInfo = {
      url: "https://github.com/owner/repo/pull/42",
      number: 42,
      status: "open" as const,
      title: "Fix the bug",
      headBranch: "kb-001-fix-bug",
      baseBranch: "main",
      commentCount: 0,
    };

    await store.updatePrInfo(task.id, prInfo);
    await store.moveTask(task.id, "todo", { moveSource: "user" });
    await store.moveTask(task.id, "in-progress", { moveSource: "user" });
    await store.moveTask(task.id, "in-review", { moveSource: "user", allowDirectInReviewMove: true });
    await store.moveTask(task.id, "done", { moveSource: "engine", skipMergeBlocker: true });

    const updated = await store.getTask(task.id);
    expect(updated.prInfo?.number).toBe(42);
    expect(updated.prInfo?.url).toBe("https://github.com/owner/repo/pull/42");
  });

  it("updates existing PR info with new values", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "pr update" });
    const prInfo1 = {
      url: "https://github.com/owner/repo/pull/1",
      number: 1,
      status: "open" as const,
      title: "Initial PR",
      headBranch: "branch-1",
      baseBranch: "main",
      commentCount: 0,
    };
    await store.updatePrInfo(task.id, prInfo1);

    const prInfo2 = {
      url: "https://github.com/owner/repo/pull/1",
      number: 1,
      status: "merged" as const,
      title: "Initial PR (updated)",
      headBranch: "branch-1",
      baseBranch: "main",
      commentCount: 3,
      lastCommentAt: "2026-01-01T00:00:00.000Z",
    };
    const updated = await store.updatePrInfo(task.id, prInfo2);

    expect(updated.prInfo?.status).toBe("merged");
    expect(updated.prInfo?.commentCount).toBe(3);
    expect(updated.prInfo?.lastCommentAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("clears PR info when passed null", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "pr clear" });
    const prInfo = {
      url: "https://github.com/owner/repo/pull/42",
      number: 42,
      status: "open" as const,
      title: "Fix the bug",
      headBranch: "kb-001-fix-bug",
      baseBranch: "main",
      commentCount: 0,
    };
    await store.updatePrInfo(task.id, prInfo);

    const updated = await store.updatePrInfo(task.id, null);

    expect(updated.prInfo).toBeUndefined();
    expect(updated.log.some((l) => l.action === "PR unlinked")).toBe(true);
  });

  it("emits task:updated event when PR info changes", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "pr event" });
    const events: any[] = [];
    store.on("task:updated", (t) => events.push(t));

    const prInfo = {
      url: "https://github.com/owner/repo/pull/42",
      number: 42,
      status: "open" as const,
      title: "Fix the bug",
      headBranch: "kb-001-fix-bug",
      baseBranch: "main",
      commentCount: 0,
    };
    await store.updatePrInfo(task.id, prInfo);

    expect(events).toHaveLength(1);
    expect(events[0].prInfo?.number).toBe(42);
  });

  it("persists to store and round-trips correctly", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "pr persist" });
    const prInfo = {
      url: "https://github.com/owner/repo/pull/42",
      number: 42,
      status: "open" as const,
      title: "Fix the bug",
      headBranch: "kb-001-fix-bug",
      baseBranch: "main",
      commentCount: 5,
      lastCommentAt: "2026-03-30T12:00:00.000Z",
    };

    await store.updatePrInfo(task.id, prInfo);
    const fetched = await store.getTask(task.id);

    expect(fetched.prInfo).toEqual(prInfo);
  });

  it("round-trips PR conflict diagnostics and keeps the field optional", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "pr conflict diag" });
    const prInfo = {
      url: "https://github.com/owner/repo/pull/42",
      number: 42,
      status: "open" as const,
      title: "Fix the bug",
      headBranch: "kb-001-fix-bug",
      baseBranch: "main",
      commentCount: 5,
      mergeable: "conflicting" as const,
      conflictDiagnostics: {
        conflictingFiles: ["packages/dashboard/src/github.ts"],
        suggestedCommands: ["git fetch origin", "git rebase origin/main"],
        capturedAt: "2026-05-18T00:00:00.000Z",
      },
    };

    await store.updatePrInfo(task.id, prInfo);
    const fetched = await store.getTask(task.id);
    expect(fetched.prInfo).toEqual(prInfo);

    const prInfoWithoutDiagnostics = {
      ...prInfo,
      mergeable: "clean" as const,
      conflictDiagnostics: undefined,
    };
    await store.updatePrInfo(task.id, prInfoWithoutDiagnostics);

    const fetchedWithoutDiagnostics = await store.getTask(task.id);
    expect(fetchedWithoutDiagnostics.prInfo?.conflictDiagnostics).toBeUndefined();
  });

  it("serializes concurrent updates correctly", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "pr concurrent" });

    const promises = Array.from({ length: 5 }, (_, i) =>
      store.updatePrInfo(task.id, {
        url: `https://github.com/owner/repo/pull/${i + 1}`,
        number: i + 1,
        status: "open" as const,
        title: `PR ${i + 1}`,
        headBranch: `branch-${i + 1}`,
        baseBranch: "main",
        commentCount: i,
      }),
    );

    await Promise.all(promises);

    const result = await store.getTask(task.id);

    expect(result.prInfo).toBeDefined();
    expect(result.prInfo!.number).toBeGreaterThanOrEqual(1);
    expect(result.prInfo!.number).toBeLessThanOrEqual(5);

    const prLogs = result.log.filter((l) => l.action === "PR linked");
    expect(prLogs).toHaveLength(5);
  });
});
