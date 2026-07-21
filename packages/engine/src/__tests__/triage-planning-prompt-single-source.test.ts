import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Settings, Task, TaskDetail, TaskStore, WorkflowIr } from "@fusion/core";
import {
  BUILTIN_CODING_WORKFLOW_IR,
  builtinSeamPrompt,
  renderTriagePolicyPlaceholders,
  resolveAgentPrompt,
  resolvePlanningPromptFromIr,
} from "@fusion/core";
import { buildSpecificationPrompt, TriageProcessor } from "../triage.js";

const { mockReviewStep, mockCreateFnAgent } = vi.hoisted(() => ({
  mockReviewStep: vi.fn(),
  mockCreateFnAgent: vi.fn(),
}));

vi.mock("../reviewer.js", () => ({
  reviewStep: mockReviewStep,
}));

vi.mock("../pi.js", () => {
  /*
  FNXC:EngineTests 2026-07-07-09:10:
  triage.ts specifyTask catch checks `err instanceof ModelFallbackExhaustedError` (FN-7559 planner fallback exhaustion handling) and agentWork calls `formatModelMarkerDetails`. The pi mock must expose both so the instanceof guard is callable and model-marker formatting resolves, instead of crashing happy-path specifyTask runs.
  */
  class ModelFallbackExhaustedError extends Error {}
  return {
    ModelFallbackExhaustedError,
    createFnAgent: mockCreateFnAgent,
    describeModel: vi.fn().mockReturnValue("mock-model"),
    formatModelMarkerDetails: vi.fn((model: string) => model),
    promptWithFallback: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("@fusion/core", async (importOriginal) => {
  const { createEngineCoreMock } = await import("../test/mockCore.js");
  const original = await importOriginal<typeof import("@fusion/core")>();
  return createEngineCoreMock(() => Promise.resolve(original), {
    resolveAgentPrompt: vi.fn(original.resolveAgentPrompt),
  });
});

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-6232-T",
    description: "Triage planning prompt test",
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

function createStore(task: Task, overrides: Partial<TaskStore> = {}, settings: Partial<Settings> = {}): TaskStore {
  return {
    getTask: vi.fn().mockResolvedValue(createDetail(task)),
    listTasks: vi.fn().mockResolvedValue([]),
    createTask: vi.fn(),
    moveTask: vi.fn(),
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
    logEntry: vi.fn().mockResolvedValue(undefined),
    appendAgentLog: vi.fn().mockResolvedValue(undefined),
    getAgentLogs: vi.fn().mockResolvedValue([]),
    addSteeringComment: vi.fn(),
    parseDependenciesFromPrompt: vi.fn().mockResolvedValue([]),
    parseStepsFromPrompt: vi.fn().mockResolvedValue([]),
    parseFileScopeFromPrompt: vi.fn().mockResolvedValue([]),
    getTaskWorkflowSelection: vi.fn().mockReturnValue(undefined),
    getWorkflowDefinition: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    emit: vi.fn(),
    ...overrides,
  } as unknown as TaskStore;
}

async function captureBasePrompt(task: Task, store: TaskStore): Promise<string> {
  let captured = "";
  mockCreateFnAgent.mockImplementationOnce(async (opts: any) => {
    captured = opts.systemPromptLayers?.stable ?? opts.systemPrompt;
    return {
      session: {
        state: {},
        sessionManager: { getLeafId: vi.fn().mockReturnValue(null) },
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
        navigateTree: vi.fn(),
      },
    };
  });

  await new TriageProcessor(store, "/tmp/root").specifyTask(task);
  return captured;
}

const canonicalPlanningPrompt = resolvePlanningPromptFromIr(BUILTIN_CODING_WORKFLOW_IR)!;
const renderedCanonicalPlanningPrompt = renderTriagePolicyPlaceholders(canonicalPlanningPrompt, {});
const renderedDefaultTriagePrompt = renderTriagePolicyPlaceholders(resolveAgentPrompt("triage"), {});
const renderedFastPlanningPrompt = renderTriagePolicyPlaceholders(builtinSeamPrompt("planning-fast"), {});

describe("triage planning prompt single source", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses the built-in workflow IR planning prompt in standard mode", async () => {
    const task = createTask({ id: "FN-6232-BUILTIN", executionMode: "standard" });
    const store = createStore(task, {
      getTaskWorkflowSelection: vi.fn().mockReturnValue({ workflowId: "builtin:coding", stepIds: [] }),
    });

    await expect(captureBasePrompt(task, store)).resolves.toBe(renderedCanonicalPlanningPrompt);
  });

  it("exposes the TaskStore-backed PROMPT.md writer to triage sessions", async () => {
    const task = createTask({ id: "FN-6232-PROMPT-WRITER" });
    const store = createStore(task);
    let customTools: Array<{ name?: string }> = [];
    let sessionTools: string | undefined;
    mockCreateFnAgent.mockImplementationOnce(async (opts: any) => {
      customTools = opts.customTools ?? [];
      sessionTools = opts.tools;
      return {
        session: {
          state: {},
          sessionManager: { getLeafId: vi.fn().mockReturnValue(null) },
          prompt: vi.fn().mockResolvedValue(undefined),
          dispose: vi.fn(),
          navigateTree: vi.fn(),
        },
      };
    });

    await new TriageProcessor(store, "/tmp/root").specifyTask(task);

    expect(customTools.map((tool) => tool.name)).toContain("fn_task_prompt_write");
    expect(sessionTools).toBe("readonly");
  });

  it("requires triage plans to use the durable prompt writer instead of generic filesystem writes", () => {
    const task = createDetail(createTask({ id: "FN-6232-DURABLE-PROMPT" }));
    const prompt = buildSpecificationPrompt(task, `.fusion/tasks/${task.id}/PROMPT.md`, {} as Settings);

    expect(prompt).toContain("fn_task_prompt_write");
    expect(prompt).toContain("Do not use the generic filesystem write tool");
    expect(prompt).not.toContain("Use the write tool to write the specification file");
  });

  it("uses the built-in workflow IR planning prompt when no workflow is selected", async () => {
    const task = createTask({ id: "FN-6232-NO-SELECTION", executionMode: "standard" });
    const store = createStore(task);

    await expect(captureBasePrompt(task, store)).resolves.toBe(renderedCanonicalPlanningPrompt);
  });

  it("preserves user triage prompt override precedence", async () => {
    const task = createTask({ id: "FN-6232-OVERRIDE", executionMode: "standard" });
    const overridePrompt = "custom triage override prompt";
    const store = createStore(task, {}, {
      agentPrompts: {
        templates: [{ id: "custom-triage", name: "Custom", role: "triage", prompt: overridePrompt }],
        roleAssignments: { triage: "custom-triage" },
      },
    } as Partial<Settings>);

    await expect(captureBasePrompt(task, store)).resolves.toBe(overridePrompt);
  });

  it("keeps fast mode on the planning-fast workflow prompt", async () => {
    const task = createTask({ id: "FN-6232-FAST", executionMode: "fast" });
    const store = createStore(task);

    await expect(captureBasePrompt(task, store)).resolves.toBe(renderedFastPlanningPrompt);
  });

  it("uses a selected custom workflow planning prompt", async () => {
    const task = createTask({ id: "FN-6232-CUSTOM", executionMode: "standard" });
    const customPrompt = "custom workflow planning prompt";
    const customIr: WorkflowIr = {
      version: "v1",
      name: "custom-workflow",
      nodes: [{ id: "planning", kind: "prompt", config: { seam: "planning", prompt: customPrompt } }],
      edges: [],
    };
    const store = createStore(task, {
      getTaskWorkflowSelection: vi.fn().mockReturnValue({ workflowId: "WF-custom", stepIds: [] }),
      getWorkflowDefinition: vi.fn().mockResolvedValue({ ir: customIr }),
    });

    await expect(captureBasePrompt(task, store)).resolves.toBe(customPrompt);
  });

  it("fails soft to the default triage prompt when workflow resolution cannot provide a planning prompt", async () => {
    const task = createTask({ id: "FN-6232-FAIL-SOFT", executionMode: "standard" });
    const store = createStore(task, {
      getTaskWorkflowSelection: vi.fn(() => {
        throw new Error("selection unavailable");
      }),
    });

    await expect(captureBasePrompt(task, store)).resolves.toBe(renderedDefaultTriagePrompt);
  });
});
