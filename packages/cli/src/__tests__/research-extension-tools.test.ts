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
      researchGlobalWebSearchProvider: "tavily",
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
      researchGlobalWebSearchProvider: "tavily",
      researchGlobalTavilyApiKey: "test-key",
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

  it("returns structured missing-run details for get and cancel", async () => {
    const store = new TaskStore(tmpDir);
    await store.init();

    const getTool = api.tools.get("fn_research_get")!;
    const getResult = await getTool.execute("call-missing-get", { id: "RR-404" }, undefined, undefined, makeCtx(tmpDir));
    expect(getResult.details.runId).toBe("RR-404");
    expect(getResult.details.status).toBe("missing");
    expect(getResult.details.setup.code).toBe("NOT_FOUND");

    const cancelTool = api.tools.get("fn_research_cancel")!;
    const cancelResult = await cancelTool.execute("call-missing-cancel", { id: "RR-404" }, undefined, undefined, makeCtx(tmpDir));
    expect(cancelResult.isError).toBe(true);
    expect(cancelResult.details.runId).toBe("RR-404");
    expect(cancelResult.details.setup.code).toBe("NOT_FOUND");
  });

  it("returns completed-run structured findings and citations", async () => {
    const store = new TaskStore(tmpDir);
    await store.init();

    const run = store.getResearchStore().createRun({ query: "fusion", topic: "fusion" });
    store.getResearchStore().setResults(run.id, {
      summary: "Summary text",
      findings: [{ heading: "Finding A", content: "Detail A", sources: ["https://example.com/a"] }],
      citations: [{ title: "Source A", url: "https://example.com/a" }],
    } as any);
    store.getResearchStore().updateStatus(run.id, "running");
    store.getResearchStore().updateStatus(run.id, "completed");

    const getTool = api.tools.get("fn_research_get")!;
    const result = await getTool.execute("call-complete", { id: run.id }, undefined, undefined, makeCtx(tmpDir));
    expect(result.details.runId).toBe(run.id);
    expect(result.details.status).toBe("completed");
    expect(result.details.summary).toBe("Summary text");
    expect(result.details.findings).toHaveLength(1);
    expect(result.details.findings[0]).toMatchObject({ heading: "Finding A", content: "Detail A" });
    expect(result.details.citations).toHaveLength(1);
    expect(result.details.citations[0]).toMatchObject({ title: "Source A", url: "https://example.com/a" });
  });

  it("retries failed run and returns retry linkage metadata", async () => {
    const store = new TaskStore(tmpDir);
    await store.init();

    const run = store.getResearchStore().createRun({
      query: "fusion",
      topic: "fusion",
      lifecycle: { retryable: true, attempt: 1, maxAttempts: 3, failureClass: "retryable_transient" },
    });
    store.getResearchStore().updateStatus(run.id, "running", {
      lifecycle: { retryable: true, attempt: 1, maxAttempts: 3, failureClass: "retryable_transient" },
    });
    store.getResearchStore().updateStatus(run.id, "failed", {
      lifecycle: { retryable: true, attempt: 1, maxAttempts: 3, failureClass: "retryable_transient" },
    });

    const retryTool = api.tools.get("fn_research_retry")!;
    const retryResult = await retryTool.execute("call-retry", { id: run.id }, undefined, undefined, makeCtx(tmpDir));

    expect(retryResult.isError).not.toBe(true);
    expect(["queued", "retry_waiting"]).toContain(retryResult.details.status);
    expect(retryResult.details.runId).not.toBe(run.id);

    const retried = store.getResearchStore().getRun(retryResult.details.runId);
    expect(retried?.status).toBe("retry_waiting");
    expect(retried?.lifecycle?.retryOfRunId).toBe(run.id);
    expect(retried?.lifecycle?.rootRunId).toBe(run.id);
    expect(retried?.lifecycle?.attempt).toBe(2);
  });

  it("returns INVALID_TRANSITION for cancel on terminal run", async () => {
    const store = new TaskStore(tmpDir);
    await store.init();
    await store.updateSettings({
      researchGlobalWebSearchProvider: "tavily",
      researchGlobalTavilyApiKey: "test-key",
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
