import { describe, it, expect, vi } from "vitest";
import { getBuiltinWorkflow } from "../workflows/builtin-workflows.js";
import { BUILTIN_STEPWISE_FINAL_REVIEW_CODING_WORKFLOW_IR } from "../workflows/builtin-stepwise-final-review-coding-workflow-ir.js";
import type { WorkflowIr } from "../workflows/workflow-ir-types.js";
import {
  resolveWorkflowIrForTask,
  resolveWorkflowIrById,
} from "../workflows/workflow-ir-resolver.js";

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
  projectId?: string;
  projectIdThrows?: boolean;
  promptOverrides?: Record<string, string>;
} = {}) {
  const getWorkflowDefinition = vi.fn(async (id: string) => opts.defs?.[id]);
  const getTaskWorkflowSelection = vi.fn((_taskId: string) => {
    if (opts.selectionThrows) throw new Error("boom");
    return opts.selection;
  });
  const getWorkflowSettingsProjectId = vi.fn(() => {
    if (opts.projectIdThrows) throw new Error("identity boom");
    return opts.projectId ?? "proj-1";
  });
  const getWorkflowPromptOverrides = vi.fn(
    (_workflowId: string, _projectId: string) => opts.promptOverrides ?? {},
  );
  return {
    getWorkflowDefinition,
    getTaskWorkflowSelection,
    getWorkflowSettingsProjectId,
    getWorkflowPromptOverrides,
  };
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
    expect(ir).toBe(BUILTIN_STEPWISE_FINAL_REVIEW_CODING_WORKFLOW_IR);
  });

  it("falls back to the default when there is no selection", async () => {
    const store = makeStore({ selection: undefined });
    const ir = await resolveWorkflowIrForTask(store, "t1");
    expect(ir).toBe(BUILTIN_STEPWISE_FINAL_REVIEW_CODING_WORKFLOW_IR);
    expect(store.getWorkflowDefinition).not.toHaveBeenCalled();
  });

  it("degrades to the default when the selection lookup throws", async () => {
    const store = makeStore({ selectionThrows: true });
    const ir = await resolveWorkflowIrForTask(store, "t1");
    expect(ir).toBe(BUILTIN_STEPWISE_FINAL_REVIEW_CODING_WORKFLOW_IR);
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
  it("resolves builtin:coding to the catalog default stepwise final-review IR", async () => {
    const store = makeStore({});
    const ir = await resolveWorkflowIrById(store, "builtin:coding");

    expect(ir).toBe(BUILTIN_STEPWISE_FINAL_REVIEW_CODING_WORKFLOW_IR);
    expect(ir).toBe(getBuiltinWorkflow("builtin:coding")!.ir);
    expect(ir.version).toBe("v2");
    if (ir.version !== "v2") throw new Error("expected v2");
    const inReview = ir.columns.find((column) => column.id === "in-review");
    expect(inReview).toBeDefined();
    expect(inReview!.traits.length).toBeGreaterThan(0);
    expect(inReview!.traits).toEqual(
      expect.arrayContaining([{ trait: "merge-blocker" }, { trait: "human-review" }]),
    );
  });

  it("resolves an explicit builtin:coding task selection through the canonical IR path", async () => {
    const store = makeStore({ selection: { workflowId: "builtin:coding", stepIds: [] } });
    const ir = await resolveWorkflowIrForTask(store, "t1");
    expect(ir).toBe(BUILTIN_STEPWISE_FINAL_REVIEW_CODING_WORKFLOW_IR);
    expect(store.getWorkflowDefinition).not.toHaveBeenCalled();
  });

  it("falls back to the canonical IR for an unknown built-in id", async () => {
    const store = makeStore({});
    const ir = await resolveWorkflowIrById(store, "builtin:missing");
    expect(ir).toBe(BUILTIN_STEPWISE_FINAL_REVIEW_CODING_WORKFLOW_IR);
    expect(store.getWorkflowDefinition).not.toHaveBeenCalled();
  });

  it("degrades built-in IR resolution when project identity lookup throws", async () => {
    const store = makeStore({
      projectIdThrows: true,
      promptOverrides: { planning: "unreachable project override" },
    });

    const ir = await resolveWorkflowIrById(store, "builtin:coding");

    expect(ir).toBe(BUILTIN_STEPWISE_FINAL_REVIEW_CODING_WORKFLOW_IR);
    expect(store.getWorkflowSettingsProjectId).toHaveBeenCalledTimes(1);
    expect(store.getWorkflowPromptOverrides).not.toHaveBeenCalled();
    expect(store.getWorkflowDefinition).not.toHaveBeenCalled();
  });

  it("uses a workflow-only cache key when project identity lookup throws", async () => {
    const store = makeStore({ projectIdThrows: true, defs: { "wf-custom": { ir: CUSTOM_IR } } });
    const cache = new Map<string, WorkflowIr>([["wf-custom", CUSTOM_IR]]);

    const ir = await resolveWorkflowIrById(store, "wf-custom", cache);

    expect(ir).toBe(CUSTOM_IR);
    expect(store.getWorkflowSettingsProjectId).toHaveBeenCalledTimes(1);
    expect(store.getWorkflowDefinition).not.toHaveBeenCalled();
  });

  it("keeps project-scoped prompt overrides and cache keys when project identity resolves", async () => {
    const store = makeStore({
      projectId: "proj-override",
      promptOverrides: { plan: "Project-specific plan" },
    });
    const cache = new Map<string, WorkflowIr>();

    const first = await resolveWorkflowIrById(store, "builtin:coding", cache);
    const second = await resolveWorkflowIrById(store, "builtin:coding", cache);

    expect(first).toBe(second);
    expect(first).not.toBe(BUILTIN_STEPWISE_FINAL_REVIEW_CODING_WORKFLOW_IR);
    expect(first.nodes.find((node) => node.id === "plan")?.config?.prompt).toBe("Project-specific plan");
    expect(cache.get("builtin:coding\u0000proj-override")).toBe(first);
    expect(store.getWorkflowPromptOverrides).toHaveBeenCalledTimes(1);
  });

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
