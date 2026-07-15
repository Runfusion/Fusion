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
import { applyPromptOverridesToIr } from "./workflow-prompt-overrides.js";
import type { WorkflowIr } from "./workflow-ir-types.js";

function defaultCodingWorkflowIr(): WorkflowIr {
  /*
   * FNXC:WorkflowBuiltins 2026-06-29-02:18:
   * `builtin:coding` is the operator-facing default workflow id, not the legacy monolithic IR export. Resolve the catalog entry first so no-selection tasks follow the new stepwise default; keep the old IR only as a missing-catalog safety fallback.
   */
  const builtin = getBuiltinWorkflow("builtin:coding");
  const ir = builtin?.ir ?? BUILTIN_CODING_WORKFLOW_IR;
  return typeof ir === "string" ? parseWorkflowIr(ir) : ir;
}

/** Minimal store surface the resolver needs (public APIs only). */
export interface WorkflowIrResolverStore {
  getTaskWorkflowSelection(taskId: string): { workflowId: string; stepIds: string[] } | undefined;
  getTaskWorkflowSelectionAsync?(taskId: string): Promise<{ workflowId: string; stepIds: string[] } | undefined>;
  getWorkflowDefinition(id: string): Promise<{ ir: string | WorkflowIr } | undefined>;
  getWorkflowSettingsProjectId?(): string;
  getWorkflowPromptOverrides?(workflowId: string, projectId: string): Record<string, string>;
  getWorkflowPromptOverridesAsync?(workflowId: string, projectId: string): Promise<Record<string, string>>;
}

/**
 * Extract a prompt seam's prompt text from a resolved workflow IR.
 *
 * Seam prompt nodes are prompt nodes with `config.seam === seam`;
 * `config.prompt` carries the text installed by builtinPromptConfig or a custom
 * workflow author. Empty/missing prompts return undefined so callers can apply
 * their own fail-soft fallback.
 */
export function resolveSeamPromptFromIr(ir: WorkflowIr, seam: string): string | undefined {
  for (const node of ir.nodes) {
    if (node.kind !== "prompt") continue;
    if (node.config?.seam !== seam) continue;
    const prompt = node.config.prompt;
    if (typeof prompt === "string" && prompt.trim().length > 0) return prompt;
  }
  return undefined;
}

/** Extract the planning seam prompt from a resolved workflow IR. */
export function resolvePlanningPromptFromIr(ir: WorkflowIr): string | undefined {
  return resolveSeamPromptFromIr(ir, "planning");
}

/** Resolve a task's seam prompt via its selected workflow IR. */
export async function resolveTaskSeamPrompt(
  store: WorkflowIrResolverStore,
  taskId: string,
  seam: string,
  irCache?: Map<string, WorkflowIr>,
): Promise<string | undefined> {
  try {
    const ir = await resolveWorkflowIrForTask(store, taskId, irCache);
    return resolveSeamPromptFromIr(ir, seam);
  } catch {
    return undefined;
  }
}

/** Resolve a task's planning seam prompt via its selected workflow IR. */
export async function resolveTaskPlanningPrompt(
  store: WorkflowIrResolverStore,
  taskId: string,
  irCache?: Map<string, WorkflowIr>,
): Promise<string | undefined> {
  return resolveTaskSeamPrompt(store, taskId, "planning", irCache);
}

/**
 * Resolve a workflow IR by its id (built-in or custom).
 *
 * @param irCache optional cache keyed by workflowId so each distinct workflow's
 *   IR (and its definition fetch) is resolved at most once per caller-scoped
 *   sweep. Hits short-circuit before any builtin/db lookup.
 */
export async function resolveWorkflowIrById(
  store: Pick<WorkflowIrResolverStore, "getWorkflowDefinition"> & Partial<Pick<WorkflowIrResolverStore, "getWorkflowSettingsProjectId" | "getWorkflowPromptOverrides" | "getWorkflowPromptOverridesAsync">>,
  workflowId: string,
  irCache?: Map<string, WorkflowIr>,
): Promise<WorkflowIr> {
  let projectId: string | undefined;
  try {
    projectId = store.getWorkflowSettingsProjectId?.();
  } catch {
    /*
     * FNXC:CustomWorkflows 2026-06-22-23:27:
     * Workflow IR resolution is an engine-entry fallback path, so project identity failures must behave like no scoped project is available.
     * Keep built-in/default IRs usable and skip project-scoped prompt overrides instead of propagating identity lookup errors.
     */
    projectId = undefined;
  }
  const cacheKey = projectId ? `${workflowId}\u0000${projectId}` : workflowId;
  const cached = irCache?.get(cacheKey);
  if (cached) return cached;

  if (isBuiltinWorkflowId(workflowId)) {
    const builtin = getBuiltinWorkflow(workflowId);
    const ir = builtin?.ir ?? defaultCodingWorkflowIr();
    const resolved = typeof ir === "string" ? parseWorkflowIr(ir) : ir;
    const overrides = projectId
      ? await (store.getWorkflowPromptOverridesAsync?.(workflowId, projectId)
        ?? store.getWorkflowPromptOverrides?.(workflowId, projectId))
      : undefined;
    // FNXC:CustomWorkflows 2026-06-21-19:12:
    // Public IR resolution must see the same project-scoped built-in prompt overrides as task execution, while callers without the new store methods keep the canonical built-in IR.
    const effective = applyPromptOverridesToIr(resolved, overrides);
    irCache?.set(cacheKey, effective);
    return effective;
  }

  try {
    const def = await store.getWorkflowDefinition(workflowId);
    if (!def) return defaultCodingWorkflowIr();
    const ir = typeof def.ir === "string" ? parseWorkflowIr(def.ir) : def.ir;
    irCache?.set(cacheKey, ir);
    return ir;
  } catch {
    return defaultCodingWorkflowIr();
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
    /*
     * FNXC:WorkflowModelLanes 2026-07-14-16:26:
     * Backend-mode task workflow selection is asynchronous. Execution must resolve the migrated task selection before loading its workflow graph; the synchronous PostgreSQL fallback intentionally reports no selection and previously forced every task onto builtin:coding.
     */
    const selection = store.getTaskWorkflowSelectionAsync
      ? await store.getTaskWorkflowSelectionAsync(taskId)
      : store.getTaskWorkflowSelection(taskId);
    workflowId = selection?.workflowId;
  } catch {
    return defaultCodingWorkflowIr();
  }
  if (!workflowId) return resolveWorkflowIrById(store, "builtin:coding", irCache);
  return resolveWorkflowIrById(store, workflowId, irCache);
}
