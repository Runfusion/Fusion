import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import kbExtension, { closeCachedStores } from "../extension.js";
import { TaskStore } from "@fusion/core";

interface RegisteredTool {
  name: string;
  execute: (
    toolCallId: string,
    params: any,
    signal: AbortSignal | undefined,
    onUpdate: ((update: any) => void) | undefined,
    ctx: any,
  ) => Promise<any>;
}

function createMockAPI() {
  const tools = new Map<string, RegisteredTool>();
  return {
    registerTool(def: RegisteredTool) {
      tools.set(def.name, def);
    },
    registerCommand() {},
    registerShortcut() {},
    registerFlag() {},
    on() {},
    tools,
  } as any;
}

function makeCtx(cwd: string) {
  return { cwd } as any;
}

describe("fn insight extension tools", () => {
  let tmpDir: string;
  let api: ReturnType<typeof createMockAPI>;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "kb-ext-insights-test-"));
    api = createMockAPI();
    kbExtension(api);
  });

  afterEach(async () => {
    await closeCachedStores();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("registers all insight tools", () => {
    expect(api.tools.has("fn_insight_list")).toBe(true);
    expect(api.tools.has("fn_insight_show")).toBe(true);
    expect(api.tools.has("fn_insight_run_list")).toBe(true);
    expect(api.tools.has("fn_insight_run_show")).toBe(true);
  });

  it("lists and shows persisted insights", async () => {
    const store = new TaskStore(tmpDir);
    await store.init();
    const insightStore = store.getInsightStore();

    const created = insightStore.createInsight("", {
      title: "Agent-visible insight",
      category: "quality",
      status: "generated",
      provenance: { trigger: "manual" },
      content: "Ensure this appears in extension output",
    });
    await store.close();

    const listTool = api.tools.get("fn_insight_list")!;
    const listResult = await listTool.execute("call-1", { category: "quality" }, undefined, undefined, makeCtx(tmpDir));
    expect(listResult.content[0].text).toContain(created.id);
    expect(listResult.details.insights).toHaveLength(1);

    const showTool = api.tools.get("fn_insight_show")!;
    const showResult = await showTool.execute("call-2", { id: created.id }, undefined, undefined, makeCtx(tmpDir));
    expect(showResult.content[0].text).toContain("Agent-visible insight");
    expect(showResult.details.insight.id).toBe(created.id);
  });

  it("lists and shows insight runs", async () => {
    const store = new TaskStore(tmpDir);
    await store.init();
    const insightStore = store.getInsightStore();

    const run = insightStore.createRun("", { trigger: "manual" });
    insightStore.updateRun(run.id, { status: "completed", insightsCreated: 2, insightsUpdated: 1 });
    await store.close();

    const listTool = api.tools.get("fn_insight_run_list")!;
    const listResult = await listTool.execute("call-3", { status: "completed" }, undefined, undefined, makeCtx(tmpDir));
    expect(listResult.content[0].text).toContain(run.id);
    expect(listResult.details.runs).toHaveLength(1);

    const showTool = api.tools.get("fn_insight_run_show")!;
    const showResult = await showTool.execute("call-4", { id: run.id }, undefined, undefined, makeCtx(tmpDir));
    expect(showResult.content[0].text).toContain("Status: completed");
    expect(showResult.details.run.id).toBe(run.id);
  });

  it("returns helpful errors for invalid pagination and missing IDs", async () => {
    const listTool = api.tools.get("fn_insight_list")!;
    const invalidList = await listTool.execute("call-5", { limit: 0 }, undefined, undefined, makeCtx(tmpDir));
    expect(invalidList.isError).toBe(true);
    expect(invalidList.content[0].text).toContain("Invalid limit");

    const showTool = api.tools.get("fn_insight_show")!;
    const missing = await showTool.execute("call-6", { id: "INS-MISSING" }, undefined, undefined, makeCtx(tmpDir));
    expect(missing.isError).toBe(true);
    expect(missing.content[0].text).toContain("not found");
  });
});
