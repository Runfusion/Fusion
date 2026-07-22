import { describe, expect, it } from "vitest";

import { BUILTIN_CODING_WORKFLOW_IR } from "../builtin-coding-workflow-ir.js";
import { insertWorkflowDefinitionSyncImpl, nextWorkflowDefinitionIdImpl } from "../task-store/workflow-definitions.js";
import type { TaskStore } from "../store.js";

/**
 * SQLite was removed at runtime (VAL-REMOVAL-005), but lifecycle materialization
 * retains this synchronous compatibility branch. This narrow SQLite-shaped fake
 * executes the real allocator and INSERT functions without reviving SQLite.
 */
function createSyncStoreWithStaleWorkflowCounter(): TaskStore {
  const workflowIds = new Set(["WF-002"]);
  const meta = new Map([["nextWorkflowDefinitionId", "2"]]);
  const db = {
    transactionImmediate<T>(operation: () => T): T { return operation(); },
    prepare(query: string) {
      if (query.includes("SELECT value FROM __meta")) {
        return { get: () => meta.has("nextWorkflowDefinitionId") ? { value: meta.get("nextWorkflowDefinitionId") } : undefined };
      }
      if (query.includes("SELECT id FROM workflows")) {
        return { all: () => [...workflowIds].map((id) => ({ id })) };
      }
      if (query.includes("INSERT INTO __meta")) {
        return { run: (value: string) => { meta.set("nextWorkflowDefinitionId", value); } };
      }
      if (query.includes("INSERT INTO workflows")) {
        return {
          run: (id: string) => {
            if (workflowIds.has(id)) throw new Error("UNIQUE constraint failed: workflows.id");
            workflowIds.add(id);
          },
        };
      }
      throw new Error(`Unexpected SQLite-shaped query: ${query}`);
    },
  };
  const store = {
    db,
    nextWorkflowDefinitionId() { return nextWorkflowDefinitionIdImpl(store as TaskStore); },
    assertWorkflowIrTraitsValid() {},
    workflowDefinitionsCache: null,
  };
  return store as unknown as TaskStore;
}

describe("workflow definition id allocator (sync materialization path)", () => {
  it("allocates beyond a stale __meta counter and occupied workflow row", () => {
    const store = createSyncStoreWithStaleWorkflowCounter();

    const created = insertWorkflowDefinitionSyncImpl(store, {
      name: "fresh workflow",
      ir: BUILTIN_CODING_WORKFLOW_IR,
    }, true);

    expect(created.id).toBe("WF-003");
    const second = insertWorkflowDefinitionSyncImpl(store, { name: "second workflow", ir: BUILTIN_CODING_WORKFLOW_IR }, true);
    expect(second.id).toBe("WF-004");
  });
});
