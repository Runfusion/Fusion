import { describe, expect, it, vi } from "vitest";
import type { Settings, Task, TaskStore } from "@fusion/core";

import { TriageProcessor } from "../triage.js";

function createMockStore(overrides: Partial<TaskStore> = {}): TaskStore {
  return {
    getTask: vi.fn(),
    getSettings: vi.fn().mockResolvedValue({ requirePlanApproval: false } as Settings),
    logEntry: vi.fn(),
    deleteTask: vi.fn(),
    recordActivity: vi.fn(),
    updateTask: vi.fn(),
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
    const store = createMockStore({
      getTask: vi.fn().mockImplementation(async (id: string) => (id === canonical.id ? canonical : null)),
    });

    await expect(runExplicitDuplicateMarker(store, createTask(), "DUPLICATE: FN-001\n", { ...settings, triageDuplicateResolution: "delete" })).resolves.toBe(true);

    expect(store.deleteTask).toHaveBeenCalledWith("FN-002", expect.objectContaining({
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


  it("flags and system-pauses duplicates by default instead of deleting", async () => {
    const canonical = createTask({ id: "FN-001", column: "todo" });
    const store = createMockStore({ getTask: vi.fn().mockResolvedValue(canonical) });
    await expect(runExplicitDuplicateMarker(store, createTask(), "DUPLICATE: FN-001\n")).resolves.toBe(true);
    expect(store.deleteTask).not.toHaveBeenCalled();
    expect(store.updateTask).toHaveBeenCalledWith("FN-002", expect.objectContaining({ paused: true, pausedReason: "duplicate-decision-required" }));
    expect(store.updateTask).toHaveBeenCalledWith("FN-002", expect.objectContaining({ sourceMetadataPatch: expect.objectContaining({ nearDuplicateOf: "FN-001", duplicateSource: "triage-marker" }) }));
  });

  it("keeps a marker duplicate by clearing its system pause for replanning", async () => {
    const canonical = createTask({ id: "FN-001", column: "todo" });
    const store = createMockStore({ getTask: vi.fn().mockResolvedValue(canonical) });
    await expect(runExplicitDuplicateMarker(store, createTask(), "DUPLICATE: FN-001\n", { ...settings, triageDuplicateResolution: "keep" })).resolves.toBe(true);
    expect(store.deleteTask).not.toHaveBeenCalled();
    expect(store.updateTask).toHaveBeenCalledWith("FN-002", expect.objectContaining({ paused: false, pausedReason: null, status: null }));
  });
  it.each([
    ["missing", null],
    ["soft-deleted", createTask({ id: "FN-001", deletedAt: new Date().toISOString() })],
    ["done", createTask({ id: "FN-001", column: "done" })],
    ["archived", createTask({ id: "FN-001", column: "archived" })],
  ])("clears an inactive %s canonical marker instead of pausing for a hidden decision", async (_state, canonical) => {
    const store = createMockStore({ getTask: vi.fn().mockResolvedValue(canonical) });

    await expect(runExplicitDuplicateMarker(store, createTask(), "DUPLICATE: FN-001\n")).resolves.toBe(true);

    expect(store.updateTask).toHaveBeenCalledWith("FN-002", {
      paused: false,
      pausedReason: null,
      status: null,
    });
    expect(store.updateTask).not.toHaveBeenCalledWith("FN-002", expect.objectContaining({ paused: true }));
    expect(store.deleteTask).not.toHaveBeenCalled();
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
