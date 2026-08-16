import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../__test-utils__/pg-test-harness.js";
import { sql } from "drizzle-orm";
import { type WorkflowIr, type WorkflowIrV1, type WorkflowIrV2 } from "../index.js";
import { resolveColumnFlags } from "../workflows/trait-registry.js";
import { downgradeIrToV1IfPure, parseWorkflowIr, serializeWorkflowIr } from "../workflows/workflow-ir.js";
import { resolveWorkflowIrById, resolveWorkflowIrForTask } from "../workflows/workflow-ir-resolver.js";
import { stepsToWorkflowIr } from "../workflows/workflow-steps-to-ir.js";
import {
  BUILTIN_WORKFLOWS,
  DEFAULT_WORKFLOW_ID,
  getBuiltinWorkflow,
  resolveDefaultWorkflowIr,
} from "../workflows/builtin-workflows.js";
import { BUILTIN_CODING_WORKFLOW_IR } from "../workflows/builtin-coding-workflow-ir.js";

/*
FNXC:WorkflowBuiltins 2026-07-19-10:40:
Regression for the flag-ON "workflow move policy preflight is stale" throw on a
task with NO `task_workflow_selection` row.

Root cause: two independent implementations of the same no-selection default.
`prepareWorkflowMovePolicyPreflightImpl` resolved it through the builtin catalog
(`builtin:coding` -> BUILTIN_STEPWISE_FINAL_REVIEW_CODING_WORKFLOW_IR) while
`resolveTaskWorkflowIrForMove` used the raw legacy `BUILTIN_CODING_WORKFLOW_IR`
constant (which the catalog now publishes as `builtin:legacy-coding`). The two
IRs serialize differently, so the signature the preflight stamped never matched
the one the move re-derived and every such move was rejected as stale.

Fix: one authority — `resolveDefaultWorkflowIr()` — shared by the async move
resolver, the sync resolver, and `workflow-ir-resolver`'s `defaultCodingWorkflowIr`.

Surface enumeration (invariant: EVERY no-selection default resolution yields the
same IR, and a no-selection move is not rejected):
 - the shared helper resolves the CATALOG `builtin:coding` entry, not the legacy constant;
 - the public async resolver (`resolveWorkflowIrForTask`) agrees with the helper for a
   task whose selection row is absent;
 - a real store move on a task with the selection row cleared succeeds (the throw's surface);
 - the whole default column trail (triage -> todo -> in-progress) stays walkable, not just
   the first hop that happened to reproduce.
*/
describe("no-selection default workflow IR (single authority)", () => {
  it("resolves the catalog builtin:coding entry, not the legacy coding IR", () => {
    const catalog = getBuiltinWorkflow(DEFAULT_WORKFLOW_ID);
    expect(catalog).toBeDefined();
    expect(serializeWorkflowIr(resolveDefaultWorkflowIr())).toBe(
      serializeWorkflowIr(catalog!.ir as never),
    );
  });

  it("does not resolve to the legacy BUILTIN_CODING_WORKFLOW_IR constant", () => {
    // Guards the exact drift: the legacy constant is `builtin:legacy-coding`, a
    // DIFFERENT catalog entry. If these ever serialize the same the test is inert.
    const legacyEntry = BUILTIN_WORKFLOWS.find((wf) => wf.ir === BUILTIN_CODING_WORKFLOW_IR);
    expect(legacyEntry?.id).toBe("builtin:legacy-coding");
    expect(serializeWorkflowIr(resolveDefaultWorkflowIr())).not.toBe(
      serializeWorkflowIr(BUILTIN_CODING_WORKFLOW_IR),
    );
  });

  it("agrees with the public async resolver when a task has no selection", async () => {
    const store = {
      getTaskWorkflowSelection: () => undefined,
      getTaskWorkflowSelectionAsync: async () => undefined,
      getWorkflowDefinition: async () => undefined,
    };
    const resolved = await resolveWorkflowIrForTask(store, "FN-NO-SELECTION");
    expect(serializeWorkflowIr(resolved)).toBe(serializeWorkflowIr(resolveDefaultWorkflowIr()));
  });
});

/*
FNXC:SlowTestCondense 2026-08-16-03:43:
custom-v1-workflow-dispatch.test.ts (3 tests) was merged into this thematically
adjacent workflow-selection file so both suites share ONE shared-harness PG boot
instead of each paying the fixed per-file DB-create cost for a handful of tests.
The dispatch describe runs first so its tests keep their original within-file
settings ordering; the move test below explicitly sets `workflowColumns: true`
itself, so the merge is behavior-preserving. All describe/it names and
assertions are verbatim from the absorbed file.
*/

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

pgDescribe("no-selection moves + custom v1 workflow dispatch (shared PG harness)", () => {
  const harness: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_no_selection_move",
  });
  beforeAll(harness.beforeAll);
  beforeEach(harness.beforeEach);
  afterEach(harness.afterEach);
  afterAll(harness.afterAll);

  /*
   * FNXC:Workflows 2026-06-28-08:45:
   * Pure-v1 custom workflows intentionally upgrade through synthesizeDefaultColumns(), whose columns are placement-only and trait-less for FN-5769/#1405 rollback compatibility. Capacity-dispatched custom workflows must author v2 columns with todo hold(capacity); the engine test suite asserts that documented remedy performs the actual sweep release.
   */
  describe("custom v1 workflow dispatch characterization", () => {
    it("documents that pure-v1 custom workflows resolve to a trait-less todo column", async () => {
      const store = harness.store();
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
      const store = harness.store();
      await store.updateGlobalSettings({ experimentalFeatures: { workflowColumns: false } });

      const fromRawV1 = await store.createWorkflowDefinition({
        name: "persisted raw v1",
        ir: pureV1CustomWorkflow(),
      });
      const storedRawV1 = (await rawStoredWorkflowIr(harness, fromRawV1.id)) as { version?: string };
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
      const storedFromSteps = (await rawStoredWorkflowIr(harness, stepDerivedDefinition.id)) as { version?: string };
      expect(storedFromSteps.version).toBe("v1");
    });
  });

  describe("moves on a task with no workflow-selection row", () => {
    it("moves through the default column trail without a stale-preflight rejection", async () => {
      const store = harness.store();
      // The stale-preflight comparison only runs on the flag-ON workflow path.
      await store.updateGlobalSettings({ experimentalFeatures: { workflowColumns: true } });
      const task = await store.createTask({ description: "no selection row" });
      await store.clearTaskWorkflowSelection(task.id);
      expect(await store.getTaskWorkflowSelectionAsync(task.id)).toBeUndefined();

      const toTodo = await store.moveTask(task.id, "todo", { moveSource: "user" });
      expect(toTodo.column).toBe("todo");

      const toInProgress = await store.moveTask(task.id, "in-progress", { moveSource: "user" });
      expect(toInProgress.column).toBe("in-progress");
    });
  });
});
