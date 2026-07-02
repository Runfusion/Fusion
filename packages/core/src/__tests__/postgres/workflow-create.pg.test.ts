/**
 * FNXC:SqliteFinalRemoval 2026-06-28:
 * PostgreSQL coverage for the workflow-definition CREATE port. In PG backend
 * mode createWorkflowDefinition previously threw ("SQLite Database is not
 * available in backend mode") because the WF-id counter read a SQLite __meta row
 * and the INSERT hit store.db. The port moves the counter into
 * project.config.next_workflow_definition_id and INSERTs via the AsyncDataLayer
 * (jsonb ir/layout written as objects). This proves the full
 * create→update→delete cycle through the async layer, plus that the WF-id
 * counter increments (no PK collision on a second create). Runs in the blocking
 * test:pg-gate lane.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";

import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import { BUILTIN_CODING_WORKFLOW_IR } from "../../builtin-coding-workflow-ir.js";

const pgTest = pgDescribe;

pgTest("workflow definition create (PostgreSQL backend mode)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_workflow_create",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  it("creates, updates, and deletes a workflow definition through the async layer", async () => {
    const store = h.store();
    expect(store.backendMode).toBe(true);

    const ir = BUILTIN_CODING_WORKFLOW_IR;

    // CREATE — must persist a real WF-### id allocated from project.config.
    const created = await store.createWorkflowDefinition({
      name: "My Custom Flow",
      description: "first custom flow",
      ir,
      layout: { positions: { a: 1 } },
    });
    expect(created.id).toMatch(/^WF-\d{3}$/);
    expect(created.name).toBe("My Custom Flow");

    const fetched = await store.getWorkflowDefinition(created.id);
    expect(fetched).toBeDefined();
    expect(fetched!.id).toBe(created.id);
    expect(fetched!.name).toBe("My Custom Flow");
    expect(fetched!.description).toBe("first custom flow");
    expect(fetched!.ir.version).toBe(ir.version);

    // SECOND CREATE — the id counter must increment (distinct id, no PK collision).
    const second = await store.createWorkflowDefinition({
      name: "Another Flow",
      description: "second custom flow",
      ir,
      layout: {},
    });
    expect(second.id).toMatch(/^WF-\d{3}$/);
    expect(second.id).not.toBe(created.id);

    const fetchedSecond = await store.getWorkflowDefinition(second.id);
    expect(fetchedSecond?.name).toBe("Another Flow");

    // UPDATE — change the description; the row round-trips through the async UPDATE.
    const updated = await store.updateWorkflowDefinition(created.id, {
      description: "edited description",
    });
    expect(updated.description).toBe("edited description");
    const refetched = await store.getWorkflowDefinition(created.id);
    expect(refetched!.description).toBe("edited description");

    // DELETE — removes the row; getWorkflowDefinition then returns undefined.
    await store.deleteWorkflowDefinition(created.id);
    expect(await store.getWorkflowDefinition(created.id)).toBeUndefined();
    // The sibling survives the delete (independent rows).
    expect(await store.getWorkflowDefinition(second.id)).toBeDefined();
  });
});
