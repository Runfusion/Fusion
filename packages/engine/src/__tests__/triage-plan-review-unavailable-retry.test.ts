import { describe, it, expect, vi, afterEach } from "vitest";
import type { Settings, Task, TaskStore } from "@fusion/core";
import { join } from "node:path";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { TriageProcessor } from "../triage.js";

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
  return mkdtemp(join(tmpdir(), "fusion-triage-plan-review-unavailable-retry-"));
}

async function cleanupFixtureRoot(rootDir: string): Promise<void> {
  await rm(rootDir, { recursive: true, force: true });
}

function createRetryTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-PLAN-RETRY-FOCUSED",
    description: "Retry existing Plan Review draft",
    title: "Retry existing Plan Review draft",
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

function createStore(task: Task): TaskStore {
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

async function retryTask(rootDir: string, task: Task, store = createStore(task)): Promise<TaskStore> {
  const processor = new TriageProcessor(store, rootDir);
  await processor.specifyTask(task);
  return store;
}

describe("Plan Review unavailable retry", () => {
  let roots: string[] = [];

  afterEach(async () => {
    mockReviewStep.mockReset();
    mockCreateFnAgent.mockReset();
    await Promise.all(roots.map(cleanupFixtureRoot));
    roots = [];
  });

  /**
   * FNXC:PlanReview 2026-06-29-16:45:
   * Reviewer-outage retry is a recovery path for an already-written PROMPT.md. These focused regressions pin that retry to the reviewer/finalizer seam so outages do not silently relaunch planning or rewrite the accepted draft.
   */
  it("approves an elapsed retry using the exact existing PROMPT.md without launching the planner", async () => {
    const rootDir = await createFixtureRoot();
    roots.push(rootDir);
    const task = createRetryTask({ id: "FN-PLAN-RETRY-APPROVE" });
    const prompt = `# Task: ${task.id} - Existing draft\n\n## Mission\n\nKeep this exact text.\n`;
    const promptPath = await writePrompt(rootDir, task.id, prompt);
    const store = createStore(task);
    mockReviewStep.mockResolvedValue({ verdict: "APPROVE", review: "Approved.", summary: "Ready." });

    await retryTask(rootDir, task, store);

    expect(mockCreateFnAgent).not.toHaveBeenCalled();
    expect(mockReviewStep).toHaveBeenCalledWith(
      rootDir,
      task.id,
      0,
      "PROMPT.md",
      "plan",
      prompt,
      undefined,
      expect.objectContaining({ taskId: task.id }),
    );
    expect(readFileSync(promptPath, "utf-8")).toBe(prompt);
    expect(store.moveTask).toHaveBeenCalledWith(task.id, "todo");
  });

  it.each([
    {
      name: "unavailable verdict",
      setup: () => mockReviewStep.mockResolvedValue({ verdict: "UNAVAILABLE", review: "Reviewer capacity outage.", summary: "Unavailable." }),
      expectedOutput: "Reviewer capacity outage",
    },
    {
      name: "thrown reviewer error",
      setup: () => mockReviewStep.mockRejectedValue(new Error("review process crashed")),
      expectedOutput: "review process crashed",
    },
  ])("keeps PROMPT.md and refreshes backoff on $name", async ({ setup, expectedOutput }) => {
    const rootDir = await createFixtureRoot();
    roots.push(rootDir);
    const staleRecoveryAt = "2026-01-01T00:00:00.000Z";
    const task = createRetryTask({ id: "FN-PLAN-RETRY-OUTAGE", nextRecoveryAt: staleRecoveryAt });
    const prompt = `# Task: ${task.id} - Existing draft\n\n## Mission\n\nDo not rewrite me.\n`;
    const promptPath = await writePrompt(rootDir, task.id, prompt);
    const store = createStore(task);
    setup();

    await retryTask(rootDir, task, store);

    expect(mockCreateFnAgent).not.toHaveBeenCalled();
    expect(readFileSync(promptPath, "utf-8")).toBe(prompt);
    expect(store.moveTask).not.toHaveBeenCalled();
    expect(store.updateTask).toHaveBeenCalledWith(task.id, expect.objectContaining({
      status: "plan-review-unavailable",
      nextRecoveryAt: expect.any(String),
    }));
    const outageUpdate = (store.updateTask as ReturnType<typeof vi.fn>).mock.calls.find(
      ([id, update]) => id === task.id && update?.status === "plan-review-unavailable",
    );
    expect(outageUpdate?.[1].nextRecoveryAt).not.toBe(staleRecoveryAt);
    expect(store.updateTask).toHaveBeenCalledWith(task.id, expect.objectContaining({
      workflowStepResults: expect.arrayContaining([
        expect.objectContaining({ workflowStepId: "plan-review", status: "failed", output: expect.stringContaining(expectedOutput) }),
      ]),
    }));
    expect(store.logEntry).toHaveBeenCalledWith(
      task.id,
      "[pre-merge] Workflow step unavailable: Plan Review",
      expect.stringContaining(expectedOutput),
    );
  });

  it.each([
    { name: "missing", contents: null, expectedError: /could not read existing PROMPT\.md/i },
    { name: "whitespace-only", contents: "  \n\t\n", expectedError: /PROMPT\.md.*(empty|whitespace)/i },
  ])("parks invalid $name PROMPT.md with a clear error and no planner launch", async ({ contents, expectedError }) => {
    const rootDir = await createFixtureRoot();
    roots.push(rootDir);
    const task = createRetryTask({ id: `FN-PLAN-RETRY-${contents === null ? "MISSING" : "BLANK"}` });
    let promptPath: string | null = null;
    if (contents !== null) {
      promptPath = await writePrompt(rootDir, task.id, contents);
    }
    const store = createStore(task);

    await retryTask(rootDir, task, store);

    expect(mockCreateFnAgent).not.toHaveBeenCalled();
    expect(mockReviewStep).not.toHaveBeenCalled();
    expect(store.updateTask).toHaveBeenCalledWith(task.id, expect.objectContaining({
      status: "failed",
      error: expect.stringMatching(expectedError),
      nextRecoveryAt: null,
    }));
    expect(store.logEntry).toHaveBeenCalledWith(task.id, expect.stringMatching(expectedError));
    if (promptPath) {
      expect(readFileSync(promptPath, "utf-8")).toBe(contents);
    }
  });

  it.each(["REVISE", "RETHINK"] as const)("moves retry to needs-replan with feedback when reviewer returns %s", async (verdict) => {
    const rootDir = await createFixtureRoot();
    roots.push(rootDir);
    const task = createRetryTask({ id: `FN-PLAN-RETRY-${verdict}` });
    const prompt = `# Task: ${task.id} - Existing draft\n\n## Mission\n\nOnly rewrite after reviewer feedback.\n`;
    const promptPath = await writePrompt(rootDir, task.id, prompt);
    const store = createStore(task);
    const feedback = `${verdict} feedback from reviewer.`;
    mockReviewStep.mockResolvedValue({ verdict, review: feedback, summary: "Needs revision." });

    await retryTask(rootDir, task, store);

    expect(mockCreateFnAgent).not.toHaveBeenCalled();
    expect(mockReviewStep).toHaveBeenCalledWith(
      rootDir,
      task.id,
      0,
      "PROMPT.md",
      "plan",
      prompt,
      undefined,
      expect.objectContaining({ taskId: task.id }),
    );
    expect(readFileSync(promptPath, "utf-8")).toBe(prompt);
    expect(store.moveTask).not.toHaveBeenCalled();
    expect(store.updateTask).toHaveBeenCalledWith(task.id, expect.objectContaining({
      status: "needs-replan",
      error: null,
      nextRecoveryAt: null,
    }));
    expect(store.logEntry).toHaveBeenCalledWith(
      task.id,
      "AI spec revision requested",
      expect.stringContaining(feedback),
    );
  });
});
