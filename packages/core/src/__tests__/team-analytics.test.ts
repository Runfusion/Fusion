import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { Database } from "../db.js";
import { aggregateTeamAnalytics } from "../team-analytics.js";

interface TaskSeed {
  id: string;
  agentId?: string | null;
  column?: string;
  columnMovedAt?: string | null;
  updatedAt?: string;
  modifiedFiles?: unknown;
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number | null;
  tokenUsageLastUsedAt?: string | null;
  modelProvider?: string | null;
  modelId?: string | null;
}

function insertAgent(db: Database, id: string, name: string, role = "executor", state = "idle"): void {
  db.prepare(
    `INSERT INTO agents (id, name, role, state, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, '2026-03-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z')`,
  ).run(id, name, role, state);
}

function modifiedFilesValue(value: unknown): string | null {
  if (value === undefined) return "[]";
  if (value === null) return null;
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function insertTask(db: Database, task: TaskSeed): void {
  const updatedAt = task.updatedAt ?? "2026-03-01T00:00:00.000Z";
  db.prepare(
    `INSERT INTO tasks
       (id, description, "column", createdAt, updatedAt, columnMovedAt, assignedAgentId,
        modifiedFiles, tokenUsageInputTokens, tokenUsageOutputTokens, tokenUsageCachedTokens,
        tokenUsageCacheWriteTokens, tokenUsageTotalTokens, tokenUsageLastUsedAt, modelProvider, modelId)
     VALUES (?, 'desc', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    task.id,
    task.column ?? "todo",
    updatedAt,
    updatedAt,
    task.columnMovedAt ?? null,
    task.agentId ?? null,
    modifiedFilesValue(task.modifiedFiles),
    task.inputTokens ?? null,
    task.outputTokens ?? null,
    task.cachedTokens ?? null,
    task.cacheWriteTokens ?? null,
    task.totalTokens === undefined ? null : task.totalTokens,
    task.tokenUsageLastUsedAt ?? null,
    task.modelProvider ?? null,
    task.modelId ?? null,
  );
}

describe("team-analytics", () => {
  let tmpDir: string;
  let db: Database;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "kb-team-analytics-"));
    db = new Database(join(tmpDir, ".fusion"));
    db.init();
  });

  afterEach(async () => {
    db.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("aggregates multiple agents with token cost, files, completed tasks, and live state", () => {
    insertAgent(db, "agent-a", "Alpha", "executor", "running");
    insertAgent(db, "agent-b", "Beta", "reviewer", "idle");
    insertTask(db, {
      id: "a-tokens",
      agentId: "agent-a",
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      totalTokens: 2_000_000,
      tokenUsageLastUsedAt: "2026-03-02T00:00:00.000Z",
      modelProvider: "openai",
      modelId: "gpt-4o",
    });
    insertTask(db, {
      id: "a-done",
      agentId: "agent-a",
      column: "done",
      columnMovedAt: "2026-03-03T00:00:00.000Z",
      modifiedFiles: ["src/a.ts", "src/b.ts"],
      updatedAt: "2026-03-03T00:00:00.000Z",
    });
    insertTask(db, {
      id: "a-progress",
      agentId: "agent-a",
      column: "in-progress",
      modifiedFiles: ["docs/readme.md"],
      updatedAt: "2026-03-04T00:00:00.000Z",
    });
    insertTask(db, {
      id: "b-review",
      agentId: "agent-b",
      column: "in-review",
      inputTokens: 50,
      outputTokens: 25,
      totalTokens: 75,
      tokenUsageLastUsedAt: "2026-03-05T00:00:00.000Z",
      modelProvider: "openai",
      modelId: "gpt-4o-mini",
      modifiedFiles: ["src/c.ts"],
      updatedAt: "2026-03-05T00:00:00.000Z",
    });

    const result = aggregateTeamAnalytics(db, {
      from: "2026-03-01T00:00:00.000Z",
      to: "2026-03-31T00:00:00.000Z",
      now: Date.parse("2026-03-10T00:00:00.000Z"),
    });

    expect(result.from).toBe("2026-03-01T00:00:00.000Z");
    expect(result.to).toBe("2026-03-31T00:00:00.000Z");
    expect(result.agents.map((agent) => agent.agentId)).toEqual(["agent-a", "agent-b"]);

    const byAgent = new Map(result.agents.map((agent) => [agent.agentId, agent]));
    expect(byAgent.get("agent-a")).toMatchObject({
      agentName: "Alpha",
      role: "executor",
      state: "running",
      filesChanged: 3,
      tasksCompleted: 1,
      tasksInProgress: 1,
      tasksInReview: 0,
    });
    expect(byAgent.get("agent-a")?.tokens.totalTokens).toBe(2_000_000);
    expect(byAgent.get("agent-a")?.cost).toEqual({ usd: 12.5, unavailable: false, stale: false });
    expect(byAgent.get("agent-b")).toMatchObject({
      agentName: "Beta",
      role: "reviewer",
      state: "idle",
      filesChanged: 1,
      tasksCompleted: 0,
      tasksInProgress: 0,
      tasksInReview: 1,
    });
    expect(result.totals.tokens.totalTokens).toBe(2_000_075);
    expect(result.totals.filesChanged).toBe(4);
    expect(result.totals.tasksCompleted).toBe(1);
    expect(result.totals.tasksInProgress).toBe(1);
    expect(result.totals.tasksInReview).toBe(1);
  });

  it("returns zeroed totals and an empty agent array for an empty database", () => {
    const result = aggregateTeamAnalytics(db, {});

    expect(result.totals).toEqual({
      tokens: {
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 0,
        nTasks: 0,
      },
      cost: { usd: null, unavailable: false, stale: false },
      filesChanged: 0,
      tasksCompleted: 0,
      tasksInProgress: 0,
      tasksInReview: 0,
    });
    expect(result.agents).toEqual([]);
  });

  it("filters completed tasks by range while preserving current in-progress counts", () => {
    insertAgent(db, "agent-a", "Alpha");
    insertTask(db, {
      id: "done-before",
      agentId: "agent-a",
      column: "done",
      columnMovedAt: "2026-02-28T23:59:59.999Z",
    });
    insertTask(db, {
      id: "done-in-range",
      agentId: "agent-a",
      column: "done",
      columnMovedAt: "2026-03-01T00:00:00.000Z",
    });
    insertTask(db, { id: "active", agentId: "agent-a", column: "in-progress" });

    const result = aggregateTeamAnalytics(db, {
      from: "2026-03-01T00:00:00.000Z",
      to: "2026-03-31T00:00:00.000Z",
    });

    expect(result.agents[0].tasksCompleted).toBe(1);
    expect(result.agents[0].tasksInProgress).toBe(1);
  });

  it("keeps a safe row for a task whose agent row was deleted", () => {
    insertTask(db, {
      id: "orphan",
      agentId: "deleted-agent",
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      tokenUsageLastUsedAt: "2026-03-02T00:00:00.000Z",
      modifiedFiles: ["src/orphan.ts"],
      updatedAt: "2026-03-02T00:00:00.000Z",
    });

    const result = aggregateTeamAnalytics(db, {
      from: "2026-03-01T00:00:00.000Z",
      to: "2026-03-31T00:00:00.000Z",
    });

    expect(result.agents).toHaveLength(1);
    expect(result.agents[0]).toMatchObject({
      agentId: "deleted-agent",
      agentName: null,
      role: null,
      state: null,
      filesChanged: 1,
    });
    expect(result.agents[0].tokens.totalTokens).toBe(15);
  });

  it("marks unpriced models unavailable instead of treating them as zero-cost", () => {
    insertAgent(db, "agent-a", "Alpha");
    insertTask(db, {
      id: "unknown-model",
      agentId: "agent-a",
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      tokenUsageLastUsedAt: "2026-03-02T00:00:00.000Z",
      modelProvider: "unknown-provider",
      modelId: "unknown-model",
    });

    const result = aggregateTeamAnalytics(db, {});

    expect(result.agents[0].cost).toEqual({ usd: null, unavailable: true, stale: false });
    expect(result.totals.cost).toEqual({ usd: null, unavailable: true, stale: false });
  });

  it("uses inclusive upper and lower bounds for tokens, completions, and files", () => {
    insertAgent(db, "agent-a", "Alpha");
    insertTask(db, {
      id: "from-boundary",
      agentId: "agent-a",
      column: "done",
      columnMovedAt: "2026-03-01T00:00:00.000Z",
      tokenUsageLastUsedAt: "2026-03-01T00:00:00.000Z",
      inputTokens: 10,
      totalTokens: 10,
      modifiedFiles: ["from.ts"],
      updatedAt: "2026-03-01T00:00:00.000Z",
    });
    insertTask(db, {
      id: "to-boundary",
      agentId: "agent-a",
      column: "done",
      columnMovedAt: "2026-03-31T00:00:00.000Z",
      tokenUsageLastUsedAt: "2026-03-31T00:00:00.000Z",
      inputTokens: 20,
      totalTokens: 20,
      modifiedFiles: ["to.ts"],
      updatedAt: "2026-03-31T00:00:00.000Z",
    });
    insertTask(db, {
      id: "after-boundary",
      agentId: "agent-a",
      column: "done",
      columnMovedAt: "2026-03-31T00:00:00.001Z",
      tokenUsageLastUsedAt: "2026-03-31T00:00:00.001Z",
      inputTokens: 30,
      totalTokens: 30,
      modifiedFiles: ["after.ts"],
      updatedAt: "2026-03-31T00:00:00.001Z",
    });

    const result = aggregateTeamAnalytics(db, {
      from: "2026-03-01T00:00:00.000Z",
      to: "2026-03-31T00:00:00.000Z",
    });

    expect(result.agents[0].tokens.totalTokens).toBe(30);
    expect(result.agents[0].tasksCompleted).toBe(2);
    expect(result.agents[0].filesChanged).toBe(2);
  });

  it("tolerates invalid modifiedFiles JSON", () => {
    insertAgent(db, "agent-a", "Alpha");
    insertTask(db, {
      id: "bad-files",
      agentId: "agent-a",
      modifiedFiles: "not-json",
      updatedAt: "2026-03-02T00:00:00.000Z",
    });

    const result = aggregateTeamAnalytics(db, {});

    expect(result.agents[0].filesChanged).toBe(0);
  });
});
