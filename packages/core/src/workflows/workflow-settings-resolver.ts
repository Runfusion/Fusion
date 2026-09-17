/**
 * Per-task EFFECTIVE workflow-settings resolution (U3, R3, KTD-3).
 *
 * Sibling of `workflow-ir-resolver.ts`. Composes three steps into the flat,
 * `Partial<ProjectSettings>`-shaped value map the engine reads at executor entry:
 *
 *   1. resolve the workflow IR (built-in or custom) → its `settings` declarations;
 *   2. read the raw stored `(workflowId, projectId)` value map;
 *   3. {@link resolveEffectiveSettingValues} → declaration default ?? stored value,
 *      dropping orphaned/invalid stored entries (KTD-6).
 *
 * The moved keys are all current `ProjectSettings` fields, so the returned map is a
 * structurally-compatible `Partial<ProjectSettings>` today. The engine MERGES this
 * over the project/global settings object so the ~20 flat `settings.<key>` read
 * sites keep their exact expressions (KTD-3).
 *
 * NEVER-THROW contract (mirrors the IR resolver): a missing/corrupt workflow
 * degrades to the built-in coding declarations; any store error degrades to an
 * empty stored map, so the result falls back to declaration defaults. The caller
 * always receives a usable map.
 *
 * IMPORTANT (parity): for built-in workflows with no stored values the effective
 * map carries the declaration defaults, which are byte-equal to the legacy
 * `DEFAULT_PROJECT_SETTINGS` literals — so merging it over project settings is a
 * no-op when nothing is customized. Keys whose declaration omits a default (the
 * per-phase model lanes) are ABSENT from the map (never `undefined`), so the merge
 * never clobbers a real project value with `undefined`.
 */

import {
  resolveWorkflowIrById,
  type WorkflowIrResolverStore,
} from "./workflow-ir-resolver.js";
import { resolveEffectiveSettingValues, findOrphanedSettingValues } from "./workflow-settings.js";
import { BUILTIN_WORKFLOW_SETTINGS, MEMORY_CONSOLIDATION_ENABLED_SETTING_ID, PLANNER_HEARTBEAT_PATROL_ENABLED_SETTING_ID } from "./builtin-workflow-settings.js";
import { DEFAULT_CODE_REVIEW_MAX_REVISIONS } from "./builtin-code-review-group.js";
import type { WorkflowSettingDefinition, WorkflowIr, WorkflowOptionalGroupConfig } from "./workflow-ir-types.js";
import { PLANNER_OVERSIGHT_LEVELS, DEFAULT_PLANNER_OVERSIGHT_LEVEL, type PlannerOversightLevel } from "../types.js";

export const PLAN_REVIEW_MAX_REVISIONS_SETTING_ID = "planReviewMaxRevisions";
export const CODE_REVIEW_MAX_REVISIONS_SETTING_ID = "codeReviewMaxRevisions";
export const PLAN_REVIEW_REPLAN_CAP_SETTING_ID = "planReviewReplanCap";
export type OptionalReviewRevisionBudget = NonNullable<WorkflowOptionalGroupConfig["maxRevisions"]>;

const REVIEW_REVISION_SETTING_BY_GROUP_ID: Record<string, string | undefined> = {
  "plan-review": PLAN_REVIEW_MAX_REVISIONS_SETTING_ID,
  "code-review": CODE_REVIEW_MAX_REVISIONS_SETTING_ID,
};

function asRevisionBudget(value: unknown): OptionalReviewRevisionBudget | undefined {
  if (value === "unbounded") return value;
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) return undefined;
  return value;
}

export interface ResolveOptionalReviewRevisionBudgetInput {
  optionalGroupId: string;
  workflowSettings?: Record<string, unknown>;
  nodeMaxRevisions?: unknown;
  fallbackMaxRevisions?: OptionalReviewRevisionBudget;
}

/**
 * Resolve the automatic remediation budget for graph-native optional review gates.
 *
 * FNXC:WorkflowRevisionBudget 2026-09-13-04:34:
 * A stored non-negative workflow value wins first (including `0`), then an authored node
 * `maxRevisions` preserves custom and Compound Engineering policy. `"unbounded"` remains a policy
 * sentinel at this layer; the shared runtime resolver converts it to the finite absolute backstop.
 * Browser Verification and custom optional gates keep their caller fallback, also clamped there.
 */
export function resolveOptionalReviewRevisionBudget({
  optionalGroupId,
  workflowSettings,
  nodeMaxRevisions,
  fallbackMaxRevisions,
}: ResolveOptionalReviewRevisionBudgetInput): OptionalReviewRevisionBudget | undefined {
  const settingId = REVIEW_REVISION_SETTING_BY_GROUP_ID[optionalGroupId];
  if (settingId) {
    const workflowBudget = asRevisionBudget(workflowSettings?.[settingId]);
    if (workflowBudget !== undefined) return workflowBudget;
  }

  const nodeBudget = asRevisionBudget(nodeMaxRevisions);
  if (nodeBudget !== undefined) return nodeBudget;

  if (optionalGroupId === "code-review") return DEFAULT_CODE_REVIEW_MAX_REVISIONS;
  if (optionalGroupId === "plan-review") return "unbounded";
  return fallbackMaxRevisions;
}

/**
 * The effective map PLUS the subset of keys whose value came from an EXPLICIT
 * STORED workflow value (not a declaration default). The engine entry merge uses
 * `storedKeys` to decide override-vs-fill semantics:
 *
 *  - a STORED key ALWAYS overrides the project/global base (the workflow tuned it);
 *  - a default-only key (in `effective` but NOT in `storedKeys`) only FILLS the
 *    base when the base lacks the key.
 *
 * This is what makes U3 behavior-identical pre-migration: a customized project
 * setting (still present in the base before the U4 hard-move) is NOT clobbered by a
 * declaration default; only a real stored workflow value overrides it. Post-
 * migration the base lacks the moved key, so the declaration default fills it.
 */
export interface EffectiveSettingsResult {
  effective: Record<string, unknown>;
  storedKeys: Set<string>;
}

/** Minimal store surface the effective-settings resolver needs (public APIs). */
export interface WorkflowSettingsResolverStore extends WorkflowIrResolverStore {
  /** Raw stored `(workflowId, projectId)` value map; `{}` when no row exists. */
  getWorkflowSettingValues(workflowId: string, projectId: string): Record<string, unknown>;
  getWorkflowSettingValuesAsync?(workflowId: string, projectId: string): Promise<Record<string, unknown>>;
  /** The stable project id this store scopes `workflow_settings` rows by. A store
   *  instance is bound to one project, so the resolver derives the project key from
   *  the store rather than from the task (Task carries no projectId field). */
  getWorkflowSettingsProjectId(): string;
}

/** Model-lane declarations that remain isolated under the selected workflow tier. */
const WORKFLOW_MODEL_LANE_SETTING_IDS: ReadonlySet<string> = new Set([
  "executionProvider",
  "executionCredentialInstanceId",
  "executionModelId",
  "executionThinkingLevel",
  "executionFallbackProvider",
  "executionFallbackCredentialInstanceId",
  "executionFallbackModelId",
  "executionFallbackThinkingLevel",
  "planningProvider",
  "planningCredentialInstanceId",
  "planningModelId",
  "planningThinkingLevel",
  "planningFallbackProvider",
  "planningFallbackCredentialInstanceId",
  "planningFallbackModelId",
  "planningFallbackThinkingLevel",
  "validatorProvider",
  "validatorCredentialInstanceId",
  "validatorModelId",
  "validatorThinkingLevel",
  "validatorFallbackProvider",
  "validatorFallbackCredentialInstanceId",
  "validatorFallbackModelId",
  "validatorFallbackThinkingLevel",
  "mergerProvider",
  "mergerCredentialInstanceId",
  "mergerModelId",
  "mergerThinkingLevel",
  "mergerFallbackProvider",
  "mergerFallbackCredentialInstanceId",
  "mergerFallbackModelId",
  "mergerFallbackThinkingLevel",
]);

/** The declarations carried by a resolved IR, with the built-in catalog as the
 *  defensive belt for built-in graphs that predate the embedded `settings` (the
 *  linear `BUILTIN_WORKFLOWS` carry them now, but keep the belt cheap). */
function declarationsFromIr(
  ir: WorkflowIr,
  workflowId: string | undefined,
): WorkflowSettingDefinition[] | undefined {
  const declared = ir.version === "v2" ? ir.settings : undefined;
  if (declared && declared.length > 0) return declared;
  // Built-in workflows declare the full moved-key catalog (the migration parity
  // anchor); fall back to it only when the resolved IR didn't embed it.
  if (workflowId && workflowId.startsWith("builtin:")) return BUILTIN_WORKFLOW_SETTINGS;
  return declared;
}

/** Compose declarations + raw stored values → effective flat map + the set of keys
 *  whose value came from an explicit stored workflow value (never throws). */
async function effectiveFrom(
  store: WorkflowSettingsResolverStore,
  ir: WorkflowIr,
  workflowId: string | undefined,
  projectId: string,
): Promise<EffectiveSettingsResult> {
  const declarations = declarationsFromIr(ir, workflowId);
  let stored: Record<string, unknown> = {};
  if (workflowId) {
    try {
      stored = await (store.getWorkflowSettingValuesAsync?.(workflowId, projectId)
        ?? store.getWorkflowSettingValues(workflowId, projectId)) ?? {};
    } catch {
      stored = {};
    }
  }
  const effective = resolveEffectiveSettingValues(declarations, stored);
  // A key is "stored" iff it appears in the effective map AND the stored row holds
  // a value for it that did NOT orphan (i.e. it was not dropped). Orphaned stored
  // entries fall to the declaration default, so they count as default-only.
  const orphanedIds = new Set(findOrphanedSettingValues(declarations, stored).map((o) => o.id));
  const storedKeys = new Set<string>();
  for (const id of Object.keys(effective)) {
    if (Object.prototype.hasOwnProperty.call(stored, id) && !orphanedIds.has(id)) {
      const raw = stored[id];
      if (raw !== null && raw !== undefined) storedKeys.add(id);
    }
  }
  return { effective, storedKeys };
}

/**
 * Resolve the effective workflow settings for an explicit `(workflowId,
 * projectId)`. Used by the migration/export/agent-tool paths that name a
 * workflow directly. Never throws.
 */
export async function resolveEffectiveSettingsById(
  store: WorkflowSettingsResolverStore,
  workflowId: string,
  projectId: string,
  irCache?: Map<string, WorkflowIr>,
): Promise<Record<string, unknown>> {
  const ir = await resolveWorkflowIrById(store, workflowId, irCache);
  return (await effectiveFrom(store, ir, workflowId, projectId)).effective;
}

/**
 * Resolve effective settings for an explicit workflow selection while retaining
 * the project-wide model-lane baseline used by task-based resolution.
 *
 * FNXC:PlanningModelPrecedence 2026-07-22-14:00:
 * Planning Mode names a workflow before a task exists, so it must compose that
 * selection exactly as a task would: stored Project Models remain the project
 * baseline and the selected workflow's lanes stay in `selectedWorkflowModelLanes`.
 * This preserves complete-pair precedence in the canonical model resolver and
 * prevents a provider from one settings tier combining with a model from another.
 */
export async function resolveEffectiveSettingsDetailedById(
  store: WorkflowSettingsResolverStore,
  workflowId: string,
  projectId: string,
  irCache?: Map<string, WorkflowIr>,
): Promise<EffectiveSettingsResult> {
  const effectiveWorkflowId = workflowId || "builtin:coding";
  const ir = await resolveWorkflowIrById(store, effectiveWorkflowId, irCache);
  const selected = await effectiveFrom(store, ir, effectiveWorkflowId, projectId);

  /*
   * FNXC:ModelResolution 2026-09-14-19:07:
   * A selected workflow is always an isolated model tier, including when it is the project default.
   * Project lanes come only from project settings; no workflow row may masquerade as that baseline.
   */
  const effective = { ...selected.effective };
  const storedKeys = new Set(selected.storedKeys);
  const selectedWorkflowModelLanes: Record<string, unknown> = {};
  for (const id of WORKFLOW_MODEL_LANE_SETTING_IDS) {
    if (!Object.prototype.hasOwnProperty.call(selected.effective, id)) continue;
    selectedWorkflowModelLanes[id] = selected.effective[id];
    delete effective[id];
    storedKeys.delete(id);
  }
  if (Object.keys(selectedWorkflowModelLanes).length > 0) {
    effective.selectedWorkflowModelLanes = selectedWorkflowModelLanes;
  }
  return { effective, storedKeys };
}

/** The minimal task identity the per-task resolver reads. Task carries no
 *  projectId field — the project key comes from the store. */
export interface EffectiveSettingsTaskRef {
  id: string;
}

/**
 * Resolve the effective workflow settings for a TASK (the engine's primary entry).
 * Reads the task's workflow selection, resolves its IR, and composes the effective
 * value map for `(resolvedWorkflowId, task.projectId)`.
 *
 * An absent/falsy selection degrades to `builtin:coding` (matching the IR
 * resolver), so a selection-less task reads the built-in declaration defaults —
 * byte-equal to legacy project-settings defaults. Never throws.
 */
export async function resolveEffectiveSettings(
  store: WorkflowSettingsResolverStore,
  task: EffectiveSettingsTaskRef,
  irCache?: Map<string, WorkflowIr>,
): Promise<Record<string, unknown>> {
  return (await resolveEffectiveSettingsDetailed(store, task, irCache)).effective;
}

/**
 * Like {@link resolveEffectiveSettings}, but also returns `storedKeys` (the keys
 * whose value came from an explicit stored workflow value vs. a declaration
 * default). The engine entry merge uses this to override the base only for stored
 * keys and fill-only for default-only keys. Never throws.
 */
export async function resolveEffectiveSettingsDetailed(
  store: WorkflowSettingsResolverStore,
  task: EffectiveSettingsTaskRef,
  irCache?: Map<string, WorkflowIr>,
): Promise<EffectiveSettingsResult> {
  let workflowId: string | undefined;
  try {
    const selection = store.getTaskWorkflowSelectionAsync
      ? await store.getTaskWorkflowSelectionAsync(task.id)
      : store.getTaskWorkflowSelection(task.id);
    workflowId = selection?.workflowId;
  } catch {
    workflowId = undefined;
  }
  const effectiveWorkflowId = workflowId || "builtin:coding";
  let projectId: string;
  try {
    projectId = store.getWorkflowSettingsProjectId();
  } catch {
    // Preserve the isolated workflow model tier even when project identity is unavailable.
    projectId = "";
  }
  return resolveEffectiveSettingsDetailedById(store, effectiveWorkflowId, projectId, irCache);
}

function isPlannerOversightLevel(value: unknown): value is PlannerOversightLevel {
  return typeof value === "string" && (PLANNER_OVERSIGHT_LEVELS as readonly string[]).includes(value);
}

/**
 * FNXC:PlannerOversight 2026-07-04-00:00:
 * Resolves the effective planner oversight level for a task: a per-task
 * `Task.plannerOversightLevel` override (FN-7509) always wins over the
 * workflow's effective `plannerOversightLevel` setting value (declared in
 * `BUILTIN_OVERSIGHT_SETTINGS`, resolved via {@link resolveEffectiveSettings}).
 * If neither is set, or either value is an unrecognized string (defensive
 * normalization — never trust arbitrary/legacy input), falls back to
 * `DEFAULT_PLANNER_OVERSIGHT_LEVEL` ("autonomous"). Pure and never throws.
 */
export function resolveEffectivePlannerOversightLevel(
  taskOverride: PlannerOversightLevel | string | null | undefined,
  workflowEffective: PlannerOversightLevel | string | null | undefined,
): PlannerOversightLevel {
  if (isPlannerOversightLevel(taskOverride)) {
    return taskOverride;
  }
  if (isPlannerOversightLevel(workflowEffective)) {
    return workflowEffective;
  }
  return DEFAULT_PLANNER_OVERSIGHT_LEVEL;
}

/*
 * FNXC:HeartbeatPatrol 2026-07-14-23:36:
 * Boolean workflow values can arrive from built-in declaration defaults or explicit stored overrides. Normalize the idle-heartbeat patrol flag in one place so engine prompt code preserves default-on compatibility while treating only explicit false as no-patrol.
 */
export function resolveEffectivePlannerHeartbeatPatrolEnabled(
  workflowEffective: Record<string, unknown> | boolean | null | undefined,
): boolean {
  const value = typeof workflowEffective === "object" && workflowEffective !== null
    ? workflowEffective[PLANNER_HEARTBEAT_PATROL_ENABLED_SETTING_ID]
    : workflowEffective;
  return value !== false;
}

/** Normalize the workflow-native Memory Keeper switch; only explicit false disables upkeep. */
export function resolveEffectiveMemoryConsolidationEnabled(
  workflowEffective: Record<string, unknown> | boolean | null | undefined,
): boolean {
  const value = typeof workflowEffective === "object" && workflowEffective !== null
    ? workflowEffective[MEMORY_CONSOLIDATION_ENABLED_SETTING_ID]
    : workflowEffective;
  return value !== false;
}
