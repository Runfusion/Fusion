/**
 * FNXC:PostgresCutover 2026-07-04-00:00:
 * Migrated from the legacy SQLite `new TaskStore(rootDir)` harness to the
 * PostgreSQL extension harness. The agent tools now resolve a PG-backed store
 * via `getStore(cwd)` (injected by the harness), and task state is read back
 * through `store.getTask(id, { includeDeleted: true })` instead of the removed
 * sync `readTaskFromDb` path.
 */

import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { pgDescribe } from "../../../core/src/__test-utils__/pg-test-harness.js";
import {
  createPgExtensionHarness,
  createMockApi,
  registerExtension,
  requireTool,
} from "./pg-extension-harness.js";

const pgTest = pgDescribe;

pgTest("task delete allowResurrection plumbing", () => {
  const h = createPgExtensionHarness("fn-task-delete-allow");

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  it("fn_task_delete forwards allowResurrection=true", async () => {
    const store = h.store();
    const task = await store.createTask({ title: "x", description: "y", column: "todo" });

    const api = createMockApi();
    registerExtension(api);
    const tool = requireTool(api, "fn_task_delete");
    await tool.execute("call-1", { id: task.id, allowResurrection: true }, undefined, undefined, { cwd: h.rootDir() });

    const deleted = await store.getTask(task.id, { includeDeleted: true });
    expect(deleted.deletedAt).toBeTruthy();
    expect(deleted.allowResurrection).toBe(true);
  });

  it("fn_task_delete defaults allowResurrection=false", async () => {
    const store = h.store();
    const task = await store.createTask({ title: "x", description: "y", column: "todo" });

    const api = createMockApi();
    registerExtension(api);
    const tool = requireTool(api, "fn_task_delete");
    await tool.execute("call-2", { id: task.id }, undefined, undefined, { cwd: h.rootDir() });

    const deleted = await store.getTask(task.id, { includeDeleted: true });
    expect(deleted.deletedAt).toBeTruthy();
    expect(deleted.allowResurrection).toBeUndefined();
  });

  it("fn_task_delete rejects deleting the caller task and leaves it live", async () => {
    const store = h.store();
    const task = await store.createTask({ title: "self", description: "current task", column: "in-progress" });

    const api = createMockApi();
    registerExtension(api);
    const tool = requireTool(api, "fn_task_delete");

    /*
    FNXC:CliTests 2026-07-15-12:05:
    fn_task_delete returns a structured isError tool result for self-delete (does not throw).
    */
    const result = await tool.execute("call-self", { id: task.id }, undefined, undefined, {
      cwd: h.rootDir(),
      taskId: task.id,
      agentId: "agent-test",
      runId: "run-test",
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain(`Task ${task.id} cannot delete itself`);

    const row = await store.getTask(task.id, { includeDeleted: true });
    expect(row?.deletedAt).toBeUndefined();
  });

  it("fn_task_delete lets a task-bound caller delete a different task", async () => {
    const store = h.store();
    const caller = await store.createTask({ title: "caller", description: "current task", column: "in-progress" });
    const target = await store.createTask({ title: "target", description: "cleanup target", column: "todo" });

    const api = createMockApi();
    registerExtension(api);
    const tool = requireTool(api, "fn_task_delete");
    const result = await tool.execute("call-other", { id: target.id }, undefined, undefined, {
      cwd: h.rootDir(),
      taskId: caller.id,
      agentId: "agent-test",
      runId: "run-test",
    });

    expect(result.content[0]?.text).toBe(`Deleted ${target.id}`);
    const deleted = await store.getTask(target.id, { includeDeleted: true });
    expect(deleted.deletedAt).toBeTruthy();
  });
});
