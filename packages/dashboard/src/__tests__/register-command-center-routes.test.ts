// @vitest-environment node

import express, { type NextFunction, type Request, type Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";

import { Database, emitUsageEvent, LITELLM_PRICING_SOURCE_URL } from "@fusion/core";
import type { GlobalSettings, TaskStore } from "@fusion/core";
import { request } from "../test-request.js";
import { ApiError } from "../api-error.js";
import {
  registerCommandCenterRoutes,
  resolveRange,
  resolveGroupBy,
  resolveTokenGranularity,
  DEFAULT_WINDOW_DAYS,
} from "../routes/register-command-center-routes.js";
import type { ApiRoutesContext } from "../routes/types.js";

const { mockInvalidateAllGlobalSettingsCaches } = vi.hoisted(() => ({
  mockInvalidateAllGlobalSettingsCaches: vi.fn(),
}));

vi.mock("../project-store-resolver.js", () => ({
  invalidateAllGlobalSettingsCaches: mockInvalidateAllGlobalSettingsCaches,
}));

/** Seed a temp DB with a token-bearing task and a tool-call usage event. */
function seedDb(db: Database, opts: { taskId: string; model: string; tokens: number }): void {
  db.prepare(
    `INSERT INTO tasks
       (id, description, "column", modelProvider, modelId,
        tokenUsageInputTokens, tokenUsageOutputTokens, tokenUsageTotalTokens,
        tokenUsageLastUsedAt, createdAt, updatedAt)
     VALUES (?, 'desc', 'todo', 'anthropic', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.taskId,
    opts.model,
    opts.tokens,
    opts.tokens,
    opts.tokens * 2,
    "2026-03-01T00:00:00.000Z",
    "2026-03-01T00:00:00.000Z",
    "2026-03-01T00:00:00.000Z",
  );
  emitUsageEvent(db, {
    kind: "tool_call",
    taskId: opts.taskId,
    agentId: "agent-1",
    nodeId: "node-1",
    category: "edit",
    ts: "2026-03-01T00:00:00.000Z",
  });
}

function seedCompletedTaskDuration(db: Database, opts: { id: string; cumulativeActiveMs: number; completedAt: string }): void {
  db.prepare(
    `INSERT INTO tasks
       (id, description, "column", cumulativeActiveMs, executionCompletedAt, createdAt, updatedAt)
     VALUES (?, 'desc', 'done', ?, ?, ?, ?)`,
  ).run(opts.id, opts.cumulativeActiveMs, opts.completedAt, opts.completedAt, opts.completedAt);
}

function seedAgentRun(db: Database, opts: { id: string; agentId: string; startedAt: string; status: string; taskId?: string }): void {
  db.prepare(
    `INSERT OR IGNORE INTO agents (id, name, role, state, createdAt, updatedAt)
     VALUES (?, ?, 'executor', 'idle', ?, ?)`,
  ).run(opts.agentId, opts.agentId, opts.startedAt, opts.startedAt);
  db.prepare(
    `INSERT INTO agentRuns (id, agentId, data, startedAt, endedAt, status)
     VALUES (?, ?, ?, ?, NULL, ?)`,
  ).run(opts.id, opts.agentId, JSON.stringify({ taskId: opts.taskId ?? `task-${opts.id}` }), opts.startedAt, opts.status);
}

function seedTeamMetrics(db: Database, opts: { agentId: string; name: string; tokens: number; taskId: string }): void {
  db.prepare(
    `INSERT OR IGNORE INTO agents (id, name, role, state, createdAt, updatedAt)
     VALUES (?, ?, 'executor', 'running', '2026-03-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z')`,
  ).run(opts.agentId, opts.name);
  db.prepare(
    `INSERT INTO tasks
       (id, description, "column", assignedAgentId, modelProvider, modelId,
        tokenUsageInputTokens, tokenUsageOutputTokens, tokenUsageTotalTokens,
        tokenUsageLastUsedAt, modifiedFiles, columnMovedAt, createdAt, updatedAt)
     VALUES (?, 'desc', 'done', ?, 'anthropic', 'claude-sonnet-4-5', ?, ?, ?,
             '2026-03-01T00:00:00.000Z', ?, '2026-03-02T00:00:00.000Z',
             '2026-03-01T00:00:00.000Z', '2026-03-02T00:00:00.000Z')`,
  ).run(
    opts.taskId,
    opts.agentId,
    opts.tokens,
    opts.tokens,
    opts.tokens * 2,
    JSON.stringify([`src/${opts.taskId}.ts`]),
  );
}

function seedWorkflowMetrics(db: Database, opts: { taskId: string; workflowId?: string; workflowName?: string; tokens: number }): void {
  if (opts.workflowId && opts.workflowName) {
    db.prepare(
      `INSERT OR IGNORE INTO workflows (id, name, description, ir, layout, kind, createdAt, updatedAt)
       VALUES (?, ?, '', '{"version":"v1","name":"test","nodes":[],"edges":[]}', '{}', 'workflow',
               '2026-03-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z')`,
    ).run(opts.workflowId, opts.workflowName);
  }
  db.prepare(
    `INSERT INTO tasks
       (id, description, "column", modelProvider, modelId,
        tokenUsageInputTokens, tokenUsageOutputTokens, tokenUsageTotalTokens,
        tokenUsageLastUsedAt, modifiedFiles, columnMovedAt, createdAt, updatedAt)
     VALUES (?, 'desc', 'done', 'anthropic', 'claude-sonnet-4-5', ?, ?, ?,
             '2026-03-01T00:00:00.000Z', ?, '2026-03-02T00:00:00.000Z',
             '2026-03-01T00:00:00.000Z', '2026-03-02T00:00:00.000Z')`,
  ).run(
    opts.taskId,
    opts.tokens,
    opts.tokens,
    opts.tokens * 2,
    JSON.stringify([`src/${opts.taskId}.ts`]),
  );
  if (opts.workflowId) {
    db.prepare(
      `INSERT INTO task_workflow_selection (taskId, workflowId, stepIds, updatedAt)
       VALUES (?, ?, '[]', '2026-03-02T00:00:00.000Z')`,
    ).run(opts.taskId, opts.workflowId);
  }
}

function seedSignalMetrics(db: Database, opts: { prefix: string; source: string; open: number; resolved: number }): void {
  let seq = 0;
  for (let i = 0; i < opts.open; i += 1) {
    db.prepare(
      `INSERT INTO incidents
         (incidentId, groupingKey, title, severity, status, source, openedAt, resolvedAt, createdAt, updatedAt)
       VALUES (?, ?, ?, 'critical', 'open', ?, '2026-03-04T00:00:00.000Z', NULL,
               '2026-03-04T00:00:00.000Z', '2026-03-04T00:00:00.000Z')`,
    ).run(`${opts.prefix}-open-${seq}`, `${opts.prefix}-group-${seq}`, `Signal ${seq}`, opts.source);
    seq += 1;
  }
  for (let i = 0; i < opts.resolved; i += 1) {
    db.prepare(
      `INSERT INTO incidents
         (incidentId, groupingKey, title, severity, status, source, openedAt, resolvedAt, createdAt, updatedAt)
       VALUES (?, ?, ?, 'warning', 'resolved', ?, '2026-03-05T00:00:00.000Z', '2026-03-05T00:30:00.000Z',
               '2026-03-05T00:00:00.000Z', '2026-03-05T00:30:00.000Z')`,
    ).run(`${opts.prefix}-resolved-${seq}`, `${opts.prefix}-group-${seq}`, `Signal ${seq}`, opts.source);
    seq += 1;
  }
}

function seedPluginActivation(db: Database, opts: { pluginId: string; activatedAt: string; source?: string; version?: string | null }): void {
  db.prepare(
    `INSERT INTO plugin_activations (pluginId, source, pluginVersion, activatedAt)
     VALUES (?, ?, ?, ?)`,
  ).run(opts.pluginId, opts.source ?? "plugin", opts.version ?? null, opts.activatedAt);
}

function seedGithubIssueMetrics(db: Database, opts: { prefix: string; repo: string; filed: number; fixed: number }): void {
  for (let i = 0; i < opts.filed; i += 1) {
    db.prepare(
      `INSERT INTO tasks (id, description, "column", createdAt, updatedAt, githubTracking)
       VALUES (?, 'desc', 'todo', '2026-03-02T00:00:00.000Z', '2026-03-02T00:00:00.000Z', ?)`,
    ).run(
      `${opts.prefix}-filed-${i}`,
      JSON.stringify({
        issue: {
          owner: opts.repo.split("/")[0],
          repo: opts.repo.split("/")[1],
          number: i + 1,
          url: `https://github.com/${opts.repo}/issues/${i + 1}`,
          createdAt: "2026-03-02T00:00:00.000Z",
        },
      }),
    );
  }
  for (let i = 0; i < opts.fixed; i += 1) {
    db.prepare(
      `INSERT INTO tasks (
         id, title, description, "column", createdAt, updatedAt,
         sourceIssueProvider, sourceIssueRepository, sourceIssueExternalIssueId,
         sourceIssueNumber, sourceIssueUrl, sourceIssueClosedAt
       ) VALUES (?, ?, 'desc', 'done', '2026-03-03T00:00:00.000Z', '2026-03-03T00:00:00.000Z',
                 'github', ?, ?, ?, ?, ?)`,
    ).run(
      `${opts.prefix}-fixed-${i}`,
      `Resolve ${opts.repo}#${i + 100}`,
      opts.repo,
      String(i + 100),
      i + 100,
      `https://github.com/${opts.repo}/issues/${i + 100}`,
      "2026-03-03T12:00:00.000Z",
    );
  }
}

/**
 * Build an express app with the registrar mounted, backed by per-project real
 * DBs. The `getScopedStore` resolves the DB by the `projectId` query param,
 * proving project scoping at the route boundary.
 */
function buildApp(stores: Record<string, TaskStore>, fallback: TaskStore) {
  const app = express();
  app.use(express.json());

  const router = express.Router();
  const ctx = {
    router,
    getScopedStore: async (req: Request): Promise<TaskStore> => {
      const projectId =
        typeof req.query.projectId === "string" ? req.query.projectId : undefined;
      return projectId && stores[projectId] ? stores[projectId] : fallback;
    },
    rethrowAsApiError: (error: unknown, fallbackMessage?: string): never => {
      if (error instanceof ApiError) throw error;
      throw new ApiError(500, fallbackMessage ?? "Internal error");
    },
  } as unknown as ApiRoutesContext;

  registerCommandCenterRoutes(ctx);
  app.use("/api", router);

  // Minimal ApiError → HTTP status mapper (mirrors server.ts behaviour).
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ApiError) {
      res.status(err.statusCode).json({ error: err.message });
      return;
    }
    res.status(500).json({ error: "Internal error" });
  });

  return app;
}

/** A minimal TaskStore exposing only the methods Command Center routes use. */
function storeFor(
  db: Database,
  overrides: Partial<TaskStore> = {},
  globalSettings: Partial<GlobalSettings> = {},
): TaskStore {
  const store = new EventEmitter() as unknown as TaskStore & { getDatabase(): Database };
  const settings = {
    modelPricingOverrides: undefined,
    modelPricingFetchedAt: undefined,
    modelPricingSource: undefined,
    ...globalSettings,
  } as GlobalSettings;
  store.getDatabase = () => db;
  store.getDefaultWorkflowId = vi.fn(async () => undefined) as TaskStore["getDefaultWorkflowId"];
  store.getGlobalSettingsStore = () => ({
    getSettings: async () => settings,
    invalidateCache: vi.fn(),
  } as unknown as ReturnType<TaskStore["getGlobalSettingsStore"]>);
  store.updateGlobalSettings = vi.fn(async (patch: Partial<GlobalSettings>) => {
    Object.assign(settings, patch);
    return settings;
  }) as TaskStore["updateGlobalSettings"];
  Object.assign(store, overrides);
  return store;
}

const SIGNAL_SECRET_ENV_KEYS = [
  "FUSION_SIGNAL_WEBHOOK_SECRET",
  "FUSION_SIGNAL_SENTRY_SECRET",
  "FUSION_SIGNAL_DATADOG_SECRET",
  "FUSION_SIGNAL_PAGERDUTY_SECRET",
  "FUSION_SIGNAL_GITLAB_SECRET",
] as const;

describe("register-command-center-routes", () => {
  let tmpDir: string;
  let dbA: Database;
  let dbB: Database;
  let app: ReturnType<typeof buildApp>;
  let savedSignalEnv: Partial<Record<(typeof SIGNAL_SECRET_ENV_KEYS)[number], string | undefined>>;

  beforeEach(() => {
    savedSignalEnv = {};
    for (const key of SIGNAL_SECRET_ENV_KEYS) {
      savedSignalEnv[key] = process.env[key];
      delete process.env[key];
    }
    tmpDir = mkdtempSync(join(tmpdir(), "kb-cc-routes-"));
    dbA = new Database(join(tmpDir, "a", ".fusion"));
    dbA.init();
    dbB = new Database(join(tmpDir, "b", ".fusion"));
    dbB.init();

    // Project A: a known task + tool call. Project B: a *different* marker task.
    seedDb(dbA, { taskId: "FN-A1", model: "claude-sonnet-4-5", tokens: 100 });
    seedDb(dbB, { taskId: "FN-B1", model: "claude-opus-4-5", tokens: 999 });

    const storeA = storeFor(dbA);
    const storeB = storeFor(dbB);
    app = buildApp({ "proj-a": storeA, "proj-b": storeB }, storeA);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    mockInvalidateAllGlobalSettingsCaches.mockClear();
    for (const key of SIGNAL_SECRET_ENV_KEYS) {
      const value = savedSignalEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    dbA.close();
    dbB.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns the token aggregator shape for a fixture DB", async () => {
    const res = await request(
      app,
      "GET",
      "/api/command-center/tokens?from=2026-02-01T00:00:00.000Z&to=2026-04-01T00:00:00.000Z&groupBy=model&projectId=proj-a",
    );
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body).toHaveProperty("totals");
    expect(body).toHaveProperty("cost");
    expect(body).toHaveProperty("groups");
    expect(body).not.toHaveProperty("series");
    expect(body.groupBy).toBe("model");
    expect((body.totals as { totalTokens: number }).totalTokens).toBe(200);
  });

  it("returns token time-series buckets when granularity is requested", async () => {
    const res = await request(
      app,
      "GET",
      "/api/command-center/tokens?from=2026-02-01T00:00:00.000Z&to=2026-04-01T00:00:00.000Z&groupBy=model&granularity=day&projectId=proj-a",
    );

    expect(res.status).toBe(200);
    const body = res.body as { series?: { bucket: string; totalTokens: number; cost: unknown }[] };
    expect(body.series).toEqual([
      expect.objectContaining({ bucket: "2026-03-01", totalTokens: 200 }),
    ]);
    expect(body.series?.[0]).toHaveProperty("cost");
  });

  it("token analytics applies persisted pricing overrides", async () => {
    const storeA = storeFor(dbA, {}, {
      modelPricingOverrides: {
        "anthropic:claude-sonnet-4-5": {
          inputPer1M: 1_000_000,
          outputPer1M: 1_000_000,
          cacheReadPer1M: 1_000_000,
          cacheWritePer1M: 1_000_000,
          source: "manual",
        },
      },
    });
    app = buildApp({ "proj-a": storeA }, storeA);

    const res = await request(
      app,
      "GET",
      "/api/command-center/tokens?from=2026-02-01T00:00:00.000Z&to=2026-04-01T00:00:00.000Z&projectId=proj-a",
    );

    expect(res.status).toBe(200);
    expect((res.body as { cost: { usd: number } }).cost.usd).toBeCloseTo(200, 2);
  });

  it("fetches latest pricing and persists merged global overrides", async () => {
    const storeA = storeFor(dbA, {}, {
      modelPricingOverrides: {
        "manual:custom": {
          inputPer1M: 9,
          outputPer1M: 9,
          cacheReadPer1M: 9,
          cacheWritePer1M: 9,
          source: "manual",
        },
      },
    });
    app = buildApp({ "proj-a": storeA }, storeA);
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        "gpt-test": {
          litellm_provider: "openai",
          mode: "chat",
          input_cost_per_token: 0.000001,
          output_cost_per_token: 0.000002,
        },
      }),
      text: async () => "",
    } as Response);

    const res = await request(app, "POST", "/api/command-center/pricing/fetch?projectId=proj-a");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ count: 1, source: LITELLM_PRICING_SOURCE_URL });
    expect((res.body as { fetchedAt: string }).fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(storeA.updateGlobalSettings).toHaveBeenCalledWith(expect.objectContaining({
      modelPricingFetchedAt: expect.any(String),
      modelPricingSource: LITELLM_PRICING_SOURCE_URL,
      modelPricingOverrides: expect.objectContaining({
        "manual:custom": expect.objectContaining({ source: "manual" }),
        "openai:gpt-test": expect.objectContaining({ inputPer1M: 1, outputPer1M: 2 }),
      }),
    }));
    expect(mockInvalidateAllGlobalSettingsCaches).toHaveBeenCalledTimes(1);
  });

  it("pricing fetch failures preserve existing overrides", async () => {
    const existing = {
      "anthropic:claude-sonnet-4-5": {
        inputPer1M: 99,
        outputPer1M: 99,
        cacheReadPer1M: 99,
        cacheWritePer1M: 99,
        source: "manual",
      },
    };
    const storeA = storeFor(dbA, {}, { modelPricingOverrides: existing });
    app = buildApp({ "proj-a": storeA }, storeA);
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));

    const res = await request(app, "POST", "/api/command-center/pricing/fetch?projectId=proj-a");

    expect(res.status).toBe(500);
    expect(storeA.updateGlobalSettings).not.toHaveBeenCalled();
    expect((await storeA.getGlobalSettingsStore().getSettings()).modelPricingOverrides).toEqual(existing);
    expect(mockInvalidateAllGlobalSettingsCaches).not.toHaveBeenCalled();
  });

  it("pricing fetch rejects empty parsed data without clobbering overrides", async () => {
    const existing = {
      "anthropic:claude-sonnet-4-5": {
        inputPer1M: 99,
        outputPer1M: 99,
        cacheReadPer1M: 99,
        cacheWritePer1M: 99,
        source: "manual",
      },
    };
    const storeA = storeFor(dbA, {}, { modelPricingOverrides: existing });
    app = buildApp({ "proj-a": storeA }, storeA);
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ sample_spec: {}, "embedding-test": { litellm_provider: "openai", mode: "embedding" } }),
      text: async () => "",
    } as Response);

    const res = await request(app, "POST", "/api/command-center/pricing/fetch?projectId=proj-a");

    expect(res.status).toBe(502);
    expect(storeA.updateGlobalSettings).not.toHaveBeenCalled();
    expect((await storeA.getGlobalSettingsStore().getSettings()).modelPricingOverrides).toEqual(existing);
  });

  it("ignores invalid token granularity rather than erroring", async () => {
    const res = await request(
      app,
      "GET",
      "/api/command-center/tokens?from=2026-02-01T00:00:00.000Z&to=2026-04-01T00:00:00.000Z&granularity=minute&projectId=proj-a",
    );

    expect(res.status).toBe(200);
    expect(res.body as Record<string, unknown>).not.toHaveProperty("series");
  });

  it("returns the team aggregator shape for a fixture DB", async () => {
    seedTeamMetrics(dbA, { agentId: "agent-route-a", name: "Route Alpha", tokens: 321, taskId: "FN-A-team" });

    const res = await request(
      app,
      "GET",
      "/api/command-center/team?from=2026-02-01T00:00:00.000Z&to=2026-04-01T00:00:00.000Z&projectId=proj-a",
    );

    expect(res.status).toBe(200);
    const body = res.body as {
      totals: { tokens: { totalTokens: number }; filesChanged: number; tasksCompleted: number };
      agents: Array<{ agentId: string; agentName: string; tokens: { totalTokens: number }; filesChanged: number }>;
    };
    expect(body).toHaveProperty("totals");
    expect(body).toHaveProperty("agents");
    expect(body.totals.tokens.totalTokens).toBe(642);
    expect(body.totals.filesChanged).toBe(1);
    expect(body.totals.tasksCompleted).toBe(1);
    expect(body.agents).toContainEqual(
      expect.objectContaining({
        agentId: "agent-route-a",
        agentName: "Route Alpha",
        tokens: expect.objectContaining({ totalTokens: 642 }),
        filesChanged: 1,
      }),
    );
  });

  it("returns the workflow aggregator shape for a fixture DB", async () => {
    seedWorkflowMetrics(dbA, { taskId: "FN-A-workflow-custom", workflowId: "WF-route-a", workflowName: "Route Workflow", tokens: 321 });
    seedWorkflowMetrics(dbA, { taskId: "FN-A-workflow-default", tokens: 50 });

    const res = await request(
      app,
      "GET",
      "/api/command-center/workflows?from=2026-02-01T00:00:00.000Z&to=2026-04-01T00:00:00.000Z&projectId=proj-a",
    );

    expect(res.status).toBe(200);
    const body = res.body as {
      totals: { tokens: { totalTokens: number }; filesChanged: number; tasksCompleted: number };
      workflows: Array<{ workflowId: string; workflowName: string; tokens: { totalTokens: number }; filesChanged: number }>;
    };
    expect(body).toHaveProperty("totals");
    expect(body).toHaveProperty("workflows");
    expect(body.totals.tokens.totalTokens).toBe(942);
    expect(body.totals.filesChanged).toBe(2);
    expect(body.totals.tasksCompleted).toBe(2);
    expect(body.workflows).toContainEqual(
      expect.objectContaining({
        workflowId: "WF-route-a",
        workflowName: "Route Workflow",
        tokens: expect.objectContaining({ totalTokens: 642 }),
        filesChanged: 1,
      }),
    );
    expect(body.workflows).toContainEqual(
      expect.objectContaining({
        workflowId: "builtin:coding",
        workflowName: "Coding",
        tokens: expect.objectContaining({ totalTokens: 300 }),
      }),
    );
  });

  it("team analytics applies persisted pricing overrides", async () => {
    seedTeamMetrics(dbA, { agentId: "agent-route-a", name: "Route Alpha", tokens: 100, taskId: "FN-A-team-override" });
    const storeA = storeFor(dbA, {}, {
      modelPricingOverrides: {
        "anthropic:claude-sonnet-4-5": {
          inputPer1M: 1_000_000,
          outputPer1M: 1_000_000,
          cacheReadPer1M: 1_000_000,
          cacheWritePer1M: 1_000_000,
          source: "manual",
        },
      },
    });
    app = buildApp({ "proj-a": storeA }, storeA);

    const res = await request(
      app,
      "GET",
      "/api/command-center/team?from=2026-02-01T00:00:00.000Z&to=2026-04-01T00:00:00.000Z&projectId=proj-a",
    );

    expect(res.status).toBe(200);
    expect((res.body as { totals: { cost: { usd: number } } }).totals.cost.usd).toBeCloseTo(200, 2);
  });

  it("returns the tools / activity / productivity aggregator shapes", async () => {
    const range = "from=2026-02-01T00:00:00.000Z&to=2026-04-01T00:00:00.000Z";
    seedAgentRun(dbA, { id: "run-a1", agentId: "agent-route", startedAt: "2026-03-02T00:00:00.000Z", status: "active" });
    seedCompletedTaskDuration(dbA, { id: "FN-D1", cumulativeActiveMs: 120_000, completedAt: "2026-03-03T00:00:00.000Z" });
    const tools = await request(app, "GET", `/api/command-center/tools?${range}&projectId=proj-a`);
    expect(tools.status).toBe(200);
    expect(tools.body).toHaveProperty("autonomyRatio");
    expect((tools.body as { toolCalls: number }).toolCalls).toBe(1);

    const activity = await request(app, "GET", `/api/command-center/activity?${range}&projectId=proj-a`);
    expect(activity.status).toBe(200);
    expect(activity.body).toHaveProperty("stickiness");
    expect(activity.body).toHaveProperty("mttr");
    expect(activity.body).toHaveProperty("agentRuns");
    expect((activity.body as { agentRuns: { total: number; active: number } }).agentRuns).toMatchObject({ total: 1, active: 1 });
    expect((activity.body as { activeAgents: number; daily: Array<{ day: string; activeAgents: number; agentRuns: number }> }).activeAgents).toBe(2);
    expect((activity.body as { daily: Array<{ day: string; activeAgents: number; agentRuns: number }> }).daily).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ day: "2026-03-02", activeAgents: 1, agentRuns: 1 }),
      ]),
    );

    const prod = await request(app, "GET", `/api/command-center/productivity?${range}&projectId=proj-a`);
    expect(prod.status).toBe(200);
    expect(prod.body).toHaveProperty("loc");
    expect(prod.body).toHaveProperty("hoursSaved");
    expect(prod.body).toHaveProperty("byLanguage");
    expect(prod.body).toHaveProperty("taskDuration");
    expect((prod.body as { taskDuration: { completedTasks: number; totalMs: number } }).taskDuration).toMatchObject({
      completedTasks: 1,
      totalMs: 120_000,
    });

    seedGithubIssueMetrics(dbA, { prefix: "FN-A", repo: "acme/alpha", filed: 2, fixed: 1 });
    const github = await request(app, "GET", `/api/command-center/github?${range}&projectId=proj-a`);
    expect(github.status).toBe(200);
    expect(github.body).toMatchObject({ filed: 2, fixed: 1, net: 1 });
    expect(github.body).toHaveProperty("daily");
    expect(github.body).toHaveProperty("byRepo");
    expect(github.body).toHaveProperty("resolved");
    expect((github.body as { resolved: unknown[] }).resolved).toEqual([
      {
        taskId: "FN-A-fixed-0",
        taskTitle: "Resolve acme/alpha#100",
        repo: "acme/alpha",
        issueNumber: 100,
        url: "https://github.com/acme/alpha/issues/100",
        resolvedAt: "2026-03-03T12:00:00.000Z",
        resolvedAtExact: true,
      },
    ]);

    process.env.FUSION_SIGNAL_SENTRY_SECRET = "configured-sentry";
    process.env.FUSION_SIGNAL_WEBHOOK_SECRET = "configured-webhook";
    process.env.FUSION_SIGNAL_GITLAB_SECRET = "configured-gitlab";
    seedSignalMetrics(dbA, { prefix: "SIG-A", source: "sentry", open: 1, resolved: 1 });
    const signals = await request(app, "GET", `/api/command-center/signals?${range}&projectId=proj-a`);
    expect(signals.status).toBe(200);
    expect(signals.body).toMatchObject({
      totalSignals: 2,
      open: 1,
      resolved: 1,
      connectors: { configured: ["webhook", "sentry", "gitlab"], anyConfigured: true },
    });
    expect(signals.body).toHaveProperty("mttr");
    expect(signals.body).toHaveProperty("bySource");
    expect(signals.body).toHaveProperty("bySeverity");
  });

  it("honors picker-shaped from-only ranges for tokens, activity, and productivity", async () => {
    vi.useFakeTimers({ now: new Date("2026-04-01T00:00:00.000Z") });
    seedAgentRun(dbA, { id: "run-open-bound", agentId: "agent-open", startedAt: "2026-03-02T00:00:00.000Z", status: "completed" });
    seedCompletedTaskDuration(dbA, { id: "FN-open-duration", cumulativeActiveMs: 45_000, completedAt: "2026-03-03T00:00:00.000Z" });

    const pickerRange = "from=2026-02-01T00%3A00%3A00.000Z";
    const expectedTo = "2026-04-01T00:00:00.000Z";
    const tokens = await request(app, "GET", `/api/command-center/tokens?${pickerRange}&projectId=proj-a`);
    const activity = await request(app, "GET", `/api/command-center/activity?${pickerRange}&projectId=proj-a`);
    const productivity = await request(app, "GET", `/api/command-center/productivity?${pickerRange}&projectId=proj-a`);

    expect(tokens.status).toBe(200);
    expect(tokens.body).toMatchObject({ from: "2026-02-01T00:00:00.000Z", to: expectedTo });
    expect((tokens.body as { totals: { totalTokens: number } }).totals.totalTokens).toBe(200);
    expect(activity.body).toMatchObject({ from: "2026-02-01T00:00:00.000Z", to: expectedTo });
    expect((activity.body as { agentRuns: { total: number } }).agentRuns.total).toBe(1);
    expect(productivity.body).toMatchObject({ from: "2026-02-01T00:00:00.000Z", to: expectedTo });
    expect((productivity.body as { taskDuration: { completedTasks: number } }).taskDuration.completedTasks).toBe(1);

    const defaultTokens = await request(app, "GET", "/api/command-center/tokens?projectId=proj-a");
    const defaultActivity = await request(app, "GET", "/api/command-center/activity?projectId=proj-a");
    const defaultProductivity = await request(app, "GET", "/api/command-center/productivity?projectId=proj-a");
    expect(defaultTokens.body).toMatchObject({ from: "2026-03-25T00:00:00.000Z", to: expectedTo });
    expect((defaultTokens.body as { totals: { totalTokens: number } }).totals.totalTokens).toBe(0);
    expect((defaultActivity.body as { agentRuns: { total: number } }).agentRuns.total).toBe(0);
    expect((defaultProductivity.body as { taskDuration: { completedTasks: number } }).taskDuration.completedTasks).toBe(0);
  });

  it("applies from-only resolved bounds on every range-consuming analytics endpoint", async () => {
    vi.useFakeTimers({ now: new Date("2026-04-01T00:00:00.000Z") });
    const endpoints = [
      "tokens",
      "tools",
      "activity",
      "productivity",
      "team",
      "workflows",
      "github",
      "signals",
      "plugin-activations",
    ];

    for (const endpoint of endpoints) {
      const res = await request(
        app,
        "GET",
        `/api/command-center/${endpoint}?from=2026-02-01T00%3A00%3A00.000Z&projectId=proj-a`,
      );
      expect(res.status, endpoint).toBe(200);
      expect(res.body, endpoint).toMatchObject({
        from: "2026-02-01T00:00:00.000Z",
        to: "2026-04-01T00:00:00.000Z",
      });
    }
  });

  it("runs the productivity LOC backfill route as a dry-run by default and respects writes", async () => {
    const backfill = vi.fn(async (options?: { dryRun?: boolean }) => ({
      scannedRows: 3,
      distinctCommits: 2,
      updatedRows: options?.dryRun === false ? 3 : 0,
      skippedUnavailableCommits: 1,
      skippedInvalidShas: 0,
      dryRun: options?.dryRun ?? true,
    }));
    const scopedStore = storeFor(dbA, { backfillCommitAssociationDiffStats: backfill } as unknown as Partial<TaskStore>);
    const scopedApp = buildApp({ "proj-a": scopedStore }, scopedStore);

    const preview = await request(
      scopedApp,
      "POST",
      "/api/command-center/productivity/backfill-loc?projectId=proj-a",
      JSON.stringify({}),
      { "content-type": "application/json" },
    );
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({
      scannedRows: 3,
      distinctCommits: 2,
      updatedRows: 0,
      skippedUnavailableCommits: 1,
      skippedInvalidShas: 0,
      dryRun: true,
    });
    expect(backfill).toHaveBeenLastCalledWith({ dryRun: true });

    const write = await request(
      scopedApp,
      "POST",
      "/api/command-center/productivity/backfill-loc?projectId=proj-a",
      JSON.stringify({ dryRun: false }),
      { "content-type": "application/json" },
    );
    expect(write.status).toBe(200);
    expect(write.body).toMatchObject({ updatedRows: 3, dryRun: false });
    expect(backfill).toHaveBeenLastCalledWith({ dryRun: false });
  });

  it("returns the live snapshot shape", async () => {
    const res = await request(app, "GET", "/api/command-center/live?projectId=proj-a");
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body).toHaveProperty("capturedAt");
    expect(body).toHaveProperty("activeSessions");
    expect(body).toHaveProperty("columns");
    // Project A seeded one 'todo' task.
    expect(body.columns).toContainEqual({ column: "todo", count: 1 });
  });

  it("invalid range params fall back to the default window, not a 500", async () => {
    const res = await request(
      app,
      "GET",
      "/api/command-center/tokens?from=not-a-date&to=also-bad&projectId=proj-a",
    );
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    // Defaulted window is recent (last 7d), so the 2026-03 fixture is out of
    // range → zeroed totals, but never a 500.
    expect(body).toHaveProperty("totals");
  });

  it("missing range params default rather than 500", async () => {
    const res = await request(app, "GET", "/api/command-center/tokens?projectId=proj-a");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("totals");
  });

  it("project scoping — project-A request cannot read project-B data (JSON)", async () => {
    const a = await request(
      app,
      "GET",
      "/api/command-center/tokens?from=2026-02-01T00:00:00.000Z&to=2026-04-01T00:00:00.000Z&projectId=proj-a",
    );
    const b = await request(
      app,
      "GET",
      "/api/command-center/tokens?from=2026-02-01T00:00:00.000Z&to=2026-04-01T00:00:00.000Z&projectId=proj-b",
    );
    // A's task had 100 input tokens (total 200); B's had 999 (total 1998).
    expect((a.body as { totals: { totalTokens: number } }).totals.totalTokens).toBe(200);
    expect((b.body as { totals: { totalTokens: number } }).totals.totalTokens).toBe(1998);
  });

  it("activity route counts project-scoped run-only task workers as active agents", async () => {
    seedAgentRun(dbA, {
      id: "run-ephemeral-a",
      agentId: "executor-FN-7297",
      taskId: "FN-7297",
      startedAt: "2026-03-02T00:00:00.000Z",
      status: "completed",
    });
    seedAgentRun(dbB, {
      id: "run-ephemeral-b",
      agentId: "executor-FN-other",
      taskId: "FN-other",
      startedAt: "2026-03-03T00:00:00.000Z",
      status: "completed",
    });
    const range = "from=2026-02-01T00:00:00.000Z&to=2026-04-01T00:00:00.000Z";

    const a = await request(app, "GET", `/api/command-center/activity?${range}&projectId=proj-a`);
    const b = await request(app, "GET", `/api/command-center/activity?${range}&projectId=proj-b`);

    expect(a.status).toBe(200);
    expect((a.body as { activeAgents: number; daily: Array<{ day: string; activeAgents: number; agentRuns: number }> }).activeAgents).toBe(2);
    expect((a.body as { daily: Array<{ day: string; activeAgents: number; agentRuns: number }> }).daily).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ day: "2026-03-02", activeAgents: 1, agentRuns: 1 }),
      ]),
    );
    expect((b.body as { activeAgents: number; daily: Array<{ day: string; activeAgents: number; agentRuns: number }> }).activeAgents).toBe(2);
    expect((b.body as { daily: Array<{ day: string; activeAgents: number; agentRuns: number }> }).daily).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ day: "2026-03-03", activeAgents: 1, agentRuns: 1 }),
      ]),
    );
  });

  it("plugin activation endpoint returns scoped JSON and preserves unavailable for empty ranges", async () => {
    seedPluginActivation(dbA, { pluginId: "plugin.a", activatedAt: "2026-03-10T00:00:00.000Z" });
    seedPluginActivation(dbA, { pluginId: "plugin.a", activatedAt: "2026-03-11T00:00:00.000Z" });
    seedPluginActivation(dbB, { pluginId: "plugin.b", activatedAt: "2026-03-10T00:00:00.000Z" });
    const range = "from=2026-03-01T00:00:00.000Z&to=2026-03-31T00:00:00.000Z";

    const a = await request(app, "GET", `/api/command-center/plugin-activations?${range}&projectId=proj-a`);
    const b = await request(app, "GET", `/api/command-center/plugin-activations?${range}&projectId=proj-b`);
    const empty = await request(app, "GET", "/api/command-center/plugin-activations?from=2026-04-01T00:00:00.000Z&to=2026-04-30T00:00:00.000Z&projectId=proj-a");

    expect(a.status).toBe(200);
    expect(a.body).toMatchObject({ activations: 2, unavailable: false });
    expect((a.body as { byPlugin: Array<{ pluginId: string; count: number }> }).byPlugin).toEqual([
      { pluginId: "plugin.a", count: 2 },
    ]);
    expect(b.body).toMatchObject({ activations: 1, unavailable: false });
    expect((b.body as { byPlugin: Array<{ pluginId: string; count: number }> }).byPlugin).toEqual([
      { pluginId: "plugin.b", count: 1 },
    ]);
    expect(empty.body).toMatchObject({ activations: 0, byPlugin: [], unavailable: true });
  });

  it("workflow endpoint stays project scoped", async () => {
    seedWorkflowMetrics(dbA, { taskId: "FN-A-workflow", workflowId: "WF-project-a", workflowName: "Project A Workflow", tokens: 111 });
    seedWorkflowMetrics(dbB, { taskId: "FN-B-workflow", workflowId: "WF-project-b", workflowName: "Project B Workflow", tokens: 999 });
    const range = "from=2026-02-01T00:00:00.000Z&to=2026-04-01T00:00:00.000Z";

    const a = await request(app, "GET", `/api/command-center/workflows?${range}&projectId=proj-a`);
    const b = await request(app, "GET", `/api/command-center/workflows?${range}&projectId=proj-b`);

    const aWorkflows = (a.body as { workflows: Array<{ workflowId: string; workflowName: string; tokens: { totalTokens: number } }> }).workflows;
    const bWorkflows = (b.body as { workflows: Array<{ workflowId: string; workflowName: string; tokens: { totalTokens: number } }> }).workflows;
    expect(aWorkflows.some((workflow) => workflow.workflowId === "WF-project-a" && workflow.tokens.totalTokens === 222)).toBe(true);
    expect(aWorkflows.some((workflow) => workflow.workflowId === "WF-project-b" || workflow.workflowName === "Project B Workflow")).toBe(false);
    expect(bWorkflows.some((workflow) => workflow.workflowId === "WF-project-b" && workflow.tokens.totalTokens === 1998)).toBe(true);
    expect(bWorkflows.some((workflow) => workflow.workflowId === "WF-project-a" || workflow.workflowName === "Project A Workflow")).toBe(false);
  });

  it("team endpoint stays project scoped", async () => {
    seedTeamMetrics(dbA, { agentId: "agent-a-only", name: "Project A Agent", tokens: 111, taskId: "FN-A-team" });
    seedTeamMetrics(dbB, { agentId: "agent-b-only", name: "Project B Agent", tokens: 999, taskId: "FN-B-team" });
    const range = "from=2026-02-01T00:00:00.000Z&to=2026-04-01T00:00:00.000Z";

    const a = await request(app, "GET", `/api/command-center/team?${range}&projectId=proj-a`);
    const b = await request(app, "GET", `/api/command-center/team?${range}&projectId=proj-b`);

    const aAgents = (a.body as { agents: Array<{ agentId: string; agentName: string; tokens: { totalTokens: number } }> }).agents;
    const bAgents = (b.body as { agents: Array<{ agentId: string; agentName: string; tokens: { totalTokens: number } }> }).agents;
    expect(aAgents.some((agent) => agent.agentId === "agent-a-only" && agent.tokens.totalTokens === 222)).toBe(true);
    expect(aAgents.some((agent) => agent.agentId === "agent-b-only" || agent.agentName === "Project B Agent")).toBe(false);
    expect(bAgents.some((agent) => agent.agentId === "agent-b-only" && agent.tokens.totalTokens === 1998)).toBe(true);
    expect(bAgents.some((agent) => agent.agentId === "agent-a-only" || agent.agentName === "Project A Agent")).toBe(false);
  });

  it("signals endpoint returns zeroed metrics for an empty incidents table", async () => {
    const range = "from=2026-02-01T00:00:00.000Z&to=2026-04-01T00:00:00.000Z";
    const res = await request(app, "GET", `/api/command-center/signals?${range}&projectId=proj-a`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      totalSignals: 0,
      open: 0,
      resolved: 0,
      mttr: { value: null, unavailable: true, sampleCount: 0 },
      bySource: [],
      bySeverity: [],
      connectors: { configured: [], anyConfigured: false },
    });
  });

  it("signals connectors endpoint reports env-backed configuration without leaking secrets", async () => {
    process.env.FUSION_SIGNAL_WEBHOOK_SECRET = "webhook-secret-value";
    process.env.FUSION_SIGNAL_DATADOG_SECRET = "datadog-secret-value";
    process.env.FUSION_SIGNAL_GITLAB_SECRET = "gitlab-secret-value";

    const a = await request(app, "GET", "/api/command-center/signals/connectors?projectId=proj-a");
    const b = await request(app, "GET", "/api/command-center/signals/connectors?projectId=proj-b");

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body).toEqual(b.body);
    expect(a.body).toEqual({
      connectors: [
        { provider: "webhook", configured: true },
        { provider: "sentry", configured: false },
        { provider: "datadog", configured: true },
        { provider: "pagerduty", configured: false },
        { provider: "gitlab", configured: true },
      ],
    });
    const serialized = JSON.stringify(a.body);
    expect(serialized).not.toContain("webhook-secret-value");
    expect(serialized).not.toContain("datadog-secret-value");
    expect(serialized).not.toContain("gitlab-secret-value");
  });

  it("signals endpoint defaults invalid ranges and stays project scoped", async () => {
    seedSignalMetrics(dbA, { prefix: "SIG-A", source: "sentry", open: 1, resolved: 1 });
    seedSignalMetrics(dbB, { prefix: "SIG-B", source: "pagerduty", open: 3, resolved: 2 });

    const invalid = await request(
      app,
      "GET",
      "/api/command-center/signals?from=bad&to=range&projectId=proj-a",
    );
    expect(invalid.status).toBe(200);
    expect(invalid.body).toHaveProperty("totalSignals");
    expect(invalid.body).toHaveProperty("mttr");
    expect(invalid.body).toHaveProperty("bySource");
    expect(invalid.body).toMatchObject({ connectors: { configured: [], anyConfigured: false } });

    process.env.FUSION_SIGNAL_PAGERDUTY_SECRET = "configured-pd";
    const range = "from=2026-02-01T00:00:00.000Z&to=2026-04-01T00:00:00.000Z";
    const a = await request(app, "GET", `/api/command-center/signals?${range}&projectId=proj-a`);
    const b = await request(app, "GET", `/api/command-center/signals?${range}&projectId=proj-b`);
    expect(a.body).toMatchObject({ totalSignals: 2, open: 1, resolved: 1, connectors: { configured: ["pagerduty"], anyConfigured: true } });
    expect(b.body).toMatchObject({ totalSignals: 5, open: 3, resolved: 2, connectors: { configured: ["pagerduty"], anyConfigured: true } });
    expect((a.body as { bySource: Array<{ source: string }> }).bySource).toContainEqual(expect.objectContaining({ source: "sentry" }));
    expect((a.body as { bySource: Array<{ source: string }> }).bySource).not.toContainEqual(expect.objectContaining({ source: "pagerduty" }));
  });

  it("github endpoint defaults invalid ranges and stays project scoped", async () => {
    seedGithubIssueMetrics(dbA, { prefix: "FN-A", repo: "acme/alpha", filed: 2, fixed: 1 });
    seedGithubIssueMetrics(dbB, { prefix: "FN-B", repo: "acme/beta", filed: 5, fixed: 4 });
    const invalid = await request(
      app,
      "GET",
      "/api/command-center/github?from=bad&to=range&projectId=proj-a",
    );
    expect(invalid.status).toBe(200);
    expect(invalid.body).toHaveProperty("filed");
    expect(invalid.body).toHaveProperty("fixed");
    expect(invalid.body).toHaveProperty("daily");
    expect(invalid.body).toHaveProperty("byRepo");
    expect(invalid.body).toHaveProperty("resolved");

    const range = "from=2026-02-01T00:00:00.000Z&to=2026-04-01T00:00:00.000Z";
    const a = await request(app, "GET", `/api/command-center/github?${range}&projectId=proj-a`);
    const b = await request(app, "GET", `/api/command-center/github?${range}&projectId=proj-b`);
    expect(a.body).toMatchObject({ filed: 2, fixed: 1 });
    expect(b.body).toMatchObject({ filed: 5, fixed: 4 });
    expect((a.body as { resolved: Array<{ repo: string; taskId: string }> }).resolved).toHaveLength(1);
    expect((a.body as { resolved: Array<{ repo: string; taskId: string }> }).resolved[0]).toMatchObject({
      repo: "acme/alpha",
      taskId: "FN-A-fixed-0",
    });
    expect((a.body as { resolved: Array<{ repo: string }> }).resolved).not.toContainEqual(expect.objectContaining({ repo: "acme/beta" }));
    expect((b.body as { resolved: Array<{ repo: string; taskId: string }> }).resolved).toHaveLength(4);
    expect((b.body as { resolved: Array<{ repo: string; taskId: string }> }).resolved[0]).toMatchObject({
      repo: "acme/beta",
      taskId: "FN-B-fixed-0",
    });
  });

  it("?format=csv returns well-formed CSV with attachment header", async () => {
    const res = await request(
      app,
      "GET",
      "/api/command-center/tokens?from=2026-02-01T00:00:00.000Z&to=2026-04-01T00:00:00.000Z&groupBy=model&projectId=proj-a&format=csv",
    );
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.headers["content-disposition"]).toBe(
      'attachment; filename="command-center-tokens.csv"',
    );
    const csv = res.body as string;
    const lines = csv.split("\r\n").filter((l) => l.length > 0);
    // Header row + one model group row (claude-sonnet-4-5, total 200).
    expect(lines[0]).toContain("totalTokens");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("claude-sonnet-4-5");
    expect(lines[1]).toContain("200");
  });

  it("?format=csv empty result returns header-only CSV, not a 204", async () => {
    // Window with no data → header-only.
    const res = await request(
      app,
      "GET",
      "/api/command-center/tokens?from=2020-01-01T00:00:00.000Z&to=2020-01-02T00:00:00.000Z&projectId=proj-a&format=csv",
    );
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    const csv = res.body as string;
    const lines = csv.split("\r\n").filter((l) => l.length > 0);
    // No groupBy → always a single (total) row of zeros, plus the header.
    expect(lines[0]).toContain("totalTokens");
    expect(lines[1]).toContain("(total)");
    expect(lines[1]).toContain(",0,");
  });

  it("?format=csv includes workflow detail rows", async () => {
    const range = "from=2026-02-01T00:00:00.000Z&to=2026-04-01T00:00:00.000Z";
    seedWorkflowMetrics(dbA, { taskId: "FN-A-workflow-csv", workflowId: "WF-csv", workflowName: "CSV Workflow", tokens: 123 });

    const res = await request(
      app,
      "GET",
      `/api/command-center/workflows?${range}&projectId=proj-a&format=csv`,
    );

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.headers["content-disposition"]).toBe(
      'attachment; filename="command-center-workflows.csv"',
    );
    const csv = res.body as string;
    expect(csv).toContain("workflowId,workflowName,isBuiltin");
    expect(csv).toContain("WF-csv,CSV Workflow,false");
    expect(csv).toContain("(total),(total),");
  });

  it("?format=csv includes GitHub resolved issue detail rows", async () => {
    seedGithubIssueMetrics(dbA, { prefix: "FN-A", repo: "acme/alpha", filed: 1, fixed: 1 });
    seedGithubIssueMetrics(dbB, { prefix: "FN-B", repo: "acme/beta", filed: 1, fixed: 1 });
    const range = "from=2026-02-01T00:00:00.000Z&to=2026-04-01T00:00:00.000Z";

    const a = await request(
      app,
      "GET",
      `/api/command-center/github?${range}&projectId=proj-a&format=csv`,
    );
    const b = await request(
      app,
      "GET",
      `/api/command-center/github?${range}&projectId=proj-b&format=csv`,
    );

    expect(a.status).toBe(200);
    expect(a.headers["content-disposition"]).toBe(
      'attachment; filename="command-center-github.csv"',
    );
    expect(a.body as string).toContain("section,key,filed,fixed,net,taskId,taskTitle,resolvedAt,resolvedAtExact,url");
    expect(a.body as string).toContain("resolved,acme/alpha#100,,,,FN-A-fixed-0,Resolve acme/alpha#100,2026-03-03T12:00:00.000Z,true,https://github.com/acme/alpha/issues/100");
    expect(a.body as string).not.toContain("acme/beta#100");
    expect(b.body as string).toContain("resolved,acme/beta#100,,,,FN-B-fixed-0");
    expect(b.body as string).not.toContain("acme/alpha#100");
  });

  it("?format=csv RFC-4180 quotes values with commas/quotes/newlines", async () => {
    // Seed a task whose model id contains a comma + quote + newline so the
    // groupBy=model group key forces RFC-4180 quoting through the export path.
    const nasty = 'mod,el "x"\nline2';
    dbA.prepare(
      `INSERT INTO tasks
         (id, description, "column", modelProvider, modelId,
          tokenUsageInputTokens, tokenUsageOutputTokens, tokenUsageTotalTokens,
          tokenUsageLastUsedAt, createdAt, updatedAt)
       VALUES ('FN-A2', 'd', 'todo', 'anthropic', ?, 5, 5, 10,
               '2026-03-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z',
               '2026-03-01T00:00:00.000Z')`,
    ).run(nasty);

    const res = await request(
      app,
      "GET",
      "/api/command-center/tokens?from=2026-02-01T00:00:00.000Z&to=2026-04-01T00:00:00.000Z&groupBy=model&projectId=proj-a&format=csv",
    );
    expect(res.status).toBe(200);
    const csv = res.body as string;
    // The nasty key must appear quoted with the embedded quote doubled.
    expect(csv).toContain('"mod,el ""x""\nline2"');
  });

  it("?format=csv is project-scoped — A cannot retrieve B's data", async () => {
    const a = await request(
      app,
      "GET",
      "/api/command-center/tokens?from=2026-02-01T00:00:00.000Z&to=2026-04-01T00:00:00.000Z&projectId=proj-a&format=csv",
    );
    const b = await request(
      app,
      "GET",
      "/api/command-center/tokens?from=2026-02-01T00:00:00.000Z&to=2026-04-01T00:00:00.000Z&projectId=proj-b&format=csv",
    );
    // A total = 200, B total = 1998. Neither CSV may contain the other's total.
    expect(a.body as string).toContain("200");
    expect(a.body as string).not.toContain("1998");
    expect(b.body as string).toContain("1998");
    expect(b.body as string).not.toContain(",200,");
  });

  it("?format=csv works for tools / activity / productivity endpoints", async () => {
    const range = "from=2026-02-01T00:00:00.000Z&to=2026-04-01T00:00:00.000Z";
    seedCompletedTaskDuration(dbA, { id: "FN-DCSV", cumulativeActiveMs: 120_000, completedAt: "2026-03-03T00:00:00.000Z" });
    for (const [path, filename] of [
      ["tools", "command-center-tools.csv"],
      ["activity", "command-center-activity.csv"],
      ["productivity", "command-center-productivity.csv"],
      ["workflows", "command-center-workflows.csv"],
      ["github", "command-center-github.csv"],
    ]) {
      const res = await request(
        app,
        "GET",
        `/api/command-center/${path}?${range}&projectId=proj-a&format=csv`,
      );
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("text/csv");
      expect(res.headers["content-disposition"]).toBe(
        `attachment; filename="${filename}"`,
      );
      expect((res.body as string).split("\r\n")[0].length).toBeGreaterThan(0);
      if (path === "productivity") {
        expect(res.body as string).toContain("completedTasks,1");
        expect(res.body as string).toContain("avgDurationMs,120000");
        expect(res.body as string).toContain("medianDurationMs,120000");
        expect(res.body as string).toContain("p90DurationMs,120000");
        expect(res.body as string).toContain("totalDurationMs,120000");
      }
    }
  });

  it("project scoping — /live is scoped per project", async () => {
    // Add a distinguishing 'in-review' task only to project B.
    dbB.prepare(
      `INSERT INTO tasks (id, description, "column", createdAt, updatedAt)
       VALUES ('FN-B2', 'd', 'in-review', '2026-03-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z')`,
    ).run();

    const a = await request(app, "GET", "/api/command-center/live?projectId=proj-a");
    const b = await request(app, "GET", "/api/command-center/live?projectId=proj-b");
    const aColumns = (a.body as { columns: { column: string }[] }).columns.map((c) => c.column);
    const bColumns = (b.body as { columns: { column: string }[] }).columns.map((c) => c.column);
    expect(aColumns).not.toContain("in-review");
    expect(bColumns).toContain("in-review");
  });
});

describe("resolveRange / resolveGroupBy / resolveTokenGranularity (param parsing)", () => {
  const NOW = Date.parse("2026-06-15T00:00:00.000Z");

  it("uses valid, ordered ISO bounds as-is", () => {
    const r = resolveRange(
      { from: "2026-06-01T00:00:00.000Z", to: "2026-06-10T00:00:00.000Z" },
      NOW,
    );
    expect(r.defaulted).toBe(false);
    expect(r.from).toBe("2026-06-01T00:00:00.000Z");
    expect(r.to).toBe("2026-06-10T00:00:00.000Z");
  });

  it("defaults to the last-7d window for missing params", () => {
    const r = resolveRange({}, NOW);
    expect(r.defaulted).toBe(true);
    expect(r.to).toBe(new Date(NOW).toISOString());
    expect(r.from).toBe(
      new Date(NOW - DEFAULT_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString(),
    );
  });

  it("defaults when from > to (inverted range)", () => {
    const r = resolveRange(
      { from: "2026-06-10T00:00:00.000Z", to: "2026-06-01T00:00:00.000Z" },
      NOW,
    );
    expect(r.defaulted).toBe(true);
  });

  it("honors a from-only bound as the symptom regression anchor", () => {
    const r = resolveRange({ from: "2026-06-01T00:00:00.000Z" }, NOW);
    expect(r.defaulted).toBe(false);
    expect(r.from).toBe("2026-06-01T00:00:00.000Z");
    expect(r.to).toBe(new Date(NOW).toISOString());
  });

  it("honors a to-only bound as an all-history window through that date", () => {
    const r = resolveRange({ to: "2026-06-10T00:00:00.000Z" }, NOW);
    expect(r.defaulted).toBe(false);
    expect(r.from).toBe(new Date(0).toISOString());
    expect(r.to).toBe("2026-06-10T00:00:00.000Z");
  });

  it("uses the remaining valid bound when the other bound is unparseable", () => {
    const toOnly = resolveRange({ from: "garbage", to: "2026-06-10T00:00:00.000Z" }, NOW);
    expect(toOnly).toEqual({
      from: new Date(0).toISOString(),
      to: "2026-06-10T00:00:00.000Z",
      defaulted: false,
    });

    const fromOnly = resolveRange({ from: "2026-06-01T00:00:00.000Z", to: "garbage" }, NOW);
    expect(fromOnly).toEqual({
      from: "2026-06-01T00:00:00.000Z",
      to: new Date(NOW).toISOString(),
      defaulted: false,
    });
  });

  it("defaults only when neither bound is usable", () => {
    const r = resolveRange({ from: "garbage", to: "also-bad" }, NOW);
    expect(r.defaulted).toBe(true);
    expect(r.to).toBe(new Date(NOW).toISOString());
    expect(r.from).toBe(new Date(NOW - DEFAULT_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString());
  });

  it("accepts known groupBy values and ignores unknown ones", () => {
    expect(resolveGroupBy({ groupBy: "model" })).toBe("model");
    expect(resolveGroupBy({ groupBy: "provider" })).toBe("provider");
    expect(resolveGroupBy({ groupBy: "bogus" })).toBeUndefined();
    expect(resolveGroupBy({})).toBeUndefined();
  });

  it("accepts known token granularities and ignores unknown ones", () => {
    expect(resolveTokenGranularity({ granularity: "hour" })).toBe("hour");
    expect(resolveTokenGranularity({ granularity: "day" })).toBe("day");
    expect(resolveTokenGranularity({ granularity: "week" })).toBe("week");
    expect(resolveTokenGranularity({ granularity: "minute" })).toBeUndefined();
    expect(resolveTokenGranularity({})).toBeUndefined();
  });
});

describe("vite /api proxy negative-lookahead (proxy verification)", () => {
  // The exact key from packages/dashboard/vite.config.ts's server.proxy. Real
  // /api endpoints must proxy to the backend; app source modules ending in a
  // .ts/.tsx (?import) suffix must stay on the Vite dev server.
  const PROXY_RE = new RegExp("^/api(?!/.*\\.[jt]sx?(?:\\?|$))(/|$)");

  it("proxies the real command-center endpoints to the backend", () => {
    expect(PROXY_RE.test("/api/command-center/tokens")).toBe(true);
    expect(PROXY_RE.test("/api/command-center/team")).toBe(true);
    expect(PROXY_RE.test("/api/command-center/workflows")).toBe(true);
    expect(PROXY_RE.test("/api/command-center/live")).toBe(true);
    expect(PROXY_RE.test("/api/command-center/github")).toBe(true);
    expect(PROXY_RE.test("/api/command-center/signals")).toBe(true);
    expect(PROXY_RE.test("/api/command-center/signals/connectors")).toBe(true);
    expect(PROXY_RE.test("/api/command-center/activity?from=x&to=y")).toBe(true);
  });

  it("leaves .ts?import source module paths on Vite (not proxied)", () => {
    expect(PROXY_RE.test("/api/command-center/foo.ts?import")).toBe(false);
    expect(PROXY_RE.test("/api/command-center/Component.tsx?import")).toBe(false);
    expect(PROXY_RE.test("/api/something.ts")).toBe(false);
  });
});
