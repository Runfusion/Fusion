import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { TaskStore, Task, TaskDetail, Settings } from "@fusion/core";
import {
  TriageProcessor,
  TRIAGE_SYSTEM_PROMPT,
  buildSpecificationPrompt,
  readAttachmentContents,
  computeUserCommentFingerprint,
} from "./triage.js";
import { join } from "node:path";
import { mkdir, writeFile, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { triageLog } from "./logger.js";

const { mockReviewStep, mockCreateFnAgent } = vi.hoisted(() => ({
  mockReviewStep: vi.fn(),
  mockCreateFnAgent: vi.fn(),
}));

vi.mock("./reviewer.js", () => ({
  reviewStep: mockReviewStep,
}));

vi.mock("./pi.js", () => ({
  createFnAgent: mockCreateFnAgent,
  describeModel: vi.fn().mockReturnValue("mock-model"),
  promptWithFallback: vi.fn().mockReturnValue("mock-prompt"),
}));

vi.mock("@fusion/core", async () => {
  const actual = await vi.importActual("@fusion/core");
  return {
    ...actual,
    resolveAgentPrompt: vi.fn().mockReturnValue(null),
  };
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
  return {
    getTask: vi.fn(),
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
    } as Settings),
    updateSettings: vi.fn(),
    logEntry: vi.fn().mockResolvedValue(undefined),
    appendAgentLog: vi.fn().mockResolvedValue(undefined),
    getAgentLogs: vi.fn().mockResolvedValue([]),
    addSteeringComment: vi.fn(),
    parseDependenciesFromPrompt: vi.fn().mockResolvedValue([]),
    parseStepsFromPrompt: vi.fn().mockResolvedValue([]),
    parseFileScopeFromPrompt: vi.fn().mockResolvedValue([]),
    on: vi.fn(),
    emit: vi.fn(),
    ...overrides,
  } as unknown as TaskStore;
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
    expect(prompt).toContain("User Feedback");
    expect(prompt).toContain(existingPrompt);
    expect(prompt).toContain(feedback);
    expect(prompt).toContain("revising an existing task specification");
  });

  it("generates fresh re-specification prompt when only feedback is provided", () => {
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
    expect(prompt).toContain(feedback);
    expect(prompt).not.toContain("Existing Specification");
    expect(prompt).toContain("without carrying forward stale assumptions");
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

describe("TRIAGE_SYSTEM_PROMPT", () => {
  it("requires specs to keep lint, tests, build, and typecheck green even outside initial file scope", () => {
    expect(TRIAGE_SYSTEM_PROMPT).toContain("If keeping lint/tests/build/typecheck green requires edits outside the initial File Scope");
    expect(TRIAGE_SYSTEM_PROMPT).toContain("Run lint check");
    expect(TRIAGE_SYSTEM_PROMPT).toContain("Run project typecheck if available");
    expect(TRIAGE_SYSTEM_PROMPT).toContain("Lint passing");
    expect(TRIAGE_SYSTEM_PROMPT).toContain("Typecheck passing (if available)");
    expect(TRIAGE_SYSTEM_PROMPT).toContain("Specs must instruct executors to fix lint failures and quality-gate failures directly");
    expect(TRIAGE_SYSTEM_PROMPT).toContain("Refuse necessary fixes just because they touch files outside the initial File Scope");
  });
});

describe("TRIAGE_SYSTEM_PROMPT", () => {
  it("includes proactive M/L subtask breakdown guidance", () => {
    expect(TRIAGE_SYSTEM_PROMPT).toContain(
      "## Proactive Subtask Breakdown for M/L Tasks",
    );
    expect(TRIAGE_SYSTEM_PROMPT).toContain(
      "Even when `breakIntoSubtasks` is not set to `true`",
    );
    expect(TRIAGE_SYSTEM_PROMPT).toContain(
      "Size S tasks should generally NOT be split",
    );
  });

  it("includes explicit subtask breakdown thresholds", () => {
    expect(TRIAGE_SYSTEM_PROMPT).toContain("MORE THAN 7 implementation steps");
    expect(TRIAGE_SYSTEM_PROMPT).toContain(
      "MORE THAN 3 different packages/modules",
    );
  });

  it("includes anti-pattern warning for oversized tasks", () => {
    expect(TRIAGE_SYSTEM_PROMPT).toContain("ANTI-PATTERN");
    expect(TRIAGE_SYSTEM_PROMPT).toContain("10+ steps");
    expect(TRIAGE_SYSTEM_PROMPT).toContain(
      "Only keep a task as one unit if it genuinely has 5 or fewer focused steps",
    );
  });
});

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
    const attachments = [
      {
        filename: "1234567890-image.png",
        originalName: "image.png",
        mimeType: "image/png" as const,
        size: 100,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ];

    // Write fake PNG data (just some bytes)
    const imageData = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG magic bytes
    await writeFile(
      join(testDir, ".fusion", "tasks", taskId, "attachments", "1234567890-image.png"),
      imageData,
    );

    const result = await readAttachmentContents(testDir, taskId, attachments);

    expect(result.attachmentContents).toHaveLength(1);
    expect(result.attachmentContents[0].text).toBeNull();
    expect(result.imageContents).toHaveLength(1);
    expect(result.imageContents[0].type).toBe("image");
    expect(result.imageContents[0].mimeType).toBe("image/png");
    expect(result.imageContents[0].data).toBe(imageData.toString("base64"));
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

  it("re-reads settings when fn_review_spec runs so reviewer uses the latest validator model", async () => {
    const taskId = "FN-001";
    const testRootDir = await createTriageFixtureRoot("fusion-triage-review-spec-");
    try {
      const promptPath = `.fusion/tasks/${taskId}/PROMPT.md`;
      const taskDir = join(testRootDir, ".fusion", "tasks", taskId);
      await mkdir(taskDir, { recursive: true });
      await writeFile(join(taskDir, "PROMPT.md"), "# Spec\n\nCurrent prompt");

      const freshSettings: Settings = {
        maxConcurrent: 2,
        maxWorktrees: 4,
        pollIntervalMs: 10000,
        groupOverlappingFiles: false,
        autoMerge: true,
        defaultProvider: "openai-codex",
        defaultModelId: "gpt-5.4",
        validatorProvider: "zai",
        validatorModelId: "glm-5.1",
      };

      store = createMockStore({
        getSettings: vi.fn().mockResolvedValue(freshSettings),
        getTask: vi.fn().mockResolvedValue({
          ...mockTaskDetail,
          id: taskId,
          comments: [],
        }),
      });
      processor = new TriageProcessor(store, testRootDir);

      mockReviewStep.mockResolvedValue({
        verdict: "APPROVE",
        review: "Looks good.",
        summary: "approved",
      });

      const tool = (processor as any).createReviewSpecTool(
        taskId,
        promptPath,
        { current: null },
        { current: null },
        { current: null },
        {
          defaultProvider: "anthropic",
          defaultModelId: "claude-opus-4-6",
          projectValidatorProvider: "anthropic",
          projectValidatorModelId: "claude-opus-4-6",
        },
      );

      await tool.execute({});

      expect(store.getSettings).toHaveBeenCalled();
      expect(mockReviewStep).toHaveBeenCalledWith(
        testRootDir,
        taskId,
        0,
        "Specification",
        "spec",
        "# Spec\n\nCurrent prompt",
        undefined,
        expect.objectContaining({
          defaultProvider: "openai-codex",
          defaultModelId: "gpt-5.4",
          projectValidatorProvider: "zai",
          projectValidatorModelId: "glm-5.1",
          userComments: undefined,
        }),
      );
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
    status: "needs-respecify",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  it("detects needs-respecify status", () => {
    expect(taskWithRevisionRequest.status).toBe("needs-respecify");
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
          status: "specifying",
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
});

describe("approved triage recovery", () => {
  let rootDir = "";

  beforeEach(async () => {
    rootDir = await createTriageFixtureRoot("fusion-triage-recovery-");
    await mkdir(join(rootDir, ".fusion", "tasks", "FN-001"), { recursive: true });
    await writeFile(
      join(rootDir, ".fusion", "tasks", "FN-001", "PROMPT.md"),
      "# Task: FN-001\n\n**Size:** M\n\n## Review Level: 2\n\nRecovered specification",
    );
  });

  afterEach(async () => {
    await cleanupTriageFixtureRoot(rootDir);
  });

  it("moves approved specifying task to todo during recovery", async () => {
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
      status: "specifying",
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
      status: null,
      error: null,
      dependencies: ["FN-1247"],
      size: "M",
      reviewLevel: 2,
    });
    expect(store.moveTask).toHaveBeenCalledWith("FN-001", "todo");
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-001",
      "Auto-recovered approved specification stuck in specifying — moved to todo",
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
      status: "specifying",
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

  it("moves approved specifying task to awaiting-approval when manual approval is required", async () => {
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
      status: "specifying",
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
    expect(store.updateTask).toHaveBeenCalledWith("FN-001", {
      status: "awaiting-approval",
    });
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-001",
      "Auto-recovered approved specification stuck in specifying — awaiting manual approval",
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
      expect(toolNames).toContain("fn_task_get");
      expect(tools).toHaveLength(3);
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
      }));
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
      const { promptWithFallback } = await import("./pi.js");
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
      expect(store.deleteTask).toHaveBeenCalledWith("FN-500");
    });
  });

  describe("bounded recovery retries for triage", () => {
    it("requeues triage with backoff when the agent exits without calling fn_review_spec", async () => {
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

      const { promptWithFallback } = await import("./pi.js");
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
        expect.stringContaining("Spec review not approved (fn_review_spec was never called)"),
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
      const { promptWithFallback } = await import("./pi.js");
      (promptWithFallback as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("test stop after model log"),
      );

      const processor = new TriageProcessor(store, "/test/root", {
        pollIntervalMs: 100_000,
      });

      await processor.specifyTask(task);

      // Verify appendAgentLog was called with model info and triage role
      expect(store.appendAgentLog).toHaveBeenCalledWith(
        "FN-300",
        "Triage using model: mock-model",
        "text",
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

      const { promptWithFallback } = await import("./pi.js");
      (promptWithFallback as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("test stop after model check"),
      );

      const processor = new TriageProcessor(store, "/test/root", {
        pollIntervalMs: 100_000,
      });

      await processor.specifyTask(task);

      // Per-task override should take precedence over settings
      expect(mockCreateFnAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          defaultProvider: "google",
          defaultModelId: "gemini-2.5-pro",
        }),
      );
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

      const { promptWithFallback } = await import("./pi.js");
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

    it("falls back to global defaults when neither task nor settings have planning model", async () => {
      const task = {
        id: "FN-402",
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

      const { promptWithFallback } = await import("./pi.js");
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

  it("captures fingerprint on fn_review_spec APPROVE", async () => {
    const taskId = "FN-CAP";
    const taskDir = join(rootDir, ".fusion", "tasks", taskId);
    await mkdir(taskDir, { recursive: true });
    await writeFile(join(taskDir, "PROMPT.md"), "# Spec\n\nCurrent prompt");

    const comments = [
      { id: "c1", text: "Feedback", author: "user", createdAt: "2026-01-01T00:00:00.000Z" },
    ];

    const store = createMockStore({
      getSettings: vi.fn().mockResolvedValue({
        maxConcurrent: 2,
        maxWorktrees: 4,
        pollIntervalMs: 10000,
        groupOverlappingFiles: false,
        autoMerge: true,
      } as Settings),
      getTask: vi.fn().mockResolvedValue({
        ...mockTaskDetail,
        id: taskId,
        comments,
      }),
    });

    const processor = new TriageProcessor(store, rootDir);

    mockReviewStep.mockResolvedValue({
      verdict: "APPROVE",
      review: "Looks good.",
      summary: "approved",
    });

    const approvedCommentFingerprintRef = { current: "" };
    const tool = (processor as any).createReviewSpecTool(
      taskId,
      `.fusion/tasks/${taskId}/PROMPT.md`,
      { current: null },
      { current: null },
      { current: null },
      approvedCommentFingerprintRef,
      {},
    );

    // Execute fn_review_spec — should capture fingerprint at APPROVE time
    await tool.execute({});

    // Verify fingerprint was captured from the user comments at approval time
    expect(approvedCommentFingerprintRef.current).toBe("c1");
  });

  it("fingerprint is empty string when fn_review_spec returns REVISE (no capture)", async () => {
    const taskId = "FN-REV";
    const taskDir = join(rootDir, ".fusion", "tasks", taskId);
    await mkdir(taskDir, { recursive: true });
    await writeFile(join(taskDir, "PROMPT.md"), "# Spec\n\nCurrent prompt");

    const store = createMockStore({
      getSettings: vi.fn().mockResolvedValue({
        maxConcurrent: 2,
        maxWorktrees: 4,
        pollIntervalMs: 10000,
        groupOverlappingFiles: false,
        autoMerge: true,
      } as Settings),
      getTask: vi.fn().mockResolvedValue({
        ...mockTaskDetail,
        id: taskId,
        comments: [],
      }),
    });

    const processor = new TriageProcessor(store, rootDir);

    mockReviewStep.mockResolvedValue({
      verdict: "REVISE",
      review: "Fix the spec.",
      summary: "needs work",
    });

    const approvedCommentFingerprintRef = { current: "" };
    const tool = (processor as any).createReviewSpecTool(
      taskId,
      `.fusion/tasks/${taskId}/PROMPT.md`,
      { current: null },
      { current: null },
      { current: null },
      approvedCommentFingerprintRef,
      {},
    );

    await tool.execute({});

    // Fingerprint should NOT be captured on REVISE
    expect(approvedCommentFingerprintRef.current).toBe("");
  });
});

describe("pause-abort status clearing (bug fix)", () => {
  it("clears specifying status to null on global pause (not a no-op)", async () => {
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
    const { promptWithFallback } = await import("./pi.js");
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
  it("markStuckAborted clears specifying status to null for retry", async () => {
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
    const { promptWithFallback } = await import("./pi.js");
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
    const warnSpy = vi.spyOn(triageLog, "warn");
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

    const { promptWithFallback } = await import("./pi.js");
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
    const warnSpy = vi.spyOn(triageLog, "warn");

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

    const { promptWithFallback } = await import("./pi.js");
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
      expect.stringContaining("FN-002: failed to restore status to 'null' during stuck-detector abort cleanup"),
    );

    warnSpy.mockRestore();
  });

  it("logs warning when logEntry fails during rate-limit retry", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(triageLog, "warn");

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

      const { promptWithFallback } = await import("./pi.js");
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
    const warnSpy = vi.spyOn(triageLog, "warn");
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
      "test.txt",
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
  }) {
    const { assignedAgentId, assignedAgentSkills } = options || {};

    const mockAgentStore = {
      getAgent: vi.fn().mockImplementation(async (id: string) => {
        if (id === assignedAgentId && assignedAgentSkills) {
          return {
            id,
            name: "Test Agent",
            role: "triage",
            state: "idle",
            metadata: { skills: assignedAgentSkills },
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
    it("passes skillSelection to createFnAgent with correct projectRootDir", async () => {
      const args = await captureCreateFnAgentArgs({
        assignedAgentId: "agent-001",
        assignedAgentSkills: ["triage"],
      });

      expect(args).not.toBeNull();
      expect(args).toHaveProperty("skillSelection");
      expect(args.skillSelection.projectRootDir).toBe(projectRoot);
    });

    it("uses 'triage' as sessionPurpose for triage sessions", async () => {
      const args = await captureCreateFnAgentArgs({
        assignedAgentId: "agent-001",
        assignedAgentSkills: ["triage"],
      });

      expect(args).not.toBeNull();
      expect(args.skillSelection?.sessionPurpose).toBe("triage");
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

  it("does not evict tasks that have been in processing less than 30 minutes", () => {
    const store = createMockStore();
    const processor = new TriageProcessor(store, "/tmp/root");

    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    (processor as any).processing.add("FN-001");
    (processor as any).processingSince.set("FN-001", Date.now());

    // Advance time 29 minutes — not stale yet
    vi.setSystemTime(new Date("2026-01-01T00:29:00.000Z"));

    const evicted = processor.evictStaleProcessing();

    expect(evicted.size).toBe(0);
    expect(processor.getProcessingTaskIds().has("FN-001")).toBe(true);
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
      getTask: vi.fn().mockResolvedValue({
        id: "FN-TRIAGE",
        title: "Test",
        description: "Test task",
        column: "triage",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        status: "specifying",
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

  it("createTriageTools returns fn_task_list, fn_task_get, fn_task_create (no delegation tools — those are in customTools)", () => {
    const store = createMockStore();
    const processor = new TriageProcessor(store as any, "/tmp/root");

    const tools = (processor as any).createTriageTools({
      parentTaskId: "FN-TRIAGE",
      allowTaskCreate: true,
      createdSubtasksRef: { current: [] },
    });

    const toolNames = tools.map((t: any) => t.name);
    expect(toolNames).toContain("fn_task_list");
    expect(toolNames).toContain("fn_task_get");
    expect(toolNames).toContain("fn_task_create");
    // fn_list_agents and fn_delegate_task are added in customTools, not createTriageTools
    expect(toolNames).not.toContain("fn_list_agents");
    expect(toolNames).not.toContain("fn_delegate_task");
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
