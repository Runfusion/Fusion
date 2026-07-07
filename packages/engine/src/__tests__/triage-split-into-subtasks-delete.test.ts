import { describe, it, expect, vi } from "vitest";
import type { Settings, Task, TaskStore } from "@fusion/core";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TriageProcessor } from "../triage.js";

const { mockCreateFnAgent } = vi.hoisted(() => ({ mockCreateFnAgent: vi.fn() }));

vi.mock("../pi.js", () => {
  /*
  FNXC:EngineTests 2026-07-07-08:05:
  triage.ts specifyTask now (FN-7559) checks `err instanceof ModelFallbackExhaustedError` in its catch and (earlier, agentWork) calls `formatModelMarkerDetails`. The pi mock must expose both so the instanceof guard is callable and agentWork's model-marker formatting resolves, instead of crashing happy-path specifyTask runs.
  */
  class ModelFallbackExhaustedError extends Error {}
  return {
    ModelFallbackExhaustedError,
    createFnAgent: mockCreateFnAgent,
    describeModel: vi.fn().mockReturnValue("mock-model"),
    formatModelMarkerDetails: vi.fn((model: string) => model),
    promptWithFallback: vi.fn(),
  };
});

vi.mock("@fusion/core", async (importOriginal) => {
  const { createEngineCoreMock } = await import("../test/mockCore.js");
  return createEngineCoreMock(() => importOriginal<typeof import("@fusion/core")>(), {
    resolveAgentPrompt: vi.fn().mockReturnValue(null),
  });
});

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-500",
    title: "Parent task",
    description: "Oversized task",
    column: "triage",
    status: "planning",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as Task;
}

function createStore(overrides: Partial<TaskStore> = {}): TaskStore {
  return {
    getTask: vi.fn().mockResolvedValue(createTask({ attachments: [], comments: [] } as any)),
    listTasks: vi.fn().mockResolvedValue([]),
    createTask: vi.fn().mockResolvedValueOnce({ id: "FN-501" }).mockResolvedValueOnce({ id: "FN-502" }),
    moveTask: vi.fn(),
    updateTask: vi.fn().mockResolvedValue(undefined),
    deleteTask: vi.fn().mockResolvedValue(undefined),
    mergeTask: vi.fn(),
    getSettings: vi.fn().mockResolvedValue({
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 10000,
      groupOverlappingFiles: false,
      autoMerge: true,
      planningFallbackProvider: "fallback-provider",
      planningFallbackModelId: "fallback-model",
    } as Settings),
    logEntry: vi.fn().mockResolvedValue(undefined),
    appendAgentLog: vi.fn().mockResolvedValue(undefined),
    parseDependenciesFromPrompt: vi.fn().mockResolvedValue([]),
    parseStepsFromPrompt: vi.fn().mockResolvedValue([]),
    on: vi.fn(),
    off: vi.fn(),
    ...overrides,
  } as unknown as TaskStore;
}

function mockSessionFactory(captureTools: { current: any[] }): void {
  mockCreateFnAgent.mockImplementation(async (opts: any) => {
    captureTools.current = opts.customTools || [];
    return {
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
        subscribe: vi.fn(),
        sessionManager: {
          getLeafId: vi.fn().mockReturnValue(null),
          navigateTree: vi.fn(),
        },
      },
    };
  });
}

async function createChildrenFromTool(tools: any[]): Promise<void> {
  const taskCreate = tools.find((tool) => tool.name === "fn_task_create");
  if (!taskCreate) return;
  await taskCreate.execute("c1", { title: "Part 1", description: "One", dependencies: [] });
  await taskCreate.execute("c2", { title: "Part 2", description: "Two", dependencies: [] });
}

describe("triage split/delete lineage forwarding", () => {
  it("passes removeLineageReferences when split-close happens on the primary planning path", async () => {
    const store = createStore();
    const captured = { current: [] as any[] };
    mockSessionFactory(captured);

    const { promptWithFallback } = await import("../pi.js");
    (promptWithFallback as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      await createChildrenFromTool(captured.current);
    });

    const processor = new TriageProcessor(store, "/test/root", { pollIntervalMs: 100_000 });
    await processor.specifyTask(createTask());

    expect(store.deleteTask).toHaveBeenCalledWith("FN-500", expect.objectContaining({
      removeLineageReferences: true,
      auditContext: expect.objectContaining({
        agentId: "triage",
        runId: expect.stringMatching(/^triage-delete-FN-500-/),
      }),
    }));
  });

  it("passes removeLineageReferences when split-close happens on the fallback planning path", async () => {
    const store = createStore();
    const captured = { current: [] as any[] };
    mockSessionFactory(captured);

    /*
    FNXC:TriageSplitLineage 2026-07-07-09:05:
    specifyTask now invokes promptWithFallback exactly once — the multi-call retry loop that this test simulated (creating children on the 4th call) no longer exists, so the fallback never fired and deleteTask(removeLineageReferences) was never reached. Simulate the split-close inside that single promptWithFallback call instead. The removeLineageReferences lineage-forwarding invariant (FN-5129/FN-5131) is what this test guards, regardless of how many prompt calls precede it.
    */
    const { promptWithFallback } = await import("../pi.js");
    (promptWithFallback as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      await createChildrenFromTool(captured.current);
    });

    const processor = new TriageProcessor(store, "/test/root", { pollIntervalMs: 100_000 });
    await processor.specifyTask(createTask({ id: "FN-600" }));

    expect(store.deleteTask).toHaveBeenCalledWith("FN-600", expect.objectContaining({
      removeLineageReferences: true,
      auditContext: expect.objectContaining({
        agentId: "triage",
        runId: expect.stringMatching(/^triage-delete-FN-600-/),
      }),
    }));
  });

  it("passes removeLineageReferences on DUPLICATE close", async () => {
    const store = createStore({
      getTask: vi.fn().mockResolvedValue(undefined),
      deleteTask: vi.fn().mockResolvedValue(undefined),
    });

    const rootDir = await mkdtemp(join(tmpdir(), "triage-dup-"));
    try {
      await mkdir(join(rootDir, ".fusion", "tasks", "FN-001"), { recursive: true });
      await writeFile(join(rootDir, ".fusion", "tasks", "FN-001", "PROMPT.md"), "DUPLICATE: FN-4894\n");

      const processor = new TriageProcessor(store, rootDir);
      await processor.recoverApprovedTask(
        createTask({ id: "FN-001", log: [{ timestamp: new Date().toISOString(), action: "Spec review: APPROVE" }] as any }),
      );

      expect(store.deleteTask).toHaveBeenCalledWith("FN-001", expect.objectContaining({
        removeLineageReferences: true,
        auditContext: expect.objectContaining({
          agentId: "triage",
          runId: expect.stringMatching(/^triage-delete-FN-001-/),
        }),
      }));
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
