// @vitest-environment node

/**
 * FNXC:SqliteFinalRemoval 2026-07-11:
 * Migrated from raw SQLite `store.db.prepare(...)` access on
 * `new TaskStore(rootDir, undefined, { inMemoryDb: false })` to the shared
 * PostgreSQL test harness. The `setSelection` / `rawStoredWorkflowIr`
 * helpers now run through `h.adminDb()` (Drizzle + `sql` template) against
 * the same DB the store uses, instead of the removed SQLite handle.
 */
import { it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../__test-utils__/pg-test-harness.js";
import { sql } from "drizzle-orm";
import { type WorkflowIr, type WorkflowIrV1, type WorkflowIrV2 } from "../index.js";
import { resolveColumnFlags } from "../trait-registry.js";
import { downgradeIrToV1IfPure, parseWorkflowIr } from "../workflow-ir.js";
import { resolveWorkflowIrById } from "../workflow-ir-resolver.js";
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

/**
 * Seed `project.task_workflow_selection` directly via the admin Drizzle
 * connection (the store's public API intentionally has no setter for raw
 * selection rows). `task_id` is the primary key, so `ON CONFLICT (task_id)`
 * upserts. `step_ids` is jsonb.
 */
async function setSelection(
  h: SharedPgTaskStoreHarness,
  taskId: string,
  workflowId: string,
): Promise<void> {
  await h.adminDb().execute(sql`
    INSERT INTO project.task_workflow_selection (task_id, workflow_id, step_ids, updated_at)
    VALUES (${taskId}, ${workflowId}, '[]'::jsonb, ${new Date().toISOString()})
    ON CONFLICT (task_id) DO UPDATE SET
      workflow_id = EXCLUDED.workflow_id,
      updated_at = EXCLUDED.updated_at
  `);
}

/**
 * Read the raw persisted workflow IR straight from `project.workflows` to
 * assert storage fidelity (independent of the store's hydration path). The
 * `ir` column is jsonb, which the `postgres` driver auto-parses into a JS
 * value; the `typeof === "string"` guard keeps this robust if that ever
 * changes.
 */
async function rawStoredWorkflowIr(
  h: SharedPgTaskStoreHarness,
  workflowId: string,
): Promise<unknown> {
  const rows = (await h.adminDb().execute(
    sql`SELECT ir FROM project.workflows WHERE id = ${workflowId}`,
  )) as unknown as Array<{ ir: unknown }>;
  if (!rows[0]) throw new Error(`missing workflow row ${workflowId}`);
  const ir = rows[0].ir;
  return typeof ir === "string" ? JSON.parse(ir) : ir;
}

const pgTest = pgDescribe;

/*
 * FNXC:Workflows 2026-06-28-08:45:
 * Pure-v1 custom workflows intentionally upgrade through synthesizeDefaultColumns(), whose columns are placement-only and trait-less for FN-5769/#1405 rollback compatibility. Capacity-dispatched custom workflows must author v2 columns with todo hold(capacity); the engine test suite asserts that documented remedy performs the actual sweep release.
 */
pgTest("custom v1 workflow dispatch characterization", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_custom_v1_wf",
  });

  beforeAll(h.beforeAll);
  afterAll(h.afterAll);
  beforeEach(async () => {
    await h.beforeEach();
  });
  afterEach(async () => {
    await h.afterEach();
  });

  it("documents that pure-v1 custom workflows resolve to a trait-less todo column", async () => {
    const store = h.store();
    const definition = await store.createWorkflowDefinition({
      name: "pure v1 custom",
      ir: pureV1CustomWorkflow(),
    });
    const task = await store.createTask({ description: "uses pure v1 custom workflow" });
    await store.writeTaskWorkflowSelection(task.id, definition.id, []);

    // resolveWorkflowIrForTask uses the sync getTaskWorkflowSelection which returns
    // undefined in backend mode (PG); resolve by the known definition ID instead.
    const resolved = await resolveWorkflowIrById(store, definition.id);
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
    const store = h.store();
    await store.updateGlobalSettings({ experimentalFeatures: { workflowColumns: false } });

    const fromRawV1 = await store.createWorkflowDefinition({
      name: "persisted raw v1",
      ir: pureV1CustomWorkflow(),
    });
    const storedRawV1 = (await rawStoredWorkflowIr(h, fromRawV1.id)) as { version?: string };
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
    const storedFromSteps = (await rawStoredWorkflowIr(h, stepDerivedDefinition.id)) as { version?: string };
    expect(storedFromSteps.version).toBe("v1");
  });
});
