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
 *   2. null-as-delete: an explicit clear (current value `undefined`, but the
 *      initial value was defined) is written as `null` so it survives
 *      `JSON.stringify` and tells the server to delete the key. Plain
 *      `undefined` is dropped.
 *   3. changed-only project writes: an inherited/effective project value that
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
      // null-as-delete: explicit clear is sent as null, plain undefined dropped.
      const initialValue = initialValues?.[key as keyof GlobalSettings];
      if (value === undefined && initialValue !== undefined) {
        (globalPatch as Record<string, unknown>)[key] = null;
      } else {
        (globalPatch as Record<string, unknown>)[key] = value;
      }
    }
  }

  const projectPatch: Partial<Settings> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (key === "githubTokenConfigured" || key === "prAuthAvailable") continue; // server-only
    if (key === "customProviders") continue; // persisted via dedicated routes, not save-split (see global branch above)
    if (key === "githubTrackingDefaultRepo" && activeSection === "global-general") continue;
    if (!isProjectSettingsKey(key)) continue;

    const initialProjectValue = initialScopedValues?.project?.[key as keyof Settings];

    if (MODEL_LANE_KEY_SET.has(key)) {
      if (value !== initialProjectValue) {
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
      if (value !== initialProjectValue) {
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
