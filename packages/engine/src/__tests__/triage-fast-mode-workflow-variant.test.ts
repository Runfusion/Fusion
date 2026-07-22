import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings, Task, TaskDetail, TaskStore, WorkflowIr } from "@fusion/core";
import {
  BUILTIN_CODING_WORKFLOW_IR,
  builtinSeamPrompt,
  renderTriagePolicyPlaceholders,
  resolvePlanningPromptFromIr,
} from "@fusion/core";
import { TriageProcessor } from "../triage.js";

const { mockReviewStep, mockCreateFnAgent, mockPromptWithFallback } = vi.hoisted(() => ({
  mockReviewStep: vi.fn(),
  mockCreateFnAgent: vi.fn(),
  mockPromptWithFallback: vi.fn(),
}));

vi.mock("../execution/reviewer.js", () => ({
  reviewStep: mockReviewStep,
}));

vi.mock("../pi.js", () => ({
  createFnAgent: mockCreateFnAgent,
  describeModel: vi.fn().mockReturnValue("mock-model"),
  promptWithFallback: mockPromptWithFallback,
  // FNXC:TriageTests 2026-07-02-07:40:
  // triage.ts specifyTask now calls formatModelMarkerDetails (from pi.js) to
  // build the model-marker log line after the agent session resolves. The mock
  // must expose the export so the planning path can reach finalization
  // (moveTask todo) instead of throwing on a missing mock member.
  formatModelMarkerDetails: vi.fn((model: string) => model),
  /*
  FNXC:EngineTests 2026-07-22-03:20:
  Catch blocks use `err instanceof ModelFallbackExhaustedError`; wholesale pi mock
  must export the class or planning failures throw on the instanceof check itself.
  */
  ModelFallbackExhaustedError: class ModelFallbackExhaustedError extends Error {},
}));

vi.mock("@fusion/core", async (importOriginal) => {
  const { createEngineCoreMock } = await import("../test/mockCore.js");
  const original = await importOriginal<typeof import("@fusion/core")>();
  return createEngineCoreMock(() => Promise.resolve(original), {
    resolveAgentPrompt: vi.fn(original.resolveAgentPrompt),
  });
});

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-6236-T",
    description: "Fast workflow variant regression",
    column: "triage",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function createDetail(task: Task): TaskDetail {
  return {
    ...task,
    prompt: "",
    attachments: [],
    comments: [],
  } as TaskDetail;
}

function createStore(task: Task, settings: Partial<Settings> = {}, overrides: Partial<TaskStore> = {}): TaskStore {
  /*
  FNXC:EngineTests 2026-07-20-23:40:
  Finalization rewrites PROMPT hygiene under withTaskLock + readTaskForMove (FN-8361).
  Minimal mocks that omit those methods fail closed inside runIfStillPlanningUnderTaskLock
  and never reach moveTask(todo). Mirror the production lock surface so planning tests can
  finish the approve path.
  */
  let live = createDetail(task);
  const store: any = {
    getTask: vi.fn(async () => live),
    listTasks: vi.fn().mockResolvedValue([]),
    createTask: vi.fn(),
    moveTask: vi.fn(async (id: string, column: string) => {
      if (id === live.id) live = { ...live, column, status: null } as typeof live;
      return live;
    }),
    /*
    FNXC:EngineTests 2026-07-20-23:50:
    finalizeApprovedTask releases triage→todo only via moveTaskIf + planning-stage predicate
    (FN-8361 family). A bare moveTask mock never runs; implement moveTaskIf so the approve
    path can complete and tests can still assert the moveTaskIf/column outcome.
    */
    moveTaskIf: vi.fn(async (id: string, column: string, predicate: (t: Task) => boolean) => {
      if (id !== live.id || !predicate(live as Task)) return { moved: false, task: live };
      live = { ...live, column, status: null } as typeof live;
      store.moveTask(id, column);
      return { moved: true, task: live };
    }),
    updateTask: vi.fn(async (id: string, updates: Partial<Task>) => {
      if (id === live.id) live = { ...live, ...updates } as typeof live;
      return live;
    }),
    deleteTask: vi.fn(),
    mergeTask: vi.fn(),
    getSettings: vi.fn().mockResolvedValue({
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 10000,
      groupOverlappingFiles: false,
      autoMerge: true,
      ...settings,
    } as Settings),
    updateSettings: vi.fn(),
    logEntry: vi.fn().mockResolvedValue(undefined),
    appendAgentLog: vi.fn().mockResolvedValue(undefined),
    getAgentLogs: vi.fn().mockResolvedValue([]),
    addSteeringComment: vi.fn(),
    parseDependenciesFromPrompt: vi.fn().mockResolvedValue([]),
    parseStepsFromPrompt: vi.fn().mockResolvedValue([]),
    parseFileScopeFromPrompt: vi.fn().mockResolvedValue([]),
    getTaskWorkflowSelection: vi.fn().mockReturnValue({ workflowId: "builtin:coding", stepIds: [] }),
    getWorkflowDefinition: vi.fn().mockResolvedValue(undefined),
    getWorkflowSettingValues: vi.fn().mockResolvedValue({}),
    getWorkflowSettingsProjectId: vi.fn().mockReturnValue("default"),
    withTaskLock: vi.fn(async (_id: string, fn: () => Promise<unknown>) => fn()),
    readTaskForMove: vi.fn(async () => live),
    on: vi.fn(),
    emit: vi.fn(),
    ...overrides,
  };
  if (!(overrides as { withTaskLock?: unknown }).withTaskLock) {
    store.withTaskLock = vi.fn(async (_id: string, fn: () => Promise<unknown>) => fn());
  }
  if (!(overrides as { readTaskForMove?: unknown }).readTaskForMove) {
    store.readTaskForMove = vi.fn(async () => live);
  }
  return store as TaskStore;
}

function mockSession(capture: { basePrompt?: string; customTools?: any[] } = {}) {
  mockCreateFnAgent.mockImplementationOnce(async (opts: any) => {
    capture.basePrompt = opts.systemPromptLayers?.stable ?? opts.systemPrompt;
    capture.customTools = opts.customTools;
    return {
      session: {
        state: {},
        sessionManager: { getLeafId: vi.fn().mockReturnValue(null) },
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
        navigateTree: vi.fn(),
        __customTools: opts.customTools,
      },
    };
  });
}

async function captureBasePrompt(task: Task, store: TaskStore): Promise<string> {
  const capture: { basePrompt?: string } = {};
  mockSession(capture);
  mockPromptWithFallback.mockResolvedValueOnce(undefined);

  await new TriageProcessor(store, "/tmp/root").specifyTask(task);
  return capture.basePrompt ?? "";
}

async function runPlanningSession(task: Task, store: TaskStore, rootDir: string): Promise<void> {
  const capture: { customTools?: any[] } = {};
  mockSession(capture);
  /*
  FNXC:EngineTests 2026-07-22-03:20:
  Keep write-through on live task state while also materializing PROMPT.md. A prompt-only
  updateTask mock left finalize reading an empty prompt and withholds coding recovery.
  Executable Steps satisfy the recoverApprovedTask step-heading gate after U10b.
  Capture the prior mockImplementation (not bind the mock) so re-wrapping cannot recurse.
  */
  const priorUpdate = (store.updateTask as ReturnType<typeof vi.fn>).getMockImplementation?.()
    ?? (async () => undefined);
  vi.mocked(store.updateTask).mockImplementation(async (taskId, patch) => {
    const result = await priorUpdate(taskId, patch);
    if (typeof patch.prompt === "string") {
      const promptDir = join(rootDir, ".fusion", "tasks", task.id);
      await mkdir(promptDir, { recursive: true });
      await writeFile(join(promptDir, "PROMPT.md"), patch.prompt, "utf8");
    }
    return result;
  });
  mockPromptWithFallback.mockImplementationOnce(async () => {
    const promptWriter = capture.customTools?.find((tool) => tool.name === "fn_task_prompt_write");
    expect(promptWriter).toBeDefined();
    await promptWriter.execute("persist-plan", {
      content: [
        "# Task: FN-6236",
        "",
        "## Mission",
        "",
        "Verify fast policy.",
        "",
        "## Steps",
        "",
        "### Step 0: Implement",
        "- [ ] do the work",
        "",
      ].join("\n"),
    });
    await expect(readFile(join(rootDir, ".fusion", "tasks", task.id, "PROMPT.md"), "utf8"))
      .resolves.toContain("Verify fast policy");
  });

  await new TriageProcessor(store, rootDir).specifyTask(task);
}

const renderedFastPlanningPrompt = renderTriagePolicyPlaceholders(builtinSeamPrompt("planning-fast"), {});
const renderedStandardPlanningPrompt = renderTriagePolicyPlaceholders(
  resolvePlanningPromptFromIr(BUILTIN_CODING_WORKFLOW_IR)!,
  {},
);

describe("fast-mode workflow variant resolution", () => {
  let tempRoots: string[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    mockReviewStep.mockResolvedValue({ verdict: "APPROVE", summary: "ok", review: "" });
  });

  afterEach(async () => {
    await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
    tempRoots = [];
  });

  it("resolves fast tasks to the lean planning-fast workflow prompt", async () => {
    const task = createTask({ id: "FN-6236-FAST-PROMPT", executionMode: "fast" });
    const store = createStore(task);

    await expect(captureBasePrompt(task, store)).resolves.toBe(renderedFastPlanningPrompt);
  });

  it("lets a selected workflow planning-fast seam override the built-in lean prompt", async () => {
    const task = createTask({ id: "FN-6236-FAST-CUSTOM-SEAM", executionMode: "fast" });
    const customFastPrompt = "custom workflow fast planning prompt";
    const customIr: WorkflowIr = {
      version: "v1",
      name: "custom-fast-workflow",
      nodes: [{ id: "planning-fast", kind: "prompt", config: { seam: "planning-fast", prompt: customFastPrompt } }],
      edges: [],
    };
    const store = createStore(task, {}, {
      getTaskWorkflowSelection: vi.fn().mockReturnValue({ workflowId: "WF-fast", stepIds: [] }),
      getWorkflowDefinition: vi.fn().mockResolvedValue({ ir: customIr }),
    });

    await expect(captureBasePrompt(task, store)).resolves.toBe(customFastPrompt);
  });

  it("falls back to the built-in lean fast prompt when the selected workflow has no planning-fast seam", async () => {
    const task = createTask({ id: "FN-6236-FAST-NO-SEAM", executionMode: "fast" });
    const noFastSeamIr: WorkflowIr = {
      version: "v1",
      name: "no-fast-seam-workflow",
      nodes: [{ id: "planning", kind: "prompt", config: { seam: "planning", prompt: "standard-only prompt" } }],
      edges: [],
    };
    const store = createStore(task, {}, {
      getTaskWorkflowSelection: vi.fn().mockReturnValue({ workflowId: "WF-no-fast", stepIds: [] }),
      getWorkflowDefinition: vi.fn().mockResolvedValue({ ir: noFastSeamIr }),
    });

    await expect(captureBasePrompt(task, store)).resolves.toBe(renderedFastPlanningPrompt);
  });

  it("resolves standard tasks to the standard workflow planning prompt", async () => {
    const task = createTask({ id: "FN-6236-STANDARD-PROMPT", executionMode: "standard" });
    const store = createStore(task);

    const basePrompt = await captureBasePrompt(task, store);

    expect(basePrompt).toBe(renderedStandardPlanningPrompt);
    expect(basePrompt).not.toBe(renderedFastPlanningPrompt);
  });

  it("finalizes fast tasks without invoking a separate spec reviewer", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "fusion-fn-6236-fast-"));
    tempRoots.push(rootDir);
    const task = createTask({ id: "FN-6236-FAST-REVIEW", executionMode: "fast" });
    const store = createStore(task);

    await runPlanningSession(task, store, rootDir);

    expect(mockReviewStep).not.toHaveBeenCalled();
    expect(store.moveTaskIf).toHaveBeenCalledWith(task.id, "todo", expect.any(Function));
  });

  it("finalizes standard tasks without invoking a separate spec reviewer", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "fusion-fn-6236-standard-"));
    tempRoots.push(rootDir);
    const task = createTask({ id: "FN-6236-STANDARD-REVIEW", executionMode: "standard" });
    const store = createStore(task);

    await runPlanningSession(task, store, rootDir);

    expect(mockReviewStep).not.toHaveBeenCalled();
    expect(store.moveTaskIf).toHaveBeenCalledWith(task.id, "todo", expect.any(Function));
  });

  it("ignores legacy autoApproveSpec because workflow Plan Review owns approval", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "fusion-fn-6236-setting-"));
    tempRoots.push(rootDir);
    const task = createTask({ id: "FN-6236-SETTING-REVIEW", executionMode: "standard" });
    const store = createStore(task, { autoApproveSpec: true });

    await runPlanningSession(task, store, rootDir);

    expect(mockReviewStep).not.toHaveBeenCalled();
    expect(store.moveTaskIf).toHaveBeenCalledWith(task.id, "todo", expect.any(Function));
  });

  it("preserves user triage prompt override precedence over the fast variant", async () => {
    const task = createTask({ id: "FN-6236-OVERRIDE", executionMode: "fast" });
    const overridePrompt = "custom fast override prompt";
    const store = createStore(task, {
      agentPrompts: {
        templates: [{ id: "custom-triage", name: "Custom", role: "triage", prompt: overridePrompt }],
        roleAssignments: { triage: "custom-triage" },
      },
    } as Partial<Settings>);

    await expect(captureBasePrompt(task, store)).resolves.toBe(overridePrompt);
  });
});
