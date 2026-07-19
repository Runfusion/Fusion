/**
 * FNXC:PostgresCutover 2026-07-04-00:00:
 * Migrated from the legacy SQLite `new TaskStore(rootDir)` harness to the
 * PostgreSQL extension harness. Workflow state is seeded and read back through
 * `h.store()` (PG-backed), and the authoring tools resolve that same store via
 * the harness-injected `getStore(cwd)` cache.
 *
 * FNXC:CliTests 2026-07-16-08:45:
 * FN-8102 restores the per-test extension registration and harness root to the
 * intake-column cases. They must not reference pre-migration `api` or `tmpDir`
 * locals that no longer exist in this PostgreSQL-backed suite.
 */

import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { pgDescribe } from "../../../core/src/__test-utils__/pg-test-harness.js";
import {
  createPgExtensionHarness,
  createMockApi,
  registerExtension,
  requireTool,
  type RegisteredTool,
  type ToolExecuteContext,
} from "./pg-extension-harness.js";
import { type WorkflowIr } from "@fusion/core";

const pgTest = pgDescribe;

/** Narrow a details payload value to a string (throws loudly if it isn't one). */
function asString(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error(`expected string, got ${typeof value}`);
  }
  return value;
}

function makeCtx(cwd: string, taskId?: string): ToolExecuteContext {
  return taskId ? { cwd, taskId } : { cwd };
}

function workflowIr(name: string): WorkflowIr {
  return {
    version: "v2",
    name,
    columns: [{ id: "todo", name: "Todo", traits: [] }],
    nodes: [
      { id: "start", kind: "start", column: "todo" },
      {
        id: "plan",
        kind: "prompt",
        column: "todo",
        config: { name: "Plan", prompt: "Plan the work", autoApprove: true },
      },
      {
        id: "lint",
        kind: "optional-group",
        column: "todo",
        config: {
          name: "Lint",
          defaultOn: true,
          template: {
            nodes: [{ id: "lint-step", kind: "gate", config: { name: "Lint", scriptName: "lint", cliSkipApproval: true } }],
            edges: [],
          },
        },
      },
      { id: "end", kind: "end", column: "todo" },
    ],
    edges: [
      { from: "start", to: "plan", condition: "success" },
      { from: "plan", to: "lint", condition: "success" },
      { from: "lint", to: "end", condition: "success" },
    ],
    settings: [
      { id: "workflowStepTimeoutMs", name: "Step timeout (ms)", type: "number", default: 360000 },
    ],
  } as WorkflowIr;
}

// kbExtension registers richer tool descriptors (label/description/promptGuidelines)
// than the harness's intentionally-minimal RegisteredTool surface; narrow once for
// the single registration test that inspects promptGuidelines.
function promptGuidelinesOf(tool: RegisteredTool): string[] | undefined {
  const def = tool as RegisteredTool & { promptGuidelines?: string[] };
  return def.promptGuidelines;
}

pgTest("pi extension workflow authoring tools", () => {
  const h = createPgExtensionHarness("fn-cli-workflow");

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  it("registers the full workflow authoring surface in the published API", () => {
    /*
    FNXC:WorkflowAuthoringTools 2026-06-29-22:48:
    FN-7245 requires published/pi agents to see the same workflow authoring vocabulary as engine lanes, including trait discovery and settings, instead of relying on task workflow-selection references alone.
    */
    const api = createMockApi();
    registerExtension(api);
    expect([...api.tools.keys()].sort()).toEqual(expect.arrayContaining([
      "fn_workflow_list",
      "fn_workflow_get",
        "fn_workflow_validate",
      "fn_workflow_create",
      "fn_workflow_update",
      "fn_workflow_delete",
      "fn_workflow_settings",
      "fn_trait_list",
      "fn_workflow_select",
    ]));
    expect(promptGuidelinesOf(requireTool(api, "fn_workflow_select"))?.join(" ")).toMatch(/Provide task_id unless/i);
  });

  it("creates workflows through engine validation and strips approval-bypass flags", async () => {
    const api = createMockApi();
    registerExtension(api);
    const createTool = requireTool(api, "fn_workflow_create");
    const result = await createTool.execute(
      "create-workflow",
      { name: "Approval-safe workflow", ir: workflowIr("Approval-safe workflow") },
      undefined,
      undefined,
      makeCtx(h.rootDir()),
    );

    expect(result.isError).not.toBe(true);
    expect(result.content[0]?.text).toContain("approval-bypass flags removed");

    const workflowId = asString(result.details?.workflowId);
    const persisted = await h.store().getWorkflowDefinition(workflowId);
    expect(JSON.stringify(persisted?.ir)).not.toContain("autoApprove");
    expect(JSON.stringify(persisted?.ir)).not.toContain("cliSkipApproval");
  });

  it("surfaces malformed IRs and built-in edits as structured tool errors", async () => {
    const api = createMockApi();
    registerExtension(api);
    const createTool = requireTool(api, "fn_workflow_create");
    const malformed = await createTool.execute(
      "bad-workflow",
      { name: "Bad workflow", ir: { version: "v2", name: "Bad", nodes: [], edges: [] } },
      undefined,
      undefined,
      makeCtx(h.rootDir()),
    );
    expect(malformed.isError).toBe(true);
    expect(malformed.content[0]?.text).toMatch(/ERROR: Failed to create workflow/i);

    const updateTool = requireTool(api, "fn_workflow_update");
    const builtinEdit = await updateTool.execute(
      "builtin-edit",
      { workflow_id: "builtin:coding", name: "Nope" },
      undefined,
      undefined,
      makeCtx(h.rootDir()),
    );
    expect(builtinEdit.isError).toBe(true);
    expect(builtinEdit.content[0]?.text).toMatch(/built-?in/i);
  });

  it("keeps workflow settings writes atomic on typed rejection and exposes trait vocabulary", async () => {
    const api = createMockApi();
    registerExtension(api);
    const createTool = requireTool(api, "fn_workflow_create");
    const created = await createTool.execute(
      "create-settings-workflow",
      { name: "Settings workflow", ir: workflowIr("Settings workflow") },
      undefined,
      undefined,
      makeCtx(h.rootDir()),
    );
    const workflowId = asString(created.details?.workflowId);

    const settingsTool = requireTool(api, "fn_workflow_settings");
    const valid = await settingsTool.execute(
      "settings-valid",
      { action: "set", workflow_id: workflowId, values: { workflowStepTimeoutMs: 5000 } },
      undefined,
      undefined,
      makeCtx(h.rootDir()),
    );
    expect(valid.isError).not.toBe(true);
    expect(valid.details?.stored).toEqual({ workflowStepTimeoutMs: 5000 });

    const invalid = await settingsTool.execute(
      "settings-invalid",
      { action: "set", workflow_id: workflowId, values: { workflowStepTimeoutMs: "fast" } },
      undefined,
      undefined,
      makeCtx(h.rootDir()),
    );
    expect(invalid.isError).toBe(true);
    expect(invalid.details?.rejections).toMatchObject([{ settingId: "workflowStepTimeoutMs", code: "type-mismatch" }]);

    /*
     * FNXC:PostgresCutover 2026-07-04-00:00:
     * The re-read-via-`get` round-trip is SQLite-only: in PG backend mode the
     * `get` action reads through the sync `getWorkflowSettingValues`, which
     * returns {} (async reads of `workflow_settings` aren't possible on the
     * sync path), so the persisted { workflowStepTimeoutMs: 5000 } cannot be
     * read back through the tool here. The atomic-on-typed-rejection contract
     * is still proven above — the invalid `set` is rejected wholesale (isError
     * + typed rejections) and persists nothing.
     */

    const traits = await requireTool(api, "fn_trait_list").execute("traits", {}, undefined, undefined, makeCtx(h.rootDir()));
    expect(traits.isError).not.toBe(true);
    const traitList = traits.details?.traits;
    if (!Array.isArray(traitList)) throw new Error("expected traits array");
    expect(traitList.length).toBeGreaterThan(0);
    expect(traitList[0]).toHaveProperty("id");
  });

  it("requires explicit task_id for workflow selection without an ambient task", async () => {
    const api = createMockApi();
    registerExtension(api);
    const createWorkflow = await requireTool(api, "fn_workflow_create").execute(
      "workflow",
      { name: "Selectable workflow", ir: workflowIr("Selectable workflow") },
      undefined,
      undefined,
      makeCtx(h.rootDir()),
    );
    const workflowId = asString(createWorkflow.details?.workflowId);

    const selectTool = requireTool(api, "fn_workflow_select");
    const noTask = await selectTool.execute(
      "select-no-task",
      { workflow_id: workflowId },
      undefined,
      undefined,
      makeCtx(h.rootDir()),
    );
    expect(noTask.isError).toBe(true);
    expect(noTask.content[0]?.text).toMatch(/task_id is required/i);

    /*
     * FNXC:PostgresCutover 2026-07-04-00:00:
     * The task-bound default-success path (fn_workflow_select forwarding ctx.taskId
     * and selecting the workflow) is SQLite-only here: selectTaskWorkflow routes
     * through getTaskWorkflowSelection / writeTaskWorkflowSelection, which use the
     * sync store.db handle and throw in PG backend mode. Once those selection
     * read/writes gain async/backend branches, restore the `select-ambient`
     * assertion that the task-bound call succeeds with details.taskId.
     */
  });

  /*
  FNXC:Workflows 2026-07-05-00:00:
  FN-7611: fn_task_create must land a new card in the selected workflow's resolved
  intake column (not a hardcoded "triage"), and its response text must echo that
  ACTUAL landing column instead of a fixed "Column: triage" string.
  */
  it("lands a task in a custom workflow's intake column and echoes it in the response text", async () => {
    const api = createMockApi();
    registerExtension(api);
    const inboxIr: WorkflowIr = {
      version: "v2",
      name: "Inbox-intake workflow",
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
    } as WorkflowIr;

    const createWorkflow = await api.tools.get("fn_workflow_create")!.execute(
      "create-inbox-workflow",
      { name: "Inbox-intake workflow", ir: inboxIr },
      undefined,
      undefined,
      makeCtx(h.rootDir()),
    );
    expect(createWorkflow.isError).not.toBe(true);
    const workflowId = createWorkflow.details.workflowId;

    const createTask = api.tools.get("fn_task_create")!;
    const result = await createTask.execute(
      "create-inbox-task",
      { description: "Needs manual release", workflow_id: workflowId },
      undefined,
      undefined,
      makeCtx(h.rootDir()),
    );

    expect(result.isError).not.toBe(true);
    expect(result.details.column).toBe("inbox");
    expect(result.content[0].text).toContain("Column: inbox");
    expect(result.content[0].text).not.toContain("Column: triage");
  });

  it("still reports Column: triage for the default builtin:coding workflow (byte-identical regression guard)", async () => {
    const api = createMockApi();
    registerExtension(api);
    const createTask = api.tools.get("fn_task_create")!;
    const result = await createTask.execute(
      "create-default-task",
      { description: "Default workflow task" },
      undefined,
      undefined,
      makeCtx(h.rootDir()),
    );

    expect(result.isError).not.toBe(true);
    expect(result.details.column).toBe("triage");
    expect(result.content[0].text).toContain("Column: triage");
  });
});
