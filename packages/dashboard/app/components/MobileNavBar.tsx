import "./MobileNavBar.css";
import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Activity,
  Bot,
  Brain,
  CheckSquare,
  ChevronRight,
  Clock,
  FileCode,
  FileText,
  Folder,
  Gauge,
  GitBranch,
  Grid3X3,
  LayoutGrid,
  Lightbulb,
  Loader2,
  Lock,
  Mail,
  MessageSquare,
  MoreHorizontal,
  Play,
  Settings,
  Monitor,
  Search,
  Sparkles,
  Target,
  Terminal,
  Workflow,
  Zap,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { fetchScripts } from "../api";
import type { PluginDashboardViewEntry } from "../api";
import { useViewportMode } from "./Header";
import { NavigationHistoryContext } from "../hooks/useNavigationHistory";
import type { TaskView } from "../hooks/useViewState";
import { buildPluginTaskViewId, isPluginViewId } from "../plugins/pluginViewRegistry";
import { getPluginDashboardViewNavIcon } from "./pluginNavIcon";
import { resolveMobileNavPrimaryItems, type MobileNavSelectableItem } from "../../../core/src/mobile-nav-primary-items";

export interface PublishedMobileNavHeightInput {
  navOffsetHeight: number;
  paddingBottom: number;
  tabHeights: number[];
}

export function computePublishedMobileNavHeight({
  navOffsetHeight,
  paddingBottom,
  tabHeights,
}: PublishedMobileNavHeightInput): number {
  const measuredTabHeight = Math.max(0, ...tabHeights.filter((height) => Number.isFinite(height)));
  if (measuredTabHeight > 0) {
    return Math.max(44, Math.ceil(measuredTabHeight));
  }

  const resolvedPaddingBottom = Number.isFinite(paddingBottom) ? paddingBottom : 0;
  const contentHeight = navOffsetHeight - resolvedPaddingBottom;
  return Math.max(44, Math.ceil(contentHeight));
}

export interface MobileNavBarProps {
  /** Current task view mode */
  view: TaskView;
  /** Change task view handler */
  onChangeView: (view: TaskView) => void;
  /** Whether the ExecutorStatusBar footer is visible */
  footerVisible: boolean;
  /** Whether any full-screen modal is currently open (hides the tab bar) */
  modalOpen?: boolean;
  /** Whether the on-screen mobile keyboard is open */
  keyboardOpen?: boolean;
  // Navigation handlers
  onOpenSettings?: () => void;
  onOpenActivityLog?: () => void;
  onOpenMailbox?: () => void;
  mailboxUnreadCount?: number;
  mailboxPendingApprovalCount?: number;
  chatHasUnreadResponse?: boolean;
  stashOrphanCount?: number;
  onOpenGitManager?: () => void;
  onOpenWorkflowEditor?: () => void;
  onOpenSchedules?: () => void;
  onOpenScripts?: () => void;
  onToggleTerminal?: () => void;
  onOpenFiles?: () => void;
  onOpenGitHubImport?: () => void;
  onOpenPlanning?: () => void;
  onResumePlanning?: () => void;
  activePlanningSessionCount?: number;
  /*
  FNXC:Navigation 2026-07-05-00:00:
  Planning Mode "awaiting input" no longer shows a top-of-board banner (its Resume button did not reliably
  redirect). Instead this flag drives a yellow `status-dot--pending` dot on the Planning More-sheet item and the
  More tab icon, mirroring `chatHasUnreadResponse`'s `mobile-nav-chat-unread-dot`, so the click target is always
  the working Planning navigation.
  */
  planningNeedsInput?: boolean;
  onOpenUsage?: () => void;
  onRunScript?: (name: string, command: string) => void;
  projectId?: string;
  onViewAllProjects?: () => void;
  /** Whether to show the skills tab */
  showSkillsTab?: boolean;
  /** Experimental feature flags controlling visibility of nav items. */
  experimentalFeatures?: {
    insights?: boolean;
    memoryView?: boolean;
    devServer?: boolean;
    devServerView?: boolean;
    todoView?: boolean;
    researchView?: boolean;
    evalsView?: boolean;
    ideationView?: boolean;
    goalsView?: boolean;
  };
  pluginDashboardViews?: PluginDashboardViewEntry[];
  shellConnectionControl?: ReactNode;
  /** Ordered quick-action tabs; invalid values resolve to the safe default. */
  mobileNavPrimaryItems?: string[];
}

function GitHubLogo({ size = 20 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.203 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.942.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" />
    </svg>
  );
}

function formatCount(count: number): string {
  return count > 99 ? "99+" : String(count);
}

export function MobileNavBar({
  view,
  onChangeView,
  footerVisible,
  modalOpen = false,
  keyboardOpen = false,
  onOpenSettings,
  onOpenActivityLog,
  mailboxUnreadCount = 0,
  mailboxPendingApprovalCount = 0,
  chatHasUnreadResponse = false,
  stashOrphanCount = 0,
  onOpenGitManager,
  onOpenWorkflowEditor,
  onOpenSchedules,
  onOpenScripts,
  onToggleTerminal,
  onOpenFiles,
  onOpenGitHubImport,
  onOpenPlanning,
  onResumePlanning,
  activePlanningSessionCount = 0,
  planningNeedsInput = false,
  onOpenUsage,
  onRunScript,
  projectId,
  onViewAllProjects,
  showSkillsTab,
  experimentalFeatures,
  pluginDashboardViews = [],
  shellConnectionControl,
  mobileNavPrimaryItems,
}: MobileNavBarProps) {
  const { t } = useTranslation("app");
  const mode = useViewportMode();
  const navigationHistory = useContext(NavigationHistoryContext);
  const [isMoreOpen, setIsMoreOpen] = useState(false);
  const [isScriptsSubmenuOpen, setIsScriptsSubmenuOpen] = useState(false);
  const [scripts, setScripts] = useState<Record<string, string>>({});
  const [scriptsLoading, setScriptsLoading] = useState(false);
  const [dragOffset, setDragOffset] = useState(0);
  const [isSheetDragging, setIsSheetDragging] = useState(false);
  const [hasSheetDragged, setHasSheetDragged] = useState(false);
  const navRef = useRef<HTMLElement | null>(null);
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const sheetDragRef = useRef<{
    startY: number;
    startedAt: number;
    eligible: boolean;
    startedOnHandle: boolean;
  } | null>(null);
  const dragOffsetRef = useRef(0);

  const scriptEntries = useMemo(
    () => Object.entries(scripts).sort(([a], [b]) => a.localeCompare(b)),
    [scripts],
  );

  // Fetch scripts when the submenu opens
  useEffect(() => {
    if (!isScriptsSubmenuOpen) return;

    let cancelled = false;
    setScriptsLoading(true);

    fetchScripts(projectId)
      .then((data) => {
        if (!cancelled) setScripts(data);
      })
      .catch(() => {
        if (!cancelled) setScripts({});
      })
      .finally(() => {
        if (!cancelled) setScriptsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [isScriptsSubmenuOpen, projectId]);

  const resetSheetDrag = useCallback(() => {
    sheetDragRef.current = null;
    dragOffsetRef.current = 0;
    setDragOffset(0);
    setIsSheetDragging(false);
  }, []);

  const closeMore = useCallback(() => {
    resetSheetDrag();
    setHasSheetDragged(false);
    setIsMoreOpen(false);
  }, [resetSheetDrag]);

  /*
  FNXC:MobileNav 2026-07-16-14:30:
  The More sheet must dismiss before navigation on iOS swipe-back, Android native Back, and browser Back.
  Register its stable, idempotent closer as a modal entry, while reading nullable context so provider-less
  component renders retain their existing behavior.
  */
  useEffect(() => {
    if (!isMoreOpen || !navigationHistory) return;
    navigationHistory.pushNav({ type: "modal", close: closeMore });
  }, [closeMore, isMoreOpen, navigationHistory]);

  const dismissMore = useCallback(() => {
    navigationHistory?.removeNav(closeMore);
    closeMore();
  }, [closeMore, navigationHistory]);

  /*
  FNXC:MobileNav 2026-07-16-12:00:
  The mobile More drawer must dismiss when a user drags down from its top or grab handle.
  Keep scrollTop===0 as the body-drag guard so a scrolled sheet retains normal interior
  scrolling; the non-passive native listener can cancel iOS Safari and Android Chrome
  overscroll only for that eligible downward dismissal gesture.
  */
  useEffect(() => {
    const sheet = sheetRef.current;
    if (!isMoreOpen || !sheet) return;

    const onTouchMove = (event: TouchEvent) => {
      const drag = sheetDragRef.current;
      const touch = event.touches[0];
      if (!drag || !touch) return;

      const offset = Math.max(0, touch.clientY - drag.startY);
      const canDismiss = drag.eligible && (drag.startedOnHandle || sheet.scrollTop <= 0);
      if (offset === 0 || !canDismiss) return;

      event.preventDefault();
      dragOffsetRef.current = offset;
      setHasSheetDragged(true);
      setIsSheetDragging(true);
      setDragOffset(offset);
    };

    sheet.addEventListener("touchmove", onTouchMove, { passive: false });
    return () => sheet.removeEventListener("touchmove", onTouchMove);
  }, [isMoreOpen]);

  const handleSheetTouchStart = useCallback((event: React.TouchEvent<HTMLDivElement>) => {
    const sheet = sheetRef.current;
    const touch = event.touches[0];
    if (!sheet || !touch) return;

    const target = event.target instanceof Element ? event.target : null;
    const startedOnHandle = Boolean(target?.closest(".mobile-more-sheet-handle"));
    sheetDragRef.current = {
      startY: touch.clientY,
      startedAt: Date.now(),
      eligible: startedOnHandle || sheet.scrollTop <= 0,
      startedOnHandle,
    };
    dragOffsetRef.current = 0;
    setDragOffset(0);
    setIsSheetDragging(false);
  }, []);

  const finishSheetDrag = useCallback((event: React.TouchEvent<HTMLDivElement>) => {
    const sheet = sheetRef.current;
    const drag = sheetDragRef.current;
    const touch = event.changedTouches[0];
    const offset = dragOffsetRef.current;
    const elapsed = drag ? Math.max(1, Date.now() - drag.startedAt) : 1;
    const sheetHeight = sheet?.getBoundingClientRect().height ?? 0;
    const dismissDistance = Math.max(100, sheetHeight / 4);
    const shouldDismiss = Boolean(drag?.eligible && offset > 0 && (offset >= dismissDistance || offset / elapsed >= 0.6));

    resetSheetDrag();
    if (shouldDismiss && touch) {
      dismissMore();
    }
  }, [dismissMore, resetSheetDrag]);

  const handleMoreAction = useCallback(
    (callback?: () => void) => {
      dismissMore();
      callback?.();
    },
    [dismissMore],
  );

  useEffect(() => {
    if (!isMoreOpen) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        dismissMore();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [dismissMore, isMoreOpen]);

  useLayoutEffect(() => {
    const navEl = navRef.current;
    if (!navEl || typeof document === "undefined") {
      return;
    }

    const publishMeasuredHeight = () => {
      const computed = window.getComputedStyle(navEl);
      const paddingBottom = Number.parseFloat(computed.paddingBottom);
      const tabHeights = Array.from(navEl.querySelectorAll<HTMLElement>(".mobile-nav-tab"), (tab) => tab.getBoundingClientRect().height);
      const publishedHeight = computePublishedMobileNavHeight({
        navOffsetHeight: navEl.offsetHeight,
        paddingBottom,
        tabHeights,
      });
      document.documentElement.style.setProperty("--mobile-nav-height", `${publishedHeight}px`);
    };

    publishMeasuredHeight();

    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(() => {
        publishMeasuredHeight();
      });
      observer.observe(navEl);
    }

    return () => {
      observer?.disconnect();
      document.documentElement.style.removeProperty("--mobile-nav-height");
    };
  }, []);

  if (mode !== "mobile" || modalOpen) {
    return null;
  }

  const planningHandler = activePlanningSessionCount > 0 && onResumePlanning ? onResumePlanning : onOpenPlanning;

  const skillsEnabled = Boolean(showSkillsTab);
  const todoViewEnabled = Boolean(experimentalFeatures?.todoView);

  const sortedPrimaryPluginViews = pluginDashboardViews
    .filter((entry) => entry.view.placement === "primary")
    .sort((a, b) => (a.view.order ?? Number.MAX_SAFE_INTEGER) - (b.view.order ?? Number.MAX_SAFE_INTEGER));
  /*
  FNXC:Navigation 2026-06-19-12:05:
  Mobile navigation adds Command Center as a fixed top-level tab immediately after Mailbox.
  Primary plugin tabs, including Compound Engineering, are demoted to the More sheet so touch targets stay wide and Command Center is not duplicated.

  FNXC:Navigation 2026-06-19-08:24:
  FN-6725 re-verified the suspected-revert surface: Command Center remains adjacent to Mailbox even when mailbox badges render, primary plugin tabs remain More-sheet-only, and no Command Center More-sheet duplicate is allowed.
  */
  const MAX_PRIMARY_PLUGIN_TOP_LEVEL_TABS = 0;
  const topLevelPrimaryPluginViews = sortedPrimaryPluginViews.slice(0, MAX_PRIMARY_PLUGIN_TOP_LEVEL_TABS);
  const topLevelPluginViewKeys = new Set(
    topLevelPrimaryPluginViews.map((entry) => `${entry.pluginId}:${entry.view.viewId}`),
  );
  const overflowPluginViews = pluginDashboardViews
    .filter((entry) => !topLevelPluginViewKeys.has(`${entry.pluginId}:${entry.view.viewId}`))
    .sort((a, b) => (a.view.order ?? Number.MAX_SAFE_INTEGER) - (b.view.order ?? Number.MAX_SAFE_INTEGER));

  const { primaryItems, omittedItems } = resolveMobileNavPrimaryItems({ mobileNavPrimaryItems });
  /*
  FNXC:Navigation 2026-07-17-00:00:
  Selectable mobile destinations use one registry so an available destination is rendered exactly once:
  configured items are tabs and omitted items are More entries. Feature gates are enforced here rather
  than by the core resolver, keeping persisted choices valid if an operator later enables a feature.
  */
  const destinationRegistry: Record<MobileNavSelectableItem, {
    icon: ReactNode;
    labelKey: string;
    fallback: string;
    moreTestId: string;
    isActive: boolean;
    isAvailable: boolean;
    navigate: (surface: "primary" | "more") => void;
    indicator?: boolean;
    indicatorLabel?: string;
    badge?: number;
  }> = {
    "command-center": { icon: <Gauge />, labelKey: "nav.commandCenter", fallback: "Dashboard", moreTestId: "mobile-more-item-command-center", isActive: view === "command-center", isAvailable: true, navigate: () => onChangeView("command-center") },
    tasks: { icon: <LayoutGrid />, labelKey: "nav.tasks", fallback: "Tasks", moreTestId: "mobile-more-item-tasks", isActive: view === "board" || view === "list", isAvailable: true, navigate: () => onChangeView(view === "board" || view === "list" ? view : "board") },
    agents: { icon: <Bot />, labelKey: "nav.agents", fallback: "Agents", moreTestId: "mobile-more-item-agents", isActive: view === "agents", isAvailable: true, navigate: () => onChangeView("agents") },
    missions: { icon: <Target />, labelKey: "nav.missions", fallback: "Missions", moreTestId: "mobile-more-item-missions", isActive: view === "missions", isAvailable: true, navigate: () => onChangeView("missions") },
    chat: { icon: <MessageSquare />, labelKey: "nav.chat", fallback: "Chat", moreTestId: "mobile-more-item-chat", isActive: view === "chat", isAvailable: true, navigate: () => onChangeView("chat"), indicator: chatHasUnreadResponse && view !== "chat", indicatorLabel: t("nav.chatUnreadAriaLabel", "Unread chat response") },
    mailbox: { icon: <Mail />, labelKey: "nav.mailbox", fallback: "Mailbox", moreTestId: "mobile-more-item-mailbox", isActive: view === "mailbox", isAvailable: true, navigate: () => onChangeView("mailbox"), indicator: mailboxPendingApprovalCount > 0 && view !== "mailbox", indicatorLabel: t("nav.mailboxPendingAriaLabel", "Pending approvals"), badge: mailboxUnreadCount },
    planning: { icon: <Lightbulb />, labelKey: "nav.planning", fallback: "Planning", moreTestId: "mobile-more-item-planning", isActive: view === "planning", isAvailable: true, navigate: (surface) => surface === "primary" ? planningHandler?.() : handleMoreAction(planningHandler), indicator: planningNeedsInput && view !== "planning", indicatorLabel: t("nav.planningNeedsInputAriaLabel", "Planning needs your input"), badge: activePlanningSessionCount },
    activity: { icon: <Activity />, labelKey: "nav.activityLog", fallback: "Activity Log", moreTestId: "mobile-more-item-activity", isActive: false, isAvailable: true, navigate: (surface) => surface === "primary" ? onOpenActivityLog?.() : handleMoreAction(onOpenActivityLog) },
    git: { icon: <GitBranch />, labelKey: "nav.gitManager", fallback: "Git Manager", moreTestId: "mobile-more-item-git", isActive: false, isAvailable: true, navigate: (surface) => surface === "primary" ? onOpenGitManager?.() : handleMoreAction(onOpenGitManager), badge: stashOrphanCount },
    files: { icon: <Folder />, labelKey: "nav.files", fallback: "Files", moreTestId: "mobile-more-item-files", isActive: false, isAvailable: true, navigate: (surface) => surface === "primary" ? onOpenFiles?.() : handleMoreAction(onOpenFiles) },
    workflows: { icon: <Workflow />, labelKey: "nav.workflows", fallback: "Workflows", moreTestId: "mobile-more-item-workflow", isActive: false, isAvailable: true, navigate: (surface) => surface === "primary" ? onOpenWorkflowEditor?.() : handleMoreAction(onOpenWorkflowEditor) },
    automation: { icon: <Clock />, labelKey: "nav.automation", fallback: "Automation", moreTestId: "mobile-more-item-schedules", isActive: false, isAvailable: true, navigate: (surface) => surface === "primary" ? onOpenSchedules?.() : handleMoreAction(onOpenSchedules) },
    "github-import": { icon: <GitHubLogo />, labelKey: "nav.importFromGitHub", fallback: "Import from GitHub", moreTestId: "mobile-more-item-github", isActive: false, isAvailable: true, navigate: (surface) => surface === "primary" ? onOpenGitHubImport?.() : handleMoreAction(onOpenGitHubImport) },
    usage: { icon: <Activity />, labelKey: "nav.usage", fallback: "Usage", moreTestId: "mobile-more-item-usage", isActive: false, isAvailable: true, navigate: (surface) => surface === "primary" ? onOpenUsage?.() : handleMoreAction(onOpenUsage) },
    projects: { icon: <Grid3X3 />, labelKey: "nav.projects", fallback: "Projects", moreTestId: "mobile-more-item-projects", isActive: false, isAvailable: true, navigate: (surface) => surface === "primary" ? onViewAllProjects?.() : handleMoreAction(onViewAllProjects) },
    documents: { icon: <FileText />, labelKey: "nav.documents", fallback: "Artifacts", moreTestId: "mobile-more-item-documents", isActive: view === "documents", isAvailable: true, navigate: (surface) => surface === "primary" ? onChangeView("documents") : handleMoreAction(() => onChangeView("documents")) },
    secrets: { icon: <Lock />, labelKey: "nav.secrets", fallback: "Secrets", moreTestId: "mobile-more-item-secrets", isActive: view === "secrets", isAvailable: true, navigate: (surface) => surface === "primary" ? onChangeView("secrets") : handleMoreAction(() => onChangeView("secrets")) },
    settings: { icon: <Settings />, labelKey: "nav.settings", fallback: "Settings", moreTestId: "mobile-more-item-settings", isActive: false, isAvailable: true, navigate: (surface) => surface === "primary" ? onOpenSettings?.() : handleMoreAction(onOpenSettings) },
    skills: { icon: <Zap />, labelKey: "nav.skills", fallback: "Skills", moreTestId: "mobile-more-item-skills", isActive: view === "skills", isAvailable: skillsEnabled, navigate: (surface) => surface === "primary" ? onChangeView("skills") : handleMoreAction(() => onChangeView("skills")) },
    insights: { icon: <Sparkles />, labelKey: "nav.insights", fallback: "Insights", moreTestId: "mobile-more-item-insights", isActive: view === "insights", isAvailable: Boolean(experimentalFeatures?.insights), navigate: (surface) => surface === "primary" ? onChangeView("insights") : handleMoreAction(() => onChangeView("insights")) },
    memory: { icon: <Brain />, labelKey: "nav.memory", fallback: "Memory", moreTestId: "mobile-more-item-memory", isActive: view === "memory", isAvailable: Boolean(experimentalFeatures?.memoryView), navigate: (surface) => surface === "primary" ? onChangeView("memory") : handleMoreAction(() => onChangeView("memory")) },
    research: { icon: <Search />, labelKey: "nav.research", fallback: "Research", moreTestId: "mobile-more-item-research", isActive: view === "research", isAvailable: Boolean(experimentalFeatures?.researchView), navigate: (surface) => surface === "primary" ? onChangeView("research") : handleMoreAction(() => onChangeView("research")) },
    evals: { icon: <Target />, labelKey: "nav.evals", fallback: "Evals", moreTestId: "mobile-more-item-evals", isActive: view === "evals", isAvailable: Boolean(experimentalFeatures?.evalsView), navigate: (surface) => surface === "primary" ? onChangeView("evals") : handleMoreAction(() => onChangeView("evals")) },
    ideation: { icon: <Lightbulb />, labelKey: "nav.ideation", fallback: "Ideation", moreTestId: "mobile-more-item-ideation", isActive: view === "ideation", isAvailable: Boolean(experimentalFeatures?.ideationView), navigate: (surface) => surface === "primary" ? onChangeView("ideation") : handleMoreAction(() => onChangeView("ideation")) },
    goals: { icon: <Target />, labelKey: "nav.goals", fallback: "Goals", moreTestId: "mobile-more-item-goals", isActive: view === "goalsView", isAvailable: Boolean(experimentalFeatures?.goalsView), navigate: (surface) => surface === "primary" ? onChangeView("goalsView") : handleMoreAction(() => onChangeView("goalsView")) },
    todos: { icon: <CheckSquare />, labelKey: "nav.todos", fallback: "Todos", moreTestId: "mobile-more-item-todos", isActive: view === "todos", isAvailable: todoViewEnabled, navigate: (surface) => surface === "primary" ? onChangeView("todos") : handleMoreAction(() => onChangeView("todos")) },
    "dev-server": { icon: <Monitor />, labelKey: "nav.devServer", fallback: "Dev Server", moreTestId: "mobile-more-item-dev-server", isActive: view === "dev-server" || view === "devserver", isAvailable: Boolean(experimentalFeatures?.devServerView), navigate: (surface) => surface === "primary" ? onChangeView("dev-server") : handleMoreAction(() => onChangeView("dev-server")) },
  };
  const effectivePrimaryItems = primaryItems.filter((item) => destinationRegistry[item].isAvailable);
  const effectiveOmittedItems = omittedItems.filter((item) => destinationRegistry[item].isAvailable);
  const isMoreActive = effectiveOmittedItems.some((item) => destinationRegistry[item].isActive)
    || view === "graph"
    || (isPluginViewId(view) && !topLevelPrimaryPluginViews.some((entry) => buildPluginTaskViewId(entry.pluginId, entry.view.viewId) === view));

  const renderSelectableItem = (item: MobileNavSelectableItem, surface: "primary" | "more") => {
    const destination = destinationRegistry[item];
    const isPrimary = surface === "primary";
    const label = t(destination.labelKey, destination.fallback);
    if (isPrimary) return <button key={item} type="button" className={`mobile-nav-tab${destination.isActive ? " mobile-nav-tab--active" : ""}`} data-testid={`mobile-nav-tab-${item}`} role="tab" aria-selected={destination.isActive} onClick={() => destination.navigate("primary")}><span className="mobile-nav-tab-icon-wrapper">{destination.icon}{destination.indicator && <span className="status-dot status-dot--pending mobile-nav-chat-unread-dot" aria-label={destination.indicatorLabel} />}</span><span className="mobile-nav-tab-label">{label}</span>{destination.badge && destination.badge > 0 ? <span className="mobile-nav-tab-badge">{formatCount(destination.badge)}</span> : null}</button>;
    return <button key={item} type="button" className="mobile-more-item" data-testid={destination.moreTestId} onClick={() => destination.navigate("more")}><span className="mobile-more-item-icon-wrapper">{destination.icon}{destination.indicator && <span className="status-dot status-dot--pending mobile-more-item-icon-dot" aria-label={destination.indicatorLabel} />}</span><span>{label}</span>{destination.badge && destination.badge > 0 ? <span className="mobile-more-item-badge">{formatCount(destination.badge)}</span> : null}</button>;
  };

  return (
    <>
      <nav
        ref={navRef}
        className={`mobile-nav-bar${footerVisible ? " mobile-nav-bar--with-footer" : ""}${keyboardOpen ? " mobile-nav-bar--keyboard-open" : ""}`}
        role="tablist"
        aria-label={t("nav.primaryNavAriaLabel", "Primary navigation")}
      >
        {effectivePrimaryItems.map((item) => renderSelectableItem(item, "primary"))}



        {topLevelPrimaryPluginViews.map((entry) => {
          const pluginTaskView = buildPluginTaskViewId(entry.pluginId, entry.view.viewId);
          const PluginIcon = getPluginDashboardViewNavIcon(entry);
          return (
            <button
              key={`${entry.pluginId}:${entry.view.viewId}`}
              type="button"
              className={`mobile-nav-tab${view === pluginTaskView || (view === "graph" && entry.pluginId === "fusion-plugin-dependency-graph" && entry.view.viewId === "graph") ? " mobile-nav-tab--active" : ""}`}
              data-testid={`mobile-nav-tab-plugin-${entry.pluginId}-${entry.view.viewId}`}
              role="tab"
              aria-selected={view === pluginTaskView || (view === "graph" && entry.pluginId === "fusion-plugin-dependency-graph" && entry.view.viewId === "graph")}
              onClick={() => onChangeView(entry.pluginId === "fusion-plugin-dependency-graph" && entry.view.viewId === "graph" ? "graph" : pluginTaskView)}
            >
              <span className="mobile-nav-tab-icon-wrapper">
                <PluginIcon />
              </span>
              <span className="mobile-nav-tab-label">{entry.view.label}</span>
            </button>
          );
        })}

        <button
          type="button"
          className={`mobile-nav-tab${isMoreActive ? " mobile-nav-tab--active" : ""}`}
          data-testid="mobile-nav-tab-more"
          role="tab"
          aria-selected={false}
          onClick={() => {
            if (isMoreOpen) {
              dismissMore();
            } else {
              setIsMoreOpen(true);
            }
          }}
        >
          <span className="mobile-nav-tab-icon-wrapper">
            <MoreHorizontal />
            {planningNeedsInput && view !== "planning" && !isMoreOpen && (
              <span className="status-dot status-dot--pending mobile-nav-chat-unread-dot" aria-label={t("nav.planningNeedsInputAriaLabel", "Planning needs your input")} />
            )}
          </span>
          <span className="mobile-nav-tab-label">{t("nav.more", "More")}</span>
        </button>
      </nav>

      {isMoreOpen && (
        <>
          <div
            className="mobile-more-sheet-backdrop"
            onClick={dismissMore}
          />
          <div
            ref={sheetRef}
            className={`mobile-more-sheet${isSheetDragging ? " mobile-more-sheet--dragging" : ""}${hasSheetDragged ? " mobile-more-sheet--gesture-ready" : ""}`}
            style={{ transform: `translateY(${dragOffset}px)` }}
            onTouchStart={handleSheetTouchStart}
            onTouchEnd={finishSheetDrag}
            onTouchCancel={resetSheetDrag}
          >
            <div className="mobile-more-sheet-handle" aria-hidden="true" />
            <div className="mobile-more-sheet-title">{t("nav.moreSheetTitle", "Navigate")}</div>

            {shellConnectionControl ? (
              <div className="mobile-more-shell-connection" data-testid="mobile-more-shell-connection">
                {shellConnectionControl}
              </div>
            ) : null}

            <div className="mobile-more-split-row">
              <button
                type="button"
                className="mobile-more-item mobile-more-split-primary"
                data-testid="mobile-more-item-terminal"
                onClick={() => handleMoreAction(onToggleTerminal)}
              >
                <Terminal />
                <span>{t("nav.terminal", "Terminal")}</span>
              </button>
              <button
                type="button"
                className="mobile-more-split-toggle"
                data-testid="mobile-more-terminal-split-toggle"
                onClick={() => setIsScriptsSubmenuOpen((prev) => !prev)}
                aria-expanded={isScriptsSubmenuOpen}
                aria-haspopup="menu"
                aria-label={t("nav.showScriptsAriaLabel", "Show scripts")}
              >
                <ChevronRight
                  size={14}
                  className={`mobile-more-chevron${isScriptsSubmenuOpen ? " mobile-more-chevron--open" : ""}`}
                />
              </button>
            </div>
            {isScriptsSubmenuOpen && (
              <div className="mobile-more-submenu" role="menu" aria-label={t("nav.scriptsSubmenuAriaLabel", "Scripts submenu")}>
                {scriptsLoading ? (
                  <div className="mobile-more-submenu-loading" data-testid="mobile-more-scripts-loading">
                    <Loader2 className="animate-spin" />
                    <span>{t("nav.loadingScripts", "Loading scripts…")}</span>
                  </div>
                ) : scriptEntries.length > 0 ? (
                  <>
                    {scriptEntries.map(([name, command]) => (
                      <button
                        key={name}
                        type="button"
                        className="mobile-more-item mobile-more-subitem"
                        data-testid={`mobile-more-script-item-${name}`}
                        onClick={() => {
                          if (onRunScript) onRunScript(name, command);
                          dismissMore();
                          setIsScriptsSubmenuOpen(false);
                        }}
                      >
                        <Play />
                        <span>{name}</span>
                      </button>
                    ))}
                    {onOpenScripts && (
                      <button
                        type="button"
                        className="mobile-more-item mobile-more-subitem mobile-more-subitem--manage"
                        data-testid="mobile-more-scripts-manage"
                        onClick={() => {
                          dismissMore();
                          setIsScriptsSubmenuOpen(false);
                          onOpenScripts();
                        }}
                      >
                        <FileCode />
                        <span>{t("nav.manageScripts", "Manage Scripts…")}</span>
                      </button>
                    )}
                  </>
                ) : (
                  onOpenScripts && (
                    <button
                      type="button"
                      className="mobile-more-item mobile-more-subitem"
                      data-testid="mobile-more-scripts-manage"
                      onClick={() => {
                        dismissMore();
                        setIsScriptsSubmenuOpen(false);
                        onOpenScripts();
                      }}
                    >
                      <FileCode />
                      <span>{t("nav.noScriptsAddOne", "No scripts — add one…")}</span>
                    </button>
                  )
                )}
              </div>
            )}



            {effectiveOmittedItems
              .filter((item) => item !== "settings")
              .map((item) => renderSelectableItem(item, "more"))}

            {overflowPluginViews.map((entry) => {
                const pluginTaskView = buildPluginTaskViewId(entry.pluginId, entry.view.viewId);
                const PluginIcon = getPluginDashboardViewNavIcon(entry);
                return (
                  <button
                    key={`${entry.pluginId}:${entry.view.viewId}`}
                    type="button"
                    className="mobile-more-item"
                    data-testid={`mobile-more-item-plugin-${entry.pluginId}-${entry.view.viewId}`}
                    onClick={() => handleMoreAction(() => onChangeView(entry.pluginId === "fusion-plugin-dependency-graph" && entry.view.viewId === "graph" ? "graph" : pluginTaskView))}
                  >
                    <PluginIcon />
                    <span>{entry.view.label}</span>
                  </button>
                );
              })}

            <div className="mobile-more-separator" />
            {/*
            FNXC:Navigation 2026-07-17-15:43:
            Mobile More-sheet pins Settings below the `mobile-more-separator` divider so it stays at the bottom of
            the list (FN-8250), not inline in the middle. The omitted-items guard prevents a duplicate when Settings
            is promoted to a primary footer tab.
            */}
            {effectiveOmittedItems.includes("settings") && renderSelectableItem("settings", "more")}

          </div>
        </>
      )}
    </>
  );
}
