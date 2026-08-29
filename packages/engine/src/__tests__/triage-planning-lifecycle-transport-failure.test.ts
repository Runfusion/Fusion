import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings, Task, TaskStore } from "@fusion/core";
import { PlanningLifecycleLockTransportError } from "@fusion/core";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const { mockCreateFnAgent, mockPromptWithFallback } = vi.hoisted(() => ({
  mockCreateFnAgent: vi.fn(),
  mockPromptWithFallback: vi.fn(),
}));

vi.mock("../pi.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../pi.js")>();
  return {
    ...actual,
    createFnAgent: mockCreateFnAgent,
    promptWithFallback: mockPromptWithFallback,
  };
});

import { TriageProcessor } from "../triage.js";

const TRANSPORT_MARKER = "planning.lifecycleLockTransportFailure";

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-8911",
    description: "Plan a direct PostgreSQL deployment",
    column: "triage",
    status: null,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-08-09T00:00:00.000Z",
    updatedAt: "2026-08-09T00:00:00.000Z",
    customFields: { unrelated: "preserve-me" },
    ...overrides,
  };
}

function createPersistedStore(initialTask: Task): { store: TaskStore; task: () => Task; logs: string[] } {
  let persisted = initialTask;
  const logs: string[] = [];
  const update = async (_id: string, patch: Partial<Task>) => {
    persisted = { ...persisted, ...patch };
    return persisted;
  };
  const store = {
    getTask: vi.fn(async () => ({ ...persisted, attachments: [], comments: [] })),
    getSettings: vi.fn(async () => ({
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 10_000,
      groupOverlappingFiles: false,
      autoMerge: true,
    } as Settings)),
    getTaskWorkflowSelection: vi.fn(() => undefined),
    getTaskWorkflowSelectionAsync: vi.fn(async () => undefined),
    updateTask: vi.fn(update),
    updateTaskAtomic: vi.fn(async (_id: string, patcher: (live: Task) => Partial<Task> | null) => {
      const patch = patcher(persisted);
      if (patch) await update(_id, patch);
      return persisted;
    }),
    withPlanningLifecycleLock: vi.fn(async () => {
      throw new PlanningLifecycleLockTransportError("direct PostgreSQL session endpoint is unavailable");
    }),
    logEntry: vi.fn(async (_id: string, message: string) => { logs.push(message); }),
    appendAgentLog: vi.fn(async () => undefined),
    getAgentLogs: vi.fn(async () => []),
    listTasks: vi.fn(async () => []),
    findRecentTasksBySourceParentTaskId: vi.fn(async () => []),
    recordActivity: vi.fn(async () => undefined),
    parseDependenciesFromPrompt: vi.fn(async () => []),
    parseStepsFromPrompt: vi.fn(async () => []),
    parseFileScopeFromPrompt: vi.fn(async () => []),
    on: vi.fn(),
    emit: vi.fn(),
  } as unknown as TaskStore;
  return { store, task: () => persisted, logs };
}

describe("triage planning lifecycle lock transport failures (FN-8911)", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "fusion-triage-lock-transport-"));
    mockCreateFnAgent.mockResolvedValue({
      session: {
        prompt: vi.fn(),
        dispose: vi.fn(),
        sessionManager: { getLeafId: vi.fn(() => null), navigateTree: vi.fn() },
      },
    });
  });

  afterEach(async () => {
    mockCreateFnAgent.mockReset();
    mockPromptWithFallback.mockReset();
    await rm(root, { recursive: true, force: true });
  });

  it("persists transport failures across a fresh triage owner instead of laundering them into unchanged-PROMPT failures", async () => {
    const fixture = createPersistedStore(createTask());
    const promptPath = join(root, ".fusion", "tasks", "FN-8911", "PROMPT.md");
    await mkdir(join(root, ".fusion", "tasks", "FN-8911"), { recursive: true });

    mockPromptWithFallback.mockImplementationOnce(async () => {
      await writeFile(promptPath, "# Direct PostgreSQL plan\n", "utf8");
    });
    await new TriageProcessor(fixture.store, root).specifyTask(fixture.task());

    expect(fixture.task().error).toBeNull();
    expect(fixture.task().recoveryRetryCount).toBe(1);
    expect(fixture.task().customFields).toMatchObject({
      unrelated: "preserve-me",
      [TRANSPORT_MARKER]: {
        message: "direct PostgreSQL session endpoint is unavailable",
        attempt: 1,
        at: expect.any(String),
      },
    });
    expect(fixture.logs.join("\n")).toContain("Planning lifecycle lock transport failure");

    // A new processor models a retry claimed after an engine restart or ownership change.
    mockPromptWithFallback.mockResolvedValueOnce(undefined);
    await new TriageProcessor(fixture.store, root).specifyTask(fixture.task());

    const retryLog = fixture.logs.at(-1) ?? "";
    expect(retryLog).toContain("Planning lifecycle lock transport failure recorded at");
    expect(retryLog).not.toContain("did not update the authoritative PROMPT.md");
    expect(fixture.task().recoveryRetryCount).toBe(2);

    mockPromptWithFallback.mockResolvedValueOnce(undefined);
    await new TriageProcessor(fixture.store, root).specifyTask(fixture.task());
    mockPromptWithFallback.mockResolvedValueOnce(undefined);
    await new TriageProcessor(fixture.store, root).specifyTask(fixture.task());

    expect(fixture.task().status).toBe("failed");
    expect(fixture.task().error).toContain("Planning lifecycle lock transport failure recorded at");
    expect(fixture.task().error).not.toContain("did not update the authoritative PROMPT.md");
    expect(fixture.task().customFields?.[TRANSPORT_MARKER]).toBeUndefined();
  });

  it("keeps the ordinary unchanged-PROMPT verdict when no persisted transport marker exists", async () => {
    const fixture = createPersistedStore(createTask({ customFields: { unrelated: "preserve-me" } }));
    const promptPath = join(root, ".fusion", "tasks", "FN-8911", "PROMPT.md");
    await mkdir(join(root, ".fusion", "tasks", "FN-8911"), { recursive: true });
    await writeFile(promptPath, "# Existing plan\n", "utf8");

    mockPromptWithFallback.mockResolvedValue(undefined);
    await new TriageProcessor(fixture.store, root).specifyTask(fixture.task());

    expect(fixture.logs.join("\n")).toContain("Planner did not update the authoritative PROMPT.md");
    expect(fixture.logs.join("\n")).not.toContain("Planning lifecycle lock transport failure recorded at");
  });
});
