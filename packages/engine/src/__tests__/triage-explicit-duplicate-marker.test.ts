import { describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Settings, Task, TaskStore } from "@fusion/core";

import { TriageProcessor } from "../triage.js";

function createMockStore(overrides: Partial<TaskStore> = {}): TaskStore {
  return {
    getTask: vi.fn(),
    getSettings: vi.fn().mockResolvedValue({ requirePlanApproval: false } as Settings),
    logEntry: vi.fn(),
    deleteTask: vi.fn(),
    deleteTaskIf: vi.fn().mockResolvedValue({ deleted: true }),
    recordActivity: vi.fn(),
    updateTask: vi.fn(),
    withTaskLock: vi.fn().mockImplementation(async (_id: string, operation: () => Promise<unknown>) => await operation()),
    readTaskForMove: vi.fn().mockImplementation(async () => createTask()),
    moveTask: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    ...overrides,
  } as unknown as TaskStore;
}

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-002",
    title: "Incoming duplicate",
    description: "desc",
    column: "triage",
    status: "planning",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("triage explicit duplicate marker short-circuit", () => {
  const rootDir = process.cwd();
  const settings = { requirePlanApproval: true } as Settings;

  async function runExplicitDuplicateMarker(
    store: TaskStore,
    task: Task,
    prompt: string,
    testSettings: Settings = settings,
  ): Promise<boolean> {
    const processor = new TriageProcessor(store, rootDir);
    return await (processor as any).tryFinalizeExplicitDuplicateMarker(task, prompt, testSettings, {});
  }

  it("deletes the duplicate task and records explicit-marker activity", async () => {
    const canonical = createTask({ id: "FN-001", title: "Canonical task", column: "todo" });
    const task = createTask();
    const store = createMockStore({
      getTask: vi.fn().mockImplementation(async (id: string) => (id === canonical.id ? canonical : task)),
    });

    await expect(runExplicitDuplicateMarker(store, task, "DUPLICATE: FN-001\n", { ...settings, triageDuplicateResolution: "delete" })).resolves.toBe(true);

    expect((store as any).deleteTaskIf).toHaveBeenCalledWith("FN-002", expect.any(Function), expect.objectContaining({
      removeLineageReferences: true,
      auditContext: expect.objectContaining({
        agentId: "triage",
        runId: expect.stringMatching(/^triage-delete-FN-002-/),
      }),
    }));
    expect(store.recordActivity).toHaveBeenCalledWith(expect.objectContaining({
      type: "task:auto-archived-duplicate",
      taskId: "FN-002",
      metadata: expect.objectContaining({ canonicalTaskId: "FN-001", source: "explicit-marker" }),
    }));
  });


  it("resolves an exact title redirect before starting a planner session", async () => {
    const canonical = createTask({ id: "KB-123", title: "Canonical task", column: "todo" });
    const task = createTask({ title: "DUPLICATE: KB-123", status: null });
    const onSpecifyStart = vi.fn();
    const store = createMockStore({
      getTask: vi.fn().mockImplementation(async (id: string) => id === canonical.id ? canonical : task),
    });
    const processor = new TriageProcessor(store, rootDir, { onSpecifyStart });

    await processor.specifyTask(task);

    expect(onSpecifyStart).not.toHaveBeenCalled();
    expect(store.updateTask).toHaveBeenCalledWith("FN-002", expect.objectContaining({
      paused: true,
      pausedReason: "duplicate-decision-required",
      sourceMetadataPatch: expect.objectContaining({ nearDuplicateOf: "KB-123" }),
    }));
  });

  it("flags and system-pauses duplicates by default instead of deleting", async () => {
    const canonical = createTask({ id: "FN-001", column: "todo" });
    const task = createTask();
    const store = createMockStore({
      getTask: vi.fn().mockImplementation(async (id: string) => id === canonical.id ? canonical : task),
    });
    await expect(runExplicitDuplicateMarker(store, task, "DUPLICATE: FN-001\n")).resolves.toBe(true);
    expect(store.deleteTask).not.toHaveBeenCalled();
    expect(store.updateTask).toHaveBeenCalledWith("FN-002", expect.objectContaining({ paused: true, pausedReason: "duplicate-decision-required" }));
    expect(store.updateTask).toHaveBeenCalledWith("FN-002", expect.objectContaining({ sourceMetadataPatch: expect.objectContaining({ nearDuplicateOf: "FN-001", duplicateSource: "triage-marker" }) }));
  });

  it("still pauses a user-authored task when the duplicate target is active", async () => {
    const canonical = createTask({ id: "FN-001", column: "in-progress" });
    const task = createTask({ sourceType: "dashboard_ui" });
    const store = createMockStore({
      getTask: vi.fn().mockImplementation(async (id: string) => id === canonical.id ? canonical : task),
    });

    await expect(runExplicitDuplicateMarker(store, task, "DUPLICATE: FN-001\n")).resolves.toBe(true);

    expect(store.updateTask).toHaveBeenCalledWith("FN-002", expect.objectContaining({
      paused: true,
      pausedReason: "duplicate-decision-required",
    }));
  });

  it("keeps a marker duplicate by clearing its system pause for replanning", async () => {
    const canonical = createTask({ id: "FN-001", column: "todo" });
    const task = createTask();
    const store = createMockStore({
      getTask: vi.fn().mockImplementation(async (id: string) => id === canonical.id ? canonical : task),
      withTaskLock: vi.fn().mockImplementation(async (_id: string, operation: () => Promise<unknown>) => await operation()),
      readTaskForMove: vi.fn().mockResolvedValue(task),
    });
    await expect(runExplicitDuplicateMarker(store, task, "DUPLICATE: FN-001\n", { ...settings, triageDuplicateResolution: "keep" })).resolves.toBe(true);
    expect(store.deleteTask).not.toHaveBeenCalled();
    // Must leave needs-replan (not status:null) so the scheduler does not wake on a prompt-less card.
    expect(store.updateTask).toHaveBeenCalledWith("FN-002", expect.objectContaining({
      paused: false,
      pausedReason: null,
      status: "needs-replan",
      sourceMetadataPatch: expect.objectContaining({ nearDuplicateOf: "FN-001", nearDuplicateDismissed: true }),
    }));
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-002",
      "Duplicate marker cleared for re-specification",
      expect.stringContaining("FN-001"),
    );
  });

  it("keeps an executable prompt when clearing a title-only redirect", async () => {
    const task = createTask({ title: "DUPLICATE: KB-123" });
    const canonical = createTask({ id: "KB-123", title: "Canonical task", column: "todo" });
    const root = await mkdtemp(join(tmpdir(), "fusion-title-redirect-"));
    const promptPath = join(root, ".fusion", "tasks", task.id, "PROMPT.md");
    await mkdir(join(root, ".fusion", "tasks", task.id), { recursive: true });
    await writeFile(promptPath, "# Complete operator-authored plan\n", "utf8");
    const store = createMockStore({
      getTask: vi.fn().mockImplementation(async (id: string) => id === canonical.id ? canonical : task),
      withTaskLock: vi.fn().mockImplementation(async (_id: string, operation: () => Promise<unknown>) => await operation()),
      readTaskForMove: vi.fn().mockResolvedValue(task),
    });

    try {
      const processor = new TriageProcessor(store, root);
      await expect((processor as any).tryFinalizeExplicitDuplicateMarker(
        task,
        "# Complete operator-authored plan\n",
        { ...settings, triageDuplicateResolution: "keep" },
        {},
      )).resolves.toBe(true);

      await expect(readFile(promptPath, "utf8")).resolves.toBe("# Complete operator-authored plan\n");
      expect(store.updateTask).toHaveBeenCalledWith(task.id, { title: "Duplicate redirect cleared: KB-123" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not re-pause a same-canonical Keep acknowledgement after marker reprocessing", async () => {
    const canonical = createTask({ id: "FN-001", column: "todo" });
    const task = createTask({
      sourceMetadata: { nearDuplicateOf: "fn-001", duplicateSource: "triage-marker", nearDuplicateDismissed: true },
    });
    const store = createMockStore({
      getTask: vi.fn().mockImplementation(async (id: string) => id === canonical.id ? canonical : task),
      withTaskLock: vi.fn().mockImplementation(async (_id: string, operation: () => Promise<unknown>) => await operation()),
      readTaskForMove: vi.fn().mockResolvedValue(task),
    });

    await expect(runExplicitDuplicateMarker(store, task, "DUPLICATE: FN-001\n")).resolves.toBe(true);

    expect(store.updateTask).toHaveBeenCalledWith("FN-002", expect.objectContaining({
      paused: false,
      pausedReason: null,
      status: "needs-replan",
      sourceMetadataPatch: expect.objectContaining({ nearDuplicateOf: "FN-001", nearDuplicateDismissed: true }),
    }));
    expect(store.updateTask).not.toHaveBeenCalledWith("FN-002", expect.objectContaining({ paused: true }));
  });

  it("prompts when a reprocessed marker names a different active canonical", async () => {
    const canonical = createTask({ id: "FN-001", column: "todo" });
    const task = createTask({
      sourceMetadata: { nearDuplicateOf: "FN-003", duplicateSource: "triage-marker", nearDuplicateDismissed: true },
    });
    const store = createMockStore({
      getTask: vi.fn().mockImplementation(async (id: string) => id === canonical.id ? canonical : task),
    });

    await expect(runExplicitDuplicateMarker(store, task, "DUPLICATE: FN-001\n")).resolves.toBe(true);

    expect(store.updateTask).toHaveBeenCalledWith("FN-002", expect.objectContaining({
      paused: true,
      pausedReason: "duplicate-decision-required",
      sourceMetadataPatch: expect.objectContaining({ nearDuplicateDismissed: false, nearDuplicateOf: "FN-001" }),
    }));
  });

  it("preserves a user pause when reprocessing an acknowledged marker", async () => {
    const canonical = createTask({ id: "FN-001", column: "todo" });
    const task = createTask({
      paused: true,
      pausedReason: "manual",
      userPaused: true,
      sourceMetadata: { nearDuplicateOf: "FN-001", duplicateSource: "triage-marker", nearDuplicateDismissed: true },
    });
    const store = createMockStore({
      getTask: vi.fn().mockImplementation(async (id: string) => id === canonical.id ? canonical : task),
      readTaskForMove: vi.fn().mockResolvedValue(task),
    });

    await expect(runExplicitDuplicateMarker(store, task, "DUPLICATE: FN-001\n")).resolves.toBe(true);

    expect(store.updateTask).not.toHaveBeenCalled();
  });
  it.each([
    ["missing", null],
    ["soft-deleted", createTask({ id: "FN-001", deletedAt: new Date().toISOString() })],
    ["done", createTask({ id: "FN-001", column: "done" })],
    ["archived", createTask({ id: "FN-001", column: "archived" })],
  ])("clears an inactive %s canonical marker instead of pausing for a hidden decision", async (_state, canonical) => {
    const task = createTask();
    const store = createMockStore({
      getTask: vi.fn().mockImplementation(async (id: string) => id === "FN-001" ? canonical : task),
      readTaskForMove: vi.fn().mockResolvedValue(task),
    });

    await expect(runExplicitDuplicateMarker(store, task, "DUPLICATE: FN-001\n")).resolves.toBe(true);

    // needs-replan + dismissal + feedback — never status:null (FN-8704 replan storm)
    expect(store.updateTask).toHaveBeenCalledWith("FN-002", expect.objectContaining({
      paused: false,
      pausedReason: null,
      status: "needs-replan",
      sourceMetadataPatch: expect.objectContaining({
        nearDuplicateOf: "FN-001",
        nearDuplicateDismissed: true,
        duplicateSource: "triage-marker",
        duplicateMarkerClearCount: 1,
      }),
    }));
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-002",
      "Duplicate marker cleared for re-specification",
      expect.stringMatching(/FN-001.*do not re-emit/i),
    );
    expect(store.updateTask).not.toHaveBeenCalledWith("FN-002", expect.objectContaining({ paused: true }));
    expect(store.deleteTask).not.toHaveBeenCalled();
  });

  it("replans programmatic work when an inactive DUPLICATE is re-emitted after dismissal", async () => {
    const task = createTask({
      sourceMetadata: {
        nearDuplicateOf: "FN-001",
        duplicateSource: "triage-marker",
        nearDuplicateDismissed: true,
        duplicateMarkerClearCount: 1,
      },
    });
    const store = createMockStore({
      getTask: vi.fn().mockImplementation(async (id: string) =>
        id === "FN-001" ? createTask({ id: "FN-001", column: "done" }) : task,
      ),
      readTaskForMove: vi.fn().mockResolvedValue(task),
    });

    await expect(runExplicitDuplicateMarker(store, task, "DUPLICATE: FN-001\n")).resolves.toBe(true);

    expect(store.updateTask).toHaveBeenCalledWith("FN-002", expect.objectContaining({
      status: "needs-replan",
      error: null,
      sourceMetadataPatch: expect.objectContaining({ duplicateMarkerClearCount: 2 }),
    }));
  });

  it("replans a user-authored task when the planner re-emits a completed duplicate", async () => {
    const task = createTask({
      sourceType: "dashboard_ui",
      sourceMetadata: {
        nearDuplicateOf: "FN-001",
        duplicateSource: "triage-marker",
        nearDuplicateDismissed: true,
        duplicateMarkerClearCount: 1,
      },
    });
    const store = createMockStore({
      getTask: vi.fn().mockImplementation(async (id: string) =>
        id === "FN-001" ? createTask({ id: "FN-001", column: "done" }) : task,
      ),
      readTaskForMove: vi.fn().mockResolvedValue(task),
    });

    await expect(runExplicitDuplicateMarker(store, task, "DUPLICATE: FN-001\n")).resolves.toBe(true);

    expect(store.updateTask).toHaveBeenCalledWith("FN-002", expect.objectContaining({
      status: "needs-replan",
      error: null,
      sourceMetadataPatch: expect.objectContaining({ duplicateMarkerClearCount: 2 }),
    }));
    expect(store.updateTask).not.toHaveBeenCalledWith("FN-002", expect.objectContaining({
      status: "failed",
    }));
  });

  it.each([
    ["user pause", createTask({ userPaused: true, paused: true, pausedReason: "manual" })],
    ["implicit user pause", createTask({ paused: true, pausedReason: null })],
    ["unrelated pause", createTask({ paused: true, pausedReason: "awaiting-approval" })],
  ])("preserves a %s while an inactive marker is encountered", async (_label, task) => {
    const store = createMockStore({ getTask: vi.fn().mockResolvedValue(null) });

    await expect(runExplicitDuplicateMarker(store, task, "DUPLICATE: FN-001\n")).resolves.toBe(true);

    expect(store.updateTask).not.toHaveBeenCalled();
  });

  it("does not short-circuit on circular self-reference", async () => {
    const task = createTask();
    const store = createMockStore({
      getTask: vi.fn().mockResolvedValue(task),
    });

    await expect(runExplicitDuplicateMarker(store, task, "DUPLICATE: FN-002\n")).resolves.toBe(false);

    expect(store.deleteTask).not.toHaveBeenCalled();
  });

  it("does not short-circuit for a full spec that mentions duplicate", async () => {
    const store = createMockStore({
      getTask: vi.fn(),
    });
    const fullSpec = `# Task: FN-002 - Example\n\n## Mission\nWe suspected this might duplicate another task, but it is a full prompt body.\n`;

    await expect(runExplicitDuplicateMarker(store, createTask(), fullSpec)).resolves.toBe(false);

    expect(store.getTask).not.toHaveBeenCalled();
    expect(store.deleteTask).not.toHaveBeenCalled();
  });

  it("fails open when store lookup throws", async () => {
    const store = createMockStore({
      getTask: vi.fn().mockRejectedValue(new Error("boom")),
    });

    await expect(runExplicitDuplicateMarker(store, createTask(), "DUPLICATE: FN-001\n")).resolves.toBe(false);

    expect(store.deleteTask).not.toHaveBeenCalled();
    expect(store.recordActivity).not.toHaveBeenCalled();
  });
});
