/**
 * Single source of truth for the workflow-IR resolution rule.
 *
 * The selection → builtin/custom → default-fallback rule was independently
 * reimplemented in engine/hold-release.ts, engine/merge-trait.ts,
 * engine/plugin-runner.ts (which bypassed the public API via getDatabase()),
 * and dashboard/board-workflows.ts, with behavioral divergence already creeping
 * in (GitHub #1402). This module consolidates the read-only resolution into one
 * pair of helpers built on the *public* store surface so every call site shares
 * one implementation.
 *
 * A missing/corrupt definition degrades to the built-in default workflow so
 * resolution never throws. The store-private, txn-hot `resolveTaskWorkflowIrSync`
 * stays separate by design.
 */

import { getBuiltinWorkflow, isBuiltinWorkflowId } from "./builtin-workflows.js";
import { BUILTIN_CODING_WORKFLOW_IR } from "./builtin-coding-workflow-ir.js";
import { parseWorkflowIr } from "./workflow-ir.js";
import type { WorkflowIr } from "./workflow-ir-types.js";

/** Minimal store surface the resolver needs (public APIs only). */
export interface WorkflowIrResolverStore {
  getTaskWorkflowSelection(taskId: string): { workflowId: string; stepIds: string[] } | undefined;
  getWorkflowDefinition(id: string): Promise<{ ir: string | WorkflowIr } | undefined>;
}

/**
 * Resolve a workflow IR by its id (built-in or custom).
 *
 * @param irCache optional cache keyed by workflowId so each distinct workflow's
 *   IR (and its definition fetch) is resolved at most once per caller-scoped
 *   sweep. Hits short-circuit before any builtin/db lookup.
 */
export async function resolveWorkflowIrById(
  store: Pick<WorkflowIrResolverStore, "getWorkflowDefinition">,
  workflowId: string,
  irCache?: Map<string, WorkflowIr>,
): Promise<WorkflowIr> {
  const cached = irCache?.get(workflowId);
  if (cached) return cached;

  if (isBuiltinWorkflowId(workflowId)) {
    const builtin = getBuiltinWorkflow(workflowId);
    const ir = builtin?.ir ?? BUILTIN_CODING_WORKFLOW_IR;
    const resolved = typeof ir === "string" ? parseWorkflowIr(ir) : ir;
    irCache?.set(workflowId, resolved);
    return resolved;
  }

  try {
    const def = await store.getWorkflowDefinition(workflowId);
    if (!def) return BUILTIN_CODING_WORKFLOW_IR;
    const ir = typeof def.ir === "string" ? parseWorkflowIr(def.ir) : def.ir;
    irCache?.set(workflowId, ir);
    return ir;
  } catch {
    return BUILTIN_CODING_WORKFLOW_IR;
  }
}

/**
 * Resolve a task's workflow IR via its selection. A null/absent selection or any
 * lookup failure degrades to the built-in default workflow.
 */
export async function resolveWorkflowIrForTask(
  store: WorkflowIrResolverStore,
  taskId: string,
  irCache?: Map<string, WorkflowIr>,
): Promise<WorkflowIr> {
  let workflowId: string | undefined;
  try {
    workflowId = store.getTaskWorkflowSelection(taskId)?.workflowId;
  } catch {
    return BUILTIN_CODING_WORKFLOW_IR;
  }
  if (!workflowId) return BUILTIN_CODING_WORKFLOW_IR;
  return resolveWorkflowIrById(store, workflowId, irCache);
}
