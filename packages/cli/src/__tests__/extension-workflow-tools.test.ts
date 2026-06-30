import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import kbExtension, { closeCachedStores } from "../extension.js";
import { TaskStore, type WorkflowIr } from "@fusion/core";

interface RegisteredTool {
  name: string;
  label: string;
  description: string;
  promptGuidelines?: string[];
  execute: (
    toolCallId: string,
    params: any,
    signal: AbortSignal | undefined,
    onUpdate: ((update: any) => void) | undefined,
    ctx: any,
  ) => Promise<any>;
}

function createMockAPI() {
  const tools = new Map<string, RegisteredTool>();
  return {
    registerTool(def: RegisteredTool) {
      tools.set(def.name, def);
    },
    registerCommand() {},
    registerShortcut() {},
    registerFlag() {},
    on() {},
    tools,
  } as any;
}

function makeCtx(cwd: string, taskId?: string) {
  return { cwd, ...(taskId ? { taskId } : {}) } as any;
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

async function readWorkflow(cwd: string, workflowId: string): Promise<any> {
  const store = new TaskStore(cwd);
  await store.init();
  try {
    return await store.getWorkflowDefinition(workflowId);
  } finally {
    await store.close();
  }
}

describe("pi extension workflow authoring tools", () => {
  let tmpDir: string;
  let api: ReturnType<typeof createMockAPI>;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "fn-7245-cli-workflow-"));
    await mkdir(join(tmpDir, ".fusion"), { recursive: true });
    api = createMockAPI();
    kbExtension(api);
  });

  afterEach(async () => {
    await closeCachedStores();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("registers the full workflow authoring surface in the published API", () => {
    /*
    FNXC:WorkflowAuthoringTools 2026-06-29-22:48:
    FN-7245 requires published/pi agents to see the same workflow authoring vocabulary as engine lanes, including trait discovery and settings, instead of relying on task workflow-selection references alone.
    */
    expect([...api.tools.keys()].sort()).toEqual(expect.arrayContaining([
      "fn_workflow_list",
      "fn_workflow_get",
      "fn_workflow_create",
      "fn_workflow_update",
      "fn_workflow_delete",
      "fn_workflow_settings",
      "fn_trait_list",
      "fn_workflow_select",
    ]));
    expect(api.tools.get("fn_workflow_select")?.promptGuidelines?.join(" ")).toMatch(/Provide task_id unless/i);
  });

  it("creates workflows through engine validation and strips approval-bypass flags", async () => {
    const createTool = api.tools.get("fn_workflow_create")!;
    const result = await createTool.execute(
      "create-workflow",
      { name: "Approval-safe workflow", ir: workflowIr("Approval-safe workflow") },
      undefined,
      undefined,
      makeCtx(tmpDir),
    );

    expect(result.isError).not.toBe(true);
    expect(result.content[0].text).toContain("approval-bypass flags removed");

    const persisted = await readWorkflow(tmpDir, result.details.workflowId);
    expect(JSON.stringify(persisted.ir)).not.toContain("autoApprove");
    expect(JSON.stringify(persisted.ir)).not.toContain("cliSkipApproval");
  });

  it("surfaces malformed IRs and built-in edits as structured tool errors", async () => {
    const createTool = api.tools.get("fn_workflow_create")!;
    const malformed = await createTool.execute(
      "bad-workflow",
      { name: "Bad workflow", ir: { version: "v2", name: "Bad", nodes: [], edges: [] } },
      undefined,
      undefined,
      makeCtx(tmpDir),
    );
    expect(malformed.isError).toBe(true);
    expect(malformed.content[0].text).toMatch(/ERROR: Failed to create workflow/i);

    const updateTool = api.tools.get("fn_workflow_update")!;
    const builtinEdit = await updateTool.execute(
      "builtin-edit",
      { workflow_id: "builtin:coding", name: "Nope" },
      undefined,
      undefined,
      makeCtx(tmpDir),
    );
    expect(builtinEdit.isError).toBe(true);
    expect(builtinEdit.content[0].text).toMatch(/built-?in/i);
  });

  it("keeps workflow settings writes atomic on typed rejection and exposes trait vocabulary", async () => {
    const createTool = api.tools.get("fn_workflow_create")!;
    const created = await createTool.execute(
      "create-settings-workflow",
      { name: "Settings workflow", ir: workflowIr("Settings workflow") },
      undefined,
      undefined,
      makeCtx(tmpDir),
    );
    const workflowId = created.details.workflowId;

    const settingsTool = api.tools.get("fn_workflow_settings")!;
    const valid = await settingsTool.execute(
      "settings-valid",
      { action: "set", workflow_id: workflowId, values: { workflowStepTimeoutMs: 5000 } },
      undefined,
      undefined,
      makeCtx(tmpDir),
    );
    expect(valid.isError).not.toBe(true);
    expect(valid.details.stored).toEqual({ workflowStepTimeoutMs: 5000 });

    const invalid = await settingsTool.execute(
      "settings-invalid",
      { action: "set", workflow_id: workflowId, values: { workflowStepTimeoutMs: "fast" } },
      undefined,
      undefined,
      makeCtx(tmpDir),
    );
    expect(invalid.isError).toBe(true);
    expect(invalid.details.rejections[0]).toMatchObject({ settingId: "workflowStepTimeoutMs", code: "type-mismatch" });

    const afterInvalid = await settingsTool.execute(
      "settings-get",
      { action: "get", workflow_id: workflowId },
      undefined,
      undefined,
      makeCtx(tmpDir),
    );
    expect(afterInvalid.details.stored).toEqual({ workflowStepTimeoutMs: 5000 });

    const traits = await api.tools.get("fn_trait_list")!.execute("traits", {}, undefined, undefined, makeCtx(tmpDir));
    expect(traits.isError).not.toBe(true);
    expect(traits.details.traits.length).toBeGreaterThan(0);
    expect(traits.details.traits[0]).toHaveProperty("id");
  });

  it("requires explicit task_id for workflow selection without an ambient task but defaults when task-bound", async () => {
    const createTask = api.tools.get("fn_task_create")!;
    const task = await createTask.execute("task", { description: "Needs workflow" }, undefined, undefined, makeCtx(tmpDir));
    const createWorkflow = await api.tools.get("fn_workflow_create")!.execute(
      "workflow",
      { name: "Selectable workflow", ir: workflowIr("Selectable workflow") },
      undefined,
      undefined,
      makeCtx(tmpDir),
    );

    const selectTool = api.tools.get("fn_workflow_select")!;
    const noTask = await selectTool.execute(
      "select-no-task",
      { workflow_id: createWorkflow.details.workflowId },
      undefined,
      undefined,
      makeCtx(tmpDir),
    );
    expect(noTask.isError).toBe(true);
    expect(noTask.content[0].text).toMatch(/task_id is required/i);

    const ambient = await selectTool.execute(
      "select-ambient",
      { workflow_id: createWorkflow.details.workflowId },
      undefined,
      undefined,
      makeCtx(tmpDir, task.details.taskId),
    );
    expect(ambient.isError).not.toBe(true);
    expect(ambient.details.taskId).toBe(task.details.taskId);
  });
});
