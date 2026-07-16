import { afterEach, describe, expect, it, vi } from "vitest";
import { CONSECUTIVE_TOOL_FAILURE_RETRY_THRESHOLD, DEFAULT_CONSECUTIVE_TOOL_FAILURE_RETRY_BACKOFF_MS, DEFAULT_MAX_CONSECUTIVE_TOOL_FAILURE_RETRIES, DEFAULT_MAX_AUTO_MERGE_RETRIES, resolveConsecutiveToolFailureRetryBackoffMs, resolveConsecutiveToolFailureThreshold, resolveExecutorEscalationTarget, resolveMaxAutoMergeRetries, resolveMaxConsecutiveToolFailureRetries } from "../in-review-stall.js";
import { isExperimentalFeatureEnabled } from "../experimental-features.js";
import { DEFAULT_GLOBAL_SETTINGS, DEFAULT_PROJECT_SETTINGS, GLOBAL_SETTINGS_KEYS, PROJECT_SETTINGS_KEYS, isGlobalOnlySettingsKey } from "../settings-schema.js";
import { isWorkflowColumnsEnabled } from "../workflow-columns-settings.js";
import {
  __resetLegacyCwdMainWarningForTests,
  normalizeMergeIntegrationWorktreeMode,
} from "../types.js";
import {
  resolveWorktrunkSettings,
  requiresWorktrunkInstallVerification,
  validateWorktrunkSettings,
} from "../worktrunk-settings.js";

describe("settings defaults invariants", () => {
  afterEach(() => {
    __resetLegacyCwdMainWarningForTests();
    vi.restoreAllMocks();
  });

  it("keeps worktrunk default off in global and project defaults", () => {
    expect(DEFAULT_GLOBAL_SETTINGS.worktrunk.enabled).toBe(false);
    expect(DEFAULT_PROJECT_SETTINGS.worktrunk.enabled).toBe(false);
  });

  it("keeps project worktreesDir unset by default", () => {
    expect(DEFAULT_PROJECT_SETTINGS.worktreesDir).toBeUndefined();
  });

  it("defaults dashboard keyboard shortcuts globally", () => {
    expect(DEFAULT_GLOBAL_SETTINGS.dashboardKeyboardShortcuts).toEqual({
      quickChat: "Space",
      terminal: "Ctrl+`",
      openFiles: "Ctrl+E",
      openSettings: "Ctrl+,",
      openCommandCenter: "Ctrl+K",
      newTask: "Ctrl+Shift+N",
    });
    expect(GLOBAL_SETTINGS_KEYS).toContain("dashboardKeyboardShortcuts");
    expect(PROJECT_SETTINGS_KEYS).not.toContain("dashboardKeyboardShortcuts");
    expect("dashboardKeyboardShortcuts" in DEFAULT_PROJECT_SETTINGS).toBe(false);
  });

  it("graduates workflow runtime defaults out of experimental flags", () => {
    expect(DEFAULT_GLOBAL_SETTINGS.experimentalFeatures.workflowColumns).toBeUndefined();
    expect(DEFAULT_GLOBAL_SETTINGS.experimentalFeatures.workflowGraphExecutor).toBeUndefined();
    expect(DEFAULT_GLOBAL_SETTINGS.experimentalFeatures.workflowInterpreterDualObserve).toBe(false);
    expect(isExperimentalFeatureEnabled(undefined, "workflowColumns")).toBe(false);
    expect(isExperimentalFeatureEnabled(undefined, "workflowGraphExecutor")).toBe(false);
    expect(isExperimentalFeatureEnabled(undefined, "workflowInterpreterDualObserve")).toBe(false);
    expect(isExperimentalFeatureEnabled({ experimentalFeatures: { workflowInterpreterDualObserve: true } }, "workflowInterpreterDualObserve")).toBe(false);
    expect(isWorkflowColumnsEnabled({ experimentalFeatures: { workflowColumns: false } })).toBe(true);
  });

  it("defaults maxAutoMergeRetries to the historical project-scoped cap", () => {
    expect(DEFAULT_PROJECT_SETTINGS.maxAutoMergeRetries).toBe(DEFAULT_MAX_AUTO_MERGE_RETRIES);
    expect("maxAutoMergeRetries" in DEFAULT_GLOBAL_SETTINGS).toBe(false);
    expect(resolveMaxAutoMergeRetries(undefined)).toBe(3);
    expect(resolveMaxAutoMergeRetries({ maxAutoMergeRetries: 1 })).toBe(1);
    expect(resolveMaxAutoMergeRetries({ maxAutoMergeRetries: 5 })).toBe(5);
    expect(resolveMaxAutoMergeRetries({ maxAutoMergeRetries: 0 })).toBe(3);
    expect(resolveMaxAutoMergeRetries({ maxAutoMergeRetries: -1 })).toBe(3);
    expect(resolveMaxAutoMergeRetries({ maxAutoMergeRetries: Number.NaN })).toBe(3);
  });

  it("defaults executor escalation off and resolves only complete opt-in targets", () => {
    expect(DEFAULT_PROJECT_SETTINGS.executorModelEscalationEnabled).toBe(false);
    expect(PROJECT_SETTINGS_KEYS).toEqual(expect.arrayContaining([
      "executorModelEscalationEnabled",
      "executorEscalationProvider",
      "executorEscalationModelId",
      "executorEscalationNodeId",
    ]));
    expect(resolveExecutorEscalationTarget({
      executorModelEscalationEnabled: false,
      executorEscalationProvider: "anthropic",
      executorEscalationModelId: "claude",
      executorEscalationNodeId: "node-1",
    }).enabled).toBe(false);
    expect(resolveExecutorEscalationTarget({ executorModelEscalationEnabled: true })).toEqual({ enabled: false });
    expect(resolveExecutorEscalationTarget({ executorModelEscalationEnabled: true, executorEscalationProvider: "anthropic" })).toEqual({ enabled: false });
    expect(resolveExecutorEscalationTarget({ executorModelEscalationEnabled: true, executorEscalationProvider: "anthropic", executorEscalationModelId: "claude" })).toEqual({ enabled: true, provider: "anthropic", modelId: "claude" });
    expect(resolveExecutorEscalationTarget({ executorModelEscalationEnabled: true, executorEscalationNodeId: "node-1" })).toEqual({ enabled: true, nodeId: "node-1" });
    expect(resolveExecutorEscalationTarget({ executorModelEscalationEnabled: true, executorEscalationProvider: "anthropic", executorEscalationModelId: "claude", executorEscalationNodeId: "node-1" })).toEqual({ enabled: true, provider: "anthropic", modelId: "claude", nodeId: "node-1" });
  });

  it("resolves worktrunk as disabled when both scopes are unset or empty", () => {
    expect(resolveWorktrunkSettings(undefined, undefined).enabled).toBe(false);
    expect(resolveWorktrunkSettings({}, {}).enabled).toBe(false);
  });

  it("preserves explicit false overrides for worktrunk enabled", () => {
    expect(resolveWorktrunkSettings({ enabled: false }, undefined).enabled).toBe(false);
    expect(resolveWorktrunkSettings(undefined, { enabled: false }).enabled).toBe(false);
  });

  it("does not implicitly enable worktrunk when validating undefined", () => {
    expect(validateWorktrunkSettings(undefined)).toEqual({});
  });

  it("flags off→on transition from fresh defaults", () => {
    const freshProject = resolveWorktrunkSettings(DEFAULT_GLOBAL_SETTINGS.worktrunk, DEFAULT_PROJECT_SETTINGS.worktrunk);
    expect(freshProject.enabled).toBe(false);
    expect(
      requiresWorktrunkInstallVerification({
        current: freshProject,
        next: { ...freshProject, enabled: true },
      }),
    ).toBe(true);
  });

  describe("prerebase policy defaults", () => {
    it("keeps prerebase policy defaults project-scoped", () => {
      expect(DEFAULT_PROJECT_SETTINGS.prerebaseAutoEnabled).toBe(true);
      expect(DEFAULT_PROJECT_SETTINGS.prerebaseDivergenceThreshold).toBe(50);
      expect(DEFAULT_PROJECT_SETTINGS.prerebaseHotFiles).toEqual([
        "AGENTS.md",
        "packages/core/src/store.ts",
        "packages/core/src/db.ts",
        "packages/engine/src/executor.ts",
        "packages/engine/src/scheduler.ts",
        "packages/engine/src/merger.ts",
        "packages/dashboard/app/styles.css",
      ]);
      expect("prerebaseAutoEnabled" in DEFAULT_GLOBAL_SETTINGS).toBe(false);
      expect("prerebaseHotFiles" in DEFAULT_GLOBAL_SETTINGS).toBe(false);
      expect("prerebaseDivergenceThreshold" in DEFAULT_GLOBAL_SETTINGS).toBe(false);
    });
  });

  it("keeps github source issue auto-close disabled by default", () => {
    expect(DEFAULT_PROJECT_SETTINGS.githubCloseSourceIssueOnDone).toBe(false);
    expect("githubCloseSourceIssueOnDone" in DEFAULT_GLOBAL_SETTINGS).toBe(false);
  });

  it("defaults PR metadata prompt guidance to project-scoped unset strings", () => {
    expect(DEFAULT_PROJECT_SETTINGS.prTitlePromptInstructions).toBeUndefined();
    expect(DEFAULT_PROJECT_SETTINGS.prDescriptionPromptInstructions).toBeUndefined();
    expect(PROJECT_SETTINGS_KEYS).toContain("prTitlePromptInstructions");
    expect(PROJECT_SETTINGS_KEYS).toContain("prDescriptionPromptInstructions");
    expect(GLOBAL_SETTINGS_KEYS).not.toContain("prTitlePromptInstructions");
    expect(GLOBAL_SETTINGS_KEYS).not.toContain("prDescriptionPromptInstructions");
  });

  it("defaults AI merge commit summaries to enabled", () => {
    // FN-5642/FN-5644 intentionally default this on for subject + body summary coverage.
    expect(DEFAULT_PROJECT_SETTINGS.useAiMergeCommitSummary).toBe(true);
  });

  describe("recycleWorktrees default", () => {
    it("keeps recycleWorktrees explicitly false in project defaults", () => {
      expect(DEFAULT_PROJECT_SETTINGS.recycleWorktrees).toBe(false);
      expect("recycleWorktrees" in DEFAULT_PROJECT_SETTINGS).toBe(true);
    });

    it("keeps recycleWorktrees project-scoped only", () => {
      // recycleWorktrees intentionally has no DEFAULT_GLOBAL_SETTINGS counterpart.
      expect("recycleWorktrees" in DEFAULT_GLOBAL_SETTINGS).toBe(false);
    });
  });

  describe("showWorktreeGrouping default", () => {
    it("keeps showWorktreeGrouping explicitly false in project defaults", () => {
      expect(DEFAULT_PROJECT_SETTINGS.showWorktreeGrouping).toBe(false);
      expect("showWorktreeGrouping" in DEFAULT_PROJECT_SETTINGS).toBe(true);
    });

    it("keeps showWorktreeGrouping project-scoped only", () => {
      // showWorktreeGrouping intentionally has no DEFAULT_GLOBAL_SETTINGS counterpart.
      expect("showWorktreeGrouping" in DEFAULT_GLOBAL_SETTINGS).toBe(false);
    });
  });

  describe("openTasksInRightSidebar default", () => {
    it("keeps openTasksInRightSidebar explicitly false in project defaults", () => {
      expect(DEFAULT_PROJECT_SETTINGS.openTasksInRightSidebar).toBe(false);
      expect("openTasksInRightSidebar" in DEFAULT_PROJECT_SETTINGS).toBe(true);
      expect(PROJECT_SETTINGS_KEYS).toContain("openTasksInRightSidebar");
    });

    it("keeps openTasksInRightSidebar project-scoped only", () => {
      expect("openTasksInRightSidebar" in DEFAULT_GLOBAL_SETTINGS).toBe(false);
      expect(GLOBAL_SETTINGS_KEYS).not.toContain("openTasksInRightSidebar");
    });
  });

  describe("openMobileTasksInPopup default", () => {
    it("keeps openMobileTasksInPopup explicitly false in project defaults", () => {
      expect(DEFAULT_PROJECT_SETTINGS.openMobileTasksInPopup).toBe(false);
      expect("openMobileTasksInPopup" in DEFAULT_PROJECT_SETTINGS).toBe(true);
      expect(PROJECT_SETTINGS_KEYS).toContain("openMobileTasksInPopup");
    });

    it("keeps openMobileTasksInPopup project-scoped only", () => {
      expect("openMobileTasksInPopup" in DEFAULT_GLOBAL_SETTINGS).toBe(false);
      expect(GLOBAL_SETTINGS_KEYS).not.toContain("openMobileTasksInPopup");
    });
  });

  describe("taskPopupsBoardListOnly default", () => {
    it("keeps taskPopupsBoardListOnly explicitly true in project defaults", () => {
      expect(DEFAULT_PROJECT_SETTINGS.taskPopupsBoardListOnly).toBe(true);
      expect("taskPopupsBoardListOnly" in DEFAULT_PROJECT_SETTINGS).toBe(true);
      expect(PROJECT_SETTINGS_KEYS).toContain("taskPopupsBoardListOnly");
    });

    it("keeps taskPopupsBoardListOnly project-scoped only", () => {
      expect("taskPopupsBoardListOnly" in DEFAULT_GLOBAL_SETTINGS).toBe(false);
      expect(GLOBAL_SETTINGS_KEYS).not.toContain("taskPopupsBoardListOnly");
    });
  });

  describe("showCostBadgeOnCards default", () => {
    it("keeps showCostBadgeOnCards explicitly false in project defaults", () => {
      expect(DEFAULT_PROJECT_SETTINGS.showCostBadgeOnCards).toBe(false);
      expect("showCostBadgeOnCards" in DEFAULT_PROJECT_SETTINGS).toBe(true);
      expect(PROJECT_SETTINGS_KEYS).toContain("showCostBadgeOnCards");
    });

    it("keeps showCostBadgeOnCards project-scoped only", () => {
      expect("showCostBadgeOnCards" in DEFAULT_GLOBAL_SETTINGS).toBe(false);
      expect(GLOBAL_SETTINGS_KEYS).not.toContain("showCostBadgeOnCards");
    });
  });

  describe("taskDetailChatFirst default", () => {
    it("keeps taskDetailChatFirst explicitly false in project defaults", () => {
      expect(DEFAULT_PROJECT_SETTINGS.taskDetailChatFirst).toBe(false);
      expect("taskDetailChatFirst" in DEFAULT_PROJECT_SETTINGS).toBe(true);
      expect(PROJECT_SETTINGS_KEYS).toContain("taskDetailChatFirst");
    });

    it("keeps taskDetailChatFirst project-scoped only", () => {
      expect("taskDetailChatFirst" in DEFAULT_GLOBAL_SETTINGS).toBe(false);
      expect(GLOBAL_SETTINGS_KEYS).not.toContain("taskDetailChatFirst");
    });
  });

  describe("quickChatCloseOnOutsideClick default", () => {
    it("keeps Quick Chat outside-click dismissal explicitly true in project defaults", () => {
      expect(DEFAULT_PROJECT_SETTINGS.quickChatCloseOnOutsideClick).toBe(true);
      expect("quickChatCloseOnOutsideClick" in DEFAULT_PROJECT_SETTINGS).toBe(true);
      expect(PROJECT_SETTINGS_KEYS).toContain("quickChatCloseOnOutsideClick");
    });

    it("keeps quickChatCloseOnOutsideClick project-scoped only", () => {
      expect("quickChatCloseOnOutsideClick" in DEFAULT_GLOBAL_SETTINGS).toBe(false);
      expect(GLOBAL_SETTINGS_KEYS).not.toContain("quickChatCloseOnOutsideClick");
    });
  });

  describe("dismissModalsOnOutsideClick default", () => {
    it("defaults modal backdrop dismissal off and global-scoped only", () => {
      expect(DEFAULT_GLOBAL_SETTINGS.dismissModalsOnOutsideClick).toBe(false);
      expect(GLOBAL_SETTINGS_KEYS).toContain("dismissModalsOnOutsideClick");
      expect("dismissModalsOnOutsideClick" in DEFAULT_PROJECT_SETTINGS).toBe(false);
      expect(PROJECT_SETTINGS_KEYS).not.toContain("dismissModalsOnOutsideClick");
    });
  });

  describe("skipConfirmationDialogs default", () => {
    it("defaults critical-action confirmation skipping off and global-scoped only", () => {
      expect(DEFAULT_GLOBAL_SETTINGS.skipConfirmationDialogs).toBe(false);
      expect(GLOBAL_SETTINGS_KEYS).toContain("skipConfirmationDialogs");
      expect("skipConfirmationDialogs" in DEFAULT_PROJECT_SETTINGS).toBe(false);
      expect(PROJECT_SETTINGS_KEYS).not.toContain("skipConfirmationDialogs");
      expect(isGlobalOnlySettingsKey("skipConfirmationDialogs")).toBe(true);
    });
  });

  describe("mergeIntegrationWorktree default", () => {
    it("defaults project settings to reuse-task-worktree", () => {
      expect(DEFAULT_PROJECT_SETTINGS.mergeIntegrationWorktree).toBe("reuse-task-worktree");
    });

    it("preserves both supported values through normalization", () => {
      expect(normalizeMergeIntegrationWorktreeMode("reuse-task-worktree")).toBe("reuse-task-worktree");
      expect(normalizeMergeIntegrationWorktreeMode("cwd-integration-branch")).toBe("cwd-integration-branch");
      expect(normalizeMergeIntegrationWorktreeMode("cwd-main")).toBe("cwd-integration-branch");
    });

    it("warns once per process for legacy cwd-main mode", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      expect(normalizeMergeIntegrationWorktreeMode("cwd-main")).toBe("cwd-integration-branch");
      expect(normalizeMergeIntegrationWorktreeMode("cwd-main")).toBe("cwd-integration-branch");

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        "[merger] settings.mergeIntegrationWorktree=cwd-main is legacy; normalized to cwd-integration-branch",
      );
    });

    it("resolves legacy missing values to the new default", () => {
      const legacyResolved = {
        ...DEFAULT_PROJECT_SETTINGS,
        mergeIntegrationWorktree: normalizeMergeIntegrationWorktreeMode(undefined),
      };
      expect(legacyResolved.mergeIntegrationWorktree).toBe("reuse-task-worktree");
    });

    it("normalizes unknown values to reuse-task-worktree", () => {
      expect(normalizeMergeIntegrationWorktreeMode("legacy-project-root-mode")).toBe("reuse-task-worktree");
      expect(normalizeMergeIntegrationWorktreeMode(null)).toBe("reuse-task-worktree");
    });
  });
  it("normalizes executor tool-failure retry settings with floor semantics", () => {
    expect(DEFAULT_PROJECT_SETTINGS.executorToolFailureRetryCount).toBe(DEFAULT_MAX_CONSECUTIVE_TOOL_FAILURE_RETRIES);
    expect(DEFAULT_PROJECT_SETTINGS.executorToolFailureRetryBackoffMs).toBe(DEFAULT_CONSECUTIVE_TOOL_FAILURE_RETRY_BACKOFF_MS);
    expect(DEFAULT_PROJECT_SETTINGS.executorToolFailureThreshold).toBe(CONSECUTIVE_TOOL_FAILURE_RETRY_THRESHOLD);
    expect(PROJECT_SETTINGS_KEYS).toEqual(expect.arrayContaining(["executorToolFailureRetryCount", "executorToolFailureRetryBackoffMs", "executorToolFailureThreshold"]));
    expect(resolveMaxConsecutiveToolFailureRetries({ executorToolFailureRetryCount: 2.7 })).toBe(2);
    expect(resolveMaxConsecutiveToolFailureRetries({ executorToolFailureRetryCount: -1 })).toBe(2);
    expect(resolveConsecutiveToolFailureRetryBackoffMs({ executorToolFailureRetryBackoffMs: 2500.9 })).toBe(2500);
    expect(resolveConsecutiveToolFailureRetryBackoffMs({ executorToolFailureRetryBackoffMs: Infinity })).toBe(2000);
    expect(resolveConsecutiveToolFailureThreshold({ executorToolFailureThreshold: 3.9 })).toBe(3);
    expect(resolveConsecutiveToolFailureThreshold({ executorToolFailureThreshold: 0.5 })).toBe(3);
  });

});
