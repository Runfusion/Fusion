// @vitest-environment node

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore, type WorkflowIr, type WorkflowIrV1, type WorkflowIrV2 } from "../index.js";
import { resolveColumnFlags } from "../trait-registry.js";
import { downgradeIrToV1IfPure, parseWorkflowIr } from "../workflow-ir.js";
import { resolveWorkflowIrForTask } from "../workflow-ir-resolver.js";
import { stepsToWorkflowIr } from "../workflow-steps-to-ir.js";

const pureV1CustomWorkflow = (): WorkflowIrV1 => ({
  version: "v1",
  name: "pure-v1-custom",
  nodes: [
    { id: "start", kind: "start" },
    { id: "execute", kind: "prompt", config: { seam: "execute", prompt: "Do the work" } },
    { id: "end", kind: "end" },
  ],
  edges: [
    { from: "start", to: "execute", condition: "success" },
    { from: "execute", to: "end", condition: "success" },
    { from: "execute", to: "end", condition: "failure" },
  ],
});

const authoredV2CapacityWorkflow = (): WorkflowIrV2 => ({
  version: "v2",
  name: "authored-v2-capacity-workflow",
  columns: [
    { id: "todo", name: "todo", traits: [{ trait: "hold", config: { release: "capacity" } }, { trait: "reset-on-entry" }] },
    { id: "in-progress", name: "in-progress", traits: [{ trait: "wip", config: { limit: "settings.maxConcurrent" } }, { trait: "abort-on-exit" }, { trait: "timing" }] },
    { id: "done", name: "done", traits: [{ trait: "complete" }] },
  ],
  nodes: [
    { id: "start", kind: "start", column: "todo" },
    { id: "execute", kind: "prompt", column: "in-progress", config: { seam: "execute", prompt: "Do the work" } },
    { id: "end", kind: "end", column: "done" },
  ],
  edges: [
    { from: "start", to: "execute", condition: "success" },
    { from: "execute", to: "end", condition: "success" },
    { from: "execute", to: "end", condition: "failure" },
  ],
});

function todoColumn(ir: WorkflowIr) {
  if (ir.version !== "v2") throw new Error("expected upgraded v2 IR");
  const column = ir.columns.find((candidate) => candidate.id === "todo");
  if (!column) throw new Error("expected todo column");
  return column;
}

function inProgressColumn(ir: WorkflowIr) {
  if (ir.version !== "v2") throw new Error("expected v2 IR");
  const column = ir.columns.find((candidate) => candidate.id === "in-progress");
  if (!column) throw new Error("expected in-progress column");
  return column;
}

function setSelection(store: TaskStore, taskId: string, workflowId: string): void {
  const db = (store as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => unknown } } }).db;
  db.prepare(
    `INSERT INTO task_workflow_selection (taskId, workflowId, stepIds, updatedAt)
     VALUES (?, ?, '[]', ?)
     ON CONFLICT(taskId) DO UPDATE SET workflowId = excluded.workflowId, updatedAt = excluded.updatedAt`,
  ).run(taskId, workflowId, new Date().toISOString());
}

function rawStoredWorkflowIr(store: TaskStore, workflowId: string): unknown {
  const db = (store as unknown as { db: { prepare: (s: string) => { get: (...a: unknown[]) => { ir: string } | undefined } } }).db;
  const row = db.prepare("SELECT ir FROM workflows WHERE id = ?").get(workflowId);
  if (!row) throw new Error(`missing workflow row ${workflowId}`);
  return JSON.parse(row.ir);
}

/*
 * FNXC:Workflows 2026-06-28-08:45:
 * Pure-v1 custom workflows intentionally upgrade through synthesizeDefaultColumns(), whose columns are placement-only and trait-less for FN-5769/#1405 rollback compatibility. Capacity-dispatched custom workflows must author v2 columns with todo hold(capacity); the engine test suite asserts that documented remedy performs the actual sweep release.
 */
describe("custom v1 workflow dispatch characterization", () => {
  let rootDir = "";
  let store: TaskStore;

  beforeEach(async () => {
    rootDir = mkdtempSync(join(tmpdir(), "fn7192-custom-v1-workflow-"));
    store = new TaskStore(rootDir, undefined, { inMemoryDb: false });
    await store.init();
    await store.updateGlobalSettings({ experimentalFeatures: { workflowColumns: true } });
  });

  afterEach(() => {
    try { store?.close(); } catch { /* ignore */ }
    if (rootDir) rmSync(rootDir, { recursive: true, force: true });
  });

  it("documents that pure-v1 custom workflows resolve to a trait-less todo column", async () => {
    const definition = await store.createWorkflowDefinition({
      name: "pure v1 custom",
      ir: pureV1CustomWorkflow(),
    });
    const task = await store.createTask({ description: "uses pure v1 custom workflow" });
    setSelection(store, task.id, definition.id);

    const resolved = await resolveWorkflowIrForTask(store, task.id);
    const todo = todoColumn(resolved);

    expect(todo.traits).toEqual([]);
    expect(resolveColumnFlags(todo).hold).not.toBe(true);
  });

  it("proves the documented v2 remedy authors hold(capacity) on todo and wip capacity downstream", () => {
    const resolved = parseWorkflowIr(authoredV2CapacityWorkflow());

    const todo = todoColumn(resolved);
    expect(todo.traits).toEqual(
      expect.arrayContaining([{ trait: "hold", config: { release: "capacity" } }]),
    );
    expect(resolveColumnFlags(todo).hold).toBe(true);

    const inProgress = inProgressColumn(resolved);
    expect(resolveColumnFlags(inProgress).countsTowardWip).toBe(true);
  });

  it("keeps pure-v1 round-trip compatibility for v1 inputs and step-derived pure-v1 graphs", async () => {
    await store.updateGlobalSettings({ experimentalFeatures: { workflowColumns: false } });

    const fromRawV1 = await store.createWorkflowDefinition({
      name: "persisted raw v1",
      ir: pureV1CustomWorkflow(),
    });
    const storedRawV1 = rawStoredWorkflowIr(store, fromRawV1.id) as { version?: string };
    expect(storedRawV1.version).toBe("v1");

    const fromSteps = stepsToWorkflowIr([
      {
        name: "Plan",
        mode: "prompt",
        prompt: "Plan the work",
        gateMode: "advisory",
      },
    ], "step-derived pure v1");
    expect(fromSteps.version).toBe("v2");
    expect(downgradeIrToV1IfPure(fromSteps).version).toBe("v1");

    const stepDerivedDefinition = await store.createWorkflowDefinition({
      name: "persisted step-derived v1",
      ir: fromSteps,
    });
    const storedFromSteps = rawStoredWorkflowIr(store, stepDerivedDefinition.id) as { version?: string };
    expect(storedFromSteps.version).toBe("v1");
  });
});
