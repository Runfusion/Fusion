import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTaskStoreTestHarness } from "./store-test-helpers.js";

describe("TaskStore task thinking levels", () => {
  const harness = createTaskStoreTestHarness();

  beforeEach(harness.beforeEach);
  afterEach(harness.afterEach);

  it("round-trips per-lane thinking levels through create, update, omit, and null clear", async () => {
    const store = harness.store();
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
  });
});
