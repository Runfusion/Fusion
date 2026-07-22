import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings, Task, TaskDetail, TaskStore } from "@fusion/core";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { TriageProcessor } from "../triage.js";

const { mockCreateResolvedAgentSession, mockPromptWithFallback } = vi.hoisted(() => ({
  mockCreateResolvedAgentSession: vi.fn(),
  mockPromptWithFallback: vi.fn(),
}));

vi.mock("../agent-session-helpers.js", () => ({
  createResolvedAgentSession: mockCreateResolvedAgentSession,
  extractRuntimeHint: vi.fn(),
  resolvePlanningSessionModel: vi.fn().mockReturnValue({ provider: "mock", modelId: "mock-model" }),
  // FNXC:EngineTestDrift 2026-07-11-22:30:
  // triage.ts planning imports resolvePlanningThinkingLevel +
  // resolveImplicitPlanningFallbackModel (Settings-ThinkingLevel precedence +
  // implicit fallback model, 2026-07-10). Surface the full resolver set so the
  // next export doesn't re-break specifyTask on a missing mock member.
  resolveExecutorThinkingLevel: vi.fn(() => undefined),
  resolveExecutorFallbackThinkingLevel: vi.fn(() => undefined),
  resolvePlanningThinkingLevel: vi.fn(() => undefined),
  resolvePlanningFallbackThinkingLevel: vi.fn(() => undefined),
  resolveValidatorThinkingLevel: vi.fn(() => undefined),
  resolveValidatorFallbackThinkingLevel: vi.fn(() => undefined),
  resolveMergerThinkingLevel: vi.fn(() => undefined),
  resolveMergerFallbackThinkingLevel: vi.fn(() => undefined),
  resolveImplicitPlanningFallbackModel: vi.fn(() => ({ provider: undefined, modelId: undefined })),
}));

vi.mock("../pi.js", () => {
  // FNXC:EngineTestDrift 2026-07-11-22:30:
  // triage.ts specifyTask catch guards `err instanceof ModelFallbackExhaustedError`
  // (FN-7559). The pi mock must expose the class so the stuck-requeue planning
  // path can finalize instead of throwing on a missing mock member.
  class ModelFallbackExhaustedError extends Error {}
  return {
    describeModel: vi.fn().mockReturnValue("mock-model"),
    promptWithFallback: mockPromptWithFallback,
    // FNXC:TriageTests 2026-07-02-07:40:
    // triage.ts specifyTask now calls formatModelMarkerDetails (from pi.js) to
    // build the model-marker log line after the agent session resolves. The mock
    // must expose the export so the stuck-requeue planning path can reach
    // finalization (moveTask todo / needs-replan) instead of throwing on a
    // missing mock member.
    formatModelMarkerDetails: vi.fn((model: string) => model),
    ModelFallbackExhaustedError,
  };
});

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-7173-T",
    title: "Preserve draft",
    description: "Preserve an existing draft after stuck triage requeue",
    column: "triage",
    status: null,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-06-27T00:00:00.000Z",
    updatedAt: "2026-06-27T00:00:00.000Z",
    ...overrides,
  } as Task;
}

function toDetail(task: Task): TaskDetail {
  return {
    ...task,
    attachments: [],
    comments: [],
    log: task.log ?? [],
  } as TaskDetail;
}

function createMutableStore(initialTask: Task, settings: Partial<Settings> = {}, documents: Record<string, string> = {}) {
  let currentTask: Task = { ...initialTask, log: [...(initialTask.log ?? [])] };
  const store = {
    getTask: vi.fn(async () => toDetail(currentTask)),
    listTasks: vi.fn().mockResolvedValue([]),
    getSettings: vi.fn().mockResolvedValue({
      pollIntervalMs: 60_000,
      maxConcurrent: 1,
      maxWorktrees: 1,
      autoMerge: true,
      groupOverlappingFiles: false,
      maxStuckKills: 6,
      requirePlanApproval: false,
      ...settings,
    } as Settings),
    getTaskDocument: vi.fn(async (_id: string, key: string) => {
      const content = documents[key];
      return content === undefined
        ? null
        : {
            id: `doc-${key}`,
            taskId: currentTask.id,
            key,
            content,
            revision: 1,
            author: "agent",
            metadata: {},
            createdAt: "2026-06-27T00:00:00.000Z",
            updatedAt: "2026-06-27T00:00:00.000Z",
          };
    }),
    updateTask: vi.fn(async (_id: string, updates: Partial<Task>) => {
      currentTask = { ...currentTask, ...updates, updatedAt: "2026-06-27T00:01:00.000Z" } as Task;
      return currentTask;
    }),
    moveTask: vi.fn(async (_id: string, column: Task["column"]) => {
      currentTask = { ...currentTask, column, status: null } as Task;
      return currentTask;
    }),
    /*
    FNXC:EngineTests 2026-07-20-23:50:
    Finalization releases via moveTaskIf (planning-stage CAS), not bare moveTask.
    */
    moveTaskIf: vi.fn(async (_id: string, column: Task["column"], predicate: (t: Task) => boolean) => {
      if (!predicate(currentTask)) return { moved: false, task: currentTask };
      currentTask = { ...currentTask, column, status: null } as Task;
      await (store as any).moveTask(_id, column);
      return { moved: true, task: currentTask };
    }),
    logEntry: vi.fn(async (_id: string, action: string, outcome?: string) => {
      currentTask = {
        ...currentTask,
        log: [...(currentTask.log ?? []), { timestamp: new Date().toISOString(), action, outcome }],
      } as Task;
    }),
    appendAgentLog: vi.fn().mockResolvedValue(undefined),
    parseDependenciesFromPrompt: vi.fn().mockResolvedValue([]),
    parseStepsFromPrompt: vi.fn().mockResolvedValue([]),
    parseFileScopeFromPrompt: vi.fn().mockResolvedValue([]),
    /*
    FNXC:EngineTests 2026-07-20-23:40:
    PROMPT hygiene finalization requires withTaskLock + readTaskForMove; without them
    runIfStillPlanningUnderTaskLock fails closed before moveTask(todo).
    */
    withTaskLock: vi.fn(async (_id: string, fn: () => Promise<unknown>) => fn()),
    readTaskForMove: vi.fn(async () => toDetail(currentTask)),
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as TaskStore;

  return {
    store,
    get currentTask() {
      return currentTask;
    },
  };
}

async function createRoot(taskId: string, draft?: string): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), "fusion-triage-stuck-draft-"));
  const taskDir = join(rootDir, ".fusion", "tasks", taskId);
  await mkdir(taskDir, { recursive: true });
  if (draft !== undefined) {
    await writeFile(join(taskDir, "PROMPT.md"), draft, "utf8");
  }
  return rootDir;
}

/*
FNXC:EngineTests 2026-07-20-23:55:
Stuck planning recovery withholds release when the workflow requires step-heading
parse-steps and the draft has neither executable steps nor **No commits expected**.
Drafts that assert auto-recovery to todo must satisfy that gate.
*/
function executableDraft(taskId: string, mission: string, extra = ""): string {
  return [
    `# Task: ${taskId}`,
    "",
    "## Mission",
    "",
    mission,
    "",
    "## Steps",
    "",
    "### Step 0: Implement",
    "- [ ] do the work",
    "",
    extra,
  ].filter((line, i, arr) => !(line === "" && arr[i - 1] === "")).join("\n");
}

function mockSession() {
  mockCreateResolvedAgentSession.mockResolvedValue({
    session: {
      state: {},
      sessionManager: { getLeafId: vi.fn().mockReturnValue(null) },
      prompt: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn(),
      navigateTree: vi.fn(),
    },
  });
}

async function cleanup(rootDir: string | undefined) {
  if (rootDir) {
    await rm(rootDir, { recursive: true, force: true });
  }
}

describe("triage stuck requeue preserves existing PROMPT.md drafts", () => {
  let rootDir: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSession();
  });

  afterEach(async () => {
    await cleanup(rootDir);
    rootDir = undefined;
  });

  it("recovers forward from a non-empty PROMPT.md draft after a stuck abort", async () => {
    const draft = executableDraft("FN-7173-T", "Continue from this already drafted plan.");
    const task = createTask();
    rootDir = await createRoot(task.id, draft);
    const harness = createMutableStore(task);
    const processor = new TriageProcessor(harness.store, rootDir);

    mockPromptWithFallback
      .mockImplementationOnce(async () => {
        processor.markStuckAborted(task.id);
      });

    await processor.specifyTask(harness.currentTask);
    expect(harness.store.moveTask).toHaveBeenCalledWith(task.id, "todo");
    expect(harness.store.logEntry).not.toHaveBeenCalledWith(
      task.id,
      "Triage stuck re-queue will resume existing planning draft",
      expect.anything(),
    );
  });

  it("resumes from a saved plan task document when PROMPT.md is absent", async () => {
    const planDocument = "# Plan document draft\n\n## Mission\n\nResume from the saved task document.";
    const task = createTask({ id: "FN-7173-PLAN-DOC" });
    rootDir = await createRoot(task.id);
    const harness = createMutableStore(task, {}, { plan: planDocument });
    const processor = new TriageProcessor(harness.store, rootDir);

    mockPromptWithFallback
      .mockImplementationOnce(async () => {
        processor.markStuckAborted(task.id);
      });

    await processor.specifyTask(harness.currentTask);
    expect(harness.currentTask.status).toBe("needs-replan");
    expect(harness.currentTask.stuckKillCount).toBe(1);
    expect(harness.store.logEntry).toHaveBeenCalledWith(
      task.id,
      "Triage stuck re-queue will resume existing planning draft",
      expect.stringContaining("Resume from the existing draft"),
    );
  });

  it("prefers PROMPT.md over the plan task document when both drafts exist", async () => {
    const promptDraft = executableDraft("FN-7173-PROMPT-WINS", "Prefer the executable prompt draft.");
    const planDocument = "# Plan document draft\n\nThis older plan document should not be the seed.";
    const task = createTask({ id: "FN-7173-PROMPT-WINS" });
    rootDir = await createRoot(task.id, promptDraft);
    const harness = createMutableStore(task, {}, { plan: planDocument });
    const processor = new TriageProcessor(harness.store, rootDir);

    mockPromptWithFallback
      .mockImplementationOnce(async () => {
        processor.markStuckAborted(task.id);
      });

    await processor.specifyTask(harness.currentTask);
    expect(harness.store.moveTask).toHaveBeenCalledWith(task.id, "todo");
    expect(harness.store.logEntry).not.toHaveBeenCalledWith(
      task.id,
      "Triage stuck re-queue will resume existing planning draft",
      expect.anything(),
    );
  });

  it.each([
    ["absent", undefined],
    ["whitespace-only", "  \n\t  "],
  ])("preserves cold-start behavior when the draft is %s", async (_label, draft) => {
    const task = createTask({ id: `FN-7173-${_label}` });
    rootDir = await createRoot(task.id, draft);
    const harness = createMutableStore(task);
    const processor = new TriageProcessor(harness.store, rootDir);

    mockPromptWithFallback
      .mockImplementationOnce(async () => {
        processor.markStuckAborted(task.id);
      });

    await processor.specifyTask(harness.currentTask);
    expect(harness.currentTask.status ?? null).toBeNull();
    expect(harness.currentTask.stuckKillCount).toBe(1);
    expect(harness.store.logEntry).not.toHaveBeenCalledWith(
      task.id,
      "Triage stuck re-queue will resume existing planning draft",
      expect.anything(),
    );
  });

  it("uses the same resume behavior for the outer catch stuck-abort path", async () => {
    const draft = executableDraft("FN-7173-CATCH", "Catch path draft.");
    const task = createTask({ id: "FN-7173-CATCH" });
    rootDir = await createRoot(task.id, draft);
    const harness = createMutableStore(task);
    const processor = new TriageProcessor(harness.store, rootDir);

    mockPromptWithFallback
      .mockImplementationOnce(async () => {
        processor.markStuckAborted(task.id);
        throw new Error("disposed by stuck detector");
      });

    await processor.specifyTask(harness.currentTask);
    expect(harness.store.moveTask).toHaveBeenCalledWith(task.id, "todo");
  });

  it("bounds repeated stuck retries by maxStuckKills and pauses failed tasks", async () => {
    const task = createTask({ id: "FN-7173-BOUND", stuckKillCount: 1 });
    rootDir = await createRoot(task.id, executableDraft("FN-7173-BOUND", "Draft."));
    const harness = createMutableStore(task, { maxStuckKills: 2 });
    const processor = new TriageProcessor(harness.store, rootDir);

    mockPromptWithFallback.mockImplementationOnce(async () => {
      processor.markStuckAborted(task.id);
    });

    await processor.specifyTask(harness.currentTask);

    expect(harness.store.moveTask).toHaveBeenCalledWith(task.id, "todo");
    expect(harness.currentTask.paused).not.toBe(true);
  });

  it("leaves already-written drafts on the prompt-based recovery path", async () => {
    const task = createTask({
      id: "FN-7173-APPROVED",
      status: "planning",
      log: [{ timestamp: new Date().toISOString(), action: "Spec review: APPROVE" }],
    });
    rootDir = await createRoot(
      task.id,
      executableDraft("FN-7173-APPROVED", "Approved draft.", "## File Scope\n\n- packages/engine/src/triage.ts\n"),
    );
    const harness = createMutableStore(task, { requirePlanApproval: false });
    const processor = new TriageProcessor(harness.store, rootDir);

    mockPromptWithFallback.mockImplementationOnce(async () => {
      processor.markStuckAborted(task.id);
    });

    await processor.specifyTask(harness.currentTask);

    expect(harness.store.moveTask).toHaveBeenCalledWith(task.id, "todo");
    expect(harness.store.logEntry).not.toHaveBeenCalledWith(
      task.id,
      "Triage stuck re-queue will resume existing planning draft",
      expect.anything(),
    );
  });
});
