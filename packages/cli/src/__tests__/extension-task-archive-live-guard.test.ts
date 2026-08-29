import {afterAll, afterEach, beforeAll, beforeEach, expect, it} from "vitest";
import {access} from "node:fs/promises";
import {join} from "node:path";
import {
  createMockApi,
  createPgExtensionHarness,
  pgDescribe,
  registerExtension,
  requireTool,
} from "./pg-extension-harness.js";

/*
FNXC:TaskLifecycleTools 2026-08-15-06:35:
The pi archive tool is an agent-facing destructive surface, not a CLI alias. It must report the
core transactional live-task fence as a structured MCP error and deliberately has no agent force
escape hatch; only a human can use `fn task archive <id> --force`.
*/
const h = createPgExtensionHarness("fn-archive-live-guard");

pgDescribe("fn_task_archive live-task guard", () => {
  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  function context() {
    return {cwd: h.rootDir()};
  }

  function archiveTool() {
    const api = createMockApi();
    registerExtension(api);
    return {tool: requireTool(api, "fn_task_archive"), registered: api.tools.get("fn_task_archive") as unknown as {parameters?: {properties?: Record<string, unknown>}}};
  }

  it("returns a structured refusal for a WIP task without archiving its task directory", async () => {
    const store = h.store();
    const task = await store.createTask({column: "in-progress", title: "live", description: "live"});
    const {tool} = archiveTool();

    const result = await tool.execute("live-wip", {id: task.id}, undefined, undefined, context());

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/WIP lane/i);
    expect(result.content[0]?.text).toContain(`fn task archive ${task.id} --force`);
    const persisted = await store.getTask(task.id, {includeDeleted: true});
    expect(persisted.column).toBe("in-progress");
    expect(persisted.deletedAt).toBeUndefined();
    await expect(access(join(h.rootDir(), ".fusion", "tasks", task.id))).resolves.toBeUndefined();
  });

  it("returns a structured refusal for an active merge status", async () => {
    const store = h.store();
    const task = await store.createTask({column: "in-review", title: "landing", description: "landing"});
    await store.updateTask(task.id, {status: "merging"});
    const {tool} = archiveTool();

    const result = await tool.execute("live-merge", {id: task.id}, undefined, undefined, context());

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/active merge pipeline/i);
    expect((await store.getTask(task.id, {includeDeleted: true})).column).toBe("in-review");
  });

  it("archives a dead task with its existing cleanup default", async () => {
    const store = h.store();
    const task = await store.createTask({column: "done", title: "dead", description: "dead"});
    const {tool} = archiveTool();

    const result = await tool.execute("dead", {id: task.id}, undefined, undefined, context());

    expect(result.isError).not.toBe(true);
    expect(result.details?.column).toBe("archived");
    expect((await store.getTask(task.id, {includeDeleted: true})).deletedAt).toBeTruthy();
  });

  it("does not expose a force override in the tool schema", () => {
    const {registered} = archiveTool();
    expect(registered.parameters?.properties).not.toHaveProperty("force");
    expect(registered.parameters?.properties).not.toHaveProperty("allowLive");
  });
});
