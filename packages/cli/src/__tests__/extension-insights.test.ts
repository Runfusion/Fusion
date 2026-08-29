/**
 * FNXC:PostgresCutover 2026-07-04-00:00:
 * Migrated from the legacy SQLite `new TaskStore(rootDir)` harness to the
 * PostgreSQL extension harness. The insight tools resolve a PG-backed store
 * via `getStore(cwd)` (injected by the harness); insights and runs are seeded
 * through the AsyncInsightStore returned by `h.store().getInsightStore()`
 * (async upsertInsight / createRun / updateRun) instead of the removed sync
 * SQLite path.
 */

import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import type { AsyncInsightStore } from "@fusion/core";
import { pgDescribe } from "../../../core/src/__test-utils__/pg-test-harness.js";
import {
  createPgExtensionHarness,
  createMockApi,
  registerExtension,
  requireTool,
} from "./pg-extension-harness.js";

const pgTest = pgDescribe;

pgTest("fn insight extension tools", () => {
  const h = createPgExtensionHarness("fn-ext-insights");

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  // In backend mode getInsightStore() returns the async (AsyncDataLayer-backed) store.
  const insights = (): AsyncInsightStore => h.store().getInsightStore() as AsyncInsightStore;

  it("registers all insight tools", () => {
    const api = createMockApi();
    registerExtension(api);
    expect(api.tools.has("fn_insight_list")).toBe(true);
    expect(api.tools.has("fn_insight_show")).toBe(true);
    expect(api.tools.has("fn_insight_run_list")).toBe(true);
    expect(api.tools.has("fn_insight_run_show")).toBe(true);
  });

  it("lists and shows persisted insights", async () => {
    const created = await insights().upsertInsight("", {
      title: "Agent-visible insight",
      category: "quality",
      content: "Ensure this appears in extension output",
      provenance: { trigger: "manual" },
      status: "generated",
      fingerprint: "ext-insights-quality-1",
    });

    const api = createMockApi();
    registerExtension(api);
    const listTool = requireTool(api, "fn_insight_list");
    const listResult = await listTool.execute(
      "call-1",
      { category: "quality" },
      undefined,
      undefined,
      { cwd: h.rootDir() },
    );
    expect(listResult.content[0]?.text).toContain(created.id);
    expect(listResult.details?.insights).toHaveLength(1);

    const showTool = requireTool(api, "fn_insight_show");
    const showResult = await showTool.execute(
      "call-2",
      { id: created.id },
      undefined,
      undefined,
      { cwd: h.rootDir() },
    );
    expect(showResult.content[0]?.text).toContain("Agent-visible insight");
    expect(showResult.details?.insight).toMatchObject({ id: created.id });
  });

  it("lists and shows insight runs", async () => {
    const s = insights();
    const run = await s.createRun("", { trigger: "manual" });
    await s.updateRun(run.id, { status: "completed", insightsCreated: 2, insightsUpdated: 1 });

    const api = createMockApi();
    registerExtension(api);
    const listTool = requireTool(api, "fn_insight_run_list");
    const listResult = await listTool.execute(
      "call-3",
      { status: "completed" },
      undefined,
      undefined,
      { cwd: h.rootDir() },
    );
    expect(listResult.content[0]?.text).toContain(run.id);
    expect(listResult.details?.runs).toHaveLength(1);

    const showTool = requireTool(api, "fn_insight_run_show");
    const showResult = await showTool.execute(
      "call-4",
      { id: run.id },
      undefined,
      undefined,
      { cwd: h.rootDir() },
    );
    expect(showResult.content[0]?.text).toContain("Status: completed");
    expect(showResult.details?.run).toMatchObject({ id: run.id });
  });

  it("returns helpful errors for invalid pagination and missing IDs", async () => {
    const api = createMockApi();
    registerExtension(api);
    const listTool = requireTool(api, "fn_insight_list");
    const invalidList = await listTool.execute(
      "call-5",
      { limit: 0 },
      undefined,
      undefined,
      { cwd: h.rootDir() },
    );
    expect(invalidList.isError).toBe(true);
    expect(invalidList.content[0]?.text).toContain("Invalid limit");

    const showTool = requireTool(api, "fn_insight_show");
    const missing = await showTool.execute(
      "call-6",
      { id: "INS-MISSING" },
      undefined,
      undefined,
      { cwd: h.rootDir() },
    );
    expect(missing.isError).toBe(true);
    expect(missing.content[0]?.text).toContain("not found");
  });
});
