import { describe, expect, it } from "vitest";
import {
  DEFAULT_GLOBAL_SETTINGS,
  DEFAULT_PROJECT_SETTINGS,
  GLOBAL_SETTINGS_KEYS,
  PROJECT_SETTINGS_KEYS,
  normalizeAutoRecovery,
  isGlobalOnlySettingsKey,
  isGlobalSettingsKey,
  isProjectSettingsKey,
} from "../types.js";
import { BUILTIN_WORKFLOW_SETTINGS } from "../builtin-workflow-settings.js";

function assertExactKeyCoverage(scopeName: string, actual: readonly string[], expected: readonly string[]): void {
  const uniqueActual = [...new Set(actual)];
  const uniqueExpected = [...new Set(expected)];

  const missing = uniqueExpected.filter((key) => !uniqueActual.includes(key));
  const extra = uniqueActual.filter((key) => !uniqueExpected.includes(key));
  const duplicates = actual.filter((key, index) => actual.indexOf(key) !== index);

  if (missing.length > 0 || extra.length > 0 || duplicates.length > 0) {
    throw new Error(
      [
        `${scopeName} parity mismatch`,
        `Missing: ${missing.length ? missing.join(", ") : "(none)"}`,
        `Extra: ${extra.length ? extra.join(", ") : "(none)"}`,
        `Duplicates: ${duplicates.length ? [...new Set(duplicates)].join(", ") : "(none)"}`,
      ].join("\n"),
    );
  }
}

describe("settings key parity", () => {
  it("GLOBAL_SETTINGS_KEYS is derived from the global settings defaults", () => {
    assertExactKeyCoverage(
      "GLOBAL_SETTINGS_KEYS",
      GLOBAL_SETTINGS_KEYS as readonly string[],
      Object.keys(DEFAULT_GLOBAL_SETTINGS),
    );
  });

  it("PROJECT_SETTINGS_KEYS is derived from the project settings defaults", () => {
    assertExactKeyCoverage(
      "PROJECT_SETTINGS_KEYS",
      PROJECT_SETTINGS_KEYS as readonly string[],
      Object.keys(DEFAULT_PROJECT_SETTINGS),
    );
  });

  it("identifies settings scopes", () => {
    expect(isGlobalSettingsKey("themeMode")).toBe(true);
    expect(isGlobalSettingsKey("maxConcurrent")).toBe(false);
    expect(isProjectSettingsKey("maxConcurrent")).toBe(true);
    expect(isProjectSettingsKey("heartbeatMultiplier")).toBe(true);
    expect(isProjectSettingsKey("completionDocumentationMode")).toBe(true);
    expect(isProjectSettingsKey("remoteAccess")).toBe(false);
    expect(isProjectSettingsKey("researchSettings")).toBe(true);
    expect(isGlobalSettingsKey("researchGlobalDefaults")).toBe(true);
    expect(isProjectSettingsKey("mergeRequestContractShadowEnabled")).toBe(true);
    expect(isGlobalSettingsKey("mergeRequestContractShadowEnabled")).toBe(true);
    expect(isProjectSettingsKey("themeMode")).toBe(false);
    expect(isGlobalSettingsKey("remoteAccess")).toBe(true);
    expect(isGlobalSettingsKey("persistAgentToolOutput")).toBe(true);
    expect(isProjectSettingsKey("persistAgentToolOutput")).toBe(false);
    expect(isGlobalSettingsKey("persistAgentThinkingLog")).toBe(true);
    expect(isProjectSettingsKey("persistAgentThinkingLog")).toBe(false);
    expect(isGlobalOnlySettingsKey("persistAgentThinkingLog")).toBe(true);
    expect(isGlobalSettingsKey("persistAgentThinkingLogPermanent")).toBe(true);
    expect(isProjectSettingsKey("persistAgentThinkingLogPermanent")).toBe(false);
    expect(isGlobalOnlySettingsKey("persistAgentThinkingLogPermanent")).toBe(true);
    expect(isGlobalSettingsKey("persistAgentThinkingLogEphemeral")).toBe(true);
    expect(isProjectSettingsKey("persistAgentThinkingLogEphemeral")).toBe(false);
    expect(isGlobalOnlySettingsKey("persistAgentThinkingLogEphemeral")).toBe(true);
    expect(isGlobalSettingsKey("researchSettings")).toBe(false);
    expect(isGlobalSettingsKey("modelPricingOverrides")).toBe(true);
    expect(isGlobalSettingsKey("modelPricingFetchedAt")).toBe(true);
    expect(isGlobalSettingsKey("modelPricingSource")).toBe(true);
    expect(isProjectSettingsKey("modelPricingOverrides")).toBe(false);
    expect(isGlobalSettingsKey("agentMemoryInclusionMode")).toBe(true);
    expect(isProjectSettingsKey("agentMemoryInclusionMode")).toBe(false);
  });

  it("keeps GitLab enablement, URL, and token configuration dual-scoped with blank defaults", () => {
    expect(DEFAULT_GLOBAL_SETTINGS.gitlabEnabled).toBeUndefined();
    expect(DEFAULT_GLOBAL_SETTINGS.gitlabInstanceUrl).toBeUndefined();
    expect(DEFAULT_GLOBAL_SETTINGS.gitlabApiBaseUrl).toBeUndefined();
    expect(DEFAULT_GLOBAL_SETTINGS.gitlabAuthToken).toBeUndefined();
    expect(DEFAULT_GLOBAL_SETTINGS.gitlabAuthTokenType).toBeUndefined();
    expect(DEFAULT_PROJECT_SETTINGS.gitlabEnabled).toBeUndefined();
    expect(DEFAULT_PROJECT_SETTINGS.gitlabInstanceUrl).toBeUndefined();
    expect(DEFAULT_PROJECT_SETTINGS.gitlabApiBaseUrl).toBeUndefined();
    expect(DEFAULT_PROJECT_SETTINGS.gitlabAuthToken).toBeUndefined();
    expect(DEFAULT_PROJECT_SETTINGS.gitlabAuthTokenType).toBeUndefined();
    for (const key of ["gitlabEnabled", "gitlabInstanceUrl", "gitlabApiBaseUrl", "gitlabAuthToken", "gitlabAuthTokenType"] as const) {
      expect(isGlobalSettingsKey(key)).toBe(true);
      expect(isProjectSettingsKey(key)).toBe(true);
      expect(PROJECT_SETTINGS_KEYS).toContain(key);
      expect(GLOBAL_SETTINGS_KEYS).toContain(key);
    }
  });


  it("keeps model-lane thinking overrides in their owning settings scopes", () => {
    expect(DEFAULT_PROJECT_SETTINGS.defaultThinkingLevelOverride).toBeUndefined();
    expect(DEFAULT_PROJECT_SETTINGS.titleSummarizerThinkingLevel).toBeUndefined();
    expect(DEFAULT_PROJECT_SETTINGS.titleSummarizerFallbackThinkingLevel).toBeUndefined();
    expect(DEFAULT_PROJECT_SETTINGS.mergerThinkingLevel).toBeUndefined();
    expect(DEFAULT_PROJECT_SETTINGS.mergerFallbackThinkingLevel).toBeUndefined();
    expect(DEFAULT_GLOBAL_SETTINGS.fallbackThinkingLevel).toBeUndefined();
    expect(DEFAULT_GLOBAL_SETTINGS.executionGlobalThinkingLevel).toBeUndefined();
    expect(DEFAULT_GLOBAL_SETTINGS.planningGlobalThinkingLevel).toBeUndefined();
    expect(DEFAULT_GLOBAL_SETTINGS.validatorGlobalThinkingLevel).toBeUndefined();
    expect(DEFAULT_GLOBAL_SETTINGS.titleSummarizerGlobalThinkingLevel).toBeUndefined();
    expect(DEFAULT_GLOBAL_SETTINGS.mergerGlobalThinkingLevel).toBeUndefined();

    expect(isProjectSettingsKey("defaultThinkingLevelOverride")).toBe(true);
    expect(isProjectSettingsKey("titleSummarizerThinkingLevel")).toBe(true);
    expect(isProjectSettingsKey("titleSummarizerFallbackThinkingLevel")).toBe(true);
    expect(isProjectSettingsKey("mergerThinkingLevel")).toBe(true);
    expect(isProjectSettingsKey("mergerFallbackThinkingLevel")).toBe(true);
    expect(isGlobalSettingsKey("fallbackThinkingLevel")).toBe(true);
    expect(isProjectSettingsKey("planningFallbackThinkingLevel")).toBe(false);
    expect(isGlobalSettingsKey("planningFallbackThinkingLevel")).toBe(false);
    expect(isProjectSettingsKey("validatorFallbackThinkingLevel")).toBe(false);
    expect(isGlobalSettingsKey("validatorFallbackThinkingLevel")).toBe(false);
    expect(isGlobalSettingsKey("executionGlobalThinkingLevel")).toBe(true);
    expect(isGlobalSettingsKey("planningGlobalThinkingLevel")).toBe(true);
    expect(isGlobalSettingsKey("validatorGlobalThinkingLevel")).toBe(true);
    expect(isGlobalSettingsKey("titleSummarizerGlobalThinkingLevel")).toBe(true);
    expect(isGlobalSettingsKey("mergerGlobalThinkingLevel")).toBe(true);
  });

  it("defaults persisted thinking logs to disabled", () => {
    expect(DEFAULT_GLOBAL_SETTINGS.persistAgentThinkingLog).toBe(false);
    expect(DEFAULT_GLOBAL_SETTINGS.persistAgentThinkingLogPermanent).toBe(false);
    expect(DEFAULT_GLOBAL_SETTINGS.persistAgentThinkingLogEphemeral).toBe(false);
  });

  it("includes heartbeatMultiplier in project defaults", () => {
    expect(DEFAULT_PROJECT_SETTINGS.heartbeatMultiplier).toBe(1);
  });

  it("defaults hidden overlap path filtering on and keeps it project-scoped", () => {
    expect(DEFAULT_PROJECT_SETTINGS.ignoreHiddenOverlapPaths).toBe(true);
    expect(isProjectSettingsKey("ignoreHiddenOverlapPaths")).toBe(true);
    expect(isGlobalSettingsKey("ignoreHiddenOverlapPaths")).toBe(false);
    expect(PROJECT_SETTINGS_KEYS).toContain("ignoreHiddenOverlapPaths");
  });

  it("defaults absolute file-browser paths off and keeps it project-scoped", () => {
    expect(DEFAULT_PROJECT_SETTINGS.allowAbsoluteFileBrowserPaths).toBe(false);
    expect(isProjectSettingsKey("allowAbsoluteFileBrowserPaths")).toBe(true);
    expect(isGlobalSettingsKey("allowAbsoluteFileBrowserPaths")).toBe(false);
    expect(PROJECT_SETTINGS_KEYS).toContain("allowAbsoluteFileBrowserPaths");
    expect(GLOBAL_SETTINGS_KEYS).not.toContain("allowAbsoluteFileBrowserPaths");
  });

  it("defaults autoClaimCandidatesInPrompt to 5 and keeps it project-scoped", () => {
    expect(DEFAULT_PROJECT_SETTINGS.autoClaimCandidatesInPrompt).toBe(5);
    expect(isProjectSettingsKey("autoClaimCandidatesInPrompt")).toBe(true);
    expect(isGlobalSettingsKey("autoClaimCandidatesInPrompt")).toBe(false);
  });

  it("defaults task chats out of the common feed and keeps the opt-in project-scoped", () => {
    expect(DEFAULT_PROJECT_SETTINGS.showTaskChatsInCommonFeed).toBe(false);
    expect(isProjectSettingsKey("showTaskChatsInCommonFeed")).toBe(true);
    expect(isGlobalSettingsKey("showTaskChatsInCommonFeed")).toBe(false);
    expect(PROJECT_SETTINGS_KEYS).toContain("showTaskChatsInCommonFeed");
    expect(GLOBAL_SETTINGS_KEYS).not.toContain("showTaskChatsInCommonFeed");
  });

  it("defaults chatAutoCleanupDays to off and keeps it project-scoped", () => {
    expect(DEFAULT_PROJECT_SETTINGS.chatAutoCleanupDays).toBe(0);
    expect(isProjectSettingsKey("chatAutoCleanupDays")).toBe(true);
    expect(isGlobalSettingsKey("chatAutoCleanupDays")).toBe(false);
  });

  it("keeps Direct-chat default target settings project-scoped with unset defaults", () => {
    const chatDefaultKeys = [
      "chatNewSessionMode",
      "chatDefaultKind",
      "chatDefaultAgentId",
      "chatDefaultModelProvider",
      "chatDefaultModelId",
      "chatDefaultThinkingLevel",
    ] as const;

    for (const key of chatDefaultKeys) {
      expect(DEFAULT_PROJECT_SETTINGS[key]).toBeUndefined();
      expect(isProjectSettingsKey(key)).toBe(true);
      expect(PROJECT_SETTINGS_KEYS).toContain(key);
      expect(isGlobalSettingsKey(key)).toBe(false);
      expect(isGlobalOnlySettingsKey(key)).toBe(false);
      expect(GLOBAL_SETTINGS_KEYS).not.toContain(key);
    }
  });

  it("keeps room compaction defaults project-scoped with expanded retention", () => {
    expect(DEFAULT_PROJECT_SETTINGS.chatRoomRecentVerbatimMessages).toBe(25);
    expect(DEFAULT_PROJECT_SETTINGS.chatRoomCompactionFetchLimit).toBe(200);
    expect(DEFAULT_PROJECT_SETTINGS.chatRoomSummaryMaxChars).toBe(3_000);
    expect(isProjectSettingsKey("chatRoomRecentVerbatimMessages")).toBe(true);
    expect(isProjectSettingsKey("chatRoomCompactionFetchLimit")).toBe(true);
    expect(isProjectSettingsKey("chatRoomSummaryMaxChars")).toBe(true);
    expect(isGlobalSettingsKey("chatRoomRecentVerbatimMessages")).toBe(false);
    expect(isGlobalSettingsKey("chatRoomCompactionFetchLimit")).toBe(false);
    expect(isGlobalSettingsKey("chatRoomSummaryMaxChars")).toBe(false);
  });

  it("defaults mailAutoCleanupDays to off and keeps it project-scoped", () => {
    expect(DEFAULT_PROJECT_SETTINGS.mailAutoCleanupDays).toBe(0);
    expect(isProjectSettingsKey("mailAutoCleanupDays")).toBe(true);
    expect(isGlobalSettingsKey("mailAutoCleanupDays")).toBe(false);
    expect(PROJECT_SETTINGS_KEYS).toContain("mailAutoCleanupDays");
  });

  it("defaults operationalLogRetentionDays to 30 and keeps it project-scoped", () => {
    expect(DEFAULT_PROJECT_SETTINGS.operationalLogRetentionDays).toBe(30);
    expect(isProjectSettingsKey("operationalLogRetentionDays")).toBe(true);
    expect(isGlobalSettingsKey("operationalLogRetentionDays")).toBe(false);
    expect(PROJECT_SETTINGS_KEYS).toContain("operationalLogRetentionDays");
  });

  it("keeps heartbeatScopeDiscipline project-scoped with strict default", () => {
    expect(DEFAULT_PROJECT_SETTINGS.heartbeatScopeDiscipline).toBe("strict");
    expect(isProjectSettingsKey("heartbeatScopeDiscipline")).toBe(true);
    expect(isGlobalSettingsKey("heartbeatScopeDiscipline")).toBe(false);
  });

  it("keeps heartbeatPromptTemplate project-scoped with default default", () => {
    expect(DEFAULT_PROJECT_SETTINGS.heartbeatPromptTemplate).toBe("default");
    expect(isProjectSettingsKey("heartbeatPromptTemplate")).toBe(true);
    expect(isGlobalSettingsKey("heartbeatPromptTemplate")).toBe(false);
  });

  it("documents autoClaimCandidatesInPrompt expected integer range", () => {
    const inRange = [0, 1, 5, 10];
    const outOfRange = [-1, 11, 100];

    expect(inRange.every((value) => Number.isInteger(value) && value >= 0 && value <= 10)).toBe(true);
    expect(outOfRange.every((value) => Number.isInteger(value) && value >= 0 && value <= 10)).toBe(false);
  });

  it("defaults sibling branch rename escape hatch to disabled", () => {
    expect(DEFAULT_PROJECT_SETTINGS.executorAllowSiblingBranchRename).toBe(false);
    expect(isProjectSettingsKey("executorAllowSiblingBranchRename")).toBe(true);
    expect(isGlobalSettingsKey("executorAllowSiblingBranchRename")).toBe(false);
  });

  it("defaults ephemeralAgentsEnabled to true and keeps it project-scoped", () => {
    expect(DEFAULT_PROJECT_SETTINGS.ephemeralAgentsEnabled).toBe(true);
    expect(isProjectSettingsKey("ephemeralAgentsEnabled")).toBe(true);
    expect(isGlobalSettingsKey("ephemeralAgentsEnabled")).toBe(false);
  });

  it("defaults ephemeralAgentsCanCreateTasks to true and keeps it project-scoped", () => {
    expect(DEFAULT_PROJECT_SETTINGS.ephemeralAgentsCanCreateTasks).toBe(true);
    expect(isProjectSettingsKey("ephemeralAgentsCanCreateTasks")).toBe(true);
    expect(isGlobalSettingsKey("ephemeralAgentsCanCreateTasks")).toBe(false);
  });

  it("defaults completionDocumentationMode to off", () => {
    expect(DEFAULT_PROJECT_SETTINGS.completionDocumentationMode).toBe("off");
  });

  it("defaults directMergeCommitStrategy to always-squash and keeps it project-scoped", () => {
    expect(DEFAULT_PROJECT_SETTINGS.directMergeCommitStrategy).toBe("always-squash");
    expect(isProjectSettingsKey("directMergeCommitStrategy")).toBe(true);
    expect(isGlobalSettingsKey("directMergeCommitStrategy")).toBe(false);
  });

  it("defaults mergeAdvanceAutoSync to stash-and-ff and keeps it project-scoped", () => {
    expect(DEFAULT_PROJECT_SETTINGS.mergeAdvanceAutoSync).toBe("stash-and-ff");
    expect(isProjectSettingsKey("mergeAdvanceAutoSync")).toBe(true);
    expect(isGlobalSettingsKey("mergeAdvanceAutoSync")).toBe(false);
  });

  it("keeps integrationBranch project-scoped", () => {
    expect(DEFAULT_PROJECT_SETTINGS.integrationBranch).toBeUndefined();
    expect(isProjectSettingsKey("integrationBranch")).toBe(true);
    expect(isGlobalSettingsKey("integrationBranch")).toBe(false);
    expect(PROJECT_SETTINGS_KEYS).toContain("integrationBranch");
  });

  it("keeps task stuck timeout active by default without coupling to workflow step timeout", () => {
    expect(DEFAULT_PROJECT_SETTINGS.taskStuckTimeoutMs).toBe(600_000);
    expect(DEFAULT_PROJECT_SETTINGS.dispatchOscillationThreshold).toBe(5);
    expect(DEFAULT_PROJECT_SETTINGS.dispatchOscillationWindowMs).toBe(60_000);
    expect(DEFAULT_PROJECT_SETTINGS.dispatchOscillationSettleMs).toBe(5_000);
    expect(DEFAULT_PROJECT_SETTINGS.runtimeStopDrainMs).toBe(2_000);
    expect(isProjectSettingsKey("dispatchOscillationThreshold")).toBe(true);
    expect(isProjectSettingsKey("dispatchOscillationWindowMs")).toBe(true);
    expect(isProjectSettingsKey("dispatchOscillationSettleMs")).toBe(true);
    // workflowStepTimeoutMs MOVED to workflow settings (U4) — no longer a project key.
    expect(isProjectSettingsKey("workflowStepTimeoutMs")).toBe(false);
    expect(PROJECT_SETTINGS_KEYS).not.toContain("workflowStepTimeoutMs");
  });

  it("removes the moved settings keys (U4 hard-move) from the project scope", () => {
    const movedKeys = [
      "workflowStepTimeoutMs",
      "workflowStepScopeEnforcement",
      "planOnlyScopeLeakEnforcement",
      "workflowRevisionForkOnScopeMismatch",
      "strictScopeEnforcement",
      "runStepsInNewSessions",
      "maxParallelSteps",
      "buildRetryCount",
      "verificationFixRetries",
      "maxPostReviewFixes",
      "requirePrApproval",
      "requirePlanApproval",
      "reviewHandoffPolicy",
      "maxReviewerContextRetries",
      "maxReviewerFallbackRetries",
      "reflectionEnabled",
      "executionProvider",
      "executionModelId",
      "planningProvider",
      "planningModelId",
      "planningFallbackProvider",
      "planningFallbackModelId",
      "planningFallbackThinkingLevel",
      "validatorProvider",
      "validatorModelId",
      "validatorFallbackProvider",
      "validatorFallbackModelId",
      "validatorFallbackThinkingLevel",
    ];
    for (const key of movedKeys) {
      expect(isProjectSettingsKey(key)).toBe(false);
      expect(PROJECT_SETTINGS_KEYS).not.toContain(key);
      expect(isGlobalSettingsKey(key)).toBe(false);
    }
  });

  it("keeps buildTimeoutMs / reflectionIntervalMs / reflectionAfterTask project-scoped (NOT moved)", () => {
    expect(isProjectSettingsKey("buildTimeoutMs")).toBe(true);
    expect(isProjectSettingsKey("reflectionIntervalMs")).toBe(true);
    expect(isProjectSettingsKey("reflectionAfterTask")).toBe(true);
    expect(DEFAULT_PROJECT_SETTINGS.buildTimeoutMs).toBe(300_000);
  });

  it("defaults engine activation grace and leaves engine active clock undefined", () => {
    expect(DEFAULT_PROJECT_SETTINGS.engineActivationGraceMs).toBe(300_000);
    expect(DEFAULT_PROJECT_SETTINGS.engineActiveSinceMs).toBeUndefined();
  });

  it("defaults autoRecovery and normalizes overrides", () => {
    expect(DEFAULT_PROJECT_SETTINGS.autoRecovery).toEqual({ mode: "deterministic-only", maxRetries: 3 });
    expect(normalizeAutoRecovery({ mode: "off", perClass: { "branch-conflict-unrecoverable": "ai-assisted" }, maxRetries: 2 })).toEqual({
      mode: "off",
      perClass: { "branch-conflict-unrecoverable": "ai-assisted" },
      maxRetries: 2,
    });
    expect(normalizeAutoRecovery({ mode: "invalid" })).toEqual({ mode: "deterministic-only", perClass: undefined, maxRetries: 3 });
  });

  it("keeps OpenRouter advanced sync/routing settings global with undefined defaults", () => {
    expect(DEFAULT_GLOBAL_SETTINGS.openrouterAppAttribution).toBeUndefined();
    expect(DEFAULT_GLOBAL_SETTINGS.openrouterModelFilters).toBeUndefined();
    expect(DEFAULT_GLOBAL_SETTINGS.openrouterProviderPreferences).toBeUndefined();
    expect(isGlobalSettingsKey("openrouterAppAttribution")).toBe(true);
    expect(isGlobalSettingsKey("openrouterModelFilters")).toBe(true);
    expect(isGlobalSettingsKey("openrouterProviderPreferences")).toBe(true);
    expect(isProjectSettingsKey("openrouterAppAttribution")).toBe(false);
    expect(isProjectSettingsKey("openrouterModelFilters")).toBe(false);
    expect(isProjectSettingsKey("openrouterProviderPreferences")).toBe(false);
  });

  it("defaults stale high fan-out blocker escalation age threshold", () => {
    expect(DEFAULT_PROJECT_SETTINGS.staleHighFanoutBlockerAgeThresholdMs).toBe(2 * 60 * 60 * 1000);
    expect(isProjectSettingsKey("staleHighFanoutBlockerAgeThresholdMs")).toBe(true);
    expect(isGlobalSettingsKey("staleHighFanoutBlockerAgeThresholdMs")).toBe(false);
  });

  it("keeps capacity risk banner toggle project-scoped with off default", () => {
    expect(DEFAULT_PROJECT_SETTINGS.capacityRiskBannerEnabled).toBe(false);
    expect(isProjectSettingsKey("capacityRiskBannerEnabled")).toBe(true);
    expect(isGlobalSettingsKey("capacityRiskBannerEnabled")).toBe(false);
  });

  it("keeps backlog pressure alert settings project-scoped with documented defaults", () => {
    expect(DEFAULT_PROJECT_SETTINGS.backlogPressureAlertEnabled).toBe(true);
    expect(DEFAULT_PROJECT_SETTINGS.backlogPressureRatioThreshold).toBe(10);
    expect(DEFAULT_PROJECT_SETTINGS.backlogPressureMinTodoCount).toBe(5);
    expect(DEFAULT_PROJECT_SETTINGS.backlogPressureAlertCooldownMs).toBe(24 * 60 * 60_000);

    expect(PROJECT_SETTINGS_KEYS).toContain("backlogPressureAlertEnabled");
    expect(PROJECT_SETTINGS_KEYS).toContain("backlogPressureRatioThreshold");
    expect(PROJECT_SETTINGS_KEYS).toContain("backlogPressureMinTodoCount");
    expect(PROJECT_SETTINGS_KEYS).toContain("backlogPressureAlertCooldownMs");

    expect(isProjectSettingsKey("backlogPressureAlertEnabled")).toBe(true);
    expect(isProjectSettingsKey("backlogPressureRatioThreshold")).toBe(true);
    expect(isProjectSettingsKey("backlogPressureMinTodoCount")).toBe(true);
    expect(isProjectSettingsKey("backlogPressureAlertCooldownMs")).toBe(true);

    expect(isGlobalSettingsKey("backlogPressureAlertEnabled")).toBe(false);
    expect(isGlobalSettingsKey("backlogPressureRatioThreshold")).toBe(false);
    expect(isGlobalSettingsKey("backlogPressureMinTodoCount")).toBe(false);
    expect(isGlobalSettingsKey("backlogPressureAlertCooldownMs")).toBe(false);
  });

  it("keeps dependency-blocked todo report settings project-scoped with documented defaults", () => {
    expect(DEFAULT_PROJECT_SETTINGS.dependencyBlockedTodoReportEnabled).toBe(true);
    expect(DEFAULT_PROJECT_SETTINGS.dependencyBlockedTodoFreshAgeMs).toBe(30 * 60_000);
    expect(DEFAULT_PROJECT_SETTINGS.dependencyBlockedTodoStaleAgeMs).toBe(4 * 60 * 60_000);
    expect(DEFAULT_PROJECT_SETTINGS.dependencyBlockedTodoMinCount).toBe(1);
    expect(DEFAULT_PROJECT_SETTINGS.dependencyBlockedTodoReportCooldownMs).toBe(6 * 60 * 60_000);

    expect(PROJECT_SETTINGS_KEYS).toContain("dependencyBlockedTodoReportEnabled");
    expect(PROJECT_SETTINGS_KEYS).toContain("dependencyBlockedTodoFreshAgeMs");
    expect(PROJECT_SETTINGS_KEYS).toContain("dependencyBlockedTodoStaleAgeMs");
    expect(PROJECT_SETTINGS_KEYS).toContain("dependencyBlockedTodoMinCount");
    expect(PROJECT_SETTINGS_KEYS).toContain("dependencyBlockedTodoReportCooldownMs");

    expect(isProjectSettingsKey("dependencyBlockedTodoReportEnabled")).toBe(true);
    expect(isProjectSettingsKey("dependencyBlockedTodoFreshAgeMs")).toBe(true);
    expect(isProjectSettingsKey("dependencyBlockedTodoStaleAgeMs")).toBe(true);
    expect(isProjectSettingsKey("dependencyBlockedTodoMinCount")).toBe(true);
    expect(isProjectSettingsKey("dependencyBlockedTodoReportCooldownMs")).toBe(true);

    expect(isGlobalSettingsKey("dependencyBlockedTodoReportEnabled")).toBe(false);
    expect(isGlobalSettingsKey("dependencyBlockedTodoFreshAgeMs")).toBe(false);
    expect(isGlobalSettingsKey("dependencyBlockedTodoStaleAgeMs")).toBe(false);
    expect(isGlobalSettingsKey("dependencyBlockedTodoMinCount")).toBe(false);
    expect(isGlobalSettingsKey("dependencyBlockedTodoReportCooldownMs")).toBe(false);
  });

  it("keeps github tracking keys in expected scopes with documented defaults", () => {
    expect(DEFAULT_PROJECT_SETTINGS.githubTrackingEnabledByDefault).toBe(false);
    expect(DEFAULT_PROJECT_SETTINGS.sessionAdvisorEnabledByDefault).toBe(false);
    expect(DEFAULT_PROJECT_SETTINGS.githubLinkImportedIssuesToTracking).toBe(false);
    expect(DEFAULT_PROJECT_SETTINGS.githubTrackingDefaultRepo).toBeUndefined();
    expect(DEFAULT_PROJECT_SETTINGS.githubAuthMode).toBe("gh-cli");
    expect(DEFAULT_PROJECT_SETTINGS.githubAuthToken).toBeUndefined();
    expect(DEFAULT_GLOBAL_SETTINGS.githubTrackingDefaultRepo).toBeUndefined();

    expect(isProjectSettingsKey("githubTrackingEnabledByDefault")).toBe(true);
    expect(isGlobalSettingsKey("githubTrackingEnabledByDefault")).toBe(false);
    expect(isProjectSettingsKey("sessionAdvisorEnabledByDefault")).toBe(true);
    expect(isGlobalSettingsKey("sessionAdvisorEnabledByDefault")).toBe(false);
    expect(isProjectSettingsKey("githubLinkImportedIssuesToTracking")).toBe(true);
    expect(isGlobalSettingsKey("githubLinkImportedIssuesToTracking")).toBe(false);
    expect(isGlobalOnlySettingsKey("githubLinkImportedIssuesToTracking")).toBe(false);
    expect(isProjectSettingsKey("githubAuthMode")).toBe(true);
    expect(isGlobalSettingsKey("githubAuthMode")).toBe(false);
    expect(isProjectSettingsKey("githubAuthToken")).toBe(true);
    expect(isGlobalSettingsKey("githubAuthToken")).toBe(false);
    expect(isProjectSettingsKey("githubTrackingDefaultRepo")).toBe(true);
    expect(isGlobalSettingsKey("githubTrackingDefaultRepo")).toBe(true);
    expect(isGlobalOnlySettingsKey("githubTrackingDefaultRepo")).toBe(false);
    expect(isGlobalOnlySettingsKey("themeMode")).toBe(true);
  });

  it("keeps remoteAccess scoped to global settings only", () => {
    const globalKeys = GLOBAL_SETTINGS_KEYS as readonly string[];
    const projectKeys = PROJECT_SETTINGS_KEYS as readonly string[];

    expect(projectKeys).not.toContain("remoteAccess");
    expect(globalKeys).toContain("remoteAccess");
    expect(DEFAULT_GLOBAL_SETTINGS.remoteAccess).toBeDefined();
    expect((DEFAULT_PROJECT_SETTINGS as Record<string, unknown>).remoteAccess).toBeUndefined();
  });

  it("keeps experimentalFeatures scoped to global settings only", () => {
    const globalKeys = GLOBAL_SETTINGS_KEYS as readonly string[];
    const projectKeys = PROJECT_SETTINGS_KEYS as readonly string[];

    expect(projectKeys).not.toContain("experimentalFeatures");
    expect(globalKeys).toContain("experimentalFeatures");
    expect(DEFAULT_GLOBAL_SETTINGS.experimentalFeatures).toBeDefined();
    expect((DEFAULT_PROJECT_SETTINGS as Record<string, unknown>).experimentalFeatures).toBeUndefined();
  });

  it("keeps dashboard keyboard shortcuts scoped to global settings only", () => {
    const globalKeys = GLOBAL_SETTINGS_KEYS as readonly string[];
    const projectKeys = PROJECT_SETTINGS_KEYS as readonly string[];

    expect(projectKeys).not.toContain("dashboardKeyboardShortcuts");
    expect(globalKeys).toContain("dashboardKeyboardShortcuts");
    expect(DEFAULT_GLOBAL_SETTINGS.dashboardKeyboardShortcuts).toEqual({ quickChat: "Space", terminal: "Ctrl+`", openFiles: "Ctrl+E", openSettings: "Ctrl+,", openCommandCenter: "Ctrl+K", newTask: "Ctrl+Shift+N" });
    expect((DEFAULT_PROJECT_SETTINGS as Record<string, unknown>).dashboardKeyboardShortcuts).toBeUndefined();
  });

  it("only intentional shared keys appear in both global and project scopes", () => {
    const projectKeySet = new Set(PROJECT_SETTINGS_KEYS as readonly string[]);
    const overlap = (GLOBAL_SETTINGS_KEYS as readonly string[]).filter((key) => projectKeySet.has(key));
    // FNXC:SettingsScopeParity 2026-06-26-17:35:
    // mcpServers is intentionally dual-scoped (FN-7077, "inject configured MCP servers across
    // agent surfaces"): a global default applies to every project while a project override
    // tailors the MCP server set per project. GitLab enablement/URL settings are dual-scoped
    // (FN-7422/FN-7453) so operators can set an organization-wide default while individual
    // projects can override active state, hosts, or API prefixes; GitLab token settings are
    // dual-scoped (FN-7423) so projects can override global fallback credentials without
    // treating project/group tokens as globally authorized. Keep this allow-list in
    // GLOBAL_SETTINGS_KEYS order.
    expect(overlap).toEqual([
      "testMode",
      "mergeRequestContractShadowEnabled",
      "taskTokenBudget",
      "githubTrackingDefaultRepo",
      "gitlabEnabled",
      "gitlabInstanceUrl",
      "gitlabApiBaseUrl",
      "gitlabAuthToken",
      "gitlabAuthTokenType",
      "mcpServers",
      "worktrunk",
      "owningNodeHandoffPolicy",
    ]);
  });
});

// ── Model Lane Key Parity Regression Tests (FN-1729) ────────────────────────

describe("research global key parity regression (FN-3313)", () => {
  const globalResearchFlatKeys = [
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
  ] as const;

  it.each(globalResearchFlatKeys)("%s is global-scoped only", (key) => {
    expect(isGlobalSettingsKey(key)).toBe(true);
    expect(isProjectSettingsKey(key)).toBe(false);
  });
});

// ── Model Lane Key Parity Regression Tests (FN-1729) ────────────────────────

describe("eval settings parity regression (FN-3393)", () => {
  it("keeps evalSettings project-scoped with expected defaults", () => {
    expect(isProjectSettingsKey("evalSettings")).toBe(true);
    expect(isGlobalSettingsKey("evalSettings")).toBe(false);

    expect(DEFAULT_PROJECT_SETTINGS.evalSettings).toEqual({
      enabled: false,
      intervalMs: 86_400_000,
      evaluatorProvider: undefined,
      evaluatorModelId: undefined,
      followUpPolicy: "suggest-only",
      retentionDays: 30,
    });
  });
});

describe("model lane key parity regression (FN-1729)", () => {
  // All model lane provider/modelId pairs that should exist.
  //
  // U4 hard-move moved the execution/planning/validator project lanes (plus
  // their fallbacks) to workflow settings. The title-summarizer lane was later
  // restored to project settings, while GLOBAL baseline lanes (`*GlobalProvider`)
  // and the default/fallback baseline remain global.
  const allModelLanePairs = [
    // Default baseline (global only)
    { provider: "defaultProvider", modelId: "defaultModelId", expectedScope: "global" },
    // Fallback baseline (global only)
    { provider: "fallbackProvider", modelId: "fallbackModelId", expectedScope: "global" },
    // Execution lane
    { provider: "executionProvider", modelId: "executionModelId", expectedScope: "workflow" },
    { provider: "executionGlobalProvider", modelId: "executionGlobalModelId", expectedScope: "global" },
    // Planning lane
    { provider: "planningProvider", modelId: "planningModelId", expectedScope: "workflow" },
    { provider: "planningGlobalProvider", modelId: "planningGlobalModelId", expectedScope: "global" },
    { provider: "planningFallbackProvider", modelId: "planningFallbackModelId", expectedScope: "workflow" },
    // Validator lane
    { provider: "validatorProvider", modelId: "validatorModelId", expectedScope: "workflow" },
    { provider: "validatorGlobalProvider", modelId: "validatorGlobalModelId", expectedScope: "global" },
    { provider: "validatorFallbackProvider", modelId: "validatorFallbackModelId", expectedScope: "workflow" },
    // Summarizer lane
    { provider: "titleSummarizerProvider", modelId: "titleSummarizerModelId", expectedScope: "project" },
    { provider: "titleSummarizerGlobalProvider", modelId: "titleSummarizerGlobalModelId", expectedScope: "global" },
    { provider: "titleSummarizerFallbackProvider", modelId: "titleSummarizerFallbackModelId", expectedScope: "project" },
    // Merger lane (project-scoped like summarizer; not workflow-moved)
    { provider: "mergerProvider", modelId: "mergerModelId", expectedScope: "project" },
    { provider: "mergerFallbackProvider", modelId: "mergerFallbackModelId", expectedScope: "project" },
    { provider: "mergerGlobalProvider", modelId: "mergerGlobalModelId", expectedScope: "global" },
  ] as const;

  it.each(allModelLanePairs)(
    "$provider/$modelId is correctly classified as $expectedScope scope",
    ({ provider, modelId, expectedScope }) => {
      if (expectedScope === "global") {
        expect(isGlobalSettingsKey(provider)).toBe(true);
        expect(isGlobalSettingsKey(modelId)).toBe(true);
        expect(isProjectSettingsKey(provider)).toBe(false);
        expect(isProjectSettingsKey(modelId)).toBe(false);
      } else if (expectedScope === "workflow") {
        // Moved to workflow settings — absent from BOTH scope key lists.
        expect(isGlobalSettingsKey(provider)).toBe(false);
        expect(isGlobalSettingsKey(modelId)).toBe(false);
        expect(isProjectSettingsKey(provider)).toBe(false);
        expect(isProjectSettingsKey(modelId)).toBe(false);
      } else {
        expect(isProjectSettingsKey(provider)).toBe(true);
        expect(isProjectSettingsKey(modelId)).toBe(true);
        expect(isGlobalSettingsKey(provider)).toBe(false);
        expect(isGlobalSettingsKey(modelId)).toBe(false);
      }
    },
  );

  it("does not declare title summarizer keys as built-in workflow settings", () => {
    const declaredIds = BUILTIN_WORKFLOW_SETTINGS.map((setting) => setting.id);
    expect(declaredIds.filter((id) => /^titleSummarizer/.test(id))).toEqual([]);
  });

  it("scoped (non-workflow) model lane keys appear in exactly one scope key list", () => {
    const globalKeys = new Set(GLOBAL_SETTINGS_KEYS as readonly string[]);
    const projectKeys = new Set(PROJECT_SETTINGS_KEYS as readonly string[]);

    for (const { provider, modelId, expectedScope } of allModelLanePairs) {
      if (expectedScope === "workflow") {
        // Workflow-scoped lanes are in neither list.
        expect(globalKeys.has(provider) || projectKeys.has(provider)).toBe(false);
        expect(globalKeys.has(modelId) || projectKeys.has(modelId)).toBe(false);
        continue;
      }
      const inGlobal = globalKeys.has(provider) && globalKeys.has(modelId);
      const inProject = projectKeys.has(provider) && projectKeys.has(modelId);
      expect(inGlobal || inProject).toBe(true);
      expect(inGlobal && inProject).toBe(false);
    }
  });

  it("all global model lane keys are in GLOBAL_SETTINGS_KEYS", () => {
    const globalKeys = new Set(GLOBAL_SETTINGS_KEYS as readonly string[]);

    const globalLanes = allModelLanePairs
      .filter((p) => p.expectedScope === "global")
      .flatMap((p) => [p.provider, p.modelId]);

    for (const key of globalLanes) {
      expect(globalKeys.has(key)).toBe(true);
    }
  });

  it("moved (workflow) model lane keys are in NEITHER scope key list", () => {
    const allKeys = new Set([...GLOBAL_SETTINGS_KEYS, ...PROJECT_SETTINGS_KEYS] as readonly string[]);
    const workflowLanes = allModelLanePairs
      .filter((p) => p.expectedScope === "workflow")
      .flatMap((p) => [p.provider, p.modelId]);

    for (const key of workflowLanes) {
      expect(allKeys.has(key)).toBe(false);
    }
  });

  it("default override keys are in project scope", () => {
    expect(isProjectSettingsKey("defaultProviderOverride")).toBe(true);
    expect(isProjectSettingsKey("defaultModelIdOverride")).toBe(true);
    expect(isGlobalSettingsKey("defaultProviderOverride")).toBe(false);
    expect(isGlobalSettingsKey("defaultModelIdOverride")).toBe(false);
  });

  it("testMode key is recognized in both project and global scopes", () => {
    expect(isProjectSettingsKey("testMode")).toBe(true);
    expect(isGlobalSettingsKey("testMode")).toBe(true);
  });

  it("no model lane provider exists without its corresponding modelId key", () => {
    const allKeys = new Set([...GLOBAL_SETTINGS_KEYS, ...PROJECT_SETTINGS_KEYS]);

    for (const { provider, modelId } of allModelLanePairs) {
      // Both must exist or neither should exist
      const hasProvider = allKeys.has(provider);
      const hasModelId = allKeys.has(modelId);
      expect(hasProvider).toBe(hasModelId);
    }
  });
});
