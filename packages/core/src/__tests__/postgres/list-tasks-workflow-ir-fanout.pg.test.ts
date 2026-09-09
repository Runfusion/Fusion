import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createSharedPgTaskStoreTestHarness, pgDescribe, type SharedPgTaskStoreHarness } from "../../__test-utils__/pg-test-harness.js";

pgDescribe("listTasks workflow IR fanout (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({ prefix: "fusion_list_ir_fanout" });
  beforeAll(h.beforeAll); beforeEach(h.beforeEach); afterEach(h.afterEach); afterAll(h.afterAll);

  it("reads one custom definition for a multi-row list and none from a warm cache", async () => {
    const store = h.store();
    const definition = await store.createWorkflowDefinition({ name: "Fanout", ir: {
      version: "v2", id: "custom:fanout", nodes: [{ id: "start", kind: "start", column: "todo" }, { id: "end", kind: "end", column: "done" }], edges: [{ from: "start", to: "end" }],
      columns: [{ id: "todo", label: "Todo", traits: [] }, { id: "done", label: "Done", traits: [{ trait: "complete" }] }],
    } } as never);
    for (let index = 0; index < 25; index += 1) {
      const id = `FN-IR-${index}`;
      await store.createTaskWithReservedId({ description: id, column: index === 0 ? "done" : "todo" } as never, { taskId: id, applyDefaultWorkflowSteps: false } as never);
      await store.writeTaskWorkflowSelection(id, definition.id, []);
    }
    const spy = vi.spyOn(store, "getWorkflowDefinition");
    const tally = { definitions: 0 };
    const cache = new Map();
    const first = await store.listTasks({ slim: true, irCache: cache, definitionReadTally: tally });
    expect(first).toHaveLength(25);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(tally.definitions).toBe(1);
    spy.mockClear();
    const warmTally = { definitions: 0 };
    await store.listTasks({ slim: true, irCache: cache, definitionReadTally: warmTally });
    expect(spy).not.toHaveBeenCalled();
    expect(warmTally.definitions).toBe(0);
  });
});
