import { afterEach, describe, expect, it } from "vitest";
import {
  createTaskStoreForTest,
  pgDescribe,
  type PgTestHarness,
} from "../../__test-utils__/pg-test-harness.js";

const pgTest = pgDescribe;

pgTest("proactive step-status chat entries (PostgreSQL)", () => {
  let harness: PgTestHarness | undefined;

  afterEach(async () => {
    await harness?.teardown();
    harness = undefined;
  });

  it("narrates every accepted lifecycle transition once, including recovery to pending", async () => {
    harness = await createTaskStoreForTest({ prefix: "fusion_proactive_step_status" });
    const task = await harness.store.createTask({
      title: "Narrate step lifecycle",
      description: "A task with a persisted step.",
    });
    await harness.store.updateTask(task.id, {
      steps: [{ name: "Implement the change", status: "pending" }],
    });

    await harness.store.updateStep(task.id, 0, "in-progress");
    await harness.store.updateStep(task.id, 0, "done");
    await harness.store.updateStep(task.id, 0, "pending");
    // An identical write is not a new lifecycle event and must not duplicate chat rows.
    await harness.store.updateStep(task.id, 0, "pending");

    const statuses = (await harness.store.getAgentLogs(task.id, { type: "status" })).map((entry) => entry.text);
    expect(statuses).toEqual([
      "Starting Step 0: Implement the change",
      "Step 0 finished — Implement the change.",
      "Step 0 was returned to pending — Implement the change.",
    ]);
  });
});

// Keep `describe` referenced if the PostgreSQL reachability guard skips this suite.
void describe;
