import { describe, it, expect, vi, afterEach } from "vitest";
import { RetryStormError, type Settings, type Task, type TaskStore } from "@fusion/core";
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
  ReviewerProviderError: class ReviewerProviderError extends Error {
    constructor(message: string, public readonly classification: string, options?: { provider?: string }) {
      super(message);
      this.provider = options?.provider;
    }
    readonly provider?: string;
  },
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

function createStore(task: Task, settingsOverrides: Partial<Settings> = {}): TaskStore {
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
    getWorkflowSettingValues: vi.fn().mockReturnValue({}),
    getWorkflowSettingsProjectId: vi.fn().mockReturnValue("project-plan-review-retry"),
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

async function retryTask(
  rootDir: string,
  task: Task,
  store = createStore(task),
  options: ConstructorParameters<typeof TriageProcessor>[2] = {},
): Promise<TaskStore> {
  const processor = new TriageProcessor(store, rootDir, options);
  await processor.specifyTask(task);
  return store;
}

function findUpdate(store: TaskStore, taskId: string, predicate: (update: Record<string, unknown>) => boolean) {
  return (store.updateTask as ReturnType<typeof vi.fn>).mock.calls.find(
    ([id, update]) => id === taskId && update && predicate(update as Record<string, unknown>),
  )?.[1] as Record<string, unknown> | undefined;
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
      "spec",
      prompt,
      undefined,
      expect.objectContaining({ taskId: task.id }),
    );
    expect(readFileSync(promptPath, "utf-8")).toBe(prompt);
    expect(store.moveTask).toHaveBeenCalledWith(task.id, "todo");
  });

  it("moves an approved retry to todo when project auto approval overrides workflow approval", async () => {
    const rootDir = await createFixtureRoot();
    roots.push(rootDir);
    const task = createRetryTask({ id: "FN-PLAN-RETRY-AUTO-APPROVE" });
    const prompt = `# Task: ${task.id} - Existing draft\n\n## Mission\n\nKeep this exact text.\n`;
    const promptPath = await writePrompt(rootDir, task.id, prompt);
    const store = createStore(task, { planApprovalMode: "auto-approve-all", requirePlanApproval: false });
    (store.getWorkflowSettingValues as ReturnType<typeof vi.fn>).mockReturnValue({ requirePlanApproval: true });
    mockReviewStep.mockResolvedValue({ verdict: "APPROVE", review: "Approved.", summary: "Ready." });

    await retryTask(rootDir, task, store);

    expect(mockCreateFnAgent).not.toHaveBeenCalled();
    expect(readFileSync(promptPath, "utf-8")).toBe(prompt);
    expect(store.moveTask).toHaveBeenCalledWith(task.id, "todo");
    expect(store.updateTask).not.toHaveBeenCalledWith(task.id, expect.objectContaining({ status: "awaiting-approval" }));
    const logActions = (store.logEntry as ReturnType<typeof vi.fn>).mock.calls.map(([, action]) => action);
    expect(logActions).not.toContain("Specification approved by AI — awaiting manual approval");
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

  /**
   * FNXC:PlanReview 2026-07-15-21:30:
   * A sustained provider outage used to re-run Plan Review on a FIXED 30s timer with no attempt
   * counter — ~1,900 requests/5h, which is what trips a provider's low-interactivity throttle.
   * These regressions pin the two rules that bound it: the backoff grows and terminalizes, and a
   * usage limit pauses every lane rather than only re-parking this task.
   *
   * Surface enumeration — the loop is driven by (a) a thrown provider error, (b) a thrown generic
   * error, and (c) a plain UNAVAILABLE verdict with no throw at all. All three enter the same park,
   * so all three are asserted; a repro that only covered the reported 429 would leave (b) and (c)
   * spinning on the old fixed timer.
   */
  it.each([
    { name: "thrown 429 overloaded_error", setup: () => mockReviewStep.mockRejectedValue(new Error("429 overloaded_error")) },
    { name: "thrown generic reviewer error", setup: () => mockReviewStep.mockRejectedValue(new Error("review process crashed")) },
    { name: "plain unavailable verdict", setup: () => mockReviewStep.mockResolvedValue({ verdict: "UNAVAILABLE", review: "No verdict.", summary: "Unavailable." }) },
  ])("backs off exponentially rather than on a fixed 30s timer for $name", async ({ setup }) => {
    const rootDir = await createFixtureRoot();
    roots.push(rootDir);
    // Second attempt: 60s base × 2^1 = 120s ±10% — provably past the old fixed 30s park.
    const task = createRetryTask({ id: "FN-PLAN-BACKOFF", recoveryRetryCount: 1 });
    await writePrompt(rootDir, task.id, `# Task: ${task.id}\n\n## Mission\n\nKeep me.\n`);
    const store = createStore(task);
    setup();

    const before = Date.now();
    await retryTask(rootDir, task, store);

    const park = findUpdate(store, task.id, (u) => u.status === "plan-review-unavailable");
    expect(park?.recoveryRetryCount).toBe(2);
    const delayMs = new Date(park?.nextRecoveryAt as string).getTime() - before;
    expect(delayMs).toBeGreaterThan(60_000);
    expect(delayMs).toBeLessThanOrEqual(133_000);
  });

  it("parks only the provider-routed task when Plan Review hits a usage limit", async () => {
    const rootDir = await createFixtureRoot();
    roots.push(rootDir);
    const task = createRetryTask({ id: "FN-PLAN-429" });
    await writePrompt(rootDir, task.id, `# Task: ${task.id}\n\n## Mission\n\nKeep me.\n`);
    const store = createStore(task);
    const onUsageLimitHit = vi.fn().mockResolvedValue(undefined);
    const { ReviewerProviderError } = await import("../reviewer.js");
    mockReviewStep.mockRejectedValue(new ReviewerProviderError("429 overloaded_error", "usage-limit", { provider: "anthropic" }));

    await retryTask(rootDir, task, store, { usageLimitPauser: { onUsageLimitHit } as never });

    expect(onUsageLimitHit).toHaveBeenCalledWith("triage", task.id, expect.stringContaining("429"), "anthropic");
  });

  it("does not pause lanes for a reviewer failure that is not a usage limit", async () => {
    const rootDir = await createFixtureRoot();
    roots.push(rootDir);
    const task = createRetryTask({ id: "FN-PLAN-NO-PAUSE" });
    await writePrompt(rootDir, task.id, `# Task: ${task.id}\n\n## Mission\n\nKeep me.\n`);
    const store = createStore(task);
    const onUsageLimitHit = vi.fn().mockResolvedValue(undefined);
    mockReviewStep.mockRejectedValue(new Error("review process crashed"));

    await retryTask(rootDir, task, store, { usageLimitPauser: { onUsageLimitHit } as never });

    expect(onUsageLimitHit).not.toHaveBeenCalled();
  });

  it("terminalizes instead of re-parking once the unavailable retry budget is spent", async () => {
    const rootDir = await createFixtureRoot();
    roots.push(rootDir);
    // MAX_RECOVERY_RETRIES is 3, so a 3rd spent attempt exhausts on this pass.
    const task = createRetryTask({ id: "FN-PLAN-EXHAUSTED", recoveryRetryCount: 3 });
    await writePrompt(rootDir, task.id, `# Task: ${task.id}\n\n## Mission\n\nKeep me.\n`);
    const store = createStore(task);
    mockReviewStep.mockRejectedValue(new Error("429 overloaded_error"));

    await retryTask(rootDir, task, store);

    expect(store.updateTask).toHaveBeenCalledWith(task.id, expect.objectContaining({
      status: "failed",
      // The real error must survive to task.error — "budget exhausted" alone hides the cause.
      error: expect.stringContaining("429 overloaded_error"),
      recoveryRetryCount: null,
      nextRecoveryAt: null,
    }));
    expect(store.updateTask).not.toHaveBeenCalledWith(task.id, expect.objectContaining({
      status: "plan-review-unavailable",
    }));
  });

  it("returns the borrowed recovery budget once Plan Review produces a real verdict", async () => {
    const rootDir = await createFixtureRoot();
    roots.push(rootDir);
    const task = createRetryTask({ id: "FN-PLAN-BUDGET-CLEAR", recoveryRetryCount: 2 });
    await writePrompt(rootDir, task.id, `# Task: ${task.id}\n\n## Mission\n\nKeep me.\n`);
    const store = createStore(task);
    mockReviewStep.mockResolvedValue({ verdict: "APPROVE", review: "Approved.", summary: "Ready." });

    await retryTask(rootDir, task, store);

    expect(store.updateTask).toHaveBeenCalledWith(task.id, expect.objectContaining({
      recoveryRetryCount: null,
      nextRecoveryAt: null,
    }));
  });

  it("terminalizes a reviewer retry storm instead of scheduling another unavailable retry", async () => {
    const rootDir = await createFixtureRoot();
    roots.push(rootDir);
    const task = createRetryTask({ id: "FN-PLAN-RETRY-STORM", reviewerFallbackRetryCount: 3 });
    const prompt = `# Task: ${task.id} - Existing draft\n\n## Mission\n\nKeep this exact text.\n`;
    await writePrompt(rootDir, task.id, prompt);
    const store = createStore(task);
    const storm = new RetryStormError({
      category: "reviewerFallback",
      total: 3,
      cap: 2,
      breakdown: {
        stuckKill: 0,
        recovery: 0,
        taskDone: 0,
        worktreeSession: 0,
        workflowStep: 0,
        verification: 0,
        postReviewFix: 0,
        mergeConflict: 0,
        branchConflict: 0,
        reviewerContext: 0,
        reviewerFallback: 3,
        total: 3,
      },
    });
    mockReviewStep.mockRejectedValue(storm);

    await retryTask(rootDir, task, store);

    expect(store.updateTask).toHaveBeenCalledWith(task.id, expect.objectContaining({
      status: "failed",
      error: expect.stringContaining('"type":"RetryStormError"'),
      nextRecoveryAt: null,
    }));
    expect(store.updateTask).not.toHaveBeenCalledWith(task.id, expect.objectContaining({
      status: "plan-review-unavailable",
    }));
    expect(store.logEntry).toHaveBeenCalledWith(
      task.id,
      "[pre-merge] Workflow step failed: Plan Review",
      expect.stringContaining('"type":"RetryStormError"'),
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
      "spec",
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
