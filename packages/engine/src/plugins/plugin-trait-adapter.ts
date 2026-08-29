/**
 * Plugin trait adapter (U8, R6/R15/R22, KTD-7).
 *
 * Bridges plugin-contributed traits (`PluginTraitContribution`) into core's
 * `TraitRegistry` and routes their executable hooks through the SAME
 * prompt-session / script / verdict machinery contributed workflow STEPS use.
 *
 * Design (mirrors the workflow-step contribution pattern):
 *   - Plugin trait ids are namespaced `plugin:<pluginId>:<traitId>` so they can
 *     never collide with built-ins or be overridden (TraitRegistry rejects
 *     builtin-namespace overrides + restricted flags already).
 *   - Hooks are async-only (gate/onEnter/onExit/releaseCondition). A sync
 *     `guard` key is rejected at contribution validation (core), so it never
 *     reaches the registry.
 *   - Executable hooks do NOT run raw in-process code. The adapter builds a
 *     synthetic `WorkflowIrNode` from the hook descriptor (mode + prompt /
 *     scriptName + gateMode) and delegates to the injected
 *     `WorkflowCustomNodeRunner` — the exact path contributed workflow steps
 *     execute through. Gates additionally reuse `createGateHandler` semantics
 *     (blocking fails closed; advisory records-and-allows).
 *   - Gates are evaluated PRE-MOVE, outside the task lock (KTD-2): the verdict
 *     is recorded into the store via `recordPluginGateVerdict`; the store's
 *     in-lock guard re-checks it cheaply. No plugin code runs in-lock.
 *
 * Disable/uninstall protection (KTD-7):
 *   - `findLivePluginTraitDependents` resolves every live task's workflow +
 *     current column and reports tasks sitting in a column that uses one of the
 *     plugin's traits. A non-force disable with dependents is blocked.
 *   - `degradePluginTraits` (force path) deregisters the hook impls so the
 *     registry resolves them to the no-op + audit-warning path — columns become
 *     passive, cards stay movable, one audit event is emitted.
 */

import type {
  PluginTraitContribution,
  PluginTraitHookDescriptor,
  TaskStore,
  TaskDetail,
  TraitDefinition,
  TraitHookKind,
  WorkflowIr,
  WorkflowIrNode,
} from "@fusion/core";
import { TraitRegistry, findWorkflowColumn } from "@fusion/core";

import { createGateHandler } from "../workflows/workflow-node-handlers.js";
import type { WorkflowCustomNodeRunner } from "../workflows/workflow-node-handlers.js";
import type { WorkflowNodeResult } from "../workflows/workflow-graph-executor.js";

/** Build the registry-facing id for a plugin trait. */
export function pluginTraitRegistryId(pluginId: string, traitId: string): string {
  return `plugin:${pluginId}:${traitId}`;
}

/** The async hook points a plugin trait may carry. */
const PLUGIN_HOOK_KINDS: readonly Exclude<TraitHookKind, "guard">[] = [
  "gate",
  "onEnter",
  "onExit",
  "releaseCondition",
];

/**
 * Convert a `PluginTraitContribution` into a core `TraitDefinition`. The result
 * is NOT built-in (`builtin` stays falsy), so the registry enforces R22
 * (restricted flags / sync guard rejected) on registration as a backstop even
 * though core's `validatePluginTraitContribution` already rejected them.
 */
export function pluginTraitToDefinition(
  pluginId: string,
  contribution: PluginTraitContribution,
): TraitDefinition {
  const hooks: TraitDefinition["hooks"] = {};
  if (contribution.hooks?.gate) hooks.gate = true;
  if (contribution.hooks?.onEnter) hooks.onEnter = true;
  if (contribution.hooks?.onExit) hooks.onExit = true;
  if (contribution.hooks?.releaseCondition) hooks.releaseCondition = true;

  return {
    id: pluginTraitRegistryId(pluginId, contribution.traitId),
    name: contribution.name,
    description: contribution.description,
    flags: { ...(contribution.flags ?? {}) },
    configSchema: contribution.configSchema
      ? { fields: contribution.configSchema.fields.map((f) => ({ ...f })) }
      : undefined,
    hooks: Object.keys(hooks).length > 0 ? hooks : undefined,
    builtin: false,
  };
}

/**
 * Build a synthetic workflow node from a hook descriptor so the hook executes
 * through the existing custom-node runner (the contributed-workflow-step path).
 */
function hookDescriptorToNode(
  traitRegistryId: string,
  hookKind: Exclude<TraitHookKind, "guard">,
  descriptor: PluginTraitHookDescriptor,
): WorkflowIrNode {
  const isGate = hookKind === "gate";
  // The custom-node runner reads `config.gateMode === "gate"` (blocking) vs
  // anything else (advisory). Map our blocking/advisory onto that contract.
  const gateModeForRunner = descriptor.gateMode === "advisory" ? "advisory" : "gate";
  return {
    id: `trait:${traitRegistryId}:${hookKind}`,
    kind: isGate ? "gate" : "prompt",
    config: {
      name: traitRegistryId,
      prompt: descriptor.prompt ?? "",
      scriptName: descriptor.scriptName,
      gateMode: isGate ? gateModeForRunner : undefined,
    },
  } as WorkflowIrNode;
}

/**
 * Evaluate a plugin gate descriptor through the gate handler + custom-node
 * runner (the same machinery contributed steps use). Returns the node result;
 * blocking gates fail closed (a failure outcome → not allowed), advisory gates
 * always pass at the handler level (the verdict is still recorded).
 */
export async function evaluatePluginGate(params: {
  traitRegistryId: string;
  descriptor: PluginTraitHookDescriptor;
  task: TaskDetail;
  context?: Record<string, unknown>;
  runCustomNode: WorkflowCustomNodeRunner;
}): Promise<WorkflowNodeResult> {
  const { traitRegistryId, descriptor, task, context, runCustomNode } = params;
  const node = hookDescriptorToNode(traitRegistryId, "gate", descriptor);
  const handler = createGateHandler(runCustomNode);
  return handler(node, { task, context: context ?? {}, settings: undefined });
}

/**
 * Register a plugin's trait contributions into the registry and wire each async
 * hook's implementation. Hook impls delegate to the injected custom-node runner
 * (gate/onEnter/onExit/releaseCondition). Returns the registry ids registered so
 * the caller can later degrade/unregister them.
 *
 * Idempotent per id: a trait already present (same plugin reload) is skipped for
 * the definition but its hook impls are refreshed.
 */
export function registerPluginTraits(params: {
  registry: TraitRegistry;
  pluginId: string;
  contributions: PluginTraitContribution[];
  /** Resolves the custom-node runner for a given task (the executor's). */
  runCustomNode: WorkflowCustomNodeRunner;
}): string[] {
  const { registry, pluginId, contributions, runCustomNode } = params;
  const registered: string[] = [];

  for (const contribution of contributions) {
    const def = pluginTraitToDefinition(pluginId, contribution);
    if (!registry.has(def.id)) {
      // Registration enforces R22 as a backstop (restricted flag / guard hook).
      registry.register(def);
    }
    registered.push(def.id);

    for (const hookKind of PLUGIN_HOOK_KINDS) {
      const descriptor = contribution.hooks?.[hookKind];
      if (!descriptor) continue;
      registry.registerTraitHookImpl(def.id, hookKind, ((...args: unknown[]) => {
        const ctx = args[0] as
          | { task?: TaskDetail; context?: Record<string, unknown> }
          | undefined;
        const task = ctx?.task;
        if (!task) return undefined;
        const node = hookDescriptorToNode(def.id, hookKind, descriptor);
        return runCustomNode(node, task, ctx?.context ?? {});
      }) as (...args: unknown[]) => unknown);
    }
  }

  return registered;
}

/** A live task sitting in a column that uses one of a plugin's traits. */
export interface PluginTraitDependent {
  taskId: string;
  column: string;
  /** The registry ids of the plugin's traits used by that column. */
  traitIds: string[];
}

/** Typed error for a blocked disable/unregister with live dependents (KTD-7). */
export class PluginTraitHasDependentsError extends Error {
  readonly pluginId: string;
  readonly dependents: PluginTraitDependent[];
  constructor(pluginId: string, dependents: PluginTraitDependent[]) {
    super(
      `Cannot disable plugin '${pluginId}': ${dependents.length} task(s) are in columns using its traits ` +
        `(${dependents.map((d) => `${d.taskId}@${d.column}`).join(", ")}). ` +
        `Force-disable to degrade those columns to passive.`,
    );
    this.name = "PluginTraitHasDependentsError";
    this.pluginId = pluginId;
    this.dependents = dependents;
  }
}

/**
 * Resolve every live (non-archived) task's workflow + current column and report
 * those sitting in a column that uses one of the given plugin trait registry
 * ids. Pure read-side: resolves the workflow IR through the injected resolver
 * (so we don't reach into the store's private methods).
 */
export async function findLivePluginTraitDependents(params: {
  store: Pick<TaskStore, "listTasks">;
  /** Resolve the (already-parsed) workflow IR for a task id. May resolve
   *  asynchronously (the shared @fusion/core resolver awaits the definition). */
  resolveTaskWorkflowIr: (taskId: string) => WorkflowIr | undefined | Promise<WorkflowIr | undefined>;
  /** The registry ids of the plugin's traits to check for. */
  pluginTraitIds: string[];
}): Promise<PluginTraitDependent[]> {
  const { store, resolveTaskWorkflowIr, pluginTraitIds } = params;
  const traitSet = new Set(pluginTraitIds);
  if (traitSet.size === 0) return [];

  const dependents: PluginTraitDependent[] = [];
  const tasks = await store.listTasks({ slim: true, includeArchived: false });
  for (const task of tasks) {
    const ir = await resolveTaskWorkflowIr(task.id);
    if (!ir) continue;
    const column = findWorkflowColumn(ir, task.column);
    if (!column) continue;
    const used = column.traits
      .map((ct) => ct.trait)
      .filter((id) => traitSet.has(id));
    if (used.length > 0) {
      dependents.push({ taskId: task.id, column: task.column, traitIds: used });
    }
  }
  return dependents;
}

/**
 * Degrade a plugin's traits to passive (force-disable path, KTD-7). Deregisters
 * the hook impls so the registry resolves them to the no-op + audit-warning
 * path; the trait definitions stay registered so columns referencing them keep
 * resolving (cards remain movable). Returns the list of degraded registry ids.
 */
export function degradePluginTraits(
  registry: TraitRegistry,
  pluginTraitIds: string[],
): string[] {
  const degraded: string[] = [];
  for (const id of pluginTraitIds) {
    const def = registry.getTrait(id);
    if (!def) continue;
    let any = false;
    for (const hookKind of PLUGIN_HOOK_KINDS) {
      if (registry.deregisterTraitHookImpl(id, hookKind)) any = true;
    }
    if (any || def.hooks) degraded.push(id);
  }
  return degraded;
}

/**
 * Fully unregister a plugin's traits from the registry (no live dependents).
 * Removes the definitions and any hook impls. Returns removed registry ids.
 */
export function unregisterPluginTraits(
  registry: TraitRegistry,
  pluginTraitIds: string[],
): string[] {
  const removed: string[] = [];
  for (const id of pluginTraitIds) {
    if (registry.unregisterTrait(id)) removed.push(id);
  }
  return removed;
}
