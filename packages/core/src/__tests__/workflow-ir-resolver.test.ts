import { describe, it, expect, vi } from "vitest";
import { getBuiltinWorkflow } from "../builtin-workflows.js";
import { BUILTIN_CODING_WORKFLOW_IR } from "../builtin-coding-workflow-ir.js";
import type { WorkflowIr } from "../workflow-ir-types.js";
import {
  resolveWorkflowIrForTask,
  resolveWorkflowIrById,
} from "../workflow-ir-resolver.js";

/** A minimal custom IR distinguishable from the built-in default. */
const CUSTOM_IR: WorkflowIr = {
  version: "v2",
  name: "custom-flow",
  nodes: [
    { id: "start", kind: "start" },
    { id: "end", kind: "end" },
  ],
  edges: [{ from: "start", to: "end" }],
  columns: [{ id: "todo", name: "Todo", traits: [] }],
} as unknown as WorkflowIr;

function makeStore(opts: {
  selection?: { workflowId: string; stepIds: string[] };
  selectionThrows?: boolean;
  defs?: Record<string, { ir: string | WorkflowIr } | undefined>;
}) {
  const getWorkflowDefinition = vi.fn(async (id: string) => opts.defs?.[id]);
  const getTaskWorkflowSelection = vi.fn((_taskId: string) => {
    if (opts.selectionThrows) throw new Error("boom");
    return opts.selection;
  });
  return { getWorkflowDefinition, getTaskWorkflowSelection };
}

describe("resolveWorkflowIrForTask", () => {
  it("resolves a selection pointing at a custom definition", async () => {
    const store = makeStore({
      selection: { workflowId: "wf-custom", stepIds: [] },
      defs: { "wf-custom": { ir: CUSTOM_IR } },
    });
    const ir = await resolveWorkflowIrForTask(store, "t1");
    expect(ir).toBe(CUSTOM_IR);
    expect(store.getWorkflowDefinition).toHaveBeenCalledWith("wf-custom");
  });

  it("resolves a built-in workflow id without touching getWorkflowDefinition", async () => {
    const store = makeStore({
      selection: { workflowId: "builtin:quick-fix", stepIds: [] },
    });
    const ir = await resolveWorkflowIrForTask(store, "t1");
    expect(ir).toEqual(getBuiltinWorkflow("builtin:quick-fix")!.ir);
    expect(store.getWorkflowDefinition).not.toHaveBeenCalled();
  });

  it("falls back to the built-in default when the definition is missing", async () => {
    const store = makeStore({
      selection: { workflowId: "wf-gone", stepIds: [] },
      defs: { "wf-gone": undefined },
    });
    const ir = await resolveWorkflowIrForTask(store, "t1");
    expect(ir).toBe(BUILTIN_CODING_WORKFLOW_IR);
  });

  it("falls back to the default when there is no selection", async () => {
    const store = makeStore({ selection: undefined });
    const ir = await resolveWorkflowIrForTask(store, "t1");
    expect(ir).toBe(BUILTIN_CODING_WORKFLOW_IR);
    expect(store.getWorkflowDefinition).not.toHaveBeenCalled();
  });

  it("degrades to the default when the selection lookup throws", async () => {
    const store = makeStore({ selectionThrows: true });
    const ir = await resolveWorkflowIrForTask(store, "t1");
    expect(ir).toBe(BUILTIN_CODING_WORKFLOW_IR);
  });

  it("caches by workflowId so the definition is fetched once across calls", async () => {
    const store = makeStore({
      selection: { workflowId: "wf-custom", stepIds: [] },
      defs: { "wf-custom": { ir: CUSTOM_IR } },
    });
    const cache = new Map<string, WorkflowIr>();
    const a = await resolveWorkflowIrForTask(store, "t1", cache);
    const b = await resolveWorkflowIrForTask(store, "t2", cache);
    expect(a).toBe(CUSTOM_IR);
    expect(b).toBe(CUSTOM_IR);
    expect(store.getWorkflowDefinition).toHaveBeenCalledTimes(1);
  });
});

describe("resolveWorkflowIrById", () => {
  it("parses a raw-string IR from the definition", async () => {
    const raw = JSON.stringify(CUSTOM_IR);
    const store = makeStore({ defs: { "wf-raw": { ir: raw } } });
    const ir = await resolveWorkflowIrById(store, "wf-raw");
    expect(ir.version).toBe("v2");
    expect(ir.name).toBe("custom-flow");
  });

  it("returns a cache hit without re-fetching the definition", async () => {
    const store = makeStore({ defs: { "wf-custom": { ir: CUSTOM_IR } } });
    const cache = new Map<string, WorkflowIr>();
    await resolveWorkflowIrById(store, "wf-custom", cache);
    await resolveWorkflowIrById(store, "wf-custom", cache);
    expect(store.getWorkflowDefinition).toHaveBeenCalledTimes(1);
  });
});
