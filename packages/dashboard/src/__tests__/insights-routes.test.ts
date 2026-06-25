import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskStore } from "@fusion/core";
import { TaskStore as TaskStoreClass } from "@fusion/core";
import * as coreModule from "@fusion/core";
import { request } from "../test-request.js";
import { createServer } from "../server.js";
import { createInsightsRouter } from "../insights-routes.js";
import { DEFAULT_SWEEP_INTERVAL_MS } from "../insight-run-sweeper.js";

const piMocks = vi.hoisted(() => ({
  createFnAgent: vi.fn(),
  promptWithFallback: vi.fn(),
}));

const resolverMocks = vi.hoisted(() => ({
  getOrCreateProjectStore: vi.fn(),
}));

vi.mock("@fusion-plugin-examples/hermes-runtime", () => ({
  hermesRuntimeMetadata: {
    id: "hermes-runtime",
    name: "Hermes Runtime",
    version: "0.0.0-test",
  },
}));

vi.mock("@fusion-plugin-examples/openclaw-runtime", () => ({
  openclawRuntimeMetadata: {
    id: "openclaw-runtime",
    name: "OpenClaw Runtime",
    version: "0.0.0-test",
  },
}));

vi.mock("../runtime-provider-probes.js", () => ({
  probeHermesProvider: vi.fn(),
  listHermesProviderProfiles: vi.fn(),
  probeOpenClawProvider: vi.fn(),
  probePaperclipProvider: vi.fn(),
  probePaperclipConnectionStatus: vi.fn(),
  discoverPaperclipProviderConfig: vi.fn(),
  listPaperclipCompanies: vi.fn(),
  listPaperclipCompaniesViaCli: vi.fn(),
  listPaperclipCompanyAgents: vi.fn(),
  listPaperclipCompanyAgentsViaCli: vi.fn(),
  getPaperclipCurrentAgent: vi.fn(),
  mintAgentApiKeyViaCli: vi.fn(),
}));

vi.mock("@fusion/engine", async () => {
  const actual = await vi.importActual<typeof import("@fusion/engine")>("@fusion/engine");
  return {
    ...actual,
    createFnAgent: piMocks.createFnAgent,
    promptWithFallback: piMocks.promptWithFallback,
  };
});

vi.mock("../project-store-resolver.js", async () => {
  const actual = await vi.importActual<typeof import("../project-store-resolver.js")>("../project-store-resolver.js");
  return {
    ...actual,
    getOrCreateProjectStore: resolverMocks.getOrCreateProjectStore,
  };
});

/*
FNXC:DashboardTests 2026-06-14-09:58:
FN-6444 rescues this route/API suite from the curated skip-list; awaited store closure and retrying temp cleanup prevent singleton/resource leakage from turning backfill coverage into a flaky orphan.
*/
describe("Insights routes", () => {
  let rootA: string;
  const disposableRouters: Array<{ __disposeSweeper?: () => void }> = [];
  let storeA: TaskStore;
  let app: ReturnType<typeof createServer>;

  /*
  FNXC:DashboardTests 2026-06-25-09:55:
  Only the projectId-scoped resolution test touches the project-b store. Lazily
  init storeB on first use instead of in beforeEach so the other 23 tests skip a
  second full TaskStore.init()/migrate per test (FN-5048: avoid redundant per-test
  setup, prefer narrow seams).
  */
  let rootB: string | null = null;
  let storeB: TaskStore | null = null;
  async function getStoreB(): Promise<TaskStore> {
    if (!storeB) {
      rootB = mkdtempSync(join(tmpdir(), "kb-insights-routes-b-"));
      storeB = new TaskStoreClass(rootB, join(rootB, ".fusion-global-settings"), { inMemoryDb: true });
      await storeB.init();
    }
    return storeB;
  }

  const readWorkingMemorySpy = vi.spyOn(coreModule, "readWorkingMemory");
  const readInsightsMemorySpy = vi.spyOn(coreModule, "readInsightsMemory");
  const writeInsightsMemorySpy = vi.spyOn(coreModule, "writeInsightsMemory");
  const buildPromptSpy = vi.spyOn(coreModule, "buildInsightExtractionPrompt");
  const parseResponseSpy = vi.spyOn(coreModule, "parseInsightExtractionResponse");
  const mergeInsightsSpy = vi.spyOn(coreModule, "mergeInsights");

  function createInsightsOnlyApp(store: TaskStore) {
    const app = express();
    app.use(express.json());
    const router = createInsightsRouter(store) as ReturnType<typeof createInsightsRouter> & { __disposeSweeper?: () => void };
    disposableRouters.push(router);
    app.use("/api/insights", router);
    return app;
  }

  beforeEach(async () => {
    vi.clearAllMocks();

    rootA = mkdtempSync(join(tmpdir(), "kb-insights-routes-a-"));
    rootB = null;
    storeB = null;

    storeA = new TaskStoreClass(rootA, join(rootA, ".fusion-global-settings"), { inMemoryDb: true });
    await storeA.init();

    resolverMocks.getOrCreateProjectStore.mockImplementation(async (projectId: string) => {
      if (projectId === "project-b") {
        return getStoreB();
      }
      return storeA;
    });

    app = createServer(storeA);

    readWorkingMemorySpy.mockResolvedValue("memory notes");
    readInsightsMemorySpy.mockResolvedValue(null);
    writeInsightsMemorySpy.mockResolvedValue(undefined);
    buildPromptSpy.mockReturnValue("prompt");
    parseResponseSpy.mockReturnValue({
      summary: "Extraction summary",
      insights: [],
      extractedAt: "2026-04-16T00:00:00.000Z",
    });
    mergeInsightsSpy.mockReturnValue("# merged insights");

    piMocks.createFnAgent.mockImplementation(() => ({
      session: {
        dispose: vi.fn(),
      },
    }));
    piMocks.promptWithFallback.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    vi.useRealTimers();
    while (disposableRouters.length > 0) {
      disposableRouters.pop()?.__disposeSweeper?.();
    }
    try {
      await storeA.close();
    } catch {
      // no-op
    }
    if (storeB) {
      try {
        await storeB.close();
      } catch {
        // no-op
      }
    }
    await rm(rootA, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    if (rootB) {
      await rm(rootB, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it("GET /api/insights/runs and /api/insights/runs/:id are not shadowed by /:id", async () => {
    const run = storeA.getInsightStore().createRun("", { trigger: "manual" });

    const listRes = await request(app, "GET", "/api/insights/runs");
    const getRes = await request(app, "GET", `/api/insights/runs/${run.id}`);

    expect(listRes.status).toBe(200);
    expect((listRes.body as { runs: unknown[] }).runs).toHaveLength(1);
    expect(getRes.status).toBe(200);
    expect((getRes.body as { id: string }).id).toBe(run.id);
  });

  it("GET /api/insights/runs/:id returns not-found JSON payload for unknown ids", async () => {
    const res = await request(app, "GET", "/api/insights/runs/INSR-missing");

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({
      error: expect.stringContaining("Run not found"),
    });
  });

  it("GET /api/insights applies category/status/runId filters and pagination", async () => {
    const insightStore = storeA.getInsightStore();
    const runA = insightStore.createRun("", { trigger: "manual" });
    const runB = insightStore.createRun("", { trigger: "schedule" });

    insightStore.createInsight("", { title: "A", category: "quality", status: "generated", provenance: { trigger: "manual" } });
    const insightB = insightStore.createInsight("", { title: "B", category: "quality", status: "confirmed", provenance: { trigger: "manual" } });
    const insightC = insightStore.createInsight("", { title: "C", category: "architecture", status: "confirmed", provenance: { trigger: "manual" } });
    storeA.getDatabase().prepare("UPDATE project_insights SET lastRunId = ? WHERE id = ?").run(runA.id, insightB.id);
    storeA.getDatabase().prepare("UPDATE project_insights SET lastRunId = ? WHERE id = ?").run(runB.id, insightC.id);

    const filtered = await request(app, "GET", `/api/insights?category=quality&status=confirmed&limit=1&offset=0`);
    expect(filtered.status).toBe(200);
    expect((filtered.body as { insights: Array<{ title: string }>; count: number }).count).toBe(1);
    expect((filtered.body as { insights: Array<{ title: string }> }).insights[0].title).toBe("B");

    const byRun = await request(app, "GET", `/api/insights?runId=${runB.id}`);
    expect(byRun.status).toBe(200);
    expect((byRun.body as { insights: Array<{ title: string }> }).insights.map((i) => i.title)).toEqual(["C"]);
  });

  it("GET /api/insights/runs supports trigger/status filters and pagination", async () => {
    const insightStore = storeA.getInsightStore();
    const run1 = insightStore.createRun("", { trigger: "manual" });
    const run2 = insightStore.createRun("", { trigger: "manual" });
    const run3 = insightStore.createRun("", { trigger: "schedule" });
    insightStore.updateRun(run1.id, { status: "running" });
    insightStore.updateRun(run2.id, { status: "failed" });
    insightStore.updateRun(run3.id, { status: "running" });

    const filtered = await request(app, "GET", "/api/insights/runs?trigger=manual&status=running");
    expect(filtered.status).toBe(200);
    expect((filtered.body as { runs: Array<{ id: string }> }).runs.map((r) => r.id)).toEqual([run1.id]);

    const paged = await request(app, "GET", "/api/insights/runs?limit=1&offset=1");
    expect(paged.status).toBe(200);
    expect((paged.body as { runs: unknown[] }).runs).toHaveLength(1);
  });

  it("runs startup sweep when creating insights router", async () => {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    storeA.getDatabase().prepare(`
      INSERT INTO project_insight_runs (id, projectId, trigger, status, summary, error, insightsCreated, insightsUpdated, inputMetadata, outputMetadata, createdAt, startedAt, completedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "INSR-STALE-STARTUP",
      "",
      "manual",
      "pending",
      null,
      null,
      0,
      0,
      null,
      null,
      oneHourAgo,
      null,
      null,
    );

    createInsightsOnlyApp(storeA);

    const run = storeA.getInsightStore().getRun("INSR-STALE-STARTUP");
    expect(run?.status).toBe("failed");
    expect(run?.lifecycle.terminalCause).toBe("orphaned_active_run_recovered");
    const events = storeA.getInsightStore().listRunEvents("INSR-STALE-STARTUP");
    expect(events.some((event) => event.metadata?.recoverySource === "startup")).toBe(true);
  });

  it("runs drive-by sweep on GET /api/insights/runs", async () => {
    // Create the insights app first so its startup sweep runs against an
    // empty insight store. Then insert the stale run; only the subsequent
    // GET request's drive-by sweep should observe it.
    const insightsApp = createInsightsOnlyApp(storeA);

    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    storeA.getDatabase().prepare(`
      INSERT INTO project_insight_runs (id, projectId, trigger, status, summary, error, insightsCreated, insightsUpdated, inputMetadata, outputMetadata, createdAt, startedAt, completedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "INSR-STALE-DRIVEBY",
      "",
      "manual",
      "pending",
      null,
      null,
      0,
      0,
      null,
      null,
      oneHourAgo,
      null,
      null,
    );
    const response = await request(insightsApp, "GET", "/api/insights/runs");
    expect(response.status).toBe(200);

    const run = storeA.getInsightStore().getRun("INSR-STALE-DRIVEBY");
    expect(run?.status).toBe("failed");
    const events = storeA.getInsightStore().listRunEvents("INSR-STALE-DRIVEBY");
    expect(events.some((event) => event.metadata?.recoverySource === "drive_by")).toBe(true);
  });

  it("runs periodic sweep and recover later stale rows", async () => {
    vi.useFakeTimers();

    const insightsApp = createInsightsOnlyApp(storeA);
    const first = storeA.getInsightStore().createRun("", { trigger: "manual" });
    storeA.getDatabase().prepare("UPDATE project_insight_runs SET createdAt = ? WHERE id = ?").run(
      new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      first.id,
    );

    vi.advanceTimersByTime(DEFAULT_SWEEP_INTERVAL_MS + 100);

    expect(storeA.getInsightStore().getRun(first.id)?.status).toBe("failed");

    const second = storeA.getInsightStore().createRun("", { trigger: "manual" });
    storeA.getDatabase().prepare("UPDATE project_insight_runs SET createdAt = ? WHERE id = ?").run(
      new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      second.id,
    );

    vi.advanceTimersByTime(DEFAULT_SWEEP_INTERVAL_MS + 100);

    expect(storeA.getInsightStore().getRun(second.id)?.status).toBe("failed");
    const events = storeA.getInsightStore().listRunEvents(second.id);
    expect(events.some((event) => event.metadata?.recoverySource === "periodic")).toBe(true);

    expect(insightsApp).toBeTruthy();
  });

  it("GET /api/insights and /api/insights/runs resolve projectId-scoped stores", async () => {
    const storeBInstance = await getStoreB();
    const runA = storeA.getInsightStore().createRun("", { trigger: "manual" });
    const runB = storeBInstance.getInsightStore().createRun("", { trigger: "manual" });

    storeA.getInsightStore().createInsight("", { title: "A", category: "quality", provenance: { trigger: "manual" }, status: "generated" });
    storeBInstance.getInsightStore().createInsight("", { title: "B", category: "quality", provenance: { trigger: "manual" }, status: "generated" });

    const defaultInsights = await request(app, "GET", "/api/insights");
    expect((defaultInsights.body as { insights: Array<{ title: string }> }).insights.map((i) => i.title)).toEqual(["A"]);

    const scopedInsights = await request(app, "GET", "/api/insights?projectId=project-b");
    expect((scopedInsights.body as { insights: Array<{ title: string }> }).insights.map((i) => i.title)).toEqual(["B"]);

    const defaultRuns = await request(app, "GET", "/api/insights/runs");
    expect((defaultRuns.body as { runs: Array<{ id: string }> }).runs.map((r) => r.id)).toEqual([runA.id]);

    const scopedRuns = await request(app, "GET", "/api/insights/runs?projectId=project-b");
    expect((scopedRuns.body as { runs: Array<{ id: string }> }).runs.map((r) => r.id)).toEqual([runB.id]);
  });

  it("PATCH /api/insights/:id rejects invalid category and status", async () => {
    const insight = storeA.getInsightStore().createInsight("", {
      title: "Patch me",
      category: "quality",
      provenance: { trigger: "manual" },
    });

    const badCategory = await request(
      app,
      "PATCH",
      `/api/insights/${insight.id}`,
      JSON.stringify({ category: "not-real" }),
      { "Content-Type": "application/json" },
    );
    expect(badCategory.status).toBe(400);

    const badStatus = await request(
      app,
      "PATCH",
      `/api/insights/${insight.id}`,
      JSON.stringify({ status: "broken" }),
      { "Content-Type": "application/json" },
    );
    expect(badStatus.status).toBe(400);
  });

  it("GET /api/insights/runs rejects invalid run status filter", async () => {
    const res = await request(app, "GET", "/api/insights/runs?status=not-a-status");
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toContain("Invalid run status");
  });

  it("POST /api/insights/run rejects invalid trigger", async () => {
    const res = await request(
      app,
      "POST",
      "/api/insights/run",
      JSON.stringify({ trigger: "invalid-trigger" }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toContain("Invalid trigger");
  });

  it("POST /api/insights/run returns structured 409 details when active run is still live", async () => {
    const activeRun = storeA.getInsightStore().createRun("", { trigger: "manual" });

    const res = await request(
      app,
      "POST",
      "/api/insights/run",
      JSON.stringify({ trigger: "manual" }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      error: "Insight generation is already running",
      details: {
        code: "ACTIVE_RUN_CONFLICT",
        activeRunId: activeRun.id,
        activeRunStatus: "pending",
        trigger: "manual",
      },
    });
  });

  it("POST /api/insights/run recovers stale active run older than orphan grace", async () => {
    const insightStore = storeA.getInsightStore();
    const staleRun = insightStore.createRun("", { trigger: "manual" });
    const staleAt = new Date(Date.now() - 45_000).toISOString();
    storeA.getDatabase().prepare("UPDATE project_insight_runs SET startedAt = ? WHERE id = ?").run(staleAt, staleRun.id);

    const res = await request(
      app,
      "POST",
      "/api/insights/run",
      JSON.stringify({ trigger: "manual" }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(201);

    const recoveredRun = insightStore.getRun(staleRun.id);
    expect(recoveredRun?.status).toBe("failed");
    expect(recoveredRun?.lifecycle.terminalReason).toBe("failed");
    expect(recoveredRun?.lifecycle.terminalCause).toBe("orphaned_active_run_recovered");
    expect(recoveredRun?.lifecycle.failureClass).toBe("non_retryable");
    expect(recoveredRun?.lifecycle.retryable).toBe(false);

    const events = insightStore.listRunEvents(staleRun.id);
    expect(events.some((event) => event.type === "warning" && event.message.includes("Recovered orphaned active run"))).toBe(true);
    expect(events.some((event) => event.type === "status_changed" && event.status === "failed")).toBe(true);
  });

  it("POST /api/insights/run uses createdAt fallback for stale check when startedAt is null", async () => {
    const insightStore = storeA.getInsightStore();
    const staleRun = insightStore.createRun("", { trigger: "manual" });
    const staleCreatedAt = new Date(Date.now() - 45_000).toISOString();
    storeA.getDatabase().prepare("UPDATE project_insight_runs SET createdAt = ?, startedAt = NULL WHERE id = ?").run(staleCreatedAt, staleRun.id);

    const res = await request(
      app,
      "POST",
      "/api/insights/run",
      JSON.stringify({ trigger: "manual" }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(201);
    expect(insightStore.getRun(staleRun.id)?.status).toBe("failed");
  });

  it("POST /api/insights/run does not recover young active runs before grace threshold", async () => {
    const insightStore = storeA.getInsightStore();
    const run = insightStore.createRun("", { trigger: "manual" });
    const youngAt = new Date(Date.now() - 5_000).toISOString();
    storeA.getDatabase().prepare("UPDATE project_insight_runs SET startedAt = ? WHERE id = ?").run(youngAt, run.id);

    const res = await request(
      app,
      "POST",
      "/api/insights/run",
      JSON.stringify({ trigger: "manual" }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(409);
    expect(insightStore.getRun(run.id)?.status).toBe("pending");
  });

  it("POST /api/insights/run persists completed run metadata", async () => {
    const res = await request(
      app,
      "POST",
      "/api/insights/run",
      JSON.stringify({ trigger: "manual", inputMetadata: { source: "route-test" } }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(201);
    const run = res.body as { id: string; status: string; summary: string; inputMetadata: Record<string, unknown>; completedAt: string };
    expect(run.status).toBe("completed");
    expect(run.summary).toBe("Extraction summary");
    expect(run.inputMetadata).toEqual({ source: "route-test" });
    expect(run.completedAt).toBeTruthy();

    const persisted = storeA.getInsightStore().getRun(run.id);
    expect(persisted?.status).toBe("completed");
    expect(persisted?.summary).toBe("Extraction summary");
    expect(persisted?.inputMetadata).toEqual({ source: "route-test" });
  });

  it("POST /api/insights/run marks run failed when AI execution throws", async () => {
    piMocks.promptWithFallback.mockRejectedValue(new Error("AI blew up"));

    const res = await request(
      app,
      "POST",
      "/api/insights/run",
      JSON.stringify({ trigger: "manual" }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(201);
    expect((res.body as { status: string }).status).toBe("failed");

    const runs = storeA.getInsightStore().listRuns({});
    expect(runs[0].status).toBe("failed");
    expect(runs[0].error).toContain("AI blew up");
    expect(runs[0].completedAt).toBeTruthy();
  });

  it("GET /api/insights/runs/:id/events returns durable event trail", async () => {
    const runRes = await request(
      app,
      "POST",
      "/api/insights/run",
      JSON.stringify({ trigger: "manual" }),
      { "Content-Type": "application/json" },
    );

    const run = runRes.body as { id: string };
    const eventsRes = await request(app, "GET", `/api/insights/runs/${run.id}/events`);

    expect(eventsRes.status).toBe(200);
    const events = (eventsRes.body as { events: Array<{ type: string }> }).events;
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((event) => event.type === "status_changed")).toBe(true);
  });

  it("POST /api/insights/runs/:id/cancel returns 409 for terminal run", async () => {
    const runRes = await request(
      app,
      "POST",
      "/api/insights/run",
      JSON.stringify({ trigger: "manual" }),
      { "Content-Type": "application/json" },
    );

    const run = runRes.body as { id: string };
    const cancelRes = await request(app, "POST", `/api/insights/runs/${run.id}/cancel`, JSON.stringify({}), {
      "Content-Type": "application/json",
    });

    expect(cancelRes.status).toBe(409);
  });

  it("POST /api/insights/runs/:id/retry only allows retryable failures", async () => {
    piMocks.promptWithFallback.mockRejectedValue(new Error("validation failed"));
    const failedRes = await request(
      app,
      "POST",
      "/api/insights/run",
      JSON.stringify({ trigger: "manual" }),
      { "Content-Type": "application/json" },
    );
    const failedRun = failedRes.body as { id: string };

    const retryRes = await request(app, "POST", `/api/insights/runs/${failedRun.id}/retry`, JSON.stringify({}), {
      "Content-Type": "application/json",
    });
    expect(retryRes.status).toBe(409);

    piMocks.promptWithFallback.mockRejectedValue(new Error("HTTP 503"));
    const retryableRunRes = await request(
      app,
      "POST",
      "/api/insights/run",
      JSON.stringify({ trigger: "manual" }),
      { "Content-Type": "application/json" },
    );
    const retryableRun = retryableRunRes.body as { id: string };

    piMocks.promptWithFallback.mockResolvedValue(undefined);
    const retriedRes = await request(app, "POST", `/api/insights/runs/${retryableRun.id}/retry`, JSON.stringify({}), {
      "Content-Type": "application/json",
    });
    expect(retriedRes.status).toBe(201);
    const retried = retriedRes.body as { lifecycle: { retryOfRunId: string } };
    expect(retried.lifecycle.retryOfRunId).toBe(retryableRun.id);
  });

  it("POST /api/insights/runs/:id/retry preserves the original run's custom model", async () => {
    // Create a run with a custom model that fails with a retryable error
    piMocks.promptWithFallback.mockRejectedValue(new Error("HTTP 503"));
    const failedRes = await request(
      app,
      "POST",
      "/api/insights/run",
      JSON.stringify({
        trigger: "manual",
        modelProvider: "openai",
        modelId: "gpt-4o",
      }),
      { "Content-Type": "application/json" },
    );
    expect(failedRes.status).toBe(201);
    const failedRun = failedRes.body as { id: string; inputMetadata: Record<string, unknown> };

    // The failed run should have persisted the model info in inputMetadata
    expect(failedRun.inputMetadata?.metadata).toMatchObject({
      modelProvider: "openai",
      modelId: "gpt-4o",
    });

    // Reset mock so retry succeeds
    piMocks.promptWithFallback.mockResolvedValue(undefined);
    piMocks.createFnAgent.mockClear();

    const retriedRes = await request(app, "POST", `/api/insights/runs/${failedRun.id}/retry`, JSON.stringify({}), {
      "Content-Type": "application/json",
    });
    expect(retriedRes.status).toBe(201);

    // The retry should pass the original model to createFnAgent
    expect(piMocks.createFnAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultProvider: "openai",
        defaultModelId: "gpt-4o",
      }),
    );
  });

  it("POST /api/insights/run passes explicit model override to createFnAgent", async () => {
    const res = await request(
      app,
      "POST",
      "/api/insights/run",
      JSON.stringify({
        trigger: "manual",
        modelProvider: "openai",
        modelId: "gpt-4o",
      }),
      { "Content-Type": "application/json" },
    );
    expect(res.status).toBe(201);

    // createFnAgent should have been called with the explicit override
    expect(piMocks.createFnAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultProvider: "openai",
        defaultModelId: "gpt-4o",
        fallbackProvider: undefined,
        fallbackModelId: undefined,
      }),
    );
  });

  it("POST /api/insights/run without model override uses settings resolution", async () => {
    const res = await request(
      app,
      "POST",
      "/api/insights/run",
      JSON.stringify({
        trigger: "manual",
      }),
      { "Content-Type": "application/json" },
    );
    expect(res.status).toBe(201);

    // Without override, provider/model come from settings resolution
    // (which returns undefined when no planning settings are configured)
    expect(piMocks.createFnAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        fallbackProvider: undefined,
        fallbackModelId: undefined,
      }),
    );
  });

  it("POST /api/insights/:id/create-task returns task-conversion payload", async () => {
    const insight = storeA.getInsightStore().createInsight("", {
      title: "Refactor parser",
      content: "Normalize parser edge cases",
      category: "quality",
      provenance: { trigger: "manual" },
    });

    const res = await request(app, "POST", `/api/insights/${insight.id}/create-task`, JSON.stringify({}), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      insight: expect.objectContaining({ id: insight.id, title: "Refactor parser" }),
      suggestedTitle: "Refactor parser",
      suggestedDescription: "Normalize parser edge cases",
    });
  });
});
