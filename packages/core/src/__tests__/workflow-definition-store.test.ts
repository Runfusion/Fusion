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

  // ── kind discriminator (U1, R6/KTD-1) ────────────────────────────────

  // A pure-v1 start→node→end fragment IR.
  function fragmentIr(): WorkflowIr {
    return {
      version: "v1",
      name: "frag",
      nodes: [
        { id: "start", kind: "start" },
        { id: "step-1", kind: "prompt", config: { name: "Doc", gateMode: "advisory", prompt: "doc it" } },
        { id: "end", kind: "end" },
      ],
      edges: [
        { from: "start", to: "step-1", condition: "success" },
        { from: "step-1", to: "end", condition: "success" },
      ],
    };
  }

  it("defaults a created workflow to kind 'workflow'", async () => {
    const created = await store.createWorkflowDefinition({ name: "W", ir: makeIr() });
    expect(created.kind).toBe("workflow");
    expect((await store.getWorkflowDefinition(created.id))?.kind).toBe("workflow");
  });

  it("persists and round-trips kind 'fragment' (INSERT includes kind)", async () => {
    const created = await store.createWorkflowDefinition({ name: "Frag", ir: fragmentIr(), kind: "fragment" });
    expect(created.kind).toBe("fragment");
    // Raw column persisted.
    const raw = (store as any).db.prepare("SELECT kind FROM workflows WHERE id = ?").get(created.id) as { kind: string };
    expect(raw.kind).toBe("fragment");
    // Reload.
    expect((await store.getWorkflowDefinition(created.id))?.kind).toBe("fragment");
  });

  it("preserves kind across updateWorkflowDefinition", async () => {
    const created = await store.createWorkflowDefinition({ name: "Frag", ir: fragmentIr(), kind: "fragment" });
    const updated = await store.updateWorkflowDefinition(created.id, { description: "edited" });
    expect(updated.kind).toBe("fragment");
    expect((await store.getWorkflowDefinition(created.id))?.kind).toBe("fragment");
  });

  it("listWorkflowDefinitions({kind:'fragment'}) returns only fragments", async () => {
    await store.createWorkflowDefinition({ name: "W1", ir: makeIr() });
    const frag = await store.createWorkflowDefinition({ name: "F1", ir: fragmentIr(), kind: "fragment" });
    const fragments = await store.listWorkflowDefinitions({ kind: "fragment" });
    expect(fragments.map((w) => w.id)).toEqual([frag.id]);
    expect(fragments.every((w) => w.kind === "fragment")).toBe(true);
  });

  it("built-in list entries are kind 'workflow'", async () => {
    const all = await store.listWorkflowDefinitions();
    const builtins = all.filter((w) => isBuiltinWorkflowId(w.id));
    expect(builtins.length).toBeGreaterThan(0);
    expect(builtins.every((w) => w.kind === "workflow")).toBe(true);
    // The workflow filter includes built-ins; the fragment filter excludes them.
    expect((await store.listWorkflowDefinitions({ kind: "workflow" })).some((w) => isBuiltinWorkflowId(w.id))).toBe(true);
    expect((await store.listWorkflowDefinitions({ kind: "fragment" })).some((w) => isBuiltinWorkflowId(w.id))).toBe(false);
  });

  it("cache regression: filtered then unfiltered (and reverse) are both correct", async () => {
    await store.createWorkflowDefinition({ name: "W1", ir: makeIr() });
    const frag = await store.createWorkflowDefinition({ name: "F1", ir: fragmentIr(), kind: "fragment" });

    // filtered → unfiltered
    const f1 = await store.listWorkflowDefinitions({ kind: "fragment" });
    expect(f1.map((w) => w.id)).toEqual([frag.id]);
    const allAfterFiltered = await store.listWorkflowDefinitions();
    expect(allAfterFiltered.filter((w) => !isBuiltinWorkflowId(w.id)).map((w) => w.kind).sort()).toEqual([
      "fragment",
      "workflow",
    ]);

    // unfiltered → filtered (cache already populated by the unfiltered call)
    const f2 = await store.listWorkflowDefinitions({ kind: "fragment" });
    expect(f2.map((w) => w.id)).toEqual([frag.id]);
    const w2 = await store.listWorkflowDefinitions({ kind: "workflow" });
    expect(w2.filter((w) => !isBuiltinWorkflowId(w.id)).every((w) => w.kind === "workflow")).toBe(true);
  });

  it("a fragment IR survives downgradeIrToV1IfPure unchanged (persists as v1)", async () => {
    const created = await store.createWorkflowDefinition({ name: "Frag", ir: fragmentIr(), kind: "fragment" });
    const raw = (store as any).db.prepare("SELECT ir FROM workflows WHERE id = ?").get(created.id) as { ir: string };
    expect(JSON.parse(raw.ir).version).toBe("v1");
  });

  it("selectTaskWorkflow rejects a fragment id with a clear error", async () => {
    const frag = await store.createWorkflowDefinition({ name: "Frag", ir: fragmentIr(), kind: "fragment" });
    // Create a task to select against.
    const task = await store.createTask({ description: "t" });
    await expect(store.selectTaskWorkflow(task.id, frag.id)).rejects.toThrow(/fragment/i);
  });

  it("setDefaultWorkflowId rejects a fragment id at the write boundary", async () => {
    const frag = await store.createWorkflowDefinition({ name: "Frag", ir: fragmentIr(), kind: "fragment" });
    await expect(store.setDefaultWorkflowId(frag.id)).rejects.toThrow(/fragment/i);
    expect(await store.getDefaultWorkflowId()).toBeUndefined();
  });

  it("setDefaultWorkflowId accepts a real workflow and clears with null", async () => {
    const wf = await store.createWorkflowDefinition({ name: "W", ir: makeIr() });
    await store.setDefaultWorkflowId(wf.id);
    expect(await store.getDefaultWorkflowId()).toBe(wf.id);
    await store.setDefaultWorkflowId(null);
    expect(await store.getDefaultWorkflowId()).toBeUndefined();
  });

  it("createTaskWithReservedId honors an explicit workflowId (precedence over default)", async () => {
    const def = await store.createWorkflowDefinition({ name: "Explicit", ir: makeIr() });
    const task = await store.createTaskWithReservedId(
      { description: "t", workflowId: def.id },
      { taskId: "task-explicit-wf" },
    );
    const sel = store.getTaskWorkflowSelection(task.id);
    expect(sel?.workflowId).toBe(def.id);
  });

  it("createTaskWithReservedId treats workflowId:null as explicit opt-out", async () => {
    const def = await store.createWorkflowDefinition({ name: "Def", ir: makeIr() });
    await store.setDefaultWorkflowId(def.id);
    const task = await store.createTaskWithReservedId(
      { description: "t", workflowId: null },
      { taskId: "task-optout-wf" },
    );
    const sel = store.getTaskWorkflowSelection(task.id);
    expect(sel?.workflowId ?? undefined).toBeUndefined();
  });
});
