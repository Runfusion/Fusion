import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { Database } from "../db.js";
import { aggregateWorkflowAnalytics } from "../workflow-analytics.js";

interface TaskSeed {
  id: string;
  workflowId?: string | null;
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

function modifiedFilesValue(value: unknown): string | null {
  if (value === undefined) return "[]";
  if (value === null) return null;
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function insertWorkflow(db: Database, id: string, name: string, icon?: string): void {
  db.prepare(
    `INSERT INTO workflows (id, name, description, icon, ir, layout, kind, createdAt, updatedAt)
     VALUES (?, ?, '', ?, '{"version":"v1","name":"test","nodes":[],"edges":[]}', '{}', 'workflow', ?, ?)`,
  ).run(id, name, icon ?? null, "2026-03-01T00:00:00.000Z", "2026-03-01T00:00:00.000Z");
}

function insertTask(db: Database, task: TaskSeed): void {
  const updatedAt = task.updatedAt ?? "2026-03-01T00:00:00.000Z";
  db.prepare(
    `INSERT INTO tasks
       (id, description, "column", createdAt, updatedAt, columnMovedAt,
        modifiedFiles, tokenUsageInputTokens, tokenUsageOutputTokens, tokenUsageCachedTokens,
        tokenUsageCacheWriteTokens, tokenUsageTotalTokens, tokenUsageLastUsedAt, modelProvider, modelId)
     VALUES (?, 'desc', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    task.id,
    task.column ?? "todo",
    updatedAt,
    updatedAt,
    task.columnMovedAt ?? null,
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

  if (task.workflowId !== undefined && task.workflowId !== null) {
    db.prepare(
      `INSERT INTO task_workflow_selection (taskId, workflowId, stepIds, updatedAt)
       VALUES (?, ?, '[]', ?)`,
    ).run(task.id, task.workflowId, updatedAt);
  }
}

describe("workflow-analytics", () => {
  let tmpDir: string;
  let db: Database;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "kb-workflow-analytics-"));
    db = new Database(join(tmpDir, ".fusion"));
    db.init();
  });

  afterEach(async () => {
    db.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("groups selected and unselected tasks under resolved workflow names", async () => {
    insertWorkflow(db, "WF-custom", "Release workflow", "🚀");
    insertTask(db, {
      id: "custom-tokens",
      workflowId: "WF-custom",
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      totalTokens: 2_000_000,
      tokenUsageLastUsedAt: "2026-03-02T00:00:00.000Z",
      modelProvider: "openai",
      modelId: "gpt-4o",
      modifiedFiles: ["src/custom.ts", "src/shared.ts"],
      updatedAt: "2026-03-02T00:00:00.000Z",
    });
    insertTask(db, {
      id: "builtin-done",
      workflowId: "builtin:quick-fix",
      column: "done",
      columnMovedAt: "2026-03-03T00:00:00.000Z",
      inputTokens: 50,
      outputTokens: 25,
      totalTokens: 75,
      tokenUsageLastUsedAt: "2026-03-03T00:00:00.000Z",
      modelProvider: "openai",
      modelId: "gpt-4o-mini",
      modifiedFiles: ["src/builtin.ts"],
      updatedAt: "2026-03-03T00:00:00.000Z",
    });
    insertTask(db, {
      id: "default-progress",
      column: "in-progress",
      modifiedFiles: ["docs/default.md"],
      updatedAt: "2026-03-04T00:00:00.000Z",
    });
    insertTask(db, {
      id: "default-review",
      column: "in-review",
      updatedAt: "2026-03-05T00:00:00.000Z",
    });

    const result = await aggregateWorkflowAnalytics(db, {
      from: "2026-03-01T00:00:00.000Z",
      to: "2026-03-31T00:00:00.000Z",
      defaultWorkflowId: "builtin:coding",
      now: Date.parse("2026-03-10T00:00:00.000Z"),
    });

    expect(result.workflows.map((workflow) => workflow.workflowId)).toEqual([
      "WF-custom",
      "builtin:quick-fix",
      "builtin:coding",
    ]);
    const byWorkflow = new Map(result.workflows.map((workflow) => [workflow.workflowId, workflow]));
    expect(byWorkflow.get("WF-custom")).toMatchObject({
      workflowName: "Release workflow",
      workflowIcon: "🚀",
      isBuiltin: false,
      filesChanged: 2,
      tasksCompleted: 0,
      tasksInProgress: 0,
      tasksInReview: 0,
    });
    expect(byWorkflow.get("WF-custom")?.tokens.totalTokens).toBe(2_000_000);
    expect(byWorkflow.get("WF-custom")?.cost).toEqual({ usd: 12.5, unavailable: false, stale: false });
    expect(byWorkflow.get("builtin:quick-fix")).toMatchObject({
      workflowName: "Quick fix",
      isBuiltin: true,
      filesChanged: 1,
      tasksCompleted: 1,
    });
    expect(byWorkflow.get("builtin:coding")).toMatchObject({
      workflowName: "Coding",
      isBuiltin: true,
      filesChanged: 1,
      tasksInProgress: 1,
      tasksInReview: 1,
    });
    expect(result.totals.tokens.totalTokens).toBe(2_000_075);
    expect(result.totals.filesChanged).toBe(4);
    expect(result.totals.tasksCompleted).toBe(1);
    expect(result.totals.tasksInProgress).toBe(1);
    expect(result.totals.tasksInReview).toBe(1);
  });

  it("marks unpriced workflow costs unavailable instead of treating them as zero", async () => {
    insertTask(db, {
      id: "unknown-model",
      workflowId: "builtin:quick-fix",
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      tokenUsageLastUsedAt: "2026-03-02T00:00:00.000Z",
      modelProvider: "unknown-provider",
      modelId: "unknown-model",
    });

    const result = await aggregateWorkflowAnalytics(db, {});

    expect(result.workflows[0].cost).toEqual({ usd: null, unavailable: true, stale: false });
    expect(result.totals.cost).toEqual({ usd: null, unavailable: true, stale: false });
  });

  it("returns zeroed totals and an empty workflow array for an empty range", async () => {
    insertTask(db, {
      id: "outside",
      workflowId: "builtin:quick-fix",
      column: "done",
      columnMovedAt: "2026-02-28T23:59:59.999Z",
      tokenUsageLastUsedAt: "2026-02-28T23:59:59.999Z",
      inputTokens: 10,
      totalTokens: 10,
      modifiedFiles: ["outside.ts"],
      updatedAt: "2026-02-28T23:59:59.999Z",
    });
    insertTask(db, {
      id: "outside-progress",
      workflowId: "builtin:quick-fix",
      column: "in-progress",
      columnMovedAt: "2026-02-28T23:59:59.999Z",
      updatedAt: "2026-04-01T00:00:00.000Z",
    });
    insertTask(db, {
      id: "outside-review",
      workflowId: "builtin:quick-fix",
      column: "in-review",
      updatedAt: "2026-02-28T23:59:59.999Z",
    });

    const result = await aggregateWorkflowAnalytics(db, {
      from: "2026-03-01T00:00:00.000Z",
      to: "2026-03-31T00:00:00.000Z",
    });

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
    expect(result.workflows).toEqual([]);
  });

  it("uses inclusive upper and lower bounds for tokens, completions, and files", async () => {
    insertTask(db, {
      id: "from-boundary",
      workflowId: "builtin:quick-fix",
      column: "done",
      columnMovedAt: "2026-03-01T00:00:00.000Z",
      tokenUsageLastUsedAt: "2026-03-01T00:00:00.000Z",
      inputTokens: 10,
      totalTokens: 10,
      modifiedFiles: ["from.ts"],
      updatedAt: "2026-03-01T00:00:00.000Z",
    });
    insertTask(db, {
      id: "progress-from-boundary",
      workflowId: "builtin:quick-fix",
      column: "in-progress",
      columnMovedAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-04-01T00:00:00.000Z",
    });
    insertTask(db, {
      id: "to-boundary",
      workflowId: "builtin:quick-fix",
      column: "done",
      columnMovedAt: "2026-03-31T00:00:00.000Z",
      tokenUsageLastUsedAt: "2026-03-31T00:00:00.000Z",
      inputTokens: 20,
      totalTokens: 20,
      modifiedFiles: ["to.ts"],
      updatedAt: "2026-03-31T00:00:00.000Z",
    });
    insertTask(db, {
      id: "review-to-boundary",
      workflowId: "builtin:quick-fix",
      column: "in-review",
      updatedAt: "2026-03-31T00:00:00.000Z",
    });
    insertTask(db, {
      id: "after-boundary",
      workflowId: "builtin:quick-fix",
      column: "done",
      columnMovedAt: "2026-03-31T00:00:00.001Z",
      tokenUsageLastUsedAt: "2026-03-31T00:00:00.001Z",
      inputTokens: 30,
      totalTokens: 30,
      modifiedFiles: ["after.ts"],
      updatedAt: "2026-03-31T00:00:00.001Z",
    });
    insertTask(db, {
      id: "progress-after-boundary",
      workflowId: "builtin:quick-fix",
      column: "in-progress",
      columnMovedAt: "2026-03-31T00:00:00.001Z",
      updatedAt: "2026-03-31T00:00:00.001Z",
    });

    const result = await aggregateWorkflowAnalytics(db, {
      from: "2026-03-01T00:00:00.000Z",
      to: "2026-03-31T00:00:00.000Z",
    });

    expect(result.workflows).toHaveLength(1);
    expect(result.workflows[0].tokens.totalTokens).toBe(30);
    expect(result.workflows[0].tasksCompleted).toBe(2);
    expect(result.workflows[0].tasksInProgress).toBe(1);
    expect(result.workflows[0].tasksInReview).toBe(1);
    expect(result.workflows[0].filesChanged).toBe(2);
  });
});
