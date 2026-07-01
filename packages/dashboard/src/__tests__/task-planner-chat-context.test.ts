import { describe, expect, it, vi } from "vitest";
import { buildTaskPlannerChatContext, formatTaskPlannerChatContext, TASK_PLANNER_CHAT_CONTEXT_PROMPT_GUIDANCE } from "../task-planner-chat-context.js";

function createStore(tasks: Record<string, Record<string, unknown>>) {
  return {
    getTask: vi.fn(async (taskId: string) => {
      const task = tasks[taskId];
      if (!task) throw new Error(`Task ${taskId} not found`);
      return task;
    }),
  } as any;
}

describe("task planner chat context", () => {
  it("builds bounded task status, dependency, activity, and prompt context server-side", async () => {
    const store = createStore({
      "FN-7312": {
        id: "FN-7312",
        title: "Send relevant task context to planner chat",
        description: "Short description",
        prompt: "# PROMPT.md\n\nAnswer status questions from task context.",
        column: "in-progress",
        status: "running",
        priority: "high",
        assignedAgent: "agent-planner",
        currentStep: 1,
        dependencies: ["FN-7311", "FN-7311", "FN-MISSING"],
        steps: [
          { title: "Preflight", status: "done" },
          { title: "Context contract", status: "in-progress" },
        ],
        comments: [{ author: "user", text: "What is happening?", createdAt: "2026-06-30T00:00:00.000Z" }],
        steeringComments: [{ author: "operator", text: "Keep Activity separate." }],
        log: [
          { level: "info", message: "Planner chat shell loaded", timestamp: "2026-06-30T00:01:00.000Z" },
          { type: "task:moved", details: "Moved from todo to in-progress" },
          { type: "legacy", action: "Executor picked up the task" },
          { type: "tool", text: "Fetched task detail" },
        ],
        sourceIssue: { title: "Planner Chat", state: "open", url: "https://example.test/issues/1" },
        reviewStatus: "not-started",
      },
      "FN-7311": {
        id: "FN-7311",
        title: "Add starter prompts",
        column: "done",
        status: "complete",
      },
    });

    const context = await buildTaskPlannerChatContext(store, "FN-7312");

    expect(store.getTask).toHaveBeenNthCalledWith(1, "FN-7312", { activityLogLimit: 20 });
    expect(store.getTask).toHaveBeenCalledWith("FN-7311");
    expect(store.getTask).toHaveBeenCalledWith("FN-MISSING");
    expect(context.snapshot.dependencies).toEqual([
      { id: "FN-7311", title: "Add starter prompts", column: "done", status: "complete" },
      { id: "FN-MISSING", missing: true },
    ]);
    expect(context.promptContext).toContain("Task ID: FN-7312");
    expect(context.promptContext).toContain("Column: in-progress");
    expect(context.promptContext).toContain("Status: running");
    expect(context.promptContext).toContain("Progress: step 2 of 2");
    expect(context.promptContext).toContain("Current step: Context contract: in-progress");
    expect(context.promptContext).toContain("Priority: high");
    expect(context.promptContext).toContain("Assigned agent: agent-planner");
    expect(context.promptContext).toContain("- FN-7311: Add starter prompts; done; complete");
    expect(context.promptContext).toContain("- FN-MISSING: details unavailable");
    expect(context.promptContext).toContain("Prompt:\n# PROMPT.md");
    expect(context.promptContext).toContain("- Context contract: in-progress");
    expect(context.promptContext).toContain("Recent activity:");
    expect(context.promptContext).toContain("Planner chat shell loaded");
    expect(context.promptContext).toContain("Moved from todo to in-progress");
    expect(context.promptContext).toContain("Executor picked up the task");
    expect(context.promptContext).toContain("Recent comments / steering:");
    expect(context.promptContext).toContain("Keep Activity separate.");
    expect(context.promptContext).toContain("Source / PR context:");
    expect(context.promptContext).toContain("reviewStatus: not-started");
  });

  it("marks absent prompt, logs, and dependencies as unavailable instead of omitting them", async () => {
    const store = createStore({
      "FN-EMPTY": {
        id: "FN-EMPTY",
        column: "todo",
        status: "pending",
        dependencies: [],
        steps: [],
      },
    });

    const context = await buildTaskPlannerChatContext(store, "FN-EMPTY");

    expect(context.promptContext).toContain("Title: not available");
    expect(context.promptContext).toContain("Dependencies: none");
    expect(context.promptContext).toContain("Prompt/plan: not available");
    expect(context.promptContext).toContain("Steps: not available");
    expect(context.promptContext).toContain("Recent activity: not available");
    expect(context.promptContext).toContain("Recent comments / steering: not available");
    expect(context.promptContext).toContain("Task prompt/plan content is not available");
    expect(context.promptContext).toContain("Recent activity/log context is not available");
    expect(context.promptContext).toContain("No dependencies are listed for this task");
  });

  it("truncates long prompt, activity, and comment excerpts to bounded limits", async () => {
    const longPrompt = "P".repeat(80);
    const longLog = "L".repeat(80);
    const longComment = "C".repeat(80);
    const store = createStore({
      "FN-LONG": {
        id: "FN-LONG",
        prompt: longPrompt,
        column: "todo",
        status: "pending",
        log: [{ message: longLog, level: "info" }],
        comments: [{ text: longComment, author: "user" }],
      },
    });

    const context = await buildTaskPlannerChatContext(store, "FN-LONG", {
      taskSpecMaxChars: 12,
      recentActivityMaxChars: 10,
      recentCommentMaxChars: 9,
    });

    expect(context.promptContext).toContain(`${"P".repeat(11)}…`);
    expect(context.promptContext).toContain(`${"L".repeat(9)}…`);
    expect(context.promptContext).toContain(`${"C".repeat(8)}…`);
    expect(context.promptContext).not.toContain(longPrompt);
    expect(context.promptContext).not.toContain(longLog);
    expect(context.promptContext).not.toContain(longComment);
  });

  it("formats duplicate-free dependency snapshots passed directly to the formatter", () => {
    const promptContext = formatTaskPlannerChatContext({
      taskId: "FN-FORMAT",
      title: "Formatter task",
      column: "failed",
      status: "error",
      progress: "0/3 steps done",
      currentStep: "Preflight: failed",
      dependencies: [
        { id: "FN-1", title: "Ready", column: "done", status: "complete" },
        { id: "FN-2", missing: true },
      ],
      steps: [],
      recentActivity: [],
      recentComments: [],
      source: [],
      review: [],
      notes: [],
    });

    expect(promptContext).toContain("- FN-1: Ready; done; complete");
    expect(promptContext).toContain("- FN-2: details unavailable");
    expect(promptContext).toContain("Prompt/plan: not available");
  });

  it("tells the planner to answer from context and state uncertainty", () => {
    expect(TASK_PLANNER_CHAT_CONTEXT_PROMPT_GUIDANCE).toContain("current status");
    expect(TASK_PLANNER_CHAT_CONTEXT_PROMPT_GUIDANCE).toContain("State uncertainty");
    expect(TASK_PLANNER_CHAT_CONTEXT_PROMPT_GUIDANCE).toContain("Do not claim you ran code, tests, builds");
    expect(TASK_PLANNER_CHAT_CONTEXT_PROMPT_GUIDANCE).toContain("Activity is the execution/steering transcript");
  });
});
