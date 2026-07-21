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
import type { GlobalSettings, McpServersSettings, Settings } from "@fusion/core";

/**
 * Project-scoped model-override keys whose overrides track inheritance
 * explicitly (changed-only writes with null-as-delete in the project branch).
 *
 * The title-summarizer lane was restored to project settings in FN-5994, so it
 * needs the same changed-only/null-as-delete handling as the project default
 * lane overrides. Execution/planning/validator lanes still live on workflow
 * settings and are filtered out before the project branch is reached.
 *
 * FNXC:Settings-ThinkingLevel 2026-07-10-12:10:
 * The project-scoped title-summarizer fallback thinking companion must travel
 * with its provider/model pair so clearing the inline selector serializes as
 * null-as-delete instead of being dropped as an unchanged inherited value.
 *
 * FNXC:Settings-MergerModel 2026-07-13-07:52:
 * Merger primary and merger-fallback lanes (provider/model/thinking) are project-scoped
 * like title summarizer — not workflow-moved — so set edits and null-as-delete resets
 * participate in the same changed-only project-branch write path instead of being dropped.
 *
 * FNXC:GitHubImportTranslate 2026-07-15-09:30:
 * The import auto-translation settings are PROJECT-scoped: which language a repo's
 * issues get translated into, and whether to translate at all, is a per-project
 * decision, so they must route to the project patch and inherit when untouched.
 * The lane's provider/model/thinking trio travels with the two non-model keys
 * (`githubImportAutoTranslate`, `importTranslateTargetLocale`) so that clearing the
 * toggle or the target locale serializes as null-as-delete (restoring inheritance)
 * instead of being dropped as an unchanged inherited value. The companion
 * `importTranslateGlobal*` keys are deliberately NOT listed here — they are global
 * scope and are gated by GLOBAL_SECTION_KEYS below.
 */
export const MODEL_LANE_KEYS = [
  "defaultProviderOverride", "defaultModelIdOverride",
  "titleSummarizerProvider", "titleSummarizerModelId",
  "titleSummarizerFallbackProvider", "titleSummarizerFallbackModelId", "titleSummarizerFallbackThinkingLevel",
  "mergerProvider", "mergerModelId", "mergerThinkingLevel",
  "mergerFallbackProvider", "mergerFallbackModelId", "mergerFallbackThinkingLevel",
  "githubImportAutoTranslate", "importTranslateTargetLocale",
  "importTranslateProvider", "importTranslateModelId", "importTranslateThinkingLevel",
] as const;

const MODEL_LANE_KEY_SET = new Set<string>(MODEL_LANE_KEYS);

/*
FNXC:GitLabEnablement 2026-07-04-00:00:
FN-7535: the global GitLab and public-roadmap fallback keys must be diffed against the SCOPED global
initial only — never the merged, project-effective `initialValues` — because
SettingsModal already edits these keys through a dedicated `globalGitlabSettings`
state seeded from `scoped.global` (FN-7453). Falling back to merged initialValues
when the scoped global object lacks the key (e.g. the operator has never saved a
global value before) let a project override's effective value silently stand in
for "no change", so a genuine global edit that happened to match the merged value
was dropped from the global patch. These scoped-only keys never fall back to `initialValues`.
*/
const GLOBAL_GITLAB_SCOPED_ONLY_KEYS = new Set<string>([
  "gitlabEnabled",
  "gitlabInstanceUrl",
  "gitlabApiBaseUrl",
  "gitlabAuthToken",
  "gitlabAuthTokenType",
  "reportRoadmapDedupeEnabled",
  "reportRoadmapLabel",
  "reportRoadmapRepo",
]);

type RemoteAccessProvider = "tailscale" | "cloudflare";
type RemoteAccessPatch = NonNullable<GlobalSettings["remoteAccess"]>;

/*
FNXC:SettingsReset 2026-07-04-00:00:
Exported (not just module-private) so the FN-7506 section-keys registry
(settings/section-keys.ts) can reuse this as the single source of truth for
which GLOBAL keys belong to which settings section, instead of duplicating
the list for the "Reset this menu" feature.
*/
export const GLOBAL_SECTION_KEYS: Record<string, ReadonlySet<string>> = {
  /* FNXC:SettingsBackups 2026-07-16-14:35: shared PostgreSQL backup policy may only write through its global Database Backups section. */
  "backups-global": new Set(["autoBackupEnabled", "autoBackupSchedule", "autoBackupRetention", "autoBackupDir", "embeddedPostgresMaxConnections"]),
  appearance: new Set([
    "themeMode",
    "colorTheme",
    "dashboardFontScalePct",
    "shadcnCustomColors",
  ]),
  notifications: new Set([
    "ntfyEnabled",
    "agentClarificationEnabled",
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
  /*
  FNXC:SourceControl 2026-07-15-20:30:
  The global GitLab fallbacks and the global default tracking repo moved out of "global-general" into their own "source-control-global" section, paired with the project "source-control" section under the Integrations nav group.
  This set is not just reset bookkeeping: `isGlobalKeyAllowedForSection` gates the SAVE path on it, so these keys reach the global patch only while their owning section is active.
  */
  "source-control-global": new Set([
    "githubTrackingDefaultRepo",
    "gitlabEnabled",
    "gitlabInstanceUrl",
    "gitlabApiBaseUrl",
    "gitlabAuthToken",
    "gitlabAuthTokenType",
    "reportRoadmapDedupeEnabled",
    "reportRoadmapLabel",
    "reportRoadmapRepo",
  ]),
  "global-general": new Set([
    "language",
    "dismissModalsOnOutsideClick",
    "skipConfirmationDialogs",
    "persistAgentToolOutput",
    "proactiveTaskChatEnabled",
    "persistAgentThinkingLogPermanent",
    "persistAgentThinkingLogEphemeral",
    "fnBinaryCheckEnabled",
    "updateCheckEnabled",
    "updateCheckFrequency",
    "updateChannel",
    "autoReloadOnVersionChange",
  ]),
  /*
  FNXC:DashboardShortcuts 2026-07-04-00:00:
  FN-7553 moves `dashboardKeyboardShortcuts` ownership out of "global-general" into its own dedicated section so the new Keyboard Shortcuts settings section (not General) owns save/reset for this key.
  */
  "keyboard-shortcuts": new Set(["dashboardKeyboardShortcuts"]),
  "global-mcp": new Set(["mcpServers"]),
  "global-models": new Set([
    "defaultProvider",
    "defaultModelId",
    "fallbackProvider",
    "fallbackModelId",
    "fallbackThinkingLevel",
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
    "mergerGlobalProvider",
    "mergerGlobalModelId",
    "mergerGlobalThinkingLevel",
    /*
    FNXC:GitHubImportTranslate 2026-07-15-09:30:
    The import-translate GLOBAL lane keys must be section-allowlisted in both Models
    sections (mirroring merger), otherwise the section gate in the global branch of
    splitSettingsSave silently drops an operator's global lane edit on Save.
    */
    "importTranslateGlobalProvider",
    "importTranslateGlobalModelId",
    "importTranslateGlobalThinkingLevel",
  ]),
  "project-models": new Set([
    "defaultProvider",
    "defaultModelId",
    "fallbackProvider",
    "fallbackModelId",
    "fallbackThinkingLevel",
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
    "mergerGlobalProvider",
    "mergerGlobalModelId",
    "mergerGlobalThinkingLevel",
    "importTranslateGlobalProvider",
    "importTranslateGlobalModelId",
    "importTranslateGlobalThinkingLevel",
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
  /** The active section id; gates where section-owned values are written. */
  activeSection: string;
  /** Current raw MCP values for both scopes, preserved even after section navigation. */
  scopedMcpValues?: { global: McpServersSettings | undefined; project: McpServersSettings | undefined };
}

export interface SaveSplitResult {
  globalPatch: Partial<GlobalSettings>;
  projectPatch: Partial<Settings>;
}

export type McpSettingsScope = "global" | "project";
export type ScopedSettingsValues = { global: GlobalSettings; project: Partial<Settings> };

/**
 * Return the raw MCP value owned by one settings scope.
 *
 * FNXC:McpSettingsScopes 2026-07-14-21:59:
 * SettingsModal's general form is project-effective, so MCP editing and saving must use the raw values returned by `/api/settings/scopes`. Preserve `undefined` for an absent project override: normalizing it to `{ enabled: false, servers: [] }` would replace global inheritance with an explicit disabled project setting on a no-op save.
 */
export function resolveScopedMcpSettings(
  scope: McpSettingsScope,
  scopedSettings: ScopedSettingsValues | null,
): McpServersSettings | undefined {
  return scope === "global"
    ? scopedSettings?.global.mcpServers
    : scopedSettings?.project.mcpServers;
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

function readString(payload: Record<string, unknown>, key: string): string | undefined {
  if (!hasOwn(payload, key) || payload[key] === undefined) return undefined;
  return String(payload[key] ?? "");
}

function readNullableString(payload: Record<string, unknown>, key: string): string | null | undefined {
  if (!hasOwn(payload, key) || payload[key] === undefined) return undefined;
  return payload[key] ? String(payload[key]) : null;
}

function readBoolean(payload: Record<string, unknown>, key: string): boolean | undefined {
  if (!hasOwn(payload, key) || payload[key] === undefined) return undefined;
  return Boolean(payload[key]);
}

function readNumber(payload: Record<string, unknown>, key: string, fallback: number): number | undefined {
  if (!hasOwn(payload, key) || payload[key] === undefined) return undefined;
  return Number(payload[key] ?? fallback);
}

function assignIfPresent<T extends object, K extends keyof T>(target: T, key: K, value: T[K] | undefined): void {
  if (value !== undefined) {
    target[key] = value;
  }
}

function buildRemoteAccessPatch(payload: Record<string, unknown>): Partial<RemoteAccessPatch> | null {
  const patch: Partial<RemoteAccessPatch> = {};
  const activeProvider = hasOwn(payload, "remoteActiveProvider")
    ? (payload.remoteActiveProvider as RemoteAccessProvider | null)
    : undefined;

  if (activeProvider !== undefined) {
    patch.activeProvider = activeProvider;
  }

  const tailscalePatch: Partial<RemoteAccessPatch["providers"]["tailscale"]> = {};
  assignIfPresent(tailscalePatch, "enabled", readBoolean(payload, "remoteTailscaleEnabled"));
  assignIfPresent(tailscalePatch, "hostname", readString(payload, "remoteTailscaleHostname"));
  assignIfPresent(tailscalePatch, "targetPort", readNumber(payload, "remoteTailscaleTargetPort", 4040));
  assignIfPresent(tailscalePatch, "acceptRoutes", readBoolean(payload, "remoteTailscaleAcceptRoutes"));
  if (activeProvider === "tailscale") {
    tailscalePatch.enabled = true;
  }

  const cloudflarePatch: Partial<RemoteAccessPatch["providers"]["cloudflare"]> = {};
  assignIfPresent(cloudflarePatch, "enabled", readBoolean(payload, "remoteCloudflareEnabled"));
  assignIfPresent(cloudflarePatch, "quickTunnel", readBoolean(payload, "remoteCloudflareQuickTunnel"));
  assignIfPresent(cloudflarePatch, "tunnelName", readString(payload, "remoteCloudflareTunnelName"));
  assignIfPresent(cloudflarePatch, "tunnelToken", readNullableString(payload, "remoteCloudflareTunnelToken"));
  assignIfPresent(cloudflarePatch, "ingressUrl", readString(payload, "remoteCloudflareIngressUrl"));
  if (activeProvider === "cloudflare") {
    cloudflarePatch.enabled = true;
  }

  if (Object.keys(tailscalePatch).length > 0 || Object.keys(cloudflarePatch).length > 0) {
    patch.providers = {} as RemoteAccessPatch["providers"];
    if (Object.keys(tailscalePatch).length > 0) {
      patch.providers.tailscale = tailscalePatch as RemoteAccessPatch["providers"]["tailscale"];
    }
    if (Object.keys(cloudflarePatch).length > 0) {
      patch.providers.cloudflare = cloudflarePatch as RemoteAccessPatch["providers"]["cloudflare"];
    }
  }

  const shortLivedPatch: Partial<RemoteAccessPatch["tokenStrategy"]["shortLived"]> = {};
  assignIfPresent(shortLivedPatch, "enabled", readBoolean(payload, "remoteShortLivedEnabled"));
  assignIfPresent(shortLivedPatch, "ttlMs", readNumber(payload, "remoteShortLivedTtlMs", 900_000));
  assignIfPresent(shortLivedPatch, "maxTtlMs", readNumber(payload, "remoteShortLivedMaxTtlMs", 86_400_000));
  if (Object.keys(shortLivedPatch).length > 0) {
    patch.tokenStrategy = {
      shortLived: shortLivedPatch as RemoteAccessPatch["tokenStrategy"]["shortLived"],
    } as RemoteAccessPatch["tokenStrategy"];
  }

  const lifecyclePatch: Partial<RemoteAccessPatch["lifecycle"]> = {};
  assignIfPresent(lifecyclePatch, "rememberLastRunning", readBoolean(payload, "remoteRememberLastRunning"));
  assignIfPresent(lifecyclePatch, "wasRunningOnShutdown", readBoolean(payload, "remoteWasRunningOnShutdown"));
  if (hasOwn(payload, "remoteLastStartedProvider") && payload.remoteLastStartedProvider !== undefined) {
    lifecyclePatch.lastRunningProvider = payload.remoteLastStartedProvider as RemoteAccessProvider | null;
  }
  if (Object.keys(lifecyclePatch).length > 0) {
    patch.lifecycle = lifecyclePatch as RemoteAccessPatch["lifecycle"];
  }

  return Object.keys(patch).length > 0 ? patch : null;
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
  scopedMcpValues,
}: SaveSplitInput): SaveSplitResult {
  const globalPatch: Partial<GlobalSettings> = {};

  if (activeSection === "remote") {
    /*
    FNXC:RemoteAccessSettings 2026-06-30-00:00:
    Main Settings Save must persist the Remote Access section's flattened form fields into the canonical nested remoteAccess object. Windows users commonly configure Tailscale options and click Save without starting the tunnel, so this path cannot rely on the Start Tunnel auto-save.
    */
    const remoteAccessPatch = buildRemoteAccessPatch(payload);
    if (remoteAccessPatch) {
      globalPatch.remoteAccess = remoteAccessPatch as RemoteAccessPatch;
    }
  }

  for (const [key, value] of Object.entries(payload)) {
    /*
    FNXC:SourceControl 2026-07-15-20:30:
    These six keys are dual-scope (declared in both DEFAULT_GLOBAL_SETTINGS and DEFAULT_PROJECT_SETTINGS), so the ACTIVE SECTION — not the key — decides which patch they land in: the global fallbacks are editable only from "source-control-global", and every other section's copy of the key is the project override. The id moved with the controls (was "global-general"); it must track whichever section renders the global GitLab/tracking-repo rows, or a global edit would silently be written as a project override.
    */
    if (key === "githubTrackingDefaultRepo" && activeSection !== "source-control-global") {
      continue;
    }
    if ((key === "gitlabEnabled" || key === "gitlabInstanceUrl" || key === "gitlabApiBaseUrl" || key === "gitlabAuthToken" || key === "gitlabAuthTokenType") && activeSection !== "source-control-global") {
      continue;
    }
    if (key === "mcpServers" && scopedMcpValues) {
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

      const scopedOnly = GLOBAL_GITLAB_SCOPED_ONLY_KEYS.has(key);
      const hasScopedInitial = hasOwn(initialScopedValues?.global, key);
      const hasMergedInitial = !scopedOnly && hasOwn(initialValues, key);
      const initialValue = hasScopedInitial
        ? initialScopedValues?.global?.[key as keyof GlobalSettings]
        : scopedOnly
          ? undefined
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
    // Mirror of the global branch's dual-scope gate: while the global source-control
    // section is active these source-control keys are the GLOBAL fallbacks, so they must not
    // also be written as project overrides. See the FNXC note in the global branch.
    if (key === "githubTrackingDefaultRepo" && activeSection === "source-control-global") continue;
    if ((key === "gitlabEnabled" || key === "gitlabInstanceUrl" || key === "gitlabApiBaseUrl" || key === "gitlabAuthToken" || key === "gitlabAuthTokenType" || key === "reportRoadmapDedupeEnabled" || key === "reportRoadmapLabel" || key === "reportRoadmapRepo") && activeSection === "source-control-global") continue;
    if (key === "mcpServers" && scopedMcpValues) continue;
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

  /*
  FNXC:McpSettingsScopes 2026-07-14-22:10:
  Saving must not discard scoped MCP edits merely because the initial scoped snapshot is unavailable. Compare against an undefined baseline in that case so the current raw scoped values are still persisted.
  */
  if (scopedMcpValues) {
    const initialGlobalMcp = resolveScopedMcpSettings("global", initialScopedValues);
    if (!settingsValueEquals(scopedMcpValues.global, initialGlobalMcp)) {
      (globalPatch as Record<string, unknown>).mcpServers = scopedMcpValues.global ?? null;
    }

    const initialProjectMcp = resolveScopedMcpSettings("project", initialScopedValues);
    if (!settingsValueEquals(scopedMcpValues.project, initialProjectMcp)) {
      (projectPatch as Record<string, unknown>).mcpServers = scopedMcpValues.project ?? null;
    }
  }

  return { globalPatch, projectPatch };
}
