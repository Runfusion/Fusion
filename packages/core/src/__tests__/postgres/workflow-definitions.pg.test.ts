/**
 * FNXC:WorkflowDefinitions 2026-06-27-06:00:
 * PostgreSQL coverage for the workflow-definition read port. In PG backend mode
 * readAllWorkflowDefinitions/getWorkflowDefinition now read custom rows from
 * project.workflows via the AsyncDataLayer (the sync store.db SELECT threw, which
 * 500'd /api/workflows). Builtins still come from code constants. Runs in the
 * blocking test:pg-gate lane.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";

import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";

const pgTest = pgDescribe;

pgTest("workflow definitions (PostgreSQL backend mode)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_workflow_defs",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  it("listWorkflowDefinitions resolves (builtins) without throwing in backend mode", async () => {
    const store = h.store();
    expect(store.backendMode).toBe(true);
    const defs = await store.listWorkflowDefinitions({ includeDisabledBuiltins: true });
    // Builtins come from code constants and must be present even with no custom rows.
    expect(Array.isArray(defs)).toBe(true);
    expect(defs.length).toBeGreaterThan(0);
  });

  it("custom workflow rows are read from project.workflows via the async helpers", async () => {
    // The PG read port is the WorkflowRow query + jsonb→JSON-string mapping. IR
    // semantic validation is downstream (backend-agnostic) and not under test
    // here, so this asserts the read helpers directly rather than the full
    // listWorkflowDefinitions mapper (which rejects a non-runnable stub IR).
    const store = h.store();
    const layer = store.getAsyncLayer();
    if (!layer) throw new Error("expected async layer in backend mode");
    const { listWorkflowRows, getWorkflowRow } = await import("../../async-workflow-store.js");
    const { project } = await import("../../postgres/schema/index.js");
    const now = "2026-01-01T00:00:00.000Z";
    await layer.db.insert(project.workflows).values({
      id: "WF-CUSTOM-1",
      name: "Custom Flow",
      description: "a custom workflow",
      ir: { version: "v1", nodes: [], edges: [] } as unknown as object,
      layout: { positions: { a: 1 } } as unknown as object,
      kind: "workflow",
      createdAt: now,
      updatedAt: now,
    });

    const rows = await listWorkflowRows(layer);
    const mine = rows.find((r) => r.id === "WF-CUSTOM-1");
    expect(mine?.name).toBe("Custom Flow");
    expect(mine?.kind).toBe("workflow");
    // jsonb is re-stringified to JSON text for the shared toWorkflowDefinition mapper.
    expect(JSON.parse(mine!.ir).version).toBe("v1");
    expect(JSON.parse(mine!.layout).positions.a).toBe(1);

    const fetched = await getWorkflowRow(layer, "WF-CUSTOM-1");
    expect(fetched?.name).toBe("Custom Flow");
    expect(await getWorkflowRow(layer, "WF-DOES-NOT-EXIST")).toBeUndefined();
  });
});
