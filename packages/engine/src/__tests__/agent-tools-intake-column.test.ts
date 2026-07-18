import { afterEach, beforeEach, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type TaskStore, type WorkflowIr } from "@fusion/core";
import { createTaskStoreForTest, pgDescribe, type PgTestHarness } from "../../../core/src/__test-utils__/pg-test-harness.js";
import { createTaskCreateTool } from "../agent-tools.js";

/*
FNXC:Workflows 2026-07-05-00:00:
FN-7611 regression suite: fn_task_create (createTaskCreateTool) must NOT override the
store's intake-column resolution with a hardcoded "triage". A custom workflow with a
non-triage `intake`-trait column (e.g. "Inbox") must capture new cards there, inert
(bootstrap-stub PROMPT.md, no Planner spec generation), while the default builtin:coding
workflow keeps landing cards in "triage" byte-identically.
*/
/* FNXC:PgMigrationQuarantine 2026-07-17-18:15: FN-8258 keeps intake-column behavior on a real PostgreSQL-backed TaskStore, replacing removed SQLite inMemoryDb setup. */
pgDescribe("createTaskCreateTool intake-column wiring", () => {
  let harness: PgTestHarness;
  let store: TaskStore;

  beforeEach(async () => {
    harness = await createTaskStoreForTest({ prefix: "fusion_agent_tools_intake" });
    store = harness.store;
  });

  afterEach(async () => {
    await harness?.teardown();
  });

  function inboxWorkflowIr(name: string): WorkflowIr {
    return {
      version: "v2",
      name,
      columns: [
        { id: "inbox", name: "Inbox", traits: [{ trait: "intake" }] },
        { id: "todo", name: "Todo", traits: [] },
      ],
      nodes: [
        { id: "start", kind: "start", column: "inbox" },
        {
          id: "plan",
          kind: "prompt",
          column: "todo",
          config: { name: "Plan", prompt: "Plan the work", autoApprove: true },
        },
        { id: "end", kind: "end", column: "todo" },
      ],
      edges: [
        { from: "start", to: "plan", condition: "success" },
        { from: "plan", to: "end", condition: "success" },
      ],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
  }

  it("lands a task in the custom workflow's Inbox intake column when selected explicitly via fn_task_create", async () => {
    const created = await store.createWorkflowDefinition({
      name: "Inbox-intake workflow",
      ir: inboxWorkflowIr("Inbox-intake workflow"),
    });

    const tool = createTaskCreateTool(store);
    const result = await tool.execute(
      "call-1",
      { description: "Needs manual release", workflow_id: created.id } as never,
      undefined,
      undefined,
      {} as never,
    );

    expect((result as { isError?: boolean }).isError).toBeFalsy();
    const task = await store.getTask((result.details as { taskId: string }).taskId);
    expect(task.column).toBe("inbox");
  });

  it("keeps a task with no workflow_id landing in triage (byte-identical default)", async () => {
    const tool = createTaskCreateTool(store);
    const result = await tool.execute(
      "call-2",
      { description: "Default workflow task" } as never,
      undefined,
      undefined,
      {} as never,
    );

    expect((result as { isError?: boolean }).isError).toBeFalsy();
    const task = await store.getTask((result.details as { taskId: string }).taskId);
    expect(task.column).toBe("triage");
  });

  it("lands a task explicitly selecting builtin:coding in triage even when the project default is the custom intake workflow", async () => {
    const created = await store.createWorkflowDefinition({
      name: "Inbox-intake workflow 2",
      ir: inboxWorkflowIr("Inbox-intake workflow 2"),
    });
    await store.setDefaultWorkflowId(created.id);

    const tool = createTaskCreateTool(store);
    const result = await tool.execute(
      "call-3",
      { description: "Explicit default coding workflow task", workflow_id: "builtin:coding" } as never,
      undefined,
      undefined,
      {} as never,
    );

    expect((result as { isError?: boolean }).isError).toBeFalsy();
    const task = await store.getTask((result.details as { taskId: string }).taskId);
    expect(task.column).toBe("triage");
  });

  it("writes a bootstrap PROMPT.md (unplanned) for the inbox-landed task, matching the store's intake gate", async () => {
    const created = await store.createWorkflowDefinition({
      name: "Inbox-intake workflow 3",
      ir: inboxWorkflowIr("Inbox-intake workflow 3"),
    });

    const tool = createTaskCreateTool(store);
    const result = await tool.execute(
      "call-4",
      { description: "Inbox bootstrap prompt task", workflow_id: created.id } as never,
      undefined,
      undefined,
      {} as never,
    );

    expect((result as { isError?: boolean }).isError).toBeFalsy();
    const taskId = (result.details as { taskId: string }).taskId;
    const prompt = await readFile(join(harness.rootDir, ".fusion", "tasks", taskId, "PROMPT.md"), "utf-8");
    expect(prompt).toBe(`# ${taskId}\n\nInbox bootstrap prompt task\n`);
  });
});
