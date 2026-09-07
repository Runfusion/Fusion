import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CustomFieldRejectionError,
  UnavailablePlanLockError,
  createCurrentPlanEvidence,
  validateCustomFieldPatch,
  type Settings,
  type Task,
  type TaskStore,
  type WorkflowFieldDefinition,
} from "@fusion/core";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const { mockCreateFnAgent, mockPromptWithFallback } = vi.hoisted(() => ({
  mockCreateFnAgent: vi.fn(),
  mockPromptWithFallback: vi.fn(),
}));

vi.mock("../pi.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../pi.js")>(),
  createFnAgent: mockCreateFnAgent,
  promptWithFallback: mockPromptWithFallback,
}));

import { TriageProcessor } from "../triage.js";

function sourceHashFor(prompt: string): string {
  return createCurrentPlanEvidence({
    version: 1,
    sourceRevision: 1,
    capturedAt: "2026-09-07T00:00:00.000Z",
    prompt,
  }).sourceHash;
}

function createFixture(defs: WorkflowFieldDefinition[] | undefined, root: string) {
  let task: Task = {
    id: "FN-9273",
    description: "Plan a safe deployment",
    column: "triage",
    status: null,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-09-07T00:00:00.000Z",
    updatedAt: "2026-09-07T00:00:00.000Z",
    customFields: { note: "operator-owned" },
  };
  const patches: Partial<Task>[] = [];
  let unavailableSourceHash = "";
  const update = async (_id: string, patch: Partial<Task>) => {
    if (patch.customFields !== undefined) {
      const validation = validateCustomFieldPatch(defs, patch.customFields);
      if (!validation.ok) throw new CustomFieldRejectionError(validation.rejection);
    }
    patches.push(patch);
    task = { ...task, ...patch };
    return task;
  };
  const promptPath = join(root, ".fusion", "tasks", task.id, "PROMPT.md");
  const store = {
    getTask: vi.fn(async () => ({ ...task, attachments: [], comments: [] })),
    isBackendMode: vi.fn(() => true),
    getSettings: vi.fn(async () => ({ maxConcurrent: 2, maxWorktrees: 4, pollIntervalMs: 10_000, groupOverlappingFiles: false, autoMerge: true } as Settings)),
    getTaskWorkflowSelection: vi.fn(() => undefined),
    getTaskWorkflowSelectionAsync: vi.fn(async () => undefined),
    updateTask: vi.fn(update), updateTaskUnlocked: vi.fn(update),
    updateTaskAtomic: vi.fn(async (_id: string, patcher: (live: Task) => Partial<Task> | null) => {
      const patch = patcher(task);
      if (patch) await update(_id, patch);
      return task;
    }),
    withPlanningLifecycleLock: vi.fn(async (_id: string, operation: () => Promise<unknown>) => operation()),
    withTaskLock: vi.fn(async (_id: string, operation: () => Promise<unknown>) => operation()),
    readTaskForMove: vi.fn(async () => task),
    lockCurrentPlanWhilePlanningLocked: vi.fn(async () => {
      const prompt = await readFile(promptPath, "utf8");
      unavailableSourceHash = sourceHashFor(prompt);
      throw new UnavailablePlanLockError("section-duplicate", ["mission"], unavailableSourceHash);
    }),
    reconcileSpecDriftWhilePlanningLocked: vi.fn(async () => undefined),
    captureCurrentPlanEvidenceWhilePlanningLocked: vi.fn(async () => undefined),
    logEntry: vi.fn(async () => undefined), appendAgentLog: vi.fn(async () => undefined), getAgentLogs: vi.fn(async () => []),
    listTasks: vi.fn(async () => []), findRecentTasksBySourceParentTaskId: vi.fn(async () => []), recordActivity: vi.fn(async () => undefined),
    parseDependenciesFromPrompt: vi.fn(async () => []), parseStepsFromPrompt: vi.fn(async () => []), parseFileScopeFromPrompt: vi.fn(async () => []), on: vi.fn(), emit: vi.fn(),
  } as unknown as TaskStore;
  return { store, task: () => task, patches, promptPath, unavailableSourceHash: () => unavailableSourceHash };
}

describe("triage planning failure state (FN-9273)", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "fusion-triage-planning-failure-"));
    mockCreateFnAgent.mockResolvedValue({ session: { prompt: vi.fn(), dispose: vi.fn(), sessionManager: { getLeafId: vi.fn(() => null), navigateTree: vi.fn() } } });
  });

  afterEach(async () => {
    mockCreateFnAgent.mockReset();
    mockPromptWithFallback.mockReset();
    await rm(root, { recursive: true, force: true });
  });

  it.each<[string, WorkflowFieldDefinition[] | undefined]>([
    ["no declared workflow fields", undefined],
    ["declared workflow fields", [{ id: "note", name: "Note", type: "string" }]],
  ])("persists an unavailable spec-lock retry without custom-field validation when %s", async (_label, defs) => {
    const fixture = createFixture(defs, root);
    await mkdir(join(root, ".fusion", "tasks", "FN-9273"), { recursive: true });
    const prompt = "## Mission\n\nPlanner-authored plan\n";
    mockPromptWithFallback.mockImplementation(async () => { await writeFile(fixture.promptPath, prompt, "utf8"); });

    await expect(new TriageProcessor(fixture.store, root).specifyTask(fixture.task())).resolves.toBeUndefined();

    expect(fixture.task()).toMatchObject({ status: "needs-replan", error: null, recoveryRetryCount: 1, customFields: { note: "operator-owned" } });
    expect(fixture.task().planningFailure?.specLockUnavailable).toMatchObject({
      sourceHash: fixture.unavailableSourceHash(), reason: "section-duplicate", sections: ["mission"], attempt: 1,
    });
    expect(fixture.patches.every((patch) => patch.customFields === undefined)).toBe(true);
  });

  it("parks with the original spec-lock failure when the terminal recovery write throws", async () => {
    const fixture = createFixture(undefined, root);
    await mkdir(join(root, ".fusion", "tasks", "FN-9273"), { recursive: true });
    mockPromptWithFallback.mockImplementation(async () => {
      await writeFile(fixture.promptPath, "## Mission\n\nPlanner-authored plan\n", "utf8");
    });
    const processor = new TriageProcessor(fixture.store, root);

    await processor.specifyTask(fixture.task());
    const atomic = fixture.store.updateTaskAtomic as ReturnType<typeof vi.fn>;
    const originalAtomic = atomic.getMockImplementation()!;
    let failTerminalWrite = true;
    atomic.mockImplementation(async (id: string, patcher: (live: Task) => Partial<Task> | null) => {
      const proposed = patcher(fixture.task());
      if (failTerminalWrite && proposed?.status === "failed" && proposed.planningFailure === null) {
        failTerminalWrite = false;
        throw new Error("durable store unavailable");
      }
      return await originalAtomic(id, patcher);
    });

    await expect(processor.specifyTask(fixture.task())).resolves.toBeUndefined();
    expect(fixture.task()).toMatchObject({
      status: "failed",
      error: "PLANNING_FAILED_SPEC_LOCK_UNAVAILABLE: section-duplicate (mission)",
      recoveryRetryCount: null,
      nextRecoveryAt: null,
    });
  });
});
