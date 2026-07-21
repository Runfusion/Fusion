import { beforeEach, describe, expect, it, vi } from "vitest";
import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import {
  captureNamedTool,
  createMockStore,
  mockedCreateFnAgent,
  mockedExistsSync,
  resetExecutorMocks,
} from "./executor-test-helpers.js";

function createBaseTask() {
  return {
    id: "FN-001",
    title: "Test",
    description: "Test task",
    column: "in-progress",
    /*
    FNXC:EngineTests 2026-07-19-16:40 (U10b):
    Summary replace-vs-append is keyed on whether any WORKFLOW STEP has produced a result, so
    the test owns that variable via `workflowStepResults`. Under graph ownership the optional
    pre-merge review nodes would run and record results of their own, making "no workflow steps
    have run yet" unreachable; declaring no pre-merge gates keeps the fixture in control of the
    only input the branch reads.
    */
    enabledWorkflowSteps: [],
    dependencies: [],
    steps: [{ name: "Step 1", status: "in-progress" as const }],
    currentStep: 0,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

async function setupTaskDoneTool(currentTaskOverrides: Record<string, unknown> = {}) {
  const store = createMockStore();
  let capturedTool: any = null;
  let currentTask: any = {
    ...createBaseTask(),
    ...currentTaskOverrides,
  };

  store.getTask.mockImplementation(async () => ({
    ...currentTask,
    steps: currentTask.steps.map((step: any) => ({ ...step })),
    workflowStepResults: currentTask.workflowStepResults?.map((result: any) => ({ ...result })),
  }));

  mockedCreateFnAgent.mockImplementation(async ({ customTools }: any) => {
    capturedTool = captureNamedTool(customTools, "fn_task_done", capturedTool);
    return {
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
      },
    } as any;
  });

  const executor = new TaskExecutor(store, "/tmp/test");
  await executor.execute(createBaseTask() as any);

  return {
    store,
    capturedTool,
    setCurrentTask(nextTask: Record<string, unknown>) {
      currentTask = { ...currentTask, ...nextTask };
    },
  };
}

function getSummaryUpdateCalls(store: ReturnType<typeof createMockStore>) {
  return store.updateTask.mock.calls.filter((call: any[]) => Object.hasOwn(call[1] ?? {}, "summary"));
}

describe("TaskExecutor fn_task_done summary persistence", () => {
  beforeEach(() => {
    resetExecutorMocks();
    mockedExistsSync.mockReturnValue(true);
  });

  it("replaces the summary on the first completion when no prior summary or workflow results exist", async () => {
    const { store, capturedTool } = await setupTaskDoneTool();

    await capturedTool.execute("tool-1", { summary: "Initial summary" });

    expect(getSummaryUpdateCalls(store)).toEqual([["FN-001", { summary: "Initial summary" }]]);
  });

  it("appends rerun summaries when a prior summary exists and workflow steps have already run", async () => {
    const { store, capturedTool, setCurrentTask } = await setupTaskDoneTool({
      summary: "Original completion summary",
      workflowStepResults: [{ stepName: "FrontendUX", status: "revision-requested" }],
    });

    setCurrentTask({
      summary: "Original completion summary",
      workflowStepResults: [{ stepName: "FrontendUX", status: "revision-requested" }],
    });

    await capturedTool.execute("tool-1", { summary: "Addressed workflow feedback" });

    const summaryUpdateCalls = getSummaryUpdateCalls(store);
    expect(summaryUpdateCalls).toHaveLength(1);
    expect(summaryUpdateCalls[0][1].summary).toContain("Original completion summary");
    expect(summaryUpdateCalls[0][1].summary).toContain("---\nRerun after workflow step revision:\nAddressed workflow feedback");
    expect(
      store.logEntry.mock.calls.some(
        ([id, action]: [string, string]) =>
          id === "FN-001" && action === "fn_task_done summary appended to existing summary (workflow-step rerun)",
      ),
    ).toBe(true);
  });

  it("falls back to replace mode when a prior summary exists but no workflow steps have run yet", async () => {
    const { store, capturedTool } = await setupTaskDoneTool({
      summary: "Original completion summary",
      workflowStepResults: [],
    });

    await capturedTool.execute("tool-1", { summary: "Replacement summary" });

    expect(getSummaryUpdateCalls(store)).toEqual([["FN-001", { summary: "Replacement summary" }]]);
  });

  it("does not rewrite the summary when fn_task_done receives an empty or missing summary", async () => {
    const { store, capturedTool } = await setupTaskDoneTool({
      summary: "Original completion summary",
      workflowStepResults: [{ stepName: "FrontendUX", status: "passed" }],
    });

    await capturedTool.execute("tool-1", {});
    await capturedTool.execute("tool-2", { summary: "   " });

    expect(getSummaryUpdateCalls(store)).toHaveLength(0);
  });

  it("avoids duplicate appends when the rerun summary is already the existing suffix", async () => {
    const existingSummary = [
      "Original completion summary",
      "",
      "---",
      "Rerun after workflow step revision:",
      "Addressed workflow feedback",
    ].join("\n");
    const { store, capturedTool } = await setupTaskDoneTool({
      summary: existingSummary,
      workflowStepResults: [{ stepName: "FrontendUX", status: "revision-requested" }],
    });

    await capturedTool.execute("tool-1", { summary: "Addressed workflow feedback" });

    expect(getSummaryUpdateCalls(store)).toHaveLength(0);
  });
});
