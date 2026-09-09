import { describe, it, expect, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { TaskStore, TaskDetail, Settings } from "@fusion/core";
import { TriageProcessor } from "../triage.js";

vi.mock("@fusion/core", async (importOriginal) => {
  const { createEngineCoreMock } = await import("../test/mockCore.js");
  return createEngineCoreMock(() => importOriginal<typeof import("@fusion/core")>(), {
    resolveAgentPrompt: vi.fn().mockReturnValue(null),
  });
});

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
  id: "FN-5112",
  description: "Test task",
  column: "triage",
  dependencies: [],
  steps: [],
  currentStep: 0,
  log: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  prompt: "# Task\n",
  attachments: [],
  comments: [],
};

describe("triage deterministic plan validation for dangling references", () => {
  it("rejects dangling task-document references without invoking reviewer", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "fusion-triage-dangling-"));
    try {
      const taskId = "FN-5112";
      const store = createMockStore({
        getTask: vi.fn().mockResolvedValue({ ...mockTaskDetail, id: taskId }),
      });
      const processor = new TriageProcessor(store, rootDir);
      const failure = await (processor as any).validateGeneratedPrompt(
        taskId,
        "## Steps\n### Step 0: Preflight\n- Read .fusion/tasks/FN-5112/notes.md\n",
      );

      expect(failure).toContain("notes.md");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("passes when referenced file is declared as new artifact", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "fusion-triage-dangling-ok-"));
    try {
      const taskId = "FN-5112";
      const store = createMockStore({
        getTask: vi.fn().mockResolvedValue({ ...mockTaskDetail, id: taskId }),
      });
      const processor = new TriageProcessor(store, rootDir);
      const failure = await (processor as any).validateGeneratedPrompt(
        taskId,
        "## Steps\n### Step 0: Create\n- Read .fusion/tasks/FN-5112/notes.md\n\n**Artifacts:**\n- `.fusion/tasks/FN-5112/notes.md` (new)\n",
      );

      expect(failure).toBeNull();
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("rejects one-based, gapped, and duplicate step-heading sequences", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "fusion-triage-step-numbering-"));
    try {
      const store = createMockStore();
      const processor = new TriageProcessor(store, rootDir);

      for (const prompt of [
        "## Steps\n### Step 1: First\n### Step 2: Second\n",
        "## Steps\n### Step 0: First\n### Step 2: Third\n",
        "## Steps\n### Step 0: First\n### Step 0: Duplicate\n",
      ]) {
        await expect((processor as any).validateGeneratedPrompt("FN-5112", prompt)).resolves.toContain(
          "contiguous 0-based execution indices",
        );
      }
      expect(store.logEntry).toHaveBeenCalledWith(
        "FN-5112",
        "Generated plan validation failed: invalid step heading numbering",
      );
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("accepts contiguous zero-based and heading-free prompts", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "fusion-triage-step-numbering-ok-"));
    try {
      const processor = new TriageProcessor(createMockStore(), rootDir);
      await expect((processor as any).validateGeneratedPrompt(
        "FN-5112",
        "## Steps\n### Step 0: First\n### Step 1: Second\n",
      )).resolves.toBeNull();
      await expect((processor as any).validateGeneratedPrompt(
        "FN-5112",
        "## Steps\n### First\n- plain heading\n",
      )).resolves.toBeNull();
      await expect((processor as any).validateGeneratedPrompt(
        "FN-5112",
        "## Steps\n### Step 0: Preflight\n### Step 1: Plan\n### Step 2: Build\n### Step 3 (depends: 0): Parallel A\n### Step 4: Continue\n### Step 5 (depends: 4): Parallel B\n### Step 6 (depends: 0): Parallel C\n### Step 7: Verify\n### Step 8: Deliver\n",
      )).resolves.toBeNull();
      await expect((processor as any).validateGeneratedPrompt(
        "FN-5112",
        "## Steps\n### Step 0: First\n### Step 1 (depends: 0): Second\n### Step 3 (depends: 1): Gap\n",
      )).resolves.toContain("contiguous 0-based execution indices");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
