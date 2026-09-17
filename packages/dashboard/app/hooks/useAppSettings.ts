import { useCallback, useEffect, useRef, useState } from "react";
import { fetchConfig, fetchSettings, updateSettings } from "../api";
import { DEFAULT_PROJECT_SETTINGS, type GlobalSettings, type ProjectSettings } from "@fusion/core";
import { resolveMobileNavPrimaryItems } from "../../../core/src/board/mobile-nav-primary-items";
import type { ModelPricingOverrides } from "../../../core/src/ai/model-pricing";
import { DEFAULT_DASHBOARD_KEYBOARD_SHORTCUTS, resolveDashboardKeyboardShortcuts, type DashboardKeyboardShortcutMap } from "../utils/keyboardShortcuts";
import { normalizeChatSubmitOnEnterMode, type ChatSubmitOnEnterMode } from "../context/ChatSubmitOnEnterContext";
import { normalizeNavigationPlacement, type NavigationPlacement } from "../utils/navigationPlacement";

export type ChatMessageLayout = "bubbles" | "full-width";
export type PlanApprovalMode = NonNullable<ProjectSettings["planApprovalMode"]>;

/**
 * FNXC:ChatMessageLayout 2026-08-18-20:27:
 * Settings can come from older project files or external writers, so the app shell accepts only the two persisted layout values and fails closed to the historical bubble presentation.
 */
export function normalizeChatMessageLayout(value: unknown): ChatMessageLayout {
  return value === "full-width" ? "full-width" : "bubbles";
}

export type TaskDetailDefaultTab = "definition" | "chat" | "activity";

/**
 * FNXC:TaskDetailDefaultTab 2026-09-16-02:53:
 * FN-442 replaced the boolean `taskDetailChatFirst` with this three-value project choice, so persisted values can be
 * absent, stale, or written by an older build. Only the three known values are accepted; everything else fails closed
 * to the historical `activity` landing tab. `legacyChatFirst` is a READ-ONLY compatibility fallback for a project that
 * had opted into Chat-first before the rename — the new key always wins and the legacy key is never written back.
 */
export function normalizeTaskDetailDefaultTab(value: unknown, legacyChatFirst?: unknown): TaskDetailDefaultTab {
  if (value === "definition" || value === "chat" || value === "activity") return value;
  return legacyChatFirst === true ? "chat" : "activity";
}

/**
 * Settings state and actions consumed by the dashboard App shell.
 */
export interface UseAppSettingsResult {
  maxConcurrent: number;
  /** Configured execution-worktree holder ceiling used by worktree grouping. */
  maxWorktrees: number;
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
  showCostBadgeOnCards: boolean;
  modelPricingOverrides?: ModelPricingOverrides;
  /**
   * FNXC:TaskDetailDefaultTab 2026-09-16-02:53:
   * FN-442: project choice of the task-detail landing tab AND tab-bar head order (Definition / Chat / Activity).
   */
  taskDetailDefaultTab: TaskDetailDefaultTab;
  chatMessageLayout: ChatMessageLayout;
  /**
   * FNXC:Navigation 2026-09-15-14:41:
   * FN-419: project choice of the single primary navigation surface (bottom footer vs left sidebar).
   */
  navigationPlacement: NavigationPlacement;
  /**
   * FNXC:RightSidebarOptional 2026-09-15-16:04:
   * FN-426: project opt-in for the right tool dock. Availability only — the dock's local open/pin/width/tool
   * preferences never substitute for it. Absent, invalid, and pre-hydration states are all `false`.
   */
  rightSidebarEnabled: boolean;
  mobileNavPrimaryItems: string[];
  dashboardKeyboardShortcuts: Required<DashboardKeyboardShortcutMap>;
  dismissModalsOnOutsideClick: boolean;
  quickAddSubmitOnEnter: boolean;
  chatSubmitOnEnter: ChatSubmitOnEnterMode;
  skipConfirmationDialogs: boolean;
  maxTotalRetriesBeforeFail: number;
  prAuthAvailable: boolean;
  settingsLoaded: boolean;
  experimentalFeatures: Record<string, boolean>;
  insightsEnabled: boolean;
  memoryEnabled: boolean;
  devServerEnabled: boolean;
  goalsEnabled: boolean;
  toggleAutoMerge: () => Promise<void>;
  togglePlanAutoApprove: () => Promise<void>;
  toggleGlobalPause: () => Promise<void>;
  toggleEnginePause: () => Promise<void>;
  setChatMessageLayoutImmediate: (layout: ChatMessageLayout) => void;
  setNavigationPlacementImmediate: (placement: NavigationPlacement) => void;
  setRightSidebarEnabledImmediate: (enabled: boolean) => void;
  setShowCostBadgeOnCardsImmediate: (enabled: boolean) => void;
  setTaskDetailDefaultTabImmediate: (tab: TaskDetailDefaultTab) => void;
  setMobileNavPrimaryItemsImmediate: (items: string[]) => void;
  /** Re-fetches settings from the backend to pick up changes made externally (e.g., by SettingsModal). */
  refresh: () => Promise<void>;
}

/**
 * Loads per-project dashboard settings and exposes optimistic toggle handlers.
 */
export function useAppSettings(projectId?: string): UseAppSettingsResult {
  const [maxConcurrent, setMaxConcurrent] = useState(DEFAULT_PROJECT_SETTINGS.maxConcurrent);
  const [maxWorktrees, setMaxWorktrees] = useState(DEFAULT_PROJECT_SETTINGS.maxWorktrees);
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
  /*
  FNXC:TaskPopupViewGating 2026-07-15-15:20:
  FN-8016 makes per-view popup scoping the default. Explicit persisted false remains the compatibility opt-out for globally shared popups; only an absent field falls back to true.
  */
  const [showCostBadgeOnCards, setShowCostBadgeOnCards] = useState(false);
  const [modelPricingOverrides, setModelPricingOverrides] = useState<ModelPricingOverrides | undefined>(undefined);
  const [taskDetailDefaultTab, setTaskDetailDefaultTab] = useState<TaskDetailDefaultTab>("activity");
  const [chatMessageLayout, setChatMessageLayout] = useState<ChatMessageLayout>("bubbles");
  const [navigationPlacement, setNavigationPlacement] = useState<NavigationPlacement>("footer");
  /* FNXC:RightSidebarOptional 2026-09-15-16:04: FN-426 — default-off availability of the right tool dock. */
  const [rightSidebarEnabled, setRightSidebarEnabled] = useState(false);
  const [mobileNavPrimaryItems, setMobileNavPrimaryItems] = useState<string[]>(() => resolveMobileNavPrimaryItems().primaryItems);
  const [dashboardKeyboardShortcuts, setDashboardKeyboardShortcuts] = useState<Required<DashboardKeyboardShortcutMap>>(DEFAULT_DASHBOARD_KEYBOARD_SHORTCUTS);
  const [dismissModalsOnOutsideClick, setDismissModalsOnOutsideClick] = useState(false);
  const [quickAddSubmitOnEnter, setQuickAddSubmitOnEnter] = useState(true);
  const [chatSubmitOnEnter, setChatSubmitOnEnter] = useState<ChatSubmitOnEnterMode>("auto");
  const [skipConfirmationDialogs, setSkipConfirmationDialogs] = useState(false);
  const [maxTotalRetriesBeforeFail, setMaxTotalRetriesBeforeFail] = useState(25);
  const [prAuthAvailable, setPrAuthAvailable] = useState(false);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [experimentalFeatures, setExperimentalFeatures] = useState<Record<string, boolean>>({});
  const [insightsEnabled, setInsightsEnabled] = useState(true);
  const [memoryEnabled, setMemoryEnabled] = useState(true);
  const [devServerEnabled, setDevServerEnabled] = useState(false);
  const [goalsEnabled, setGoalsEnabled] = useState(true);
  const autoMergeRef = useRef(autoMerge);
  const planApprovalModeRef = useRef<PlanApprovalMode>(planApprovalMode);
  const settingsProjectIdRef = useRef(projectId);
  // FNXC:ChatMessageLayout 2026-08-18-21:02: Ignore a prior project's late settings response so its project-scoped conversation layout cannot overwrite the active project's bubbles/full-width choice.
  settingsProjectIdRef.current = projectId;

  /**
   * Fetches config and settings from the backend and updates local state.
   * Shared between the mount-time useEffect and the refresh() function.
   */
  const refresh = useCallback(async () => {
    const [configResult, settingsResult] = await Promise.allSettled([
      fetchConfig(projectId),
      fetchSettings(projectId),
    ]);

    if (settingsProjectIdRef.current !== projectId) return;

    if (configResult.status === "fulfilled") {
      setMaxConcurrent(configResult.value.maxConcurrent);
      setMaxWorktrees(configResult.value.maxWorktrees);
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
      setMobileNavPrimaryItems(resolveMobileNavPrimaryItems(settings).primaryItems);
      setDashboardKeyboardShortcuts(resolveDashboardKeyboardShortcuts((settings as GlobalSettings).dashboardKeyboardShortcuts));
      setDismissModalsOnOutsideClick(settings.dismissModalsOnOutsideClick === true);
      setQuickAddSubmitOnEnter(settings.quickAddSubmitOnEnter !== false);
      setChatSubmitOnEnter(normalizeChatSubmitOnEnterMode(settings.chatSubmitOnEnter));
      setSkipConfirmationDialogs(settings.skipConfirmationDialogs === true);
      setMaxTotalRetriesBeforeFail(settings.maxTotalRetriesBeforeFail ?? 25);
      setCapacityRiskBannerEnabled(settings.capacityRiskBannerEnabled === true);
      setCapacityRiskTodoThreshold(settings.capacityRiskTodoThreshold ?? 20);
      /*
      FNXC:TaskCardCostBadge 2026-07-11-12:15:
      The app shell exposes the default-off card cost badge setting to the board context only after settings hydration, preserving the no-badge default for upgraded projects.
      */
      setShowCostBadgeOnCards(settings.showCostBadgeOnCards === true);
      setModelPricingOverrides((settings as GlobalSettings).modelPricingOverrides);
      /*
      FNXC:TaskDetailDefaultTab 2026-09-16-02:53:
      App-level task-detail hosts need the project choice so an open with no explicit tab lands on the configured tab
      and the tab bar leads with it. The explicit cast is deliberate: `taskDetailChatFirst` no longer exists in the
      type, but a project persisted before FN-442 can still carry it, and unknown keys are tolerated on read.
      */
      setTaskDetailDefaultTab(
        normalizeTaskDetailDefaultTab(settings.taskDetailDefaultTab, (settings as Record<string, unknown>).taskDetailChatFirst),
      );
      setChatMessageLayout(normalizeChatMessageLayout(settings.chatMessageLayout));
      setNavigationPlacement(normalizeNavigationPlacement(settings.navigationPlacement));
      /*
      FNXC:RightSidebarOptional 2026-09-15-16:04:
      FN-426: strictly `=== true`. A stale string, number, or absent field must never mount a shell surface the
      operator did not ask for, because every tool is reachable without it.
      */
      setRightSidebarEnabled(settings.rightSidebarEnabled === true);
      setExperimentalFeatures(settings.experimentalFeatures ?? {});
      const features = settings.experimentalFeatures ?? {};
      /*
      FNXC:DefaultNavigation 2026-06-23-01:24:
      Insights, Memory, Todo, and Goals graduated from experimental navigation. Keep them enabled regardless of missing or stale false experimental flags so upgrades keep the sidebar/header surfaces visible.
      */
      setInsightsEnabled(true);
      setMemoryEnabled(true);
      setDevServerEnabled(features.devServerView === true || features.devServer === true);
      setGoalsEnabled(true);
    }

    setSettingsLoaded(true);
  }, [projectId]);

  useEffect(() => {
    setSettingsLoaded(false);
    setExperimentalFeatures({});
    setInsightsEnabled(true);
    setMemoryEnabled(true);
    setDevServerEnabled(false);
    /*
    FNXC:RightSidebarOptional 2026-09-15-16:04:
    FN-426: a project switch must not carry the previous project's dock availability across the gap before the new
    project's settings land, so it falls back to the safe default rather than the outgoing value.
    */
    setRightSidebarEnabled(false);
    setShowCostBadgeOnCards(false);
    setModelPricingOverrides(undefined);
    setTaskDetailDefaultTab("activity");
    setChatMessageLayout("bubbles");
    setNavigationPlacement("footer");
    setDashboardKeyboardShortcuts(DEFAULT_DASHBOARD_KEYBOARD_SHORTCUTS);
    setDismissModalsOnOutsideClick(false);
    setPlanApprovalMode("workflow");
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

  const setChatMessageLayoutImmediate = useCallback((layout: ChatMessageLayout) => {
    /*
    FNXC:LiveAppearanceSettings 2026-08-19-18:07:
    Both overlay and embedded Settings must mirror every mounted Appearance control into the App shell during its input event. These setters intentionally avoid persistence: SettingsModal remains the only debounced writer and its reconciliation remains authoritative.
    */
    setChatMessageLayout(normalizeChatMessageLayout(layout));
  }, []);

  const setNavigationPlacementImmediate = useCallback((placement: NavigationPlacement) => {
    /*
    FNXC:Navigation 2026-09-15-14:41:
    FN-419 mirrors the Appearance placement control into the shell during its input event so the menu moves live.
    Like the other Immediate setters this never persists: SettingsModal stays the sole debounced writer.
    */
    setNavigationPlacement(normalizeNavigationPlacement(placement));
  }, []);

  const setRightSidebarEnabledImmediate = useCallback((enabled: boolean) => {
    /*
    FNXC:RightSidebarOptional 2026-09-15-16:04:
    FN-426 mirrors the Appearance opt-in into the shell during its input event so the dock appears/disappears live.
    Like the sibling Immediate setters it never persists; SettingsModal stays the sole debounced writer.
    */
    setRightSidebarEnabled(enabled === true);
  }, []);

  const setShowCostBadgeOnCardsImmediate = useCallback((enabled: boolean) => {
    setShowCostBadgeOnCards(enabled === true);
  }, []);

  const setTaskDetailDefaultTabImmediate = useCallback((tab: TaskDetailDefaultTab) => {
    /*
    FNXC:LiveAppearanceSettings 2026-08-19-18:07:
    Mirrors the mounted Appearance control into the App shell during its input event. Like the other Immediate setters
    it never persists: SettingsModal remains the only debounced writer and its reconciliation stays authoritative.
    */
    setTaskDetailDefaultTab(normalizeTaskDetailDefaultTab(tab));
  }, []);

  /*
  FNXC:Navigation 2026-07-17-00:00:
  The settings draft previews mobile quick-action order and membership in the app shell before Save;
  persistence remains owned by SettingsModal's normal save path.
  */
  const setMobileNavPrimaryItemsImmediate = useCallback((items: string[]) => {
    setMobileNavPrimaryItems(resolveMobileNavPrimaryItems({ mobileNavPrimaryItems: items }).primaryItems);
  }, []);

  return {
    maxConcurrent,
    maxWorktrees,
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
    showCostBadgeOnCards,
    modelPricingOverrides,
    taskDetailDefaultTab,
    chatMessageLayout,
    navigationPlacement,
    rightSidebarEnabled,
    mobileNavPrimaryItems,
    dashboardKeyboardShortcuts,
    dismissModalsOnOutsideClick,
    quickAddSubmitOnEnter,
    chatSubmitOnEnter,
    skipConfirmationDialogs,
    maxTotalRetriesBeforeFail,
    prAuthAvailable,
    settingsLoaded,
    experimentalFeatures,
    insightsEnabled,
    memoryEnabled,
    devServerEnabled,
    goalsEnabled,
    toggleAutoMerge,
    togglePlanAutoApprove,
    toggleGlobalPause,
    toggleEnginePause,
    setChatMessageLayoutImmediate,
    setNavigationPlacementImmediate,
    setRightSidebarEnabledImmediate,
    setShowCostBadgeOnCardsImmediate,
    setTaskDetailDefaultTabImmediate,
    setMobileNavPrimaryItemsImmediate,
    refresh,
  };
}
