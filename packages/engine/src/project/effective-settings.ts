/**
 * Engine-side helper: merge per-task EFFECTIVE workflow settings (U3, KTD-3) over a
 * base settings object fetched from the store, so the engine's flat
 * `settings.<key>` read sites pick up workflow-setting values with zero changes at
 * the read sites.
 *
 * TWO-TIER MERGE (the parity-preserving rule):
 *  - a STORED flat value ALWAYS overrides the base (workflow policy, or the
 *    project workflow-model baseline);
 *  - a declaration-DEFAULT-only key (no stored value) only FILLS the base when the
 *    base lacks the key.
 *
 * This is what keeps U3 behavior-identical BEFORE the U4 hard-move: a customized
 * project setting still present in the base is NOT clobbered by a declaration
 * default; only a real stored workflow value overrides it. After the hard-move the
 * base lacks the moved key, so the declaration default fills it. Absent-default
 * model lanes contribute nothing. Lower-precedence selected-workflow model lanes
 * are retained separately for the centralized model resolver.
 *
 * `resolveEffectiveSettingsDetailed` never throws (degrades to declaration
 * defaults), so this helper is a thin store-coupled wrapper that also never throws.
 */

import {
  applyWorkflowSettingsOverlay,
  resolveEffectiveSettingsDetailed,
  resolveProjectWorkflowModelLaneBaseline,
  type Settings,
  type TaskStore,
} from "@fusion/core";

/** The minimal task shape the resolver needs. Task carries no projectId field —
 *  the project key is derived from the store. */
export interface EffectiveSettingsTask {
  id: string;
}

/**
 * Merge `base` with the task's effective workflow settings via the two-tier rule
 * (stored overrides; default-only fills only-absent). Returns a NEW object; `base`
 * is not mutated. Degrades to returning `base` unchanged on any resolver error.
 */
export async function mergeEffectiveSettings<T extends Partial<Settings>>(
  store: Pick<
    TaskStore,
    | "getDefaultWorkflowId"
    | "getTaskWorkflowSelection"
    | "getTaskWorkflowSelectionAsync"
    | "getWorkflowDefinition"
    | "getWorkflowSettingValues"
    | "getWorkflowSettingsProjectId"
  >,
  task: EffectiveSettingsTask,
  base: T,
): Promise<T> {
  try {
    const detailed = await resolveEffectiveSettingsDetailed(
      store as Parameters<typeof resolveEffectiveSettingsDetailed>[0],
      task,
    );
    return applyWorkflowSettingsOverlay(base, detailed);
  } catch {
    return base;
  }
}

/** Merge the Project Models workflow-lane baseline when no task-selected
 * workflow exists, such as scheduled AI prompts and idle heartbeats. */
export async function mergeProjectWorkflowModelLaneBaseline<T extends Partial<Settings>>(
  store: Pick<
    TaskStore,
    | "getDefaultWorkflowId"
    | "getWorkflowDefinition"
    | "getWorkflowSettingValues"
    | "getWorkflowSettingsProjectId"
  >,
  base: T,
): Promise<T> {
  try {
    const detailed = await resolveProjectWorkflowModelLaneBaseline(
      store as Parameters<typeof resolveProjectWorkflowModelLaneBaseline>[0],
      store.getWorkflowSettingsProjectId(),
    );
    return applyWorkflowSettingsOverlay(base, detailed);
  } catch {
    return base;
  }
}
