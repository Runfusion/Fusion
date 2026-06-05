import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { WorkflowIrError } from "../workflow-ir.js";
import { isBuiltinWorkflowId } from "../builtin-workflows.js";
import type { WorkflowIr } from "../workflow-ir-types.js";
import { createTaskStoreTestHarness } from "./store-test-helpers.js";

function makeIr(overrides: Partial<WorkflowIr> = {}): WorkflowIr {
  return {
    version: "v1",
    name: "test-workflow",
    nodes: [
      { id: "start", kind: "start" },
      { id: "lint", kind: "gate", config: { scriptName: "lint" } },
      { id: "end", kind: "end" },
    ],
    edges: [
      { from: "start", to: "lint" },
      { from: "lint", to: "end" },
    ],
    ...overrides,
  };
}

describe("TaskStore workflow definitions (U1)", () => {
  const harness = createTaskStoreTestHarness();
  let store: ReturnType<typeof harness.store>;

  beforeEach(async () => {
    await harness.beforeEach();
    store = harness.store();
  });

  afterEach(async () => {
    await harness.afterEach();
  });

  it("creates and round-trips a workflow with IR and layout intact", async () => {
    const created = await store.createWorkflowDefinition({
      name: "Quality Gate",
      description: "Runs lint before merge",
      ir: makeIr(),
      layout: { start: { x: 0, y: 0 }, lint: { x: 120, y: 0 }, end: { x: 240, y: 0 } },
    });

    expect(created.id).toBe("WF-001");
    // The list prepends read-only built-ins; assert on the user workflows only.
    const userList = (await store.listWorkflowDefinitions()).filter((w) => !isBuiltinWorkflowId(w.id));
    expect(userList).toHaveLength(1);
    expect(userList[0].name).toBe("Quality Gate");
    expect(userList[0].ir.nodes).toHaveLength(3);
    expect(userList[0].layout.lint).toEqual({ x: 120, y: 0 });
  });

  it("rejects a workflow whose IR is missing start/end", async () => {
    const bad = makeIr({ nodes: [{ id: "only", kind: "prompt" }], edges: [] });
    await expect(
      store.createWorkflowDefinition({ name: "Broken", ir: bad }),
    ).rejects.toBeInstanceOf(WorkflowIrError);
    expect((await store.listWorkflowDefinitions()).filter((w) => !isBuiltinWorkflowId(w.id))).toHaveLength(0);
  });

  it("requires a non-empty name", async () => {
    await expect(
      store.createWorkflowDefinition({ name: "   ", ir: makeIr() }),
    ).rejects.toThrow(/name is required/i);
  });

  describe("rollback compat — v1/v2 persistence (#1405)", () => {
    function rawIr(id: string): { version: string } {
      const row = (store as any).db
        .prepare("SELECT ir FROM workflows WHERE id = ?")
        .get(id) as { ir: string };
      return JSON.parse(row.ir);
    }

    // A pure-v1 graph: only v1 node kinds, default columns at default placement.
    const pureV1 = (): WorkflowIr => makeIr();

    // A v2 graph using a custom column (a genuine v2 feature).
    const v2Custom = (): WorkflowIr =>
      ({
        version: "v2",
        name: "v2-feature",
        columns: [
          { id: "triage", name: "triage", traits: [] },
          { id: "todo", name: "todo", traits: [] },
          { id: "in-progress", name: "in-progress", traits: [] },
          { id: "in-review", name: "in-review", traits: [] },
          { id: "done", name: "done", traits: [] },
          { id: "archived", name: "archived", traits: [] },
          { id: "review-queue", name: "Review Queue", traits: [] },
        ],
        nodes: [
          { id: "start", kind: "start", column: "todo" },
          { id: "end", kind: "end", column: "todo" },
        ],
        edges: [{ from: "start", to: "end" }],
      }) as unknown as WorkflowIr;

    it("flag OFF: a pure-v1 workflow persists in the v1 shape on create and update", async () => {
      const created = await store.createWorkflowDefinition({ name: "Pure", ir: pureV1() });
      expect(rawIr(created.id).version).toBe("v1");
      await store.updateWorkflowDefinition(created.id, { description: "edit", ir: pureV1() });
      expect(rawIr(created.id).version).toBe("v1");
      // Read-path still resolves it as the upgraded v2 in-memory shape.
      const reloaded = await store.getWorkflowDefinition(created.id);
      expect(reloaded?.ir.version).toBe("v2");
    });

    it("flag OFF: a v2-feature workflow persists as v2 regardless", async () => {
      const created = await store.createWorkflowDefinition({ name: "Feat", ir: v2Custom() });
      expect(rawIr(created.id).version).toBe("v2");
    });

    it("flag ON: a pure-v1 workflow persists as v2", async () => {
      await store.updateGlobalSettings({ experimentalFeatures: { workflowColumns: true } });
      const created = await store.createWorkflowDefinition({ name: "OnFlag", ir: pureV1() });
      expect(rawIr(created.id).version).toBe("v2");
    });
  });

  it("updates name, description, IR, and layout and advances updatedAt", async () => {
    const created = await store.createWorkflowDefinition({ name: "V1", ir: makeIr() });
    await new Promise((r) => setTimeout(r, 2));
    const updated = await store.updateWorkflowDefinition(created.id, {
      name: "V2",
      description: "now with a prompt step",
      ir: makeIr({
        nodes: [
          { id: "start", kind: "start" },
          { id: "review", kind: "prompt", config: { prompt: "Review the change" } },
          { id: "end", kind: "end" },
        ],
        edges: [
          { from: "start", to: "review" },
          { from: "review", to: "end" },
        ],
      }),
      layout: { start: { x: 5, y: 5 } },
    });

    expect(updated.name).toBe("V2");
    expect(updated.description).toBe("now with a prompt step");
    expect(updated.ir.nodes.some((n) => n.id === "review")).toBe(true);
    expect(updated.layout.start).toEqual({ x: 5, y: 5 });
    expect(new Date(updated.updatedAt).getTime()).toBeGreaterThan(
      new Date(created.updatedAt).getTime(),
    );
  });

  it("update rejects an invalid IR without mutating the stored row", async () => {
    const created = await store.createWorkflowDefinition({ name: "Keep", ir: makeIr() });
    await expect(
      store.updateWorkflowDefinition(created.id, {
        ir: { version: "v1", name: "x", nodes: [], edges: [] } as WorkflowIr,
      }),
    ).rejects.toBeInstanceOf(WorkflowIrError);
    const reread = await store.getWorkflowDefinition(created.id);
    expect(reread?.ir.nodes).toHaveLength(3);
  });

  it("deletes a workflow and reflects absence", async () => {
    const created = await store.createWorkflowDefinition({ name: "Temp", ir: makeIr() });
    await store.deleteWorkflowDefinition(created.id);
    expect(await store.getWorkflowDefinition(created.id)).toBeUndefined();
    expect((await store.listWorkflowDefinitions()).filter((w) => !isBuiltinWorkflowId(w.id))).toHaveLength(0);
  });

  it("throws when deleting a non-existent workflow", async () => {
    await expect(store.deleteWorkflowDefinition("WF-999")).rejects.toThrow(/not found/i);
  });

  it("allocates monotonic ids without reusing across deletes", async () => {
    const a = await store.createWorkflowDefinition({ name: "A", ir: makeIr() });
    const b = await store.createWorkflowDefinition({ name: "B", ir: makeIr() });
    expect(a.id).toBe("WF-001");
    expect(b.id).toBe("WF-002");
    await store.deleteWorkflowDefinition(b.id);
    const c = await store.createWorkflowDefinition({ name: "C", ir: makeIr() });
    expect(c.id).toBe("WF-003");
  });
});
