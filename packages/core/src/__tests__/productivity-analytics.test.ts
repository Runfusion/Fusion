import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { Database } from "../db.js";
import { aggregateProductivityAnalytics, HUMAN_LINES_PER_HOUR } from "../productivity-analytics.js";

function insertTaskWithFiles(db: Database, id: string, files: string[], updatedAt: string): void {
  db.prepare(
    `INSERT INTO tasks (id, description, "column", createdAt, updatedAt, modifiedFiles)
     VALUES (?, 'desc', 'todo', ?, ?, ?)`,
  ).run(id, updatedAt, updatedAt, JSON.stringify(files));
}

function insertCompletedTask(
  db: Database,
  id: string,
  opts: {
    cumulativeActiveMs?: number | null;
    executionCompletedAt: string | null;
    column?: string;
  },
): void {
  const createdAt = opts.executionCompletedAt ?? "2026-03-01T00:00:00.000Z";
  db.prepare(
    `INSERT INTO tasks
       (id, description, "column", createdAt, updatedAt, cumulativeActiveMs, executionCompletedAt)
     VALUES (?, 'desc', ?, ?, ?, ?, ?)`,
  ).run(
    id,
    opts.column ?? "done",
    createdAt,
    createdAt,
    opts.cumulativeActiveMs ?? null,
    opts.executionCompletedAt,
  );
}

function insertCommit(
  db: Database,
  id: string,
  sha: string,
  authoredAt: string,
  stats: { additions?: number | null; deletions?: number | null } = {},
): void {
  db.prepare(
    `INSERT INTO task_commit_associations
       (id, taskLineageId, taskIdSnapshot, commitSha, commitSubject, authoredAt,
        matchedBy, confidence, additions, deletions, createdAt, updatedAt)
     VALUES (?, 'lin-1', 't-1', ?, 'subj', ?, 'canonical-lineage-trailer', 'canonical', ?, ?, ?, ?)`,
  ).run(id, sha, authoredAt, stats.additions ?? null, stats.deletions ?? null, authoredAt, authoredAt);
}

function insertPr(db: Database, id: string, createdAtMs: number): void {
  db.prepare(
    `INSERT INTO pull_requests
       (id, sourceType, sourceId, repo, headBranch, state, createdAt, updatedAt)
     VALUES (?, 'task', ?, 'org/repo', ?, 'open', ?, ?)`,
  ).run(id, `src-${id}`, `branch-${id}`, createdAtMs, createdAtMs);
}

describe("productivity-analytics", () => {
  let tmpDir: string;
  let db: Database;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "kb-productivity-analytics-"));
    db = new Database(join(tmpDir, ".fusion"));
    db.init();
  });

  afterEach(async () => {
    db.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("counts modified files and language distribution", () => {
    insertTaskWithFiles(db, "t1", ["src/a.ts", "src/b.ts", "README.md"], "2026-03-01T00:00:00.000Z");
    insertTaskWithFiles(db, "t2", ["src/c.ts", "style.css"], "2026-03-02T00:00:00.000Z");

    const result = aggregateProductivityAnalytics(db, { from: "2026-03-01T00:00:00.000Z", to: "2026-03-31T00:00:00.000Z" });
    expect(result.modifiedFiles).toBe(5);
    const byLang = new Map(result.byLanguage.map((l) => [l.language, l.count]));
    expect(byLang.get("ts")).toBe(3);
    expect(byLang.get("md")).toBe(1);
    expect(byLang.get("css")).toBe(1);
    // sorted descending by count
    expect(result.byLanguage[0]).toEqual({ language: "ts", count: 3 });
  });

  it("counts commit associations and pull requests in range", () => {
    insertCommit(db, "c1", "sha1", "2026-03-01T00:00:00.000Z");
    insertCommit(db, "c2", "sha2", "2026-03-02T00:00:00.000Z");
    insertCommit(db, "c-old", "sha-old", "2025-01-01T00:00:00.000Z");

    insertPr(db, "pr1", Date.parse("2026-03-01T00:00:00.000Z"));
    insertPr(db, "pr2", Date.parse("2026-03-10T00:00:00.000Z"));
    insertPr(db, "pr-old", Date.parse("2025-01-01T00:00:00.000Z"));

    const result = aggregateProductivityAnalytics(db, { from: "2026-03-01T00:00:00.000Z", to: "2026-03-31T00:00:00.000Z" });
    expect(result.commits).toBe(2);
    expect(result.pullRequests).toBe(2);
  });

  it("reports LOC as unavailable (null + unavailable:true), never 0 when no stats exist", () => {
    insertTaskWithFiles(db, "t1", ["src/a.ts"], "2026-03-01T00:00:00.000Z");
    insertCommit(db, "c-null", "sha-null", "2026-03-01T00:00:00.000Z");
    const result = aggregateProductivityAnalytics(db, {});
    expect(result.loc).toEqual({ value: null, unavailable: true });
    expect(result.loc.value).not.toBe(0);
    expect(result.hoursSaved).toEqual({ value: null, unavailable: true });
    expect(result.hoursSaved.value).not.toBe(0);
  });

  it("sums additions and deletions into LOC and derives estimated hours saved when commit stats exist", () => {
    insertCommit(db, "c1", "sha1", "2026-03-01T00:00:00.000Z", { additions: 10, deletions: 5 });
    insertCommit(db, "c-old", "sha-old", "2025-01-01T00:00:00.000Z", { additions: 100, deletions: 100 });

    const result = aggregateProductivityAnalytics(db, { from: "2026-03-01T00:00:00.000Z", to: "2026-03-31T00:00:00.000Z" });
    expect(result.commits).toBe(1);
    expect(result.loc).toEqual({ value: 15, unavailable: false });
    expect(result.hoursSaved).toEqual({
      value: Math.round((15 / HUMAN_LINES_PER_HOUR) * 10) / 10,
      unavailable: false,
    });
  });

  it("keeps the LOC and hours-saved sentinels when in-range commit rows have only null stats", () => {
    insertCommit(db, "c1", "sha1", "2026-03-01T00:00:00.000Z");
    insertCommit(db, "c2", "sha2", "2026-03-02T00:00:00.000Z", { additions: null, deletions: null });

    const result = aggregateProductivityAnalytics(db, { from: "2026-03-01T00:00:00.000Z", to: "2026-03-31T00:00:00.000Z" });
    expect(result.commits).toBe(2);
    expect(result.loc).toEqual({ value: null, unavailable: true });
    expect(result.loc.value).not.toBe(0);
    expect(result.hoursSaved).toEqual({ value: null, unavailable: true });
    expect(result.hoursSaved.value).not.toBe(0);
  });

  it("sums only valued LOC rows and hours saved while allowing partial commit-stat coverage", () => {
    insertCommit(db, "c-null", "sha-null", "2026-03-01T00:00:00.000Z");
    insertCommit(db, "c-additions", "sha-additions", "2026-03-02T00:00:00.000Z", { additions: 7 });
    insertCommit(db, "c-deletions", "sha-deletions", "2026-03-03T00:00:00.000Z", { deletions: 4 });

    const result = aggregateProductivityAnalytics(db, { from: "2026-03-01T00:00:00.000Z", to: "2026-03-31T00:00:00.000Z" });
    expect(result.commits).toBe(3);
    expect(result.loc).toEqual({ value: 11, unavailable: false });
    expect(result.hoursSaved).toEqual({
      value: Math.round((11 / HUMAN_LINES_PER_HOUR) * 10) / 10,
      unavailable: false,
    });
  });

  it("computes completed-task duration stats for done tasks completed in range", () => {
    insertCompletedTask(db, "d1", { cumulativeActiveMs: 1_000, executionCompletedAt: "2026-03-01T00:00:00.000Z" });
    insertCompletedTask(db, "d2", { cumulativeActiveMs: 2_000, executionCompletedAt: "2026-03-02T00:00:00.000Z" });
    insertCompletedTask(db, "d3", { cumulativeActiveMs: 3_000, executionCompletedAt: "2026-03-03T00:00:00.000Z" });
    insertCompletedTask(db, "d4", { cumulativeActiveMs: 4_000, executionCompletedAt: "2026-03-04T00:00:00.000Z" });

    const result = aggregateProductivityAnalytics(db, { from: "2026-03-01T00:00:00.000Z", to: "2026-03-31T00:00:00.000Z" });
    expect(result.taskDuration).toEqual({
      completedTasks: 4,
      averageMs: 2_500,
      medianMs: 2_500,
      p90Ms: 4_000,
      totalMs: 10_000,
      unavailable: false,
    });
  });

  it("excludes completed-task durations outside the executionCompletedAt range", () => {
    insertCompletedTask(db, "before", { cumulativeActiveMs: 9_000, executionCompletedAt: "2026-02-28T23:59:59.999Z" });
    insertCompletedTask(db, "inside", { cumulativeActiveMs: 2_000, executionCompletedAt: "2026-03-01T00:00:00.000Z" });
    insertCompletedTask(db, "after", { cumulativeActiveMs: 8_000, executionCompletedAt: "2026-04-01T00:00:00.000Z" });

    const result = aggregateProductivityAnalytics(db, { from: "2026-03-01T00:00:00.000Z", to: "2026-03-31T23:59:59.999Z" });
    expect(result.taskDuration).toEqual({
      completedTasks: 1,
      averageMs: 2_000,
      medianMs: 2_000,
      p90Ms: 2_000,
      totalMs: 2_000,
      unavailable: false,
    });
  });

  it("excludes non-done tasks and null or zero cumulativeActiveMs durations", () => {
    insertCompletedTask(db, "todo", { cumulativeActiveMs: 1_000, executionCompletedAt: "2026-03-01T00:00:00.000Z", column: "todo" });
    insertCompletedTask(db, "null-duration", { cumulativeActiveMs: null, executionCompletedAt: "2026-03-02T00:00:00.000Z" });
    insertCompletedTask(db, "zero-duration", { cumulativeActiveMs: 0, executionCompletedAt: "2026-03-03T00:00:00.000Z" });
    insertCompletedTask(db, "valid", { cumulativeActiveMs: 5_000, executionCompletedAt: "2026-03-04T00:00:00.000Z" });

    const result = aggregateProductivityAnalytics(db, { from: "2026-03-01T00:00:00.000Z", to: "2026-03-31T00:00:00.000Z" });
    expect(result.taskDuration).toEqual({
      completedTasks: 1,
      averageMs: 5_000,
      medianMs: 5_000,
      p90Ms: 5_000,
      totalMs: 5_000,
      unavailable: false,
    });
  });

  it("reports task duration as unavailable, never zero, when no qualifying durations exist", () => {
    insertCompletedTask(db, "zero-duration", { cumulativeActiveMs: 0, executionCompletedAt: "2026-03-01T00:00:00.000Z" });
    insertCompletedTask(db, "todo", { cumulativeActiveMs: 1_000, executionCompletedAt: "2026-03-02T00:00:00.000Z", column: "todo" });

    const result = aggregateProductivityAnalytics(db, { from: "2026-03-01T00:00:00.000Z", to: "2026-03-31T00:00:00.000Z" });
    expect(result.taskDuration).toEqual({
      completedTasks: 0,
      averageMs: null,
      medianMs: null,
      p90Ms: null,
      totalMs: null,
      unavailable: true,
    });
    expect(result.taskDuration.averageMs).not.toBe(0);
    expect(result.taskDuration.medianMs).not.toBe(0);
    expect(result.taskDuration.p90Ms).not.toBe(0);
    expect(result.taskDuration.totalMs).not.toBe(0);
  });

  it("empty range returns zeroed structures, not nulls", () => {
    insertTaskWithFiles(db, "t1", ["src/a.ts"], "2026-03-01T00:00:00.000Z");
    insertCommit(db, "c1", "sha1", "2026-03-01T00:00:00.000Z");
    insertPr(db, "pr1", Date.parse("2026-03-01T00:00:00.000Z"));
    insertCompletedTask(db, "d1", { cumulativeActiveMs: 1_000, executionCompletedAt: "2026-03-01T00:00:00.000Z" });

    const result = aggregateProductivityAnalytics(db, { from: "2027-01-01T00:00:00.000Z", to: "2027-12-31T00:00:00.000Z" });
    expect(result.modifiedFiles).toBe(0);
    expect(result.byLanguage).toEqual([]);
    expect(result.commits).toBe(0);
    expect(result.pullRequests).toBe(0);
    // LOC, derived hours, and task duration are unavailable regardless of range.
    expect(result.loc).toEqual({ value: null, unavailable: true });
    expect(result.hoursSaved).toEqual({ value: null, unavailable: true });
    expect(result.hoursSaved.value).not.toBe(0);
    expect(result.taskDuration).toEqual({
      completedTasks: 0,
      averageMs: null,
      medianMs: null,
      p90Ms: null,
      totalMs: null,
      unavailable: true,
    });
    expect(result.taskDuration.totalMs).not.toBe(0);
  });

  it("includes a boundary task exactly at `from`", () => {
    insertTaskWithFiles(db, "boundary", ["x.ts"], "2026-03-01T00:00:00.000Z");
    const result = aggregateProductivityAnalytics(db, { from: "2026-03-01T00:00:00.000Z", to: "2026-03-31T00:00:00.000Z" });
    expect(result.modifiedFiles).toBe(1);
  });
});
