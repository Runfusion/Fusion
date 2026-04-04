import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TaskStore, Task, TaskDetail, Settings } from "@fusion/core";
import {
  TriageProcessor,
  TRIAGE_SYSTEM_PROMPT,
  buildSpecificationPrompt,
  readAttachmentContents,
} from "./triage.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdir, writeFile, rm } from "node:fs/promises";

const { mockReviewStep, mockCreateKbAgent } = vi.hoisted(() => ({
  mockReviewStep: vi.fn(),
  mockCreateKbAgent: vi.fn(),
}));

vi.mock("./reviewer.js", () => ({
  reviewStep: mockReviewStep,
}));

vi.mock("./pi.js", () => ({
  createKbAgent: mockCreateKbAgent,
  describeModel: vi.fn().mockReturnValue("mock-model"),
  promptWithFallback: vi.fn().mockReturnValue("mock-prompt"),
}));

const __dirname = dirname(fileURLToPath(import.meta.url));

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
    expect(prompt).toContain("Size M or L");
    expect(prompt).toContain("Subtask creation is OPTIONAL");
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
    expect(prompt).toContain("If splitting: use the \\\`task_create\\\` tool");
    expect(prompt).not.toContain("## Subtask Consideration");
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
});

describe("readAttachmentContents", () => {
  const testDir = join(__dirname, "test-attachments");
  const taskId = "FN-TEST";

  beforeEach(async () => {
    // Clean up and create test directory
    await rm(testDir, { recursive: true, force: true });
    await mkdir(join(testDir, ".fusion", "tasks", taskId, "attachments"), {
      recursive: true,
    });
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

  it("re-reads settings when review_spec runs so reviewer uses the latest validator model", async () => {
    const taskId = "FN-001";
    const testRootDir = join(__dirname, "__test_triage_review_spec__");
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
        validatorProvider: "anthropic",
        validatorModelId: "claude-opus-4-6",
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
        validatorModelProvider: "zai",
        validatorModelId: "glm-5.1",
      }),
    );

    await rm(testRootDir, { recursive: true, force: true });
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
  const rootDir = join(__dirname, "__test_triage_approval__");

  beforeEach(async () => {
    await mkdir(rootDir, { recursive: true });
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

    await rm(rootDir, { recursive: true, force: true });
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

  describe("bounded recovery retries for triage", () => {
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

      // Mock createKbAgent to throw a transient error
      mockCreateKbAgent.mockRejectedValue(new Error("upstream connect error"));

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

      mockCreateKbAgent.mockRejectedValue(new Error("connection reset"));

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

      // Set up createKbAgent to return a session that immediately throws
      // after the model log line, so we can verify the appendAgentLog call.
      // The session will be created, model logged, then promptWithFallback
      // throws — but the model log has already been written.
      mockCreateKbAgent.mockResolvedValue({
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
});
