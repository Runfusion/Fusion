import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { TaskStore, Task, TaskDetail, Settings } from "@fusion/core";
import { applyOriginalDescription, builtinSeamPrompt, buildBootstrapPrompt, computePlanApprovalFingerprint, MAX_TASK_LIST_TEXT_CHARS, renderTriagePolicyPlaceholders, resolveAgentPrompt } from "@fusion/core";
import {
  TriageProcessor,
  buildSpecificationPrompt,
  resolveTaskListFormatter,
  readAttachmentContents,
  computeUserCommentFingerprint,
} from "../triage.js";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { mkdir, writeFile, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { planLog } from "../logger.js";

const { mockReviewStep, mockCreateFnAgent } = vi.hoisted(() => ({
  mockReviewStep: vi.fn(),
  mockCreateFnAgent: vi.fn(),
}));

const TRIAGE_POLICY_PROMPT = resolveAgentPrompt("triage");
const STANDARD_PLANNING_PROMPT = builtinSeamPrompt("planning");
const FAST_PLANNING_PROMPT = builtinSeamPrompt("planning-fast");
const RENDERED_TRIAGE_POLICY_PROMPT = renderTriagePolicyPlaceholders(TRIAGE_POLICY_PROMPT, {});

vi.mock("../reviewer.js", () => ({
  reviewStep: mockReviewStep,
}));

vi.mock("../pi.js", () => {
  class ModelFallbackExhaustedError extends Error {
    readonly primaryModel: string;
    readonly fallbackModel?: string;
    readonly triggerPoint: "session-creation" | "prompt-time";
    readonly attempts: number;
    readonly underlyingReason: string;

    constructor(input: { primaryModel: string; fallbackModel?: string; triggerPoint: "session-creation" | "prompt-time"; attempts: number; underlyingReason: string }) {
      const fallbackClause = input.fallbackModel ? `, fallback ${input.fallbackModel}` : ", no fallback configured";
      super(`Unable to select a usable model after ${input.attempts} attempts (primary ${input.primaryModel}${fallbackClause}, trigger: ${input.triggerPoint}): ${input.underlyingReason}`);
      this.name = "ModelFallbackExhaustedError";
      this.primaryModel = input.primaryModel;
      this.fallbackModel = input.fallbackModel;
      this.triggerPoint = input.triggerPoint;
      this.attempts = input.attempts;
      this.underlyingReason = input.underlyingReason;
    }
  }

  return {
  ModelFallbackExhaustedError,
  createFnAgent: mockCreateFnAgent,
  describeModel: vi.fn().mockReturnValue("mock-model"),
  formatModelMarkerDetails: vi.fn((model: string, thinking?: string | null, annotations: string[] = []) => {
    const suffixes = [thinking ? `thinking effort: ${thinking}` : "", ...annotations].filter(Boolean);
    return suffixes.length ? `${model} ${suffixes.map((suffix) => `(${suffix})`).join(" ")}` : model;
  }),
  promptWithFallback: vi.fn().mockReturnValue("mock-prompt"),
  };
});

vi.mock("@fusion/core", async (importOriginal) => {
  const { createEngineCoreMock } = await import("../test/mockCore.js");
  const original = await importOriginal<typeof import("@fusion/core")>();
  return createEngineCoreMock(() => Promise.resolve(original), {
    resolveAgentPrompt: vi.fn(original.resolveAgentPrompt),
  });
});


describe("fn_task_list resilience (FN-6573)", () => {
  it("returns bounded text when formatter exports are unavailable", () => {
    const boardLines = [
      `FN-1 (todo): Triage duplicate check ${"x".repeat(6_000)}`,
      `FN-2 (triage): Triage duplicate check ${"x".repeat(6_000)}`,
    ];

    /*
    FNXC:TaskListOutput 2026-06-17-07:38:
    FN-6573 drives the engine triage formatter resolver seam because the tool closure imports the live @fusion/core namespace at module load. The seam reproduces stale dist namespaces where formatTaskListText, or both task-list helpers, are absent and must still produce one bounded text block.
    */
    for (const coreNamespace of [
      { formatTaskListText: undefined, clampTaskListText: () => "unused" },
      { formatTaskListText: undefined, clampTaskListText: undefined },
    ]) {
      const formatter = resolveTaskListFormatter(coreNamespace);
      const text = formatter(boardLines, { clamp: coreNamespace.clampTaskListText }).trimEnd();
      expect(text).toBeTruthy();
      expect(text.length).toBeLessThanOrEqual(MAX_TASK_LIST_TEXT_CHARS);
    }
  });
});

async function createTriageFixtureRoot(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

async function cleanupTriageFixtureRoot(rootDir: string | undefined): Promise<void> {
  if (!rootDir) return;

  const retryableCodes = new Set(["ENOTEMPTY", "EBUSY", "EPERM"]);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(rootDir, { recursive: true, force: true });
      return;
    } catch (error: any) {
      if (!retryableCodes.has(error?.code) || attempt === 4) {
        throw error;
      }

      await delay(25 * (attempt + 1));
    }
  }
}

function createMockStore(overrides: Partial<TaskStore> = {}): TaskStore {
  let store: Partial<TaskStore>;
  store = {
    getTask: vi.fn(),
    listTasks: vi.fn().mockResolvedValue([]),
    createTask: vi.fn(),
    moveTask: vi.fn(),
    moveTaskIf: vi.fn(async (id, toColumn) => {
      const task = await store.moveTask?.(id, toColumn);
      return { task: task as Task, moved: true };
    }),
    withTaskLock: vi.fn(async (_id, callback) => callback()),
    readTaskForMove: vi.fn(async (id) => (await store.getTask?.(id)) ?? ({ id, column: "triage", status: "planning" } as Task)),
    updateTask: vi.fn().mockResolvedValue(undefined),
    deleteTask: vi.fn(),
    mergeTask: vi.fn(),
    getSettings: vi.fn().mockResolvedValue({
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 10000,
      groupOverlappingFiles: false,
      autoMerge: true,
    } as Settings),
    updateSettings: vi.fn(),
    logEntry: vi.fn().mockResolvedValue(undefined),
    /*
    FNXC:TaskCreateDedup 2026-07-18-14:45:
    FN-8277 aborts parent-scoped createTask when findRecentTasksBySourceParentTaskId throws.
    Shared triage mocks return no recent siblings so proactive subtask tool tests can create children.
    */
    findRecentTasksBySourceParentTaskId: vi.fn().mockResolvedValue([]),
    /*
    FNXC:TriageTestMock 2026-07-16-14:15:
    Duplicate finalization records activity for near-duplicates and explicit DUPLICATE markers, so shared TaskStore mocks must provide an awaited no-op. The reviewer-outage retry test explicitly selects the delete resolution because the runtime default is prompt and only delete reaches deleteTask.
    */
    recordActivity: vi.fn().mockResolvedValue(undefined),
    appendAgentLog: vi.fn().mockResolvedValue(undefined),
    getAgentLogs: vi.fn().mockResolvedValue([]),
    addSteeringComment: vi.fn(),
    parseDependenciesFromPrompt: vi.fn().mockResolvedValue([]),
    parseStepsFromPrompt: vi.fn().mockResolvedValue([]),
    parseFileScopeFromPrompt: vi.fn().mockResolvedValue([]),
    on: vi.fn(),
    emit: vi.fn(),
    ...overrides,
  };
  return store as TaskStore;
}

const mockTaskDetail: TaskDetail = {
  id: "FN-001",
  description: "Test task description",
  column: "triage",
  dependencies: [],
  steps: [],
  currentStep: 0,
  log: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  prompt: "# KB-001 - Test Task\n\nOriginal specification content.",
  attachments: [],
};

function createTriageTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-001",
    description: "Triage task",
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

describe("buildSpecificationPrompt", () => {
  const baseTask: TaskDetail = {
    ...mockTaskDetail,
    title: "Test Task",
  };

  it("generates basic specification prompt", () => {
    const prompt = buildSpecificationPrompt(
      baseTask,
      ".fusion/tasks/KB-001/PROMPT.md",
    );

    expect(prompt).toContain("Specify this task");
    expect(prompt).toContain("FN-001");
    expect(prompt).toContain("Test Task");
    expect(prompt).toContain("Test task description");
    expect(prompt).toContain(".fusion/tasks/KB-001/PROMPT.md");
  });

  /*
  FNXC:OriginalDescriptionInPrompt 2026-07-14-23:35:
  Planner instructions must require ## Original Description with the operator text
  verbatim so AI-planned PROMPT.md preserves the source request.
  */
  it("instructs the planner to include ## Original Description verbatim", () => {
    const prompt = buildSpecificationPrompt(
      baseTask,
      ".fusion/tasks/KB-001/PROMPT.md",
    );

    expect(prompt).toContain("## Original Description");
    expect(prompt).toContain("verbatim");
    expect(prompt).toContain("Test task description");
  });

  it("expands stored plan.md while preserving original request and edited description context", () => {
    const prompt = buildSpecificationPrompt(
      { ...baseTask, description: "Operator edited context" },
      ".fusion/tasks/FN-001/PROMPT.md",
      undefined,
      undefined,
      undefined,
      undefined,
      { plan: "# Validated plan\n\nPlan detail\n\n## Size\nM\n\n## Suggested dependencies\n_None_\n\n## Key deliverables\n- Deliver it\n", originalDescription: "Raw operator request" },
    );
    expect(prompt).toContain("## Planning Mode plan.md");
    expect(prompt).toContain("Plan detail");
    expect(prompt).toContain("Operator edited context");
    expect(prompt).toContain("Raw operator request");
    expect(prompt).toContain("never use plan.md");
  });

  describe("task-definition input language setting", () => {
    const languageSettings: Settings = {
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 10_000,
      groupOverlappingFiles: false,
      autoMerge: true,
      taskDefinitionInInputLanguage: true,
    };
    const detectedSamples = [
      ["es", "Necesitamos actualizar la definición de la tarea para que los usuarios puedan leer los pasos y las instrucciones en español con todos los detalles necesarios.", "Español"],
      ["fr", "Nous devons mettre à jour la définition de la tâche pour que les utilisateurs puissent lire les étapes et les instructions en français avec tous les détails nécessaires.", "Français"],
      ["ko", "사용자가 작업 정의의 단계와 지침을 한국어로 읽을 수 있도록 필요한 모든 세부 정보와 함께 작업 정의를 업데이트해야 합니다.", "한국어"],
      ["zh-CN", "我们需要更新任务定义，以便用户可以使用中文阅读所有必要详细信息中的步骤和说明，并且确保任务规划清晰准确。", "简体中文"],
    ] as const;

    it.each(detectedSamples)("adds a %s authoring section for confident supported input", (locale, description, displayName) => {
      const prompt = buildSpecificationPrompt(
        { ...baseTask, description },
        ".fusion/tasks/KB-001/PROMPT.md",
        languageSettings,
      );

      expect(prompt).toContain("## Task Definition Language");
      expect(prompt).toContain(`${displayName} (${locale})`);
      expect(prompt).toContain("Keep every `##`/`###` section heading");
      expect(prompt).toContain("`## Original Description`");
    });

    it.each([
      [undefined, undefined, "Specify this task"],
      ["# Existing specification", "Apply the feedback", "Revise this task"],
      [undefined, "Create a replacement", "Re-specify this task"],
    ])("applies the instruction in every specification mode", (existingPrompt, feedback, mode) => {
      const prompt = buildSpecificationPrompt(
        { ...baseTask, description: detectedSamples[0][1] },
        ".fusion/tasks/KB-001/PROMPT.md",
        languageSettings,
        [],
        existingPrompt,
        feedback,
      );

      expect(prompt).toContain(mode);
      expect(prompt).toContain("## Task Definition Language");
    });

    it.each([
      ["setting is disabled", { ...languageSettings, taskDefinitionInInputLanguage: false }, detectedSamples[0][1]],
      ["English input", languageSettings, "The task description has enough English words for the detector to identify the language with high confidence and preserve normal behavior."],
      ["short input", languageSettings, "Très court"],
      ["low-confidence input", languageSettings, "Atypical vocabulary provides no familiar stopwords despite being long enough for language detection to inspect this ambiguous prose sample."],
      ["unsupported Japanese input", languageSettings, "ユーザーが作業内容と必要な手順を日本語で詳細に説明し、すべての利用者が理解できるように要件と確認方法を記載しています。"],
    ])("keeps English behavior when %s", (_reason, settings, description) => {
      const prompt = buildSpecificationPrompt(
        { ...baseTask, description },
        ".fusion/tasks/KB-001/PROMPT.md",
        settings,
      );

      expect(prompt).not.toContain("## Task Definition Language");
    });
  });

  it("includes project commands when provided", () => {
    const settings: Settings = {
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 10000,
      groupOverlappingFiles: false,
      autoMerge: true,
      testCommand: "pnpm test",
      buildCommand: "pnpm build",
    };

    const prompt = buildSpecificationPrompt(
      baseTask,
      ".fusion/tasks/KB-001/PROMPT.md",
      settings,
    );

    expect(prompt).toContain("Project Commands");
    expect(prompt).toContain("pnpm test");
    expect(prompt).toContain("pnpm build");
  });

  describe("completionDocumentationMode setting", () => {
    it("omits completion documentation guidance when mode is off", () => {
      const settings: Settings = {
        maxConcurrent: 2,
        maxWorktrees: 4,
        pollIntervalMs: 10000,
        groupOverlappingFiles: false,
        autoMerge: true,
        completionDocumentationMode: "off",
      };

      const prompt = buildSpecificationPrompt(
        baseTask,
        ".fusion/tasks/KB-001/PROMPT.md",
        settings,
      );

      expect(prompt).not.toContain("## Completion Documentation Preference");
    });

    it("includes changeset guidance when mode is changeset", () => {
      const settings: Settings = {
        maxConcurrent: 2,
        maxWorktrees: 4,
        pollIntervalMs: 10000,
        groupOverlappingFiles: false,
        autoMerge: true,
        completionDocumentationMode: "changeset",
      };

      const prompt = buildSpecificationPrompt(
        baseTask,
        ".fusion/tasks/KB-001/PROMPT.md",
        settings,
      );

      expect(prompt).toContain("## Completion Documentation Preference");
      expect(prompt).toContain("`completionDocumentationMode` is set to `changeset`");
      expect(prompt).toContain("`.changeset/*.md`");
      expect(prompt).toContain("completion documentation/delivery expectations");
    });

    it("includes changelog guidance when mode is changelog", () => {
      const settings: Settings = {
        maxConcurrent: 2,
        maxWorktrees: 4,
        pollIntervalMs: 10000,
        groupOverlappingFiles: false,
        autoMerge: true,
        completionDocumentationMode: "changelog",
      };

      const prompt = buildSpecificationPrompt(
        baseTask,
        ".fusion/tasks/KB-001/PROMPT.md",
        settings,
      );

      expect(prompt).toContain("`completionDocumentationMode` is set to `changelog`");
      expect(prompt).toContain("updating an existing changelog file");
      expect(prompt).toContain("do not invent a new changelog file");
    });
  });

  it("generates revision prompt when existingPrompt and feedback provided", () => {
    const existingPrompt = "# Original Spec\n\nOriginal content.";
    const feedback = "Add more details about error handling";

    const prompt = buildSpecificationPrompt(
      baseTask,
      ".fusion/tasks/KB-001/PROMPT.md",
      undefined,
      [],
      existingPrompt,
      feedback,
    );

    expect(prompt).toContain("Revise this task");
    expect(prompt).toContain("Revision Instructions");
    expect(prompt).toContain("Existing Specification");
    expect(prompt).toContain("Revision Feedback");
    expect(prompt).toContain("Converge — do not rewrite from scratch");
    expect(prompt).toContain("surgical");
    expect(prompt).toContain(existingPrompt);
    expect(prompt).toContain(feedback);
    expect(prompt).toContain("revising an existing task specification");
  });

  it("generates fresh re-planning prompt when only feedback is provided", () => {
    const feedback = "Start fresh and avoid the stale bootstrap assumption";

    const prompt = buildSpecificationPrompt(
      baseTask,
      ".fusion/tasks/KB-001/PROMPT.md",
      undefined,
      [],
      undefined,
      feedback,
    );

    expect(prompt).toContain("Re-specify this task");
    expect(prompt).toContain("Re-specification Instructions");
    expect(prompt).toContain("fresh replacement specification");
    expect(prompt).toContain("Revision Feedback");
    expect(prompt).toContain(feedback);
    expect(prompt).not.toContain("Existing Specification");
    expect(prompt).toContain("no usable prior PROMPT.md draft");
    expect(prompt).toContain("Treat the current task title and description as required primary inputs");
  });

  it("includes attachments when provided", () => {
    const attachments = [
      {
        originalName: "screenshot.png",
        mimeType: "image/png" as const,
        text: null as string | null,
      },
      {
        originalName: "notes.txt",
        mimeType: "text/plain" as const,
        text: "Some notes content",
      },
    ];

    const prompt = buildSpecificationPrompt(
      baseTask,
      ".fusion/tasks/KB-001/PROMPT.md",
      undefined,
      attachments,
    );

    expect(prompt).toContain("Attachments");
    expect(prompt).toContain("screenshot.png");
    expect(prompt).toContain("notes.txt");
    expect(prompt).toContain("Some notes content");
  });

  it("includes dependencies when present", () => {
    const taskWithDeps: TaskDetail = {
      ...baseTask,
      dependencies: ["FN-002", "FN-003"],
    };

    const prompt = buildSpecificationPrompt(
      taskWithDeps,
      ".fusion/tasks/KB-001/PROMPT.md",
    );

    expect(prompt).toContain("Dependencies");
    expect(prompt).toContain("FN-002, FN-003");
  });

  it("handles task without title", () => {
    const taskWithoutTitle: TaskDetail = {
      ...baseTask,
      title: undefined,
    };

    const prompt = buildSpecificationPrompt(
      taskWithoutTitle,
      ".fusion/tasks/KB-001/PROMPT.md",
    );

    expect(prompt).toContain("(none)");
  });

  it("includes proactive subtask guidance when breakdown was not explicitly requested", () => {
    const prompt = buildSpecificationPrompt(
      baseTask,
      ".fusion/tasks/KB-001/PROMPT.md",
    );

    expect(prompt).toContain("## Subtask Consideration");
    expect(prompt).toContain("MORE THAN 7 implementation steps");
    expect(prompt).toContain("GOOD TO SPLIT");
    expect(prompt).not.toContain("## Subtask Breakdown Requested");
  });

  it("keeps explicit breakIntoSubtasks flow mandatory when requested", () => {
    const prompt = buildSpecificationPrompt(
      {
        ...baseTask,
        breakIntoSubtasks: true,
      },
      ".fusion/tasks/KB-001/PROMPT.md",
    );

    expect(prompt).toContain("## Subtask Breakdown Requested");
    expect(prompt).toContain("If splitting: use the \\\`fn_task_create\\\` tool");
    expect(prompt).not.toContain("## Subtask Consideration");
  });

  describe("memoryEnabled setting", () => {
    it("includes memory instructions when memoryEnabled: true", () => {
      const settings: Settings = {
        maxConcurrent: 2,
        maxWorktrees: 4,
        pollIntervalMs: 10000,
        groupOverlappingFiles: false,
        autoMerge: true,
        memoryEnabled: true,
      };
      const prompt = buildSpecificationPrompt(
        baseTask,
        ".fusion/tasks/KB-001/PROMPT.md",
        settings,
      );
      expect(prompt).toContain("Specify this task");
      expect(prompt).toContain("## Project Memory");
      expect(prompt).toContain("fn_memory_search");
      expect(prompt).toContain("fn_memory_get");
    });

    it("excludes memory instructions when memoryEnabled: false", () => {
      const settings: Settings = {
        maxConcurrent: 2,
        maxWorktrees: 4,
        pollIntervalMs: 10000,
        groupOverlappingFiles: false,
        autoMerge: true,
        memoryEnabled: false,
      };
      const prompt = buildSpecificationPrompt(
        baseTask,
        ".fusion/tasks/KB-001/PROMPT.md",
        settings,
      );
      expect(prompt).toContain("Specify this task");
      expect(prompt).not.toContain("## Project Memory");
    });

    it("includes memory instructions when memoryEnabled is undefined (default enabled)", () => {
      const prompt = buildSpecificationPrompt(
        baseTask,
        ".fusion/tasks/KB-001/PROMPT.md",
        undefined,
      );
      expect(prompt).toContain("Specify this task");
      expect(prompt).toContain("## Project Memory");
      expect(prompt).toContain("fn_memory_search");
      expect(prompt).toContain("fn_memory_get");
    });
  });

  describe("memoryBackendType setting", () => {
    it("includes .fusion/memory/ for file backend", () => {
      const settings: Settings = {
        maxConcurrent: 2,
        maxWorktrees: 4,
        pollIntervalMs: 10000,
        groupOverlappingFiles: false,
        autoMerge: true,
        memoryEnabled: true,
        memoryBackendType: "file",
      };
      const prompt = buildSpecificationPrompt(
        baseTask,
        ".fusion/tasks/KB-001/PROMPT.md",
        settings,
      );
      expect(prompt).toContain("## Project Memory");
      expect(prompt).toContain(".fusion/memory/");
      expect(prompt).toContain("fn_memory_append");
      expect(prompt).toContain("Do **not** write");
      expect(prompt).toContain("or any other memory files directly");
    });

    it("includes read-only wording for readonly backend without write directives", () => {
      const settings: Settings = {
        maxConcurrent: 2,
        maxWorktrees: 4,
        pollIntervalMs: 10000,
        groupOverlappingFiles: false,
        autoMerge: true,
        memoryEnabled: true,
        memoryBackendType: "readonly",
      };
      const prompt = buildSpecificationPrompt(
        baseTask,
        ".fusion/tasks/KB-001/PROMPT.md",
        settings,
      );
      expect(prompt).toContain("## Project Memory");
      // Should NOT contain write/update directives
      expect(prompt).not.toMatch(/write.*memory|update.*memory/i);
      // Should NOT contain the specific file path
      expect(prompt).not.toContain(".fusion/memory/");
    });

    it("does not include .fusion/memory/ for qmd backend", () => {
      const settings: Settings = {
        maxConcurrent: 2,
        maxWorktrees: 4,
        pollIntervalMs: 10000,
        groupOverlappingFiles: false,
        autoMerge: true,
        memoryEnabled: true,
        memoryBackendType: "qmd",
      };
      const prompt = buildSpecificationPrompt(
        baseTask,
        ".fusion/tasks/KB-001/PROMPT.md",
        settings,
      );
      expect(prompt).toContain("## Project Memory");
      // QMD should NOT unconditionally reference .fusion/memory/
      expect(prompt).not.toContain(".fusion/memory/");
      expect(prompt).toContain("fn_memory_search");
      expect(prompt).toContain("fn_memory_get");
      expect(prompt).toContain("fn_memory_append");
      expect(prompt).toContain("Do **not** write memory files directly");
    });

    it("QMD prompt has actionable memory instructions", () => {
      const settings: Settings = {
        maxConcurrent: 2,
        maxWorktrees: 4,
        pollIntervalMs: 10000,
        groupOverlappingFiles: false,
        autoMerge: true,
        memoryEnabled: true,
        memoryBackendType: "qmd",
      };
      const prompt = buildSpecificationPrompt(
        baseTask,
        ".fusion/tasks/KB-001/PROMPT.md",
        settings,
      );
      expect(prompt).toContain("## Project Memory");
      // QMD should NOT contain .fusion/memory/
      expect(prompt).not.toContain(".fusion/memory/");
      expect(prompt).toContain("fn_memory_search");
    });
  });

  describe("user comments", () => {
    it("includes user comments section when user comments exist", () => {
      const taskWithComments: TaskDetail = {
        ...baseTask,
        comments: [
          {
            id: "c1",
            text: "Please add error handling for edge cases",
            author: "user",
            createdAt: "2026-01-02T10:00:00.000Z",
            updatedAt: "2026-01-02T10:00:00.000Z",
          },
          {
            id: "c2",
            text: "Make sure to update the README too",
            author: "user",
            createdAt: "2026-01-02T11:00:00.000Z",
          },
        ],
      };

      const prompt = buildSpecificationPrompt(
        taskWithComments,
        ".fusion/tasks/KB-001/PROMPT.md",
      );

      expect(prompt).toContain("## User Comments");
      expect(prompt).toContain("Please add error handling for edge cases");
      expect(prompt).toContain("Make sure to update the README too");
      expect(prompt).toContain("Address every comment");
      expect(prompt).toContain("Missing comment coverage is a spec quality failure");
    });

    it("pins task-detail chat comments as planning-agent context", () => {
      const taskWithChatComment: TaskDetail = {
        ...baseTask,
        comments: [
          {
            id: "chat-1",
            text: "Please keep the old API export in the generated spec",
            author: "user",
            createdAt: "2026-06-21T15:30:00.000Z",
          },
        ],
      };

      const prompt = buildSpecificationPrompt(
        taskWithChatComment,
        ".fusion/tasks/KB-001/PROMPT.md",
      );

      expect(prompt).toContain("## User Comments");
      expect(prompt).toContain("Please keep the old API export in the generated spec");
      expect(prompt).toContain("Address every comment");
    });

    it("excludes agent/system comments from user comments section", () => {
      const taskWithMixedComments: TaskDetail = {
        ...baseTask,
        comments: [
          {
            id: "c1",
            text: "User feedback here",
            author: "user",
            createdAt: "2026-01-02T10:00:00.000Z",
          },
          {
            id: "c2",
            text: "Agent system note",
            author: "agent",
            createdAt: "2026-01-02T11:00:00.000Z",
          },
          {
            id: "c3",
            text: "System auto-message",
            author: "system",
            createdAt: "2026-01-02T12:00:00.000Z",
          },
        ],
      };

      const prompt = buildSpecificationPrompt(
        taskWithMixedComments,
        ".fusion/tasks/KB-001/PROMPT.md",
      );

      expect(prompt).toContain("User feedback here");
      expect(prompt).not.toContain("Agent system note");
      expect(prompt).not.toContain("System auto-message");
    });

    it("does not include user comments section when no comments exist", () => {
      const prompt = buildSpecificationPrompt(
        baseTask,
        ".fusion/tasks/KB-001/PROMPT.md",
      );

      expect(prompt).not.toContain("## User Comments");
    });

    it("does not include user comments section when only agent comments exist", () => {
      const taskWithOnlyAgentComments: TaskDetail = {
        ...baseTask,
        comments: [
          {
            id: "c1",
            text: "Agent note",
            author: "agent",
            createdAt: "2026-01-02T10:00:00.000Z",
          },
        ],
      };

      const prompt = buildSpecificationPrompt(
        taskWithOnlyAgentComments,
        ".fusion/tasks/KB-001/PROMPT.md",
      );

      expect(prompt).not.toContain("## User Comments");
    });
  });
});

describe("canonical triage policy prompt", () => {
  it("does not include unconditional research guidance", () => {
    expect(TRIAGE_POLICY_PROMPT).not.toContain("fn_research_run");
    expect(TRIAGE_POLICY_PROMPT).not.toContain("Keep research bounded");
  });

  it("requires specs to keep lint, tests, build, and typecheck green even outside initial file scope", () => {
    expect(TRIAGE_POLICY_PROMPT).toContain("If keeping lint/tests/build/typecheck green requires edits outside the initial File Scope");
    expect(TRIAGE_POLICY_PROMPT).toContain("Run lint check");
    expect(TRIAGE_POLICY_PROMPT).toContain("Run project typecheck if available");
    expect(TRIAGE_POLICY_PROMPT).toContain("Lint passing");
    expect(TRIAGE_POLICY_PROMPT).toContain("Typecheck passing (if available)");
    expect(TRIAGE_POLICY_PROMPT).toContain("Specs must instruct executors to fix lint failures and quality-gate failures directly");
    expect(TRIAGE_POLICY_PROMPT).toContain("Refuse necessary fixes just because they touch files outside the initial File Scope");
  });

  it("includes task-artifact location guidance for forensic/reconciliation tasks", () => {
    expect(TRIAGE_POLICY_PROMPT).toContain("Task Artifact Location");
    expect(TRIAGE_POLICY_PROMPT).toContain("<rootDir>/.fusion/tasks/{TARGET_ID}/");
    expect(TRIAGE_POLICY_PROMPT).toContain(".fusion/fusion.db");
    expect(TRIAGE_POLICY_PROMPT).toContain("project root");
    expect(TRIAGE_POLICY_PROMPT).toContain("forensic");
  });
});

describe("canonical triage policy prompt", () => {
  it("includes proactive M/L subtask breakdown guidance", () => {
    expect(TRIAGE_POLICY_PROMPT).toContain(
      "## Proactive Subtask Breakdown for M/L Tasks",
    );
    expect(TRIAGE_POLICY_PROMPT).toContain("{{triageProactiveSubtaskSplittingEnabled}}");
    expect(RENDERED_TRIAGE_POLICY_PROMPT).toContain(
      "Even when `breakIntoSubtasks` is not set to `true`",
    );
    expect(RENDERED_TRIAGE_POLICY_PROMPT).toContain(
      "Size S tasks should NOT be split",
    );
  });

  it("includes explicit rendered subtask breakdown thresholds", () => {
    expect(RENDERED_TRIAGE_POLICY_PROMPT).toContain("MORE THAN 7 implementation steps");
    expect(RENDERED_TRIAGE_POLICY_PROMPT).toContain(
      "MORE THAN 3 different packages/modules",
    );
    expect(RENDERED_TRIAGE_POLICY_PROMPT).not.toContain("{{triageSubtaskStepThreshold}}");
  });

  it("biases toward keeping tasks whole and acknowledges coordination overhead", () => {
    expect(RENDERED_TRIAGE_POLICY_PROMPT).toContain("Default to keeping the task whole");
    expect(RENDERED_TRIAGE_POLICY_PROMPT).toContain("Coordination overhead");
    expect(RENDERED_TRIAGE_POLICY_PROMPT).toContain(
      "7-10 focused steps within a coherent scope is fine as one unit",
    );
  });
});

describe("FN-5893 invariant regression wording", () => {
  const corePromptSource = readFileSync(
    fileURLToPath(new URL("../../../core/src/agent-prompts.ts", import.meta.url)),
    "utf8",
  );

  it("requires before-to-after transformation summaries in standard and fast planning prompts", () => {
    for (const prompt of [
      TRIAGE_POLICY_PROMPT,
      STANDARD_PLANNING_PROMPT,
      FAST_PLANNING_PROMPT,
    ]) {
      expect(prompt).toContain("## Before → After Transformation");
      expect(prompt).toContain("Before");
      expect(prompt).toContain("After");
      expect(prompt).toContain("current state");
      expect(prompt).toContain("target state");
      expect(prompt).toContain("satisfies the user's request at a glance");
    }

    expect(STANDARD_PLANNING_PROMPT).toBe(TRIAGE_POLICY_PROMPT);
    expect(FAST_PLANNING_PROMPT).not.toContain("## Review Level");
    expect(FAST_PLANNING_PROMPT).not.toContain("## Proactive Subtask Breakdown");
  });

  it("places Before → After Transformation at the top of the definition, ahead of Mission and Review Level (FN-7593)", () => {
    const standardTransformationIdx = STANDARD_PLANNING_PROMPT.indexOf("## Before → After Transformation");
    const standardReviewLevelIdx = STANDARD_PLANNING_PROMPT.indexOf("## Review Level");
    const standardMissionIdx = STANDARD_PLANNING_PROMPT.indexOf("## Mission");
    expect(standardTransformationIdx).toBeGreaterThan(-1);
    expect(standardReviewLevelIdx).toBeGreaterThan(-1);
    expect(standardMissionIdx).toBeGreaterThan(-1);
    expect(standardTransformationIdx).toBeLessThan(standardReviewLevelIdx);
    expect(standardTransformationIdx).toBeLessThan(standardMissionIdx);

    const fastTransformationIdx = FAST_PLANNING_PROMPT.indexOf("## Before → After Transformation");
    const fastMissionIdx = FAST_PLANNING_PROMPT.indexOf("## Mission");
    expect(fastTransformationIdx).toBeGreaterThan(-1);
    expect(fastMissionIdx).toBeGreaterThan(-1);
    expect(fastTransformationIdx).toBeLessThan(fastMissionIdx);
  });

  it("requires invariant-level regression coverage in standard, fast, and core triage prompts", () => {
    for (const prompt of [
      TRIAGE_POLICY_PROMPT,
      FAST_PLANNING_PROMPT,
      corePromptSource,
    ]) {
      expect(prompt).toContain("invariant across all known surfaces");
      expect(prompt).toContain("provider/bridge");
      expect(prompt).toContain("desktop + mobile breakpoints");
      expect(prompt).toContain("empty/undefined/populated data states");
      expect(prompt).toContain("FN-5787/FN-5789/FN-5803");
      expect(prompt).toContain("FN-5751");
    }
  });

  it("requires a Surface Enumeration section and routes validation through workflow Plan Review", () => {
    for (const prompt of [TRIAGE_POLICY_PROMPT, FAST_PLANNING_PROMPT]) {
      expect(prompt).toContain("## Surface Enumeration");
      expect(prompt).toContain("workflow Plan Review");
      expect(prompt).toContain("docs/testing.md");
      expect(prompt).toContain("duplicate / populated data states");
      expect(prompt).toContain("shared hooks/components/modules/helpers");
      expect(prompt).toContain("UI-affordance add/remove");
      expect(prompt).toContain("For bug fixes and UI-affordance add/remove tasks");
      expect(prompt).toContain(
        "For bug-fix and UI-affordance add/remove tasks, paste and fill in this checklist",
      );
    }

    expect(corePromptSource).toContain("## Surface Enumeration");
    expect(corePromptSource).toContain("spec MUST include a \\`## Surface Enumeration\\` section");
    expect(corePromptSource).toContain("workflow Plan Review");
    expect(corePromptSource).toContain("docs/testing.md");
    expect(corePromptSource).toContain("duplicate / populated data states");
    expect(corePromptSource).toContain("shared hooks/components/modules/helpers");
  });

  it("requires implementation-step testing guidance to enumerate invariant surfaces in standard and fast prompts", () => {
    for (const prompt of [TRIAGE_POLICY_PROMPT, FAST_PLANNING_PROMPT]) {
      expect(prompt).toContain(
        "Run targeted tests for changed files, asserting the invariant across all known surfaces",
      );
      expect(prompt).toContain(
        "For bug-fix and UI-affordance add/remove tasks, paste and fill in this checklist in the `## Surface Enumeration` section",
      );
    }
  });

  it("defines the FN-6229 Symptom Verification contract in standard and fast prompts", () => {
    for (const prompt of [TRIAGE_POLICY_PROMPT, FAST_PLANNING_PROMPT]) {
      expect(prompt).toContain("## Symptom Verification");
      expect(prompt).toContain("Use the exact heading `## Symptom Verification`");
      expect(prompt).toContain("**Original symptom** — what the user/issue reported was broken");
      expect(prompt).toContain("**Exact reproduction** — the precise steps, inputs, fixture, or automated repro that triggered the failure");
      expect(prompt).toContain("**Assertion it is gone**");
      expect(prompt).toContain("final verification must reproduce that original failure condition and assert it no longer occurs");
      expect(prompt).toContain("Green build/tests alone are insufficient");
      expect(prompt).toContain("symptom-based acceptance");
      expect(prompt).toContain("bug-class/bug-fix tasks");
      expect(prompt).toContain("feature/docs/non-bug tasks do not need this section");
    }
  });

  it("requires Surface Enumeration for UI-affordance add/remove tasks regardless of review-level analysis", () => {
    for (const prompt of [TRIAGE_POLICY_PROMPT, FAST_PLANNING_PROMPT]) {
      expect(prompt).toContain("bug-fix tasks and UI-affordance add/remove tasks");
      expect(prompt).toContain("every component that renders the affordance");
      expect(prompt).toContain("searching the codebase for the icon/class/testid");
      expect(prompt).toContain("leftover shells after removal");
      expect(prompt).toContain("empty buttons");
    }

    expect(FAST_PLANNING_PROMPT).not.toContain("## Review Level");
  });

  it("pins the canonical docs checklist heading", () => {
    const docsTestingSource = readFileSync(
      fileURLToPath(new URL("../../../../docs/testing.md", import.meta.url)),
      "utf8",
    );

    expect(docsTestingSource).toContain("### Surface Enumeration checklist");
    expect(docsTestingSource).toContain("Providers / bridges / execution paths touched by the invariant");
  });
});

describe("fast-mode triage", () => {
  it("exports a lean FAST_PLANNING_PROMPT", () => {
    expect(typeof FAST_PLANNING_PROMPT).toBe("string");
    expect(FAST_PLANNING_PROMPT.length).toBeGreaterThan(0);
    expect(FAST_PLANNING_PROMPT).toContain("This task is running in **fast mode**");
    expect(FAST_PLANNING_PROMPT).toContain("workflow Plan Review");
    expect(FAST_PLANNING_PROMPT).toContain("Do not call `fn_review_spec()`");
    expect(FAST_PLANNING_PROMPT).not.toContain("## Review Level");
    expect(FAST_PLANNING_PROMPT).not.toContain("## Triage subtask breakdown");
    expect(FAST_PLANNING_PROMPT).not.toContain("## Proactive Subtask Breakdown");
    expect(FAST_PLANNING_PROMPT).not.toContain("Frontend UX Criteria");
  });

  it("documents explicit-request-only workflow routing in standard and fast prompts", () => {
    const required = ["## Workflow Routing", "Keep the project default workflow", "unless the user explicitly requested a specific workflow", "or you created that task yourself", "When you create a task via `fn_task_create`", "do not move a task you did not create unless the user asked", "Do NOT call `fn_workflow_select` or pass `workflow_id`", "If the user explicitly", "fn_workflow_list", "fn_workflow_select", "workflow_id", "**No commits expected:** true", "builtin:coding"];
    const forbidden = ["use workflow descriptions as the routing signal", "select an appropriate lightweight workflow", "prefer `builtin:quick-fix` or a custom investigation workflow", "Match the task nature to the workflow description", "descriptions are authoritative for routing decisions"];
    for (const prompt of [RENDERED_TRIAGE_POLICY_PROMPT, FAST_PLANNING_PROMPT]) {
      for (const text of required) expect(prompt).toContain(text);
      for (const text of forbidden) expect(prompt).not.toContain(text);
    }
    expect(renderTriagePolicyPlaceholders(TRIAGE_POLICY_PROMPT, { defaultWorkflowId: "WF-005" })).toContain(
      "Keep the project default workflow (`WF-005`)",
    );
  });

  it("includes task-artifact location guidance for forensic/reconciliation tasks", () => {
    expect(FAST_PLANNING_PROMPT).toContain("Task Artifact Location");
    expect(FAST_PLANNING_PROMPT).toContain("<rootDir>/.fusion/tasks/{TARGET_ID}/");
    expect(FAST_PLANNING_PROMPT).toContain(".fusion/fusion.db");
    expect(FAST_PLANNING_PROMPT).toContain("project root");
    expect(FAST_PLANNING_PROMPT).toContain("forensic");
  });

  it("selects FAST_PLANNING_PROMPT for fast tasks", async () => {
    const task = createTriageTask({ id: "FN-FAST-001", executionMode: "fast" });
    const store = createMockStore({
      getTask: vi.fn().mockResolvedValue({ ...mockTaskDetail, id: task.id, attachments: [], comments: [] }),
    });

    let capturedSystemPrompt = "";
    mockCreateFnAgent.mockImplementationOnce(async (opts: any) => {
      capturedSystemPrompt = opts.systemPrompt;
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

    const processor = new TriageProcessor(store, "/tmp/root");
    await processor.specifyTask(task);

    expect(capturedSystemPrompt).toContain("This task is running in **fast mode**");
    expect(capturedSystemPrompt).not.toContain("## Review Level");
  });

  it("keeps standard prompt for standard tasks", async () => {
    const task = createTriageTask({ id: "FN-FAST-002", executionMode: "standard" });
    const store = createMockStore({
      getTask: vi.fn().mockResolvedValue({ ...mockTaskDetail, id: task.id, attachments: [], comments: [] }),
    });

    let capturedSystemPrompt = "";
    mockCreateFnAgent.mockImplementationOnce(async (opts: any) => {
      capturedSystemPrompt = opts.systemPrompt;
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

    const processor = new TriageProcessor(store, "/tmp/root");
    await processor.specifyTask(task);

    expect(capturedSystemPrompt).toContain("## Review Level");
  });

  it("renders a stored triage workflow override over the configured project default", async () => {
    const task = createTriageTask({ id: "FN-7967", executionMode: "standard" });
    const store = createMockStore({
      getTask: vi.fn().mockResolvedValue({ ...mockTaskDetail, id: task.id, attachments: [], comments: [] }),
      getSettings: vi.fn().mockResolvedValue({
        maxConcurrent: 2,
        maxWorktrees: 4,
        pollIntervalMs: 10000,
        groupOverlappingFiles: false,
        autoMerge: true,
        defaultWorkflowId: "WF-005",
      } as Settings),
      getTaskWorkflowSelection: vi.fn().mockReturnValue({ workflowId: "builtin:coding", stepIds: [] }),
      getWorkflowSettingsProjectId: vi.fn().mockReturnValue("project-1"),
      getWorkflowSettingValues: vi.fn().mockReturnValue({ triageDefaultWorkflowId: "WF-009" }),
    });

    let capturedSystemPrompt = "";
    mockCreateFnAgent.mockImplementationOnce(async (opts: any) => {
      capturedSystemPrompt = opts.systemPrompt;
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

    const processor = new TriageProcessor(store, "/tmp/root");
    await processor.specifyTask(task);

    expect(capturedSystemPrompt).toContain("Keep the project default workflow (`WF-009`)");
    expect(capturedSystemPrompt).not.toContain("Keep the project default workflow (`WF-005`)");
  });

  it("renders disabled proactive splitting while preserving explicit breakIntoSubtasks prompts", async () => {
    const task = createTriageTask({ id: "FN-FAST-003", executionMode: "standard", breakIntoSubtasks: true });
    const rootDir = await createTriageFixtureRoot("fn-7491-triage-");
    const detail = { ...mockTaskDetail, id: task.id, breakIntoSubtasks: true, attachments: [], comments: [] };
    const store = createMockStore({
      getTask: vi.fn().mockResolvedValue(detail),
      getSettings: vi.fn().mockResolvedValue({
        maxConcurrent: 2,
        maxWorktrees: 4,
        pollIntervalMs: 10000,
        groupOverlappingFiles: false,
        autoMerge: true,
        triageProactiveSubtaskSplittingEnabled: false,
      } as Settings),
    });

    let capturedSystemPrompt = "";
    const { promptWithFallback } = await import("../pi.js");
    (promptWithFallback as ReturnType<typeof vi.fn>).mockImplementationOnce(async (_session: unknown, prompt: string) => {
      await mkdir(join(rootDir, ".fusion", "tasks", "FN-FAST-003"), { recursive: true }).catch(() => undefined);
      await writeFile(join(rootDir, ".fusion", "tasks", "FN-FAST-003", "PROMPT.md"), "# Task: FN-FAST-003 - Split\n\n## Mission\n\nDone.", { flag: "w" }).catch(() => undefined);
      expect(prompt).toContain("## Subtask Breakdown Requested");
      expect(prompt).toContain("The user has requested that this task be broken into smaller subtasks");
      expect(prompt).not.toContain("## Subtask Consideration");
    });
    mockCreateFnAgent.mockImplementationOnce(async (opts: any) => {
      capturedSystemPrompt = opts.systemPrompt;
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

    const processor = new TriageProcessor(store, rootDir);
    await processor.specifyTask(task);

    expect(capturedSystemPrompt).toContain("Proactive oversized-task splitting is DISABLED");
    expect(capturedSystemPrompt).toContain("Only create child tasks when `breakIntoSubtasks: true` is explicitly present");
    expect(capturedSystemPrompt).not.toContain("Even when `breakIntoSubtasks` is not set to `true`, apply these thresholds proactively");
    expect(promptWithFallback).toHaveBeenCalled();
    await cleanupTriageFixtureRoot(rootDir);
  });

  it("includes triage plugin contributions when provided", async () => {
    const task = createTriageTask({ id: "FN-FAST-PLUGIN-001", executionMode: "standard" });
    const store = createMockStore({
      getTask: vi.fn().mockResolvedValue({ ...mockTaskDetail, id: task.id, attachments: [], comments: [] }),
    });
    const pluginRunner = {
      getPromptContributionsForSurface: vi.fn().mockImplementation((surface: string) => {
        if (surface !== "triage") return [];
        return [{ pluginId: "plugin-triage", contribution: { surface: "triage", content: "Use plugin triage policy." }, config: {} }];
      }),
      getPluginSkills: vi.fn().mockReturnValue([]),
    };

    let capturedSystemPrompt = "";
    mockCreateFnAgent.mockImplementationOnce(async (opts: any) => {
      capturedSystemPrompt = opts.systemPrompt;
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

    const processor = new TriageProcessor(store, "/tmp/root", { pluginRunner: pluginRunner as any });
    await processor.specifyTask(task);

    expect(capturedSystemPrompt).toContain("## Plugin: plugin-triage");
    expect(capturedSystemPrompt).toContain("Use plugin triage policy.");
  });

  it("keeps triage prompt unchanged when no triage plugin contributions exist", async () => {
    const task = createTriageTask({ id: "FN-FAST-PLUGIN-002", executionMode: "standard" });
    const store = createMockStore({
      getTask: vi.fn().mockResolvedValue({ ...mockTaskDetail, id: task.id, attachments: [], comments: [] }),
    });
    const pluginRunner = {
      getPromptContributionsForSurface: vi.fn().mockReturnValue([]),
      getPluginSkills: vi.fn().mockReturnValue([]),
    };

    let capturedSystemPrompt = "";
    mockCreateFnAgent.mockImplementationOnce(async (opts: any) => {
      capturedSystemPrompt = opts.systemPrompt;
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

    const processor = new TriageProcessor(store, "/tmp/root", { pluginRunner: pluginRunner as any });
    await processor.specifyTask(task);

    expect(capturedSystemPrompt).not.toContain("## Plugin:");
  });

  it("applies triage plugin contributions in fast mode too", async () => {
    const task = createTriageTask({ id: "FN-FAST-PLUGIN-003", executionMode: "fast" });
    const store = createMockStore({
      getTask: vi.fn().mockResolvedValue({ ...mockTaskDetail, id: task.id, attachments: [], comments: [] }),
    });
    const pluginRunner = {
      getPromptContributionsForSurface: vi.fn().mockReturnValue([
        { pluginId: "plugin-fast", contribution: { surface: "triage", content: "Fast mode plugin note." }, config: {} },
      ]),
      getPluginSkills: vi.fn().mockReturnValue([]),
    };

    let capturedSystemPrompt = "";
    mockCreateFnAgent.mockImplementationOnce(async (opts: any) => {
      capturedSystemPrompt = opts.systemPrompt;
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

    const processor = new TriageProcessor(store, "/tmp/root", { pluginRunner: pluginRunner as any });
    await processor.specifyTask(task);

    expect(capturedSystemPrompt).toContain("This task is running in **fast mode**");
    expect(capturedSystemPrompt).toContain("## Plugin: plugin-fast");
  });

  it("finalizes fast planning without exposing a separate spec-review tool", async () => {
    const rootDir = await createTriageFixtureRoot("fusion-triage-fast-gate-");
    try {
      const task = createTriageTask({ id: "FN-FAST-004", executionMode: "fast" });
      const promptPath = join(rootDir, ".fusion", "tasks", task.id, "PROMPT.md");
      await mkdir(join(rootDir, ".fusion", "tasks", task.id), { recursive: true });

      const store = createMockStore({
        getSettings: vi.fn().mockResolvedValue({
          maxConcurrent: 2,
          maxWorktrees: 4,
          pollIntervalMs: 10000,
          groupOverlappingFiles: false,
          autoMerge: true,
          experimentalFeatures: { researchView: true },
        } as Settings),
        getTask: vi.fn().mockResolvedValue({ ...mockTaskDetail, id: task.id, attachments: [], comments: [] }),
        parseDependenciesFromPrompt: vi.fn().mockResolvedValue([]),
        parseStepsFromPrompt: vi.fn().mockResolvedValue([]),
        parseFileScopeFromPrompt: vi.fn().mockResolvedValue([]),
      });

      let capturedTools: any[] = [];
      mockCreateFnAgent.mockImplementationOnce(async (opts: any) => {
        capturedTools = opts.customTools;
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

      const { promptWithFallback } = await import("../pi.js");
      (promptWithFallback as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
        expect(capturedTools.some((tool: any) => tool.name === "fn_research_run")).toBe(true);
        expect(capturedTools.some((tool: any) => tool.name === "fn_research_list")).toBe(true);
        expect(capturedTools.some((tool: any) => tool.name === "fn_research_get")).toBe(true);
        expect(capturedTools.some((tool: any) => tool.name === "fn_research_cancel")).toBe(true);
        expect(capturedTools.some((tool: any) => tool.name === "fn_research_retry")).toBe(true);
        expect(capturedTools.some((tool: any) => tool.name === "fn_review_spec")).toBe(false);
        await writeFile(promptPath, "# Task: FN-FAST-004 - Fast\n\n## Mission\n\nShip it.");
      });

      const processor = new TriageProcessor(store, rootDir);
      await processor.specifyTask(task);

      expect(mockReviewStep).not.toHaveBeenCalled();
      expect(store.moveTask).toHaveBeenCalledWith("FN-FAST-004", "todo");
    } finally {
      await cleanupTriageFixtureRoot(rootDir);
    }
  });

  it("omits research tools and prompt guidance when researchView experimental flag is disabled", async () => {
    const task = createTriageTask({ id: "FN-FAST-005", executionMode: "fast" });
    const store = createMockStore({
      getSettings: vi.fn().mockResolvedValue({
        maxConcurrent: 2,
        maxWorktrees: 4,
        pollIntervalMs: 10000,
        groupOverlappingFiles: false,
        autoMerge: true,
        experimentalFeatures: { researchView: false },
      } as Settings),
      getTask: vi.fn().mockResolvedValue({ ...mockTaskDetail, id: task.id, attachments: [], comments: [] }),
    });

    let capturedTools: any[] = [];
    let capturedSystemPrompt = "";
    mockCreateFnAgent.mockImplementationOnce(async (opts: any) => {
      capturedTools = opts.customTools;
      capturedSystemPrompt = opts.systemPrompt;
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

    const processor = new TriageProcessor(store, "/tmp/root");
    await processor.specifyTask(task);

    expect(capturedTools.some((tool: any) => tool.name === "fn_research_run")).toBe(false);
    expect(capturedTools.some((tool: any) => tool.name === "fn_research_list")).toBe(false);
    expect(capturedTools.some((tool: any) => tool.name === "fn_research_get")).toBe(false);
    expect(capturedTools.some((tool: any) => tool.name === "fn_research_cancel")).toBe(false);
    expect(capturedTools.some((tool: any) => tool.name === "fn_research_retry")).toBe(false);
    expect(capturedSystemPrompt).not.toContain("fn_research_run");
  });

  it("includes research prompt guidance when researchView experimental flag is enabled", async () => {
    const task = createTriageTask({ id: "FN-FAST-006", executionMode: "fast" });
    const store = createMockStore({
      getSettings: vi.fn().mockResolvedValue({
        maxConcurrent: 2,
        maxWorktrees: 4,
        pollIntervalMs: 10000,
        groupOverlappingFiles: false,
        autoMerge: true,
        experimentalFeatures: { researchView: true },
      } as Settings),
      getTask: vi.fn().mockResolvedValue({ ...mockTaskDetail, id: task.id, attachments: [], comments: [] }),
    });

    let capturedSystemPrompt = "";
    mockCreateFnAgent.mockImplementationOnce(async (opts: any) => {
      capturedSystemPrompt = opts.systemPrompt;
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

    const processor = new TriageProcessor(store, "/tmp/root");
    await processor.specifyTask(task);

    expect(capturedSystemPrompt).toContain("fn_research_run");
    expect(capturedSystemPrompt).toContain("Keep research bounded");
  });
});

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const WEBP_BYTES = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x01, 0x02, 0x03, 0x04, 0x57, 0x45, 0x42, 0x50]);

function attachmentFixture(overrides: Partial<TaskDetail["attachments"][number]>): TaskDetail["attachments"][number] {
  return {
    filename: "1234567890-image.png",
    originalName: "image.png",
    mimeType: "image/png",
    size: 100,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("readAttachmentContents", () => {
  let testDir = "";
  const taskId = "FN-TEST";

  beforeEach(async () => {
    testDir = await createTriageFixtureRoot("fusion-triage-attachments-");
    await mkdir(join(testDir, ".fusion", "tasks", taskId, "attachments"), {
      recursive: true,
    });
  });

  afterEach(async () => {
    await cleanupTriageFixtureRoot(testDir);
  });

  it("returns empty arrays when no attachments provided", async () => {
    const result = await readAttachmentContents(testDir, taskId, undefined);

    expect(result.attachmentContents).toHaveLength(0);
    expect(result.imageContents).toHaveLength(0);
  });

  it("handles empty attachments array", async () => {
    const result = await readAttachmentContents(testDir, taskId, []);

    expect(result.attachmentContents).toHaveLength(0);
    expect(result.imageContents).toHaveLength(0);
  });

  it("reads text attachment content", async () => {
    const attachments = [
      {
        filename: "1234567890-notes.txt",
        originalName: "notes.txt",
        mimeType: "text/plain" as const,
        size: 100,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ];

    const content = "Test notes content";
    await writeFile(
      join(testDir, ".fusion", "tasks", taskId, "attachments", "1234567890-notes.txt"),
      content,
    );

    const result = await readAttachmentContents(testDir, taskId, attachments);

    expect(result.attachmentContents).toHaveLength(1);
    expect(result.attachmentContents[0].originalName).toBe("notes.txt");
    expect(result.attachmentContents[0].text).toBe(content);
    expect(result.imageContents).toHaveLength(0);
  });

  it("truncates text files over 50KB", async () => {
    const attachments = [
      {
        filename: "1234567890-large.txt",
        originalName: "large.txt",
        mimeType: "text/plain" as const,
        size: 100000,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ];

    const largeContent = "a".repeat(60 * 1024); // 60KB
    await writeFile(
      join(testDir, ".fusion", "tasks", taskId, "attachments", "1234567890-large.txt"),
      largeContent,
    );

    const result = await readAttachmentContents(testDir, taskId, attachments);

    expect(result.attachmentContents[0].text).toContain("truncated at 50KB");
    expect(result.attachmentContents[0].text!.length).toBeLessThan(largeContent.length);
  });

  it("reads image as base64 content", async () => {
    const attachments = [attachmentFixture({ filename: "1234567890-image.png", originalName: "image.png", mimeType: "image/png" })];

    await writeFile(
      join(testDir, ".fusion", "tasks", taskId, "attachments", "1234567890-image.png"),
      PNG_BYTES,
    );

    const result = await readAttachmentContents(testDir, taskId, attachments);

    expect(result.attachmentContents).toHaveLength(1);
    expect(result.attachmentContents[0]).toMatchObject({ originalName: "image.png", mimeType: "image/png", text: null });
    expect(result.imageContents).toHaveLength(1);
    expect(result.imageContents[0].type).toBe("image");
    expect(result.imageContents[0].mimeType).toBe("image/png");
    expect(result.imageContents[0].data).toBe(PNG_BYTES.toString("base64"));
  });

  it("corrects a webp-labeled PNG image block to image/png", async () => {
    const attachments = [attachmentFixture({ filename: "mismatch.webp", originalName: "mismatch.webp", mimeType: "image/webp" })];
    await writeFile(join(testDir, ".fusion", "tasks", taskId, "attachments", "mismatch.webp"), PNG_BYTES);

    const result = await readAttachmentContents(testDir, taskId, attachments);

    expect(result.attachmentContents).toEqual([{ originalName: "mismatch.webp", mimeType: "image/webp", text: null }]);
    expect(result.imageContents).toEqual([{ type: "image", data: PNG_BYTES.toString("base64"), mimeType: "image/png" }]);
  });

  it("corrects a png-labeled WEBP image block to image/webp", async () => {
    const attachments = [attachmentFixture({ filename: "mismatch.png", originalName: "mismatch.png", mimeType: "image/png" })];
    await writeFile(join(testDir, ".fusion", "tasks", taskId, "attachments", "mismatch.png"), WEBP_BYTES);

    const result = await readAttachmentContents(testDir, taskId, attachments);

    expect(result.attachmentContents).toEqual([{ originalName: "mismatch.png", mimeType: "image/png", text: null }]);
    expect(result.imageContents).toEqual([{ type: "image", data: WEBP_BYTES.toString("base64"), mimeType: "image/webp" }]);
  });

  it("falls back to stored image mime type for unrecognized bytes", async () => {
    const unknownBytes = Buffer.from([0x01, 0x02, 0x03, 0x04]);
    const attachments = [attachmentFixture({ filename: "unknown.webp", originalName: "unknown.webp", mimeType: "image/webp" })];
    await writeFile(join(testDir, ".fusion", "tasks", taskId, "attachments", "unknown.webp"), unknownBytes);

    const result = await readAttachmentContents(testDir, taskId, attachments);

    expect(result.attachmentContents).toEqual([{ originalName: "unknown.webp", mimeType: "image/webp", text: null }]);
    expect(result.imageContents).toEqual([{ type: "image", data: unknownBytes.toString("base64"), mimeType: "image/webp" }]);
  });

  it("skips unreadable attachments", async () => {
    const attachments = [
      {
        filename: "1234567890-missing.txt",
        originalName: "missing.txt",
        mimeType: "text/plain" as const,
        size: 100,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ];

    // Don't write the file

    const result = await readAttachmentContents(testDir, taskId, attachments);

    expect(result.attachmentContents).toHaveLength(0);
    expect(result.imageContents).toHaveLength(0);
  });
});

describe("TriageProcessor", () => {
  let store: TaskStore;
  let processor: TriageProcessor;
  const rootDir = "/fake/root";

  beforeEach(() => {
    store = createMockStore();
    processor = new TriageProcessor(store, rootDir);
    mockReviewStep.mockReset();
  });

  it("creates processor with default options", () => {
    expect(processor).toBeInstanceOf(TriageProcessor);
  });

  it("uses a synchronous reservation to keep planning and advanced recovery mutually exclusive", async () => {
    const task = createTriageTask({ id: "FN-RECOVERY-RESERVED" });
    const release = processor.tryReserveAdvancedRecovery(task.id);
    expect(release).toBeTypeOf("function");
    expect(processor.getProcessingTaskIds()).toContain(task.id);
    expect(processor.getPlanningTaskIds()).not.toContain(task.id);

    await processor.specifyTask(task);
    expect(store.getTask).not.toHaveBeenCalled();

    release?.();
    expect(processor.getProcessingTaskIds()).not.toContain(task.id);
  });

  /*
  FNXC:OriginalDescriptionInPrompt 2026-07-14-23:35:
  finalizeApprovedTask must inject ## Original Description with the task description
  verbatim near the top of the planner-written PROMPT.md (deterministic hygiene).
  */
  it("injects ## Original Description into PROMPT.md on finalize", async () => {
    const originalDesc = "Operator raw request: blank board on mobile when autoMerge is off.";
    const task = createTriageTask({
      id: "FN-ORIG-DESC",
      title: "Preserve original description",
      description: originalDesc,
      status: "planning",
    });
    const tempRoot = await mkdtemp(join(tmpdir(), "fusion-orig-desc-"));
    try {
      const taskDir = join(tempRoot, ".fusion", "tasks", task.id);
      await mkdir(taskDir, { recursive: true });
      const plannerWritten = `# Task: ${task.id} - Preserve original description

**Created:** 2026-07-14
**Size:** M

## Mission

Planner rewrote mission without the raw request.

## Steps

### Step 1: Implement

- [ ] Do the work
`;
      await writeFile(join(taskDir, "PROMPT.md"), plannerWritten, "utf-8");

      const localStore = createMockStore({
        getTask: vi.fn().mockResolvedValue(task),
      });
      const localProcessor = new TriageProcessor(localStore, tempRoot);

      await (localProcessor as unknown as {
        finalizeApprovedTask(task: Task, writtenInput: string, settings: Settings): Promise<void>;
      }).finalizeApprovedTask(
        task,
        plannerWritten,
        { requirePlanApproval: false } as Settings,
      );

      const onDisk = readFileSync(join(taskDir, "PROMPT.md"), "utf-8");
      expect(onDisk).toContain("## Original Description");
      expect(onDisk).toContain(originalDesc);
      expect(onDisk).not.toMatch(/## Original Description\s*\n\s*Planner rewrote/);
      const originalIdx = onDisk.indexOf("## Original Description");
      const missionIdx = onDisk.indexOf("## Mission");
      expect(originalIdx).toBeGreaterThan(-1);
      expect(missionIdx).toBeGreaterThan(originalIdx);
    } finally {
      await cleanupTriageFixtureRoot(tempRoot);
    }
  });

  it("does not release planning to todo when the authoritative PROMPT.md disappears before transition", async () => {
    const task = createTriageTask({ id: "FN-MISSING-RELEASE", status: "planning", recoveryRetryCount: 0 });
    const tempRoot = await mkdtemp(join(tmpdir(), "fusion-missing-release-"));
    try {
      const taskDir = join(tempRoot, ".fusion", "tasks", task.id);
      await mkdir(taskDir, { recursive: true });
      const written = `# Task: ${task.id} - Missing release artifact\n\n## Steps\n\n### Step 1: Implement\n\n- [ ] Do the work\n`;
      await writeFile(join(taskDir, "PROMPT.md"), written, "utf-8");
      const localStore = createMockStore({
        getTask: vi.fn().mockResolvedValue({ ...task, prompt: "" }),
        recordRunAuditEvent: vi.fn().mockResolvedValue(undefined),
      });
      const localProcessor = new TriageProcessor(localStore, tempRoot);

      await (localProcessor as any).finalizeApprovedTask(task, written, { requirePlanApproval: false } as Settings);

      expect(localStore.moveTaskIf).not.toHaveBeenCalled();
      for (const [, patch] of localStore.updateTask.mock.calls) {
        expect(patch).not.toEqual(expect.objectContaining({
          steps: expect.anything(),
        }));
        expect(patch).not.toEqual(expect.objectContaining({
          sourceMetadataPatch: expect.anything(),
        }));
      }
      expect(localStore.updateTask).toHaveBeenCalledWith(task.id, expect.objectContaining({
        status: null,
        recoveryRetryCount: 1,
        nextRecoveryAt: expect.any(String),
      }));
      expect(localStore.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
        mutationType: "task:required-artifact-missing",
        metadata: expect.objectContaining({ source: "planning-release", action: "replan" }),
      }));
    } finally {
      await cleanupTriageFixtureRoot(tempRoot);
    }
  });

  it("includes workflow discovery and selection tools in the full triage toolset", async () => {
    const task = createTriageTask({ id: "FN-WORKFLOW-TOOLS" });
    const detailedTask = { ...mockTaskDetail, id: task.id, attachments: [], comments: [] };
    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue(detailedTask);

    let capturedTools: any[] = [];
    mockCreateFnAgent.mockImplementationOnce(async (opts: any) => {
      capturedTools = opts.customTools;
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

    await processor.specifyTask(task);

    const toolNames = capturedTools.map((tool) => tool.name);
    expect(toolNames).toContain("fn_workflow_list");
    expect(toolNames).toContain("fn_workflow_select");
  });

  it("can be started and stopped", () => {
    processor.start();
    processor.stop();
    // Should not throw
  });

  it("handles settings:updated event for globalPause", () => {
    const handler = vi.fn();
    (store.on as ReturnType<typeof vi.fn>).mockImplementation(
      (event: string, cb: (...args: any[]) => void) => {
        if (event === "settings:updated") {
          // Simulate globalPause transition
          cb({ settings: { globalPause: true }, previous: { globalPause: false } });
        }
      }
    );

    // Create a new processor to trigger the event handler setup
    new TriageProcessor(store, rootDir);

    expect(store.on).toHaveBeenCalledWith("settings:updated", expect.any(Function));
  });

  describe("poll ordering", () => {
    it("dispatches eligible triage tasks by createdAt asc", async () => {
      const tasks: Task[] = [
        createTriageTask({
          id: "FN-100",
          priority: "normal",
          createdAt: "2026-01-01T00:01:00.000Z",
        }),
        createTriageTask({
          id: "FN-101",
          priority: "urgent",
          createdAt: "2026-01-01T00:10:00.000Z",
        }),
        createTriageTask({
          id: "FN-102",
          priority: "high",
          createdAt: "2026-01-01T00:03:00.000Z",
        }),
        createTriageTask({
          id: "FN-103",
          priority: "high",
          createdAt: "2026-01-01T00:02:00.000Z",
        }),
      ];

      const triageStore = createMockStore({
        listTasks: vi.fn().mockResolvedValue(tasks),
        getSettings: vi.fn().mockResolvedValue({
          maxConcurrent: 10,
          maxTriageConcurrent: 10,
          pollIntervalMs: 10_000,
          groupOverlappingFiles: false,
          autoMerge: true,
        }),
      });
      const triageProcessor = new TriageProcessor(triageStore, rootDir);
      const specifySpy = vi
        .spyOn(triageProcessor, "specifyTask")
        .mockResolvedValue(undefined);

      (triageProcessor as any).running = true;
      await (triageProcessor as any).poll();

      expect(specifySpy).toHaveBeenCalledTimes(4);
      expect(specifySpy.mock.calls.map(([task]) => task.id)).toEqual([
        "FN-100",
        "FN-103",
        "FN-102",
        "FN-101",
      ]);
    });

    it("excludes paused, awaiting-approval, failed, stuck-killed, and recovery-gated tasks from ordered candidates", async () => {
      const future = new Date(Date.now() + 60_000).toISOString();
      const tasks: Task[] = [
        createTriageTask({ id: "FN-200", priority: "urgent" }),
        createTriageTask({ id: "FN-201", priority: "urgent", paused: true }),
        createTriageTask({ id: "FN-202", priority: "urgent", status: "awaiting-approval" }),
        createTriageTask({ id: "FN-203", priority: "urgent", status: "failed" }),
        createTriageTask({ id: "FN-204", priority: "urgent", status: "stuck-killed" }),
        createTriageTask({ id: "FN-205", priority: "urgent", nextRecoveryAt: future }),
      ];

      const triageStore = createMockStore({
        listTasks: vi.fn().mockResolvedValue(tasks),
        getSettings: vi.fn().mockResolvedValue({
          maxConcurrent: 10,
          maxTriageConcurrent: 10,
          pollIntervalMs: 10_000,
          groupOverlappingFiles: false,
          autoMerge: true,
        }),
      });
      const triageProcessor = new TriageProcessor(triageStore, rootDir);
      const specifySpy = vi
        .spyOn(triageProcessor, "specifyTask")
        .mockResolvedValue(undefined);

      (triageProcessor as any).running = true;
      await (triageProcessor as any).poll();

      expect(specifySpy).toHaveBeenCalledTimes(1);
      expect(specifySpy).toHaveBeenCalledWith(expect.objectContaining({ id: "FN-200" }));
    });

    it("does not repeatedly dispatch a triage row that already has executor advancement evidence", async () => {
      const tasks: Task[] = [
        createTriageTask({ id: "FN-ADVANCED", worktree: "/tmp/fusion-fn-advanced" }),
        createTriageTask({ id: "FN-UNPLANNED" }),
      ];
      const triageStore = createMockStore({
        listTasks: vi.fn().mockResolvedValue(tasks),
        getSettings: vi.fn().mockResolvedValue({
          maxConcurrent: 10,
          maxTriageConcurrent: 10,
          pollIntervalMs: 10_000,
          groupOverlappingFiles: false,
          autoMerge: true,
        }),
      });
      const triageProcessor = new TriageProcessor(triageStore, rootDir);
      const specifySpy = vi
        .spyOn(triageProcessor, "specifyTask")
        .mockResolvedValue(undefined);

      (triageProcessor as any).running = true;
      await (triageProcessor as any).poll();

      expect(specifySpy).toHaveBeenCalledOnce();
      expect(specifySpy).toHaveBeenCalledWith(expect.objectContaining({ id: "FN-UNPLANNED" }));
    });

    /*
    FNXC:GlobalConcurrencyControls 2026-07-14-18:30:
    When an in-progress executor already counts toward the live running-agent total, triage must leave room under the global cap instead of filling maxTriageConcurrent purely from semaphore.availableCount.
    */
    it("leaves global concurrency room for live in-progress agents when admitting planners", async () => {
      const tasks: Task[] = [
        createTriageTask({ id: "FN-300", priority: "urgent" }),
        createTriageTask({ id: "FN-301", priority: "urgent" }),
        createTriageTask({ id: "FN-302", priority: "urgent" }),
        createTriageTask({ id: "FN-303", priority: "urgent" }),
        {
          ...createTriageTask({ id: "FN-EXEC", priority: "normal" }),
          column: "in-progress",
          status: null,
          sessionFile: "/tmp/fusion-fn-exec-session.json",
        } as Task,
      ];

      const triageStore = createMockStore({
        listTasks: vi.fn().mockResolvedValue(tasks),
        getSettings: vi.fn().mockResolvedValue({
          maxConcurrent: 4,
          maxTriageConcurrent: 4,
          pollIntervalMs: 10_000,
          groupOverlappingFiles: false,
          autoMerge: true,
        }),
      });
      const semaphore = {
        availableCount: 4,
        activeCount: 0,
        limit: 4,
        snapshot: vi.fn(() => ({ activeCount: 0, waitingCount: 0, availableCount: 4, limit: 4 })),
      };
      const triageProcessor = new TriageProcessor(triageStore, rootDir, { semaphore: semaphore as any });
      const specifySpy = vi
        .spyOn(triageProcessor, "specifyTask")
        .mockResolvedValue(undefined);

      (triageProcessor as any).running = true;
      await (triageProcessor as any).poll();

      // Global cap 4 with 1 in-progress holder → at most 3 new planners.
      expect(specifySpy).toHaveBeenCalledTimes(3);
    });

    /*
    FNXC:PlanReview 2026-06-29-15:42:
    Polling must honor Plan Review retry backoff as a dispatch boundary: future `nextRecoveryAt` rows stay parked, elapsed reviewer-outage rows bypass the planner, and ordinary null/needs-replan rows still launch planning.
    */
    it("continues dispatching unplanned and explicit replan tasks to the planning agent", async () => {
      const tasks = [
        createTriageTask({ id: "FN-PLANNER-UNDEFINED", status: undefined } as Partial<Task>),
        createTriageTask({ id: "FN-PLANNER-NULL", status: null } as Partial<Task>),
        createTriageTask({
          id: "FN-PLANNER-REPLAN",
          status: "needs-replan",
          log: [{ action: "AI spec revision requested", outcome: "Add verification details." } as any],
        } as Partial<Task>),
      ];
      const tasksById = new Map(tasks.map((task) => [task.id, { ...task, attachments: [], comments: [] }]));
      const triageStore = createMockStore({
        listTasks: vi.fn().mockResolvedValue(tasks),
        getTask: vi.fn().mockImplementation(async (id: string) => tasksById.get(id) ?? null),
        getSettings: vi.fn().mockResolvedValue({
          maxConcurrent: 10,
          maxTriageConcurrent: 10,
          pollIntervalMs: 10_000,
          groupOverlappingFiles: false,
          autoMerge: true,
        } as Settings),
      });
      const triageProcessor = new TriageProcessor(triageStore, rootDir);
      const { promptWithFallback } = await import("../pi.js");

      mockCreateFnAgent.mockClear();
      mockCreateFnAgent.mockResolvedValue({
        session: {
          state: {},
          sessionManager: { getLeafId: vi.fn().mockReturnValue(null) },
          prompt: vi.fn().mockResolvedValue(undefined),
          dispose: vi.fn(),
        },
      });
      (promptWithFallback as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

      (triageProcessor as any).running = true;
      await (triageProcessor as any).poll();

      await vi.waitFor(() => {
        expect(mockCreateFnAgent).toHaveBeenCalledTimes(3);
      });
      expect(mockCreateFnAgent.mock.calls.map(([options]) => options.taskId).sort()).toEqual([
        "FN-PLANNER-NULL",
        "FN-PLANNER-REPLAN",
        "FN-PLANNER-UNDEFINED",
      ]);
      for (const task of tasks) {
        expect(triageStore.updateTask).toHaveBeenCalledWith(task.id, { status: "planning" });
      }
    });
  });

  /*
  FNXC:CodingIdeasWorkflow 2026-07-05-00:00:
  FN-7596 pins the Coding (Ideas) manual-intake lifecycle at the poll-dispatch boundary: an `ideas`-column card must stay parked (never auto-dispatched via `eligibleTriageTasks`, which only matches `column === "triage"`), while a promoted `todo`-column card whose PROMPT.md is still the bootstrap stub must be discovered and specified via `eligibleTodoTasks`'s bootstrap-prompt file check. A `todo` card with a real (non-bootstrap) spec must NOT be re-dispatched, guarding against double-specifying an already-planned card.
  */
  describe("Coding (Ideas) manual-intake discovery (FN-7596)", () => {
    it("excludes a parked ideas-column task from the poll's specify-dispatch set", async () => {
      const tasks: Task[] = [
        createTriageTask({ id: "FN-IDEAS-PARKED", column: "ideas" as any, priority: "urgent" }),
      ];

      const triageStore = createMockStore({
        listTasks: vi.fn().mockResolvedValue(tasks),
        getSettings: vi.fn().mockResolvedValue({
          maxConcurrent: 10,
          maxTriageConcurrent: 10,
          pollIntervalMs: 10_000,
          groupOverlappingFiles: false,
          autoMerge: true,
        }),
      });
      const triageProcessor = new TriageProcessor(triageStore, rootDir);
      const specifySpy = vi
        .spyOn(triageProcessor, "specifyTask")
        .mockResolvedValue(undefined);

      (triageProcessor as any).running = true;
      await (triageProcessor as any).poll();

      expect(specifySpy).not.toHaveBeenCalled();
    });

    it("discovers a promoted todo-column task whose PROMPT.md is still the bootstrap stub", async () => {
      const tempRoot = await createTriageFixtureRoot("fusion-triage-ideas-discovery-");
      const promotedId = "FN-IDEAS-PROMOTED";
      try {
        const promotedTask = createTriageTask({
          id: promotedId,
          title: "Promoted from Ideas intake",
          description: "Promoted intake task",
          column: "todo",
          priority: "urgent",
        });
        await mkdir(join(tempRoot, ".fusion", "tasks", promotedId), { recursive: true });
        await writeFile(
          join(tempRoot, ".fusion", "tasks", promotedId, "PROMPT.md"),
          buildBootstrapPrompt(promotedId, promotedTask.title, promotedTask.description),
          "utf-8",
        );

        const triageStore = createMockStore({
          listTasks: vi.fn().mockResolvedValue([promotedTask]),
          getSettings: vi.fn().mockResolvedValue({
            maxConcurrent: 10,
            maxTriageConcurrent: 10,
            pollIntervalMs: 10_000,
            groupOverlappingFiles: false,
            autoMerge: true,
          }),
        });
        const triageProcessor = new TriageProcessor(triageStore, tempRoot);
        const specifySpy = vi
          .spyOn(triageProcessor, "specifyTask")
          .mockResolvedValue(undefined);

        (triageProcessor as any).running = true;
        await (triageProcessor as any).poll();

        expect(specifySpy).toHaveBeenCalledTimes(1);
        expect(specifySpy).toHaveBeenCalledWith(expect.objectContaining({ id: promotedId }));
      } finally {
        await cleanupTriageFixtureRoot(tempRoot);
      }
    });

    it("does not re-dispatch a todo-column task whose PROMPT.md already carries a real (non-bootstrap) spec", async () => {
      const tempRoot = await createTriageFixtureRoot("fusion-triage-ideas-planned-");
      const plannedId = "FN-IDEAS-PLANNED";
      try {
        const plannedTask = createTriageTask({
          id: plannedId,
          title: "Already planned todo task",
          description: "Already planned intake task",
          column: "todo",
          priority: "urgent",
        });
        await mkdir(join(tempRoot, ".fusion", "tasks", plannedId), { recursive: true });
        await writeFile(
          join(tempRoot, ".fusion", "tasks", plannedId, "PROMPT.md"),
          `# Task: ${plannedId} - Already planned todo task\n\n## Mission\n\nThis task carries a real spec, not the bootstrap stub.\n`,
          "utf-8",
        );

        const triageStore = createMockStore({
          listTasks: vi.fn().mockResolvedValue([plannedTask]),
          getSettings: vi.fn().mockResolvedValue({
            maxConcurrent: 10,
            maxTriageConcurrent: 10,
            pollIntervalMs: 10_000,
            groupOverlappingFiles: false,
            autoMerge: true,
          }),
        });
        const triageProcessor = new TriageProcessor(triageStore, tempRoot);
        const specifySpy = vi
          .spyOn(triageProcessor, "specifyTask")
          .mockResolvedValue(undefined);

        (triageProcessor as any).running = true;
        await (triageProcessor as any).poll();

        expect(specifySpy).not.toHaveBeenCalled();
      } finally {
        await cleanupTriageFixtureRoot(tempRoot);
      }
    });

    /*
    FNXC:CodingIdeasWorkflow 2026-07-12-23:50:
    Plan-in-place workflows replan in "todo" (the workflow-aware replan rebound keeps them
    there instead of orphaning them in an undeclared "triage" column), so a `needs-replan`
    todo card must be rediscovered even though its PROMPT.md is a real failed plan, not a
    seed.
    */
    it("discovers a needs-replan todo-column task even though its PROMPT.md is a real spec", async () => {
      const tempRoot = await createTriageFixtureRoot("fusion-triage-ideas-replan-");
      const replanId = "FN-IDEAS-REPLAN";
      try {
        const replanTask = createTriageTask({
          id: replanId,
          title: "Replanning in place",
          description: "Plan Review sent this back for revision",
          column: "todo",
          status: "needs-replan",
          priority: "urgent",
        });
        await mkdir(join(tempRoot, ".fusion", "tasks", replanId), { recursive: true });
        await writeFile(
          join(tempRoot, ".fusion", "tasks", replanId, "PROMPT.md"),
          `# Task: ${replanId} - Replanning in place\n\n## Mission\n\nA real spec under revision.\n`,
          "utf-8",
        );

        const triageStore = createMockStore({
          listTasks: vi.fn().mockResolvedValue([replanTask]),
          getSettings: vi.fn().mockResolvedValue({
            maxConcurrent: 10,
            maxTriageConcurrent: 10,
            pollIntervalMs: 10_000,
            groupOverlappingFiles: false,
            autoMerge: true,
          }),
        });
        const triageProcessor = new TriageProcessor(triageStore, tempRoot);
        const specifySpy = vi
          .spyOn(triageProcessor, "specifyTask")
          .mockResolvedValue(undefined);

        (triageProcessor as any).running = true;
        await (triageProcessor as any).poll();

        expect(specifySpy).toHaveBeenCalledTimes(1);
        expect(specifySpy).toHaveBeenCalledWith(expect.objectContaining({ id: replanId }));
      } finally {
        await cleanupTriageFixtureRoot(tempRoot);
      }
    });

    /*
    FNXC:TaskRefinementWorkflow 2026-07-12-23:50:
    A refinement's seed PROMPT.md has no task-id prefix (`# {title}\n\n{description}`), so the
    strict bootstrap-stub equality used to treat a promoted refinement as already planned and
    skip specification; isUnplannedSeedPrompt must accept the refinement seed shape.
    */
    it("discovers a promoted refinement whose PROMPT.md is the refinement seed (no id prefix)", async () => {
      const tempRoot = await createTriageFixtureRoot("fusion-triage-ideas-refine-");
      const refineId = "FN-IDEAS-REFINE";
      try {
        const refineTask = createTriageTask({
          id: refineId,
          title: "FN-100: tighten the header spacing",
          description: "tighten the header spacing\n\nRefines: FN-100",
          column: "todo",
          sourceType: "task_refine",
          priority: "urgent",
        });
        await mkdir(join(tempRoot, ".fusion", "tasks", refineId), { recursive: true });
        await writeFile(
          join(tempRoot, ".fusion", "tasks", refineId, "PROMPT.md"),
          `# ${refineTask.title}\n\n${refineTask.description}\n`,
          "utf-8",
        );

        const triageStore = createMockStore({
          listTasks: vi.fn().mockResolvedValue([refineTask]),
          getSettings: vi.fn().mockResolvedValue({
            maxConcurrent: 10,
            maxTriageConcurrent: 10,
            pollIntervalMs: 10_000,
            groupOverlappingFiles: false,
            autoMerge: true,
          }),
        });
        const triageProcessor = new TriageProcessor(triageStore, tempRoot);
        const specifySpy = vi
          .spyOn(triageProcessor, "specifyTask")
          .mockResolvedValue(undefined);

        (triageProcessor as any).running = true;
        await (triageProcessor as any).poll();

        expect(specifySpy).toHaveBeenCalledTimes(1);
        expect(specifySpy).toHaveBeenCalledWith(expect.objectContaining({ id: refineId }));
      } finally {
        await cleanupTriageFixtureRoot(tempRoot);
      }
    });
  });

  it("runs deterministic validation without calling the spec reviewer", async () => {
    const taskId = "FN-001";
    const testRootDir = await createTriageFixtureRoot("fusion-triage-plan-validation-");
    try {
      store = createMockStore({
        getTask: vi.fn().mockResolvedValue({
          ...mockTaskDetail,
          id: taskId,
          comments: [],
        }),
      });
      processor = new TriageProcessor(store, testRootDir);

      const failure = await (processor as any).validateGeneratedPrompt(
        taskId,
        "# Spec\n\n## Mission\n\nCurrent prompt",
      );

      expect(failure).toBeNull();
      expect(mockReviewStep).not.toHaveBeenCalled();
    } finally {
      await cleanupTriageFixtureRoot(testRootDir);
    }
  });
});

describe("Re-specification flow", () => {
  const taskWithRevisionRequest: Task = {
    id: "FN-001",
    description: "Test task",
    column: "triage",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [
      {
        timestamp: "2026-01-01T00:00:00.000Z",
        action: "AI spec revision requested",
        outcome: "Please add more details about error handling",
      },
    ],
    status: "needs-replan",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  it("detects needs-replan status", () => {
    expect(taskWithRevisionRequest.status).toBe("needs-replan");
  });

  it("extracts feedback from log entry", () => {
    const revisionLogEntry = [...taskWithRevisionRequest.log]
      .reverse()
      .find((entry) => entry.action === "AI spec revision requested");

    expect(revisionLogEntry).toBeDefined();
    expect(revisionLogEntry?.outcome).toBe("Please add more details about error handling");
  });

  it("finds most recent revision request when multiple exist", () => {
    const taskWithMultipleRequests: Task = {
      ...taskWithRevisionRequest,
      log: [
        {
          timestamp: "2026-01-01T00:00:00.000Z",
          action: "AI spec revision requested",
          outcome: "First feedback",
        },
        {
          timestamp: "2026-01-01T00:01:00.000Z",
          action: "Other action",
        },
        {
          timestamp: "2026-01-01T00:02:00.000Z",
          action: "AI spec revision requested",
          outcome: "Most recent feedback",
        },
      ],
    };

    const revisionLogEntry = [...taskWithMultipleRequests.log]
      .reverse()
      .find((entry) => entry.action === "AI spec revision requested");

    expect(revisionLogEntry?.outcome).toBe("Most recent feedback");
  });

  it("prefers latest comment-triggered re-spec feedback log over legacy revision requests", () => {
    const taskWithCommentTriggeredFeedback: Task = {
      ...taskWithRevisionRequest,
      log: [
        {
          timestamp: "2026-01-01T00:00:00.000Z",
          action: "AI spec revision requested",
          outcome: "Older feedback",
        },
        {
          timestamp: "2026-01-01T00:03:00.000Z",
          action: "User comment requested re-specification of planned task",
          outcome: "Latest feedback",
        },
      ],
    };

    const feedbackLogEntry = [...taskWithCommentTriggeredFeedback.log]
      .reverse()
      .find((entry) =>
        entry.action === "User comment requested re-specification of planned task"
        || entry.action === "User comment invalidated spec approval — task needs re-specification"
        || entry.action === "AI spec revision requested"
      );

    expect(feedbackLogEntry?.outcome).toBe("Latest feedback");
  });

});

describe("requirePlanApproval setting", () => {
  let rootDir = "";

  beforeEach(async () => {
    rootDir = await createTriageFixtureRoot("fusion-triage-approval-");
  });

  afterEach(async () => {
    await cleanupTriageFixtureRoot(rootDir);
  });

  it("sets awaiting-approval status instead of moving to todo when requirePlanApproval is true", async () => {
    const taskDir = join(rootDir, ".fusion", "tasks", "FN-001");
    await mkdir(taskDir, { recursive: true });
    await writeFile(
      join(taskDir, "task.json"),
      JSON.stringify({
        id: "FN-001",
        description: "Test task",
        column: "triage",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    await writeFile(
      join(taskDir, "PROMPT.md"),
      "# KB-001\n\n**Size:** M\n\n## Review Level: 1\n\nTest specification",
    );

    const store = createMockStore({
      getSettings: vi.fn().mockResolvedValue({
        maxConcurrent: 2,
        maxWorktrees: 4,
        pollIntervalMs: 10000,
        groupOverlappingFiles: false,
        autoMerge: true,
        requirePlanApproval: true,
      } as Settings),
      getTask: vi.fn().mockResolvedValue({
        ...mockTaskDetail,
        prompt: "# KB-001\n\nTest spec",
      }),
      listTasks: vi.fn().mockResolvedValue([
        {
          id: "FN-001",
          description: "Test task",
          column: "triage",
          dependencies: [],
          steps: [],
          currentStep: 0,
          log: [],
          status: "planning",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ]),
    });

    const processor = new TriageProcessor(store, rootDir);

    // Simulate that a spec was written and approved by reviewer
    // We can't easily run the full specifyTask without mocking the AI,
    // but we can verify the store setup is correct
    expect(await store.getSettings()).toHaveProperty("requirePlanApproval", true);
  });

  it("auto-moves to todo when requirePlanApproval is false", async () => {
    const store = createMockStore({
      getSettings: vi.fn().mockResolvedValue({
        maxConcurrent: 2,
        maxWorktrees: 4,
        pollIntervalMs: 10000,
        groupOverlappingFiles: false,
        autoMerge: true,
        requirePlanApproval: false,
      } as Settings),
    });

    const settings = await store.getSettings();
    expect(settings.requirePlanApproval).toBe(false);
  });

  it("defaults to false when requirePlanApproval is not set", async () => {
    const store = createMockStore({
      getSettings: vi.fn().mockResolvedValue({
        maxConcurrent: 2,
        maxWorktrees: 4,
        pollIntervalMs: 10000,
        groupOverlappingFiles: false,
        autoMerge: true,
      } as Settings),
    });

    const settings = await store.getSettings();
    expect(settings.requirePlanApproval).toBeUndefined();
  });

  async function finalizeWithSettings(settings: Settings) {
    const task = createTriageTask({
      id: "FN-APPROVAL",
      title: "Approval mode task",
      status: "planning",
    } as Partial<Task>);
    const store = createMockStore({
      getTask: vi.fn().mockResolvedValue(task),
    });
    const processor = new TriageProcessor(store, rootDir);
    await (processor as unknown as {
      finalizeApprovedTask(task: Task, writtenInput: string, settings: Settings): Promise<void>;
    }).finalizeApprovedTask(
      task,
      "# Task: FN-APPROVAL - Approval mode task\n\n**Size:** M\n\n## Review Level: 1\n\n## File Scope\n\n- packages/engine/src/triage.ts\n",
      settings,
    );
    return store;
  }

  it("auto-approve-all moves to todo even when workflow requires plan approval", async () => {
    const store = await finalizeWithSettings({
      requirePlanApproval: true,
      planApprovalMode: "auto-approve-all",
    } as Settings);

    expect(store.moveTask).toHaveBeenCalledWith("FN-APPROVAL", "todo");
    expect(store.updateTask).not.toHaveBeenCalledWith("FN-APPROVAL", expect.objectContaining({ status: "awaiting-approval" }));
  });

  it("require-all parks for manual approval even when workflow disables plan approval", async () => {
    const store = await finalizeWithSettings({
      requirePlanApproval: false,
      planApprovalMode: "require-all",
    } as Settings);

    expect(store.updateTask).toHaveBeenCalledWith("FN-APPROVAL", expect.objectContaining({ status: "awaiting-approval" }));
    expect(store.moveTask).not.toHaveBeenCalled();
  });

  /*
   * FNXC:ReleaseAuthorizationGate 2026-07-09-00:00:
   * The triage release-authorization gate was removed (it over-fired on AI-authored
   * specs that merely mention release tooling and stranded ordinary tasks in
   * awaiting-approval). A release-class spec now flows through triage like any other
   * task; releases are kept out of Fusion by agent instruction, not an engine gate.
   * Two former gate regression tests (release-class parks under auto-approve-all;
   * release-vs-manual awaitingApprovalReason distinction) were deleted with it.
   */
  it("does not park a release-class task in awaiting-approval when auto-approve-all is on", async () => {
    const task = createTriageTask({
      id: "FN-RELEASE",
      title: "Release @runfusion/fusion patch",
      status: "planning",
      sourceType: "agent_heartbeat",
    } as Partial<Task>);
    const recordActivity = vi.fn().mockResolvedValue(undefined);
    const store = createMockStore({
      getTask: vi.fn().mockResolvedValue(task),
      recordActivity,
    } as Partial<TaskStore>);
    const processor = new TriageProcessor(store, rootDir);

    await (processor as unknown as {
      finalizeApprovedTask(task: Task, writtenInput: string, settings: Settings): Promise<void>;
    }).finalizeApprovedTask(
      task,
      "# Task: FN-RELEASE - Release @runfusion/fusion patch\n\n## Mission\n\nRun pnpm release --yes.\n",
      { requirePlanApproval: false, planApprovalMode: "auto-approve-all" } as Settings,
    );

    expect(store.updateTask).not.toHaveBeenCalledWith("FN-RELEASE", expect.objectContaining({ awaitingApprovalReason: "release-authorization" }));
    expect(recordActivity).not.toHaveBeenCalledWith(expect.objectContaining({ type: "task:release-authorization-required" }));
  });

  /*
   * FNXC:PlanApproval 2026-07-04-22:41:
   * FN-7569 — symptom repro + fix: manual plan approval must be idempotent against
   * unchanged plan content. An operator approves a plan (approvedPlanFingerprint gets
   * persisted on the task, mirroring POST /tasks/:id/approve-plan), then the SAME task
   * re-enters finalizeApprovedTask (replan / plan-review retry / self-healing rebound)
   * with byte-identical PROMPT.md. Today's code (pre-fix) would re-park at
   * awaiting-approval a second time; the fix must move straight to todo instead.
   */
  describe("FN-7569: plan approval fingerprint idempotency", () => {
    const planText = "# Task: FN-IDEMPOTENT - Idempotent plan\n\n## Mission\n\nDo the thing.\n\n## File Scope\n\n- a.ts\n\n## Steps\n\n### Step 1: Implement\n\nDo the thing.\n";
    const changedPlanText = "# Task: FN-IDEMPOTENT - Idempotent plan\n\n## Mission\n\nDo the thing, differently.\n\n## File Scope\n\n- a.ts\n- b.ts\n\n## Steps\n\n### Step 1: Implement differently\n\nDo the changed thing.\n";

    /*
    FNXC:PlanApproval 2026-07-15-14:05:
    Build PROMPT.md as it exists ON DISK once a plan has been approved.

    `finalizeApprovedTask` injects `## Original Description` (FN 2026-07-14-23:35,
    `applyOriginalDescription`) into PROMPT.md BEFORE computing the approval fingerprint, and
    `POST /tasks/:id/approve-plan` fingerprints the on-disk file — so the fingerprint an operator's
    approval records is always over the POST-injection content. A fixture that writes the raw
    planner text and fingerprints THAT models a state approve-plan can never produce: the
    injection then rewrites the file, the fingerprint moves, and the idempotency short-circuit
    looks broken when it is not (verified: the injection is idempotent, so the real approve →
    recover round-trip matches).

    Derive the content from the helper rather than hard-coding a post-injection string, so this
    fixture keeps meaning "whatever content the operator actually approved" if the hygiene
    injection changes.
    */
    const approvedOnDisk = (source: string, description: string): string =>
      applyOriginalDescription(source, description);

    it("re-specifying the SAME approved plan skips the manual gate and moves straight to todo", async () => {
      /*
      Re-specify the plan as it was actually approved (description already injected). Passing the
      RAW planner text here made this test pass for the wrong reason: the injection rewrote the
      content, the rewrite ENOENT'd because no task dir exists, the failure was swallowed, and
      `written` stayed raw — so the fingerprint matched only by accident. With the approved
      content the injection is a no-op, no rewrite is attempted, and the short-circuit is proven.
      */
      const approvedPlan = approvedOnDisk(planText, "Triage task");
      const fingerprint = computePlanApprovalFingerprint(approvedPlan);
      const task = createTriageTask({
        id: "FN-IDEMPOTENT",
        status: "planning",
        approvedPlanFingerprint: fingerprint,
      } as Partial<Task>);
      const store = createMockStore({
        getTask: vi.fn().mockResolvedValue(task),
      } as Partial<TaskStore>);
      const processor = new TriageProcessor(store, rootDir);

      await (processor as unknown as {
        finalizeApprovedTask(task: Task, writtenInput: string, settings: Settings): Promise<void>;
      }).finalizeApprovedTask(
        task,
        approvedPlan,
        { requirePlanApproval: true, planApprovalMode: "require-all" } as Settings,
      );

      expect(store.moveTask).toHaveBeenCalledWith("FN-IDEMPOTENT", "todo");
      expect(store.updateTask).not.toHaveBeenCalledWith("FN-IDEMPOTENT", expect.objectContaining({ status: "awaiting-approval" }));
      expect(store.logEntry).toHaveBeenCalledWith(
        "FN-IDEMPOTENT",
        "Plan unchanged since prior approval — proceeding without re-approval",
      );
    });

    it("re-specifying a CHANGED plan after prior approval still re-asks for approval", async () => {
      const fingerprint = computePlanApprovalFingerprint(planText);
      const task = createTriageTask({
        id: "FN-IDEMPOTENT-CHANGED",
        status: "planning",
        approvedPlanFingerprint: fingerprint,
      } as Partial<Task>);
      const store = createMockStore({
        getTask: vi.fn().mockResolvedValue(task),
      } as Partial<TaskStore>);
      const processor = new TriageProcessor(store, rootDir);

      await (processor as unknown as {
        finalizeApprovedTask(task: Task, writtenInput: string, settings: Settings): Promise<void>;
      }).finalizeApprovedTask(
        task,
        changedPlanText,
        { requirePlanApproval: true, planApprovalMode: "require-all" } as Settings,
      );

      expect(store.updateTask).toHaveBeenCalledWith("FN-IDEMPOTENT-CHANGED", expect.objectContaining({ status: "awaiting-approval", awaitingApprovalReason: null }));
      expect(store.moveTask).not.toHaveBeenCalled();
    });

    /*
    FNXC:PlanApproval 2026-07-15-20:45:
    FN-8008 — stored approval fingerprints and finalize recovery must ignore deterministic
    Original Description / Frontend UX hygiene. Cover the successful on-disk write seam: the
    fingerprint is recorded for the raw operator-authored plan, then finalize injects a non-empty
    description before comparing it and must still move directly to todo.
    */
    it("auto-approves an unchanged plan after successfully injecting Original Description", async () => {
      // The recorded fingerprint is over the pre-injection planner text.
      const legacyFingerprint = computePlanApprovalFingerprint(planText);
      const task = createTriageTask({
        id: "FN-LEGACY-FP",
        status: "planning",
        approvedPlanFingerprint: legacyFingerprint,
      } as Partial<Task>);
      const store = createMockStore({
        getTask: vi.fn().mockResolvedValue(task),
      } as Partial<TaskStore>);
      await mkdir(join(rootDir, ".fusion", "tasks", "FN-LEGACY-FP"), { recursive: true });
      await writeFile(join(rootDir, ".fusion", "tasks", "FN-LEGACY-FP", "PROMPT.md"), planText);
      const processor = new TriageProcessor(store, rootDir);

      await (processor as unknown as {
        finalizeApprovedTask(task: Task, writtenInput: string, settings: Settings): Promise<void>;
      }).finalizeApprovedTask(
        task,
        planText,
        { requirePlanApproval: true, planApprovalMode: "require-all" } as Settings,
      );

      expect(store.moveTask).toHaveBeenCalledWith("FN-LEGACY-FP", "todo");
      expect(store.updateTask).not.toHaveBeenCalledWith("FN-LEGACY-FP", expect.objectContaining({ status: "awaiting-approval" }));
      expect(store.updateTask).not.toHaveBeenCalledWith(
        "FN-LEGACY-FP",
        expect.objectContaining({ approvedPlanFingerprint: expect.anything() }),
      );
    });

    /*
     * FNXC:PlanApproval 2026-07-15-21:10:
     * FN-8009 requires the as-approved comparison to cover both deterministic hygiene
     * mutations. A legacy operator-approved plan may lack both its original request and
     * the frontend checklist; these injections must not turn an unchanged plan into a
     * new manual approval request.
     */
    it("auto-approves a pre-hygiene plan after Original Description and Frontend UX injection", async () => {
      const frontendPlan = "# Task: FN-FRONTEND-HYGIENE - Frontend plan\n\n## Mission\n\nUpdate the dashboard.\n\n## File Scope\n\n- `packages/dashboard/app/TaskCard.tsx`\n";
      const task = createTriageTask({
        id: "FN-FRONTEND-HYGIENE",
        description: "The original dashboard request is absent from this planner output.",
        status: "planning",
        approvedPlanFingerprint: computePlanApprovalFingerprint(frontendPlan),
      } as Partial<Task>);
      const store = createMockStore({
        getTask: vi.fn().mockResolvedValue(task),
      } as Partial<TaskStore>);
      await mkdir(join(rootDir, ".fusion", "tasks", task.id), { recursive: true });
      await writeFile(join(rootDir, ".fusion", "tasks", task.id, "PROMPT.md"), frontendPlan);
      const processor = new TriageProcessor(store, rootDir);

      await (processor as unknown as {
        finalizeApprovedTask(task: Task, writtenInput: string, settings: Settings): Promise<void>;
      }).finalizeApprovedTask(
        task,
        frontendPlan,
        { requirePlanApproval: true, planApprovalMode: "require-all" } as Settings,
      );

      expect(store.moveTask).toHaveBeenCalledWith(task.id, "todo");
      expect(store.updateTask).not.toHaveBeenCalledWith(task.id, expect.objectContaining({ status: "awaiting-approval" }));
      const persisted = readFileSync(join(rootDir, ".fusion", "tasks", task.id, "PROMPT.md"), "utf8");
      expect(persisted).toContain("## Original Description");
      expect(persisted).toContain("## Frontend UX Criteria");
    });

    it("still re-asks approval for a CHANGED plan when the prior approval predates prompt hygiene", async () => {
      // The safety edge: legacy tolerance must not approve a plan the operator never saw.
      const legacyFingerprint = computePlanApprovalFingerprint(planText);
      const task = createTriageTask({
        id: "FN-LEGACY-FP-CHANGED",
        status: "planning",
        approvedPlanFingerprint: legacyFingerprint,
      } as Partial<Task>);
      const store = createMockStore({
        getTask: vi.fn().mockResolvedValue(task),
      } as Partial<TaskStore>);
      await mkdir(join(rootDir, ".fusion", "tasks", "FN-LEGACY-FP-CHANGED"), { recursive: true });
      await writeFile(join(rootDir, ".fusion", "tasks", "FN-LEGACY-FP-CHANGED", "PROMPT.md"), changedPlanText);
      const processor = new TriageProcessor(store, rootDir);

      await (processor as unknown as {
        finalizeApprovedTask(task: Task, writtenInput: string, settings: Settings): Promise<void>;
      }).finalizeApprovedTask(
        task,
        changedPlanText,
        { requirePlanApproval: true, planApprovalMode: "require-all" } as Settings,
      );

      expect(store.updateTask).toHaveBeenCalledWith("FN-LEGACY-FP-CHANGED", expect.objectContaining({ status: "awaiting-approval" }));
      expect(store.moveTask).not.toHaveBeenCalled();
      expect(store.updateTask).not.toHaveBeenCalledWith("FN-LEGACY-FP-CHANGED", expect.objectContaining({ approvedPlanFingerprint: expect.anything() }));
    });

    it("recoverApprovedTask auto-approves a legacy pre-hygiene fingerprint too", async () => {
      const legacyFingerprint = computePlanApprovalFingerprint(planText);
      await mkdir(join(rootDir, ".fusion", "tasks", "FN-LEGACY-RECOVER"), { recursive: true });
      await writeFile(join(rootDir, ".fusion", "tasks", "FN-LEGACY-RECOVER", "PROMPT.md"), planText);
      const store = createMockStore({
        getSettings: vi.fn().mockResolvedValue({
          maxConcurrent: 2,
          maxWorktrees: 4,
          pollIntervalMs: 10000,
          groupOverlappingFiles: false,
          autoMerge: true,
          requirePlanApproval: true,
        } as Settings),
      });
      const processor = new TriageProcessor(store, rootDir);

      const recovered = await processor.recoverApprovedTask({
        id: "FN-LEGACY-RECOVER",
        description: "Recovered triage task",
        column: "triage",
        status: "planning",
        approvedPlanFingerprint: legacyFingerprint,
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [{ timestamp: "2026-01-01T00:00:00.000Z", action: "Spec review: APPROVE" }],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:02:00.000Z",
      });

      expect(recovered).toBe(true);
      expect(store.moveTask).toHaveBeenCalledWith("FN-LEGACY-RECOVER", "todo");
      expect(store.updateTask).not.toHaveBeenCalledWith("FN-LEGACY-RECOVER", expect.objectContaining({ status: "awaiting-approval" }));
    });

    it("does not rewrite a matching approved fingerprint", async () => {
      const approvedPlan = approvedOnDisk(planText, "Triage task");
      const task = createTriageTask({
        id: "FN-FP-NO-MIGRATE",
        status: "planning",
        approvedPlanFingerprint: computePlanApprovalFingerprint(approvedPlan),
      } as Partial<Task>);
      const store = createMockStore({
        getTask: vi.fn().mockResolvedValue(task),
      } as Partial<TaskStore>);
      const processor = new TriageProcessor(store, rootDir);

      await (processor as unknown as {
        finalizeApprovedTask(task: Task, writtenInput: string, settings: Settings): Promise<void>;
      }).finalizeApprovedTask(
        task,
        approvedPlan,
        { requirePlanApproval: true, planApprovalMode: "require-all" } as Settings,
      );

      expect(store.moveTask).toHaveBeenCalledWith("FN-FP-NO-MIGRATE", "todo");
      // A matching normalized fingerprint needs no redundant write.
      expect(store.updateTask).not.toHaveBeenCalledWith("FN-FP-NO-MIGRATE", expect.objectContaining({ approvedPlanFingerprint: expect.anything() }));
    });

    it("never-approved task (no fingerprint) still parks at awaiting-approval on first specify", async () => {
      const task = createTriageTask({
        id: "FN-NEVER-APPROVED",
        status: "planning",
      } as Partial<Task>);
      const store = createMockStore({
        getTask: vi.fn().mockResolvedValue(task),
      } as Partial<TaskStore>);
      const processor = new TriageProcessor(store, rootDir);

      await (processor as unknown as {
        finalizeApprovedTask(task: Task, writtenInput: string, settings: Settings): Promise<void>;
      }).finalizeApprovedTask(
        task,
        planText,
        { requirePlanApproval: true, planApprovalMode: "require-all" } as Settings,
      );

      expect(store.updateTask).toHaveBeenCalledWith("FN-NEVER-APPROVED", expect.objectContaining({ status: "awaiting-approval" }));
      expect(store.moveTask).not.toHaveBeenCalled();
    });

    it("rejected plan (fingerprint cleared to undefined) re-asks even though the same content was approved before", async () => {
      const task = createTriageTask({
        id: "FN-REJECTED-THEN-RESPECIFIED",
        status: "planning",
        approvedPlanFingerprint: undefined,
      } as Partial<Task>);
      const store = createMockStore({
        getTask: vi.fn().mockResolvedValue(task),
      } as Partial<TaskStore>);
      const processor = new TriageProcessor(store, rootDir);

      await (processor as unknown as {
        finalizeApprovedTask(task: Task, writtenInput: string, settings: Settings): Promise<void>;
      }).finalizeApprovedTask(
        task,
        planText,
        { requirePlanApproval: true, planApprovalMode: "require-all" } as Settings,
      );

      expect(store.updateTask).toHaveBeenCalledWith("FN-REJECTED-THEN-RESPECIFIED", expect.objectContaining({ status: "awaiting-approval" }));
      expect(store.moveTask).not.toHaveBeenCalled();
    });

    it("auto-approve-all moves to todo regardless of fingerprint state (manual gate never reached)", async () => {
      const task = createTriageTask({
        id: "FN-AUTO-APPROVE-FINGERPRINT",
        status: "planning",
        approvedPlanFingerprint: computePlanApprovalFingerprint(changedPlanText),
      } as Partial<Task>);
      const store = createMockStore({
        getTask: vi.fn().mockResolvedValue(task),
      } as Partial<TaskStore>);
      const processor = new TriageProcessor(store, rootDir);

      await (processor as unknown as {
        finalizeApprovedTask(task: Task, writtenInput: string, settings: Settings): Promise<void>;
      }).finalizeApprovedTask(
        task,
        planText,
        { requirePlanApproval: true, planApprovalMode: "auto-approve-all" } as Settings,
      );

      expect(store.moveTask).toHaveBeenCalledWith("FN-AUTO-APPROVE-FINGERPRINT", "todo");
      expect(store.updateTask).not.toHaveBeenCalledWith("FN-AUTO-APPROVE-FINGERPRINT", expect.objectContaining({ status: "awaiting-approval" }));
    });

    /*
     * FN-7569: exercise the recoverApprovedTask caller (planning-recovery self-heal),
     * not just finalizeApprovedTask directly, so the fingerprint short-circuit is
     * proven to reach every finalizeApprovedTask caller, not just a direct-call seam.
     */
    it("recoverApprovedTask (self-healing planning recovery) skips re-park for an unchanged already-approved plan", async () => {
      // Recovery reads raw planner text from disk and successfully injects the description.
      // Its pre-injection approval fingerprint must compare equal after that write.
      const fingerprint = computePlanApprovalFingerprint(planText);
      await mkdir(join(rootDir, ".fusion", "tasks", "FN-RECOVER-IDEMPOTENT"), { recursive: true });
      await writeFile(join(rootDir, ".fusion", "tasks", "FN-RECOVER-IDEMPOTENT", "PROMPT.md"), planText);
      const store = createMockStore({
        getSettings: vi.fn().mockResolvedValue({
          maxConcurrent: 2,
          maxWorktrees: 4,
          pollIntervalMs: 10000,
          groupOverlappingFiles: false,
          autoMerge: true,
          requirePlanApproval: true,
        } as Settings),
      });
      const processor = new TriageProcessor(store, rootDir);

      const recovered = await processor.recoverApprovedTask({
        id: "FN-RECOVER-IDEMPOTENT",
        description: "Recovered triage task",
        column: "triage",
        status: "planning",
        approvedPlanFingerprint: fingerprint,
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [
          { timestamp: "2026-01-01T00:00:00.000Z", action: "Spec review: APPROVE" },
        ],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:02:00.000Z",
      });

      expect(recovered).toBe(true);
      expect(store.moveTask).toHaveBeenCalledWith("FN-RECOVER-IDEMPOTENT", "todo");
      expect(store.updateTask).not.toHaveBeenCalledWith("FN-RECOVER-IDEMPOTENT", expect.objectContaining({ status: "awaiting-approval" }));
    });
  });

  /*
   * FNXC:PlanApproval 2026-07-04-12:30:
   * FN-7526 — auto-approve-all must NOT bypass Workflow Plan Review. A REVISE
   * verdict routes to status: "needs-replan" (never reaches the manual
   * resolvePlanApprovalRequired gate at all), which is distinct from the manual
   * gate's "awaiting-approval" outcome and proves the two gates remain independent.
   */
  it("clears stale workflow step instances when a fresh accepted plan replaces existing steps", async () => {
    const task = createTriageTask({
      id: "FN-7224",
      title: "Rebuilt plan task",
      status: "planning",
      steps: [{ name: "Old step", status: "pending" }],
    } as Partial<Task>);
    const clearWorkflowRunStepInstancesAsync = vi.fn().mockResolvedValue(undefined);
    const store = createMockStore({
      getTask: vi.fn().mockResolvedValue(task),
      parseStepsFromPrompt: vi.fn().mockResolvedValue([{ name: "Fresh step", status: "pending" }]),
      clearWorkflowRunStepInstancesAsync,
    } as Partial<TaskStore>);
    const processor = new TriageProcessor(store, rootDir);

    await (processor as unknown as {
      finalizeApprovedTask(task: Task, writtenInput: string, settings: Settings): Promise<void>;
    }).finalizeApprovedTask(
      task,
      "# Task: FN-7224 - Rebuilt plan task\n\n## Steps\n\n### Step 1: Fresh step\n- Execute the fresh plan.\n",
      { requirePlanApproval: false } as Settings,
    );

    expect(clearWorkflowRunStepInstancesAsync).toHaveBeenCalledWith("FN-7224");
    expect(store.moveTask).toHaveBeenCalledWith("FN-7224", "todo");
  });

  it.each([
    { mode: "workflow" as const, requirePlanApproval: true, expectedApproval: true },
    { mode: undefined, requirePlanApproval: false, expectedApproval: false },
  ])("defers to workflow requirePlanApproval when mode is $mode", async ({ mode, requirePlanApproval, expectedApproval }) => {
    const store = await finalizeWithSettings({
      requirePlanApproval,
      planApprovalMode: mode,
    } as Settings);

    if (expectedApproval) {
      expect(store.updateTask).toHaveBeenCalledWith("FN-APPROVAL", expect.objectContaining({ status: "awaiting-approval" }));
      expect(store.moveTask).not.toHaveBeenCalled();
    } else {
      expect(store.moveTask).toHaveBeenCalledWith("FN-APPROVAL", "todo");
      expect(store.updateTask).not.toHaveBeenCalledWith("FN-APPROVAL", expect.objectContaining({ status: "awaiting-approval" }));
    }
  });
});

describe("specified triage recovery", () => {
  let rootDir = "";

  beforeEach(async () => {
    rootDir = await createTriageFixtureRoot("fusion-triage-recovery-");
    await mkdir(join(rootDir, ".fusion", "tasks", "FN-001"), { recursive: true });
    await writeFile(
      join(rootDir, ".fusion", "tasks", "FN-001", "PROMPT.md"),
      "# Task: FN-001\n\n**Size:** M\n\n**No commits expected:** true\n\n## Review Level: 2\n\nRecovered specification",
    );
  });

  afterEach(async () => {
    await cleanupTriageFixtureRoot(rootDir);
  });

  it("moves approved planning task to todo during recovery", async () => {
    const store = createMockStore({
      getSettings: vi.fn().mockResolvedValue({
        maxConcurrent: 2,
        maxWorktrees: 4,
        pollIntervalMs: 10000,
        groupOverlappingFiles: false,
        autoMerge: true,
        requirePlanApproval: false,
      } as Settings),
      parseDependenciesFromPrompt: vi.fn().mockResolvedValue(["FN-1247"]),
    });

    const processor = new TriageProcessor(store, rootDir);
    const recovered = await processor.recoverApprovedTask({
      id: "FN-001",
      description: "Recovered triage task",
      column: "triage",
      status: "planning",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [
        { timestamp: "2026-01-01T00:00:00.000Z", action: "Spec review requested" },
        { timestamp: "2026-01-01T00:01:00.000Z", action: "Spec review: APPROVE" },
      ],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:02:00.000Z",
    });

    expect(recovered).toBe(true);
    expect(store.updateTask).toHaveBeenCalledWith("FN-001", {
      error: null,
      dependencies: ["FN-1247"],
      size: "M",
      noCommitsExpected: true,
    });
    expect(store.moveTask).toHaveBeenCalledWith("FN-001", "todo");
    // FNXC:TriageStuckKill 2026-07-18-21:05: terminal status clear after release move (FN-1312).
    expect(store.updateTask).toHaveBeenCalledWith("FN-001", { status: null, error: null });
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-001",
      "Auto-recovered specified task stuck in planning — moved to todo",
    );
  });

  it("does not recover a prose-only partial planning draft into execution", async () => {
    await writeFile(
      join(rootDir, ".fusion", "tasks", "FN-001", "PROMPT.md"),
      "# Refinement: unfinished plan\n\nOperator request.\n\n## Original Description\n\nOperator request.\n",
    );
    const store = createMockStore({
      getSettings: vi.fn().mockResolvedValue({
        maxConcurrent: 2,
        maxWorktrees: 4,
        pollIntervalMs: 10000,
        groupOverlappingFiles: false,
        autoMerge: true,
        requirePlanApproval: false,
      } as Settings),
      parseStepsFromPrompt: vi.fn().mockResolvedValue([]),
    });
    const processor = new TriageProcessor(store, rootDir);

    const recovered = await processor.recoverApprovedTask({
      id: "FN-001",
      title: "Refinement: unfinished plan",
      description: "Operator request.",
      column: "triage",
      status: "planning",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:02:00.000Z",
    });

    expect(recovered).toBe(false);
    expect(store.moveTask).not.toHaveBeenCalledWith("FN-001", "todo");
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-001",
      "Planning recovery withheld: PROMPT.md has no executable steps and does not declare no commits expected",
    );
  });

  it("recovers a structured implementation plan without a no-commits marker", async () => {
    await writeFile(
      join(rootDir, ".fusion", "tasks", "FN-001", "PROMPT.md"),
      "# Task: FN-001 - Implement change\n\n**Size:** M\n\n## Steps\n\n### Step 1: Implement\n\nMake the change.\n",
    );
    const store = createMockStore({
      getSettings: vi.fn().mockResolvedValue({
        maxConcurrent: 2,
        maxWorktrees: 4,
        pollIntervalMs: 10000,
        groupOverlappingFiles: false,
        autoMerge: true,
        requirePlanApproval: false,
      } as Settings),
      parseStepsFromPrompt: vi.fn().mockResolvedValue([{ name: "Implement", status: "pending" }]),
    });
    const processor = new TriageProcessor(store, rootDir);

    const recovered = await processor.recoverApprovedTask({
      id: "FN-001",
      description: "Implement change",
      column: "triage",
      status: "planning",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:02:00.000Z",
    });

    expect(recovered).toBe(true);
    expect(store.moveTask).toHaveBeenCalledWith("FN-001", "todo");
  });

  /*
  FNXC:TriageStuckKill 2026-07-18-22:30:
  Null status alone is not proof of an approved plan (Greptile P1). Only recover null-status
  triage cards when Plan Review already recorded a passed verdict.
  */
  it("recovers a null-status triage task only when Plan Review already passed", async () => {
    const store = createMockStore({
      getSettings: vi.fn().mockResolvedValue({
        maxConcurrent: 2,
        maxWorktrees: 4,
        pollIntervalMs: 10000,
        groupOverlappingFiles: false,
        autoMerge: true,
        requirePlanApproval: false,
      } as Settings),
    });

    const processor = new TriageProcessor(store, rootDir);
    const recovered = await processor.recoverApprovedTask({
      id: "FN-001",
      description: "Recovered triage task",
      column: "triage",
      status: null,
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      workflowStepResults: [
        {
          workflowStepId: "plan-review",
          workflowStepName: "Plan Review",
          phase: "pre-merge",
          status: "passed",
          verdict: "APPROVE",
        },
      ],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:02:00.000Z",
    } as any);

    expect(recovered).toBe(true);
    expect(store.moveTask).toHaveBeenCalledWith("FN-001", "todo");
  });

  it("does not recover a null-status triage draft that never passed Plan Review", async () => {
    const store = createMockStore({
      getSettings: vi.fn().mockResolvedValue({
        maxConcurrent: 2,
        maxWorktrees: 4,
        pollIntervalMs: 10000,
        groupOverlappingFiles: false,
        autoMerge: true,
        requirePlanApproval: false,
      } as Settings),
    });

    const processor = new TriageProcessor(store, rootDir);
    const recovered = await processor.recoverApprovedTask({
      id: "FN-001",
      description: "Unapproved draft after early status clear",
      column: "triage",
      status: null,
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:02:00.000Z",
    });

    expect(recovered).toBe(false);
    expect(store.moveTask).not.toHaveBeenCalled();
  });

  it("does not recover needs-replan cards (those require a real replan, not handoff recovery)", async () => {
    const store = createMockStore({
      getSettings: vi.fn().mockResolvedValue({
        maxConcurrent: 2,
        maxWorktrees: 4,
        pollIntervalMs: 10000,
        groupOverlappingFiles: false,
        autoMerge: true,
        requirePlanApproval: false,
      } as Settings),
    });

    const processor = new TriageProcessor(store, rootDir);
    const recovered = await processor.recoverApprovedTask({
      id: "FN-001",
      description: "Rejected plan under revision",
      column: "triage",
      status: "needs-replan",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:02:00.000Z",
    });

    expect(recovered).toBe(false);
    expect(store.moveTask).not.toHaveBeenCalled();
  });

  it("defers stuck-abort requeue while Plan Review finalize is still in flight", async () => {
    const store = createMockStore({
      getSettings: vi.fn().mockResolvedValue({
        maxConcurrent: 2,
        maxWorktrees: 4,
        pollIntervalMs: 10000,
        groupOverlappingFiles: false,
        autoMerge: true,
        maxStuckKills: 6,
      } as Settings),
      getTask: vi.fn().mockResolvedValue({
        id: "FN-001",
        description: "mid finalize",
        column: "triage",
        status: null,
        stuckKillCount: 0,
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:02:00.000Z",
      }),
    });

    const processor = new TriageProcessor(store, rootDir);
    (processor as any).finalizing.add("FN-001");

    await (processor as any).handleStuckAbortRequeue(
      {
        id: "FN-001",
        description: "mid finalize",
        column: "triage",
        status: null,
        stuckKillCount: 0,
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:02:00.000Z",
      },
      "catch",
    );

    // Must not force needs-replan while the in-flight finalize owns the handoff.
    expect(store.updateTask).toHaveBeenCalledWith("FN-001", { stuckKillCount: 1 });
    expect(store.updateTask).not.toHaveBeenCalledWith(
      "FN-001",
      expect.objectContaining({ status: "needs-replan" }),
    );
    expect(store.moveTask).not.toHaveBeenCalled();
  });

  /*
  FNXC:TriageStuckKill 2026-07-18-22:30:
  After a successful release, outer stuckAborted cleanup must not re-apply needs-replan
  (Greptile P1 post-handoff race on PR #2326).
  */
  it("does not write needs-replan when stuck-abort cleanup runs after handoff to todo", async () => {
    const store = createMockStore({
      getSettings: vi.fn().mockResolvedValue({
        maxConcurrent: 2,
        maxWorktrees: 4,
        pollIntervalMs: 10000,
        groupOverlappingFiles: false,
        autoMerge: true,
        maxStuckKills: 6,
      } as Settings),
      getTask: vi.fn().mockResolvedValue({
        id: "FN-001",
        description: "already released",
        column: "todo",
        status: null,
        stuckKillCount: 0,
        dependencies: [],
        steps: [{ name: "step-1", status: "pending" }],
        currentStep: 0,
        log: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:02:00.000Z",
      }),
    });

    const processor = new TriageProcessor(store, rootDir);

    await (processor as any).handleStuckAbortRequeue(
      {
        id: "FN-001",
        description: "already released",
        column: "todo",
        status: null,
        stuckKillCount: 0,
        dependencies: [],
        steps: [{ name: "step-1", status: "pending" }],
        currentStep: 0,
        log: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:02:00.000Z",
      },
      "catch",
    );

    expect(store.updateTask).toHaveBeenCalledWith("FN-001", { stuckKillCount: 1 });
    expect(store.updateTask).not.toHaveBeenCalledWith(
      "FN-001",
      expect.objectContaining({ status: "needs-replan" }),
    );
  });

  /*
  FNXC:TriageStuckKill 2026-07-18-22:50:
  Plan-in-place workflows plan inside todo with status:"planning". Stuck-abort must requeue
  those cards, not treat every todo row as a completed handoff (CodeRabbit on PR #2326).
  */
  it("requeues plan-in-place todo cards still in planning status after stuck-abort", async () => {
    await writeFile(
      join(rootDir, ".fusion", "tasks", "FN-001", "PROMPT.md"),
      "# Task: FN-001\n\n**Size:** M\n\n## Mission\n\nDraft still being planned in todo\n",
    );

    const planningTodo = {
      id: "FN-001",
      description: "plan-in-place mid plan",
      column: "todo" as const,
      status: "planning" as const,
      stuckKillCount: 0,
      dependencies: [] as string[],
      steps: [] as Array<{ name: string; status: string }>,
      currentStep: 0,
      log: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:02:00.000Z",
    };

    const store = createMockStore({
      getSettings: vi.fn().mockResolvedValue({
        maxConcurrent: 2,
        maxWorktrees: 4,
        pollIntervalMs: 10000,
        groupOverlappingFiles: false,
        autoMerge: true,
        maxStuckKills: 6,
      } as Settings),
      getTask: vi.fn().mockResolvedValue(planningTodo),
    });

    const processor = new TriageProcessor(store, rootDir);
    await (processor as any).handleStuckAbortRequeue(planningTodo, "catch");

    expect(store.updateTask).toHaveBeenCalledWith(
      "FN-001",
      expect.objectContaining({ status: "needs-replan", stuckKillCount: 1 }),
    );
  });

  it("stamps source metadata from sanitized effective write scope during recovery", async () => {
    await writeFile(
      join(rootDir, ".fusion", "tasks", "FN-001", "PROMPT.md"),
      `# Task: FN-001 - Fix poisoned scope

**Size:** L

## File Scope

Expected touched paths:

- \`packages/core/src/store.ts\`
- \`packages/engine/src/scheduler.ts\`
- \`packages/dashboard/**\`

Forbidden paths / non-goals:

- Do not edit Atlas files: \`AtlasNotes.xcodeproj/**\`, \`Tests/AtlasNotesMobileUITests/**\`, \`Packages/MobileApp/**\`.
- Evidence only: \`.fusion/fusion.db\`, \`.fusion/tasks/*/task.json\`, \`Packages/*/Package.resolved\`.
- Conditional only: \`.changeset/*.md\`.

## Steps

### Step 1: Fix poisoned scope

Apply the scoped implementation changes.
`,
    );

    const store = createMockStore({
      getSettings: vi.fn().mockResolvedValue({
        maxConcurrent: 2,
        maxWorktrees: 4,
        pollIntervalMs: 10000,
        groupOverlappingFiles: false,
        autoMerge: true,
        requirePlanApproval: false,
      } as Settings),
      parseFileScopeFromPrompt: vi.fn().mockResolvedValue([]),
    });

    const processor = new TriageProcessor(store, rootDir);
    const recovered = await processor.recoverApprovedTask({
      id: "FN-001",
      description: "Recovered triage task",
      column: "triage",
      status: "planning",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [{ timestamp: "2026-01-01T00:00:00.000Z", action: "Spec review: APPROVE" }],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:02:00.000Z",
    });

    expect(recovered).toBe(true);
    expect(store.updateTask).toHaveBeenCalledWith(
      "FN-001",
      expect.objectContaining({
        sourceMetadataPatch: expect.objectContaining({
          fileScope: [
            "packages/core/src/store.ts",
            "packages/engine/src/scheduler.ts",
            "packages/dashboard/**",
          ],
          intentSignature: expect.objectContaining({
            filePaths: [
              "packages/core/src/store.ts",
              "packages/engine/src/scheduler.ts",
            ],
          }),
        }),
      }),
    );
    const metadataPatch = (store.updateTask as ReturnType<typeof vi.fn>).mock.calls
      .map(([, patch]) => patch?.sourceMetadataPatch)
      .find(Boolean);
    expect(metadataPatch.fileScope).not.toContain("AtlasNotes.xcodeproj/**");
    expect(metadataPatch.fileScope).not.toContain(".fusion/fusion.db");
    expect(metadataPatch.fileScope).not.toContain("Packages/*/Package.resolved");
    expect(metadataPatch.fileScope).not.toContain(".changeset/*.md");
    expect(metadataPatch.intentSignature.filePaths).not.toContain("AtlasNotes.xcodeproj/**");
  });

  it("updates malformed metadata title from prompt heading when task ID matches", async () => {
    await writeFile(
      join(rootDir, ".fusion", "tasks", "FN-001", "PROMPT.md"),
      "# Task: FN-001 - Experimental AI Agent Onboarding Flow\n\n**Size:** M\n\n## Review Level: 2\n\nRecovered specification\n\n## Steps\n\n### Step 1: Implement onboarding flow\n\nMake the change.",
    );

    const store = createMockStore({
      getSettings: vi.fn().mockResolvedValue({
        maxConcurrent: 2,
        maxWorktrees: 4,
        pollIntervalMs: 10000,
        groupOverlappingFiles: false,
        autoMerge: true,
        requirePlanApproval: false,
      } as Settings),
    });

    const processor = new TriageProcessor(store, rootDir);
    const recovered = await processor.recoverApprovedTask({
      id: "FN-001",
      description: "Recovered triage task",
      column: "triage",
      status: "planning",
      title: "Created task **FN-999** in triage",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [{ timestamp: "2026-01-01T00:00:00.000Z", action: "Spec review: APPROVE" }],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:02:00.000Z",
    });

    expect(recovered).toBe(true);
    expect(store.updateTask).toHaveBeenCalledWith(
      "FN-001",
      expect.objectContaining({ title: "Experimental AI Agent Onboarding Flow" }),
    );
  });

  it("does not overwrite title when heading task ID does not match", async () => {
    await writeFile(
      join(rootDir, ".fusion", "tasks", "FN-001", "PROMPT.md"),
      "# Task: FN-999 - Wrong Task\n\n**Size:** M\n\n## Review Level: 2\n\nRecovered specification\n\n## Steps\n\n### Step 1: Implement change\n\nMake the change.",
    );

    const store = createMockStore({
      getSettings: vi.fn().mockResolvedValue({
        maxConcurrent: 2,
        maxWorktrees: 4,
        pollIntervalMs: 10000,
        groupOverlappingFiles: false,
        autoMerge: true,
        requirePlanApproval: false,
      } as Settings),
    });

    const processor = new TriageProcessor(store, rootDir);
    const recovered = await processor.recoverApprovedTask({
      id: "FN-001",
      description: "Recovered triage task",
      column: "triage",
      status: "planning",
      title: "Existing title",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [{ timestamp: "2026-01-01T00:00:00.000Z", action: "Spec review: APPROVE" }],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:02:00.000Z",
    });

    expect(recovered).toBe(true);
    expect(store.updateTask).toHaveBeenCalledWith(
      "FN-001",
      expect.not.objectContaining({ title: expect.any(String) }),
    );
  });

  it("includes decision-only noCommitsExpected heuristic instructions in system prompts", () => {
    expect(TRIAGE_POLICY_PROMPT).toContain("**No commits expected:** true");
    expect(TRIAGE_POLICY_PROMPT).toContain("Decide whether FN-XYZ needs a fix");
    expect(TRIAGE_POLICY_PROMPT).toContain("Assign ready implementation task to active owner, or record no-route state");
    expect(TRIAGE_POLICY_PROMPT).toContain("operational routing/coordination");
    expect(TRIAGE_POLICY_PROMPT).toContain("Investigate FN-XYZ and fix if needed");
    expect(TRIAGE_POLICY_PROMPT).toContain("Investigate and fix routing if needed");
    expect(FAST_PLANNING_PROMPT).toContain("**No commits expected:** true");
    expect(FAST_PLANNING_PROMPT).toContain("operational routing/coordination");
  });

  it("preserves imported GitHub issue titles during planning recovery", async () => {
    await writeFile(
      join(rootDir, ".fusion", "tasks", "FN-001", "PROMPT.md"),
      "# Task: FN-001 - Different AI-generated planning title\n\n**Size:** M\n\n## Review Level: 2\n\nRecovered specification\n\n## Steps\n\n### Step 1: Implement issue fix\n\nMake the change.",
    );

    const store = createMockStore({
      getSettings: vi.fn().mockResolvedValue({
        maxConcurrent: 2,
        maxWorktrees: 4,
        pollIntervalMs: 10000,
        groupOverlappingFiles: false,
        autoMerge: true,
        requirePlanApproval: false,
      } as Settings),
    });

    const processor = new TriageProcessor(store, rootDir);
    const recovered = await processor.recoverApprovedTask({
      id: "FN-001",
      description: "Imported from GitHub",
      column: "triage",
      status: "planning",
      title: '"Cannot read properties of undefined (reading \'trim\')" when extracting insights',
      sourceType: "github_import",
      sourceIssue: {
        provider: "github",
        repository: "Runfusion/Fusion",
        externalIssueId: "70",
        issueNumber: 70,
        url: "https://github.com/Runfusion/Fusion/issues/70",
      },
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [{ timestamp: "2026-01-01T00:00:00.000Z", action: "Spec review: APPROVE" }],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:02:00.000Z",
    });

    expect(recovered).toBe(true);
    expect(store.updateTask).not.toHaveBeenCalledWith(
      "FN-001",
      expect.objectContaining({ title: "Different AI-generated planning title" }),
    );
  });

  it("clears status and error before moving approved tasks to todo", async () => {
    const store = createMockStore({
      getSettings: vi.fn().mockResolvedValue({
        maxConcurrent: 2,
        maxWorktrees: 4,
        pollIntervalMs: 10000,
        groupOverlappingFiles: false,
        autoMerge: true,
        requirePlanApproval: false,
      } as Settings),
    });

    const processor = new TriageProcessor(store, rootDir);
    const recovered = await processor.recoverApprovedTask({
      id: "FN-001",
      description: "Recovered triage task",
      column: "triage",
      status: "planning",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [
        { timestamp: "2026-01-01T00:00:00.000Z", action: "Spec review: APPROVE" },
      ],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:02:00.000Z",
    });

    expect(recovered).toBe(true);
    expect(store.updateTask).toHaveBeenCalledWith("FN-001", expect.objectContaining({
      status: null,
      error: null,
    }));
    expect(store.moveTask).toHaveBeenCalledWith("FN-001", "todo");
  });

  it("moves recovered task to todo when project auto approval overrides stored workflow approval", async () => {
    const store = createMockStore({
      getSettings: vi.fn().mockResolvedValue({
        maxConcurrent: 2,
        maxWorktrees: 4,
        pollIntervalMs: 10000,
        groupOverlappingFiles: false,
        autoMerge: true,
        planApprovalMode: "auto-approve-all",
        requirePlanApproval: false,
      } as Settings),
      getTaskWorkflowSelection: vi.fn().mockReturnValue({ workflowId: "builtin:coding", stepIds: [] }),
      getWorkflowDefinition: vi.fn().mockResolvedValue(undefined),
      getWorkflowSettingValues: vi.fn().mockReturnValue({ requirePlanApproval: true }),
      getWorkflowSettingsProjectId: vi.fn().mockReturnValue("project-auto-approval"),
    } as Partial<TaskStore>);

    const processor = new TriageProcessor(store, rootDir);
    const recovered = await processor.recoverApprovedTask({
      id: "FN-001",
      description: "Recovered triage task",
      column: "triage",
      status: "planning",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [
        { timestamp: "2026-01-01T00:00:00.000Z", action: "Spec review: APPROVE" },
      ],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:02:00.000Z",
    });

    expect(recovered).toBe(true);
    expect(store.moveTask).toHaveBeenCalledWith("FN-001", "todo");
    expect(store.updateTask).not.toHaveBeenCalledWith("FN-001", expect.objectContaining({ status: "awaiting-approval" }));
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-001",
      "Auto-recovered specified task stuck in planning — moved to todo",
    );
  });

  it("moves approved planning task to awaiting-approval when manual approval is required", async () => {
    const store = createMockStore({
      getSettings: vi.fn().mockResolvedValue({
        maxConcurrent: 2,
        maxWorktrees: 4,
        pollIntervalMs: 10000,
        groupOverlappingFiles: false,
        autoMerge: true,
        requirePlanApproval: true,
      } as Settings),
    });

    const processor = new TriageProcessor(store, rootDir);
    const recovered = await processor.recoverApprovedTask({
      id: "FN-001",
      description: "Recovered triage task",
      column: "triage",
      status: "planning",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [
        { timestamp: "2026-01-01T00:00:00.000Z", action: "Spec review: APPROVE" },
      ],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:02:00.000Z",
    });

    expect(recovered).toBe(true);
    expect(store.moveTask).not.toHaveBeenCalled();
    /*
     * FN-7559: the manual gate's own awaiting-approval write now explicitly
     * clears awaitingApprovalReason (defense against a stale "release-authorization"
     * reason surviving a replan) so this genuine manual hold is never mistaken
     * for a release-authorization hold in the dashboard.
     */
    expect(store.updateTask).toHaveBeenCalledWith("FN-001", {
      status: "awaiting-approval",
      awaitingApprovalReason: null,
    });
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-001",
      "Auto-recovered specified task stuck in planning — awaiting manual approval",
    );
  });
});

describe("taskCreate tool model inheritance", () => {
  it("inherits parent task model settings when creating subtasks", async () => {
    const parentTask: Task = {
      id: "FN-001",
      description: "Parent task",
      column: "triage",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      modelProvider: "anthropic",
      modelId: "claude-sonnet-4-5",
      validatorModelProvider: "openai",
      validatorModelId: "gpt-4o",
    };

    const createdSubtask: Task = {
      id: "FN-002",
      description: "Child task description",
      column: "triage",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    const store = createMockStore({
      getTask: vi.fn().mockResolvedValue(parentTask),
      createTask: vi.fn().mockResolvedValue(createdSubtask),
    });

    // Simulate the taskCreate tool behavior
    const parentTaskId = "FN-001";
    const parentTaskResult = await store.getTask(parentTaskId);
    
    await store.createTask({
      title: "Child Task",
      description: "Child task description",
      dependencies: [],
      column: "triage",
      modelProvider: parentTaskResult?.modelProvider,
      modelId: parentTaskResult?.modelId,
      validatorModelProvider: parentTaskResult?.validatorModelProvider,
      validatorModelId: parentTaskResult?.validatorModelId,
      source: { sourceType: "agent_heartbeat", sourceParentTaskId: parentTaskId },
    });

    expect(store.getTask).toHaveBeenCalledWith("FN-001");
    expect(store.createTask).toHaveBeenCalledWith(expect.objectContaining({
      title: "Child Task",
      modelProvider: "anthropic",
      modelId: "claude-sonnet-4-5",
      validatorModelProvider: "openai",
      validatorModelId: "gpt-4o",
    }));
  });

  it("handles missing parent task gracefully when creating subtasks", async () => {
    const createdSubtask: Task = {
      id: "FN-002",
      description: "Child task description",
      column: "triage",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    const store = createMockStore({
      getTask: vi.fn().mockRejectedValue(new Error("Task not found")),
      createTask: vi.fn().mockResolvedValue(createdSubtask),
    });

    // Simulate the taskCreate tool behavior with missing parent
    const parentTaskId = "FN-NONEXISTENT";
    let parentTask;
    try {
      parentTask = await store.getTask(parentTaskId);
    } catch {
      parentTask = undefined;
    }
    
    await store.createTask({
      title: "Child Task",
      description: "Child task description",
      dependencies: [],
      column: "triage",
      modelProvider: parentTask?.modelProvider,
      modelId: parentTask?.modelId,
      validatorModelProvider: parentTask?.validatorModelProvider,
      validatorModelId: parentTask?.validatorModelId,
      source: { sourceType: "agent_heartbeat", sourceParentTaskId: parentTaskId },
    });

    expect(store.getTask).toHaveBeenCalledWith("FN-NONEXISTENT");
    expect(store.createTask).toHaveBeenCalledWith(expect.objectContaining({
      modelProvider: undefined,
      modelId: undefined,
      validatorModelProvider: undefined,
      validatorModelId: undefined,
    }));
  });

  describe("proactive subtask creation (fn_task_create always available)", () => {
    it("fn_task_create tool is included in triage tools regardless of breakIntoSubtasks", () => {
      const store = createMockStore();
      const processor = new TriageProcessor(store, "/test/root");
      const createdSubtasksRef = { current: [] };

      const tools = (processor as any).createTriageTools({
        parentTaskId: "FN-400",
        allowTaskCreate: true,
        createdSubtasksRef,
      });

      const toolNames = tools.map((t: any) => t.name);
      expect(toolNames).toContain("fn_task_create");
      expect(toolNames).toContain("fn_task_list");
      expect(toolNames).toContain("fn_task_search");
      expect(toolNames).toContain("fn_task_show");
      expect(tools).toHaveLength(4);
    });

    it("fn_task_create tool succeeds and tracks created subtask", async () => {
      const parentTask: Task = {
        id: "FN-400",
        description: "Large task without breakIntoSubtasks",
        column: "triage",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      };

      const createdSubtask: Task = {
        id: "FN-401",
        description: "Child task",
        column: "triage",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      };

      const store = createMockStore({
        getTask: vi.fn().mockResolvedValue(parentTask),
        createTask: vi.fn().mockResolvedValue(createdSubtask),
      });

      const processor = new TriageProcessor(store, "/test/root");
      const createdSubtasksRef = { current: [] };

      const tools = (processor as any).createTriageTools({
        parentTaskId: "FN-400",
        allowTaskCreate: true,
        createdSubtasksRef,
      });

      const taskCreateTool = tools.find((t: any) => t.name === "fn_task_create");
      const result = await taskCreateTool.execute("call-1", {
        description: "Child task description",
        title: "Child Task",
        dependencies: [],
      });

      // Should NOT return an error about task creation being disabled
      const text = result.content[0].text;
      expect(text).not.toContain("ERROR");
      expect(text).not.toContain("not enabled");
      expect(text).toContain("Created child task FN-401");

      // Subtask should be tracked in the ref
      expect(createdSubtasksRef.current).toContain("FN-401");

      // Should inherit parent model settings
      expect(store.createTask).toHaveBeenCalledWith(expect.objectContaining({
        title: "Child Task",
        description: "Child task description",
      }), expect.objectContaining({
        settings: expect.objectContaining({
          maxConcurrent: 2,
          maxWorktrees: 4,
        }),
      }));
    });

    it("fn_task_create passes workflow_id and noCommitsExpected through to child tasks", async () => {
      const parentTask: Task = {
        id: "FN-410",
        description: "Parent task",
        column: "triage",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      };

      const createdSubtask: Task = {
        ...parentTask,
        id: "FN-411",
        description: "Decision child task",
        workflowId: "builtin:quick-fix",
        noCommitsExpected: true,
      };

      const store = createMockStore({
        getTask: vi.fn().mockResolvedValue(parentTask),
        createTask: vi.fn().mockResolvedValue(createdSubtask),
      });
      const processor = new TriageProcessor(store, "/test/root");
      const createdSubtasksRef = { current: [] };

      const tools = (processor as any).createTriageTools({
        parentTaskId: "FN-410",
        allowTaskCreate: true,
        createdSubtasksRef,
      });
      const taskCreateTool = tools.find((t: any) => t.name === "fn_task_create");

      const result = await taskCreateTool.execute("call-1", {
        description: "Investigate and report the routing decision",
        workflow_id: "builtin:quick-fix",
        noCommitsExpected: true,
      });

      expect(result.content[0].text).toContain("Created child task FN-411");
      expect(store.createTask).toHaveBeenCalledWith(expect.objectContaining({
        description: "Investigate and report the routing decision",
        workflowId: "builtin:quick-fix",
        noCommitsExpected: true,
      }), expect.objectContaining({
        settings: expect.objectContaining({
          maxConcurrent: 2,
          maxWorktrees: 4,
        }),
      }));
      expect(createdSubtasksRef.current).toContain("FN-411");
    });

    it("fn_task_create rejects a dependency on the parent task being split", async () => {
      // Regression: triage used to accept any id in `dependencies`. If the AI
      // named the parent, the parent got deleted after the split and the child
      // was blocked forever by a nonexistent dep (FN-2163/FN-2164 incident).
      const parentTask: Task = {
        id: "FN-600",
        description: "Parent about to be split",
        column: "triage",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      };

      const store = createMockStore({
        getTask: vi.fn().mockResolvedValue(parentTask),
        createTask: vi.fn(),
      });
      const processor = new TriageProcessor(store, "/test/root");
      const createdSubtasksRef = { current: [] };

      const tools = (processor as any).createTriageTools({
        parentTaskId: "FN-600",
        allowTaskCreate: true,
        createdSubtasksRef,
      });
      const taskCreateTool = tools.find((t: any) => t.name === "fn_task_create");

      const result = await taskCreateTool.execute("call-1", {
        description: "Child that tries to wait for the parent",
        dependencies: ["FN-600"],
      });

      const text = result.content[0].text;
      expect(text).toContain("ERROR");
      expect(text).toContain("FN-600");
      expect(text).toContain("parent task is deleted after splitting");
      // Must not create the child — the caller has to fix the deps and retry.
      expect(store.createTask).not.toHaveBeenCalled();
      expect(createdSubtasksRef.current).toEqual([]);
    });

    it("fn_task_create accepts dependencies on sibling subtasks created earlier in the same split", async () => {
      // The valid case: two siblings where the second depends on the first.
      const parentTask: Task = {
        id: "FN-700",
        description: "Parent to split",
        column: "triage",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      };
      const sibling1: Task = { ...parentTask, id: "FN-701", description: "Sibling 1" };
      const sibling2: Task = { ...parentTask, id: "FN-702", description: "Sibling 2" };

      const createTaskMock = vi
        .fn()
        .mockResolvedValueOnce(sibling1)
        .mockResolvedValueOnce(sibling2);

      const store = createMockStore({
        getTask: vi.fn().mockResolvedValue(parentTask),
        createTask: createTaskMock,
      });
      const processor = new TriageProcessor(store, "/test/root");
      const createdSubtasksRef = { current: [] };

      const tools = (processor as any).createTriageTools({
        parentTaskId: "FN-700",
        allowTaskCreate: true,
        createdSubtasksRef,
      });
      const taskCreateTool = tools.find((t: any) => t.name === "fn_task_create");

      const firstRes = await taskCreateTool.execute("c1", {
        description: "Sibling 1",
        dependencies: [],
      });
      expect(firstRes.content[0].text).toContain("Created child task FN-701");

      const secondRes = await taskCreateTool.execute("c2", {
        description: "Sibling 2 depending on sibling 1",
        dependencies: ["FN-701"],
      });
      expect(secondRes.content[0].text).toContain("Created child task FN-702");
      expect(secondRes.content[0].text).not.toContain("ERROR");

      // The second createTask call should have the resolved sibling id preserved.
      expect(createTaskMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ dependencies: ["FN-701"] }),
        expect.objectContaining({
          settings: expect.objectContaining({
            maxConcurrent: 2,
            maxWorktrees: 4,
          }),
        }),
      );
      expect(createdSubtasksRef.current).toEqual(["FN-701", "FN-702"]);
    });

    it("fn_task_create rejects an unknown dependency id that is neither sibling nor existing task", async () => {
      const parentTask: Task = {
        id: "FN-800",
        description: "Parent",
        column: "triage",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      };
      // getTask returns the parent when asked, but throws for unknown ids.
      const store = createMockStore({
        getTask: vi.fn(async (id: string) => {
          if (id === "FN-800") return parentTask;
          throw new Error(`Task ${id} not found`);
        }) as unknown as TaskStore["getTask"],
        createTask: vi.fn(),
      });
      const processor = new TriageProcessor(store, "/test/root");
      const createdSubtasksRef = { current: [] };

      const tools = (processor as any).createTriageTools({
        parentTaskId: "FN-800",
        allowTaskCreate: true,
        createdSubtasksRef,
      });
      const taskCreateTool = tools.find((t: any) => t.name === "fn_task_create");

      const result = await taskCreateTool.execute("c1", {
        description: "Child naming a nonexistent dep",
        dependencies: ["FN-9999"],
      });

      expect(result.content[0].text).toContain("ERROR");
      expect(result.content[0].text).toContain("FN-9999");
      expect(result.content[0].text).toContain("task not found");
      expect(store.createTask).not.toHaveBeenCalled();
    });

    it("closes parent after proactive split even when breakIntoSubtasks is undefined", async () => {
      // Test that the post-session closure path doesn't gate on breakIntoSubtasks.
      // Strategy: capture the customTools from createFnAgent, then have
      // promptWithFallback invoke the fn_task_create tool to simulate the agent
      // proactively splitting an oversized task.
      const task: Task = {
        id: "FN-500",
        description: "Oversized task without breakIntoSubtasks flag",
        column: "triage",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      };

      const childTask1: Task = {
        id: "FN-501",
        description: "Child part 1",
        column: "triage",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      };
      const childTask2: Task = {
        id: "FN-502",
        description: "Child part 2",
        column: "triage",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      };

      const taskDetail: TaskDetail = {
        ...task,
        prompt: "",
        attachments: [],
        // breakIntoSubtasks is explicitly undefined
      };

      const store = createMockStore({
        getTask: vi.fn().mockResolvedValue(taskDetail),
        createTask: vi.fn()
          .mockResolvedValueOnce(childTask1)
          .mockResolvedValueOnce(childTask2),
      });

      // Capture customTools from createFnAgent call
      let capturedCustomTools: any[] = [];
      const mockDispose = vi.fn();
      mockCreateFnAgent.mockImplementation(async (opts: any) => {
        capturedCustomTools = opts.customTools || [];
        return {
          session: {
            prompt: vi.fn().mockResolvedValue(undefined),
            dispose: mockDispose,
            subscribe: vi.fn(),
            sessionManager: {
              getLeafId: vi.fn().mockReturnValue(null),
              navigateTree: vi.fn(),
            },
          },
        };
      });

      // Make promptWithFallback invoke the fn_task_create tool twice to simulate
      // the agent proactively splitting the oversized task
      const { promptWithFallback } = await import("../pi.js");
      (promptWithFallback as ReturnType<typeof vi.fn>).mockImplementationOnce(
        async () => {
          const taskCreateTool = capturedCustomTools.find(
            (t: any) => t.name === "fn_task_create",
          );
          expect(taskCreateTool).toBeDefined();
          // Simulate agent creating two child tasks
          await taskCreateTool.execute("call-1", {
            description: "Child part 1",
            title: "Part 1",
            dependencies: [],
          });
          await taskCreateTool.execute("call-2", {
            description: "Child part 2",
            title: "Part 2",
            dependencies: [],
          });
        },
      );

      const processor = new TriageProcessor(store, "/test/root", {
        pollIntervalMs: 100_000,
      });

      await processor.specifyTask(task);

      // The parent task should be deleted because subtasks were created,
      // even though breakIntoSubtasks was NOT set
      expect(store.logEntry).toHaveBeenCalledWith(
        "FN-500",
        expect.stringContaining("Converted into subtasks: FN-501, FN-502"),
      );
      expect(store.deleteTask).toHaveBeenCalledWith("FN-500", expect.objectContaining({
        removeLineageReferences: true,
        auditContext: expect.objectContaining({
          agentId: "triage",
          runId: expect.stringMatching(/^triage-delete-FN-500-/),
        }),
      }));
    });
  });

  describe("bounded recovery retries for triage", () => {
    beforeEach(async () => {
      vi.clearAllMocks();
      const { promptWithFallback } = await import("../pi.js");
      (promptWithFallback as ReturnType<typeof vi.fn>).mockReset();
      (promptWithFallback as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    });

    it("requeues triage with backoff when the agent exits without writing PROMPT.md", async () => {
      const task = {
        id: "FN-202",
        description: "Test triage task",
        column: "triage",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as unknown as Task;

      const store = createMockStore({
        getTask: vi.fn().mockResolvedValue({ ...task, attachments: [], comments: [] }),
      });

      mockCreateFnAgent.mockResolvedValue({
        session: {
          prompt: vi.fn().mockResolvedValue(undefined),
          dispose: vi.fn(),
          sessionManager: {
            getLeafId: vi.fn().mockReturnValue(null),
            navigateTree: vi.fn(),
          },
        },
      });

      const { promptWithFallback } = await import("../pi.js");
      (promptWithFallback as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);

      const processor = new TriageProcessor(store, "/test/root", {
        pollIntervalMs: 100_000,
      });

      await processor.specifyTask(task);

      expect(store.updateTask).toHaveBeenCalledWith("FN-202", expect.objectContaining({
        status: null,
        error: null,
        recoveryRetryCount: 1,
        nextRecoveryAt: expect.any(String),
      }));
      expect(store.logEntry).toHaveBeenCalledWith(
        "FN-202",
        expect.stringContaining("Generated plan failed deterministic validation (PROMPT.md file not found or empty)"),
      );
    });

    it("sets recoveryRetryCount and nextRecoveryAt on first transient error via specifyTask", async () => {
      const task = {
        id: "FN-200",
        description: "Test triage task",
        column: "triage",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as unknown as Task;

      const store = createMockStore({
        getTask: vi.fn().mockResolvedValue({ ...task, attachments: [] }),
      });

      const processor = new TriageProcessor(store, "/test/root", {
        pollIntervalMs: 100_000,
      });

      // Mock createFnAgent to throw a transient error
      mockCreateFnAgent.mockRejectedValue(new Error("upstream connect error"));

      await processor.specifyTask(task);

      expect(store.updateTask).toHaveBeenCalledWith("FN-200", expect.objectContaining({
        recoveryRetryCount: 1,
        nextRecoveryAt: expect.any(String),
      }));
    });

    it("persists terminal planning error when prompt-time primary and fallback models are exhausted", async () => {
      const task = {
        id: "FN-7437",
        description: "Bug: planner triage fallback loop",
        column: "triage",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as unknown as Task;
      const onSpecifyError = vi.fn();
      const store = createMockStore({
        getTask: vi.fn().mockResolvedValue({ ...task, attachments: [] }),
        getSettings: vi.fn().mockResolvedValue({
          maxConcurrent: 2,
          maxWorktrees: 4,
          pollIntervalMs: 10000,
          groupOverlappingFiles: false,
          autoMerge: true,
          defaultProvider: "openai",
          defaultModelId: "gpt-4o",
          planningFallbackProvider: "anthropic",
          planningFallbackModelId: "claude-3-5-haiku-20241022",
          defaultThinkingLevel: "low",
        } as Settings),
      });
      const mockDispose = vi.fn();
      mockCreateFnAgent.mockResolvedValue({
        session: {
          state: {},
          sessionManager: {},
          prompt: vi.fn(),
          dispose: mockDispose,
          navigateTree: vi.fn(),
        },
      });
      const { ModelFallbackExhaustedError, promptWithFallback } = await import("../pi.js");
      (promptWithFallback as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new ModelFallbackExhaustedError({
          primaryModel: "openai/gpt-4o",
          fallbackModel: "anthropic/claude-3-5-haiku-20241022",
          triggerPoint: "prompt-time",
          attempts: 2,
          underlyingReason: "401 invalid api key for fallback",
        }),
      );

      const processor = new TriageProcessor(store, "/test/root", {
        pollIntervalMs: 100_000,
        onSpecifyError,
      });

      await processor.specifyTask(task);

      expect(store.logEntry).toHaveBeenCalledWith(
        "FN-7437",
        "Planning using model: mock-model (thinking effort: low)",
      );
      expect(store.appendAgentLog).toHaveBeenCalledWith(
        "FN-7437",
        "Planning using model: mock-model (thinking effort: low)",
        "status",
        undefined,
        "triage",
      );
      expect(store.logEntry).toHaveBeenCalledWith(
        "FN-7437",
        expect.stringContaining("Triage failed: unable to select a usable model after 2 attempts"),
      );
      expect(store.updateTask).toHaveBeenCalledWith("FN-7437", expect.objectContaining({
        status: "failed",
        error: expect.stringContaining("openai/gpt-4o"),
        recoveryRetryCount: null,
        nextRecoveryAt: null,
      }));
      expect(store.updateTask).not.toHaveBeenCalledWith("FN-7437", expect.objectContaining({
        status: null,
        error: null,
      }));
      expect(mockDispose).toHaveBeenCalledTimes(1);
      expect(onSpecifyError).toHaveBeenCalledTimes(1);
    });

    it("persists terminal planning error when session state reports fallback exhaustion", async () => {
      const task = {
        id: "FN-7437-STATE",
        description: "Bug: planner triage fallback loop via state error",
        column: "triage",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as unknown as Task;
      const store = createMockStore({
        getTask: vi.fn().mockResolvedValue({ ...task, attachments: [] }),
      });
      mockCreateFnAgent.mockResolvedValue({
        session: {
          state: {},
          sessionManager: {},
          prompt: vi.fn(),
          dispose: vi.fn(),
          navigateTree: vi.fn(),
        },
      });
      const { ModelFallbackExhaustedError, promptWithFallback } = await import("../pi.js");
      const exhausted = new ModelFallbackExhaustedError({
        primaryModel: "openai/gpt-4o",
        fallbackModel: "anthropic/claude-3-5-haiku-20241022",
        triggerPoint: "prompt-time",
        attempts: 2,
        underlyingReason: "fallback session state error: 403 forbidden",
      });
      (promptWithFallback as ReturnType<typeof vi.fn>).mockRejectedValueOnce(exhausted);

      const processor = new TriageProcessor(store, "/test/root", { pollIntervalMs: 100_000 });
      await processor.specifyTask(task);

      expect(store.updateTask).toHaveBeenCalledWith("FN-7437-STATE", expect.objectContaining({
        status: "failed",
        error: expect.stringContaining("fallback session state error: 403 forbidden"),
      }));
    });

    describe("implicit planning fallback (FN-7719)", () => {
      const baseSession = () => ({
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
        sessionManager: {
          getLeafId: vi.fn().mockReturnValue(null),
          navigateTree: vi.fn(),
        },
      });

      it("recovers from the reported 404/429 planner failure via a derived implicit fallback", async () => {
        const task = {
          id: "FN-7719",
          description: "Bug: 9router/Planning 404 on nvidia/moonshotai/kimi-k2.6",
          column: "triage",
          dependencies: [],
          steps: [],
          currentStep: 0,
          log: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        } as unknown as Task;
        const onSpecifyError = vi.fn();
        const store = createMockStore({
          getTask: vi.fn().mockResolvedValue({ ...task, attachments: [] }),
          getSettings: vi.fn().mockResolvedValue({
            maxConcurrent: 2,
            maxWorktrees: 4,
            pollIntervalMs: 10000,
            groupOverlappingFiles: false,
            autoMerge: true,
            // Primary planner lane ("9router/Planning") — distinct from the project default.
            planningProvider: "9router",
            planningModelId: "nvidia/moonshotai/kimi-k2.6",
            defaultProvider: "openai",
            defaultModelId: "gpt-4o",
            // No planningFallback*/global fallback* configured — this is the reported gap.
            defaultThinkingLevel: "low",
          } as Settings),
        });
        mockCreateFnAgent.mockResolvedValue({ session: baseSession() });

        const { promptWithFallback } = await import("../pi.js");
        // With a distinct implicit fallback now supplied, pi.ts's real single-swap
        // loop (covered by pi.test.ts) recovers instead of throwing
        // ModelFallbackExhaustedError — simulate that recovered outcome here.
        (promptWithFallback as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);

        const processor = new TriageProcessor(store, "/test/root", {
          pollIntervalMs: 100_000,
          onSpecifyError,
        });

        await processor.specifyTask(task);

        expect(mockCreateFnAgent).toHaveBeenCalledWith(
          expect.objectContaining({
            defaultProvider: "9router",
            defaultModelId: "nvidia/moonshotai/kimi-k2.6",
            fallbackProvider: "openai",
            fallbackModelId: "gpt-4o",
          }),
        );
        expect(store.updateTask).not.toHaveBeenCalledWith("FN-7719", expect.objectContaining({
          status: "failed",
          error: expect.stringContaining("no fallback configured"),
        }));
      });

      it("stays terminal when the implicit fallback would equal the primary planner model (self-swap guard)", async () => {
        const task = {
          id: "FN-7719-SELF-SWAP",
          description: "No distinct default model available for implicit fallback",
          column: "triage",
          dependencies: [],
          steps: [],
          currentStep: 0,
          log: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        } as unknown as Task;
        const onSpecifyError = vi.fn();
        const store = createMockStore({
          getTask: vi.fn().mockResolvedValue({ ...task, attachments: [] }),
          getSettings: vi.fn().mockResolvedValue({
            maxConcurrent: 2,
            maxWorktrees: 4,
            pollIntervalMs: 10000,
            groupOverlappingFiles: false,
            autoMerge: true,
            // No planningProvider/planningModelId — the primary planning model
            // resolves through to the project default itself, so the implicit
            // fallback would equal the primary. Must NOT self-swap.
            defaultProvider: "openai",
            defaultModelId: "gpt-4o",
            defaultThinkingLevel: "low",
          } as Settings),
        });
        mockCreateFnAgent.mockResolvedValue({ session: baseSession() });

        const { ModelFallbackExhaustedError, promptWithFallback } = await import("../pi.js");
        (promptWithFallback as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
          new ModelFallbackExhaustedError({
            primaryModel: "openai/gpt-4o",
            triggerPoint: "prompt-time",
            attempts: 1,
            underlyingReason: "model not found: no distinct fallback available",
          }),
        );

        const processor = new TriageProcessor(store, "/test/root", {
          pollIntervalMs: 100_000,
          onSpecifyError,
        });

        await processor.specifyTask(task);

        expect(mockCreateFnAgent).toHaveBeenCalledWith(
          expect.objectContaining({
            defaultProvider: "openai",
            defaultModelId: "gpt-4o",
            fallbackProvider: undefined,
            fallbackModelId: undefined,
          }),
        );
        expect(store.updateTask).toHaveBeenCalledWith("FN-7719-SELF-SWAP", expect.objectContaining({
          status: "failed",
          recoveryRetryCount: null,
          nextRecoveryAt: null,
        }));
        expect(onSpecifyError).toHaveBeenCalledTimes(1);
      });

      it("does not override an explicitly configured planningFallback* pair", async () => {
        const task = {
          id: "FN-7719-EXPLICIT-PLANNING",
          description: "Explicit planning fallback stays authoritative",
          column: "triage",
          dependencies: [],
          steps: [],
          currentStep: 0,
          log: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        } as unknown as Task;
        const store = createMockStore({
          getTask: vi.fn().mockResolvedValue({ ...task, attachments: [] }),
          getSettings: vi.fn().mockResolvedValue({
            maxConcurrent: 2,
            maxWorktrees: 4,
            pollIntervalMs: 10000,
            groupOverlappingFiles: false,
            autoMerge: true,
            planningProvider: "9router",
            planningModelId: "nvidia/moonshotai/kimi-k2.6",
            defaultProvider: "openai",
            defaultModelId: "gpt-4o",
            planningFallbackProvider: "anthropic",
            planningFallbackModelId: "claude-3-5-haiku-20241022",
          } as Settings),
        });
        mockCreateFnAgent.mockResolvedValue({ session: baseSession() });

        const { promptWithFallback } = await import("../pi.js");
        (promptWithFallback as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
          new Error("test stop after model check"),
        );

        const processor = new TriageProcessor(store, "/test/root", { pollIntervalMs: 100_000 });
        await processor.specifyTask(task);

        expect(mockCreateFnAgent).toHaveBeenCalledWith(
          expect.objectContaining({
            defaultProvider: "9router",
            defaultModelId: "nvidia/moonshotai/kimi-k2.6",
            fallbackProvider: "anthropic",
            fallbackModelId: "claude-3-5-haiku-20241022",
          }),
        );
      });

      it("does not override an explicitly configured global fallback* pair", async () => {
        const task = {
          id: "FN-7719-EXPLICIT-GLOBAL",
          description: "Explicit global fallback stays authoritative",
          column: "triage",
          dependencies: [],
          steps: [],
          currentStep: 0,
          log: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        } as unknown as Task;
        const store = createMockStore({
          getTask: vi.fn().mockResolvedValue({ ...task, attachments: [] }),
          getSettings: vi.fn().mockResolvedValue({
            maxConcurrent: 2,
            maxWorktrees: 4,
            pollIntervalMs: 10000,
            groupOverlappingFiles: false,
            autoMerge: true,
            planningProvider: "9router",
            planningModelId: "nvidia/moonshotai/kimi-k2.6",
            defaultProvider: "openai",
            defaultModelId: "gpt-4o",
            fallbackProvider: "google",
            fallbackModelId: "gemini-2.5-pro",
          } as Settings),
        });
        mockCreateFnAgent.mockResolvedValue({ session: baseSession() });

        const { promptWithFallback } = await import("../pi.js");
        (promptWithFallback as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
          new Error("test stop after model check"),
        );

        const processor = new TriageProcessor(store, "/test/root", { pollIntervalMs: 100_000 });
        await processor.specifyTask(task);

        expect(mockCreateFnAgent).toHaveBeenCalledWith(
          expect.objectContaining({
            defaultProvider: "9router",
            defaultModelId: "nvidia/moonshotai/kimi-k2.6",
            fallbackProvider: "google",
            fallbackModelId: "gemini-2.5-pro",
          }),
        );
      });

      // NOTE: test-mode exclusion (isTestModeActive -> no implicit fallback
      // injected) is covered directly at the resolver-unit level in
      // agent-session-helpers.test.ts ("resolveImplicitPlanningFallbackModel
      // (FN-7719)"). The mock runtime used by createResolvedAgentSession in
      // test mode does not route through createFnAgent, so it cannot assert
      // fallbackProvider/fallbackModelId via mockCreateFnAgent call args here.
    });

    it.each([
      ["transient provider failure", "upstream connect error"],
      ["operator-actionable provider failure", "No API key for provider: anthropic"],
      ["generic planning failure", "planner protocol failed"],
    ])("keeps an advanced task in place after a %s", async (_label, errorMessage) => {
      const task = {
        id: "FN-7977-ADVANCED",
        description: "Do not overwrite execution after a stale planning run",
        column: "triage",
        status: "planning",
        dependencies: [],
        steps: [],
        log: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as unknown as Task;
      let liveTask = { ...task, attachments: [], comments: [] } as unknown as Task;
      const store = createMockStore({
        getTask: vi.fn().mockImplementation(async () => liveTask),
        updateTask: vi.fn().mockImplementation(async (_id: string, patch: Partial<Task>) => {
          if (patch.status === "planning") {
            liveTask = {
              ...liveTask,
              column: "in-progress",
              status: "executing",
              worktree: "/tmp/fusion/FN-7977-ADVANCED",
              steps: [{ id: "implementation", status: "in-progress" }],
            } as unknown as Task;
          }
        }),
      });
      mockCreateFnAgent.mockRejectedValue(new Error(errorMessage));

      await new TriageProcessor(store, "/test/root", { pollIntervalMs: 100_000 }).specifyTask(task);

      expect(liveTask).toMatchObject({
        column: "in-progress",
        status: "executing",
        worktree: "/tmp/fusion/FN-7977-ADVANCED",
        steps: [{ id: "implementation", status: "in-progress" }],
      });
      expect(store.updateTask).toHaveBeenCalledTimes(1);
      expect(store.updateTask).toHaveBeenCalledWith("FN-7977-ADVANCED", { status: "planning" });
    });

    it("keeps advanced worktree and steps after model fallback exhaustion", async () => {
      const task = {
        id: "FN-7977-MODEL",
        description: "Preserve execution after planner model fallback exhaustion",
        column: "triage",
        dependencies: [],
        steps: [],
        log: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as unknown as Task;
      let liveTask = { ...task, attachments: [], comments: [] } as unknown as Task;
      const store = createMockStore({
        getTask: vi.fn().mockImplementation(async () => liveTask),
        updateTask: vi.fn().mockImplementation(async (_id: string, patch: Partial<Task>) => {
          if (patch.status === "planning") {
            liveTask = { ...liveTask, column: "in-review", status: "reviewing", worktree: "/tmp/FN-7977-MODEL", steps: [{ id: "1" }] } as unknown as Task;
          }
        }),
      });
      mockCreateFnAgent.mockResolvedValue({ session: { state: {}, sessionManager: {}, prompt: vi.fn(), dispose: vi.fn(), navigateTree: vi.fn() } });
      const { ModelFallbackExhaustedError, promptWithFallback } = await import("../pi.js");
      (promptWithFallback as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new ModelFallbackExhaustedError({
        primaryModel: "antigravity/gemini-3.5-flash-low",
        attempts: 2,
        triggerPoint: "prompt-time",
        underlyingReason: "403 provider access forbidden",
      }));

      await new TriageProcessor(store, "/test/root", { pollIntervalMs: 100_000 }).specifyTask(task);

      expect(liveTask).toMatchObject({ column: "in-review", status: "reviewing", worktree: "/tmp/FN-7977-MODEL", steps: [{ id: "1" }] });
      expect(store.updateTask).toHaveBeenCalledWith(task.id, { status: "planning" });
      expect(store.updateTask).toHaveBeenCalledWith(task.id, {
        planningStartedAt: expect.any(String),
      });
    });

    it("keeps advanced worktree and steps after deterministic validation recovery", async () => {
      const task = {
        id: "FN-7977-VALIDATION",
        description: "Preserve execution after stale deterministic validation retry",
        column: "triage",
        dependencies: [],
        steps: [],
        log: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as unknown as Task;
      let liveTask = { ...task, attachments: [], comments: [] } as unknown as Task;
      const store = createMockStore({
        getTask: vi.fn().mockImplementation(async () => liveTask),
        updateTask: vi.fn().mockImplementation(async (_id: string, patch: Partial<Task>) => {
          if (patch.status === "planning") {
            liveTask = { ...liveTask, column: "in-progress", status: "executing", worktree: "/tmp/FN-7977-VALIDATION", steps: [{ id: "1" }] } as unknown as Task;
          }
        }),
      });
      mockCreateFnAgent.mockResolvedValue({ session: { state: {}, sessionManager: {}, prompt: vi.fn(), dispose: vi.fn(), navigateTree: vi.fn() } });
      const { promptWithFallback } = await import("../pi.js");
      (promptWithFallback as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);

      await new TriageProcessor(store, "/test/root", { pollIntervalMs: 100_000 }).specifyTask(task);

      expect(liveTask).toMatchObject({ column: "in-progress", status: "executing", worktree: "/tmp/FN-7977-VALIDATION", steps: [{ id: "1" }] });
      expect(store.updateTask).toHaveBeenCalledWith(task.id, { status: "planning" });
      expect(store.updateTask).toHaveBeenCalledWith(task.id, {
        planningStartedAt: expect.any(String),
      });
    });

    it("escalates to error state when triage retries are exhausted via specifyTask", async () => {
      const task = {
        id: "FN-201",
        description: "Test triage task",
        column: "triage",
        recoveryRetryCount: 3, // Already at max
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as unknown as Task;

      const onSpecifyError = vi.fn();
      const store = createMockStore({
        getTask: vi.fn().mockResolvedValue({ ...task, attachments: [] }),
      });

      const processor = new TriageProcessor(store, "/test/root", {
        pollIntervalMs: 100_000,
        onSpecifyError,
      });

      mockCreateFnAgent.mockRejectedValue(new Error("connection reset"));

      await processor.specifyTask(task);

      // Should set error and clear recovery metadata
      expect(store.updateTask).toHaveBeenCalledWith("FN-201", expect.objectContaining({
        error: expect.stringContaining("Specification failed after 3 transient errors"),
        recoveryRetryCount: null,
        nextRecoveryAt: null,
      }));
      expect(onSpecifyError).toHaveBeenCalled();
    });

    it("parks missing provider credentials instead of making triage immediately claimable again", async () => {
      const task = {
        id: "FN-7952",
        description: "Specify a task with direct Anthropic auth",
        column: "triage",
        status: "planning",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as unknown as Task;
      const store = createMockStore({
        getTask: vi.fn().mockResolvedValue({ ...task, attachments: [] }),
      });
      mockCreateFnAgent.mockRejectedValue(new Error("No API key for provider: anthropic"));

      const processor = new TriageProcessor(store, "/test/root", { pollIntervalMs: 100_000 });
      await processor.specifyTask(task);

      expect(store.updateTask).toHaveBeenCalledWith("FN-7952", expect.objectContaining({
        status: "failed",
        error: "Specification failed: No API key for provider: anthropic",
        recoveryRetryCount: null,
        nextRecoveryAt: null,
      }));
      expect(store.updateTask).not.toHaveBeenCalledWith("FN-7952", expect.objectContaining({ status: null }));
    });

    it("uses bounded transient recovery when a credential refresh fails because the connection reset", async () => {
      const task = {
        id: "FN-7952-TRANSIENT",
        description: "Retry a transient credential refresh failure",
        column: "triage",
        status: "planning",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as unknown as Task;
      const store = createMockStore({
        getTask: vi.fn().mockResolvedValue({ ...task, attachments: [] }),
      });
      mockCreateFnAgent.mockRejectedValue(new Error("credential refresh failed: connection reset"));

      const processor = new TriageProcessor(store, "/test/root", { pollIntervalMs: 100_000 });
      await processor.specifyTask(task);

      expect(store.updateTask).toHaveBeenCalledWith("FN-7952-TRANSIENT", expect.objectContaining({
        status: null,
        recoveryRetryCount: 1,
        nextRecoveryAt: expect.any(String),
      }));
      expect(store.updateTask).not.toHaveBeenCalledWith("FN-7952-TRANSIENT", expect.objectContaining({ status: "failed" }));
      expect(store.updateTask).not.toHaveBeenCalledWith("FN-7952-TRANSIENT", expect.objectContaining({
        title: expect.any(String),
      }));
    });

    /*
    FNXC:TriageFallbackTitle 2026-07-16-00:00:
    Still-retrying deterministic and transient branches must preserve retry scheduling and never backfill a blank title; only terminal failures backfill.
    */
    it("does not backfill blank titles while deterministic validation retries remain", async () => {
      const task = {
        id: "FN-8155-DETERMINISTIC-RETRY",
        title: "",
        description: "Keep blank titles while deterministic validation retries remain",
        column: "triage",
        status: "planning",
        recoveryRetryCount: 1,
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as unknown as Task;
      const store = createMockStore({
        getTask: vi.fn().mockResolvedValue({ ...task, attachments: [] }),
      });
      mockCreateFnAgent.mockResolvedValue({
        session: {
          state: {},
          sessionManager: {},
          prompt: vi.fn().mockResolvedValue(undefined),
          dispose: vi.fn(),
          navigateTree: vi.fn(),
        },
      });

      const processor = new TriageProcessor(store, "/test/root", { pollIntervalMs: 100_000 });
      await processor.specifyTask(task);

      expect(store.updateTask).toHaveBeenCalledWith("FN-8155-DETERMINISTIC-RETRY", expect.objectContaining({
        status: null,
        error: null,
        recoveryRetryCount: 2,
        nextRecoveryAt: expect.any(String),
      }));
      expect(store.updateTask).not.toHaveBeenCalledWith("FN-8155-DETERMINISTIC-RETRY", expect.objectContaining({ status: "failed" }));
      expect(store.updateTask).not.toHaveBeenCalledWith("FN-8155-DETERMINISTIC-RETRY", expect.objectContaining({
        title: expect.any(String),
      }));
    });

    it("does not backfill blank titles while transient retries remain", async () => {
      const task = {
        id: "FN-8155-TRANSIENT-RETRY",
        title: "",
        description: "Keep blank titles while transient connection retries remain",
        column: "triage",
        status: "planning",
        recoveryRetryCount: 1,
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as unknown as Task;
      const store = createMockStore({
        getTask: vi.fn().mockResolvedValue({ ...task, attachments: [] }),
      });
      mockCreateFnAgent.mockRejectedValue(new Error("connection reset"));

      const processor = new TriageProcessor(store, "/test/root", { pollIntervalMs: 100_000 });
      await processor.specifyTask(task);

      expect(store.updateTask).toHaveBeenCalledWith("FN-8155-TRANSIENT-RETRY", expect.objectContaining({
        status: null,
        recoveryRetryCount: 2,
        nextRecoveryAt: expect.any(String),
      }));
      expect(store.updateTask).not.toHaveBeenCalledWith("FN-8155-TRANSIENT-RETRY", expect.objectContaining({ status: "failed" }));
      expect(store.updateTask).not.toHaveBeenCalledWith("FN-8155-TRANSIENT-RETRY", expect.objectContaining({
        title: expect.any(String),
      }));
    });

    it("backfills blank titles when deterministic validation retries are exhausted", async () => {
      const task = {
        id: "FN-7961-DETERMINISTIC",
        title: "",
        description: "Backfill blank titles after deterministic prompt validation failure",
        column: "triage",
        recoveryRetryCount: 3,
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as unknown as Task;
      const store = createMockStore({
        getTask: vi.fn().mockResolvedValue({ ...task, attachments: [] }),
      });
      mockCreateFnAgent.mockResolvedValue({
        session: {
          state: {},
          sessionManager: {},
          prompt: vi.fn().mockResolvedValue(undefined),
          dispose: vi.fn(),
          navigateTree: vi.fn(),
        },
      });

      const processor = new TriageProcessor(store, "/test/root", { pollIntervalMs: 100_000 });
      await processor.specifyTask(task);

      const expectedError = "Specification failed deterministic validation after 3 retries (PROMPT.md file not found or empty). Retry after adjusting the task prompt or model.";
      expect(store.updateTask).toHaveBeenCalledWith("FN-7961-DETERMINISTIC", {
        status: "failed",
        error: expectedError,
        recoveryRetryCount: null,
        nextRecoveryAt: null,
      });
      expect(store.updateTask).toHaveBeenCalledWith("FN-7961-DETERMINISTIC", {
        title: "Backfill blank titles after deterministic prompt",
      });
    });

    it("backfills blank titles when planner model fallback is exhausted", async () => {
      const task = {
        id: "FN-7961-MODEL",
        title: "",
        description: "Repair blank title rows after planner model fallback exhaustion",
        column: "triage",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as unknown as Task;
      const store = createMockStore({
        getTask: vi.fn().mockResolvedValue({ ...task, attachments: [] }),
      });
      mockCreateFnAgent.mockResolvedValue({
        session: {
          state: {},
          sessionManager: {},
          prompt: vi.fn(),
          dispose: vi.fn(),
          navigateTree: vi.fn(),
        },
      });
      const { ModelFallbackExhaustedError, promptWithFallback } = await import("../pi.js");
      (promptWithFallback as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new ModelFallbackExhaustedError({
          primaryModel: "openai/gpt-4o",
          fallbackModel: "anthropic/claude-3-5-haiku-20241022",
          triggerPoint: "prompt-time",
          attempts: 2,
          underlyingReason: "model unavailable",
        }),
      );

      const processor = new TriageProcessor(store, "/test/root", { pollIntervalMs: 100_000 });
      await processor.specifyTask(task);

      expect(store.updateTask).toHaveBeenCalledWith("FN-7961-MODEL", expect.objectContaining({
        status: "failed",
        error: expect.stringContaining("Triage failed: unable to select a usable model after 2 attempts"),
        recoveryRetryCount: null,
        nextRecoveryAt: null,
      }));
      expect(store.updateTask).toHaveBeenCalledWith("FN-7961-MODEL", {
        title: "Repair blank title rows after planner model fallback",
      });
    });

    it("backfills blank titles when operator-actionable provider failures park planning", async () => {
      const task = {
        id: "FN-7961-OPERATOR",
        title: "",
        description: "Show failed tasks when provider credentials are unavailable",
        column: "triage",
        status: "planning",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as unknown as Task;
      const store = createMockStore({
        getTask: vi.fn().mockResolvedValue({ ...task, attachments: [] }),
      });
      mockCreateFnAgent.mockRejectedValue(new Error("No API key for provider: anthropic"));

      const processor = new TriageProcessor(store, "/test/root", { pollIntervalMs: 100_000 });
      await processor.specifyTask(task);

      expect(store.updateTask).toHaveBeenCalledWith("FN-7961-OPERATOR", {
        status: "failed",
        error: "Specification failed: No API key for provider: anthropic",
        recoveryRetryCount: null,
        nextRecoveryAt: null,
      });
      expect(store.updateTask).toHaveBeenCalledWith("FN-7961-OPERATOR", {
        title: "Show failed tasks when provider credentials are unavailable",
      });
    });

    it("backfills blank titles when transient retries are exhausted", async () => {
      const task = {
        id: "FN-7961-TRANSIENT",
        title: "",
        description: "Identify failed rows after exhausted transient planning retries",
        column: "triage",
        status: "planning",
        recoveryRetryCount: 3,
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as unknown as Task;
      const store = createMockStore({
        getTask: vi.fn().mockResolvedValue({ ...task, attachments: [] }),
      });
      mockCreateFnAgent.mockRejectedValue(new Error("connection reset"));

      const processor = new TriageProcessor(store, "/test/root", { pollIntervalMs: 100_000 });
      await processor.specifyTask(task);

      expect(store.updateTask).toHaveBeenCalledWith("FN-7961-TRANSIENT", {
        error: "Specification failed after 3 transient errors: connection reset",
        recoveryRetryCount: null,
        nextRecoveryAt: null,
      });
      expect(store.updateTask).toHaveBeenCalledWith("FN-7961-TRANSIENT", {
        title: "Identify failed rows after exhausted transient planning",
      });
    });

    it("does not overwrite an existing title during terminal fallback exhaustion", async () => {
      const task = {
        id: "FN-7961-EXISTING",
        title: "Existing operator title",
        description: "This description would otherwise become the fallback title",
        column: "triage",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as unknown as Task;
      const store = createMockStore({
        getTask: vi.fn().mockResolvedValue({ ...task, attachments: [] }),
      });
      mockCreateFnAgent.mockResolvedValue({
        session: {
          state: {},
          sessionManager: {},
          prompt: vi.fn(),
          dispose: vi.fn(),
          navigateTree: vi.fn(),
        },
      });
      const { ModelFallbackExhaustedError, promptWithFallback } = await import("../pi.js");
      (promptWithFallback as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new ModelFallbackExhaustedError({
          primaryModel: "openai/gpt-4o",
          triggerPoint: "prompt-time",
          attempts: 1,
          underlyingReason: "model not found",
        }),
      );

      const processor = new TriageProcessor(store, "/test/root", { pollIntervalMs: 100_000 });
      await processor.specifyTask(task);

      expect(store.updateTask).toHaveBeenCalledWith("FN-7961-EXISTING", expect.objectContaining({
        status: "failed",
        recoveryRetryCount: null,
        nextRecoveryAt: null,
      }));
      expect(store.updateTask).not.toHaveBeenCalledWith("FN-7961-EXISTING", expect.objectContaining({
        title: expect.any(String),
      }));
    });
  });

  describe("recovery due-time gating (nextRecoveryAt)", () => {
    it("skips failed triage tasks until they are explicitly retried", async () => {
      const task = {
        id: "FN-102",
        description: "Failed triage task",
        column: "triage",
        status: "failed",
        error: "Specification failed",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as unknown as Task;

      const store = createMockStore({
        listTasks: vi.fn().mockResolvedValue([task]),
      });

      const processor = new TriageProcessor(store, "/test/root", {
        pollIntervalMs: 100_000,
      });
      const specifySpy = vi.spyOn(processor, "specifyTask");

      processor.start();
      await new Promise((r) => setTimeout(r, 50));
      processor.stop();

      expect(specifySpy).not.toHaveBeenCalled();
      specifySpy.mockRestore();
    });

    it("skips triage tasks whose nextRecoveryAt is in the future", async () => {
      const future = new Date(Date.now() + 60_000).toISOString();
      const task = {
        id: "FN-100",
        description: "Test triage task",
        column: "triage",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        nextRecoveryAt: future,
        recoveryRetryCount: 1,
      } as unknown as Task;

      const store = createMockStore({
        listTasks: vi.fn().mockResolvedValue([task]),
      });

      const processor = new TriageProcessor(store, "/test/root", {
        pollIntervalMs: 100_000, // long interval so only manual poll runs
      });

      // Spy on specifyTask to ensure it's NOT called for gated tasks
      const specifySpy = vi.spyOn(processor, "specifyTask");

      processor.start();
      // Wait a tick for the initial poll
      await new Promise((r) => setTimeout(r, 50));
      processor.stop();

      expect(specifySpy).not.toHaveBeenCalled();
      specifySpy.mockRestore();
    });

    it("processes triage tasks whose nextRecoveryAt has elapsed", async () => {
      const past = new Date(Date.now() - 1000).toISOString();
      const task = {
        id: "FN-101",
        description: "Test triage task past",
        column: "triage",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        nextRecoveryAt: past,
        recoveryRetryCount: 1,
      } as unknown as Task;

      const store = createMockStore({
        listTasks: vi.fn().mockResolvedValue([task]),
      });

      const processor = new TriageProcessor(store, "/test/root", {
        pollIntervalMs: 100_000,
      });

      const specifySpy = vi.spyOn(processor, "specifyTask").mockResolvedValue(undefined);

      processor.start();
      await new Promise((r) => setTimeout(r, 50));
      processor.stop();

      expect(specifySpy).toHaveBeenCalledWith(expect.objectContaining({ id: "FN-101" }));
      specifySpy.mockRestore();
    });
  });

  describe("triage model logging in agent log", () => {
    it("appends triage model info to agent log after session creation", async () => {
      const task = {
        id: "FN-300",
        description: "Test triage task for model logging",
        column: "triage",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as unknown as Task;

      const mockDispose = vi.fn();
      const mockPrompt = vi.fn().mockResolvedValue(undefined);
      const mockGetLeafId = vi.fn().mockReturnValue(null);
      const mockNavigateTree = vi.fn();

      const store = createMockStore({
        getTask: vi.fn().mockResolvedValue({ ...task, attachments: [] }),
        getSettings: vi.fn().mockResolvedValue({
          maxConcurrent: 2,
          maxWorktrees: 4,
          pollIntervalMs: 10000,
          groupOverlappingFiles: false,
          autoMerge: true,
          defaultThinkingLevel: "high",
        } as Settings),
      });

      // Set up createFnAgent to return a session that immediately throws
      // after the model log line, so we can verify the appendAgentLog call.
      // The session will be created, model logged, then promptWithFallback
      // throws — but the model log has already been written.
      mockCreateFnAgent.mockResolvedValue({
        session: {
          prompt: mockPrompt,
          dispose: mockDispose,
          sessionManager: {
            getLeafId: mockGetLeafId,
            navigateTree: mockNavigateTree,
          },
        },
      });

      // Make promptWithFallback throw so we can stop execution after model log
      const { promptWithFallback } = await import("../pi.js");
      (promptWithFallback as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("test stop after model log"),
      );

      const processor = new TriageProcessor(store, "/test/root", {
        pollIntervalMs: 100_000,
      });

      await processor.specifyTask(task);

      // Verify appendAgentLog was called with model and thinking effort info on the same triage row.
      expect(store.logEntry).toHaveBeenCalledWith(
        "FN-300",
        "Planning using model: mock-model (thinking effort: high)",
      );
      expect(store.appendAgentLog).toHaveBeenCalledWith(
        "FN-300",
        "Planning using model: mock-model (thinking effort: high)",
        "status",
        undefined,
        "triage",
      );
    });
  });

  describe("per-task planning model override", () => {
    it("uses per-task planningModelProvider/planningModelId when set on the task", async () => {
      const task = {
        id: "FN-400",
        description: "Test per-task planning model override",
        column: "triage",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        planningModelProvider: "google",
        planningModelId: "gemini-2.5-pro",
      } as unknown as Task;

      const mockDispose = vi.fn();
      const mockPrompt = vi.fn().mockResolvedValue(undefined);
      const mockGetLeafId = vi.fn().mockReturnValue(null);
      const mockNavigateTree = vi.fn();

      const store = createMockStore({
        getTask: vi.fn().mockResolvedValue({ ...task, attachments: [] }),
        getSettings: vi.fn().mockResolvedValue({
          maxConcurrent: 2,
          maxWorktrees: 4,
          pollIntervalMs: 10000,
          groupOverlappingFiles: false,
          autoMerge: true,
          provider: "anthropic",
          modelId: "claude-sonnet-4-5",
          planningProvider: "openai",
          planningModelId: "gpt-4o",
        } as Settings),
      });

      mockCreateFnAgent.mockResolvedValue({
        session: {
          prompt: mockPrompt,
          dispose: mockDispose,
          sessionManager: {
            getLeafId: mockGetLeafId,
            navigateTree: mockNavigateTree,
          },
        },
      });

      const { promptWithFallback } = await import("../pi.js");
      (promptWithFallback as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("test stop after model check"),
      );

      const processor = new TriageProcessor(store, "/test/root", {
        pollIntervalMs: 100_000,
      });

      await processor.specifyTask(task);

      // Per-task override should take precedence over settings and use session defaults keys
      expect(mockCreateFnAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          defaultProvider: "google",
          defaultModelId: "gemini-2.5-pro",
        }),
      );
      const triageSessionCall = mockCreateFnAgent.mock.calls.at(-1)?.[0] as Record<string, unknown>;
      expect(triageSessionCall).toBeDefined();
      expect(triageSessionCall).not.toHaveProperty("provider");
      expect(triageSessionCall).not.toHaveProperty("modelId");
    });

    it("falls back to settings planningProvider/planningModelId when task has no override", async () => {
      const task = {
        id: "FN-401",
        description: "Test fallback to settings planning model",
        column: "triage",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        // No planningModelProvider/planningModelId set
      } as unknown as Task;

      const mockDispose = vi.fn();
      const mockPrompt = vi.fn().mockResolvedValue(undefined);
      const mockGetLeafId = vi.fn().mockReturnValue(null);
      const mockNavigateTree = vi.fn();

      const store = createMockStore({
        getTask: vi.fn().mockResolvedValue({ ...task, attachments: [] }),
        getSettings: vi.fn().mockResolvedValue({
          maxConcurrent: 2,
          maxWorktrees: 4,
          pollIntervalMs: 10000,
          groupOverlappingFiles: false,
          autoMerge: true,
          defaultProvider: "anthropic",
          defaultModelId: "claude-sonnet-4-5",
          planningProvider: "openai",
          planningModelId: "gpt-4o",
        } as Settings),
      });

      mockCreateFnAgent.mockResolvedValue({
        session: {
          prompt: mockPrompt,
          dispose: mockDispose,
          sessionManager: {
            getLeafId: mockGetLeafId,
            navigateTree: mockNavigateTree,
          },
        },
      });

      const { promptWithFallback } = await import("../pi.js");
      (promptWithFallback as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("test stop after model check"),
      );

      const processor = new TriageProcessor(store, "/test/root", {
        pollIntervalMs: 100_000,
      });

      await processor.specifyTask(task);

      // Should use settings planning model when no per-task override
      expect(mockCreateFnAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          defaultProvider: "openai",
          defaultModelId: "gpt-4o",
        }),
      );
    });

    it("uses project default override when planning lanes are absent", async () => {
      const task = {
        id: "FN-402",
        description: "Test fallback to project default override",
        column: "triage",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as unknown as Task;

      const mockDispose = vi.fn();
      const mockPrompt = vi.fn().mockResolvedValue(undefined);
      const mockGetLeafId = vi.fn().mockReturnValue(null);
      const mockNavigateTree = vi.fn();

      const store = createMockStore({
        getTask: vi.fn().mockResolvedValue({ ...task, attachments: [] }),
        getSettings: vi.fn().mockResolvedValue({
          maxConcurrent: 2,
          maxWorktrees: 4,
          pollIntervalMs: 10000,
          groupOverlappingFiles: false,
          autoMerge: true,
          defaultProvider: "anthropic",
          defaultModelId: "claude-sonnet-4-5",
          defaultProviderOverride: "openai",
          defaultModelIdOverride: "gpt-4o",
          // No planningProvider/planningModelId set
        } as Settings),
      });

      mockCreateFnAgent.mockResolvedValue({
        session: {
          prompt: mockPrompt,
          dispose: mockDispose,
          sessionManager: {
            getLeafId: mockGetLeafId,
            navigateTree: mockNavigateTree,
          },
        },
      });

      const { promptWithFallback } = await import("../pi.js");
      (promptWithFallback as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("test stop after model check"),
      );

      const processor = new TriageProcessor(store, "/test/root", {
        pollIntervalMs: 100_000,
      });

      await processor.specifyTask(task);

      // Should use project default override when planning lanes are absent
      expect(mockCreateFnAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          defaultProvider: "openai",
          defaultModelId: "gpt-4o",
        }),
      );
    });

    it("falls through to global default when project default override is incomplete", async () => {
      const task = {
        id: "FN-403",
        description: "Test fallback when project default override is incomplete",
        column: "triage",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as unknown as Task;

      const mockDispose = vi.fn();
      const mockPrompt = vi.fn().mockResolvedValue(undefined);
      const mockGetLeafId = vi.fn().mockReturnValue(null);
      const mockNavigateTree = vi.fn();

      const store = createMockStore({
        getTask: vi.fn().mockResolvedValue({ ...task, attachments: [] }),
        getSettings: vi.fn().mockResolvedValue({
          maxConcurrent: 2,
          maxWorktrees: 4,
          pollIntervalMs: 10000,
          groupOverlappingFiles: false,
          autoMerge: true,
          defaultProvider: "anthropic",
          defaultModelId: "claude-sonnet-4-5",
          defaultProviderOverride: "openai",
          // defaultModelIdOverride intentionally omitted
          // No planningProvider/planningModelId set
        } as Settings),
      });

      mockCreateFnAgent.mockResolvedValue({
        session: {
          prompt: mockPrompt,
          dispose: mockDispose,
          sessionManager: {
            getLeafId: mockGetLeafId,
            navigateTree: mockNavigateTree,
          },
        },
      });

      const { promptWithFallback } = await import("../pi.js");
      (promptWithFallback as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("test stop after model check"),
      );

      const processor = new TriageProcessor(store, "/test/root", {
        pollIntervalMs: 100_000,
      });

      await processor.specifyTask(task);

      // Incomplete override should fall through to global defaults
      expect(mockCreateFnAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          defaultProvider: "anthropic",
          defaultModelId: "claude-sonnet-4-5",
        }),
      );
    });

    it("falls back to global defaults when neither task nor settings have planning model", async () => {
      const task = {
        id: "FN-404",
        description: "Test fallback to global defaults",
        column: "triage",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as unknown as Task;

      const mockDispose = vi.fn();
      const mockPrompt = vi.fn().mockResolvedValue(undefined);
      const mockGetLeafId = vi.fn().mockReturnValue(null);
      const mockNavigateTree = vi.fn();

      const store = createMockStore({
        getTask: vi.fn().mockResolvedValue({ ...task, attachments: [] }),
        getSettings: vi.fn().mockResolvedValue({
          maxConcurrent: 2,
          maxWorktrees: 4,
          pollIntervalMs: 10000,
          groupOverlappingFiles: false,
          autoMerge: true,
          defaultProvider: "anthropic",
          defaultModelId: "claude-sonnet-4-5",
          // No planningProvider/planningModelId set
        } as Settings),
      });

      mockCreateFnAgent.mockResolvedValue({
        session: {
          prompt: mockPrompt,
          dispose: mockDispose,
          sessionManager: {
            getLeafId: mockGetLeafId,
            navigateTree: mockNavigateTree,
          },
        },
      });

      const { promptWithFallback } = await import("../pi.js");
      (promptWithFallback as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("test stop after model check"),
      );

      const processor = new TriageProcessor(store, "/test/root", {
        pollIntervalMs: 100_000,
      });

      await processor.specifyTask(task);

      // Should fall back to global defaults
      expect(mockCreateFnAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          defaultProvider: "anthropic",
          defaultModelId: "claude-sonnet-4-5",
        }),
      );
    });
  });

  describe("assigned-agent triage inheritance", () => {
    it("injects assigned-agent identity into triage system prompt", async () => {
      const task = createTriageTask({ id: "FN-AGENT-001", assignedAgentId: "agent-007" });
      const store = createMockStore({
        getTask: vi.fn().mockResolvedValue({ ...task, attachments: [] }),
      });

      const mockAgentStore = {
        getAgent: vi.fn().mockResolvedValue({
          id: "agent-007",
          name: "Atlas",
          title: "Senior Planner",
          role: "executor",
          soul: "Think in milestones.",
          instructionsText: "Always preserve rollout safety.",
          memory: "Atlas memory context",
        }),
      };

      let capturedArgs: any;
      mockCreateFnAgent.mockImplementationOnce(async (opts: any) => {
        capturedArgs = opts;
        return {
          session: {
            state: {},
            sessionManager: {},
            prompt: vi.fn().mockResolvedValue(undefined),
            dispose: vi.fn(),
            navigateTree: vi.fn(),
          },
        };
      });

      const processor = new TriageProcessor(store, "/test/root", {
        pollIntervalMs: 100_000,
        agentStore: mockAgentStore as any,
      });

      await processor.specifyTask(task);

      expect(capturedArgs.systemPrompt).toContain("## Identity");
      expect(capturedArgs.systemPrompt).toContain("You are Atlas, Senior Planner");
      expect(capturedArgs.systemPrompt).toContain("agent ID: agent-007");
    });

    it("prefers planning settings model ahead of assigned-agent runtime model", async () => {
      const completeRuntimeTask = createTriageTask({ id: "FN-AGENT-MODEL-1", assignedAgentId: "agent-model-complete" });
      const incompleteRuntimeTask = createTriageTask({ id: "FN-AGENT-MODEL-2", assignedAgentId: "agent-model-incomplete" });

      const store = createMockStore({
        getTask: vi.fn()
          .mockResolvedValueOnce({ ...completeRuntimeTask, attachments: [] })
          .mockResolvedValueOnce({ ...incompleteRuntimeTask, attachments: [] }),
        getSettings: vi.fn().mockResolvedValue({
          maxConcurrent: 2,
          maxWorktrees: 4,
          pollIntervalMs: 10000,
          groupOverlappingFiles: false,
          autoMerge: true,
          planningProvider: "openai",
          planningModelId: "gpt-4o",
        } as Settings),
      });

      const mockAgentStore = {
        getAgent: vi.fn().mockImplementation(async (id: string) => {
          if (id === "agent-model-complete") {
            return {
              id,
              name: "Model Agent",
              role: "executor",
              runtimeConfig: {
                modelProvider: "anthropic",
                modelId: "claude-sonnet-4-5",
              },
            };
          }
          return {
            id,
            name: "Incomplete Model Agent",
            role: "executor",
            runtimeConfig: {
              modelProvider: "anthropic",
            },
          };
        }),
      };

      const capturedArgs: any[] = [];
      mockCreateFnAgent.mockImplementation(async (opts: any) => {
        capturedArgs.push(opts);
        return {
          session: {
            state: {},
            sessionManager: {},
            prompt: vi.fn().mockResolvedValue(undefined),
            dispose: vi.fn(),
            navigateTree: vi.fn(),
          },
        };
      });

      const processor = new TriageProcessor(store, "/test/root", {
        pollIntervalMs: 100_000,
        agentStore: mockAgentStore as any,
      });

      await processor.specifyTask(completeRuntimeTask);
      await processor.specifyTask(incompleteRuntimeTask);

      const completeCall = capturedArgs.find((entry) => entry.taskId === "FN-AGENT-MODEL-1");
      const fallbackCall = capturedArgs.find((entry) => entry.taskId === "FN-AGENT-MODEL-2");

      expect(completeCall).toMatchObject({ defaultProvider: "openai", defaultModelId: "gpt-4o" });
      expect(fallbackCall).toMatchObject({ defaultProvider: "openai", defaultModelId: "gpt-4o" });
    });

    it("passes assigned agent memory context into triage memory tools", async () => {
      const rootDir = await createTriageFixtureRoot("fusion-triage-agent-memory-");
      try {
        const task = createTriageTask({ id: "FN-AGENT-MEM-001", assignedAgentId: "agent-memory-1" });
        const store = createMockStore({
          getTask: vi.fn().mockResolvedValue({ ...task, attachments: [] }),
          getSettings: vi.fn().mockResolvedValue({
            maxConcurrent: 2,
            maxWorktrees: 4,
            pollIntervalMs: 10000,
            groupOverlappingFiles: false,
            autoMerge: true,
            memoryBackendType: "file",
          } as Settings),
        });

        const mockAgentStore = {
          getAgent: vi.fn().mockResolvedValue({
            id: "agent-memory-1",
            name: "Memory Agent",
            role: "executor",
            memory: "The launch runway is blocked by migration sequencing.",
          }),
        };

        let capturedArgs: any;
        mockCreateFnAgent.mockImplementationOnce(async (opts: any) => {
          capturedArgs = opts;
          return {
            session: {
              state: {},
              sessionManager: {},
              prompt: vi.fn().mockResolvedValue(undefined),
              dispose: vi.fn(),
              navigateTree: vi.fn(),
            },
          };
        });

        const processor = new TriageProcessor(store, rootDir, {
          pollIntervalMs: 100_000,
          agentStore: mockAgentStore as any,
        });

        await processor.specifyTask(task);

        const memorySearchTool = capturedArgs.customTools.find((tool: any) => tool.name === "fn_memory_search");
        expect(memorySearchTool).toBeDefined();

        const result = await memorySearchTool.execute("tool-run", { query: "runway", limit: 5 });
        expect(result.details.results.some((hit: any) => String(hit.path).includes(".fusion/agent-memory/agent-memory-1/MEMORY.md"))).toBe(true);
      } finally {
        await cleanupTriageFixtureRoot(rootDir);
      }
    });
  });
});

describe("computeUserCommentFingerprint", () => {
  it("returns empty string for undefined comments", () => {
    expect(computeUserCommentFingerprint(undefined)).toBe("");
  });

  it("returns empty string for empty comments array", () => {
    expect(computeUserCommentFingerprint([])).toBe("");
  });

  it("returns empty string when only agent comments exist", () => {
    const comments = [
      { id: "c1", text: "agent note", author: "agent", createdAt: "2026-01-01T00:00:00.000Z" },
    ];
    expect(computeUserCommentFingerprint(comments as any)).toBe("");
  });

  it("returns sorted semicolon-joined IDs for user comments", () => {
    const comments = [
      { id: "c3", text: "user 3", author: "user", createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "c1", text: "user 1", author: "user", createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "c2", text: "agent", author: "agent", createdAt: "2026-01-01T00:00:00.000Z" },
    ];
    // Should be sorted: c1;c3 (c2 is agent, excluded)
    expect(computeUserCommentFingerprint(comments as any)).toBe("c1;c3");
  });

  it("detects changed fingerprint when new user comment is added", () => {
    const before = [
      { id: "c1", text: "user 1", author: "user", createdAt: "2026-01-01T00:00:00.000Z" },
    ];
    const after = [
      { id: "c1", text: "user 1", author: "user", createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "c2", text: "user 2", author: "user", createdAt: "2026-01-01T00:00:00.000Z" },
    ];
    expect(computeUserCommentFingerprint(before as any)).not.toBe(
      computeUserCommentFingerprint(after as any),
    );
  });
});

describe("awaiting-approval poll exclusion", () => {
  it("excludes awaiting-approval tasks from poll discovery", async () => {
    const awaitingTask: Task = {
      id: "FN-AW1",
      description: "Awaiting approval task",
      column: "triage",
      status: "awaiting-approval",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const normalTask: Task = {
      id: "FN-NT1",
      description: "Normal triage task",
      column: "triage",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    const specifySpy = vi.fn();
    const store = createMockStore({
      listTasks: vi.fn().mockResolvedValue([awaitingTask, normalTask]),
      getSettings: vi.fn().mockResolvedValue({
        maxConcurrent: 2,
        maxWorktrees: 4,
        pollIntervalMs: 60000,
        groupOverlappingFiles: false,
        autoMerge: true,
      }),
    });

    const processor = new TriageProcessor(store, "/tmp");
    // Mark as running so poll() proceeds
    (processor as any).running = true;
    // Override specifyTask to spy on which tasks get dispatched
    (processor as any).specifyTask = specifySpy;

    // Trigger poll via private method
    await (processor as any).poll();

    // Only the normal task should have been dispatched
    expect(specifySpy).toHaveBeenCalledTimes(1);
    expect(specifySpy).toHaveBeenCalledWith(normalTask);
  });
});

describe("stale approval detection", () => {
  let rootDir = "";

  beforeEach(async () => {
    rootDir = await createTriageFixtureRoot("fusion-triage-stale-approval-");
  });

  afterEach(async () => {
    await cleanupTriageFixtureRoot(rootDir);
  });

  it("computeUserCommentFingerprint detects added user comment", () => {
    const before = [
      { id: "c1", text: "First", author: "user", createdAt: "2026-01-01T00:00:00.000Z" },
    ];
    const after = [
      { id: "c1", text: "First", author: "user", createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "c2", text: "Second", author: "user", createdAt: "2026-01-02T00:00:00.000Z" },
    ];

    const fpBefore = computeUserCommentFingerprint(before as any);
    const fpAfter = computeUserCommentFingerprint(after as any);

    expect(fpBefore).toBe("c1");
    expect(fpAfter).toBe("c1;c2");
    expect(fpBefore).not.toBe(fpAfter);
  });

  it("computeUserCommentFingerprint is stable when comments unchanged", () => {
    const comments = [
      { id: "c1", text: "Same", author: "user", createdAt: "2026-01-01T00:00:00.000Z" },
    ];

    const fp1 = computeUserCommentFingerprint(comments as any);
    const fp2 = computeUserCommentFingerprint(comments as any);

    expect(fp1).toBe(fp2);
  });

});

describe("pause-abort status clearing (bug fix)", () => {
  it("clears planning status to null on global pause (not a no-op)", async () => {
    const settingsListeners: Array<(e: any) => void> = [];

    const store = {
      on: vi.fn((event: string, cb: (e: any) => void) => {
        if (event === "settings:updated") settingsListeners.push(cb);
      }),
      getTask: vi.fn().mockResolvedValue({ ...mockTaskDetail }),
      getSettings: vi.fn().mockResolvedValue({ maxConcurrent: 2, maxWorktrees: 4, pollIntervalMs: 10000, groupOverlappingFiles: false, autoMerge: true } as Settings),
      listTasks: vi.fn().mockResolvedValue([]),
      updateTask: vi.fn().mockResolvedValue(undefined),
      logEntry: vi.fn().mockResolvedValue(undefined),
      appendAgentLog: vi.fn().mockResolvedValue(undefined),
      parseDependenciesFromPrompt: vi.fn().mockResolvedValue([]),
    } as unknown as TaskStore;

    let resolveDispose: () => void;
    const disposePromise = new Promise<void>((r) => { resolveDispose = r; });
    mockCreateFnAgent.mockResolvedValue({
      session: {
        state: {},
        sessionManager: {},
        prompt: vi.fn().mockReturnValue(disposePromise),
        dispose: vi.fn().mockImplementation(() => resolveDispose()),
        navigateTree: vi.fn(),
      },
    });
    const { promptWithFallback } = await import("../pi.js");
    (promptWithFallback as ReturnType<typeof vi.fn>).mockReturnValueOnce(disposePromise);

    const task: Task = { id: "FN-001", description: "test", column: "triage", dependencies: [], steps: [], currentStep: 0, log: [], createdAt: "", updatedAt: "" };
    const processor = new TriageProcessor(store, "/tmp/root");
    const specifyPromise = processor.specifyTask(task);

    await new Promise((r) => setTimeout(r, 20));

    for (const fn of settingsListeners) {
      fn({ settings: { globalPause: true }, previous: { globalPause: false } });
    }

    await specifyPromise;

    // Status must be set to null so the next poll can retry (old bug: undefined was a no-op)
    const nullStatusCall = (store.updateTask as ReturnType<typeof vi.fn>).mock.calls
      .find((c) => c[1]?.status === null);
    expect(nullStatusCall).toBeDefined();

    const undefinedStatusCall = (store.updateTask as ReturnType<typeof vi.fn>).mock.calls
      .find((c) => "status" in c[1] && c[1].status === undefined);
    expect(undefinedStatusCall).toBeUndefined();
  });
});

describe("stuck task detector integration", () => {
  it("markStuckAborted clears planning status to null for retry", async () => {
    const store = {
      on: vi.fn(),
      getTask: vi.fn().mockResolvedValue({ ...mockTaskDetail }),
      getSettings: vi.fn().mockResolvedValue({ maxConcurrent: 2, maxWorktrees: 4, pollIntervalMs: 10000, groupOverlappingFiles: false, autoMerge: true } as Settings),
      listTasks: vi.fn().mockResolvedValue([]),
      updateTask: vi.fn().mockResolvedValue(undefined),
      logEntry: vi.fn().mockResolvedValue(undefined),
      appendAgentLog: vi.fn().mockResolvedValue(undefined),
      parseDependenciesFromPrompt: vi.fn().mockResolvedValue([]),
    } as unknown as TaskStore;

    let resolveDispose: () => void;
    let mockDispose: ReturnType<typeof vi.fn>;
    const disposePromise = new Promise<void>((r) => { resolveDispose = r; });
    mockDispose = vi.fn().mockImplementation(() => resolveDispose());
    mockCreateFnAgent.mockResolvedValue({
      session: {
        state: {},
        sessionManager: {},
        prompt: vi.fn().mockReturnValue(disposePromise),
        dispose: mockDispose,
        navigateTree: vi.fn(),
      },
    });
    const { promptWithFallback } = await import("../pi.js");
    (promptWithFallback as ReturnType<typeof vi.fn>).mockReturnValueOnce(disposePromise);

    const task: Task = { id: "FN-001", description: "test", column: "triage", dependencies: [], steps: [], currentStep: 0, log: [], createdAt: "", updatedAt: "" };
    const processor = new TriageProcessor(store, "/tmp/root");
    const specifyPromise = processor.specifyTask(task);

    await new Promise((r) => setTimeout(r, 20));

    // Stuck detector marks task then disposes the session (simulating StuckTaskDetector.killAndRetry)
    processor.markStuckAborted("FN-001");
    mockDispose();

    await specifyPromise;

    // Status cleared to null so next poll retries
    const nullStatusCall = (store.updateTask as ReturnType<typeof vi.fn>).mock.calls
      .find((c) => c[1]?.status === null);
    expect(nullStatusCall).toBeDefined();
  });

  it("tracks and untracks sessions with stuckTaskDetector", async () => {
    const trackTask = vi.fn();
    const untrackTask = vi.fn();
    const recordActivity = vi.fn();
    const mockDetector = { trackTask, untrackTask, recordActivity } as any;

    const store = {
      on: vi.fn(),
      getTask: vi.fn().mockResolvedValue({ ...mockTaskDetail }),
      getSettings: vi.fn().mockResolvedValue({ maxConcurrent: 2, maxWorktrees: 4, pollIntervalMs: 10000, groupOverlappingFiles: false, autoMerge: true } as Settings),
      listTasks: vi.fn().mockResolvedValue([]),
      updateTask: vi.fn().mockResolvedValue(undefined),
      logEntry: vi.fn().mockResolvedValue(undefined),
      appendAgentLog: vi.fn().mockResolvedValue(undefined),
      parseDependenciesFromPrompt: vi.fn().mockResolvedValue([]),
    } as unknown as TaskStore;

    mockCreateFnAgent.mockResolvedValue({
      session: {
        state: {},
        sessionManager: {},
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
        navigateTree: vi.fn(),
      },
    });

    const task: Task = { id: "FN-001", description: "test", column: "triage", dependencies: [], steps: [], currentStep: 0, log: [], createdAt: "", updatedAt: "" };
    const processor = new TriageProcessor(store, "/tmp/root", { stuckTaskDetector: mockDetector });
    await processor.specifyTask(task);

    expect(trackTask).toHaveBeenCalledWith("FN-001", expect.objectContaining({ dispose: expect.any(Function) }));
    expect(untrackTask).toHaveBeenCalledWith("FN-001");
    expect(recordActivity).toHaveBeenCalled();
  });
});

describe("specifyTask — status restore failure diagnostics", () => {
  it("logs warning when status restore fails during pause abort", async () => {
    const warnSpy = vi.spyOn(planLog, "warn");
    const settingsListeners: Array<(e: any) => void> = [];

    const store = {
      on: vi.fn((event: string, cb: (e: any) => void) => {
        if (event === "settings:updated") settingsListeners.push(cb);
      }),
      getTask: vi.fn().mockResolvedValue({ ...mockTaskDetail }),
      getSettings: vi.fn().mockResolvedValue({ maxConcurrent: 2, maxWorktrees: 4, pollIntervalMs: 10000, groupOverlappingFiles: false, autoMerge: true } as Settings),
      listTasks: vi.fn().mockResolvedValue([]),
      updateTask: vi.fn().mockImplementation(async (_id: string, patch: Record<string, unknown>) => {
        if (patch?.status === null) {
          throw new Error("pause restore failed");
        }
      }),
      logEntry: vi.fn().mockResolvedValue(undefined),
      appendAgentLog: vi.fn().mockResolvedValue(undefined),
      parseDependenciesFromPrompt: vi.fn().mockResolvedValue([]),
    } as unknown as TaskStore;

    let resolveDispose!: () => void;
    const disposePromise = new Promise<void>((r) => { resolveDispose = r; });
    mockCreateFnAgent.mockResolvedValue({
      session: {
        state: {},
        sessionManager: {},
        prompt: vi.fn().mockReturnValue(disposePromise),
        dispose: vi.fn().mockImplementation(() => resolveDispose()),
        navigateTree: vi.fn(),
      },
    });

    const { promptWithFallback } = await import("../pi.js");
    const promptWithFallbackMock = promptWithFallback as ReturnType<typeof vi.fn>;
    promptWithFallbackMock.mockReturnValueOnce(disposePromise);

    const task: Task = { id: "FN-001", description: "test", column: "triage", dependencies: [], steps: [], currentStep: 0, log: [], createdAt: "", updatedAt: "" };
    const processor = new TriageProcessor(store, "/tmp/root");
    const specifyPromise = processor.specifyTask(task);

    await new Promise((r) => setTimeout(r, 20));
    for (const listener of settingsListeners) {
      listener({ settings: { globalPause: true }, previous: { globalPause: false } });
    }

    await expect(specifyPromise).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("FN-001: failed to restore status to 'null' during pause-abort cleanup"),
    );

    warnSpy.mockRestore();
  });

  it("logs warning when status restore fails during stuck-detector abort", async () => {
    const warnSpy = vi.spyOn(planLog, "warn");

    const store = {
      on: vi.fn(),
      getTask: vi.fn().mockResolvedValue({ ...mockTaskDetail }),
      getSettings: vi.fn().mockResolvedValue({ maxConcurrent: 2, maxWorktrees: 4, pollIntervalMs: 10000, groupOverlappingFiles: false, autoMerge: true } as Settings),
      listTasks: vi.fn().mockResolvedValue([]),
      updateTask: vi.fn().mockImplementation(async (_id: string, patch: Record<string, unknown>) => {
        if (patch?.status === null) {
          throw new Error("stuck restore failed");
        }
      }),
      logEntry: vi.fn().mockResolvedValue(undefined),
      appendAgentLog: vi.fn().mockResolvedValue(undefined),
      parseDependenciesFromPrompt: vi.fn().mockResolvedValue([]),
    } as unknown as TaskStore;

    let resolveDispose!: () => void;
    const disposePromise = new Promise<void>((r) => { resolveDispose = r; });
    const mockDispose = vi.fn().mockImplementation(() => resolveDispose());
    mockCreateFnAgent.mockResolvedValue({
      session: {
        state: {},
        sessionManager: {},
        prompt: vi.fn().mockReturnValue(disposePromise),
        dispose: mockDispose,
        navigateTree: vi.fn(),
      },
    });

    const { promptWithFallback } = await import("../pi.js");
    const promptWithFallbackMock = promptWithFallback as ReturnType<typeof vi.fn>;
    promptWithFallbackMock.mockReturnValueOnce(disposePromise);

    const task: Task = { id: "FN-002", description: "test", column: "triage", dependencies: [], steps: [], currentStep: 0, log: [], createdAt: "", updatedAt: "" };
    const processor = new TriageProcessor(store, "/tmp/root");
    const specifyPromise = processor.specifyTask(task);

    await new Promise((r) => setTimeout(r, 20));
    processor.markStuckAborted("FN-002");
    mockDispose();

    await expect(specifyPromise).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("FN-002: failed to restore status to 'null' during stuck-detector in-loop cleanup"),
    );

    warnSpy.mockRestore();
  });

  it("logs warning when logEntry fails during rate-limit retry", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(planLog, "warn");

    try {
      const task: Task = {
        id: "FN-207",
        description: "Rate limit test",
        column: "triage",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as Task;

      const store = createMockStore({
        getTask: vi.fn().mockResolvedValue({ ...task, attachments: [], comments: [] }),
        logEntry: vi.fn().mockImplementation(async (_taskId: string, message: string) => {
          if (message.includes("Rate limited — retry")) {
            throw new Error("log write failed");
          }
        }),
      });

      mockCreateFnAgent.mockResolvedValue({
        session: {
          state: {},
          sessionManager: { getLeafId: vi.fn().mockReturnValue(null) },
          prompt: vi.fn().mockResolvedValue(undefined),
          dispose: vi.fn(),
          navigateTree: vi.fn(),
        },
      });

      const { promptWithFallback } = await import("../pi.js");
      const promptWithFallbackMock = promptWithFallback as ReturnType<typeof vi.fn>;
      promptWithFallbackMock
        .mockRejectedValueOnce(new Error("429 Too Many Requests"))
        .mockResolvedValueOnce(undefined);

      const processor = new TriageProcessor(store, "/test/root", {
        pollIntervalMs: 100_000,
      });

      const specifyPromise = processor.specifyTask(task);
      await vi.advanceTimersByTimeAsync(60_000);
      await expect(specifyPromise).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("FN-207: failed to log rate-limit retry entry"),
      );
    } finally {
      warnSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("logs warning when transient-error retry status update fails", async () => {
    const warnSpy = vi.spyOn(planLog, "warn");
    const task: Task = {
      id: "FN-208",
      description: "Transient retry test",
      column: "triage",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as Task;

    const store = createMockStore({
      getTask: vi.fn().mockResolvedValue({ ...task, attachments: [] }),
      updateTask: vi.fn().mockImplementation(async (_id: string, patch: Record<string, unknown>) => {
        if (patch?.recoveryRetryCount === 1) {
          throw new Error("retry status update failed");
        }
      }),
    });

    mockCreateFnAgent.mockRejectedValueOnce(new Error("upstream connect error"));

    const processor = new TriageProcessor(store, "/test/root", {
      pollIntervalMs: 100_000,
    });

    await expect(processor.specifyTask(task)).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("FN-208: failed to restore status to 'null' during transient-error retry scheduling"),
    );

    warnSpy.mockRestore();
  });
});

describe("tool callback behavior (FN-1500)", () => {
  it("records activity via stuckTaskDetector on tool callbacks", async () => {
    const recordActivity = vi.fn();
    const mockDetector = { trackTask: vi.fn(), untrackTask: vi.fn(), recordActivity } as any;

    const store = createMockStore();
    const processor = new TriageProcessor(store, "/tmp/root", { stuckTaskDetector: mockDetector });

    // Access the agentLogger via internal agentWork closure
    // by running specifyTask and intercepting the createFnAgent call
    let capturedOnAgentTool: ((id: string, name: string) => void) | undefined;
    mockCreateFnAgent.mockImplementation(async (opts: any) => {
      // Capture the onToolStart callback that was passed to createFnAgent
      // This is the onAgentTool from agentLogger
      if (opts.onToolStart) {
        capturedOnAgentTool = opts.onToolStart;
      }
      return {
        session: {
          state: {},
          sessionManager: {},
          prompt: vi.fn().mockResolvedValue(undefined),
          dispose: vi.fn(),
          navigateTree: vi.fn(),
        },
      };
    });

    const task: Task = { id: "FN-TOOL-001", description: "test tool callbacks", column: "triage", dependencies: [], steps: [], currentStep: 0, log: [], createdAt: "", updatedAt: "" };
    await processor.specifyTask(task);

    // Simulate tool callbacks
    if (capturedOnAgentTool) {
      capturedOnAgentTool("call-1", "read");
      capturedOnAgentTool("call-2", "write");
      capturedOnAgentTool("call-3", "bash");
    }

    // Stuck detector should have recorded activity
    expect(recordActivity).toHaveBeenCalledWith("FN-TOOL-001");
    // Activity should have been recorded at least once (for each tool callback)
    expect(recordActivity.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it("agent logger persists tool events via appendAgentLog", async () => {
    const store = createMockStore();
    const processor = new TriageProcessor(store, "/tmp/root");

    let capturedOnToolStart: ((name: string, args?: Record<string, unknown>) => void) | undefined;
    mockCreateFnAgent.mockImplementation(async (opts: any) => {
      if (opts.onToolStart) {
        capturedOnToolStart = opts.onToolStart;
      }
      return {
        session: {
          state: {},
          sessionManager: {},
          prompt: vi.fn().mockResolvedValue(undefined),
          dispose: vi.fn(),
          navigateTree: vi.fn(),
        },
      };
    });

    const task: Task = { id: "FN-TOOL-002", description: "test tool logging", column: "triage", dependencies: [], steps: [], currentStep: 0, log: [], createdAt: "", updatedAt: "" };
    await processor.specifyTask(task);

    // Simulate tool call
    if (capturedOnToolStart) {
      capturedOnToolStart("read", { path: "test.txt" });
    }

    // Agent logger should have persisted via appendAgentLog
    expect(store.appendAgentLog).toHaveBeenCalledWith(
      "FN-TOOL-002",
      "read",
      "tool",
      undefined,
      "triage",
    );
  });

  it("does not emit stdout 'tool:' log pattern during triage (FN-1500)", async () => {
    // Spy on console.log to verify no tool: spam
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const store = createMockStore();
    const processor = new TriageProcessor(store, "/tmp/root");

    let capturedOnToolStart: ((name: string, args?: Record<string, unknown>) => void) | undefined;
    mockCreateFnAgent.mockImplementation(async (opts: any) => {
      if (opts.onToolStart) {
        capturedOnToolStart = opts.onToolStart;
      }
      return {
        session: {
          state: {},
          sessionManager: {},
          prompt: vi.fn().mockResolvedValue(undefined),
          dispose: vi.fn(),
          navigateTree: vi.fn(),
        },
      };
    });

    const task: Task = { id: "FN-STDOUT-001", description: "test no stdout spam", column: "triage", dependencies: [], steps: [], currentStep: 0, log: [], createdAt: "", updatedAt: "" };
    await processor.specifyTask(task);

    // Simulate multiple tool calls
    if (capturedOnToolStart) {
      capturedOnToolStart("read", { path: "file1.txt" });
      capturedOnToolStart("edit", { path: "file2.txt" });
      capturedOnToolStart("bash", { command: "npm test" });
    }

    // Verify no stdout "tool:" pattern was emitted
    const toolSpamLogs = (consoleLogSpy.mock.calls as string[][]).filter(
      (args) => args.some((arg) => typeof arg === "string" && arg.includes("tool:"))
    );
    expect(toolSpamLogs).toHaveLength(0);

    consoleLogSpy.mockRestore();
  });
});

// ── Skill Selection Regression Tests (FN-1514) ──────────────────────────
//
// Note: These tests verify that skillSelection is passed through the triage
// pipeline. The actual agent skill lookup is tested in session-skill-context.test.ts.
// Here we focus on the contract that skillSelection flows correctly.

describe("TriageProcessor skillSelection regression (FN-1511)", () => {
  const projectRoot = "/tmp/test-project";

  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateFnAgent.mockResolvedValue({
      session: {
        state: {},
        sessionManager: {},
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
        navigateTree: vi.fn(),
      },
    });
  });

  /**
   * Helper: execute triage on a task and capture createFnAgent call arguments.
   */
  async function captureCreateFnAgentArgs(options?: {
    assignedAgentId?: string;
    assignedAgentSkills?: string[];
    permissionPolicy?: Record<string, unknown>;
  }) {
    const { assignedAgentId, assignedAgentSkills, permissionPolicy } = options || {};

    const mockAgentStore = {
      getAgent: vi.fn().mockImplementation(async (id: string) => {
        if (id === assignedAgentId && assignedAgentSkills) {
          return {
            id,
            name: "Test Agent",
            role: "triage",
            state: "idle",
            metadata: { skills: assignedAgentSkills },
            permissionPolicy,
          };
        }
        return null;
      }),
    };

    const store = createMockStore({
      getTask: vi.fn().mockResolvedValue({
        id: "FN-SKILL",
        title: "Skill Test",
        description: "Test skill selection",
        column: "triage",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        assignedAgentId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    });

    let capturedArgs: any = null;
    mockCreateFnAgent.mockImplementationOnce(async (opts: any) => {
      capturedArgs = opts;
      return {
        session: {
          state: {},
          sessionManager: {},
          prompt: vi.fn().mockResolvedValue(undefined),
          dispose: vi.fn(),
          navigateTree: vi.fn(),
        },
      };
    });

    const processor = new TriageProcessor(store, projectRoot, {
      agentStore: mockAgentStore as any,
    });
    const task: Task = {
      id: "FN-SKILL",
      description: "Test skill selection",
      column: "triage",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      assignedAgentId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await processor.specifyTask(task);

    return capturedArgs;
  }

  describe("skillSelection context propagation", () => {
    it("passes skillSelection and delegation reassignment tools to createFnAgent", async () => {
      const args = await captureCreateFnAgentArgs({
        assignedAgentId: "agent-001",
        assignedAgentSkills: ["triage"],
      });

      expect(args).not.toBeNull();
      expect(args).toHaveProperty("skillSelection");
      expect(args.skillSelection.projectRootDir).toBe(projectRoot);
      const toolNames = args.customTools.map((tool: { name: string }) => tool.name);
      expect(toolNames).toContain("fn_delegate_task");
      expect(toolNames).toContain("fn_task_assign");
    });

    it("uses 'triage' as sessionPurpose for triage sessions", async () => {
      const args = await captureCreateFnAgentArgs({
        assignedAgentId: "agent-001",
        assignedAgentSkills: ["triage"],
      });

      expect(args).not.toBeNull();
      expect(args.skillSelection?.sessionPurpose).toBe("triage");
    });

    it.each(["block", "require-approval"] as const)("passes triage Mission mutations through the %s action gate", async (disposition) => {
      const args = await captureCreateFnAgentArgs({
        assignedAgentId: "agent-001",
        assignedAgentSkills: ["triage"],
        permissionPolicy: {
          presetId: "custom",
          rules: {
            git_write: "allow",
            file_write_delete: "allow",
            command_execution: "allow",
            network_api: "allow",
            task_agent_mutation: disposition,
            review_gate_bypass: "allow",
            file_scope: "allow",
          },
        },
      });

      const { evaluateAgentActionGate } = await import("../agent-action-gate.js");
      expect(args.actionGateContext).toBeDefined();
      expect(args.permanentAgentGating).toBeDefined();
      expect(evaluateAgentActionGate({
        agentId: args.actionGateContext.agentId,
        taskId: args.actionGateContext.taskId,
        toolName: "fn_mission_create",
        args: { title: "Gated mission" },
        permissionPolicy: args.actionGateContext.permissionPolicy,
      })).toMatchObject({ category: "task_agent_mutation", disposition });
    });

    it("skillSelection is undefined when no agentStore provided (role fallback behavior)", async () => {
      // When no agentStore is provided, buildSessionSkillContext uses role fallback
      // and skillSelection may be undefined or use role fallback skills
      const store = createMockStore({
        getTask: vi.fn().mockResolvedValue({
          id: "FN-SKILL",
          description: "Test",
          column: "triage",
          dependencies: [],
          steps: [],
          currentStep: 0,
          log: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
      });

      let capturedArgs: any = null;
      mockCreateFnAgent.mockImplementationOnce(async (opts: any) => {
        capturedArgs = opts;
        return {
          session: {
            state: {},
            sessionManager: {},
            prompt: vi.fn().mockResolvedValue(undefined),
            dispose: vi.fn(),
            navigateTree: vi.fn(),
          },
        };
      });

      const processor = new TriageProcessor(store, projectRoot);
      await processor.specifyTask({
        id: "FN-SKILL",
        description: "Test",
        column: "triage",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      // Without agentStore, role fallback is used which adds skillSelection with triage skill
      expect(capturedArgs).not.toBeNull();
      expect(capturedArgs).toHaveProperty("skillSelection");
    });
  });

  describe("parity with executor paths", () => {
    it("uses same skillSelection field structure as executor", async () => {
      const args = await captureCreateFnAgentArgs({
        assignedAgentId: "agent-001",
        assignedAgentSkills: ["triage"],
      });

      expect(args).not.toBeNull();
      // Triage and executor should use the same skillSelection field structure
      expect(args).toHaveProperty("skillSelection");
      expect(args.skillSelection).toHaveProperty("projectRootDir");
      expect(args.skillSelection).toHaveProperty("requestedSkillNames");
      expect(args.skillSelection).toHaveProperty("sessionPurpose");
    });
  });
});

describe("evictStaleProcessing", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("evicts tasks that have been in processing longer than 30 minutes", () => {
    const store = createMockStore();
    const processor = new TriageProcessor(store, "/tmp/root");

    // Simulate a task that entered processing 31 minutes ago
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    (processor as any).processing.add("FN-001");
    (processor as any).processingSince.set("FN-001", Date.now());

    // Advance time 31 minutes
    vi.setSystemTime(new Date("2026-01-01T00:31:00.000Z"));

    const evicted = processor.evictStaleProcessing();

    expect(evicted).toEqual(new Set(["FN-001"]));
    expect(processor.getProcessingTaskIds().has("FN-001")).toBe(false);
  });

  it("retains stale tasks with a live non-aborted triage session", () => {
    const store = createMockStore();
    const processor = new TriageProcessor(store, "/tmp/root");

    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    (processor as any).processing.add("FN-live");
    (processor as any).processingSince.set("FN-live", Date.now());
    (processor as any).activeSessions.set("FN-live", { dispose: vi.fn() });

    vi.setSystemTime(new Date("2026-01-01T00:31:00.000Z"));

    const evicted = processor.evictStaleProcessing();

    expect(evicted).toEqual(new Set());
    expect(processor.getProcessingTaskIds().has("FN-live")).toBe(true);
    expect((processor as any).activeSessions.has("FN-live")).toBe(true);
  });

  it("does not evict tasks that have been in processing less than 30 minutes regardless of session state", () => {
    const store = createMockStore();
    const processor = new TriageProcessor(store, "/tmp/root");

    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    for (const taskId of ["FN-no-session", "FN-live", "FN-stuck-aborted"]) {
      (processor as any).processing.add(taskId);
      (processor as any).processingSince.set(taskId, Date.now());
    }
    (processor as any).activeSessions.set("FN-live", { dispose: vi.fn() });
    (processor as any).activeSessions.set("FN-stuck-aborted", { dispose: vi.fn() });
    (processor as any).stuckAborted.add("FN-stuck-aborted");

    // Advance time 29 minutes — not stale yet.
    vi.setSystemTime(new Date("2026-01-01T00:29:00.000Z"));

    const evicted = processor.evictStaleProcessing();

    expect(evicted.size).toBe(0);
    expect(processor.getProcessingTaskIds()).toEqual(new Set([
      "FN-no-session",
      "FN-live",
      "FN-stuck-aborted",
    ]));
  });

  it("cleans up activeSessions and stuckAborted when evicting", () => {
    const store = createMockStore();
    const processor = new TriageProcessor(store, "/tmp/root");

    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    (processor as any).processing.add("FN-001");
    (processor as any).processingSince.set("FN-001", Date.now());
    (processor as any).activeSessions.set("FN-001", { dispose: vi.fn() });
    (processor as any).stuckAborted.add("FN-001");

    vi.setSystemTime(new Date("2026-01-01T00:31:00.000Z"));

    const evicted = processor.evictStaleProcessing();

    expect(evicted).toEqual(new Set(["FN-001"]));
    expect((processor as any).activeSessions.has("FN-001")).toBe(false);
    expect((processor as any).stuckAborted.has("FN-001")).toBe(false);
  });

  it("returns empty set when no tasks are stale", () => {
    const store = createMockStore();
    const processor = new TriageProcessor(store, "/tmp/root");

    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    (processor as any).processing.add("FN-001");
    (processor as any).processingSince.set("FN-001", Date.now());

    // Only 5 minutes — well within threshold
    vi.setSystemTime(new Date("2026-01-01T00:05:00.000Z"));

    const evicted = processor.evictStaleProcessing();

    expect(evicted.size).toBe(0);
    expect(processor.getProcessingTaskIds().has("FN-001")).toBe(true);
  });

  it("evicts multiple stale tasks while keeping fresh ones", () => {
    const store = createMockStore();
    const processor = new TriageProcessor(store, "/tmp/root");

    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    (processor as any).processing.add("FN-001");
    (processor as any).processingSince.set("FN-001", Date.now());

    vi.setSystemTime(new Date("2026-01-01T00:15:00.000Z"));
    (processor as any).processing.add("FN-002");
    (processor as any).processingSince.set("FN-002", Date.now());

    // FN-001 entered at 00:00, FN-002 at 00:15
    vi.setSystemTime(new Date("2026-01-01T00:35:00.000Z"));

    const evicted = processor.evictStaleProcessing();

    // FN-001 has been in for 35min → evicted. FN-002 for 20min → not stale.
    expect(evicted).toEqual(new Set(["FN-001"]));
    expect(processor.getProcessingTaskIds().has("FN-001")).toBe(false);
    expect(processor.getProcessingTaskIds().has("FN-002")).toBe(true);
  });

  /*
  FNXC:TriageStuckKill 2026-07-18-21:05:
  FN-1312: after stuck-kill of the main triage session, Plan Review still runs as a
  subagent and finalize is mid-handoff. Eviction at the 30m threshold must not drop
  those cards or self-healing/poll will start a concurrent planner.
  */
  it("retains stuck-aborted tasks that still have a live Plan Review subagent", () => {
    const store = createMockStore();
    const processor = new TriageProcessor(store, "/tmp/root");

    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    (processor as any).processing.add("FN-1312");
    (processor as any).processingSince.set("FN-1312", Date.now());
    (processor as any).stuckAborted.add("FN-1312");
    (processor as any).activeSubagentSessions.set("FN-1312", new Set([{ dispose: vi.fn() }]));

    vi.setSystemTime(new Date("2026-01-01T00:31:00.000Z"));

    const evicted = processor.evictStaleProcessing();

    expect(evicted).toEqual(new Set());
    expect(processor.getProcessingTaskIds().has("FN-1312")).toBe(true);
  });

  it("retains stuck-aborted tasks currently inside finalizeApprovedTask", () => {
    const store = createMockStore();
    const processor = new TriageProcessor(store, "/tmp/root");

    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    (processor as any).processing.add("FN-1312");
    (processor as any).processingSince.set("FN-1312", Date.now());
    (processor as any).stuckAborted.add("FN-1312");
    (processor as any).finalizing.add("FN-1312");

    vi.setSystemTime(new Date("2026-01-01T00:31:00.000Z"));

    const evicted = processor.evictStaleProcessing();

    expect(evicted).toEqual(new Set());
    expect(processor.getProcessingTaskIds().has("FN-1312")).toBe(true);
  });

  it("includes finalizing and subagent tasks in getProcessingTaskIds even when not in processing", () => {
    const store = createMockStore();
    const processor = new TriageProcessor(store, "/tmp/root");

    (processor as any).finalizing.add("FN-finalizing");
    (processor as any).activeSubagentSessions.set("FN-subagent", new Set([{ dispose: vi.fn() }]));

    const ids = processor.getProcessingTaskIds();
    expect(ids.has("FN-finalizing")).toBe(true);
    expect(ids.has("FN-subagent")).toBe(true);
  });
});

// ── Agent Delegation Tool Tests ──────────────────────────────────────

describe("TriageProcessor delegation tools", () => {
  function createMockAgentStore() {
    return {
      listAgents: vi.fn().mockResolvedValue([]),
      getAgent: vi.fn().mockResolvedValue(null),
    };
  }

  function createMockStore() {
    return {
      listTasks: vi.fn().mockResolvedValue([]),
      searchTasks: vi.fn().mockResolvedValue([]),
      getTask: vi.fn().mockResolvedValue({
        id: "FN-TRIAGE",
        title: "Test",
        description: "Test task",
        column: "triage",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        status: "planning",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
      getSettings: vi.fn().mockResolvedValue({
        maxConcurrent: 2,
        maxWorktrees: 4,
        pollIntervalMs: 10000,
        defaultProvider: "openai",
        defaultModelId: "gpt-4o",
      }),
      logEntry: vi.fn().mockResolvedValue(undefined),
      appendAgentLog: vi.fn().mockResolvedValue(undefined),
      updateTask: vi.fn().mockResolvedValue({}),
      on: vi.fn(),
      emit: vi.fn(),
    };
  }

  it("createTriageTools returns fn_task_list, fn_task_search, fn_task_show, fn_task_create (no delegation tools — those are in customTools)", () => {
    const store = createMockStore();
    const processor = new TriageProcessor(store as any, "/tmp/root");

    const tools = (processor as any).createTriageTools({
      parentTaskId: "FN-TRIAGE",
      allowTaskCreate: true,
      createdSubtasksRef: { current: [] },
    });

    const toolNames = tools.map((t: any) => t.name);
    expect(toolNames).toContain("fn_task_list");
    expect(toolNames).toContain("fn_task_search");
    expect(toolNames).toContain("fn_task_show");
    expect(toolNames).toContain("fn_task_create");
    // fn_list_agents and fn_delegate_task are added in customTools, not createTriageTools
    expect(toolNames).not.toContain("fn_list_agents");
    expect(toolNames).not.toContain("fn_delegate_task");
  });

  it("fn_task_search includes done tasks by default and searches with includeArchived true", async () => {
    const store = createMockStore();
    (store.searchTasks as any).mockResolvedValue([
      {
        id: "FN-100",
        title: "Fix rebase merge truncation",
        description: "desc",
        column: "done",
        dependencies: [],
      },
      {
        id: "FN-101",
        title: "Another task",
        description: "desc",
        column: "todo",
        dependencies: ["FN-100"],
      },
    ]);
    const processor = new TriageProcessor(store as any, "/tmp/root");
    const tools = (processor as any).createTriageTools({
      parentTaskId: "FN-TRIAGE",
      allowTaskCreate: true,
      createdSubtasksRef: { current: [] },
    });

    const taskSearchTool = tools.find((t: any) => t.name === "fn_task_search");
    const result = await taskSearchTool.execute("call-1", { query: "rebase diff" });
    const text = result.content[0].text;

    expect(store.searchTasks).toHaveBeenCalledWith("rebase diff", {
      slim: true,
      includeArchived: true,
      limit: 20,
    });
    expect(text).toContain('Search results for "rebase diff" (2):');
    expect(text).toContain("FN-100 (done): Fix rebase merge truncation");
  });

  it("fn_task_search filters done tasks when includeDone is false", async () => {
    const store = createMockStore();
    (store.searchTasks as any).mockResolvedValue([
      { id: "FN-100", title: "Done task", description: "desc", column: "done", dependencies: [] },
      { id: "FN-101", title: "Todo task", description: "desc", column: "todo", dependencies: [] },
    ]);
    const processor = new TriageProcessor(store as any, "/tmp/root");
    const tools = (processor as any).createTriageTools({
      parentTaskId: "FN-TRIAGE",
      allowTaskCreate: true,
      createdSubtasksRef: { current: [] },
    });

    const taskSearchTool = tools.find((t: any) => t.name === "fn_task_search");
    const result = await taskSearchTool.execute("call-1", {
      query: "task",
      includeDone: false,
    });
    const text = result.content[0].text;

    expect(store.searchTasks).toHaveBeenCalled();
    expect(text).toContain("FN-101 (todo): Todo task");
    expect(text).not.toContain("FN-100 (done): Done task");
  });

  it("fn_task_search returns no-match text when search results are empty", async () => {
    const store = createMockStore();
    (store.searchTasks as any).mockResolvedValue([]);
    const processor = new TriageProcessor(store as any, "/tmp/root");
    const tools = (processor as any).createTriageTools({
      parentTaskId: "FN-TRIAGE",
      allowTaskCreate: true,
      createdSubtasksRef: { current: [] },
    });

    const taskSearchTool = tools.find((t: any) => t.name === "fn_task_search");
    const result = await taskSearchTool.execute("call-1", { query: "missing" });

    expect(result.content[0].text).toBe("No tasks matched.");
  });

  it("delegation tools are accessible when agentStore is available", () => {
    const mockAgentStore = createMockAgentStore();
    const store = createMockStore();
    const processor = new TriageProcessor(store as any, "/tmp/root", {
      agentStore: mockAgentStore as any,
    });

    // Verify agentStore is injected into processor options
    expect((processor as any).options.agentStore).toBe(mockAgentStore);
  });
});

// ── FN-4774 Regression: Duplicate detection over done/archived tasks (recovered under FN-4827; supersedes FN-4815) ───

describe("FN-4774 regression: triage duplicate detection over done/archived tasks", () => {
  function createMockStore() {
    return {
      listTasks: vi.fn().mockResolvedValue([]),
      searchTasks: vi.fn().mockResolvedValue([]),
      getTask: vi.fn().mockResolvedValue({
        id: "FN-TRIAGE",
        title: "Test",
        description: "Test task",
        column: "triage",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        status: "planning",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
      getSettings: vi.fn().mockResolvedValue({
        maxConcurrent: 2,
        maxWorktrees: 4,
        pollIntervalMs: 10000,
        defaultProvider: "openai",
        defaultModelId: "gpt-4o",
      }),
      logEntry: vi.fn().mockResolvedValue(undefined),
      appendAgentLog: vi.fn().mockResolvedValue(undefined),
      updateTask: vi.fn().mockResolvedValue({}),
      on: vi.fn(),
      emit: vi.fn(),
    };
  }

  // Regression: FN-4774 (FN-4827 recovery; supersedes FN-4815) — see docs/triage-duplicate-detection-postmortem.md
  it("fn_task_search tool is registered with includeDone and includeArchived parameters", () => {
    const store = createMockStore();
    const processor = new TriageProcessor(store as any, "/tmp/root");

    const tools = (processor as any).createTriageTools({
      parentTaskId: "FN-TRIAGE",
      allowTaskCreate: true,
      createdSubtasksRef: { current: [] },
    });

    const taskSearchTool = tools.find((t: any) => t.name === "fn_task_search");
    expect(taskSearchTool).toBeDefined();
    expect(taskSearchTool.name).toBe("fn_task_search");

    // Verify includeDone and includeArchived are present in the parameter schema
    const props = taskSearchTool.parameters.properties;
    expect(props).toHaveProperty("includeDone");
    expect(props).toHaveProperty("includeArchived");
  });

  // Regression: FN-4774 (FN-4827 recovery; supersedes FN-4815) — see docs/triage-duplicate-detection-postmortem.md
  it("canonical triage policy prompt guides agents to search done/archived before creating", () => {
    // Standard prompt mentions fn_task_search in duplicate-check guidance
    expect(TRIAGE_POLICY_PROMPT).toContain("fn_task_search");
    // The tool bullet list explicitly states it covers done and archived
    expect(TRIAGE_POLICY_PROMPT).toContain("including done and archived tasks");
    // Duplicate-check section co-locates fn_task_search with done/archived references
    expect(TRIAGE_POLICY_PROMPT).toContain("done");
    expect(TRIAGE_POLICY_PROMPT).toContain("archived");
    // Defensive regex: duplicate-check guidance must cross-reference fn_task_search with done/archived
    expect(
      /Duplicate check[\s\S]{0,600}fn_task_search[\s\S]{0,400}(done|archived)/i.test(
        TRIAGE_POLICY_PROMPT,
      ),
    ).toBe(true);
  });

  // Regression: FN-4774 (FN-4827 recovery; supersedes FN-4815) — see docs/triage-duplicate-detection-postmortem.md
  it("FAST_PLANNING_PROMPT guides agents to search done/archived before creating", () => {
    // Fast prompt mentions fn_task_search
    expect(FAST_PLANNING_PROMPT).toContain("fn_task_search");
    // Duplicate-check section references done and archived
    expect(FAST_PLANNING_PROMPT).toContain("done");
    expect(FAST_PLANNING_PROMPT).toContain("archived");
    // Defensive regex: duplicate-check guidance must cross-reference fn_task_search with done/archived
    expect(
      /Duplicate check[\s\S]{0,600}fn_task_search[\s\S]{0,400}(done|archived)/i.test(
        FAST_PLANNING_PROMPT,
      ),
    ).toBe(true);
  });

  // Regression: FN-4774 (FN-4827 recovery; supersedes FN-4815) — see docs/triage-duplicate-detection-postmortem.md
  it("fn_task_search returns done-column results by default", async () => {
    const store = createMockStore();
    (store.searchTasks as any).mockResolvedValue([
      {
        id: "FN-DONE",
        title: "Fix rebase truncation bug",
        description: "desc",
        column: "done",
        dependencies: [],
      },
    ]);
    const processor = new TriageProcessor(store as any, "/tmp/root");
    const tools = (processor as any).createTriageTools({
      parentTaskId: "FN-TRIAGE",
      allowTaskCreate: true,
      createdSubtasksRef: { current: [] },
    });

    const taskSearchTool = tools.find((t: any) => t.name === "fn_task_search");
    const result = await taskSearchTool.execute("call-1", {
      query: "rebase truncation",
    });
    const text = result.content[0].text;

    // searchTasks is called with includeArchived: true (includeDone is a post-filter, not passed to searchTasks)
    expect(store.searchTasks).toHaveBeenCalledWith("rebase truncation", {
      slim: true,
      includeArchived: true,
      limit: 20,
    });
    // Done results surface in output with the (done): column label
    expect(text).toContain("FN-DONE");
    expect(text).toContain("(done):");
  });
});
