import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import kbExtension from "../extension.js";
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

describe("research extension tools", () => {
  let tmpDir: string;
  let api: ReturnType<typeof createMockAPI>;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "kb-ext-research-test-"));
    api = createMockAPI();
    kbExtension(api);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("registers research extension tools", () => {
    expect(api.tools.has("fn_research_run")).toBe(true);
    expect(api.tools.has("fn_research_list")).toBe(true);
    expect(api.tools.has("fn_research_get")).toBe(true);
    expect(api.tools.has("fn_research_cancel")).toBe(true);
    expect(api.tools.has("fn_research_retry")).toBe(true);
  });

  it("returns actionable disabled response when research is off", async () => {
    const store = new TaskStore(tmpDir);
    await store.init();
    await store.updateSettings({ researchSettings: { enabled: false } });

    const runTool = api.tools.get("fn_research_run")!;
    const result = await runTool.execute("call-1", { query: "fusion" }, undefined, undefined, makeCtx(tmpDir));

    expect(result.details.setup.code).toBe("feature-disabled");
    expect(result.content[0].text).toContain("disabled");
  });

  it("returns actionable missing-credentials response", async () => {
    const store = new TaskStore(tmpDir);
    await store.init();
    await store.updateSettings({
      researchWebSearchProvider: "tavily",
      researchSettings: { enabled: true },
      researchGlobalDefaults: { searchProvider: "tavily" },
    });

    const runTool = api.tools.get("fn_research_run")!;
    const result = await runTool.execute("call-0", { query: "fusion" }, undefined, undefined, makeCtx(tmpDir));

    expect(result.details.setup.code).toBe("missing-credentials");
    expect(result.content[0].text).toContain("Missing credentials");
  });

  it("creates, reads, lists, and cancels runs", async () => {
    const store = new TaskStore(tmpDir);
    await store.init();
    await store.updateSettings({
      researchWebSearchProvider: "tavily",
      researchTavilyApiKey: "test-key",
      researchSettings: { enabled: true },
      researchGlobalDefaults: { searchProvider: "tavily" },
    });

    const created = store.getResearchStore().createRun({ query: "fusion architecture", topic: "fusion architecture" });

    const listTool = api.tools.get("fn_research_list")!;
    const listResult = await listTool.execute("call-2", {}, undefined, undefined, makeCtx(tmpDir));
    expect(listResult.details.runs.length).toBeGreaterThan(0);

    const getTool = api.tools.get("fn_research_get")!;
    const getResult = await getTool.execute("call-3", { id: created.id }, undefined, undefined, makeCtx(tmpDir));
    expect(getResult.details.runId).toBe(created.id);

    const cancelTool = api.tools.get("fn_research_cancel")!;
    const cancelResult = await cancelTool.execute("call-4", { id: created.id }, undefined, undefined, makeCtx(tmpDir));
    expect(["cancelling", "cancelled"]).toContain(cancelResult.details.status);

    const retryTool = api.tools.get("fn_research_retry")!;
    const retryBlocked = await retryTool.execute("call-5", { id: created.id }, undefined, undefined, makeCtx(tmpDir));
    expect(retryBlocked.isError).toBe(true);
  });

  it("returns INVALID_TRANSITION for cancel on terminal run", async () => {
    const store = new TaskStore(tmpDir);
    await store.init();
    await store.updateSettings({
      researchWebSearchProvider: "tavily",
      researchTavilyApiKey: "test-key",
      researchSettings: { enabled: true },
      researchGlobalDefaults: { searchProvider: "tavily" },
    });

    const run = store.getResearchStore().createRun({ query: "fusion", topic: "fusion" });
    store.getResearchStore().updateStatus(run.id, "running");
    store.getResearchStore().updateStatus(run.id, "completed");

    const cancelTool = api.tools.get("fn_research_cancel")!;
    const result = await cancelTool.execute("call-6", { id: run.id }, undefined, undefined, makeCtx(tmpDir));
    expect(result.isError).toBe(true);
    expect(result.details.setup.code).toBe("INVALID_TRANSITION");
  });
});
