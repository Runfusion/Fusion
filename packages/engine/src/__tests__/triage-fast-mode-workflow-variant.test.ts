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

vi.mock("../reviewer.js", () => ({
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
  return {
    getTask: vi.fn().mockResolvedValue(createDetail(task)),
    listTasks: vi.fn().mockResolvedValue([]),
    createTask: vi.fn(),
    moveTask: vi.fn(),
    moveTaskIf: vi.fn().mockResolvedValue({ moved: true }),
    updateTask: vi.fn().mockResolvedValue(undefined),
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
    withTaskLock: vi.fn(async (_taskId, operation) => operation()),
    readTaskForMove: vi.fn().mockResolvedValue(createDetail(task)),
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
    on: vi.fn(),
    emit: vi.fn(),
    ...overrides,
  } as unknown as TaskStore;
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
  vi.mocked(store.updateTask).mockImplementation(async (_taskId, patch) => {
    if (typeof patch.prompt !== "string") return;
    const promptDir = join(rootDir, ".fusion", "tasks", task.id);
    await mkdir(promptDir, { recursive: true });
    await writeFile(join(promptDir, "PROMPT.md"), patch.prompt, "utf8");
  });
  mockPromptWithFallback.mockImplementationOnce(async () => {
    const promptWriter = capture.customTools?.find((tool) => tool.name === "fn_task_prompt_write");
    expect(promptWriter).toBeDefined();
    await promptWriter.execute("persist-plan", {
      content: "# Task: FN-6236\n\n## Mission\n\nVerify fast policy.\n",
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
