import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
  validateCustomFieldPatch,
  applyFieldDefaults,
  reconcileFieldsOnWorkflowChange,
} from "../task-fields.js";
import type { WorkflowFieldDefinition, WorkflowIr } from "../workflow-ir-types.js";
import { createTaskStoreTestHarness } from "./store-test-helpers.js";

/**
 * U11 / KTD-13 — custom task fields: validation authority, defaults,
 * reconciliation, and the store-level write authority.
 *
 * The pure functions in task-fields.ts are the single validation core; the
 * store delegates to them for updateTask/updateTaskCustomFields and for
 * workflow-switch / definition-edit reconciliation. These tests cover both.
 */

// ── Field-definition fixtures ────────────────────────────────────────────────

const F = (over: Partial<WorkflowFieldDefinition> & { id: string; type: WorkflowFieldDefinition["type"] }): WorkflowFieldDefinition => ({
  name: over.id,
  ...over,
});

const enumOpts = [
  { value: "high", label: "High" },
  { value: "low", label: "Low" },
];

const ALL_TYPES: WorkflowFieldDefinition[] = [
  F({ id: "s", type: "string" }),
  F({ id: "tx", type: "text" }),
  F({ id: "n", type: "number" }),
  F({ id: "b", type: "boolean" }),
  F({ id: "e", type: "enum", options: enumOpts }),
  F({ id: "m", type: "multi-enum", options: enumOpts }),
  F({ id: "d", type: "date" }),
  F({ id: "u", type: "url" }),
];

// ── Pure validation: every type ──────────────────────────────────────────────

describe("validateCustomFieldPatch — per-type validate/reject", () => {
  it("string/text accept strings, reject non-strings", () => {
    expect(validateCustomFieldPatch(ALL_TYPES, { s: "hi", tx: "yo" }).ok).toBe(true);
    const r = validateCustomFieldPatch(ALL_TYPES, { s: 5 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rejection.code).toBe("type-mismatch");
  });

  it("number accepts finite numbers, rejects NaN/Infinity/non-number", () => {
    expect(validateCustomFieldPatch(ALL_TYPES, { n: 3 }).ok).toBe(true);
    expect(validateCustomFieldPatch(ALL_TYPES, { n: 0 }).ok).toBe(true);
    expect(validateCustomFieldPatch(ALL_TYPES, { n: Number.NaN }).ok).toBe(false);
    expect(validateCustomFieldPatch(ALL_TYPES, { n: Number.POSITIVE_INFINITY }).ok).toBe(false);
    expect(validateCustomFieldPatch(ALL_TYPES, { n: "3" }).ok).toBe(false);
  });

  it("boolean accepts booleans only", () => {
    expect(validateCustomFieldPatch(ALL_TYPES, { b: true }).ok).toBe(true);
    expect(validateCustomFieldPatch(ALL_TYPES, { b: "true" }).ok).toBe(false);
  });

  it("date accepts parseable ISO strings, rejects garbage", () => {
    expect(validateCustomFieldPatch(ALL_TYPES, { d: "2026-06-04" }).ok).toBe(true);
    expect(validateCustomFieldPatch(ALL_TYPES, { d: "2026-06-04T12:00:00Z" }).ok).toBe(true);
    expect(validateCustomFieldPatch(ALL_TYPES, { d: "not-a-date" }).ok).toBe(false);
    expect(validateCustomFieldPatch(ALL_TYPES, { d: 20260604 }).ok).toBe(false);
  });

  it("url accepts URL-parseable strings, rejects bad", () => {
    expect(validateCustomFieldPatch(ALL_TYPES, { u: "https://example.com/x" }).ok).toBe(true);
    const r = validateCustomFieldPatch(ALL_TYPES, { u: "not a url" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rejection.code).toBe("type-mismatch");
  });
});

describe("validateCustomFieldPatch — enum membership", () => {
  it("accepts a declared option, rejects a non-member with enum-violation", () => {
    expect(validateCustomFieldPatch(ALL_TYPES, { e: "high" }).ok).toBe(true);
    const r = validateCustomFieldPatch(ALL_TYPES, { e: "medium" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.rejection.code).toBe("enum-violation");
      expect(r.rejection.fieldId).toBe("e");
    }
  });
  it("rejects a non-string enum value with type-mismatch", () => {
    const r = validateCustomFieldPatch(ALL_TYPES, { e: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rejection.code).toBe("type-mismatch");
  });
});

describe("validateCustomFieldPatch — multi-enum subsets + dupes", () => {
  it("accepts a subset of options", () => {
    const r = validateCustomFieldPatch(ALL_TYPES, { m: ["high"] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.normalized.m).toEqual(["high"]);
  });
  it("accepts the empty array", () => {
    expect(validateCustomFieldPatch(ALL_TYPES, { m: [] }).ok).toBe(true);
  });
  it("rejects a non-member with enum-violation", () => {
    const r = validateCustomFieldPatch(ALL_TYPES, { m: ["high", "medium"] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rejection.code).toBe("enum-violation");
  });
  it("rejects duplicate members", () => {
    const r = validateCustomFieldPatch(ALL_TYPES, { m: ["high", "high"] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rejection.code).toBe("enum-violation");
  });
  it("rejects a non-array", () => {
    const r = validateCustomFieldPatch(ALL_TYPES, { m: "high" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rejection.code).toBe("type-mismatch");
  });
});

describe("validateCustomFieldPatch — unknown field & no-fields", () => {
  it("rejects a patch key naming no declared field", () => {
    const r = validateCustomFieldPatch(ALL_TYPES, { nope: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.rejection.code).toBe("unknown-field");
      expect(r.rejection.fieldId).toBe("nope");
    }
  });
  it("rejects any non-empty patch when no fields are defined (no-fields-defined)", () => {
    const r = validateCustomFieldPatch(undefined, { anything: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rejection.code).toBe("no-fields-defined");
    const r2 = validateCustomFieldPatch([], { x: 1 });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.rejection.code).toBe("no-fields-defined");
  });
  it("accepts an EMPTY patch even with no fields defined", () => {
    expect(validateCustomFieldPatch(undefined, {}).ok).toBe(true);
    expect(validateCustomFieldPatch([], {}).ok).toBe(true);
  });
  it("treats null/undefined patch values as delete sentinels (normalized to null)", () => {
    const r = validateCustomFieldPatch(ALL_TYPES, { s: null, n: undefined });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.normalized).toEqual({ s: null, n: null });
  });
});

// ── Defaults ──────────────────────────────────────────────────────────────

describe("applyFieldDefaults", () => {
  const fields: WorkflowFieldDefinition[] = [
    F({ id: "req", type: "string", required: true, default: "x" }),
    F({ id: "reqNoDefault", type: "string", required: true }),
    F({ id: "optDefault", type: "number", default: 7 }),
  ];
  it("fills required field defaults absent from current", () => {
    expect(applyFieldDefaults(fields, {})).toEqual({ req: "x" });
  });
  it("does not override an existing value", () => {
    expect(applyFieldDefaults(fields, { req: "kept" })).toEqual({ req: "kept" });
  });
  it("ignores non-required defaults and required-without-default", () => {
    const out = applyFieldDefaults(fields, {});
    expect(out).not.toHaveProperty("optDefault");
    expect(out).not.toHaveProperty("reqNoDefault");
  });
});

// ── Reconciliation ──────────────────────────────────────────────────────────

describe("reconcileFieldsOnWorkflowChange", () => {
  it("keeps same-id type-compatible values, orphans removed ids", () => {
    const oldF = [F({ id: "a", type: "string" }), F({ id: "gone", type: "number" })];
    const newF = [F({ id: "a", type: "string" })];
    const { kept, orphaned } = reconcileFieldsOnWorkflowChange(oldF, newF, { a: "v", gone: 1 });
    expect(kept).toEqual({ a: "v" });
    expect(orphaned).toEqual({ gone: 1 });
  });

  it("orphans a value when the new type is incompatible", () => {
    const oldF = [F({ id: "a", type: "string" })];
    const newF = [F({ id: "a", type: "number" })];
    const { kept, orphaned } = reconcileFieldsOnWorkflowChange(oldF, newF, { a: "still-a-string" });
    expect(kept).toEqual({});
    expect(orphaned).toEqual({ a: "still-a-string" });
  });

  it("keeps an enum value still in the new options, orphans one no longer present", () => {
    const oldF = [F({ id: "e", type: "enum", options: enumOpts })];
    const newF = [F({ id: "e", type: "enum", options: [{ value: "high", label: "H" }] })];
    expect(reconcileFieldsOnWorkflowChange(oldF, newF, { e: "high" }).kept).toEqual({ e: "high" });
    expect(reconcileFieldsOnWorkflowChange(oldF, newF, { e: "low" }).orphaned).toEqual({ e: "low" });
  });
});

// ── Store authority integration ──────────────────────────────────────────────

describe("store: updateTaskCustomFields + updateTask integration (U11)", () => {
  const harness = createTaskStoreTestHarness();
  let store: ReturnType<typeof harness.store>;

  const irWith = (fields: WorkflowFieldDefinition[], name = "wf"): WorkflowIr =>
    ({
      version: "v2",
      name,
      columns: [
        { id: "todo", name: "todo", traits: [] },
        { id: "in-progress", name: "in-progress", traits: [] },
        { id: "done", name: "done", traits: [] },
      ],
      nodes: [
        { id: "start", kind: "start", column: "todo" },
        { id: "end", kind: "end", column: "todo" },
      ],
      edges: [{ from: "start", to: "end" }],
      fields,
    }) as unknown as WorkflowIr;

  beforeEach(async () => {
    await harness.beforeEach();
    store = harness.store();
  });
  afterEach(async () => {
    await harness.afterEach();
  });

  async function taskWithFields(fields: WorkflowFieldDefinition[]) {
    const def = await (store as any).createWorkflowDefinition({ name: "WF", ir: irWith(fields) });
    const t = await store.createTask({ description: "field task" });
    await (store as any).selectTaskWorkflow(t.id, def.id);
    return { task: t, workflowId: def.id as string };
  }

  it("happy path: validates, merges, persists, returns ok", async () => {
    const { task } = await taskWithFields([
      F({ id: "sev", type: "enum", options: enumOpts }),
      F({ id: "pts", type: "number" }),
    ]);
    const r = await (store as any).updateTaskCustomFields(task.id, { sev: "high", pts: 5 });
    expect(r.ok).toBe(true);
    const got = await store.getTask(task.id);
    expect(got?.customFields).toEqual({ sev: "high", pts: 5 });
  });

  it("reject path: returns a typed rejection, does not mutate", async () => {
    const { task } = await taskWithFields([F({ id: "pts", type: "number" })]);
    const r = await (store as any).updateTaskCustomFields(task.id, { pts: "not-a-number" });
    expect(r.ok).toBe(false);
    expect(r.rejection.code).toBe("type-mismatch");
    expect(r.rejection.fieldId).toBe("pts");
    const got = await store.getTask(task.id);
    expect(got?.customFields).toEqual({});
  });

  it("unknown-field rejection on an undeclared key", async () => {
    const { task } = await taskWithFields([F({ id: "pts", type: "number" })]);
    const r = await (store as any).updateTaskCustomFields(task.id, { nope: 1 });
    expect(r.ok).toBe(false);
    expect(r.rejection.code).toBe("unknown-field");
  });

  it("default workflow (zero fields) rejects cleanly with no-fields-defined", async () => {
    const t = await store.createTask({ description: "default wf" });
    const r = await (store as any).updateTaskCustomFields(t.id, { anything: 1 });
    expect(r.ok).toBe(false);
    expect(r.rejection.code).toBe("no-fields-defined");
  });

  it("emits task:updated on a successful write", async () => {
    const { task } = await taskWithFields([F({ id: "pts", type: "number" })]);
    let emitted = 0;
    (store as any).on("task:updated", () => {
      emitted += 1;
    });
    const r = await (store as any).updateTaskCustomFields(task.id, { pts: 1 });
    expect(r.ok).toBe(true);
    expect(emitted).toBeGreaterThanOrEqual(1);
  });

  it("null patch value deletes the stored value", async () => {
    const { task } = await taskWithFields([F({ id: "pts", type: "number" }), F({ id: "x", type: "number" })]);
    await (store as any).updateTaskCustomFields(task.id, { pts: 1, x: 2 });
    await (store as any).updateTaskCustomFields(task.id, { pts: null });
    const got = await store.getTask(task.id);
    expect(got?.customFields).toEqual({ x: 2 });
  });

  it("updateTask with an invalid customFields patch throws CustomFieldRejectionError", async () => {
    const { task } = await taskWithFields([F({ id: "pts", type: "number" })]);
    await expect(store.updateTask(task.id, { customFields: { pts: "bad" } })).rejects.toThrow(/pts/);
  });

  it("applies required+default fields at workflow selection", async () => {
    const def = await (store as any).createWorkflowDefinition({
      name: "Defaults",
      ir: irWith([F({ id: "tier", type: "string", required: true, default: "bronze" })]),
    });
    const t = await store.createTask({ description: "defaults" });
    await (store as any).selectTaskWorkflow(t.id, def.id);
    const got = await store.getTask(t.id);
    expect(got?.customFields).toEqual({ tier: "bronze" });
  });
});

describe("store: workflow switch reconciliation (U11)", () => {
  const harness = createTaskStoreTestHarness();
  let store: ReturnType<typeof harness.store>;

  const irWith = (fields: WorkflowFieldDefinition[], name: string): WorkflowIr =>
    ({
      version: "v2",
      name,
      columns: [
        { id: "todo", name: "todo", traits: [] },
        { id: "in-progress", name: "in-progress", traits: [] },
        { id: "done", name: "done", traits: [] },
      ],
      nodes: [
        { id: "start", kind: "start", column: "todo" },
        { id: "end", kind: "end", column: "todo" },
      ],
      edges: [{ from: "start", to: "end" }],
      fields,
    }) as unknown as WorkflowIr;

  beforeEach(async () => {
    await harness.beforeEach();
    store = harness.store();
  });
  afterEach(async () => {
    await harness.afterEach();
  });

  it("keeps same-id compatible values and orphans the rest (orphan-not-delete)", async () => {
    const wfA = await (store as any).createWorkflowDefinition({
      name: "A",
      ir: irWith([F({ id: "shared", type: "string" }), F({ id: "onlyA", type: "number" })], "A"),
    });
    const wfB = await (store as any).createWorkflowDefinition({
      name: "B",
      ir: irWith([F({ id: "shared", type: "string" }), F({ id: "onlyB", type: "boolean" })], "B"),
    });
    const t = await store.createTask({ description: "switch" });
    await (store as any).selectTaskWorkflow(t.id, wfA.id);
    await (store as any).updateTaskCustomFields(t.id, { shared: "v", onlyA: 3 });

    await (store as any).selectTaskWorkflow(t.id, wfB.id);
    const got = await store.getTask(t.id);
    // shared kept; onlyA orphaned but RETAINED in storage (never destroyed).
    expect(got?.customFields).toEqual({ shared: "v", onlyA: 3 });
  });
});

describe("store: updateWorkflowDefinition field-type change coercion (U11)", () => {
  const harness = createTaskStoreTestHarness();
  let store: ReturnType<typeof harness.store>;

  const irWith = (fields: WorkflowFieldDefinition[], name = "WF"): WorkflowIr =>
    ({
      version: "v2",
      name,
      columns: [
        { id: "todo", name: "todo", traits: [] },
        { id: "in-progress", name: "in-progress", traits: [] },
        { id: "done", name: "done", traits: [] },
      ],
      nodes: [
        { id: "start", kind: "start", column: "todo" },
        { id: "end", kind: "end", column: "todo" },
      ],
      edges: [{ from: "start", to: "end" }],
      fields,
    }) as unknown as WorkflowIr;

  beforeEach(async () => {
    await harness.beforeEach();
    store = harness.store();
  });
  afterEach(async () => {
    await harness.afterEach();
  });

  async function fieldedTaskAndWf(fields: WorkflowFieldDefinition[]) {
    const def = await (store as any).createWorkflowDefinition({ name: "WF", ir: irWith(fields) });
    const t = await store.createTask({ description: "edit" });
    await (store as any).selectTaskWorkflow(t.id, def.id);
    return { workflowId: def.id as string, taskId: t.id as string };
  }

  it("rejects an incompatible type change with occupants and no coerce", async () => {
    const { workflowId, taskId } = await fieldedTaskAndWf([F({ id: "x", type: "string" })]);
    await (store as any).updateTaskCustomFields(taskId, { x: "hello" });
    await expect(
      store.updateWorkflowDefinition(workflowId, { ir: irWith([F({ id: "x", type: "number" })]) }),
    ).rejects.toThrow(/IncompatibleFieldChange|incompatibl/i);
  });

  it("coerce:keep-orphaned retains the now-incompatible value", async () => {
    const { workflowId, taskId } = await fieldedTaskAndWf([F({ id: "x", type: "string" })]);
    await (store as any).updateTaskCustomFields(taskId, { x: "hello" });
    await store.updateWorkflowDefinition(workflowId, {
      ir: irWith([F({ id: "x", type: "number" })]),
      coerce: "keep-orphaned",
    });
    const got = await store.getTask(taskId);
    expect(got?.customFields).toEqual({ x: "hello" });
  });

  it("coerce:drop discards the now-incompatible value", async () => {
    const { workflowId, taskId } = await fieldedTaskAndWf([F({ id: "x", type: "string" })]);
    await (store as any).updateTaskCustomFields(taskId, { x: "hello" });
    await store.updateWorkflowDefinition(workflowId, {
      ir: irWith([F({ id: "x", type: "number" })]),
      coerce: "drop",
    });
    const got = await store.getTask(taskId);
    expect(got?.customFields).toEqual({});
  });

  it("removing a field outright orphans (never blocks, value retained)", async () => {
    const { workflowId, taskId } = await fieldedTaskAndWf([
      F({ id: "x", type: "string" }),
      F({ id: "y", type: "string" }),
    ]);
    await (store as any).updateTaskCustomFields(taskId, { x: "a", y: "b" });
    await store.updateWorkflowDefinition(workflowId, { ir: irWith([F({ id: "x", type: "string" })]) });
    const got = await store.getTask(taskId);
    // y orphaned but retained.
    expect(got?.customFields).toEqual({ x: "a", y: "b" });
  });

  // T1 (store.ts:12410): a field-schema edit that adds a new required+default
  // field must backfill the default onto EVERY occupant, including occupants
  // that currently hold no custom field values — not only ones already populated.
  it("backfills a new required+default field onto occupants with no existing values", async () => {
    const { taskId, workflowId } = await fieldedTaskAndWf([F({ id: "x", type: "string" })]);
    // Occupant deliberately has NO custom field values stored.
    const before = await store.getTask(taskId);
    expect(before?.customFields ?? {}).toEqual({});

    await store.updateWorkflowDefinition(workflowId, {
      ir: irWith([
        F({ id: "x", type: "string" }),
        F({ id: "tier", type: "string", required: true, default: "bronze" }),
      ]),
    });

    const got = await store.getTask(taskId);
    expect(got?.customFields).toEqual({ tier: "bronze" });
  });
});

// ── Archive → unarchive customFields round-trip ──────────────────────────────

describe("store: archive → unarchive preserves customFields (T0)", () => {
  const harness = createTaskStoreTestHarness();
  let store: ReturnType<typeof harness.store>;

  const irWith = (fields: WorkflowFieldDefinition[], name = "WF"): WorkflowIr =>
    ({
      version: "v2",
      name,
      columns: [
        { id: "todo", name: "todo", traits: [] },
        { id: "in-progress", name: "in-progress", traits: [] },
        { id: "done", name: "done", traits: [] },
      ],
      nodes: [
        { id: "start", kind: "start", column: "todo" },
        { id: "end", kind: "end", column: "todo" },
      ],
      edges: [{ from: "start", to: "end" }],
      fields,
    }) as unknown as WorkflowIr;

  beforeEach(async () => {
    await harness.beforeEach();
    store = harness.store();
  });
  afterEach(async () => {
    await harness.afterEach();
  });

  it("restores customFields after an archive → unarchive round-trip", async () => {
    const def = await (store as any).createWorkflowDefinition({
      name: "WF",
      ir: irWith([F({ id: "sev", type: "enum", options: enumOpts }), F({ id: "pts", type: "number" })]),
    });
    const t = await store.createTask({ description: "round-trip" });
    await (store as any).selectTaskWorkflow(t.id, def.id);
    await (store as any).updateTaskCustomFields(t.id, { sev: "high", pts: 5 });

    // Move through the legacy transition chain to reach 'done', then archive.
    await store.moveTask(t.id, "todo");
    await store.moveTask(t.id, "in-progress");
    await store.moveTask(t.id, "in-review");
    await store.moveTask(t.id, "done");
    const archived = await store.archiveTask(t.id);
    expect(archived.column).toBe("archived");

    const restored = await store.unarchiveTask(t.id);
    expect(restored.customFields).toEqual({ sev: "high", pts: 5 });
    const got = await store.getTask(t.id);
    expect(got?.customFields).toEqual({ sev: "high", pts: 5 });
  });
});

// ── JSON round-trip stability ────────────────────────────────────────────────

describe("custom-field values JSON round-trip", () => {
  it("normalized values survive a JSON round-trip unchanged", () => {
    const r = validateCustomFieldPatch(ALL_TYPES, {
      s: "x",
      n: 1.5,
      b: false,
      e: "low",
      m: ["high", "low"],
      d: "2026-06-04",
      u: "https://x.test/",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(JSON.parse(JSON.stringify(r.normalized))).toEqual(r.normalized);
    }
  });
});
