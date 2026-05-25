import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { TaskStore } from "@fusion/core";
import kbExtension from "../extension.js";

type RegisteredTool = {
  name: string;
  execute: (toolCallId: string, params: any, signal: AbortSignal | undefined, onUpdate: any, ctx: { cwd: string }) => Promise<any>;
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
});
