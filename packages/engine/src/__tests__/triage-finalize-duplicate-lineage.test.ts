import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings, Task, TaskStore } from "@fusion/core";

import { TriageProcessor } from "../triage.js";

function createMockStore(overrides: Partial<TaskStore> = {}): TaskStore {
  const store: any = {
    listTasks: vi.fn().mockResolvedValue([]),
    getTask: vi.fn(),
    getSettings: vi.fn().mockResolvedValue({ requirePlanApproval: false } as Settings),
    parseDependenciesFromPrompt: vi.fn().mockResolvedValue([]),
    parseStepsFromPrompt: vi.fn().mockResolvedValue([]),
    parseFileScopeFromPrompt: vi.fn().mockResolvedValue([]),
    updateTask: vi.fn(),
    moveTask: vi.fn(),
    // FNXC:EngineTests 2026-07-20-23:55: finalize releases via moveTaskIf + withTaskLock (FN-8361).
    moveTaskIf: vi.fn(async (id: string, column: string, predicate: (t: any) => boolean) => {
      const live = await store.getTask(id);
      if (!live || !predicate(live)) return { moved: false, task: live };
      await store.moveTask(id, column);
      return { moved: true, task: { ...live, column, status: null } };
    }),
    withTaskLock: vi.fn(async (_id: string, fn: () => Promise<unknown>) => fn()),
    readTaskForMove: vi.fn(async (id: string) => store.getTask(id)),
    logEntry: vi.fn(),
    // FNXC:EngineTests 2026-07-17-11:45: flagTriageDuplicate records task:auto-archived-duplicate activity.
    recordActivity: vi.fn().mockResolvedValue(undefined),
    deleteTask: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    ...overrides,
  };
  if (!overrides.moveTaskIf) {
    store.moveTaskIf = vi.fn(async (id: string, column: string, predicate: (t: any) => boolean) => {
      const live = await store.getTask(id);
      if (!live || !predicate(live)) return { moved: false, task: live };
      await store.moveTask(id, column);
      return { moved: true, task: { ...live, column, status: null } };
    });
  }
  if (!overrides.withTaskLock) store.withTaskLock = vi.fn(async (_id: string, fn: () => Promise<unknown>) => fn());
  if (!overrides.readTaskForMove) store.readTaskForMove = vi.fn(async (id: string) => store.getTask(id));
  return store as TaskStore;
}

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-001",
    title: "Task",
    description: "desc",
    column: "triage",
    status: "planning",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [{ timestamp: new Date().toISOString(), action: "Spec review: APPROVE" }],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("triage finalize duplicate lineage", () => {
  let rootDir = "";

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "fusion-triage-dup-"));
    await mkdir(join(rootDir, ".fusion", "tasks", "FN-001"), { recursive: true });
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  async function runRecovery(task: Task, prompt: string, store: TaskStore): Promise<void> {
    await writeFile(join(rootDir, ".fusion", "tasks", task.id, "PROMPT.md"), prompt);
    vi.mocked(store.getTask).mockResolvedValue(task as any);
    const processor = new TriageProcessor(store, rootDir);
    await processor.recoverApprovedTask(task);
  }

  it("captures title-only duplicate references", async () => {
    const store = createMockStore();
    await runRecovery(
      createTask({ title: "Foo (duplicate of FN-4894)", description: "plain" }),
      "# Task: FN-001 - Foo\n\nBody",
      store,
    );

    expect(vi.mocked(store.updateTask).mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ sourceMetadataPatch: { duplicateOfTaskIds: ["FN-4894"] } }),
    );
  });

  it("dedupes references across title and description in order", async () => {
    const store = createMockStore();
    await runRecovery(
      createTask({ title: "(duplicate of FN-4894)", description: "duplicates FN-4894, FN-4847" }),
      "# Task: FN-001 - Foo\n\nBody",
      store,
    );

    expect(vi.mocked(store.updateTask).mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ sourceMetadataPatch: { duplicateOfTaskIds: ["FN-4894", "FN-4847"] } }),
    );
  });

  it("filters self references", async () => {
    const store = createMockStore();
    await runRecovery(
      createTask({ title: "(duplicate of FN-001)", description: "duplicate of FN-001" }),
      "# Task: FN-001 - Foo\n\nBody",
      store,
    );

    expect(vi.mocked(store.updateTask).mock.calls[0]?.[1]).not.toHaveProperty("sourceMetadataPatch");
  });

  it("is a no-op when no references are present", async () => {
    const store = createMockStore();
    await runRecovery(createTask({ title: "Normal title", description: "Normal desc" }), "# Task: FN-001 - Foo\n\nBody", store);

    expect(vi.mocked(store.updateTask).mock.calls[0]?.[1]).not.toHaveProperty("sourceMetadataPatch");
  });

  it("preserves opt-in duplicate stub delete path", async () => {
    /*
    FNXC:EngineTests 2026-07-17-11:50:
    Issue #2225 default is prompt (flag + pause). Deletion remains opt-in via
    settings.triageDuplicateResolution === "delete" and still requires a live
    canonical task for the marker short-circuit.
    */
    const store = createMockStore({
      getSettings: vi.fn().mockResolvedValue({ requirePlanApproval: false, triageDuplicateResolution: "delete" } as Settings),
      /*
      FNXC:EngineTests 2026-07-17-18:10:
      PR #2275 review: preserve a default current-task mock for non-canonical IDs.
      Returning undefined for FN-001 risks NPEs if recovery re-fetches the subject task.
      */
      getTask: vi.fn().mockImplementation(async (id: string) => {
        if (id === "FN-4894") {
          return createTask({ id: "FN-4894", title: "Canonical", column: "todo", status: null });
        }
        return createTask({ id: "FN-001" });
      }),
    });
    await runRecovery(createTask(), "DUPLICATE: FN-4894\n", store);

    expect(store.deleteTask).toHaveBeenCalledWith("FN-001", expect.objectContaining({
      removeLineageReferences: true,
      auditContext: expect.objectContaining({
        agentId: "triage",
        runId: expect.stringMatching(/^triage-delete-FN-001-/),
      }),
    }));
  });

  it("flags and parks DUPLICATE markers under default prompt resolution", async () => {
    const store = createMockStore({
      getTask: vi.fn().mockImplementation(async (id: string) => {
        if (id === "FN-4894") {
          return createTask({ id: "FN-4894", title: "Canonical", column: "todo", status: null });
        }
        return createTask({ id: "FN-001" });
      }),
    });
    await runRecovery(createTask(), "DUPLICATE: FN-4894\n", store);

    expect(store.recordActivity).toHaveBeenCalledWith(expect.objectContaining({
      type: "task:auto-archived-duplicate",
      taskId: "FN-001",
    }));
    expect(store.updateTask).toHaveBeenCalledWith(
      "FN-001",
      expect.objectContaining({
        sourceMetadataPatch: expect.objectContaining({ nearDuplicateOf: "FN-4894", duplicateSource: "triage-marker" }),
      }),
    );
    expect(store.updateTask).toHaveBeenCalledWith(
      "FN-001",
      expect.objectContaining({ paused: true, pausedReason: "duplicate-decision-required" }),
    );
    expect(store.deleteTask).not.toHaveBeenCalled();
  });
});
