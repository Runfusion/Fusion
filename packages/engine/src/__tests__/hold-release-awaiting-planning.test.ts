import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBootstrapPrompt, PLAN_REVIEW_GROUP_ID, type Task, type TaskStore, type WorkflowIr } from "@fusion/core";

import {
  promoteHeldTask,
  resetHoldReleaseInstrumentation,
  runHoldReleaseSweep,
} from "../execution/hold-release.js";
import { getPromptPath } from "../execution/spec-staleness.js";

const WORKFLOW_ID = "custom:fn-242";
const roots: string[] = [];

function workflow(withPlanReview = false): WorkflowIr {
  return {
    version: "v2",
    id: WORKFLOW_ID,
    name: "FN-242 readiness",
    columns: [
      { id: "todo", name: "Planning", traits: [{ trait: "hold", config: { release: "capacity" } }] },
      { id: "in-progress", name: "In progress", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
      { id: "done", name: "Done", traits: [{ trait: "complete" }] },
    ],
    nodes: [
      { id: "start", kind: "start", column: "todo" },
      ...(withPlanReview
        ? [{
            id: PLAN_REVIEW_GROUP_ID,
            name: "Plan Review",
            kind: "optional-group" as const,
            column: "todo",
            config: { defaultOn: true, template: { nodes: [], edges: [] } },
          }]
        : []),
      { id: "execute", kind: "prompt", column: "in-progress", config: { prompt: "execute" } },
      { id: "end", kind: "end", column: "done" },
    ],
    edges: [],
  } as WorkflowIr;
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-2420",
    title: "Event-driven dispatch",
    description: "Plan this card",
    column: "todo",
    status: null,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-08-28T20:15:47.076Z",
    updatedAt: "2026-08-28T20:15:47.076Z",
    columnMovedAt: "2026-08-28T20:15:47.076Z",
    ...overrides,
  } as Task;
}

async function makeStore(
  initial: Task,
  options: { ir?: WorkflowIr; prompt?: string; workItems?: Array<Record<string, unknown>> } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "fusion-fn-242-"));
  roots.push(root);
  const tasksDir = join(root, "tasks");
  const promptPath = getPromptPath(tasksDir, initial.id);
  await mkdir(join(tasksDir, initial.id), { recursive: true });
  await writeFile(
    promptPath,
    options.prompt ?? "# Planned\n\n## Mission\nImplement the approved work.\n",
    "utf8",
  );

  const current = initial;
  const ir = options.ir ?? workflow();
  const checkAndRecordUnplannedExecutionBlock = vi.fn(async () => {
    current.log.push({
      timestamp: new Date().toISOString(),
      message: "Execution dispatch refused — task is still unplanned",
    } as Task["log"][number]);
    return true;
  });
  const moveTaskIf = vi.fn(async (
    _id: string,
    target: string,
    predicate: (live: Task) => boolean,
  ) => {
    if (!predicate(current)) return { task: current, moved: false };
    current.column = target;
    return { task: current, moved: true };
  });
  const updateTask = vi.fn(async (_id: string, patch: Partial<Task>) => {
    Object.assign(current, patch);
    return current;
  });
  const recordRunAuditEvent = vi.fn(async () => undefined);
  const selection = { workflowId: WORKFLOW_ID, stepIds: [] };
  const store = {
    getSettings: vi.fn(async () => ({ maxConcurrent: 4, autoMerge: true })),
    listTasks: vi.fn(async () => [current]),
    getTask: vi.fn(async () => current),
    getTasksDir: () => tasksDir,
    getTaskWorkflowSelection: vi.fn(() => selection),
    getTaskWorkflowSelectionAsync: vi.fn(async () => selection),
    getTaskWorkflowSelectionsAsync: vi.fn(async () => new Map([[current.id, selection]])),
    getWorkflowDefinition: vi.fn(async () => ({ ir })),
    listWorkflowWorkItemsForTask: vi.fn(async () => options.workItems ?? []),
    getCompletionHandoffAcceptedMarker: vi.fn(async () => null),
    checkAndRecordUnplannedExecutionBlock,
    moveTaskIf,
    updateTask,
    recordRunAuditEvent,
  } as unknown as TaskStore;

  return { store, current, moveTaskIf, updateTask, recordRunAuditEvent, checkAndRecordUnplannedExecutionBlock };
}

beforeEach(() => {
  resetHoldReleaseInstrumentation();
  vi.restoreAllMocks();
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("automatic capacity-hold candidacy", () => {
  it("keeps a just-created seed card quiet until planning is complete", async () => {
    const original = task();
    const seed = buildBootstrapPrompt(original.id, original.title, original.description);
    const fixture = await makeStore(original, { prompt: seed });
    const reserveSlot = vi.fn();

    const result = await runHoldReleaseSweep(fixture.store, { now: () => Date.parse("2026-08-28T20:16:00.000Z"), reserveSlot });

    expect(result).toMatchObject({ released: [], held: [{ taskId: original.id, reason: "awaiting-planning:seed-prompt" }] });
    expect(fixture.checkAndRecordUnplannedExecutionBlock).not.toHaveBeenCalled();
    expect(original.log.some((entry) => entry.message.includes("Execution dispatch refused"))).toBe(false);
    expect(reserveSlot).not.toHaveBeenCalled();
  });

  it("releases a Fast bootstrap card through both explicit promotion and the capacity sweep", async () => {
    const promotedTask = task({ id: "FN-242-fast-promote", executionMode: "fast" });
    const promoted = await makeStore(promotedTask, {
      ir: workflow(true),
      prompt: buildBootstrapPrompt(promotedTask.id, promotedTask.title, promotedTask.description),
    });

    await expect(promoteHeldTask(promoted.store, promotedTask.id)).resolves.toMatchObject({ released: true });
    expect(promotedTask.column).toBe("in-progress");
    expect(promoted.checkAndRecordUnplannedExecutionBlock).not.toHaveBeenCalled();

    const sweptTask = task({ id: "FN-242-fast-sweep", executionMode: "fast" });
    const swept = await makeStore(sweptTask, {
      ir: workflow(true),
      prompt: buildBootstrapPrompt(sweptTask.id, sweptTask.title, sweptTask.description),
    });
    await expect(runHoldReleaseSweep(swept.store, { now: () => Date.now() })).resolves.toMatchObject({ released: [sweptTask.id] });
    expect(sweptTask.column).toBe("in-progress");
    expect(swept.checkAndRecordUnplannedExecutionBlock).not.toHaveBeenCalled();
  });

  it("keeps explicit promote refusals durable for every unplanned seed", async () => {
    const firstTask = task({ id: "FN-2421" });
    const first = await makeStore(firstTask, {
      prompt: buildBootstrapPrompt(firstTask.id, firstTask.title, firstTask.description),
    });

    await expect(promoteHeldTask(first.store, firstTask.id)).resolves.toMatchObject({
      released: false,
      rejection: "unplanned-for-execution",
    });
    expect(first.checkAndRecordUnplannedExecutionBlock).toHaveBeenCalledTimes(1);
    expect(firstTask.log.filter((entry) => entry.message.includes("Execution dispatch refused"))).toHaveLength(1);
    expect(first.moveTaskIf).not.toHaveBeenCalled();

    const secondTask = task({ id: "FN-2422" });
    const second = await makeStore(secondTask, {
      prompt: buildBootstrapPrompt(secondTask.id, secondTask.title, secondTask.description),
    });
    await expect(promoteHeldTask(second.store, secondTask.id)).resolves.toMatchObject({
      released: false,
      rejection: "unplanned-for-execution",
    });
    expect(second.checkAndRecordUnplannedExecutionBlock).toHaveBeenCalledTimes(1);
    expect(second.moveTaskIf).not.toHaveBeenCalled();
  });

  it("does not write plan-review waiver bookkeeping for a terminal refusal", async () => {
    const original = task({ id: "FN-2423", status: "needs-replan" });
    const fixture = await makeStore(original, { ir: workflow(true) });

    await expect(promoteHeldTask(fixture.store, original.id)).resolves.toMatchObject({
      released: false,
      rejection: "unplanned-for-execution",
    });
    expect(original.status).toBe("needs-replan");
    expect(original.workflowStepResults).toBeUndefined();
    expect(fixture.updateTask).not.toHaveBeenCalled();
    expect(fixture.recordRunAuditEvent).not.toHaveBeenCalled();
    expect(fixture.moveTaskIf).not.toHaveBeenCalled();
  });

  it("keeps a fully planned approval-held card refused", async () => {
    const original = task({ id: "FN-2424", status: "awaiting-approval" });
    const fixture = await makeStore(original);

    await expect(promoteHeldTask(fixture.store, original.id)).resolves.toMatchObject({
      released: false,
      rejection: "capacity-exhausted-or-no-slot",
    });
    expect(fixture.moveTaskIf).not.toHaveBeenCalled();
    expect(fixture.updateTask).not.toHaveBeenCalled();
    expect(fixture.recordRunAuditEvent).not.toHaveBeenCalled();
    expect(fixture.checkAndRecordUnplannedExecutionBlock).not.toHaveBeenCalled();
  });

  it("does not reserve capacity for an unplanned card", async () => {
    const original = task({ id: "FN-2425", status: "needs-replan" });
    const fixture = await makeStore(original);
    const reserveSlot = vi.fn(async () => null);

    await expect(promoteHeldTask(fixture.store, original.id, { reserveSlot })).resolves.toMatchObject({
      released: false,
      rejection: "unplanned-for-execution",
    });
    expect(reserveSlot).not.toHaveBeenCalled();
    expect(fixture.moveTaskIf).not.toHaveBeenCalled();
  });

  it("distinguishes pending Plan Review from an active capacity continuation", async () => {
    const pendingTask = task({ id: "FN-2426" });
    const pending = await makeStore(pendingTask, { ir: workflow(true) });
    await expect(runHoldReleaseSweep(pending.store, { now: () => Date.now() })).resolves.toMatchObject({
      released: [],
      held: [{ taskId: pendingTask.id, reason: "awaiting-planning:plan-review-pending" }],
    });
    expect(pending.checkAndRecordUnplannedExecutionBlock).not.toHaveBeenCalled();

    const readyTask = task({ id: "FN-2427" });
    const ready = await makeStore(readyTask, {
      ir: workflow(true),
      workItems: [{ state: "held", waitReason: "capacity", sourceColumn: "todo" }],
    });
    await expect(runHoldReleaseSweep(ready.store, { now: () => Date.now() })).resolves.toMatchObject({ released: [readyTask.id] });
  });

  it.each([
    ["planning", "awaiting-planning:planning-status"],
    ["needs-replan", "awaiting-planning:needs-replan"],
  ])("reports %s as its specific planning wait", async (status, reason) => {
    const original = task({ id: `FN-${status}`, status });
    const fixture = await makeStore(original);
    const result = await runHoldReleaseSweep(fixture.store, { now: () => Date.now() });
    expect(result.held).toEqual([{ taskId: original.id, reason }]);
    expect(fixture.checkAndRecordUnplannedExecutionBlock).not.toHaveBeenCalled();
  });

  it("reports an explicit duplicate redirect as a planning wait", async () => {
    const original = task({ id: "FN-2428", title: "DUPLICATE: FN-12" });
    const fixture = await makeStore(original);
    const result = await runHoldReleaseSweep(fixture.store, { now: () => Date.now() });
    expect(result.held).toEqual([{ taskId: original.id, reason: "awaiting-planning:duplicate-prompt" }]);
    expect(fixture.checkAndRecordUnplannedExecutionBlock).not.toHaveBeenCalled();
  });

  it("reports an approval-held planned card without moving it", async () => {
    const original = task({ id: "FN-2429", status: "awaiting-approval" });
    const fixture = await makeStore(original);
    const result = await runHoldReleaseSweep(fixture.store, { now: () => Date.now() });
    expect(result).toMatchObject({ released: [], held: [{ taskId: original.id, reason: "awaiting-approval" }] });
    expect(fixture.moveTaskIf).not.toHaveBeenCalled();
    expect(fixture.checkAndRecordUnplannedExecutionBlock).not.toHaveBeenCalled();
  });

  it("still releases a planned card when capacity is free", async () => {
    const original = task({ id: "FN-2430" });
    const fixture = await makeStore(original);
    await expect(runHoldReleaseSweep(fixture.store, { now: () => Date.now() })).resolves.toMatchObject({ released: [original.id], held: [] });
    expect(fixture.moveTaskIf).toHaveBeenCalledTimes(1);
  });
});
