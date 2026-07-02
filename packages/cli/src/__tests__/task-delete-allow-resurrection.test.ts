import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { TaskStore } from "@fusion/core";
import kbExtension, { closeCachedStores } from "../extension.js";

type RegisteredTool = {
  name: string;
  execute: (toolCallId: string, params: any, signal: AbortSignal | undefined, onUpdate: any, ctx: { cwd: string; taskId?: string; agentId?: string; runId?: string }) => Promise<any>;
};

function createMockAPI() {
  const tools = new Map<string, RegisteredTool>();
  return {
    tools,
    registerTool(tool: RegisteredTool) {
      tools.set(tool.name, tool);
    },
    registerCommand() {
      // no-op for tests
    },
    on() {
      // no-op for tests
    },
  } as any;
}

describe("task delete allowResurrection plumbing", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "fn-task-delete-allow-"));
    await mkdir(join(rootDir, ".fusion"), { recursive: true });
  });

  afterEach(async () => {
    await closeCachedStores();
    await rm(rootDir, { recursive: true, force: true });
  });

  it("fn_task_delete forwards allowResurrection=true", async () => {
    const store = new TaskStore(rootDir);
    await store.init();
    const task = await store.createTask({ title: "x", description: "y", column: "todo" });

    const api = createMockAPI();
    kbExtension(api);
    const tool = api.tools.get("fn_task_delete") as RegisteredTool;
    await tool.execute("call-1", { id: task.id, allowResurrection: true }, undefined, undefined, { cwd: rootDir });

    const deleted = (store as any).readTaskFromDb(task.id, { includeDeleted: true }) as { allowResurrection?: boolean; deletedAt?: string };
    expect(deleted.deletedAt).toBeTruthy();
    expect(deleted.allowResurrection).toBe(true);
  });

  it("fn_task_delete defaults allowResurrection=false", async () => {
    const store = new TaskStore(rootDir);
    await store.init();
    const task = await store.createTask({ title: "x", description: "y", column: "todo" });

    const api = createMockAPI();
    kbExtension(api);
    const tool = api.tools.get("fn_task_delete") as RegisteredTool;
    await tool.execute("call-2", { id: task.id }, undefined, undefined, { cwd: rootDir });

    const deleted = (store as any).readTaskFromDb(task.id, { includeDeleted: true }) as { allowResurrection?: boolean; deletedAt?: string };
    expect(deleted.deletedAt).toBeTruthy();
    expect(deleted.allowResurrection).toBeUndefined();
  });

  it("fn_task_delete rejects deleting the caller task and leaves it live", async () => {
    const store = new TaskStore(rootDir);
    await store.init();
    const task = await store.createTask({ title: "self", description: "current task", column: "in-progress" });

    const api = createMockAPI();
    kbExtension(api);
    const tool = api.tools.get("fn_task_delete") as RegisteredTool;

    await expect(
      tool.execute("call-self", { id: task.id }, undefined, undefined, {
        cwd: rootDir,
        taskId: task.id,
        agentId: "agent-test",
        runId: "run-test",
      }),
    ).rejects.toThrow(`Task ${task.id} cannot delete itself`);

    const row = (store as any).readTaskFromDb(task.id, { includeDeleted: true }) as { deletedAt?: string };
    expect(row.deletedAt).toBeUndefined();
  });

  it("fn_task_delete lets a task-bound caller delete a different task", async () => {
    const store = new TaskStore(rootDir);
    await store.init();
    const caller = await store.createTask({ title: "caller", description: "current task", column: "in-progress" });
    const target = await store.createTask({ title: "target", description: "cleanup target", column: "todo" });

    const api = createMockAPI();
    kbExtension(api);
    const tool = api.tools.get("fn_task_delete") as RegisteredTool;
    const result = await tool.execute("call-other", { id: target.id }, undefined, undefined, {
      cwd: rootDir,
      taskId: caller.id,
      agentId: "agent-test",
      runId: "run-test",
    });

    expect(result.content[0]?.text).toBe(`Deleted ${target.id}`);
    const deleted = (store as any).readTaskFromDb(target.id, { includeDeleted: true }) as { deletedAt?: string };
    expect(deleted.deletedAt).toBeTruthy();
  });
});
