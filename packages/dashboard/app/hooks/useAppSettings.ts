import { useCallback, useEffect, useRef, useState } from "react";
import { fetchConfig, fetchSettings, updateSettings, updateGlobalSettings } from "../api";
import type { GlobalSettings, ProjectSettings } from "@fusion/core";
import type { ModelPricingOverrides } from "../../../core/src/model-pricing";
import { setAutoReloadEnabled } from "../versionCheck";
import { DEFAULT_DASHBOARD_KEYBOARD_SHORTCUTS, resolveDashboardKeyboardShortcuts, type DashboardKeyboardShortcutMap } from "../utils/keyboardShortcuts";

export type QuickChatButtonMode = "floating" | "footer" | "off";
export type PlanApprovalMode = NonNullable<ProjectSettings["planApprovalMode"]>;

/**
 * Settings state and actions consumed by the dashboard App shell.
 */
export interface UseAppSettingsResult {
  maxConcurrent: number;
  rootDir: string;
  autoMerge: boolean;
  mergeStrategy: string;
  planApprovalMode: PlanApprovalMode;
  planAutoApproveEnabled: boolean;
  showWorktreeGrouping: boolean;
  testMode: boolean;
  isTestMode: boolean;
  globalPaused: boolean;
  enginePaused: boolean;
  taskStuckTimeoutMs: number | undefined;
  staleHighFanoutBlockerAgeThresholdMs: number;
  capacityRiskBannerEnabled: boolean;
  capacityRiskTodoThreshold: number;
  openTasksInRightSidebar: boolean;
  openMobileTasksInPopup: boolean;
  showCostBadgeOnCards: boolean;
  modelPricingOverrides?: ModelPricingOverrides;
  taskDetailChatFirst: boolean;
  quickChatButtonMode: QuickChatButtonMode;
  quickChatCloseOnOutsideClick: boolean;
  dashboardKeyboardShortcuts: Required<DashboardKeyboardShortcutMap>;
  dismissModalsOnOutsideClick: boolean;
  showQuickChatFAB: boolean;
  maxTotalRetriesBeforeFail: number;
  prAuthAvailable: boolean;
  settingsLoaded: boolean;
  experimentalFeatures: Record<string, boolean>;
  insightsEnabled: boolean;
  memoryEnabled: boolean;
  devServerEnabled: boolean;
  todosEnabled: boolean;
  goalsEnabled: boolean;
  autoReloadOnVersionChange: boolean;
  toggleAutoMerge: () => Promise<void>;
  togglePlanAutoApprove: () => Promise<void>;
  toggleGlobalPause: () => Promise<void>;
  toggleEnginePause: () => Promise<void>;
  toggleShowQuickChatFAB: () => Promise<void>;
  setQuickChatButtonModeImmediate: (mode: QuickChatButtonMode) => void;
  toggleAutoReloadOnVersionChange: () => Promise<void>;
  /** Re-fetches settings from the backend to pick up changes made externally (e.g., by SettingsModal). */
  refresh: () => Promise<void>;
}

/**
 * Loads per-project dashboard settings and exposes optimistic toggle handlers.
 */
export function useAppSettings(projectId?: string): UseAppSettingsResult {
  const [maxConcurrent, setMaxConcurrent] = useState(2);
  const [rootDir, setRootDir] = useState<string>(".");
  const [autoMerge, setAutoMerge] = useState(true);
  const [mergeStrategy, setMergeStrategy] = useState("direct");
  /*
  FNXC:PlanApproval 2026-07-04-00:00:
  FN-7557: plan auto-approval is the default project posture; the pre-hydration state and any genuinely unset/invalid server value fall back to "auto-approve-all" instead of "workflow". Explicit server values ("workflow", "auto-approve-all", "require-all") are preserved during hydration below.
  */
  const [planApprovalMode, setPlanApprovalMode] = useState<PlanApprovalMode>("auto-approve-all");
  const [showWorktreeGrouping, setShowWorktreeGrouping] = useState(false);
  const [testMode, setTestMode] = useState(false);
  const [isTestMode, setIsTestMode] = useState(false);
  const [globalPaused, setGlobalPaused] = useState(false);
  const [enginePaused, setEnginePaused] = useState(false);
  const [taskStuckTimeoutMs, setTaskStuckTimeoutMs] = useState<number | undefined>(undefined);
  const [staleHighFanoutBlockerAgeThresholdMs, setStaleHighFanoutBlockerAgeThresholdMs] = useState(2 * 60 * 60 * 1000);
  const [capacityRiskBannerEnabled, setCapacityRiskBannerEnabled] = useState(false);
  const [capacityRiskTodoThreshold, setCapacityRiskTodoThreshold] = useState(20);
  const [openTasksInRightSidebar, setOpenTasksInRightSidebar] = useState(false);
  const [openMobileTasksInPopup, setOpenMobileTasksInPopup] = useState(false);
  const [showCostBadgeOnCards, setShowCostBadgeOnCards] = useState(false);
  const [modelPricingOverrides, setModelPricingOverrides] = useState<ModelPricingOverrides | undefined>(undefined);
  const [taskDetailChatFirst, setTaskDetailChatFirst] = useState(false);
  const [quickChatButtonMode, setQuickChatButtonMode] = useState<QuickChatButtonMode>("off");
  const [quickChatCloseOnOutsideClick, setQuickChatCloseOnOutsideClick] = useState(true);
  const [dashboardKeyboardShortcuts, setDashboardKeyboardShortcuts] = useState<Required<DashboardKeyboardShortcutMap>>(DEFAULT_DASHBOARD_KEYBOARD_SHORTCUTS);
  const [dismissModalsOnOutsideClick, setDismissModalsOnOutsideClick] = useState(false);
  const [showQuickChatFAB, setShowQuickChatFAB] = useState(false);
  const [maxTotalRetriesBeforeFail, setMaxTotalRetriesBeforeFail] = useState(25);
  const [prAuthAvailable, setPrAuthAvailable] = useState(false);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [experimentalFeatures, setExperimentalFeatures] = useState<Record<string, boolean>>({});
  const [insightsEnabled, setInsightsEnabled] = useState(true);
  const [memoryEnabled, setMemoryEnabled] = useState(true);
  const [devServerEnabled, setDevServerEnabled] = useState(false);
  const [todosEnabled, setTodosEnabled] = useState(true);
  const [goalsEnabled, setGoalsEnabled] = useState(true);
  const [autoReloadOnVersionChange, setAutoReloadOnVersionChangeState] = useState(true);
  const autoMergeRef = useRef(autoMerge);
  const planApprovalModeRef = useRef<PlanApprovalMode>(planApprovalMode);

  /**
   * Fetches config and settings from the backend and updates local state.
   * Shared between the mount-time useEffect and the refresh() function.
   */
  const refresh = useCallback(async () => {
    const [configResult, settingsResult] = await Promise.allSettled([
      fetchConfig(projectId),
      fetchSettings(projectId),
    ]);

    if (configResult.status === "fulfilled") {
      setMaxConcurrent(configResult.value.maxConcurrent);
      setRootDir(configResult.value.rootDir);
    }

    if (settingsResult.status === "fulfilled") {
      const settings = settingsResult.value;
      setAutoMerge(Boolean(settings.autoMerge));
      /*
      FNXC:BoardCardActions 2026-06-30-00:42:
      Board and List context menus need the project merge strategy before PR creation so manual PR projects can show Start PR Review with the same availability as Task Detail.
      */
      setMergeStrategy(typeof settings.mergeStrategy === "string" ? settings.mergeStrategy : "direct");
      const nextPlanApprovalMode: PlanApprovalMode =
        settings.planApprovalMode === "auto-approve-all" ||
        settings.planApprovalMode === "require-all" ||
        settings.planApprovalMode === "workflow"
          ? settings.planApprovalMode
          : "auto-approve-all";
      planApprovalModeRef.current = nextPlanApprovalMode;
      setPlanApprovalMode(nextPlanApprovalMode);
      setShowWorktreeGrouping(settings.showWorktreeGrouping === true);
      const nextTestMode = settings.testMode === true;
      const nextIsTestMode = nextTestMode || settings.defaultProvider?.trim().toLowerCase() === "mock";
      setTestMode(nextTestMode);
      setIsTestMode(nextIsTestMode);
      setGlobalPaused(Boolean(settings.globalPause));
      setEnginePaused(Boolean(settings.enginePaused));
      setPrAuthAvailable(Boolean(settings.prAuthAvailable));
      setTaskStuckTimeoutMs(settings.taskStuckTimeoutMs);
      setStaleHighFanoutBlockerAgeThresholdMs(
        settings.staleHighFanoutBlockerAgeThresholdMs ?? 2 * 60 * 60 * 1000,
      );
      const nextQuickChatButtonMode: QuickChatButtonMode =
        settings.quickChatButtonMode === "floating" || settings.quickChatButtonMode === "footer" || settings.quickChatButtonMode === "off"
          ? settings.quickChatButtonMode
          : settings.showQuickChatFAB === true
            ? "floating"
            : "off";
      setQuickChatButtonMode(nextQuickChatButtonMode);
      setQuickChatCloseOnOutsideClick(settings.quickChatCloseOnOutsideClick !== false);
      setDashboardKeyboardShortcuts(resolveDashboardKeyboardShortcuts((settings as GlobalSettings).dashboardKeyboardShortcuts));
      setDismissModalsOnOutsideClick(settings.dismissModalsOnOutsideClick === true);
      setShowQuickChatFAB(nextQuickChatButtonMode === "floating");
      setMaxTotalRetriesBeforeFail(settings.maxTotalRetriesBeforeFail ?? 25);
      setCapacityRiskBannerEnabled(settings.capacityRiskBannerEnabled === true);
      setCapacityRiskTodoThreshold(settings.capacityRiskTodoThreshold ?? 20);
      setOpenTasksInRightSidebar(settings.openTasksInRightSidebar === true);
      setOpenMobileTasksInPopup(settings.openMobileTasksInPopup === true);
      /*
      FNXC:TaskCardCostBadge 2026-07-11-12:15:
      The app shell exposes the default-off card cost badge setting to the board context only after settings hydration, preserving the no-badge default for upgraded projects.
      */
      setShowCostBadgeOnCards(settings.showCostBadgeOnCards === true);
      setModelPricingOverrides((settings as GlobalSettings).modelPricingOverrides);
      /*
      FNXC:TaskDetailActivityFirst 2026-06-30-23:59:
      App-level task-detail hosts need the project setting so Activity-first is the missing/false default and Chat-first is restored only by explicit opt-in.
      */
      setTaskDetailChatFirst(settings.taskDetailChatFirst === true);
      setExperimentalFeatures(settings.experimentalFeatures ?? {});
      const features = settings.experimentalFeatures ?? {};
      /*
      FNXC:DefaultNavigation 2026-06-23-01:24:
      Insights, Memory, Todo, and Goals graduated from experimental navigation. Keep them enabled regardless of missing or stale false experimental flags so upgrades keep the sidebar/header surfaces visible.
      */
      setInsightsEnabled(true);
      setMemoryEnabled(true);
      setDevServerEnabled(features.devServerView === true || features.devServer === true);
      setTodosEnabled(true);
      setGoalsEnabled(true);
      // Sync the module-level auto-reload guard with the persisted setting
      const autoReload = settings.autoReloadOnVersionChange !== false;
      setAutoReloadOnVersionChangeState(autoReload);
      setAutoReloadEnabled(autoReload);
    }

    setSettingsLoaded(true);
  }, [projectId]);

  useEffect(() => {
    setSettingsLoaded(false);
    setExperimentalFeatures({});
    setInsightsEnabled(true);
    setMemoryEnabled(true);
    setDevServerEnabled(false);
    setOpenTasksInRightSidebar(false);
    setOpenMobileTasksInPopup(false);
    setShowCostBadgeOnCards(false);
    setModelPricingOverrides(undefined);
    setTaskDetailChatFirst(false);
    setQuickChatCloseOnOutsideClick(true);
    setDashboardKeyboardShortcuts(DEFAULT_DASHBOARD_KEYBOARD_SHORTCUTS);
    setDismissModalsOnOutsideClick(false);
    setPlanApprovalMode("workflow");
    setTodosEnabled(true);
    setGoalsEnabled(true);
    void refresh();
  }, [refresh]);

  useEffect(() => {
    autoMergeRef.current = autoMerge;
  }, [autoMerge]);

  useEffect(() => {
    planApprovalModeRef.current = planApprovalMode;
  }, [planApprovalMode]);

  const toggleAutoMerge = useCallback(async () => {
    const previousAutoMerge = autoMergeRef.current;
    const nextAutoMerge = !previousAutoMerge;
    autoMergeRef.current = nextAutoMerge;
    setAutoMerge(nextAutoMerge);

    try {
      await updateSettings({ autoMerge: nextAutoMerge }, projectId);
    } catch {
      autoMergeRef.current = previousAutoMerge;
      setAutoMerge(previousAutoMerge);
    }
  }, [projectId]);

  /*
  FNXC:PlanApproval 2026-07-01-08:37:
  The Board Triage shortcut is a binary mirror of project planApprovalMode === "auto-approve-all". Settings modal remains the full three-state editor, so turning the Board switch off returns to "workflow" and "require-all" stays unchecked until an operator explicitly enables auto-approval.
  */
  const togglePlanAutoApprove = useCallback(async () => {
    const previousMode = planApprovalModeRef.current;
    const nextMode: PlanApprovalMode = previousMode === "auto-approve-all" ? "workflow" : "auto-approve-all";
    planApprovalModeRef.current = nextMode;
    setPlanApprovalMode(nextMode);

    try {
      await updateSettings({ planApprovalMode: nextMode }, projectId);
    } catch {
      planApprovalModeRef.current = previousMode;
      setPlanApprovalMode(previousMode);
    }
  }, [projectId]);

  const toggleGlobalPause = useCallback(async () => {
    const next = !globalPaused;
    setGlobalPaused(next);

    try {
      await updateSettings(
        {
          globalPause: next,
          globalPauseReason: next ? "manual" : undefined,
        },
        projectId,
      );
    } catch {
      setGlobalPaused(!next);
    }
  }, [globalPaused, projectId]);

  const toggleEnginePause = useCallback(async () => {
    const next = !enginePaused;
    setEnginePaused(next);

    try {
      await updateSettings({ enginePaused: next }, projectId);
    } catch {
      setEnginePaused(!next);
    }
  }, [enginePaused, projectId]);

  const toggleShowQuickChatFAB = useCallback(async () => {
    const next = !showQuickChatFAB;
    setShowQuickChatFAB(next);
    setQuickChatButtonMode(next ? "floating" : "off");

    try {
      await updateSettings({ quickChatButtonMode: next ? "floating" : "off", showQuickChatFAB: next }, projectId);
    } catch {
      setShowQuickChatFAB(!next);
      setQuickChatButtonMode(!next ? "floating" : "off");
    }
  }, [showQuickChatFAB, projectId]);

  const setQuickChatButtonModeImmediate = useCallback((mode: QuickChatButtonMode) => {
    /*
    FNXC:QuickChat 2026-06-22-18:55:
    The Quick Chat launcher setting must move the visible launcher immediately between floating FAB, footer button, and off while Settings is still open. Persistence still flows through SettingsModal save; this mirrors the pending selection in the app shell.
    */
    setQuickChatButtonMode(mode);
    setShowQuickChatFAB(mode === "floating");
  }, []);

  const toggleAutoReloadOnVersionChange = useCallback(async () => {
    const next = !autoReloadOnVersionChange;
    setAutoReloadOnVersionChangeState(next);
    setAutoReloadEnabled(next);

    try {
      await updateGlobalSettings({ autoReloadOnVersionChange: next });
    } catch {
      setAutoReloadOnVersionChangeState(!next);
      setAutoReloadEnabled(!next);
    }
  }, [autoReloadOnVersionChange]);

  return {
    maxConcurrent,
    rootDir,
    autoMerge,
    mergeStrategy,
    planApprovalMode,
    planAutoApproveEnabled: planApprovalMode === "auto-approve-all",
    showWorktreeGrouping,
    testMode,
    isTestMode,
    globalPaused,
    enginePaused,
    taskStuckTimeoutMs,
    staleHighFanoutBlockerAgeThresholdMs,
    capacityRiskBannerEnabled,
    capacityRiskTodoThreshold,
    openTasksInRightSidebar,
    openMobileTasksInPopup,
    showCostBadgeOnCards,
    modelPricingOverrides,
    taskDetailChatFirst,
    quickChatButtonMode,
    quickChatCloseOnOutsideClick,
    dashboardKeyboardShortcuts,
    dismissModalsOnOutsideClick,
    showQuickChatFAB,
    maxTotalRetriesBeforeFail,
    prAuthAvailable,
    settingsLoaded,
    experimentalFeatures,
    insightsEnabled,
    memoryEnabled,
    devServerEnabled,
    todosEnabled,
    goalsEnabled,
    autoReloadOnVersionChange,
    toggleAutoMerge,
    togglePlanAutoApprove,
    toggleGlobalPause,
    toggleEnginePause,
    toggleShowQuickChatFAB,
    setQuickChatButtonModeImmediate,
    toggleAutoReloadOnVersionChange,
    refresh,
  };
}
