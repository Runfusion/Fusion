// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore } from "@fusion/core";
import { __resetPlanningState, __setCreateFnAgent, createSession, createSessionWithAgent, planningStreamManager } from "../planning.js";

function createQuestionJson(): string {
  return JSON.stringify({
    type: "question",
    data: { id: "q-1", type: "text", question: "What should this plan cover?" },
  });
}

function createMockAgent(response = createQuestionJson()) {
  const messages: Array<{ role: string; content: string }> = [];
  return {
    session: {
      state: { messages },
      prompt: vi.fn(async () => {
        messages.push({ role: "assistant", content: response });
      }),
      dispose: vi.fn(),
    },
  };
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for condition");
}

describe("planning task-document tools", () => {
  let rootDir: string;
  let globalDir: string;
  let store: TaskStore;

  beforeEach(async () => {
    rootDir = mkdtempSync(join(tmpdir(), "planning-doc-tools-root-"));
    globalDir = mkdtempSync(join(tmpdir(), "planning-doc-tools-global-"));
    store = new TaskStore(rootDir, globalDir, { inMemoryDb: true });
    await store.init();
    __resetPlanningState();
  });

  afterEach(() => {
    __resetPlanningState();
    store.close();
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(globalDir, { recursive: true, force: true });
  });

  it("exposes task-document tools from both planning customTools assembly sites", async () => {
    const capturedNonStreaming: any[] = [];
    __setCreateFnAgent(async (options: any) => {
      capturedNonStreaming.push(options);
      return createMockAgent();
    });

    await createSession("127.0.0.210", "Plan document tool coverage", store, rootDir);

    const nonStreamingToolNames = capturedNonStreaming[0]?.customTools?.map((tool: any) => tool.name) ?? [];
    expect(nonStreamingToolNames).toContain("fn_task_document_write");
    expect(nonStreamingToolNames).toContain("fn_task_document_read");

    const capturedStreaming: any[] = [];
    __resetPlanningState();
    __setCreateFnAgent(async (options: any) => {
      capturedStreaming.push(options);
      return createMockAgent();
    });

    const sessionId = await createSessionWithAgent(
      "127.0.0.211",
      "Plan streaming document tool coverage",
      rootDir,
      store,
    );
    const unsubscribe = planningStreamManager.subscribe(sessionId, () => undefined);
    try {
      planningStreamManager.consumeInitialTurn(sessionId)?.();
      await waitFor(() => capturedStreaming.length > 0);
    } finally {
      unsubscribe();
    }

    const streamingToolNames = capturedStreaming[0]?.customTools?.map((tool: any) => tool.name) ?? [];
    expect(streamingToolNames).toContain("fn_task_document_write");
    expect(streamingToolNames).toContain("fn_task_document_read");
  });

  it("uses explicit task_id when planning document tools write and read task documents", async () => {
    const task = await store.createTask({ description: "Document target" });
    const upsertSpy = vi.spyOn(store, "upsertTaskDocument");
    const getSpy = vi.spyOn(store, "getTaskDocument");
    const listSpy = vi.spyOn(store, "getTaskDocuments");
    let capturedOptions: any;
    __setCreateFnAgent(async (options: any) => {
      capturedOptions = options;
      return createMockAgent();
    });

    await createSession("127.0.0.212", "Plan document behavior", store, rootDir);

    const writeTool = capturedOptions.customTools.find((tool: any) => tool.name === "fn_task_document_write");
    const readTool = capturedOptions.customTools.find((tool: any) => tool.name === "fn_task_document_read");
    expect(writeTool).toBeDefined();
    expect(readTool).toBeDefined();

    const writeResult = await writeTool.execute("write-plan-doc", {
      task_id: task.id,
      key: "plan",
      content: "Planning notes",
      author: "planner",
    });

    expect(writeResult.content[0]?.text).toContain("Saved document \"plan\"");
    expect(upsertSpy).toHaveBeenCalledWith(task.id, {
      key: "plan",
      content: "Planning notes",
      author: "planner",
    });

    const readResult = await readTool.execute("read-plan-doc", { task_id: task.id, key: "plan" });
    expect(readResult.content[0]?.text).toContain("Document: plan");
    expect(readResult.content[0]?.text).toContain("Planning notes");
    expect(getSpy).toHaveBeenCalledWith(task.id, "plan");

    const listResult = await readTool.execute("list-plan-docs", { task_id: task.id });
    expect(listResult.content[0]?.text).toContain("Task documents:");
    expect(listResult.content[0]?.text).toContain("- plan");
    expect(listSpy).toHaveBeenCalledWith(task.id);
  });
});
