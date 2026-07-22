import type { WorkflowIr, WorkflowIrNode } from "./workflow-ir-types.js";

export type WorkflowPromptOverrides = Record<string, string>;

export interface WorkflowPromptDefault {
  nodeId: string;
  kind: "prompt" | "gate";
  prompt: string;
}

function normalizePromptOverride(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.trim().length > 0 ? value : undefined;
}

export function normalizeWorkflowPromptOverrides(overrides: Record<string, unknown> | undefined): WorkflowPromptOverrides {
  const normalized: WorkflowPromptOverrides = {};
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) return normalized;
  for (const [nodeId, value] of Object.entries(overrides)) {
    const prompt = normalizePromptOverride(value);
    if (prompt !== undefined) normalized[nodeId] = prompt;
  }
  return normalized;
}

export function isPromptBearingWorkflowNode(node: WorkflowIrNode): node is WorkflowIrNode & { kind: "prompt" | "gate" } {
  return node.kind === "prompt" || node.kind === "gate";
}

export function enumeratePromptBearingWorkflowNodes(ir: WorkflowIr): WorkflowPromptDefault[] {
  const defaults: WorkflowPromptDefault[] = [];
  for (const node of ir.nodes) {
    if (!isPromptBearingWorkflowNode(node)) continue;
    const prompt = node.config?.prompt;
    if (typeof prompt !== "string") continue;
    defaults.push({ nodeId: node.id, kind: node.kind, prompt });
  }
  return defaults;
}

/**
 * FNXC:CustomWorkflows 2026-06-21-19:10:
 * Built-in prompt overrides must overlay effective IRs without mutating shipped built-in objects. Return the original IR when no non-empty override targets a prompt/gate node; otherwise clone only the graph shell and changed node/config records.
 */
export function applyPromptOverridesToIr(ir: WorkflowIr, overrides: Record<string, unknown> | undefined): WorkflowIr {
  const normalized = normalizeWorkflowPromptOverrides(overrides);
  if (Object.keys(normalized).length === 0) return ir;

  let changed = false;
  const nodes = ir.nodes.map((node) => {
    if (!isPromptBearingWorkflowNode(node)) return node;
    const override = normalized[node.id];
    if (override === undefined) return node;
    changed = true;
    return {
      ...node,
      config: {
        ...(node.config ?? {}),
        prompt: override,
      },
    };
  });

  return changed ? ({ ...ir, nodes } as WorkflowIr) : ir;
}
