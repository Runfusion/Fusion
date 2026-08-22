import { beforeEach, describe, expect, it, vi } from "vitest";
import "./executor-test-helpers.js";
import { registerTaskRecommendationNoticeMailbox } from "@fusion/core";
import { TaskExecutor, validateCompletionRecommendations } from "../executor.js";
import { __flushPendingRecommendationNotices } from "../executor/completion-recommendation-notice.js";
import * as worktreePool from "../worktree/worktree-pool.js";
import { createMockStore, mockedExecSync, resetExecutorMocks } from "./executor-test-helpers.js";

const recommendation = {
  id: "rec-export",
  title: "Export completed tasks",
  description: "Add CSV export outside the completed task's scope.",
  category: "feature" as const,
};

function completionTask() {
  return {
    id: "FN-8829-test",
    title: "Completed recommendation parent",
    description: "A completed task with out-of-scope follow-up work.",
    column: "in-progress",
    worktree: "/repo/.worktrees/recommendations",
    branch: "fusion/fn-8829-test",
    baseCommitSha: "base-sha",
    enabledWorkflowSteps: [],
    dependencies: [],
    steps: [{ name: "Implement", status: "done" as const }],
    currentStep: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function createProductionTaskDoneTool(maximum: number | undefined = 3, recommendationMailboxNoticeEnabled?: boolean, requireTaskRecommendations = false) {
  const store = createMockStore();
  const task = completionTask();
  store._setRow(task.id, task);
  store.getSettings.mockResolvedValue({
    maxConcurrent: 2,
    maxWorktrees: 4,
    pollIntervalMs: 15_000,
    groupOverlappingFiles: false,
    autoMerge: false,
    worktreeInitCommand: undefined,
    ...(maximum === undefined ? {} : { maxRecommendationsPerTask: maximum }),
    ...(recommendationMailboxNoticeEnabled === undefined ? {} : { recommendationMailboxNoticeEnabled }),
    ...(requireTaskRecommendations ? { requireTaskRecommendations: true } : {}),
  });
  const executor = new TaskExecutor(store as any, "/repo");
  const onDone = vi.fn();
  const tool = (executor as any).createTaskDoneTool(
    task.id,
    task.worktree,
    "# Task\n## Steps\n### Step 0: Implement\n- [x] Complete",
    new Map(),
    onDone,
  );
  return { store, task, tool, onDone };
}

describe("fn_task_done recommendation validation", () => {
  beforeEach(() => {
    resetExecutorMocks();
    vi.spyOn(worktreePool, "isUsableTaskWorktree").mockResolvedValue(true);
    mockedExecSync.mockImplementation((command: string) => {
      if (command.includes("rev-parse --show-toplevel")) return Buffer.from("/repo/.worktrees/recommendations\n");
      if (command.includes("rev-parse --abbrev-ref HEAD")) return Buffer.from("fusion/fn-8829-test\n");
      if (command.includes("rev-list --count")) return Buffer.from("1\n");
      if (command.includes("rev-parse HEAD")) return Buffer.from("head-sha\n");
      return Buffer.from("");
    });
  });

  it("accepts a bounded task-ready recommendation list", () => {
    expect(validateCompletionRecommendations([recommendation], 1)).toEqual([recommendation]);
    expect(validateCompletionRecommendations([], 0)).toEqual([]);
  });

  it("allows task-ready security recommendations without credential material", () => {
    expect(validateCompletionRecommendations([{
      ...recommendation,
      title: "Add password reset support",
      description: "Add a password reset flow as a separate security follow-up.",
    }], 3)).not.toBeTypeOf("string");
  });

  it("requires an explicit quality-first evaluation without mutating refused completion", async () => {
    const { store, task, tool, onDone } = createProductionTaskDoneTool(3, undefined, true);

    const refused = await tool.execute("call-required-omitted", {});

    expect(refused.content[0].text).toContain("requires an explicit recommendations array");
    expect(refused.content[0].text).toContain("recommendations: []");
    expect((await store.getTask(task.id)).recommendations).toBeUndefined();
    expect(store.updateTask).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
  });

  it("accepts shorter, at-cap, and empty explicit arrays when required", async () => {
    const short = createProductionTaskDoneTool(3, undefined, true);
    await short.tool.execute("call-required-short", { recommendations: [recommendation] });
    expect((await short.store.getTask(short.task.id)).recommendations).toEqual([recommendation]);

    const empty = createProductionTaskDoneTool(3, undefined, true);
    await empty.tool.execute("call-required-empty", { recommendations: [] });
    expect((await empty.store.getTask(empty.task.id)).recommendations).toEqual([]);

    const atCap = createProductionTaskDoneTool(3, undefined, true);
    await atCap.tool.execute("call-required-cap", {
      recommendations: [recommendation, { ...recommendation, id: "rec-second" }, { ...recommendation, id: "rec-third" }],
    });
    expect((await atCap.store.getTask(atCap.task.id)).recommendations).toHaveLength(3);
  });

  it("keeps blocked exits outside required recommendation enforcement", async () => {
    const { store, task, tool } = createProductionTaskDoneTool(3, undefined, true);
    const blocked = await tool.execute("call-required-blocked", {
      outcome: "blocked",
      reason: "Waiting for the upstream API contract.",
    });

    expect(blocked.content[0].text).toContain("Task parked as blocked");
    expect((await store.getTask(task.id)).recommendations).toBeUndefined();
  });

  it("requires an explicit result for no-op completion too", async () => {
    const { store, task, tool, onDone } = createProductionTaskDoneTool(3, undefined, true);
    const refused = await tool.execute("call-required-no-op", {
      summary: "PREMISE STALE: the requested behavior is already present on HEAD",
    });

    expect(refused.content[0].text).toContain("requires an explicit recommendations array");
    expect((await store.getTask(task.id)).recommendations).toBeUndefined();
    expect(store.updateTask).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
  });

  it("persists and deterministically replaces recommendations through the production completion tool", async () => {
    const { store, task, tool } = createProductionTaskDoneTool();
    const first = await tool.execute("call-1", { recommendations: [recommendation] });

    expect(first.content[0].text).toContain("Task marked complete");
    expect((await store.getTask(task.id)).recommendations).toEqual([recommendation]);

    const replacement = { ...recommendation, id: "rec-replacement", title: "Improve task exports" };
    await tool.execute("call-2", { recommendations: [replacement] });
    expect((await store.getTask(task.id)).recommendations).toEqual([replacement]);
  });


  it("sends one non-blocking operator mailbox notice after accepted completion", async () => {
    const { store, task, tool } = createProductionTaskDoneTool();
    const messages: Array<{ input: any; key: string }> = [];
    registerTaskRecommendationNoticeMailbox(store as any, {
      sendMessageOnce: async (input, key) => { messages.push({ input, key }); },
    });

    await expect(tool.execute("call-notice", { recommendations: [recommendation, { ...recommendation, id: "rec-docs", title: "Document exports" }] })).resolves.toMatchObject({ details: {} });
    await __flushPendingRecommendationNotices();

    expect(messages).toHaveLength(1);
    expect(messages[0].input).toMatchObject({
      toId: "dashboard",
      type: "system",
      metadata: { kind: "task-recommendation-notice", taskId: task.id, recommendationCount: 2 },
    });
    expect(messages[0].input.content).toContain("Export completed tasks");
    expect(messages[0].input.content).toContain("Document exports");

    await tool.execute("call-notice-retry", { recommendations: [recommendation, { ...recommendation, id: "rec-docs", title: "Document exports" }] });
    await __flushPendingRecommendationNotices();
    expect(messages[1].key).toBe(messages[0].key);
  });

  it("persists recommendations but suppresses notices when the project setting is off", async () => {
    const { store, task, tool } = createProductionTaskDoneTool(3, false);
    let messages = 0;
    registerTaskRecommendationNoticeMailbox(store as any, { sendMessageOnce: async () => { messages += 1; } });
    await tool.execute("call-notice-off", { recommendations: [recommendation] });
    await __flushPendingRecommendationNotices();
    expect((await store.getTask(task.id)).recommendations).toEqual([recommendation]);
    expect(messages).toBe(0);
  });

  it("persists an honest empty list and uses the default cap when the setting is absent", async () => {
    const { store, task, tool } = createProductionTaskDoneTool(undefined);
    const empty = await tool.execute("call-empty", { recommendations: [] });
    expect(empty.content[0].text).toContain("Task marked complete");
    expect((await store.getTask(task.id)).recommendations).toEqual([]);

    const { store: defaultStore, task: defaultTask, tool: defaultTool } = createProductionTaskDoneTool(undefined);
    await defaultTool.execute("call-default", { recommendations: [recommendation, { ...recommendation, id: "rec-second" }, { ...recommendation, id: "rec-third" }] });
    expect((await defaultStore.getTask(defaultTask.id)).recommendations).toHaveLength(3);
  });

  it("accepts an empty list but rejects populated input when capture is disabled", async () => {
    const { store, task, tool } = createProductionTaskDoneTool(0);
    const empty = await tool.execute("call-disabled-empty", { recommendations: [] });
    expect(empty.content[0].text).toContain("Task marked complete");
    expect((await store.getTask(task.id)).recommendations).toEqual([]);

    const { store: rejectedStore, task: rejectedTask, tool: rejectedTool } = createProductionTaskDoneTool(0);
    const rejected = await rejectedTool.execute("call-disabled-populated", { recommendations: [recommendation] });
    expect(rejected.content[0].text).toContain("maximum of 0");
    expect((await rejectedStore.getTask(rejectedTask.id)).recommendations).toBeUndefined();
  });

  it("documents the prompted payload and persists its equivalent through the production tool", async () => {
    const { store, task, tool } = createProductionTaskDoneTool();
    expect(tool.description).toContain("recommendations: []");
    expect(tool.description).toContain("a shorter list or [] is valid when relevance does not support more");
    expect(tool.parameters.properties.recommendations.description).toContain("unique stable ids");
    expect(tool.parameters.properties.recommendations.description).toContain("populated input is rejected");

    await tool.execute("call-prompt-shape", { recommendations: [recommendation] });
    expect((await store.getTask(task.id)).recommendations).toEqual([recommendation]);
  });

  it("does not persist recommendations when production completion is refused or blocked", async () => {
    const { store, task, tool } = createProductionTaskDoneTool();
    const refused = await tool.execute("call-refused", {
      recommendations: [{ ...recommendation, description: "Run pnpm export before filing this follow-up." }],
    });
    expect(refused.content[0].text).toContain("Cannot mark task done yet");
    expect((await store.getTask(task.id)).recommendations).toBeUndefined();

    const blocked = await tool.execute("call-blocked", {
      outcome: "blocked",
      reason: "Waiting for the upstream API contract.",
      recommendations: [recommendation],
    });
    expect(blocked.content[0].text).toContain("Task parked as blocked");
    expect((await store.getTask(task.id)).recommendations).toBeUndefined();
  });

  it.each([
    ["disabled", [recommendation], 0, "maximum of 0"],
    ["over-cap", [recommendation, { ...recommendation, id: "rec-2" }], 1, "maximum of 1"],
    ["duplicate id", [recommendation, recommendation], 3, "ids must be unique"],
    ["invalid category", [{ ...recommendation, category: "unknown" }], 3, "category must be"],
    ["secret", [{ ...recommendation, description: "Use API_KEY=value for this follow-up." }], 3, "must not contain secrets"],
    ["command", [{ ...recommendation, description: "Run `pnpm export` after completing this task." }], 3, "must not contain secrets"],
    ["bare command", [{ ...recommendation, description: "Run pnpm export after completing this task." }], 3, "must not contain secrets"],
    ["imperative flags", [{ ...recommendation, description: "Run ls -la after completing this task." }], 3, "must not contain secrets"],
    ["imperative script path", [{ ...recommendation, description: "Execute ./cleanup.sh after completing this task." }], 3, "must not contain secrets"],
    ["shell prompt",  [{ ...recommendation, description: "$ curl https://example.test/export" }], 3, "must not contain secrets"],
    ["missing title", [{ ...recommendation, title: "  " }], 3, "requires id, title, and description"],
    ["reasoning payload", [{ ...recommendation, reasoning: "I considered several implementation paths." }], 3, "may contain only"],
    ["pre-linked child", [{ ...recommendation, createdTaskId: "FN-999" }], 3, "may contain only"],
  ])("rejects %s recommendation input", (_label, input, maximum, expectedError) => {
    expect(validateCompletionRecommendations(input, maximum)).toContain(expectedError);
  });
});
