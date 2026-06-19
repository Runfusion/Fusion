import type { PluginSettingSchema } from "@fusion/plugin-sdk";
import { listStages } from "./session/stage-registry.js";

/**
 * Operator-facing settings for the Compound Engineering plugin (U9).
 *
 * Grouped like `fusion-plugin-reports`. Every setting here has a real, honest
 * consumption point in the existing plugin code:
 *   - Sessions group  → the orchestrator's interactive-session factory call
 *                        (`defaultProvider`/`defaultModelId`) and the launch
 *                        guard (`disabledStages`).
 *   - Sync group      → the reconciler trigger surface (auto-drain on hooks +
 *                        the cadence hint a refresh surface reads).
 *
 * `DEFAULT_*` consts are the single source of truth shared by the schema
 * defaults, the typed getters, and the settings test.
 */

/** Sessions: default provider/model for CE interactive sessions. */
export const DEFAULT_PROVIDER = "";
export const DEFAULT_MODEL_ID = "";

/** Sessions: stage launch opt-outs. Empty means every registered stage is launchable. */
export const DEFAULT_DISABLED_STAGES: string[] = [];

/** Sync: whether the board→pipeline reconcile sweep auto-fires after lifecycle hooks. */
export const DEFAULT_RECONCILE_ON_HOOKS = true;
/**
 * Sync: cadence hint (minutes) a refresh/poll-fallback surface uses when it
 * sweeps the reconciler on demand. This is a HINT, not a host scheduler — there
 * is no continuous poll loop (per docs/performance/dashboard-load.md); a refresh
 * surface reads this to decide how often to offer/auto-trigger a manual sweep.
 */
export const DEFAULT_RECONCILE_INTERVAL_MINUTES = 15;

export const settingsSchema: Record<string, PluginSettingSchema> = {
  defaultProvider: {
    type: "string",
    label: "Default Session Provider",
    description: "Model provider used for CE interactive sessions (for example anthropic). Leave blank to use the host default.",
    group: "Sessions",
    defaultValue: DEFAULT_PROVIDER,
  },
  defaultModelId: {
    type: "string",
    label: "Default Session Model",
    description: "Model ID within the provider used for CE interactive sessions. Leave blank to use the host default.",
    group: "Sessions",
    defaultValue: DEFAULT_MODEL_ID,
  },
  disabledStages: {
    type: "array",
    itemType: "string",
    label: "Disabled Stages",
    description: "Stage IDs hidden from launch in the Compound Engineering view. Empty means all registered stages are launchable.",
    group: "Sessions",
    defaultValue: DEFAULT_DISABLED_STAGES,
  },

  reconcileOnHooks: {
    type: "boolean",
    label: "Reconcile on Board Changes",
    description: "Run the board→pipeline reconcile sweep automatically after task move/complete hooks. Disable to only reconcile on demand.",
    group: "Sync",
    defaultValue: DEFAULT_RECONCILE_ON_HOOKS,
  },
  reconcileIntervalMinutes: {
    type: "number",
    label: "Reconcile Cadence (minutes)",
    description: "Cadence hint for how often an on-demand refresh surface sweeps the reconciler. Not a continuous poll loop.",
    group: "Sync",
    defaultValue: DEFAULT_RECONCILE_INTERVAL_MINUTES,
  },
};

function asString(settings: Record<string, unknown>, key: string): string | undefined {
  const value = settings[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function asBoolean(settings: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = settings[key];
  return typeof value === "boolean" ? value : fallback;
}

function asNumber(settings: Record<string, unknown>, key: string, fallback: number): number {
  const value = settings[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asStringArray(settings: Record<string, unknown>, key: string, fallback: string[]): string[] {
  const value = settings[key];
  if (!Array.isArray(value)) return [...fallback];
  const normalized = value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
  return normalized.length > 0 ? normalized : [...fallback];
}

/**
 * Default provider for CE sessions. Returns `undefined` when unset so the
 * orchestrator can omit it and let the host pick its default provider.
 */
export function getDefaultProvider(settings: Record<string, unknown>): string | undefined {
  return asString(settings, "defaultProvider");
}

/**
 * Default model ID for CE sessions. Returns `undefined` when unset so the
 * orchestrator can omit it and let the host pick its default model.
 */
export function getDefaultModelId(settings: Record<string, unknown>): string | undefined {
  return asString(settings, "defaultModelId");
}

/**
 * Stage IDs explicitly disabled by the operator. Malformed or empty values mean
 * no opt-outs, so all registered stages remain launchable.
 */
export function getDisabledStages(settings: Record<string, unknown>): string[] {
  return asStringArray(settings, "disabledStages", DEFAULT_DISABLED_STAGES);
}

/**
 * Stage IDs that may be launched. This is the LIVE registry minus explicit
 * disabled-stage opt-outs; stale persisted `enabledStages` snapshots are ignored.
 *
 * FNXC:CompoundEngineering 2026-06-17-08:06:
 * The previous enabledStages allow-list was snapshotted into plugin settings at first install, so later appended stages such as debug were silently un-launchable on existing installs. Use disabledStages as an explicit opt-out so every registered stage is launchable by default as documented.
 */
export function getEnabledStages(settings: Record<string, unknown>): string[] {
  const disabled = new Set(getDisabledStages(settings));
  return listStages().map((s) => s.stageId).filter((stageId) => !disabled.has(stageId));
}

/** Whether the reconcile sweep auto-fires after lifecycle hooks. */
export function getReconcileOnHooks(settings: Record<string, unknown>): boolean {
  return asBoolean(settings, "reconcileOnHooks", DEFAULT_RECONCILE_ON_HOOKS);
}

/** On-demand reconcile cadence hint in minutes (>= 1). */
export function getReconcileIntervalMinutes(settings: Record<string, unknown>): number {
  return Math.max(1, Math.floor(asNumber(settings, "reconcileIntervalMinutes", DEFAULT_RECONCILE_INTERVAL_MINUTES)));
}
