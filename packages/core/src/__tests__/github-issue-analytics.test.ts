import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { Database } from "../db.js";
import { aggregateGithubIssueAnalytics } from "../github-issue-analytics.js";

function insertTrackedIssue(
  db: Database,
  id: string,
  issue: Record<string, unknown>,
  updatedAt = "2026-04-01T00:00:00.000Z",
): void {
  db.prepare(
    `INSERT INTO tasks (id, description, "column", createdAt, updatedAt, githubTracking)
     VALUES (?, 'desc', 'todo', ?, ?, ?)`,
  ).run(id, updatedAt, updatedAt, JSON.stringify({ issue }));
}

function insertRawGithubTracking(db: Database, id: string, githubTracking: string): void {
  db.prepare(
    `INSERT INTO tasks (id, description, "column", createdAt, updatedAt, githubTracking)
     VALUES (?, 'desc', 'todo', '2026-04-01T00:00:00.000Z', '2026-04-01T00:00:00.000Z', ?)`,
  ).run(id, githubTracking);
}

function insertSourceIssueTask(
  db: Database,
  id: string,
  opts: {
    provider: string;
    repository: string;
    column: string;
    updatedAt: string;
    closedAt?: string | null;
    issueNumber?: number;
  },
): void {
  db.prepare(
    `INSERT INTO tasks (
       id, description, "column", createdAt, updatedAt,
       sourceIssueProvider, sourceIssueRepository, sourceIssueExternalIssueId,
       sourceIssueNumber, sourceIssueUrl, sourceIssueClosedAt
     ) VALUES (?, 'desc', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    opts.column,
    opts.updatedAt,
    opts.updatedAt,
    opts.provider,
    opts.repository,
    String(opts.issueNumber ?? 1),
    opts.issueNumber ?? 1,
    `https://example.test/${id}`,
    opts.closedAt ?? null,
  );
}

describe("github-issue-analytics", () => {
  let tmpDir: string;
  let db: Database;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "kb-github-issue-analytics-"));
    db = new Database(join(tmpDir, ".fusion"));
    db.init();
  });

  afterEach(async () => {
    db.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("aggregates filed and fixed issue totals, daily buckets, and repositories", () => {
    insertTrackedIssue(db, "filed-a-1", {
      owner: "acme",
      repo: "alpha",
      number: 10,
      url: "https://github.com/acme/alpha/issues/10",
      createdAt: "2026-04-01T12:00:00.000Z",
    });
    insertTrackedIssue(db, "filed-a-2", {
      owner: "acme",
      repo: "alpha",
      number: 11,
      url: "https://github.com/acme/alpha/issues/11",
      createdAt: "2026-04-02T12:00:00.000Z",
    });
    insertTrackedIssue(db, "filed-b-1", {
      owner: "acme",
      repo: "beta",
      number: 12,
      url: "https://github.com/acme/beta/issues/12",
      createdAt: "2026-04-02T13:00:00.000Z",
    });
    insertTrackedIssue(db, "filed-old", {
      owner: "acme",
      repo: "old",
      number: 9,
      url: "https://github.com/acme/old/issues/9",
      createdAt: "2026-03-01T00:00:00.000Z",
    });

    insertSourceIssueTask(db, "fixed-a", {
      provider: "github",
      repository: "acme/alpha",
      column: "done",
      updatedAt: "2026-04-02T20:00:00.000Z",
      issueNumber: 20,
    });
    insertSourceIssueTask(db, "fixed-b", {
      provider: "github",
      repository: "acme/beta",
      column: "done",
      updatedAt: "2026-04-03T20:00:00.000Z",
      issueNumber: 21,
    });
    insertSourceIssueTask(db, "not-done", {
      provider: "github",
      repository: "acme/alpha",
      column: "todo",
      updatedAt: "2026-04-02T20:00:00.000Z",
      issueNumber: 22,
    });
    insertSourceIssueTask(db, "not-github", {
      provider: "gitlab",
      repository: "acme/alpha",
      column: "done",
      updatedAt: "2026-04-02T20:00:00.000Z",
      issueNumber: 23,
    });

    const result = aggregateGithubIssueAnalytics(db, {
      from: "2026-04-01T00:00:00.000Z",
      to: "2026-04-03T23:59:59.999Z",
    });

    expect(result.filed).toBe(3);
    expect(result.fixed).toBe(2);
    expect(result.net).toBe(1);
    expect(result.daily).toEqual([
      { date: "2026-04-01", filed: 1, fixed: 0 },
      { date: "2026-04-02", filed: 2, fixed: 1 },
      { date: "2026-04-03", filed: 0, fixed: 1 },
    ]);
    expect(result.byRepo).toEqual([
      { repo: "acme/alpha", filed: 2, fixed: 1 },
      { repo: "acme/beta", filed: 1, fixed: 1 },
    ]);
  });

  it("treats range bounds as inclusive", () => {
    insertTrackedIssue(db, "filed-from", {
      owner: "acme",
      repo: "alpha",
      number: 1,
      url: "https://github.com/acme/alpha/issues/1",
      createdAt: "2026-04-01T00:00:00.000Z",
    });
    insertSourceIssueTask(db, "fixed-to", {
      provider: "github",
      repository: "acme/alpha",
      column: "done",
      updatedAt: "2026-04-03T00:00:00.000Z",
    });

    const result = aggregateGithubIssueAnalytics(db, {
      from: "2026-04-01T00:00:00.000Z",
      to: "2026-04-03T00:00:00.000Z",
    });

    expect(result.filed).toBe(1);
    expect(result.fixed).toBe(1);
    expect(result.daily).toEqual([
      { date: "2026-04-01", filed: 1, fixed: 0 },
      { date: "2026-04-03", filed: 0, fixed: 1 },
    ]);
  });

  it("prefers source issue closedAt over updatedAt for fixed range and daily buckets", () => {
    insertSourceIssueTask(db, "closed-in-range-updated-outside", {
      provider: "github",
      repository: "acme/alpha",
      column: "done",
      updatedAt: "2026-03-01T00:00:00.000Z",
      closedAt: "2026-04-02T10:00:00.000Z",
      issueNumber: 31,
    });
    insertSourceIssueTask(db, "closed-outside-updated-in-range", {
      provider: "github",
      repository: "acme/alpha",
      column: "done",
      updatedAt: "2026-04-03T10:00:00.000Z",
      closedAt: "2026-03-31T23:59:59.999Z",
      issueNumber: 32,
    });
    insertSourceIssueTask(db, "no-closedAt-falls-back", {
      provider: "github",
      repository: "acme/beta",
      column: "done",
      updatedAt: "2026-04-03T10:00:00.000Z",
      issueNumber: 33,
    });

    const result = aggregateGithubIssueAnalytics(db, {
      from: "2026-04-01T00:00:00.000Z",
      to: "2026-04-03T23:59:59.999Z",
    });

    expect(result.fixed).toBe(2);
    expect(result.daily).toEqual([
      { date: "2026-04-02", filed: 0, fixed: 1 },
      { date: "2026-04-03", filed: 0, fixed: 1 },
    ]);
    expect(result.byRepo).toEqual([
      { repo: "acme/alpha", filed: 0, fixed: 1 },
      { repo: "acme/beta", filed: 0, fixed: 1 },
    ]);
  });

  it("returns zeroed structures for an empty range", () => {
    insertTrackedIssue(db, "filed", {
      owner: "acme",
      repo: "alpha",
      number: 1,
      url: "https://github.com/acme/alpha/issues/1",
      createdAt: "2026-04-01T00:00:00.000Z",
    });
    insertSourceIssueTask(db, "fixed", {
      provider: "github",
      repository: "acme/alpha",
      column: "done",
      updatedAt: "2026-04-01T00:00:00.000Z",
    });

    const result = aggregateGithubIssueAnalytics(db, {
      from: "2027-01-01T00:00:00.000Z",
      to: "2027-01-31T00:00:00.000Z",
    });

    expect(result).toMatchObject({
      from: "2027-01-01T00:00:00.000Z",
      to: "2027-01-31T00:00:00.000Z",
      filed: 0,
      fixed: 0,
      net: 0,
      daily: [],
      byRepo: [],
    });
  });

  it("skips malformed tracking JSON and issue-less rows without throwing", () => {
    insertRawGithubTracking(db, "bad-json", "{not json");
    insertRawGithubTracking(db, "empty-object", "{}");
    insertRawGithubTracking(db, "no-issue", JSON.stringify({ enabled: true }));

    expect(() => aggregateGithubIssueAnalytics(db, {})).not.toThrow();
    expect(aggregateGithubIssueAnalytics(db, {})).toMatchObject({
      filed: 0,
      fixed: 0,
      daily: [],
      byRepo: [],
    });
  });

  it("counts undated filed issues in totals without fabricating a daily date", () => {
    insertTrackedIssue(db, "undated", {
      owner: "acme",
      repo: "alpha",
      number: 1,
      url: "https://github.com/acme/alpha/issues/1",
    });

    const result = aggregateGithubIssueAnalytics(db, {
      from: "2026-04-01T00:00:00.000Z",
      to: "2026-04-30T00:00:00.000Z",
    });

    expect(result.filed).toBe(1);
    expect(result.daily).toEqual([]);
    expect(result.byRepo).toEqual([{ repo: "acme/alpha", filed: 1, fixed: 0 }]);
  });
});
