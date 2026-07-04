/**
 * FNXC:PostgresCutover 2026-07-04-00:00:
 * Migrated from the legacy SQLite `new TaskStore(tmpDir)` harness to the
 * PostgreSQL extension harness. Research runs are seeded via the PG-backed
 * AsyncResearchStore (`h.store().getResearchStore()`), and the research tools
 * resolve the same store through the harness-injected `getStore(cwd)` cache.
 */

import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { pgDescribe } from "../../../core/src/__test-utils__/pg-test-harness.js";
import {
  createPgExtensionHarness,
  createMockApi,
  registerExtension,
  requireTool,
  type ToolExecuteContext,
} from "./pg-extension-harness.js";
import { type AsyncResearchStore, type ResearchResult } from "@fusion/core";

const pgTest = pgDescribe;

/** Narrow a details payload value to a string (throws loudly if it isn't one). */
function asString(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error(`expected string, got ${typeof value}`);
  }
  return value;
}

function makeCtx(cwd: string): ToolExecuteContext {
  return { cwd };
}

pgTest("research extension tools", () => {
  const h = createPgExtensionHarness("kb-cli-research");

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  // In backend mode getResearchStore() returns the AsyncResearchStore (async methods).
  const research = (): AsyncResearchStore => h.store().getResearchStore() as AsyncResearchStore;

  it("registers research extension tools", () => {
    const api = createMockApi();
    registerExtension(api);
    expect(api.tools.has("fn_research_run")).toBe(true);
    expect(api.tools.has("fn_research_list")).toBe(true);
    expect(api.tools.has("fn_research_get")).toBe(true);
    expect(api.tools.has("fn_research_cancel")).toBe(true);
    expect(api.tools.has("fn_research_retry")).toBe(true);
  });

  it("returns feature-disabled response when experimental research flag is off", async () => {
    const store = h.store();
    await store.updateSettings({ researchSettings: { enabled: true }, experimentalFeatures: { researchView: false } as Record<string, boolean> });

    const api = createMockApi();
    registerExtension(api);
    const runTool = requireTool(api, "fn_research_run");
    const result = await runTool.execute("call-1", { query: "fusion" }, undefined, undefined, makeCtx(h.rootDir()));

    expect(result.details?.setup).toMatchObject({ code: "feature-disabled" });
    expect(result.content[0]?.text).toContain("disabled");
  });

  it("returns feature-disabled contract for list/get/cancel/retry when flag is off", async () => {
    const store = h.store();
    await store.updateSettings({ researchSettings: { enabled: true }, experimentalFeatures: { researchView: false } as Record<string, boolean> });

    const api = createMockApi();
    registerExtension(api);
    const listResult = await requireTool(api, "fn_research_list").execute("call-list", {}, undefined, undefined, makeCtx(h.rootDir()));
    expect(listResult.details?.setup).toMatchObject({ code: "feature-disabled" });

    const getResult = await requireTool(api, "fn_research_get").execute("call-get", { id: "RR-1" }, undefined, undefined, makeCtx(h.rootDir()));
    expect(getResult.details?.setup).toMatchObject({ code: "feature-disabled" });

    const cancelResult = await requireTool(api, "fn_research_cancel").execute("call-cancel", { id: "RR-1" }, undefined, undefined, makeCtx(h.rootDir()));
    expect(cancelResult.isError).toBe(true);
    expect(cancelResult.details?.setup).toMatchObject({ code: "feature-disabled" });

    const retryResult = await requireTool(api, "fn_research_retry").execute("call-retry", { id: "RR-1" }, undefined, undefined, makeCtx(h.rootDir()));
    expect(retryResult.isError).toBe(true);
    expect(retryResult.details?.setup).toMatchObject({ code: "feature-disabled" });
  });

  it("treats builtin as configured when no provider is explicitly set", async () => {
    const store = h.store();
    await store.updateGlobalSettings({
      experimentalFeatures: { researchView: true } as Record<string, boolean>,
      researchGlobalEnabled: true,
    });
    await store.updateSettings({
      researchSettings: { enabled: true },
    });

    const api = createMockApi();
    registerExtension(api);
    const runTool = requireTool(api, "fn_research_run");
    const result = await runTool.execute("call-builtin", { query: "fusion" }, undefined, undefined, makeCtx(h.rootDir()));

    expect(result.details?.setup).toBeNull();
    expect(result.details?.status).toBe("queued");
  });

  it("returns actionable missing-credentials response", async () => {
    const store = h.store();
    await store.updateGlobalSettings({
      experimentalFeatures: { researchView: true } as Record<string, boolean>,
      researchGlobalEnabled: true,
      researchGlobalWebSearchProvider: "tavily",
      researchGlobalDefaults: { searchProvider: "tavily" },
    });
    await store.updateSettings({
      researchSettings: { enabled: true },
    });

    const api = createMockApi();
    registerExtension(api);
    const runTool = requireTool(api, "fn_research_run");
    const result = await runTool.execute("call-0", { query: "fusion" }, undefined, undefined, makeCtx(h.rootDir()));

    expect(result.details?.setup).toMatchObject({ code: "missing-credentials" });
    expect(result.content[0]?.text).toContain("Missing credentials");
  });

  it("creates, reads, lists, and cancels runs", async () => {
    const store = h.store();
    await store.updateGlobalSettings({
      experimentalFeatures: { researchView: true } as Record<string, boolean>,
      researchGlobalEnabled: true,
      researchGlobalWebSearchProvider: "searxng",
      researchGlobalSearxngUrl: "http://localhost:8888",
      researchGlobalDefaults: { searchProvider: "searxng" },
    });
    await store.updateSettings({
      researchSettings: { enabled: true, searchProvider: "searxng" },
    });

    const created = await research().createRun({ query: "fusion architecture", topic: "fusion architecture" });

    const api = createMockApi();
    registerExtension(api);
    const listResult = await requireTool(api, "fn_research_list").execute("call-2", {}, undefined, undefined, makeCtx(h.rootDir()));
    const runs = listResult.details?.runs;
    if (!Array.isArray(runs)) throw new Error("expected runs array");
    expect(runs.length).toBeGreaterThan(0);

    const getResult = await requireTool(api, "fn_research_get").execute("call-3", { id: created.id }, undefined, undefined, makeCtx(h.rootDir()));
    expect(getResult.details?.runId).toBe(created.id);

    const cancelResult = await requireTool(api, "fn_research_cancel").execute("call-4", { id: created.id }, undefined, undefined, makeCtx(h.rootDir()));
    const cancelStatus = cancelResult.details?.status;
    expect(cancelStatus === "cancelling" || cancelStatus === "cancelled").toBe(true);

    const retryResult = await requireTool(api, "fn_research_retry").execute("call-5", { id: created.id }, undefined, undefined, makeCtx(h.rootDir()));
    expect(retryResult.isError).toBe(true);
  });

  it("returns structured missing-run details for get and cancel", async () => {
    const store = h.store();
    await store.updateGlobalSettings({
      experimentalFeatures: { researchView: true } as Record<string, boolean>,
      researchGlobalEnabled: true,
      researchGlobalWebSearchProvider: "searxng",
      researchGlobalSearxngUrl: "http://localhost:8888",
      researchGlobalDefaults: { searchProvider: "searxng" },
    });
    await store.updateSettings({
      researchSettings: { enabled: true, searchProvider: "searxng" },
    });

    const api = createMockApi();
    registerExtension(api);
    const getResult = await requireTool(api, "fn_research_get").execute("call-missing-get", { id: "RR-404" }, undefined, undefined, makeCtx(h.rootDir()));
    expect(getResult.details?.runId).toBe("RR-404");
    expect(getResult.details?.status).toBe("missing");
    expect(getResult.details?.setup).toMatchObject({ code: "NOT_FOUND" });

    const cancelResult = await requireTool(api, "fn_research_cancel").execute("call-missing-cancel", { id: "RR-404" }, undefined, undefined, makeCtx(h.rootDir()));
    expect(cancelResult.isError).toBe(true);
    expect(cancelResult.details?.runId).toBe("RR-404");
    expect(cancelResult.details?.setup).toMatchObject({ code: "NOT_FOUND" });
  });

  it("returns completed-run structured findings and citations", async () => {
    const store = h.store();
    await store.updateGlobalSettings({
      experimentalFeatures: { researchView: true } as Record<string, boolean>,
      researchGlobalEnabled: true,
      researchGlobalWebSearchProvider: "searxng",
      researchGlobalSearxngUrl: "http://localhost:8888",
      researchGlobalDefaults: { searchProvider: "searxng" },
    });
    await store.updateSettings({
      researchSettings: { enabled: true, searchProvider: "searxng" },
    });

    const run = await research().createRun({ query: "fusion", topic: "fusion" });
    // The persisted result carries structured citations; the ResearchResult type
    // declares citations as string[], so narrow once at this test boundary.
    const results = {
      summary: "Summary text",
      findings: [{ heading: "Finding A", content: "Detail A", sources: ["https://example.com/a"] }],
      citations: [{ title: "Source A", url: "https://example.com/a" }],
    } as unknown as ResearchResult;
    await research().setResults(run.id, results);
    await research().updateStatus(run.id, "running");
    await research().updateStatus(run.id, "completed");

    const api = createMockApi();
    registerExtension(api);
    const result = await requireTool(api, "fn_research_get").execute("call-complete", { id: run.id }, undefined, undefined, makeCtx(h.rootDir()));
    expect(result.details?.runId).toBe(run.id);
    expect(result.details?.status).toBe("completed");
    expect(result.details?.summary).toBe("Summary text");
    expect(result.details?.findings).toHaveLength(1);
    expect(result.details?.findings).toMatchObject([{ heading: "Finding A", content: "Detail A" }]);
    expect(result.details?.citations).toHaveLength(1);
    expect(result.details?.citations).toMatchObject([{ title: "Source A", url: "https://example.com/a" }]);
  });

  it("retries failed run and returns retry linkage metadata", async () => {
    const store = h.store();
    await store.updateGlobalSettings({
      experimentalFeatures: { researchView: true } as Record<string, boolean>,
      researchGlobalEnabled: true,
      researchGlobalWebSearchProvider: "searxng",
      researchGlobalSearxngUrl: "http://localhost:8888",
      researchGlobalDefaults: { searchProvider: "searxng" },
    });
    await store.updateSettings({
      researchSettings: { enabled: true, searchProvider: "searxng" },
    });

    const lifecycle = { retryable: true, attempt: 1, maxAttempts: 3, failureClass: "retryable_transient" };
    const run = await research().createRun({ query: "fusion", topic: "fusion", lifecycle });
    await research().updateStatus(run.id, "running", { lifecycle });
    await research().updateStatus(run.id, "failed", { lifecycle });

    const api = createMockApi();
    registerExtension(api);
    const retryResult = await requireTool(api, "fn_research_retry").execute("call-retry", { id: run.id }, undefined, undefined, makeCtx(h.rootDir()));

    expect(retryResult.isError).not.toBe(true);
    const retryStatus = retryResult.details?.status;
    expect(retryStatus === "queued" || retryStatus === "retry_waiting").toBe(true);
    const newRunId = asString(retryResult.details?.runId);
    expect(newRunId).not.toBe(run.id);

    const retried = await research().getRun(newRunId);
    expect(retried?.status).toBe("retry_waiting");
    expect(retried?.lifecycle?.retryOfRunId).toBe(run.id);
    expect(retried?.lifecycle?.rootRunId).toBe(run.id);
    expect(retried?.lifecycle?.attempt).toBe(2);
  });

  it("returns INVALID_TRANSITION for cancel on terminal run", async () => {
    const store = h.store();
    await store.updateGlobalSettings({
      experimentalFeatures: { researchView: true } as Record<string, boolean>,
      researchGlobalEnabled: true,
      researchGlobalWebSearchProvider: "searxng",
      researchGlobalSearxngUrl: "http://localhost:8888",
      researchGlobalDefaults: { searchProvider: "searxng" },
    });
    await store.updateSettings({
      researchSettings: { enabled: true, searchProvider: "searxng" },
    });

    const run = await research().createRun({ query: "fusion", topic: "fusion" });
    await research().updateStatus(run.id, "running");
    await research().updateStatus(run.id, "completed");

    const api = createMockApi();
    registerExtension(api);
    const result = await requireTool(api, "fn_research_cancel").execute("call-6", { id: run.id }, undefined, undefined, makeCtx(h.rootDir()));
    expect(result.isError).toBe(true);
    expect(result.details?.setup).toMatchObject({ code: "INVALID_TRANSITION" });
  });
});
