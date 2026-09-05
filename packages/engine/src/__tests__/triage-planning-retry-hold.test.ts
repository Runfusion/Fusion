import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings, Task, TaskStore, WorkflowIr } from "@fusion/core";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TriageProcessor } from "../triage.js";
import { evaluateUnplannedForExecution } from "../execution/hold-release.js";

const { mockCreateFnAgent, mockPromptWithFallback } = vi.hoisted(() => ({
  mockCreateFnAgent: vi.fn(),
  mockPromptWithFallback: vi.fn(),
}));

vi.mock("../pi.js", () => ({
  createFnAgent: mockCreateFnAgent,
  promptWithFallback: mockPromptWithFallback,
  describeModel: vi.fn(() => "test-model"),
  formatModelMarkerDetails: vi.fn(() => "test-model"),
  wrapToolsWithRtkRewrite: vi.fn((tools: unknown) => tools),
  wrapToolsWithActionGate: vi.fn((tools: unknown) => tools),
  wrapToolsWithPermanentAgentGating: vi.fn((tools: unknown) => tools),
  wrapToolsWithOutputBudget: vi.fn((tools: unknown) => tools),
}));

const INVALID_PLAN = "# Invalid plan\n\n### Step 1: Starts at one\n";
const VALID_PLAN = "# Valid plan\n\n## Steps\n\n### Step 0: Implement\n- Deliver the requested behavior.\n";
const EMPTY_IR = { columns: [], nodes: [], edges: [] } as unknown as WorkflowIr;

function taskFixture(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-9260-RETRY",
    title: "Retry planning safely",
    description: "Ensure a rejected plan remains held until it is replanned.",
    column: "triage",
    status: "planning",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-09-05T00:00:00.000Z",
    updatedAt: "2026-09-05T00:00:00.000Z",
    ...overrides,
  };
}

function createStore(task: Task, settings: Partial<Settings> = {}): TaskStore {
  const store: Partial<TaskStore> = {
    getTask: vi.fn(async () => ({ ...task, attachments: [], comments: [] })),
    getSettings: vi.fn(async () => ({
      maxConcurrent: 2,
      maxWorktrees: 2,
      pollIntervalMs: 10_000,
      groupOverlappingFiles: false,
      autoMerge: true,
      planApprovalMode: "workflow",
      requirePlanApproval: false,
      ...settings,
    } as Settings)),
    getTaskWorkflowSelection: vi.fn(() => undefined),
    getTaskWorkflowSelectionAsync: vi.fn(async () => undefined),
    getWorkflowSettingValues: vi.fn(() => ({ requirePlanApproval: true })),
    getWorkflowSettingsProjectId: vi.fn(() => "test-project"),
    getWorkflowDefinition: vi.fn(async () => undefined),
    withTaskLock: vi.fn(async (_id, callback) => callback()),
    withPlanningLifecycleLock: vi.fn(async (_id, callback) => callback()),
    updateTask: vi.fn(async (_id, patch) => Object.assign(task, patch)),
    updateTaskUnlocked: vi.fn(async (_id, patch) => Object.assign(task, patch)),
    readTaskForMove: vi.fn(async () => task),
    moveTaskIf: vi.fn(async (_id, column) => {
      task.column = column;
      return { task, moved: true };
    }),
    logEntry: vi.fn(async () => undefined),
    parseDependenciesFromPrompt: vi.fn(async () => []),
    parseStepsFromPrompt: vi.fn(async () => []),
    parseFileScopeFromPrompt: vi.fn(async () => []),
    recordActivity: vi.fn(async () => undefined),
    appendAgentLog: vi.fn(async () => undefined),
    findRecentTasksBySourceParentTaskId: vi.fn(async () => []),
    listTasks: vi.fn(async () => []),
    on: vi.fn(),
    emit: vi.fn(),
    isBackendMode: vi.fn(() => false),
  };
  return store as TaskStore;
}

/*
FNXC:TriagePlanningRetry 2026-09-05-22:39:
FN-9260 requires the real planning retry path to retain a finished-looking rejected plan as
`needs-replan`; otherwise dispatch can bypass the workflow-required manual approval gate.
*/
describe("planning retry hold safety gate (FN-9260)", () => {
  let rootDir = "";

  beforeEach(async () => {
    vi.clearAllMocks();
    rootDir = await mkdtemp(join(tmpdir(), "fusion-triage-retry-hold-"));
    mockCreateFnAgent.mockResolvedValue({
      session: { state: {}, prompt: vi.fn(), dispose: vi.fn(), sessionManager: {}, navigateTree: vi.fn() },
      settleFallbackDispatch: async () => undefined,
    });
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it("holds a deterministic-validation retry over a real plan, refuses release, and later requires approval", async () => {
    const task = taskFixture();
    const store = createStore(task);
    const promptPath = join(rootDir, ".fusion", "tasks", task.id, "PROMPT.md");
    await mkdir(join(rootDir, ".fusion", "tasks", task.id), { recursive: true });

    mockPromptWithFallback.mockImplementationOnce(async () => {
      await writeFile(promptPath, INVALID_PLAN, "utf8");
    });
    const processor = new TriageProcessor(store, rootDir, { pollIntervalMs: 100_000 });
    await processor.specifyTask(task);

    expect(store.updateTask).toHaveBeenCalledWith(task.id, expect.objectContaining({
      status: "needs-replan",
      recoveryRetryCount: 1,
      nextRecoveryAt: expect.any(String),
    }));
    expect(task.status).toBe("needs-replan");
    expect(await evaluateUnplannedForExecution(store, task, EMPTY_IR)).toMatchObject({
      unplanned: true,
      reason: "needs-replan",
    });

    mockPromptWithFallback.mockImplementationOnce(async () => {
      await writeFile(promptPath, VALID_PLAN, "utf8");
    });
    await processor.specifyTask(task);

    expect(store.updateTask).toHaveBeenCalledWith(task.id, expect.objectContaining({ status: "awaiting-approval" }));
    expect(task.status).toBe("awaiting-approval");
  });

  it("keeps missing drafts claimable, preserves existing review holds, and terminalizes an exhausted retry", async () => {
    const task = taskFixture();
    const processor = new TriageProcessor(createStore(task), rootDir);
    const retryStatus = await (processor as unknown as {
      resolvePlanningRetryHoldStatus(task: Task): Promise<Task["status"]>;
    }).resolvePlanningRetryHoldStatus(task);
    expect(retryStatus).toBeNull();

    const reviewHeld = taskFixture({ status: "plan-review-unavailable" });
    const reviewProcessor = new TriageProcessor(createStore(reviewHeld), rootDir);
    await expect((reviewProcessor as unknown as {
      resolvePlanningRetryHoldStatus(task: Task): Promise<Task["status"]>;
    }).resolvePlanningRetryHoldStatus(reviewHeld)).resolves.toBe("plan-review-unavailable");

    const exhausted = taskFixture({ id: "FN-9260-EXHAUSTED", recoveryRetryCount: 3 });
    const exhaustedStore = createStore(exhausted);
    const exhaustedPath = join(rootDir, ".fusion", "tasks", exhausted.id, "PROMPT.md");
    await mkdir(join(rootDir, ".fusion", "tasks", exhausted.id), { recursive: true });
    mockPromptWithFallback.mockImplementationOnce(async () => {
      await writeFile(exhaustedPath, INVALID_PLAN, "utf8");
    });
    await new TriageProcessor(exhaustedStore, rootDir).specifyTask(exhausted);
    expect(exhaustedStore.updateTask).toHaveBeenCalledWith(exhausted.id, expect.objectContaining({
      status: "failed",
      recoveryRetryCount: null,
      nextRecoveryAt: null,
    }));
  });
});
