import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBootstrapPrompt, type Task, type TaskStore, type WorkflowIr } from "@fusion/core";

import { promoteHeldTask } from "../execution/hold-release.js";
import { getPromptPath } from "../execution/spec-staleness.js";
import { TriageProcessor } from "../triage.js";

const roots: string[] = [];

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-252-admission",
    title: "Fast admission",
    description: "Make a quick change",
    column: "triage",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-08-29T00:00:00.000Z",
    updatedAt: "2026-08-29T00:00:00.000Z",
    ...overrides,
  } as Task;
}

async function makeProcessor(tasks: Task[]) {
  const root = await mkdtemp(join(tmpdir(), "fusion-fn-252-admission-"));
  roots.push(root);
  for (const entry of tasks) {
    const dir = join(root, ".fusion", "tasks", entry.id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "PROMPT.md"), buildBootstrapPrompt(entry.id, entry.title, entry.description));
  }

  const logEntry = vi.fn(async () => undefined);
  const store = {
    on: vi.fn(),
    off: vi.fn(),
    getSettings: vi.fn(async () => ({ maxConcurrent: 4, maxWorktrees: 4, pollIntervalMs: 60_000, autoMerge: true })),
    getTaskWorkflowSelection: vi.fn(() => ({ workflowId: "builtin:coding", stepIds: [] })),
    getTaskWorkflowSelectionAsync: vi.fn(async () => ({ workflowId: "builtin:coding", stepIds: [] })),
    listWorkflowWorkItemsForTask: vi.fn(async () => []),
    logEntry,
  } as unknown as TaskStore;
  return { processor: new TriageProcessor(store, root), logEntry };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const HELD_FAST_ADMISSION_WORKFLOW_ID = "custom:fn-252-held-fast-admission";

function heldFastAdmissionWorkflow(): WorkflowIr {
  return {
    version: "v2",
    id: HELD_FAST_ADMISSION_WORKFLOW_ID,
    name: "Fast admission regression",
    columns: [
      { id: "todo", name: "Planning", traits: [{ trait: "hold", config: { release: "capacity" } }] },
      { id: "in-progress", name: "In Progress", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
      { id: "done", name: "Done", traits: [{ trait: "complete" }] },
    ],
    nodes: [
      { id: "start", kind: "start", column: "todo" },
      { id: "execute", kind: "prompt", column: "in-progress", config: { prompt: "execute" } },
      { id: "end", kind: "end", column: "done" },
    ],
    edges: [],
  } as WorkflowIr;
}

async function makeHeldFastAdmissionStore(initial: Task) {
  const root = await mkdtemp(join(tmpdir(), "fusion-fn-252-held-fast-"));
  roots.push(root);
  const tasksDir = join(root, "tasks");
  await mkdir(join(tasksDir, initial.id), { recursive: true });
  await writeFile(
    getPromptPath(tasksDir, initial.id),
    buildBootstrapPrompt(initial.id, initial.title, initial.description),
    "utf8",
  );

  const current = initial;
  const selection = { workflowId: HELD_FAST_ADMISSION_WORKFLOW_ID, stepIds: [] };
  const checkAndRecordUnplannedExecutionBlock = vi.fn(async () => true);
  const moveTaskIf = vi.fn(async (
    _id: string,
    target: string,
    predicate: (live: Task) => boolean | Promise<boolean>,
  ) => {
    if (!await predicate(current)) return { task: current, moved: false };
    current.column = target as Task["column"];
    return { task: current, moved: true };
  });
  const updateTask = vi.fn(async (_id: string, patch: Partial<Task>) => {
    Object.assign(current, patch);
    return current;
  });
  const store = {
    getSettings: vi.fn(async () => ({ maxConcurrent: 4, autoMerge: true })),
    getTask: vi.fn(async () => current),
    getTasksDir: () => tasksDir,
    getTaskWorkflowSelection: vi.fn(() => selection),
    getTaskWorkflowSelectionAsync: vi.fn(async () => selection),
    getWorkflowDefinition: vi.fn(async () => ({ ir: heldFastAdmissionWorkflow() })),
    listWorkflowWorkItemsForTask: vi.fn(async () => []),
    getCompletionHandoffAcceptedMarker: vi.fn(async () => null),
    checkAndRecordUnplannedExecutionBlock,
    moveTaskIf,
    updateTask,
    recordRunAuditEvent: vi.fn(async () => undefined),
  } as unknown as TaskStore;

  return { store, current, moveTaskIf, updateTask, checkAndRecordUnplannedExecutionBlock };
}

describe("FN-252 fast-lane planning admission", () => {
  it("releases a stale planning claim after the Fast toggle persists only executionMode", async () => {
    const planningTask = task({
      id: "FN-252-fast-after-planning",
      column: "todo",
      status: "planning",
      executionMode: "standard",
    });
    const fixture = await makeHeldFastAdmissionStore(planningTask);

    await expect(promoteHeldTask(fixture.store, planningTask.id)).resolves.toMatchObject({
      released: false,
      rejection: "unplanned-for-execution",
    });

    // Task Detail deliberately patches only the mode when entering Fast; it does not rebuild a plan.
    await fixture.store.updateTask(planningTask.id, { executionMode: "fast" });
    expect(fixture.current.status).toBe("planning");

    await expect(promoteHeldTask(fixture.store, planningTask.id)).resolves.toMatchObject({
      released: true,
      toColumn: "in-progress",
    });
    expect(fixture.current.column).toBe("in-progress");
    expect(fixture.moveTaskIf).toHaveBeenCalledTimes(1);
    expect(fixture.checkAndRecordUnplannedExecutionBlock).toHaveBeenCalledTimes(1);
  });

  it("keeps Fast intake and hold cards out of planning discovery while standard seed cards remain candidates", async () => {
    const fastIntake = task({ id: "FN-252-fast-intake", executionMode: "fast", column: "triage" });
    const standardIntake = task({ id: "FN-252-standard-intake", executionMode: "standard", column: "triage" });
    const fastHold = task({ id: "FN-252-fast-hold", executionMode: "fast", column: "todo" });
    const standardHold = task({ id: "FN-252-standard-hold", executionMode: "standard", column: "todo" });
    const { processor, logEntry } = await makeProcessor([fastIntake, standardIntake, fastHold, standardHold]);

    const discover = (processor as unknown as {
      discoverReadyPlanningTasks(tasks: Task[], now: number): Promise<Task[]>;
    }).discoverReadyPlanningTasks.bind(processor);
    const first = await discover([fastIntake, standardIntake, fastHold, standardHold], Date.now());
    expect(first.map((entry) => entry.id).sort()).toEqual([standardHold.id, standardIntake.id].sort());
    expect(logEntry.mock.calls.filter(([, message]) => message === "Fast mode intentionally skips specification planning")).toHaveLength(2);

    await discover([fastIntake, standardIntake, fastHold, standardHold], Date.now());
    expect(logEntry.mock.calls.filter(([, message]) => message === "Fast mode intentionally skips specification planning")).toHaveLength(2);

    await processor.specifyTask(fastIntake);
    await expect(processor.recoverApprovedTask(fastIntake)).resolves.toBe(false);
    expect(logEntry.mock.calls.filter(([, message]) => message === "Fast mode intentionally skips specification planning")).toHaveLength(2);
  });
});
