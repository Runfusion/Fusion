/**
 * FNXC:SqliteFinalRemoval 2026-06-25:
 * PostgreSQL-backed counterpart of store-review-comments.test.ts.
 *
 * Exercises the addComment backend-mode path (comments-ops.ts delegates to
 * async-comments-attachments.ts when store.backendMode is true) plus the
 * dedup-by-source+externalId invariant and interleave semantics.
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

const pgTest = pgDescribe;

pgTest("TaskStore review comment ingestion (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_review_comments",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  it("inserts github review comment metadata on first write", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "review ingest", column: "in-review" });

    await store.addComment(task.id, "Needs fixes", "github:alice", {
      skipRefinement: true,
      source: "github-review",
      externalId: "review-101",
      reviewState: "CHANGES_REQUESTED",
    });

    const updated = await store.getTask(task.id);
    expect(updated.comments).toHaveLength(1);
    expect(updated.comments?.[0]).toMatchObject({
      source: "github-review",
      externalId: "review-101",
      reviewState: "CHANGES_REQUESTED",
      author: "github:alice",
    });
  });

  it("deduplicates repeated writes by source + externalId", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "dedupe", column: "in-review" });

    await store.addComment(task.id, "Please address", "github:bob", {
      skipRefinement: true,
      source: "github-review",
      externalId: "review-102",
      reviewState: "CHANGES_REQUESTED",
    });
    await store.addComment(task.id, "Please address updated", "github:bob", {
      skipRefinement: true,
      source: "github-review",
      externalId: "review-102",
      reviewState: "CHANGES_REQUESTED",
    });

    const updated = await store.getTask(task.id);
    expect(updated.comments).toHaveLength(1);
    expect(updated.comments?.[0]?.text).toBe("Please address");
  });

  it("keeps interleaved review and review-comment threads distinct", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "interleave", column: "in-review" });

    await store.addComment(task.id, "Review summary", "github:alice", {
      skipRefinement: true,
      source: "github-review",
      externalId: "review-201",
      reviewState: "COMMENTED",
    });
    await store.addComment(task.id, "Inline comment 1", "github:alice", {
      skipRefinement: true,
      source: "github-review-comment",
      externalId: "comment-301",
      reviewState: "COMMENTED",
    });
    await store.addComment(task.id, "Inline comment 2", "github:alice", {
      skipRefinement: true,
      source: "github-review-comment",
      externalId: "comment-302",
      reviewState: "COMMENTED",
    });

    const updated = await store.getTask(task.id);
    expect(updated.comments).toHaveLength(3);
    expect(updated.comments?.map((comment) => `${comment.source}:${comment.externalId}`)).toEqual([
      "github-review:review-201",
      "github-review-comment:comment-301",
      "github-review-comment:comment-302",
    ]);
  });

  it("respects skipRefinement for done task github comments", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "done", column: "done" });

    await store.addComment(task.id, "changes requested", "github:reviewer", {
      skipRefinement: true,
      source: "github-review",
      externalId: "review-500",
      reviewState: "CHANGES_REQUESTED",
    });

    const tasks = await store.listTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.id).toBe(task.id);
  });
});
