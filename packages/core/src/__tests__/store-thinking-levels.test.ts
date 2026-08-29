/*
FNXC:SqliteFinalRemoval 2026-07-14:
Migrated from the removed SQLite `new TaskStore(root)` path (VAL-REMOVAL-005)
to the PostgreSQL test harness via `createTaskStoreForTest`. The legacy
`createTaskStoreTestHarness` (store-test-helpers.ts) builds a TaskStore with
no async layer, which now throws because the SQLite Database class body was
deleted. The harness provides a backend-mode TaskStore (`asyncLayer` injected)
backed by an isolated PG database, so the thinking-level round-trip
assertions are unchanged: create/update/omit/null-clear behave identically
through the backend-agnostic TaskStore API (PG row mapper maps NULL -> undefined,
matching the prior SQLite behavior the assertions expect).
*/
import { describe, expect, it } from "vitest";
import {
  pgDescribe,
  createTaskStoreForTest,
  type PgTestHarness,
} from "../__test-utils__/pg-test-harness.js";

pgDescribe("TaskStore task thinking levels", () => {
  let harness: PgTestHarness | null = null;

  async function makeHarness(): Promise<PgTestHarness> {
    harness = await createTaskStoreForTest({ prefix: "fusion_thinking_levels" });
    return harness;
  }

  async function teardown(): Promise<void> {
    if (harness) {
      await harness.teardown();
      harness = null;
    }
  }

  it("round-trips per-lane thinking levels through create, update, omit, and null clear", async () => {
    const h = await makeHarness();
    try {
      const store = h.store;
      const created = await store.createTask({
        description: "per-lane thinking fields",
        validatorThinkingLevel: "high",
        planningThinkingLevel: "low",
      });

      expect(created.validatorThinkingLevel).toBe("high");
      expect(created.planningThinkingLevel).toBe("low");
      expect((await store.getTask(created.id)).validatorThinkingLevel).toBe("high");
      expect((await store.getTask(created.id)).planningThinkingLevel).toBe("low");

      const updated = await store.updateTask(created.id, {
        validatorThinkingLevel: "medium",
        planningThinkingLevel: "minimal",
      });
      expect(updated.validatorThinkingLevel).toBe("medium");
      expect(updated.planningThinkingLevel).toBe("minimal");

      const omitted = await store.updateTask(created.id, { title: "untouched thinking" });
      expect(omitted.validatorThinkingLevel).toBe("medium");
      expect(omitted.planningThinkingLevel).toBe("minimal");

      const cleared = await store.updateTask(created.id, {
        validatorThinkingLevel: null,
        planningThinkingLevel: null,
      });
      expect(cleared.validatorThinkingLevel).toBeUndefined();
      expect(cleared.planningThinkingLevel).toBeUndefined();
      expect((await store.getTask(created.id)).validatorThinkingLevel).toBeUndefined();
      expect((await store.getTask(created.id)).planningThinkingLevel).toBeUndefined();
    } finally {
      await teardown();
    }
  });
});

// Keep `describe` referenced so the import is not flagged as unused if the
// pgDescribe.skip path is taken in CI (no PG available).
void describe;
