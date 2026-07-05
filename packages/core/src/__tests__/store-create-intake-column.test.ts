import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Task } from "../types.js";
import { createTaskStoreTestHarness } from "./store-test-helpers.js";

/*
FNXC:CodingIdeasWorkflow 2026-07-04-11:30:
Pin the createTask intake-column wiring: a task created against the Coding (Ideas) workflow (manual autoTriage:false intake) must land in the "ideas" column, not the legacy "triage" default, while the default Coding workflow keeps landing cards in "triage".
*/
describe("createTask intake-column wiring (Coding (Ideas))", () => {
  const harness = createTaskStoreTestHarness();

  beforeEach(harness.beforeEach);
  afterEach(harness.afterEach);

  it("lands a default-workflow task in triage (byte-identical regression guard)", async () => {
    const store = harness.store();
    const task = await store.createTask({ description: "default workflow task" });
    expect(task.column).toBe("triage");
  });

  it("lands a Coding (Ideas) task in the ideas intake column when selected explicitly", async () => {
    const store = harness.store();
    const task = await store.createTask({
      description: "ideas workflow task",
      workflowId: "builtin:coding-ideas",
    });
    expect(task.column).toBe("ideas");
  });

  it("lands a Coding (Ideas) task in ideas when it is the project default workflow", async () => {
    const store = harness.store();
    await store.setDefaultWorkflowId("builtin:coding-ideas");
    const task = await store.createTask({ description: "default ideas task" });
    expect(task.column).toBe("ideas");
  });

  it("lands a task explicitly selecting builtin:coding in triage even when the project default is coding-ideas", async () => {
    const store = harness.store();
    await store.setDefaultWorkflowId("builtin:coding-ideas");
    const task = await store.createTask({
      description: "explicit default coding workflow task",
      workflowId: "builtin:coding",
    });
    expect(task.column).toBe("triage");
  });

  it("does not throw and falls back to triage when workflowId is explicitly null (\"No workflow\")", async () => {
    const store = harness.store();
    await store.setDefaultWorkflowId("builtin:coding-ideas");
    const task = await store.createTask({
      description: "explicit no-workflow task",
      workflowId: null,
    });
    expect(task.column).toBe("triage");
  });

  it("writes a bootstrap PROMPT.md for an ideas-column task (unplanned)", async () => {
    const store = harness.store();
    const task: Task = await store.createTask({
      description: "ideas bootstrap prompt task",
      workflowId: "builtin:coding-ideas",
    });
    const prompt = await readFile(
      join(harness.rootDir(), ".fusion", "tasks", task.id, "PROMPT.md"),
      "utf-8",
    );
    expect(prompt).toBe(`# ${task.id}\n\n${task.description}\n`);
  });

  it("keeps generateSpecifiedPrompt for a direct create into todo (not bootstrap)", async () => {
    const store = harness.store();
    const task = await store.createTask({ description: "direct todo create", column: "todo" });
    expect(task.column).toBe("todo");
    const prompt = await readFile(
      join(harness.rootDir(), ".fusion", "tasks", task.id, "PROMPT.md"),
      "utf-8",
    );
    // A direct todo create is NOT an intake column, so it must NOT get the bootstrap stub.
    expect(prompt).not.toBe(`# ${task.id}\n\n${task.description}\n`);
  });
});
