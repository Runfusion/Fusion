import { describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createWorkflowAuthoringTools,
  createWorkflowListTool,
  createWorkflowGetTool,
  createWorkflowValidateTool,
  createWorkflowSelectTool,
  createWorkflowCreateTool,
  createWorkflowUpdateTool,
  createWorkflowDeleteTool,
} from "../index.js";
import { createWorkflowSettingsTool } from "../agent-tools.js";
import { parseWorkflowIr, TaskStore } from "@fusion/core";

/**
 * U11 / R12 drift guard (engine half): the workflow-authoring tool surface that
 * chat, planning, and the task executor all share must always expose workflow
 * discovery, mutation, settings, selection, and trait vocabulary tools.
 * The lanes assemble most of their toolset from `createWorkflowAuthoringTools`
 * (chat/planning) and the executor mirrors the same factories — so asserting
 * factory completeness here guards every lane's source of truth. Lane-wiring
 * (that chat/planning actually pass these to createFnAgent) is asserted in
 * packages/dashboard's exposure test.
 *
 * We invoke the REAL factories with a fake store — never mock the factories
 * themselves — so a renamed/removed tool name is caught.
 */

const REQUIRED_WORKFLOW_TOOLS = [
  "fn_workflow_list",
  "fn_workflow_get",
  "fn_workflow_validate",
  "fn_workflow_select",
  "fn_workflow_create",
  "fn_workflow_update",
  "fn_workflow_delete",
  "fn_workflow_settings",
  "fn_trait_list",
] as const;

// Minimal stand-in; the factories only capture the store reference at build
// time, so no methods are exercised by name-membership assertions.
const fakeStore = {} as unknown as TaskStore;

describe("workflow tool exposure (engine factories)", () => {
  it("createWorkflowAuthoringTools exposes the complete workflow authoring surface", () => {
    const names = createWorkflowAuthoringTools(fakeStore, "FN-1").map((t) => t.name);
    expect(names).toEqual(REQUIRED_WORKFLOW_TOOLS);
  });

  it("each fn_workflow_* factory produces a tool with the expected name", () => {
    expect(createWorkflowListTool(fakeStore).name).toBe("fn_workflow_list");
    expect(createWorkflowGetTool(fakeStore).name).toBe("fn_workflow_get");
    expect(createWorkflowValidateTool(fakeStore).name).toBe("fn_workflow_validate");
    expect(createWorkflowSelectTool(fakeStore, "FN-1").name).toBe("fn_workflow_select");
    expect(createWorkflowCreateTool(fakeStore).name).toBe("fn_workflow_create");
    expect(createWorkflowUpdateTool(fakeStore).name).toBe("fn_workflow_update");
    expect(createWorkflowDeleteTool(fakeStore).name).toBe("fn_workflow_delete");
    expect(createWorkflowSettingsTool(fakeStore).name).toBe("fn_workflow_settings");
  });
});

/**
 * P0 security: the chat/planning lanes pass {stripApprovalFlags:true} so the
 * create/update tools cannot persist a CLI-approval-bypass smuggled through a
 * prompt-injectable agent lane. The executor lane omits the option (project-
 * owner escape hatch) and the flags pass through unchanged.
 */
describe("fn_workflow_validate dry-run", () => {
  const run = (tool: { execute: (...a: any[]) => Promise<any> }, params: unknown) =>
    tool.execute("call-1", params, undefined, undefined, undefined) as Promise<{
      isError?: boolean; details: any; content: { type: string; text?: string }[];
    }>;

  const validIr = () => ({
    version: "v1" as const,
    name: "Valid",
    nodes: [
      { id: "start", kind: "start" },
      { id: "end", kind: "end" },
    ],
    edges: [{ from: "start", to: "end", condition: "success" as const }],
  });

  async function withStore<T>(fn: (store: TaskStore) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), "workflow-validate-tool-"));
    const store = new TaskStore(dir);
    await store.init();
    try {
      return await fn(store);
    } finally {
      await store.close?.().catch(() => {});
      await rm(dir, { recursive: true, force: true });
    }
  }

  it("returns valid true for a valid IR and creates no workflow row", async () => {
    await withStore(async (store) => {
      const before = await store.listWorkflowDefinitions();
      const res = await run(createWorkflowValidateTool(store), { ir: validIr() });
      const after = await store.listWorkflowDefinitions();
      expect(res.isError).toBeFalsy();
      expect(res.details).toEqual({ valid: true });
      expect(after).toHaveLength(before.length);
    });
  });

  it("returns valid false with the same WorkflowIrError message create parsing would throw", async () => {
    await withStore(async (store) => {
      const malformed = { ...validIr(), nodes: [{ id: "start", kind: "start" }, { id: "start2", kind: "start" }, { id: "end", kind: "end" }] };
      let expected = "";
      try { parseWorkflowIr(malformed); } catch (err) { expected = err instanceof Error ? err.message : String(err); }
      const res = await run(createWorkflowValidateTool(store), { ir: malformed });
      expect(res.isError).toBeFalsy();
      expect(res.details.valid).toBe(false);
      expect(res.details.errors[0]).toMatchObject({ type: "workflow-ir", message: expected });
    });
  });

  it("treats missing input and unknown workflow ids as tool errors", async () => {
    await withStore(async (store) => {
      const tool = createWorkflowValidateTool(store);
      expect((await run(tool, {})).isError).toBe(true);
      const missing = await run(tool, { workflow_id: "WF-NOPE" });
      expect(missing.isError).toBe(true);
      expect(missing.content[0].text).toContain("not found");
    });
  });
});

describe("workflow authoring tools approval-flag stripping", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function captureStore(): { store: TaskStore; captured: { ir?: any } } {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const captured: { ir?: any } = {};
    const store = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createWorkflowDefinition: async (input: any) => {
        captured.ir = input.ir;
        return { id: "wf-1", name: input.name };
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      updateWorkflowDefinition: async (_id: string, input: any) => {
        captured.ir = input.ir;
        return { id: "wf-1", name: input.name ?? "wf" };
      },
    } as unknown as TaskStore;
    return { store, captured };
  }

  // The ToolDefinition.execute signature requires (id, params, signal, onUpdate,
  // ctx); tests only need id+params, so pass undefined for the rest and cast the
  // result to read the optional `isError`/`content` shape these tools return.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const run = (tool: { execute: (...a: any[]) => Promise<any> }, params: unknown) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tool.execute("call-1", params, undefined, undefined, undefined) as Promise<{
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      isError?: boolean; content: { type: string; text?: string }[];
    }>;

  const irWithFlags = () => ({
    version: "v1" as const,
    name: "wf",
    nodes: [
      { id: "n1", kind: "prompt", config: { cliSkipApproval: true, name: "x" } },
      {
        id: "fe",
        kind: "foreach",
        config: {
          template: {
            nodes: [
              { id: "inner", kind: "step-execute", config: { autoApprove: true } },
            ],
            edges: [],
          },
        },
      },
    ],
    edges: [],
  });

  it("strips both flags (incl. foreach template) on create with stripApprovalFlags:true", async () => {
    const { store, captured } = captureStore();
    const tool = createWorkflowCreateTool(store, { stripApprovalFlags: true });
    const res = await run(tool, { name: "wf", ir: irWithFlags() });
    expect(res.isError).toBeFalsy();
    expect(captured.ir.nodes[0].config.cliSkipApproval).toBeUndefined();
    expect(captured.ir.nodes[1].config.template.nodes[0].config.autoApprove).toBeUndefined();
    const text = res.content.map((c) => c.text ?? "").join("");
    expect(text).toContain("approval-bypass flags removed");
  });

  it("strips flags on update with stripApprovalFlags:true", async () => {
    const { store, captured } = captureStore();
    const tool = createWorkflowUpdateTool(store, { stripApprovalFlags: true });
    const res = await run(tool, { workflow_id: "wf-1", ir: irWithFlags() });
    expect(res.isError).toBeFalsy();
    expect(captured.ir.nodes[0].config.cliSkipApproval).toBeUndefined();
    expect(captured.ir.nodes[1].config.template.nodes[0].config.autoApprove).toBeUndefined();
  });

  it("executor lane (no option) passes both flags through unchanged", async () => {
    const { store, captured } = captureStore();
    const tool = createWorkflowCreateTool(store);
    const res = await run(tool, { name: "wf", ir: irWithFlags() });
    expect(res.isError).toBeFalsy();
    expect(captured.ir.nodes[0].config.cliSkipApproval).toBe(true);
    expect(captured.ir.nodes[1].config.template.nodes[0].config.autoApprove).toBe(true);
    const text = res.content.map((c) => c.text ?? "").join("");
    expect(text).not.toContain("approval-bypass flags removed");
  });
});
