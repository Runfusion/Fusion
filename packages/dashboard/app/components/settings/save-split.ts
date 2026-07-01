/**
 * Save-split logic for SettingsModal (U9 / KTD-10).
 *
 * The modal edits a single merged form that mixes global-scope and
 * project-scope keys. On save it must split that form into two patches with
 * strict scope separation and preserve three subtle semantics:
 *
 *   1. Global keys are routed via {@link isGlobalSettingsKey} to the global
 *      patch; project keys via {@link isProjectSettingsKey} to the project
 *      patch. (A key can be neither — server-only/UI-only fields are dropped.)
 *   2. Global and project writes are changed-only. This prevents any Settings
 *      save from re-sending default global values that can overwrite unrelated
 *      user preferences such as notifications or onboarding state.
 *   3. null-as-delete: an explicit clear (current value `undefined`, but the
 *      initial value was defined) is written as `null` so it survives
 *      `JSON.stringify` and tells the server to delete the key. Plain
 *      `undefined` is dropped.
 *   4. changed-only project writes: an inherited/effective project value that
 *      the user never touched is NOT serialized as an explicit override —
 *      doing so would silently break inheritance for every project setting on
 *      every save. Only keys whose value differs from the initial project-scoped
 *      value are written.
 *
 * This module is pure (no React, no network) so the regression-critical split
 * behavior is characterized in isolation; the modal shell calls it and performs
 * the actual `updateGlobalSettings`/`updateSettings` writes.
 */
import { isGlobalSettingsKey, isProjectSettingsKey } from "@fusion/core";
import type { GlobalSettings, Settings } from "@fusion/core";

/**
 * Project-scoped model-override keys whose overrides track inheritance
 * explicitly (changed-only writes with null-as-delete in the project branch).
 *
 * The title-summarizer lane was restored to project settings in FN-5994, so it
 * needs the same changed-only/null-as-delete handling as the project default
 * lane overrides. Execution/planning/validator lanes still live on workflow
 * settings and are filtered out before the project branch is reached.
 */
export const MODEL_LANE_KEYS = [
  "defaultProviderOverride", "defaultModelIdOverride",
  "titleSummarizerProvider", "titleSummarizerModelId",
  "titleSummarizerFallbackProvider", "titleSummarizerFallbackModelId",
] as const;

const MODEL_LANE_KEY_SET = new Set<string>(MODEL_LANE_KEYS);

const GLOBAL_SECTION_KEYS: Record<string, ReadonlySet<string>> = {
  appearance: new Set([
    "themeMode",
    "colorTheme",
    "dashboardFontScalePct",
    "shadcnCustomColors",
  ]),
  notifications: new Set([
    "ntfyEnabled",
    "ntfyTopic",
    "ntfyBaseUrl",
    "ntfyAccessToken",
    "ntfyEvents",
    "ntfyDashboardHost",
    "failureNotificationDelayMs",
    "failureNotificationMode",
    "webhookEnabled",
    "webhookUrl",
    "webhookFormat",
    "webhookEvents",
    "notificationProviders",
  ]),
  experimental: new Set(["experimentalFeatures"]),
  "global-general": new Set([
    "githubTrackingDefaultRepo",
    "language",
    "dismissModalsOnOutsideClick",
    "persistAgentToolOutput",
    "persistAgentThinkingLogPermanent",
    "persistAgentThinkingLogEphemeral",
    "fnBinaryCheckEnabled",
    "updateCheckEnabled",
    "updateCheckFrequency",
    "autoReloadOnVersionChange",
  ]),
  "global-mcp": new Set(["mcpServers"]),
  "global-models": new Set([
    "defaultProvider",
    "defaultModelId",
    "fallbackProvider",
    "fallbackModelId",
    "defaultThinkingLevel",
    "modelRouterEnabled",
    "modelRouterCheapProvider",
    "modelRouterCheapModelId",
    "opencodeGoModelSync",
    "openrouterAppAttribution",
    "openrouterModelFilters",
    "openrouterModelSync",
    "openrouterProviderPreferences",
    "executionGlobalProvider",
    "executionGlobalModelId",
    "planningGlobalProvider",
    "planningGlobalModelId",
    "validatorGlobalProvider",
    "validatorGlobalModelId",
    "titleSummarizerGlobalProvider",
    "titleSummarizerGlobalModelId",
  ]),
  "project-models": new Set([
    "defaultProvider",
    "defaultModelId",
    "fallbackProvider",
    "fallbackModelId",
    "defaultThinkingLevel",
    "modelRouterEnabled",
    "modelRouterCheapProvider",
    "modelRouterCheapModelId",
    "opencodeGoModelSync",
    "openrouterAppAttribution",
    "openrouterModelFilters",
    "openrouterModelSync",
    "openrouterProviderPreferences",
    "executionGlobalProvider",
    "executionGlobalModelId",
    "planningGlobalProvider",
    "planningGlobalModelId",
    "validatorGlobalProvider",
    "validatorGlobalModelId",
    "titleSummarizerGlobalProvider",
    "titleSummarizerGlobalModelId",
  ]),
  "node-sync": new Set([
    "settingsSyncEnabled",
    "settingsSyncAuth",
    "settingsSyncInterval",
    "settingsSyncConflictResolution",
  ]),
  "research-global": new Set([
    "researchGlobalDefaults",
    "researchGlobalEnabled",
    "researchGlobalMaxConcurrentRuns",
    "researchGlobalDefaultTimeout",
    "researchGlobalMaxSourcesPerRun",
    "researchGlobalMaxSynthesisRounds",
    "researchGlobalWebSearchProvider",
    "researchGlobalSearxngUrl",
    "researchGlobalBraveApiKey",
    "researchGlobalGoogleSearchApiKey",
    "researchGlobalGoogleSearchCx",
    "researchGlobalTavilyApiKey",
    "researchGlobalGitHubEnabled",
    "researchGlobalLocalDocsEnabled",
    "researchGlobalMaxSearchResults",
    "researchGlobalFetchTimeoutMs",
    "researchGlobalUserAgent",
  ]),
  remote: new Set(["remoteAccess"]),
};

function isGlobalKeyAllowedForSection(key: string, activeSection: string): boolean {
  const sectionKeys = GLOBAL_SECTION_KEYS[activeSection];
  return !sectionKeys || sectionKeys.has(key);
}

export interface SaveSplitInput {
  /** The fully-normalized form payload (after trimming/normalization). */
  payload: Record<string, unknown>;
  /** Initial merged settings, used to detect explicit clears of global keys. */
  initialValues: Settings | null;
  /** Initial scoped values, used to detect changed/cleared project overrides. */
  initialScopedValues: { global: GlobalSettings; project: Partial<Settings> } | null;
  /** The active section id; gates where `githubTrackingDefaultRepo` is written. */
  activeSection: string;
}

export interface SaveSplitResult {
  globalPatch: Partial<GlobalSettings>;
  projectPatch: Partial<Settings>;
}

function hasOwn(obj: object | null | undefined, key: string): boolean {
  return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function settingsValueEquals(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    if (left.length !== right.length) return false;
    return left.every((item, index) => settingsValueEquals(item, right[index]));
  }
  if (isPlainObject(left) || isPlainObject(right)) {
    if (!isPlainObject(left) || !isPlainObject(right)) return false;
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every((key) => hasOwn(right, key) && settingsValueEquals(left[key], right[key]));
  }
  return false;
}

/**
 * Split a normalized settings form payload into global and project patches,
 * preserving null-as-delete and changed-only-project-write semantics.
 */
export function splitSettingsSave({
  payload,
  initialValues,
  initialScopedValues,
  activeSection,
}: SaveSplitInput): SaveSplitResult {
  const globalPatch: Partial<GlobalSettings> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (key === "githubTrackingDefaultRepo" && activeSection !== "global-general") {
      continue;
    }
    if (key === "mcpServers" && activeSection !== "global-mcp") {
      continue;
    }
    if (key === "persistAgentThinkingLog") {
      continue;
    }
    // customProviders is a global key, but it is NOT written through the
    // save-split form. It is persisted via its own REST routes
    // (register-custom-provider-routes.ts -> store.updateGlobalSettings) which
    // mask API keys on read (sanitizeProvider). Routing it through this patch
    // would write the masked keys back and clobber the real credentials.
    if (key === "customProviders") {
      continue;
    }
    if (isGlobalSettingsKey(key)) {
      /*
      FNXC:SettingsPersistence 2026-06-23-00:55:
      Global settings saves must be changed-only, just like project settings. The Settings form carries full default-shaped global values, so emitting unchanged globals can overwrite unrelated user preferences (notifications, onboarding state, theme) when a user saves another section or when experimental-feature normalization allocates a fresh but equivalent object.

      FNXC:SettingsPersistence 2026-06-23-01:18:
      Global Settings saves are also gated by the active settings section. The form can contain stale/default values from sections the user did not edit, so changed-only comparison alone cannot distinguish an intentional Appearance edit from a default-filled Notifications or onboarding field.
      */
      if (!isGlobalKeyAllowedForSection(key, activeSection)) {
        continue;
      }

      if (value === undefined && key === "ntfyAccessToken" && activeSection === "notifications") {
        (globalPatch as Record<string, unknown>)[key] = null;
        continue;
      }

      const hasScopedInitial = hasOwn(initialScopedValues?.global, key);
      const hasMergedInitial = hasOwn(initialValues, key);
      const initialValue = hasScopedInitial
        ? initialScopedValues?.global?.[key as keyof GlobalSettings]
        : initialValues?.[key as keyof GlobalSettings];
      const hasInitialValue = hasScopedInitial || hasMergedInitial;

      if (settingsValueEquals(value, initialValue)) {
        continue;
      }

      // null-as-delete: explicit clear is sent as null, plain undefined dropped.
      if (value === undefined && hasInitialValue && initialValue !== undefined) {
        (globalPatch as Record<string, unknown>)[key] = null;
      } else if (value !== undefined) {
        (globalPatch as Record<string, unknown>)[key] = value;
      }
    }
  }

  const projectPatch: Partial<Settings> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (key === "githubTokenConfigured" || key === "prAuthAvailable") continue; // server-only
    if (key === "customProviders") continue; // persisted via dedicated routes, not save-split (see global branch above)
    if (key === "githubTrackingDefaultRepo" && activeSection === "global-general") continue;
    if (key === "mcpServers" && activeSection === "global-mcp") continue;
    if (!isProjectSettingsKey(key)) continue;

    const initialProjectValue = initialScopedValues?.project?.[key as keyof Settings];

    if (MODEL_LANE_KEY_SET.has(key)) {
      if (!settingsValueEquals(value, initialProjectValue)) {
        if (
          (value === undefined || value === null) &&
          initialProjectValue !== undefined &&
          initialProjectValue !== null
        ) {
          (projectPatch as Record<string, unknown>)[key] = null;
        } else if (value !== undefined) {
          (projectPatch as Record<string, unknown>)[key] = value;
        }
      }
    } else {
      // Changed-only gate + null-as-delete for non-model project settings.
      if (!settingsValueEquals(value, initialProjectValue)) {
        if (value === undefined && initialProjectValue !== undefined && initialProjectValue !== null) {
          (projectPatch as Record<string, unknown>)[key] = null;
        } else if (value !== undefined) {
          (projectPatch as Record<string, unknown>)[key] = value;
        }
      }
    }
  }

  return { globalPatch, projectPatch };
}
