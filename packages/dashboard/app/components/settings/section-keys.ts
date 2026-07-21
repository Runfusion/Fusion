/**
 * Section -> owned settings keys (+ scope) registry (FN-7506).
 *
 * FNXC:SettingsReset 2026-07-04-00:00:
 * "Reset this menu" in the Settings footer must touch ONLY the active
 * section's own keys, at the correct scope (global vs project), and must
 * never silently reset a section that isn't a simple settings blob. This
 * module is the single source of truth for that mapping so the reset flow
 * and `splitSettingsSave` (save-split.ts) never diverge on which keys belong
 * to which section. Global-section entries are re-exported from
 * `GLOBAL_SECTION_KEYS` in save-split.ts (do not duplicate that list here);
 * this file adds the missing PROJECT-section entries and the shared
 * exclusion list.
 *
 * Design decisions (recorded in the `plan` task document for FN-7506):
 *   1. A key-owning section maps to { scope, keys }. Every key here MUST be a
 *      real member of GLOBAL_SETTINGS_KEYS or PROJECT_SETTINGS_KEYS matching
 *      the declared scope (enforced by section-keys.test.ts).
 *   2. Non-key sections (secrets, global-mcp, mcp, plugins, memory,
 *      authentication, prompts, cli-agents, and the three runtime sections)
 *      are NOT a simple settings blob — they are managed by their own CRUD
 *      flows/routes. They are explicitly EXCLUDED from per-menu reset rather
 *      than silently reset. See EXCLUDED_RESET_SECTIONS below.
 *   3. Reset semantics: GLOBAL keys reset to the canonical
 *      `DEFAULT_GLOBAL_SETTINGS` value (write). PROJECT keys reset via
 *      null-as-delete (write `null`) so an inherited/overridable project
 *      setting reverts to its inherited/default value, matching the existing
 *      null-as-delete convention already used by `splitSettingsSave`.
 *   4. Each key is assigned to exactly ONE canonical owning section per scope,
 *      so every section's reset is scoped to a disjoint key set. A key may
 *      still appear once at each scope when it is genuinely dual-scope (e.g.
 *      `githubTrackingDefaultRepo`); the disjointness guard is per-scope.
 *
 * FNXC:SourceControl 2026-07-15-20:30:
 * Rule 4 used to arbitrate a real UI duplicate rather than a naming overlap:
 * `gitlabEnabled` was rendered and written from BOTH "general" and "merge", so
 * the registry awarded it to "general" to keep reset sets disjoint while the
 * duplicate toggle stayed on screen. Both sections' GitHub/GitLab controls now
 * live in the "source-control"/"source-control-global" pair, which owns those
 * keys outright — the arbitration is no longer needed.
 */
import { GLOBAL_SETTINGS_KEYS, PROJECT_SETTINGS_KEYS } from "@fusion/core";
import { GLOBAL_SECTION_KEYS, MODEL_LANE_KEYS } from "./save-split";

export type SettingsResetScope = "global" | "project";

export interface SectionKeyEntry {
  scope: SettingsResetScope;
  keys: readonly string[];
}

/**
 * Project-scope section -> owned key registry. Reuses MODEL_LANE_KEYS from
 * save-split.ts for the project-models lane overrides instead of duplicating
 * them.
 */
const PROJECT_SECTION_KEYS: Record<string, readonly string[]> = {
  general: [
    "allowAbsoluteFileBrowserPaths",
    "capacityRiskBannerEnabled",
    "capacityRiskTodoThreshold",
    "chatAutoCleanupDays",
    "chatRoomCompactionFetchLimit",
    "chatRoomRecentVerbatimMessages",
    "chatRoomSummaryMaxChars",
    "completionDocumentationMode",
    "reviewArtifacts",
    "enabledBuiltinWorkflowIds",
    "ephemeralAgentTaskCreationPolicy",
    "ephemeralAgentsEnabled",
    "sessionAdvisorEnabledByDefault",
    "mailAutoCleanupDays",
    "mobileNavPrimaryItems",
    "operationalLogRetentionDays",
    "quickChatButtonMode",
    "quickChatCloseOnOutsideClick",
    "showQuickChatFAB",
    "showTaskChatsInCommonFeed",
    "taskPrefix",
    "workspaceMode",
    "reportMode",
    "reportModeByAction",
    "reportRoadmapDedupeEnabled",
    "reportRoadmapLabel",
    "reportRoadmapRepo",
  ],
  /*
  FNXC:SourceControl 2026-07-15-20:30:
  Every project-scoped GitHub/GitLab key is owned here, by the one section that now renders them all. This entry is what replaced the split ownership the notes above used to describe: `gitlabEnabled`'s toggle was rendered from BOTH "general" and "merge", so the registry had to arbitrarily award the key to "general" to keep the per-section reset sets disjoint — a bookkeeping fix for a UI duplicate. With a single owning section the arbitration is gone.
  `githubTrackingDefaultRepo` also appears in "source-control-global" (GLOBAL_SECTION_KEYS): it is a real dual-scope key, and the disjointness guard is per-scope, so the project row here and the global row there are two different settings, not a duplicate.
  */
  "source-control": [
    "githubAuthMode",
    "githubAuthToken",
    "githubLinkImportedIssuesToTracking",
    "githubTrackingDedupEnabled",
    "githubTrackingDefaultRepo",
    "githubTrackingEnabledByDefault",
    "gitlabApiBaseUrl",
    "gitlabAuthToken",
    "gitlabAuthTokenType",
    "gitlabEnabled",
    "gitlabInstanceUrl",
  ],
  commands: ["buildCommand", "testCommand"],
  worktrees: [
    "executorAllowSiblingBranchRename",
    "maxWorktrees",
    "recycleWorktrees",
    "showWorktreeGrouping",
    "worktreeCopyFiles",
    "worktreeInitCommand",
    "worktreeNaming",
    "worktreeRebaseBeforeMerge",
    "worktreeRebaseLocalBase",
    "worktreeRebaseRemote",
    "worktreesDir",
    "worktrunk",
  ],
  scheduling: [
    "archiveAgentLogMode",
    "autoArchiveDoneAfterMs",
    "autoArchiveDoneTasksEnabled",
    "engineerBacklogAutoClaim",
    "executorToolFailureRetryCount",
    "executorToolFailureRetryBackoffMs",
    "executorToolFailureThreshold",
    "executorModelEscalationEnabled",
    "executorEscalationProvider",
    "executorEscalationModelId",
    "executorEscalationNodeId",
    "groupOverlappingFiles",
    "heartbeatScopeDiscipline",
    "ignoreHiddenOverlapPaths",
    "maxConcurrent",
    "maxConcurrentVerifications",
    "maxStuckKills",
    "maxTriageConcurrent",
    "overlapIgnorePaths",
    "pollIntervalMs",
    "preserveProgressOnStuckRequeue",
    "specStalenessEnabled",
    "specStalenessMaxAgeMs",
    "staleHighFanoutBlockerAgeThresholdMs",
    "taskStuckTimeoutMs",
  ],
  "scheduled-evals": ["evalSettings"],
  "node-routing": ["defaultNodeId", "unavailableNodePolicy"],
  merge: [
    "autoMerge",
    "autoResolveConflicts",
    "commitAuthorEmail",
    "commitAuthorEnabled",
    "commitAuthorName",
    "directMergeCommitStrategy",
    "includeTaskIdInCommit",
    "integrationBranch",
    "maxAutoMergeRetries",
    "mergeAdvanceAutoSync",
    "mergeConflictStrategy",
    "mergeIntegrationWorktree",
    "mergeStrategy",
    "mergeStrategyOverlapBehavior",
    "merger",
    "planApprovalMode",
    "postMergeAuditMode",
    "pushAfterMerge",
    "pushRemote",
    "smartConflictResolution",
    "testMode",
  ],
  "agent-permissions": ["agentProvisioning", "defaultAgentPermissionPolicy"],
  backups: [
    "memoryBackupDir",
    "memoryBackupEnabled",
    "memoryBackupRetention",
    "memoryBackupSchedule",
    "memoryBackupScope",
  ],
  "research-project": ["researchSettings"],
  "project-models": [
    "autoSelectModelPreset",
    "autoSummarizeTitles",
    "defaultPresetBySize",
    "taskDefinitionInInputLanguage",
    "defaultWorkflowId",
    "modelPresets",
    "prDescriptionPromptInstructions",
    "prTitlePromptInstructions",
    "tokenCap",
    "useAiMergeCommitSummary",
    ...MODEL_LANE_KEYS,
  ],
};

/**
 * Non-key sections that are NOT a simple settings blob. Each is managed by
 * its own dedicated flow/routes (secrets store, MCP server CRUD, plugin
 * manager, memory editor, auth/OAuth, prompt library, CLI adapter approvals,
 * plugin runtime config), so a generic "reset to defaults" over the merged
 * settings form would be meaningless or actively destructive. Per-menu reset
 * is disabled for these with a documented reason (surfaced in the dialog).
 */
export const EXCLUDED_RESET_SECTIONS: Record<string, string> = {
  /*
  FNXC:SettingsReset 2026-07-15-18:52:
  scheduling-global owns exactly one control (`globalMaxConcurrent`), and it is not a settings-blob key: it is read and written through the dedicated global-concurrency endpoint, so per-menu reset has nothing here to reset.
  Listed explicitly rather than left to the unknown-id fallback: an unregistered id is reset-ineligible with NO reason, which renders the dialog without telling the operator why the button is unavailable.
  */
  "scheduling-global": "The global concurrency cap is managed by the global-concurrency endpoint, not the settings form.",
  secrets: "Secrets are managed by the Secrets store, not the settings form.",
  "global-mcp": "MCP servers are managed by their own add/edit/remove flow.",
  mcp: "MCP servers are managed by their own add/edit/remove flow.",
  plugins: "Plugins and Pi extensions are managed by the Plugin Manager.",
  memory: "Memory files are edited directly, not as a settings blob.",
  authentication: "Authentication/provider credentials are managed by their own OAuth/API-key flow.",
  prompts: "Prompt library entries are managed by their own editor, not bulk-reset here.",
  "cli-agents": "Per-adapter CLI agent settings are managed by their own approval/config flow.",
  "hermes-runtime": "Runtime plugin settings are managed by the plugin's own config surface.",
  "openclaw-runtime": "Runtime plugin settings are managed by the plugin's own config surface.",
  "paperclip-runtime": "Runtime plugin settings are managed by the plugin's own config surface.",
};

/**
 * Resolve the { scope, keys } entry for a key-owning section id, or `null`
 * for excluded/non-key/group-header sections.
 */
export function getSectionKeyEntry(sectionId: string): SectionKeyEntry | null {
  /*
  FNXC:SettingsReset 2026-07-04-00:10:
  Exclusions are checked FIRST because a couple of section ids collide across
  the two lookup tables for unrelated reasons: "global-mcp" has an entry in
  GLOBAL_SECTION_KEYS (used by splitSettingsSave to gate the normal Save flow)
  but is explicitly excluded from RESET because MCP servers are managed by
  their own CRUD flow, not a bulk reset. "project-models" also has an entry in
  GLOBAL_SECTION_KEYS (its dual-scope global lane baselines) but for reset
  purposes only its project-owned keys are touched, so PROJECT_SECTION_KEYS
  is checked before GLOBAL_SECTION_KEYS.
  */
  if (EXCLUDED_RESET_SECTIONS[sectionId]) {
    return null;
  }
  const projectKeys = PROJECT_SECTION_KEYS[sectionId];
  if (projectKeys) {
    return { scope: "project", keys: projectKeys };
  }
  const globalKeys = GLOBAL_SECTION_KEYS[sectionId];
  if (globalKeys) {
    return { scope: "global", keys: Array.from(globalKeys) };
  }
  return null;
}

/** True when a section id has no reset-eligible key set (excluded or unknown/group-header). */
export function isResetEligibleSection(sectionId: string): boolean {
  return getSectionKeyEntry(sectionId) !== null;
}

/** Human-readable reason a section's per-menu reset is disabled, or undefined if it is eligible. */
export function getResetIneligibleReason(sectionId: string): string | undefined {
  return EXCLUDED_RESET_SECTIONS[sectionId];
}

/** Every PROJECT_SETTINGS_KEYS member, used for "reset all project settings". */
export const ALL_PROJECT_RESET_KEYS: readonly string[] = PROJECT_SETTINGS_KEYS;

/** Exposed for tests: validates every registry key against the canonical scope key sets. */
export function isRegistryKeyValidForScope(key: string, scope: SettingsResetScope): boolean {
  if (scope === "global") {
    return (GLOBAL_SETTINGS_KEYS as readonly string[]).includes(key);
  }
  return (PROJECT_SETTINGS_KEYS as readonly string[]).includes(key);
}

export { GLOBAL_SECTION_KEYS, MODEL_LANE_KEYS };
