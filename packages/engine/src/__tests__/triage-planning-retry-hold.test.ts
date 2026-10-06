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
  ModelFallbackExhaustedError: class ModelFallbackExhaustedError extends Error {},
  describeModel: vi.fn(() => "test-model"),
  formatModelMarkerDetails: vi.fn(() => "test-model"),
  wrapToolsWithRtkRewrite: vi.fn((tools: unknown) => tools),
  wrapToolsWithActionGate: vi.fn((tools: unknown) => tools),
  wrapToolsWithPermanentAgentGating: vi.fn((tools: unknown) => tools),
  wrapToolsWithOutputBudget: vi.fn((tools: unknown) => tools),
}));

/*
 * FNXC:StepDependencyValidation 2026-10-01-22:44:
 * FN-9435 treats heading labels as display-only. Keep an intentionally non-zero valid label, while
 * making retry coverage fail on an impossible parsed-step position rather than its visible number.
 */
const INVALID_PLAN = "# Invalid plan\n\n### Step 24 (depends: 2): Uses an absent prerequisite\n";
const VALID_PLAN = "# Valid plan\n\n## Steps\n\n### Step 42: Implement\n- Deliver the requested behavior.\n";
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

  it("keeps missing drafts claimable, preserves existing review holds, and reseeds an exhausted retry", async () => {
    /*
     * FNXC:TriagePlanningRetry 2026-10-01-05:53:
     * FN-9446 requires missing-draft and review-hold coverage to run through specifyTask. The
     * persisted row intentionally differs from the attempt snapshot, matching TaskStore reads so
     * the production retry writer—not a private status helper—proves its durable transition.
     */
    const missingDraft = taskFixture({ id: "FN-9260-MISSING-DRAFT" });
    const missingPersisted = { ...missingDraft };
    const missingStore = createStore(missingDraft);
    vi.mocked(missingStore.getTask).mockImplementation(async () => ({ ...missingPersisted, attachments: [], comments: [] }));
    vi.mocked(missingStore.updateTask).mockImplementation(async (_id, patch) => Object.assign(missingPersisted, patch));
    await new TriageProcessor(missingStore, rootDir).specifyTask(missingDraft);
    expect(missingPersisted).toMatchObject({
      status: null,
      recoveryRetryCount: 1,
      nextRecoveryAt: expect.any(String),
    });

    const reviewHeld = taskFixture({ id: "FN-9260-REVIEW-HOLD", status: "plan-review-unavailable" });
    const reviewPersisted = { ...reviewHeld };
    const reviewStore = createStore(reviewHeld);
    vi.mocked(reviewStore.getTask).mockImplementation(async () => ({ ...reviewPersisted, attachments: [], comments: [] }));
    vi.mocked(reviewStore.updateTask).mockImplementation(async (_id, patch) => Object.assign(reviewPersisted, patch));
    await new TriageProcessor(reviewStore, rootDir).specifyTask(reviewHeld);
    expect(reviewPersisted).toMatchObject({
      status: "plan-review-unavailable",
      recoveryRetryCount: 1,
      nextRecoveryAt: expect.any(String),
    });

    /*
     * FNXC:TriagePlanningRetry 2026-10-06-19:53:
     * FN-9512 makes ordinary deterministic planning exhaustion re-enter the existing planning
     * owner at and beyond the retry cap. A failed status has no automatic claimant, so both
     * boundary counts must retain needs-replan and the visible reseed disposition until a new
     * planning claim clears it.
     */
    for (const recoveryRetryCount of [3, 4]) {
      const exhausted = taskFixture({
        id: `FN-9260-EXHAUSTED-${recoveryRetryCount}`,
        recoveryRetryCount,
      });
      const exhaustedStore = createStore(exhausted);
      const exhaustedPath = join(rootDir, ".fusion", "tasks", exhausted.id, "PROMPT.md");
      await mkdir(join(rootDir, ".fusion", "tasks", exhausted.id), { recursive: true });
      mockPromptWithFallback.mockImplementationOnce(async () => {
        await writeFile(exhaustedPath, INVALID_PLAN, "utf8");
      });
      await new TriageProcessor(exhaustedStore, rootDir).specifyTask(exhausted);

      expect(exhaustedStore.updateTask).toHaveBeenCalledWith(exhausted.id, expect.objectContaining({
        status: "needs-replan",
        error: null,
        recoveryRetryCount: null,
        recoveryDisposition: "escalated-reseed",
        nextRecoveryAt: null,
      }));
      expect(exhausted.status).toBe("needs-replan");
      expect(exhausted.error).toBeNull();
      expect(await evaluateUnplannedForExecution(exhaustedStore, exhausted, EMPTY_IR)).toMatchObject({
        unplanned: true,
        reason: "needs-replan",
      });
    }
  });
});
