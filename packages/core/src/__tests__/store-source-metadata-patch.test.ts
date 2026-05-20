import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { TaskStore } from "../store.js";
import { createTaskStoreTestHarness } from "./store-test-helpers.js";

describe("TaskStore.updateTask sourceMetadataPatch", () => {
  const harness = createTaskStoreTestHarness();

  beforeEach(harness.beforeEach);
  afterEach(harness.afterEach);

  it("adds metadata when none exists", async () => {
    const task = await harness.store().createTask({ description: "Patch metadata" });

    await harness.store().updateTask(task.id, {
      sourceMetadataPatch: { duplicateOfTaskIds: ["FN-1"] },
    });

    const detail = await harness.store().getTask(task.id);
    expect(detail.sourceMetadata).toEqual({ duplicateOfTaskIds: ["FN-1"] });
  });

  it("preserves unrelated keys and overwrites shallowly", async () => {
    const task = await harness.store().createTask({
      description: "Existing metadata",
      source: {
        sourceType: "chat_session",
        sourceMetadata: {
          acknowledgedDuplicateIds: ["FN-8"],
          nested: { before: true },
        },
      },
    });

    await harness.store().updateTask(task.id, {
      sourceMetadataPatch: {
        duplicateOfTaskIds: ["FN-2"],
        nested: { after: true },
      },
    });

    const detail = await harness.store().getTask(task.id);
    expect(detail.sourceMetadata).toEqual({
      acknowledgedDuplicateIds: ["FN-8"],
      duplicateOfTaskIds: ["FN-2"],
      nested: { after: true },
    });
  });

  it("clears metadata when sourceMetadataPatch is null", async () => {
    const task = await harness.store().createTask({
      description: "Clear metadata",
      source: {
        sourceType: "chat_session",
        sourceMetadata: { duplicateOfTaskIds: ["FN-3"] },
      },
    });

    await harness.store().updateTask(task.id, { sourceMetadataPatch: null });

    const detail = await harness.store().getTask(task.id);
    expect(detail.sourceMetadata).toBeUndefined();
  });

  it("persists patched metadata across sqlite reopen", async () => {
    harness.store().close();
    const store = new TaskStore(harness.rootDir(), harness.globalDir());
    await store.init();

    try {
      const task = await store.createTask({ description: "Persist metadata patch" });

      await store.updateTask(task.id, {
        sourceMetadataPatch: { duplicateOfTaskIds: ["FN-4", "FN-5"] },
      });

      store.close();
      const reopened = new TaskStore(harness.rootDir(), harness.globalDir());
      await reopened.init();

      try {
        const detail = await reopened.getTask(task.id);
        expect(detail.sourceMetadata).toEqual({ duplicateOfTaskIds: ["FN-4", "FN-5"] });
      } finally {
        reopened.close();
      }
    } finally {
      store.close();
    }
  });
});
