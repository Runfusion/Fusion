import { describe, it, expect, vi, afterEach } from "vitest";
import type { Settings, Task, TaskStore } from "@fusion/core";
import { join } from "node:path";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { TriageProcessor } from "../triage.js";

/*
 * Bug A (part 2): the triage pre-execution Plan Review gate must bound consecutive
 * REVISE replans so a persistent planner/reviewer disagreement escalates to
 * awaiting-approval instead of looping plan -> Plan Review REVISE -> replan forever.
 */

const { mockReviewStep, mockCreateFnAgent } = vi.hoisted(() => ({
  mockReviewStep: vi.fn(),
  mockCreateFnAgent: vi.fn(),
}));

vi.mock("../reviewer.js", () => ({
  reviewStep: mockReviewStep,
}));

vi.mock("../pi.js", () => ({
  createFnAgent: mockCreateFnAgent,
  describeModel: vi.fn().mockReturnValue("mock-model"),
  promptWithFallback: vi.fn().mockReturnValue("mock-prompt"),
}));

vi.mock("@fusion/core", async (importOriginal) => {
  const { createEngineCoreMock } = await import("../test/mockCore.js");
  const original = await importOriginal<typeof import("@fusion/core")>();
  return createEngineCoreMock(() => Promise.resolve(original));
});

async function createFixtureRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "fusion-triage-plan-review-replan-cap-"));
}

async function cleanupFixtureRoot(rootDir: string): Promise<void> {
  await rm(rootDir, { recursive: true, force: true });
}

function createRetryTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-REPLAN-CAP",
    description: "Bounded Plan Review replan",
    title: "Bounded Plan Review replan",
    column: "triage",
    status: "plan-review-unavailable",
    nextRecoveryAt: "2026-01-01T00:00:00.000Z",
    enabledWorkflowSteps: ["plan-review", "code-review"],
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as Task;
}

function createStore(
  task: Task,
  settingsOverrides: Partial<Settings> = {},
  workflowSettings: Record<string, unknown> = {},
): TaskStore {
  return {
    getTask: vi.fn().mockResolvedValue(task),
    listTasks: vi.fn().mockResolvedValue([task]),
    getSettings: vi.fn().mockResolvedValue({
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 10_000,
      groupOverlappingFiles: false,
      autoMerge: true,
      requirePlanApproval: false,
      ...settingsOverrides,
    } as Settings),
    updateTask: vi.fn().mockResolvedValue(undefined),
    moveTask: vi.fn().mockResolvedValue(undefined),
    logEntry: vi.fn().mockResolvedValue(undefined),
    appendAgentLog: vi.fn().mockResolvedValue(undefined),
    getAgentLogs: vi.fn().mockResolvedValue([]),
    parseDependenciesFromPrompt: vi.fn().mockResolvedValue([]),
    parseStepsFromPrompt: vi.fn().mockResolvedValue([]),
    parseFileScopeFromPrompt: vi.fn().mockResolvedValue([]),
    createTask: vi.fn(),
    deleteTask: vi.fn(),
    mergeTask: vi.fn(),
    updateSettings: vi.fn(),
    addSteeringComment: vi.fn(),
    getTaskWorkflowSelection: vi.fn().mockReturnValue({ workflowId: "builtin:coding", stepIds: [] }),
    getWorkflowDefinition: vi.fn().mockResolvedValue(undefined),
    getWorkflowSettingValues: vi.fn().mockReturnValue(workflowSettings),
    getWorkflowSettingsProjectId: vi.fn().mockReturnValue("project-plan-review-replan-cap"),
    on: vi.fn(),
    emit: vi.fn(),
  } as unknown as TaskStore;
}

async function writePrompt(rootDir: string, taskId: string, prompt: string): Promise<string> {
  const taskDir = join(rootDir, ".fusion", "tasks", taskId);
  await mkdir(taskDir, { recursive: true });
  const promptPath = join(taskDir, "PROMPT.md");
  await writeFile(promptPath, prompt, "utf-8");
  return promptPath;
}

async function runGate(rootDir: string, task: Task, store = createStore(task)): Promise<TaskStore> {
  const processor = new TriageProcessor(store, rootDir);
  await processor.specifyTask(task);
  return store;
}

describe("Plan Review replan cap", () => {
  let roots: string[] = [];

  afterEach(async () => {
    mockReviewStep.mockReset();
    mockCreateFnAgent.mockReset();
    await Promise.all(roots.map(cleanupFixtureRoot));
    roots = [];
  });

  it("increments the replan counter and stays in needs-replan below the cap", async () => {
    const rootDir = await createFixtureRoot();
    roots.push(rootDir);
    const task = createRetryTask({ id: "FN-REPLAN-CAP-BELOW", planReviewReplanCount: 1 });
    const prompt = `# Task: ${task.id} - Existing draft\n\n## Mission\n\nOnly rewrite after reviewer feedback.\n`;
    await writePrompt(rootDir, task.id, prompt);
    const store = createStore(task);
    mockReviewStep.mockResolvedValue({ verdict: "REVISE", review: "Please tighten the file scope.", summary: "Needs revision." });

    await runGate(rootDir, task, store);

    // Still replans, but bumps the consecutive-REVISE counter toward the cap.
    expect(store.updateTask).toHaveBeenCalledWith(task.id, expect.objectContaining({
      status: "needs-replan",
      planReviewReplanCount: 2,
    }));
    expect(store.updateTask).not.toHaveBeenCalledWith(task.id, expect.objectContaining({
      status: "awaiting-approval",
    }));
  });

  it("uses a workflow-configured replan cap before escalating to manual approval", async () => {
    const rootDir = await createFixtureRoot();
    roots.push(rootDir);
    const task = createRetryTask({
      id: "FN-REPLAN-CAP-CONFIGURED",
      planReviewReplanCount: 1,
    });
    const prompt = `# Task: ${task.id} - Existing draft\n\n## Mission\n\nOnly rewrite after reviewer feedback.\n`;
    await writePrompt(rootDir, task.id, prompt);
    const store = createStore(task, {}, { planReviewReplanCap: 1 });
    mockReviewStep.mockResolvedValue({ verdict: "REVISE", review: "One configured attempt was enough.", summary: "Needs revision." });

    await runGate(rootDir, task, store);

    expect(store.updateTask).toHaveBeenCalledWith(task.id, expect.objectContaining({
      status: "awaiting-approval",
      awaitingApprovalReason: "plan-review-replan-cap",
    }));
    expect(store.logEntry).toHaveBeenCalledWith(
      task.id,
      "Plan Review replan cap reached — escalating to manual approval",
      expect.stringContaining("cap 1"),
    );
  });

  it("falls back to the source cap when the workflow setting is unset", async () => {
    const rootDir = await createFixtureRoot();
    roots.push(rootDir);
    // The workflow-value map intentionally omits planReviewReplanCap. A task that has
    // consumed the source-default cap must still escalate on the next REVISE.
    const task = createRetryTask({
      id: "FN-REPLAN-CAP-HIT",
      planReviewReplanCount: 8,
    });
    const prompt = `# Task: ${task.id} - Existing draft\n\n## Mission\n\nOnly rewrite after reviewer feedback.\n`;
    await writePrompt(rootDir, task.id, prompt);
    const store = createStore(task);
    const feedback = "Reviewer keeps rejecting the same plan.";
    mockReviewStep.mockResolvedValue({ verdict: "REVISE", review: feedback, summary: "Needs revision." });

    await runGate(rootDir, task, store);

    expect(store.updateTask).toHaveBeenCalledWith(task.id, expect.objectContaining({
      status: "awaiting-approval",
      awaitingApprovalReason: "plan-review-replan-cap",
    }));
    expect(store.updateTask).not.toHaveBeenCalledWith(task.id, expect.objectContaining({
      status: "needs-replan",
    }));
    expect(store.logEntry).toHaveBeenCalledWith(
      task.id,
      "Plan Review replan cap reached — escalating to manual approval",
      expect.stringContaining(feedback),
    );
    expect(store.logEntry).toHaveBeenCalledWith(
      task.id,
      "Plan Review replan cap reached — escalating to manual approval",
      expect.stringContaining("cap 8"),
    );
  });

  it("still replans from seven consecutive REVISE verdicts", async () => {
    const rootDir = await createFixtureRoot();
    roots.push(rootDir);
    /*
    FNXC:PlanReviewReplan 2026-07-15-11:30:
    Keep this boundary literal rather than deriving it from the production constant. FN-7986
    requires proof that the default is truly 8: with the former cap of 3, seven prior REVISE
    verdicts would escalate instead of returning the task to `needs-replan` at count 8.
    */
    const task = createRetryTask({
      id: "FN-REPLAN-CAP-LAST",
      planReviewReplanCount: 7,
    });
    const prompt = `# Task: ${task.id} - Existing draft\n\n## Mission\n\nOnly rewrite after reviewer feedback.\n`;
    await writePrompt(rootDir, task.id, prompt);
    const store = createStore(task);
    mockReviewStep.mockResolvedValue({ verdict: "REVISE", review: "One more try.", summary: "Needs revision." });

    await runGate(rootDir, task, store);

    expect(store.updateTask).toHaveBeenCalledWith(task.id, expect.objectContaining({
      status: "needs-replan",
      planReviewReplanCount: 8,
    }));
    expect(store.updateTask).not.toHaveBeenCalledWith(task.id, expect.objectContaining({
      status: "awaiting-approval",
    }));
  });

  it("resets the replan counter when Plan Review passes", async () => {
    const rootDir = await createFixtureRoot();
    roots.push(rootDir);
    const task = createRetryTask({ id: "FN-REPLAN-CAP-RESET", planReviewReplanCount: 2 });
    const prompt = `# Task: ${task.id} - Existing draft\n\n## Mission\n\nKeep this exact text.\n`;
    await writePrompt(rootDir, task.id, prompt);
    const store = createStore(task);
    mockReviewStep.mockResolvedValue({ verdict: "APPROVE", review: "Approved.", summary: "Ready." });

    await runGate(rootDir, task, store);

    expect(store.updateTask).toHaveBeenCalledWith(task.id, expect.objectContaining({
      planReviewReplanCount: null,
    }));
    expect(store.moveTask).toHaveBeenCalledWith(task.id, "todo");
  });
});
