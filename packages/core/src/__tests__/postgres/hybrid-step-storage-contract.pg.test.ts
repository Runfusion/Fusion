/*
FNXC:HybridStepStorage 2026-08-23-20:10:
Pins the hybrid step-storage contract that an investigation mistook for a PostgreSQL persistence bug
("updateTask(id, {steps: []}) silently no-ops"). Both halves are asserted here so the next reader
sees the mechanism instead of re-diagnosing it:
  1. the WRITE is literal — an empty array really is persisted;
  2. the READ re-derives steps from PROMPT.md whenever the stored array is empty, because PROMPT.md
     is the source of truth for a task's plan (`updateStep`'s range error says so outright).
Removing (2) would strand every task whose plan lives only in PROMPT.md; removing (1) would lose a
legitimate write. Change either half only with both of these updated deliberately.
*/
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";

pgDescribe("hybrid step storage contract (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({ prefix: "fusion_hybrid_steps" });
  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  it("persists an explicit empty steps array to the row and to task.json", async () => {
    const task = await h.store().createTask({ description: "hybrid steps" });
    await h.store().updateTask(task.id, { steps: [{ name: "One", status: "pending" }] } as never);
    await h.store().updateTask(task.id, { steps: [] } as never);

    // The write is literal: nothing swallows or reverts it at the persistence layer.
    const onDisk = JSON.parse(await readFile(join(h.store().taskDir(task.id), "task.json"), "utf-8"));
    expect(onDisk.steps).toEqual([]);
  });

  it("re-derives steps from PROMPT.md on read when the stored array is empty", async () => {
    const task = await h.store().createTask({ description: "hybrid steps read" });
    const dir = h.store().taskDir(task.id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "PROMPT.md"), "## Steps\n\n### Step 1: Alpha\n\n### Step 2: Beta\n", "utf-8");
    await h.store().updateTask(task.id, { steps: [] } as never);

    const read = await h.store().getTask(task.id);
    expect(read!.steps.map((step) => step.name)).toEqual(["Alpha", "Beta"]);
  });
});
