import { describe, it, expect, vi, beforeEach } from "vitest";
import { AgentSemaphore } from "./concurrency.js";

// Mock createKbAgent before importing TriageProcessor
vi.mock("./pi.js", () => ({
  createKbAgent: vi.fn(),
}));

import { TriageProcessor, buildSpecificationPrompt, type AttachmentContent } from "./triage.js";
import { createKbAgent } from "./pi.js";
import type { TaskDetail } from "@kb/core";

const mockedCreateHaiAgent = vi.mocked(createKbAgent);

function createMockStore(tasks: any[] = []) {
  return {
    listTasks: vi.fn().mockResolvedValue(tasks),
    getTask: vi.fn().mockResolvedValue({
      id: "KB-001",
      title: "Test",
      description: "Test task",
      column: "triage",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      prompt: "# test",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
    updateTask: vi.fn().mockResolvedValue({}),
    moveTask: vi.fn().mockResolvedValue({}),
    appendAgentLog: vi.fn().mockResolvedValue(undefined),
    getSettings: vi.fn().mockResolvedValue({
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 15000,
      groupOverlappingFiles: false,
      autoMerge: false,
    }),
  } as any;
}

function createMockTaskDetail(overrides: Partial<TaskDetail> = {}): TaskDetail {
  return {
    id: "KB-001",
    title: "Test Task",
    description: "A test task",
    column: "triage",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    prompt: "",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("TriageProcessor with semaphore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("acquires semaphore before creating agent and releases after", async () => {
    const sem = new AgentSemaphore(1);
    const store = createMockStore();
    const acquireSpy = vi.spyOn(sem, "acquire");
    const releaseSpy = vi.spyOn(sem, "release");

    mockedCreateHaiAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
      },
    } as any);

    const triage = new TriageProcessor(store, "/tmp/test", { semaphore: sem });

    await triage.specifyTask({
      id: "KB-001",
      title: "Test",
      description: "Test",
      column: "triage",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Semaphore was used via run() which calls acquire + release
    expect(acquireSpy).toHaveBeenCalledOnce();
    expect(releaseSpy).toHaveBeenCalledOnce();
    expect(mockedCreateHaiAgent).toHaveBeenCalledOnce();
    expect(sem.activeCount).toBe(0);
  });

  it("releases semaphore on agent error", async () => {
    const sem = new AgentSemaphore(1);
    const store = createMockStore();

    mockedCreateHaiAgent.mockRejectedValue(new Error("agent failed"));

    const onError = vi.fn();
    const triage = new TriageProcessor(store, "/tmp/test", {
      semaphore: sem,
      onSpecifyError: onError,
    });

    await triage.specifyTask({
      id: "KB-001",
      title: "Test",
      description: "Test",
      column: "triage",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    expect(sem.activeCount).toBe(0);
    expect(onError).toHaveBeenCalled();
  });

  it("concurrent specifyTask calls respect semaphore limit", async () => {
    const sem = new AgentSemaphore(1);
    const store = createMockStore();
    let concurrent = 0;
    let maxConcurrent = 0;

    mockedCreateHaiAgent.mockImplementation(async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      return {
        session: {
          prompt: vi.fn().mockImplementation(async () => {
            await new Promise((r) => setTimeout(r, 10));
            concurrent--;
          }),
          dispose: vi.fn(),
        },
      } as any;
    });

    const triage = new TriageProcessor(store, "/tmp/test", { semaphore: sem });

    const task = (id: string) => ({
      id,
      title: "Test",
      description: "Test",
      column: "triage" as const,
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    await Promise.all([
      triage.specifyTask(task("KB-001")),
      triage.specifyTask(task("KB-002")),
      triage.specifyTask(task("KB-003")),
    ]);

    expect(maxConcurrent).toBe(1);
    expect(sem.activeCount).toBe(0);
  });
});

describe("TriageProcessor dynamic poll interval", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("refreshes poll interval when settings.pollIntervalMs changes", async () => {
    const store = createMockStore();
    store.getSettings.mockResolvedValue({
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 10000,
      groupOverlappingFiles: false,
      autoMerge: false,
    });

    const triage = new TriageProcessor(store, "/tmp/test");

    // Simulate start state
    (triage as any).running = true;
    (triage as any).activePollMs = 10000;
    (triage as any).pollInterval = setInterval(() => {}, 10000);

    // First poll — same interval, no change
    await (triage as any).poll();
    expect((triage as any).activePollMs).toBe(10000);

    // Change pollIntervalMs in settings
    store.getSettings.mockResolvedValue({
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 3000,
      groupOverlappingFiles: false,
      autoMerge: false,
    });

    await (triage as any).poll();
    expect((triage as any).activePollMs).toBe(3000);

    // Clean up
    triage.stop();
  });
});

describe("TriageProcessor paused tasks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("skips paused triage tasks in poll()", async () => {
    const pausedTask = {
      id: "KB-001",
      title: "Paused",
      description: "Paused task",
      column: "triage" as const,
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      paused: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const store = createMockStore([pausedTask]);

    mockedCreateHaiAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
      },
    } as any);

    const triage = new TriageProcessor(store, "/tmp/test");
    (triage as any).running = true;
    await (triage as any).poll();

    // Agent should never be created for a paused task
    expect(mockedCreateHaiAgent).not.toHaveBeenCalled();
    expect(store.updateTask).not.toHaveBeenCalled();
  });

  it("processes non-paused triage tasks normally", async () => {
    const normalTask = {
      id: "KB-002",
      title: "Normal",
      description: "Normal task",
      column: "triage" as const,
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const store = createMockStore([normalTask]);

    mockedCreateHaiAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
      },
    } as any);

    const triage = new TriageProcessor(store, "/tmp/test");
    (triage as any).running = true;
    await (triage as any).poll();

    // Agent should be created for a non-paused task
    expect(store.updateTask).toHaveBeenCalledWith("KB-002", { status: "specifying" });
  });
});

describe("buildSpecificationPrompt", () => {
  it("includes project commands when testCommand is set", () => {
    const task = createMockTaskDetail();
    const result = buildSpecificationPrompt(task, ".kb/tasks/KB-001/PROMPT.md", {
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 15000,
      groupOverlappingFiles: false,
      autoMerge: false,
      testCommand: "pnpm test",
    });

    expect(result).toContain("## Project Commands");
    expect(result).toContain("**Test:** `pnpm test`");
    expect(result).toContain("Use these exact commands");
  });

  it("includes project commands when buildCommand is set", () => {
    const task = createMockTaskDetail();
    const result = buildSpecificationPrompt(task, ".kb/tasks/KB-001/PROMPT.md", {
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 15000,
      groupOverlappingFiles: false,
      autoMerge: false,
      buildCommand: "pnpm build",
    });

    expect(result).toContain("## Project Commands");
    expect(result).toContain("**Build:** `pnpm build`");
  });

  it("includes both commands when both are set", () => {
    const task = createMockTaskDetail();
    const result = buildSpecificationPrompt(task, ".kb/tasks/KB-001/PROMPT.md", {
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 15000,
      groupOverlappingFiles: false,
      autoMerge: false,
      testCommand: "npm test",
      buildCommand: "npm run build",
    });

    expect(result).toContain("**Test:** `npm test`");
    expect(result).toContain("**Build:** `npm run build`");
  });

  it("omits project commands section when neither command is set", () => {
    const task = createMockTaskDetail();
    const result = buildSpecificationPrompt(task, ".kb/tasks/KB-001/PROMPT.md", {
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 15000,
      groupOverlappingFiles: false,
      autoMerge: false,
    });

    expect(result).not.toContain("## Project Commands");
  });

  it("omits project commands section when settings is undefined", () => {
    const task = createMockTaskDetail();
    const result = buildSpecificationPrompt(task, ".kb/tasks/KB-001/PROMPT.md");

    expect(result).not.toContain("## Project Commands");
  });

  it("includes text attachment content in fenced code block", () => {
    const task = createMockTaskDetail();
    const attachmentContents: AttachmentContent[] = [
      { originalName: "error.log", mimeType: "text/plain", text: "ERROR: something broke\nStack trace here" },
    ];
    const result = buildSpecificationPrompt(task, ".kb/tasks/KB-001/PROMPT.md", undefined, attachmentContents);

    expect(result).toContain("## Attachments");
    expect(result).toContain("### error.log (text/plain)");
    expect(result).toContain("```\nERROR: something broke\nStack trace here\n```");
  });

  it("includes image attachment reference in prompt", () => {
    const task = createMockTaskDetail();
    const attachmentContents: AttachmentContent[] = [
      { originalName: "screenshot.png", mimeType: "image/png", text: null },
    ];
    const result = buildSpecificationPrompt(task, ".kb/tasks/KB-001/PROMPT.md", undefined, attachmentContents);

    expect(result).toContain("## Attachments");
    expect(result).toContain("**screenshot.png** (image/png)");
    expect(result).toContain("included as image below");
  });

  it("includes both image and text attachments", () => {
    const task = createMockTaskDetail();
    const attachmentContents: AttachmentContent[] = [
      { originalName: "screenshot.png", mimeType: "image/png", text: null },
      { originalName: "config.json", mimeType: "application/json", text: '{"key": "value"}' },
    ];
    const result = buildSpecificationPrompt(task, ".kb/tasks/KB-001/PROMPT.md", undefined, attachmentContents);

    expect(result).toContain("**screenshot.png** (image/png)");
    expect(result).toContain("### config.json (application/json)");
    expect(result).toContain('{"key": "value"}');
  });

  it("omits attachments section when no attachments", () => {
    const task = createMockTaskDetail();
    const result = buildSpecificationPrompt(task, ".kb/tasks/KB-001/PROMPT.md", undefined, []);

    expect(result).not.toContain("## Attachments");
  });

  it("omits attachments section when attachmentContents is undefined", () => {
    const task = createMockTaskDetail();
    const result = buildSpecificationPrompt(task, ".kb/tasks/KB-001/PROMPT.md");

    expect(result).not.toContain("## Attachments");
  });
});

describe("TRIAGE_SYSTEM_PROMPT and task_get tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("system prompt contains dependency awareness instructions", async () => {
    const store = createMockStore();

    mockedCreateHaiAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
      },
    } as any);

    const triage = new TriageProcessor(store, "/tmp/test");
    await triage.specifyTask({
      id: "KB-001",
      title: "Test",
      description: "Test",
      column: "triage",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const callArgs = mockedCreateHaiAgent.mock.calls[0][0];
    const systemPrompt = callArgs.systemPrompt as string;
    expect(systemPrompt).toContain("## Dependency awareness");
    expect(systemPrompt).toContain("call `task_get` on that task ID to read its PROMPT.md");
  });

  it("task_get tool description mentions reading dependency specs", async () => {
    const store = createMockStore();

    mockedCreateHaiAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
      },
    } as any);

    const triage = new TriageProcessor(store, "/tmp/test");
    await triage.specifyTask({
      id: "KB-001",
      title: "Test",
      description: "Test",
      column: "triage",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const callArgs = mockedCreateHaiAgent.mock.calls[0][0];
    const tools = callArgs.customTools as any[];
    const taskGetTool = tools.find((t: any) => t.name === "task_get");
    expect(taskGetTool).toBeDefined();
    expect(taskGetTool.description).toContain("read dependency task specs");
  });
});

function createEnoentError(path = "/fake/path"): NodeJS.ErrnoException {
  return Object.assign(
    new Error(`ENOENT: no such file or directory, open '${path}'`),
    { code: "ENOENT", errno: -2, syscall: "open" },
  );
}

const dummyTask = {
  id: "KB-099",
  title: "Deleted task",
  description: "This task was deleted",
  column: "triage" as const,
  dependencies: [],
  steps: [],
  currentStep: 0,
  log: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

describe("TriageProcessor deleted task handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("handles ENOENT from updateTask gracefully without calling onSpecifyError", async () => {
    const store = createMockStore();
    store.updateTask.mockRejectedValue(createEnoentError());

    const onError = vi.fn();
    const triage = new TriageProcessor(store, "/tmp/test", {
      onSpecifyError: onError,
    });

    // Should not throw
    await triage.specifyTask(dummyTask);

    expect(onError).not.toHaveBeenCalled();
    // updateTask was called once (the "specifying" call that threw)
    expect(store.updateTask).toHaveBeenCalledTimes(1);
  });

  it("handles ENOENT from getTask gracefully", async () => {
    const store = createMockStore();
    store.updateTask.mockResolvedValue({});
    store.getTask.mockRejectedValue(createEnoentError());

    const onError = vi.fn();
    const triage = new TriageProcessor(store, "/tmp/test", {
      onSpecifyError: onError,
    });

    await triage.specifyTask(dummyTask);

    expect(onError).not.toHaveBeenCalled();
    // updateTask called once for "specifying", but NOT for status reset (ENOENT path skips it)
    expect(store.updateTask).toHaveBeenCalledTimes(1);
  });

  it("cleans up processing Set on ENOENT so task is not stuck", async () => {
    const store = createMockStore();
    store.updateTask.mockRejectedValueOnce(createEnoentError());

    const triage = new TriageProcessor(store, "/tmp/test", {});

    // First call — ENOENT
    await triage.specifyTask(dummyTask);

    // Second call with same task should NOT short-circuit from processing guard.
    // Reset mock to succeed and set up agent mock for the retry path.
    store.updateTask.mockResolvedValue({});
    mockedCreateHaiAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
      },
    } as any);

    await triage.specifyTask(dummyTask);

    // If processing Set was cleaned up, updateTask will be called again for "specifying"
    expect(store.updateTask).toHaveBeenCalledWith("KB-099", { status: "specifying" });
    expect(mockedCreateHaiAgent).toHaveBeenCalled();
  });
});

describe("TriageProcessor agent log persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("logs text deltas to store.appendAgentLog", async () => {
    const store = createMockStore();
    let capturedOnText: ((delta: string) => void) | undefined;

    mockedCreateHaiAgent.mockImplementation(async (opts: any) => {
      capturedOnText = opts.onText;
      return {
        session: {
          prompt: vi.fn().mockImplementation(async () => {
            // Simulate text deltas from the agent
            capturedOnText?.("Hello ");
            capturedOnText?.("world");
          }),
          dispose: vi.fn(),
        },
      } as any;
    });

    const triage = new TriageProcessor(store, "/tmp/test", {});
    await triage.specifyTask({
      id: "KB-001",
      title: "Test",
      description: "Test",
      column: "triage",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Text buffer is flushed in finally block
    expect(store.appendAgentLog).toHaveBeenCalledWith("KB-001", "Hello world", "text", undefined, "triage");
  });

  it("logs tool invocations to store.appendAgentLog", async () => {
    const store = createMockStore();
    let capturedOnToolStart: ((name: string, args: any) => void) | undefined;

    mockedCreateHaiAgent.mockImplementation(async (opts: any) => {
      capturedOnToolStart = opts.onToolStart;
      return {
        session: {
          prompt: vi.fn().mockImplementation(async () => {
            capturedOnToolStart?.("Read", { path: "foo.ts" });
          }),
          dispose: vi.fn(),
        },
      } as any;
    });

    const triage = new TriageProcessor(store, "/tmp/test", {});
    await triage.specifyTask({
      id: "KB-001",
      title: "Test",
      description: "Test",
      column: "triage",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    expect(store.appendAgentLog).toHaveBeenCalledWith("KB-001", "Read", "tool", "foo.ts", "triage");
  });

  it("still fires onAgentText callback alongside logging", async () => {
    const store = createMockStore();
    const onAgentText = vi.fn();
    let capturedOnText: ((delta: string) => void) | undefined;

    mockedCreateHaiAgent.mockImplementation(async (opts: any) => {
      capturedOnText = opts.onText;
      return {
        session: {
          prompt: vi.fn().mockImplementation(async () => {
            capturedOnText?.("hi");
          }),
          dispose: vi.fn(),
        },
      } as any;
    });

    const triage = new TriageProcessor(store, "/tmp/test", { onAgentText });
    await triage.specifyTask({
      id: "KB-001",
      title: "Test",
      description: "Test",
      column: "triage",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    expect(onAgentText).toHaveBeenCalledWith("KB-001", "hi");
    expect(store.appendAgentLog).toHaveBeenCalledWith("KB-001", "hi", "text", undefined, "triage");
  });
});
