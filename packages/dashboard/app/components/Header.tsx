import { useState, useEffect, useRef, useCallback, useMemo, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Settings, Pause, Play, Square, LayoutGrid, List, Terminal, Lightbulb, Search, X, Activity, MoreHorizontal, Clock, Folder, History, GitBranch, Monitor, Server, Workflow, Bot, Target, ChevronRight, FileCode, Loader2, Grid3X3, Mail, MessageSquare, ChevronDown, Check, Zap, Sparkles, FileText, Brain, CheckSquare, Lock, Gauge } from "lucide-react";
import "./Header.css";
// ProjectSelector styles used by the imported standalone component.
import "./ProjectSelector.css";
import { ProjectSelector as StandaloneProjectSelector } from "./ProjectSelector";
import type { ProjectInfo } from "../api";
import type { NodeConfig, ProjectStatus } from "@fusion/core";
import { fetchScripts } from "../api";
import { NodeStatusIndicator } from "./NodeStatusIndicator";
import { NodeHealthDot } from "./NodeHealthDot";
import { PluginSlot } from "./PluginSlot";
import { useViewportMode, type ViewportMode } from "../hooks/useViewportMode";
import { getTrailingPath } from "../utils/pathDisplay";
import type { TaskView } from "../hooks/useViewState";
import type { PluginDashboardViewEntry } from "../api";
import { buildPluginTaskViewId, isPluginViewId } from "../plugins/pluginViewRegistry";
import { getPluginNavIcon } from "./pluginNavIcon";
import type { ShellHostContext } from "../shell-host";

export { useViewportMode };

const NO_BRANCH_FILTER_VALUE = "__fusion:no-branch__";

// Status icon config for project selector dropdown
const PROJECT_STATUS_CONFIG: Record<ProjectStatus, { color: string }> = {
  active: { color: "var(--success)" },
  paused: { color: "var(--warning)" },
  errored: { color: "var(--color-error)" },
  initializing: { color: "var(--info)" },
};

// Inline ProjectSelector removed — now imports StandaloneProjectSelector from ./ProjectSelector
// which has scroll fix, autocomplete, and bookmarking features.

// GitHub logo icon (Octocat mark) - uses currentColor for theme compatibility
function GitHubLogo({ size = 16 }: { size?: number }) {
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

interface DropdownPosition {
  top: number;
  left: number;
  width: number;
}

export interface HeaderProps {
  onOpenSettings?: () => void;
  onOpenGitHubImport?: () => void;
  onOpenPlanning?: () => void;
  /** Resume an in-flight planning session. Takes priority over onOpenPlanning when activePlanningSessionCount > 0 */
  onResumePlanning?: () => void;
  /** Number of active planning sessions. When > 0, shows a badge on the Planning button. */
  activePlanningSessionCount?: number;
  onOpenUsage?: (anchorRect?: DOMRect | null) => void;
  onOpenActivityLog?: () => void;
  /** Opens the mailbox view */
  onOpenMailbox?: () => void;
  /** Unread message count for badge display */
  mailboxUnreadCount?: number;
  /** Pending approval count for mailbox indicator */
  mailboxPendingApprovalCount?: number;
  /** Whether chat has an unread assistant response */
  chatHasUnreadResponse?: boolean;
  /** Count of orphaned merger autostashes for stash recovery indicator. */
  stashOrphanCount?: number;
  onOpenSchedules?: () => void;
  onOpenGitManager?: () => void;
  onOpenNodes?: () => void;
  /** When false, hides the Nodes management button. Defaults to true for backward compat. */
  showNodesButton?: boolean;
  onOpenWorkflowEditor?: () => void;
  onOpenScripts?: () => void;
  onRunScript?: (name: string, command: string) => void;
  onToggleTerminal?: () => void;
  /** Opens the top-level workspace-aware file browser modal. */
  onOpenFiles?: () => void;
  filesOpen?: boolean;
  onOpenTodos?: () => void;
  todosOpen?: boolean;
  todosEnabled?: boolean;
  globalPaused?: boolean;
  enginePaused?: boolean;
  onToggleGlobalPause?: () => void;
  onToggleEnginePause?: () => void;
  view?: TaskView;
  onChangeView?: (view: TaskView) => void;
  /** Whether to show the skills tab in the view toggle */
  showSkillsTab?: boolean;
  /** When true, shows the Agents view tab button. Hidden by default (experimental feature). */
  showAgentsTab?: boolean;
  searchQuery?: string;
  onSearchChange?: (query: string) => void;
  branchFilter?: string;
  baseBranchFilter?: string;
  branchOptions?: string[];
  baseBranchOptions?: string[];
  onBranchFilterChange?: (value: string) => void;
  onBaseBranchFilterChange?: (value: string) => void;
  /** Multi-project props */
  projects?: ProjectInfo[];
  currentProject?: ProjectInfo | null;
  onSelectProject?: (project: ProjectInfo) => void;
  onViewAllProjects?: () => void;
  projectId?: string;
  shellHost?: ShellHostContext;
  /** When true, the mobile bottom nav bar handles primary navigation and header nav controls are hidden. */
  mobileNavEnabled?: boolean;
  /** Available nodes for the node selector */
  availableNodes?: NodeConfig[];
  /** Currently selected node (null for local) */
  currentNode?: NodeConfig | null;
  /** Callback when a node is selected */
  onSelectNode?: (node: NodeConfig | null) => void;
  /** Whether the current view is a remote node */
  isRemote?: boolean;
  /** Experimental feature flags controlling visibility of nav items. */
  experimentalFeatures?: { insights?: boolean; memoryView?: boolean; devServer?: boolean; devServerView?: boolean; researchView?: boolean; evalsView?: boolean; goalsView?: boolean };
  pluginDashboardViews?: PluginDashboardViewEntry[];
  shellConnectionControl?: ReactNode;
}

export function Header({
  onOpenSettings,
  onOpenGitHubImport,
  onOpenPlanning,
  onResumePlanning,
  activePlanningSessionCount = 0,
  onOpenUsage,
  onOpenActivityLog,
  onOpenMailbox,
  mailboxUnreadCount = 0,
  mailboxPendingApprovalCount = 0,
  chatHasUnreadResponse = false,
  stashOrphanCount = 0,
  onOpenSchedules,
  onOpenGitManager,
  onOpenNodes,
  showNodesButton,
  onOpenWorkflowEditor,
  onOpenScripts,
  onRunScript,
  onToggleTerminal,
  onOpenFiles,
  filesOpen,
  onOpenTodos,
  todosOpen,
  todosEnabled,
  globalPaused,
  enginePaused,
  onToggleGlobalPause,
  onToggleEnginePause,
  view = "board",
  onChangeView,
  showSkillsTab,
  showAgentsTab,
  searchQuery = "",
  onSearchChange,
  branchFilter = "",
  baseBranchFilter = "",
  branchOptions = [],
  baseBranchOptions = [],
  onBranchFilterChange,
  onBaseBranchFilterChange,
  projects = [],
  currentProject,
  onSelectProject,
  onViewAllProjects,
  projectId,
  shellHost = { kind: "browser" },
  mobileNavEnabled,
  availableNodes = [],
  currentNode,
  onSelectNode,
  isRemote = false,
  experimentalFeatures,
  pluginDashboardViews = [],
  shellConnectionControl,
}: HeaderProps) {
  const { t } = useTranslation("app");
  const mode: ViewportMode = useViewportMode();
  const isMobile = mode === "mobile";
  const isTablet = mode === "tablet";
  const isCompact = isMobile || isTablet;
  const hideFullNav = isMobile && mobileNavEnabled;
  const [isMobileSearchOpen, setIsMobileSearchOpen] = useState(false);
  const [isNonMobileSearchOpen, setIsNonMobileSearchOpen] = useState(false);
  // Track when user has explicitly closed the search (used for toggle visibility)
  const [isNonMobileSearchExplicitlyClosed, setIsNonMobileSearchExplicitlyClosed] = useState(false);
  const [isOverflowMenuOpen, setIsOverflowMenuOpen] = useState(false);
  const [isTerminalSubmenuOpen, setIsTerminalSubmenuOpen] = useState(false);
  const [isNodeSelectorOpen, setIsNodeSelectorOpen] = useState(false);
  const [isMobileProjectSwitchOpen, setIsMobileProjectSwitchOpen] = useState(false);
  const [isViewOverflowOpen, setIsViewOverflowOpen] = useState(false);
  const [isDesktopOverflowOpen, setIsDesktopOverflowOpen] = useState(false);
  const [isEngineMenuOpen, setIsEngineMenuOpen] = useState(false);
  const [isScriptsOpen, setIsScriptsOpen] = useState(false);
  const [scripts, setScripts] = useState<Record<string, string>>({});
  const [scriptsLoading, setScriptsLoading] = useState(false);
  const [highlightedScriptIndex, setHighlightedScriptIndex] = useState(-1);
  const [scriptsDropdownPosition, setScriptsDropdownPosition] = useState<DropdownPosition | null>(null);
  const [overflowScripts, setOverflowScripts] = useState<Record<string, string>>({});
  const [overflowScriptsLoading, setOverflowScriptsLoading] = useState(false);
  const overflowButtonRef = useRef<HTMLButtonElement>(null);
  const overflowMenuRef = useRef<HTMLDivElement>(null);
  const desktopOverflowTriggerRef = useRef<HTMLButtonElement>(null);
  const desktopOverflowRef = useRef<HTMLDivElement>(null);
  const mobileSearchRef = useRef<HTMLDivElement>(null);
  const mobileSearchInputRef = useRef<HTMLInputElement>(null);
  const terminalSubmenuOpenRef = useRef(false);
  const nodeSelectorRef = useRef<HTMLDivElement>(null);
  const mobileProjectSwitchRef = useRef<HTMLDivElement>(null);
  const viewOverflowRef = useRef<HTMLDivElement>(null);
  const viewOverflowTriggerRef = useRef<HTMLButtonElement>(null);
  const engineMenuRef = useRef<HTMLDivElement>(null);
  const scriptsSplitButtonRef = useRef<HTMLDivElement>(null);
  const scriptsChevronButtonRef = useRef<HTMLButtonElement>(null);
  const scriptsMenuRef = useRef<HTMLDivElement>(null);
  const scriptsOpenRef = useRef(false);
  
  // Get remote nodes only (exclude local node type)
  const remoteNodes = useMemo(() => 
    availableNodes.filter((node) => node.type === "remote"),
    [availableNodes]
  );
  const showNodeSelector = remoteNodes.length > 0;

  // Script entries sorted alphabetically for desktop scripts dropdown
  const scriptEntries = useMemo(() => {
    return Object.entries(scripts).sort(([a], [b]) => a.localeCompare(b));
  }, [scripts]);

  const showScriptsFooter = scriptEntries.length > 0;
  const totalScriptItems = scriptEntries.length + (showScriptsFooter ? 1 : 0);

  // Script entries sorted alphabetically for overflow submenu
  const overflowScriptEntries = useMemo(() => {
    return Object.entries(overflowScripts).sort(([a], [b]) => a.localeCompare(b));
  }, [overflowScripts]);

  const hasViewOverflowItems = useMemo(() => {
    return !!(
      onChangeView ||
      experimentalFeatures?.researchView ||
      todosEnabled ||
      experimentalFeatures?.insights ||

      showSkillsTab ||
      experimentalFeatures?.memoryView ||
      experimentalFeatures?.devServerView ||
      !hideFullNav ||
      isTablet ||
      pluginDashboardViews.some((entry) => entry.view.placement !== "primary")
    );
  }, [onChangeView, experimentalFeatures, todosEnabled, showSkillsTab, hideFullNav, isTablet, pluginDashboardViews]);

  const getEffectiveViewport = useCallback(() => {
    const vv = window.visualViewport;
    if (vv && vv.width > 0 && vv.height > 0) {
      return {
        width: vv.width,
        height: vv.height,
        offsetTop: vv.offsetTop,
        offsetLeft: vv.offsetLeft,
      };
    }

    return {
      width: window.innerWidth,
      height: window.innerHeight,
      offsetTop: 0,
      offsetLeft: 0,
    };
  }, []);

  const updateScriptsDropdownPosition = useCallback(() => {
    const trigger = scriptsChevronButtonRef.current;
    if (!trigger) return;

    const rect = trigger.getBoundingClientRect();
    const menu = scriptsMenuRef.current;
    const { width: viewportWidth, height: viewportHeight, offsetTop, offsetLeft } = getEffectiveViewport();
    const horizontalPadding = 16;
    const verticalPadding = 16;
    const gap = 6;

    const measuredWidth = menu?.offsetWidth || Math.max(rect.width, 260);
    const width = Math.min(
      measuredWidth,
      Math.max(viewportWidth - horizontalPadding * 2, 160),
    );

    const measuredHeight = menu?.offsetHeight || 280;
    const constrainedHeight = Math.min(
      measuredHeight,
      Math.max(viewportHeight - verticalPadding * 2, 160),
    );

    const triggerTop = rect.top - offsetTop;
    const triggerBottom = rect.bottom - offsetTop;
    const triggerRight = rect.right - offsetLeft;

    const spaceBelow = viewportHeight - triggerBottom;
    const spaceAbove = triggerTop;

    const openUpward = spaceBelow < constrainedHeight && spaceAbove > spaceBelow;

    const left = Math.min(
      Math.max(triggerRight - width, horizontalPadding),
      viewportWidth - horizontalPadding - width,
    ) + offsetLeft;

    const top = openUpward
      ? Math.max(verticalPadding + offsetTop, triggerTop - constrainedHeight - gap + offsetTop)
      : Math.min(
          triggerBottom + gap + offsetTop,
          viewportHeight + offsetTop - verticalPadding - constrainedHeight,
        );

    setScriptsDropdownPosition({ top, left, width });
  }, [getEffectiveViewport]);

  const handleRunQuickScript = useCallback(
    (name: string, command: string) => {
      onRunScript?.(name, command);
      setIsScriptsOpen(false);
      setHighlightedScriptIndex(-1);
    },
    [onRunScript],
  );

  const handleManageScripts = useCallback(() => {
    onOpenScripts?.();
    setIsScriptsOpen(false);
    setHighlightedScriptIndex(-1);
  }, [onOpenScripts]);

  const handleScriptsDropdownKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          if (totalScriptItems > 0) {
            setHighlightedScriptIndex((prev) => (prev < totalScriptItems - 1 ? prev + 1 : 0));
          }
          break;
        case "ArrowUp":
          e.preventDefault();
          if (totalScriptItems > 0) {
            setHighlightedScriptIndex((prev) => (prev > 0 ? prev - 1 : totalScriptItems - 1));
          }
          break;
        case "Enter":
          e.preventDefault();
          if (highlightedScriptIndex >= 0) {
            if (highlightedScriptIndex < scriptEntries.length) {
              const [name, command] = scriptEntries[highlightedScriptIndex];
              handleRunQuickScript(name, command);
            } else if (showScriptsFooter && highlightedScriptIndex === scriptEntries.length) {
              handleManageScripts();
            }
          }
          break;
        case "Home":
          e.preventDefault();
          if (totalScriptItems > 0) {
            setHighlightedScriptIndex(0);
          }
          break;
        case "End":
          e.preventDefault();
          if (totalScriptItems > 0) {
            setHighlightedScriptIndex(totalScriptItems - 1);
          }
          break;
      }
    },
    [handleManageScripts, handleRunQuickScript, highlightedScriptIndex, scriptEntries, showScriptsFooter, totalScriptItems],
  );

  // Keep ref in sync with state
  useEffect(() => {
    terminalSubmenuOpenRef.current = isTerminalSubmenuOpen;
  }, [isTerminalSubmenuOpen]);

  useEffect(() => {
    scriptsOpenRef.current = isScriptsOpen;
  }, [isScriptsOpen]);

  // Fetch scripts when terminal submenu opens in compact mode
  useEffect(() => {
    if (!isTerminalSubmenuOpen || !isCompact) return;

    let cancelled = false;
    setOverflowScriptsLoading(true);

    fetchScripts(projectId)
      .then((data) => {
        if (!cancelled) {
          setOverflowScripts(data);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setOverflowScripts({});
        }
      })
      .finally(() => {
        if (!cancelled) {
          setOverflowScriptsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [isTerminalSubmenuOpen, isCompact, projectId]);

  // Fetch scripts when desktop scripts dropdown opens
  useEffect(() => {
    if (!isScriptsOpen || isCompact) return;

    let cancelled = false;
    setScriptsLoading(true);

    fetchScripts(projectId)
      .then((data) => {
        if (!cancelled) {
          setScripts(data);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setScripts({});
        }
      })
      .finally(() => {
        if (!cancelled) {
          setScriptsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [isScriptsOpen, isCompact, projectId]);

  // Close desktop scripts dropdown on outside click
  useEffect(() => {
    if (!isScriptsOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (
        scriptsSplitButtonRef.current &&
        !scriptsSplitButtonRef.current.contains(e.target as Node)
      ) {
        setIsScriptsOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isScriptsOpen]);

  // Close desktop scripts dropdown on Escape
  useEffect(() => {
    if (!isScriptsOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setIsScriptsOpen(false);
        scriptsChevronButtonRef.current?.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isScriptsOpen]);

  // Reset highlight and focus menu when dropdown opens
  useEffect(() => {
    if (isScriptsOpen) {
      setHighlightedScriptIndex(-1);
      const timeoutId = window.setTimeout(() => scriptsMenuRef.current?.focus(), 0);
      return () => window.clearTimeout(timeoutId);
    }

    setScriptsDropdownPosition(null);
  }, [isScriptsOpen]);

  // Position scripts dropdown when opening and content changes
  useEffect(() => {
    if (!isScriptsOpen) return;

    const rafId = requestAnimationFrame(() => {
      updateScriptsDropdownPosition();
    });

    return () => cancelAnimationFrame(rafId);
  }, [isScriptsOpen, scriptsLoading, scriptEntries.length, showScriptsFooter, updateScriptsDropdownPosition]);

  // Keep scripts dropdown anchored on viewport changes
  useEffect(() => {
    if (!isScriptsOpen) return;

    const handleReposition = () => updateScriptsDropdownPosition();

    window.addEventListener("resize", handleReposition);
    window.addEventListener("scroll", handleReposition, true);

    const vv = window.visualViewport;
    if (vv) {
      vv.addEventListener("resize", handleReposition);
      vv.addEventListener("scroll", handleReposition);
    }

    return () => {
      window.removeEventListener("resize", handleReposition);
      window.removeEventListener("scroll", handleReposition, true);
      if (vv) {
        vv.removeEventListener("resize", handleReposition);
        vv.removeEventListener("scroll", handleReposition);
      }
    };
  }, [isScriptsOpen, updateScriptsDropdownPosition]);

  useEffect(() => {
    if (isCompact) {
      setIsScriptsOpen(false);
      setHighlightedScriptIndex(-1);
    }
  }, [isCompact]);

  // Keep mobile search open if there's an active search query
  const shouldShowMobileSearch = isMobileSearchOpen || searchQuery.length > 0;

  // Non-mobile search: toggled open OR has active query, but not if explicitly closed
  const shouldShowNonMobileSearch = (isNonMobileSearchOpen || searchQuery.length > 0) && !isNonMobileSearchExplicitlyClosed;
  // Show toggle when search is available, NOT currently shown, NOT explicitly closed, AND query is empty
  const canShowNonMobileSearchToggle = (view === "board" || view === "list") && !isMobile && onSearchChange && !isNonMobileSearchExplicitlyClosed && searchQuery.length === 0;
  const canShowNonMobileSearch = (view === "board" || view === "list") && !isMobile && onSearchChange;
  const showBoardBranchFilters = view === "board";

  // Reset explicit close flag when query becomes empty (so toggle reappears)
  useEffect(() => {
    if (searchQuery === "") {
      setIsNonMobileSearchExplicitlyClosed(false);
    }
  }, [searchQuery]);

  // Close overflow menu on outside click
  useEffect(() => {
    if (!isOverflowMenuOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (
        overflowMenuRef.current &&
        !overflowMenuRef.current.contains(e.target as Node) &&
        overflowButtonRef.current &&
        !overflowButtonRef.current.contains(e.target as Node)
      ) {
        setIsOverflowMenuOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOverflowMenuOpen]);

  // Close desktop overflow menu on outside click
  useEffect(() => {
    if (!isDesktopOverflowOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (
        desktopOverflowRef.current &&
        !desktopOverflowRef.current.contains(e.target as Node) &&
        desktopOverflowTriggerRef.current &&
        !desktopOverflowTriggerRef.current.contains(e.target as Node)
      ) {
        setIsDesktopOverflowOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isDesktopOverflowOpen]);

  // Close node selector on outside click
  useEffect(() => {
    if (!isNodeSelectorOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (
        nodeSelectorRef.current &&
        !nodeSelectorRef.current.contains(e.target as Node)
      ) {
        setIsNodeSelectorOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isNodeSelectorOpen]);

  // Close menus on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setIsViewOverflowOpen(false);
        setIsDesktopOverflowOpen(false);
        if (terminalSubmenuOpenRef.current) {
          setIsTerminalSubmenuOpen(false);
          return;
        }
        if (scriptsOpenRef.current) {
          setIsScriptsOpen(false);
          scriptsChevronButtonRef.current?.focus();
          return;
        }
        setIsOverflowMenuOpen(false);
        setIsMobileSearchOpen(false);
        setIsNodeSelectorOpen(false);
        setIsMobileProjectSwitchOpen(false);
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Close mobile project switch on outside click
  useEffect(() => {
    if (!isMobileProjectSwitchOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (
        mobileProjectSwitchRef.current &&
        !mobileProjectSwitchRef.current.contains(e.target as Node)
      ) {
        setIsMobileProjectSwitchOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isMobileProjectSwitchOpen]);

  // Close engine controls dropdown on outside click
  useEffect(() => {
    if (!isEngineMenuOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (engineMenuRef.current && !engineMenuRef.current.contains(e.target as Node)) {
        setIsEngineMenuOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isEngineMenuOpen]);

  // Close engine controls dropdown on Escape
  useEffect(() => {
    if (!isEngineMenuOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setIsEngineMenuOpen(false);
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isEngineMenuOpen]);

  // Close view toggle overflow on outside click
  useEffect(() => {
    if (!isViewOverflowOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (
        viewOverflowRef.current &&
        !viewOverflowRef.current.contains(e.target as Node) &&
        viewOverflowTriggerRef.current &&
        !viewOverflowTriggerRef.current.contains(e.target as Node)
      ) {
        setIsViewOverflowOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isViewOverflowOpen]);

  const handleMobileSearchToggle = useCallback(() => {
    setIsMobileSearchOpen((prev) => !prev);
  }, []);

  const handleNonMobileSearchToggle = useCallback(() => {
    setIsNonMobileSearchOpen(true);
    setIsNonMobileSearchExplicitlyClosed(false);
  }, []);

  const handleNonMobileSearchClose = useCallback(() => {
    setIsNonMobileSearchOpen(false);
    setIsNonMobileSearchExplicitlyClosed(true);
    if (onSearchChange) onSearchChange("");
  }, [onSearchChange]);

  const handleOverflowToggle = useCallback(() => {
    setIsOverflowMenuOpen((prev) => !prev);
  }, []);

  const handleOverflowAction = useCallback((callback?: () => void) => {
    if (callback) callback();
    setIsOverflowMenuOpen(false);
    setIsTerminalSubmenuOpen(false);
  }, []);

  const handleMobileSearchClose = useCallback(() => {
    setIsMobileSearchOpen(false);
    if (onSearchChange) onSearchChange("");
  }, [onSearchChange]);

  const isDesktopShell = shellHost.kind === "desktop-shell";

  return (
    <div className="header-wrapper">
      <header className="header" data-shell-kind={shellHost.kind}>
        <div className="header-left">
          <div className="header-brand">
          <svg
            className="header-logo"
            width={24}
            height={24}
            viewBox="0 0 128 128"
            fill="none"
            aria-label="Fusion logo"
            role="img"
          >
            <circle
              cx="64"
              cy="64"
              r="52"
              stroke="currentColor"
              strokeWidth="8"
            />
            <path
              d="M26 101C44 82 62 64 82 45C90 37 98 30 104 24C96 35 89 47 81 60C70 79 57 95 43 108C38 112 32 108 26 101Z"
              fill="currentColor"
            />
          </svg>
          <h1 className="logo">Fusion</h1>
        </div>

        {/* Mobile Project Switch - dropdown trigger next to logo when at least one project exists (mobile only) */}
        {isMobile && projects.length >= 1 && onSelectProject && (
          <div className="mobile-project-switch" ref={mobileProjectSwitchRef}>
            <button
              className={`mobile-project-switch-trigger${isMobileProjectSwitchOpen ? " mobile-project-switch-trigger--open" : ""}`}
              onClick={() => setIsMobileProjectSwitchOpen((prev) => !prev)}
              title={t("header.switchProject", "Switch project")}
              aria-label={t("header.switchProject", "Switch project")}
              aria-expanded={isMobileProjectSwitchOpen}
              aria-haspopup="listbox"
              data-testid="mobile-project-switch-trigger"
            >
              <ChevronDown size={14} className={`mobile-project-switch-chevron${isMobileProjectSwitchOpen ? " mobile-project-switch-chevron--open" : ""}`} />
            </button>
            {isMobileProjectSwitchOpen && (
              <div
                className="mobile-project-switch-dropdown"
                role="listbox"
                aria-label={t("header.selectProject", "Select project")}
                data-testid="mobile-project-switch-dropdown"
              >
                {projects.map((project) => {
                  const isCurrent = currentProject?.id === project.id;
                  const statusColor = PROJECT_STATUS_CONFIG[project.status]?.color;
                  return (
                    <button
                      key={project.id}
                      className={`mobile-project-switch-item${isCurrent ? " mobile-project-switch-item--current" : ""}`}
                      onClick={() => {
                        onSelectProject(project);
                        setIsMobileProjectSwitchOpen(false);
                      }}
                      role="option"
                      aria-selected={isCurrent}
                      data-testid={`mobile-project-switch-item-${project.id}`}
                    >
                      <span
                        className="mobile-project-switch-dot"
                        style={{ backgroundColor: statusColor || "var(--text-muted)" }}
                      />
                      <div className="mobile-project-switch-info">
                        <span className="mobile-project-switch-name">{project.name}</span>
                        <span className="mobile-project-switch-path">
                          {getTrailingPath(project.path, 2)}
                        </span>
                      </div>
                      {isCurrent && <Check size={14} className="mobile-project-switch-check" />}
                    </button>
                  );
                })}
                {onViewAllProjects && (
                  <>
                    <div className="mobile-project-switch-divider" />
                    <button
                      className="mobile-project-switch-manage"
                      onClick={() => {
                        onViewAllProjects();
                        setIsMobileProjectSwitchOpen(false);
                      }}
                      data-testid="mobile-project-switch-view-all"
                    >
                      <Grid3X3 size={14} />
                      <span>{t("header.viewProjects", "View Projects")}</span>
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        )}

        {/* Project Selector - Back button when project selected, dropdown when 2+ projects (tablet + desktop) */}
        {!isMobile && projects.length >= 1 && onViewAllProjects && (
          <StandaloneProjectSelector
            projects={projects}
            currentProject={currentProject ?? null}
            onViewAll={onViewAllProjects}
            onSelect={onSelectProject}
            allowSingleProject
            viewAllLabel={t("header.manageProjects", "Manage Projects")}
          />
        )}

        {/* Node selector and status indicator */}
        {showNodeSelector && (
          <div
            className={`header-node-selector${isMobile ? " header-node-selector--mobile" : ""}`}
            ref={isMobile ? undefined : nodeSelectorRef}
          >
            {/* Node status indicator - always visible */}
            <NodeStatusIndicator
              node={currentNode ?? null}
              showDetails={!isMobile}
            />

            {/* Node selector dropdown - desktop/tablet only */}
            {!isMobile && (
              <>
                <button
                  className={`btn-icon node-selector-trigger${isNodeSelectorOpen ? " node-selector-trigger--open" : ""}`}
                  onClick={() => setIsNodeSelectorOpen((prev) => !prev)}
                  title={t("header.switchNode", "Switch node")}
                  aria-label={t("header.switchNode", "Switch node")}
                  aria-expanded={isNodeSelectorOpen}
                  aria-haspopup="listbox"
                  data-testid="node-selector-trigger"
                >
                  <ChevronRight
                    size={12}
                    className={`node-selector-chevron${isNodeSelectorOpen ? " node-selector-chevron--open" : ""}`}
                  />
                </button>

                {/* Node selector dropdown menu */}
                {isNodeSelectorOpen && (
                  <div className="node-selector-dropdown" role="listbox" aria-label={t("header.selectNode", "Select node")}>
                    {/* Local option */}
                    <button
                      className={`node-selector-option${!isRemote ? " node-selector-option--active" : ""}`}
                      onClick={() => {
                        onSelectNode?.(null);
                        setIsNodeSelectorOpen(false);
                      }}
                      role="option"
                      aria-selected={!isRemote}
                      data-testid="node-option-local"
                    >
                      <NodeHealthDot status="online" compact />
                      <span className="node-selector-option-label">{t("header.localNode", "Local")}</span>
                    </button>

                    {/* Remote nodes */}
                    {remoteNodes.map((node) => (
                      <button
                        key={node.id}
                        className={`node-selector-option${currentNode?.id === node.id ? " node-selector-option--active" : ""}`}
                        onClick={() => {
                          onSelectNode?.(node);
                          setIsNodeSelectorOpen(false);
                        }}
                        role="option"
                        aria-selected={currentNode?.id === node.id}
                        data-testid={`node-option-${node.id}`}
                      >
                        <NodeHealthDot status={node.status} compact />
                        <span className="node-selector-option-label">{node.name}</span>
                        <span className="node-selector-option-status">{node.status}</span>
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>

      <div className="header-actions">
        {shellConnectionControl}
        {/* Mobile View Toggle - compact board/list switcher in header when mobile nav is active */}
        {hideFullNav && onChangeView && (view === "board" || view === "list") && (
          <div className="view-toggle" data-testid="mobile-view-toggle">
            <button
              className={`view-toggle-btn${view === "board" ? " active" : ""}`}
              onClick={() => onChangeView("board")}
              title={t("header.boardView", "Board view")}
              aria-label={t("header.boardView", "Board view")}
              aria-pressed={view === "board"}
              data-testid="mobile-view-toggle-board"
            >
              <LayoutGrid size={16} />
            </button>
            <button
              className={`view-toggle-btn${view === "list" ? " active" : ""}`}
              onClick={() => onChangeView("list")}
              title={t("header.listView", "List view")}
              aria-label={t("header.listView", "List view")}
              aria-pressed={view === "list"}
              data-testid="mobile-view-toggle-list"
            >
              <List size={16} />
            </button>
          </div>
        )}

        {/* Mobile Search Trigger - only on mobile, show trigger button in header */}
        {onSearchChange && isMobile && (hideFullNav || view === "board" || view === "list") && !shouldShowMobileSearch && (
          <button
            className="btn-icon mobile-search-trigger"
            onClick={handleMobileSearchToggle}
            title={t("header.openSearch", "Open search")}
            aria-label={t("header.openSearch", "Open search")}
            aria-expanded={false}
            data-testid="mobile-header-search-btn"
          >
            <Search size={16} />
          </button>
        )}

        {/* Desktop/Tablet Search Toggle - show icon when search is available but hidden */}
        {canShowNonMobileSearchToggle && (
          <button
            className="btn-icon"
            onClick={handleNonMobileSearchToggle}
            title={t("header.openSearch", "Open search")}
            aria-label={t("header.openSearch", "Open search")}
            data-testid="desktop-header-search-btn"
          >
            <Search size={16} />
          </button>
        )}

        {/* Usage button on mobile when mobile bottom nav is active */}
        {isMobile && hideFullNav && onOpenUsage && (
          <button
            className="btn-icon"
            onClick={(event) => onOpenUsage(event.currentTarget.getBoundingClientRect())}
            title={t("header.viewUsage", "View usage")}
            data-testid="mobile-header-usage-btn"
          >
            <Activity size={16} />
          </button>
        )}

        {/* View Toggle - always inline, even on mobile */}
        {!hideFullNav && onChangeView && (
          <div className="view-toggle">
            <button
              className={`view-toggle-btn${view === "board" ? " active" : ""}`}
              onClick={() => onChangeView("board")}
              title={t("header.boardView", "Board view")}
              aria-label={t("header.boardView", "Board view")}
              aria-pressed={view === "board"}
            >
              <LayoutGrid size={16} />
            </button>
            <button
              className={`view-toggle-btn${view === "list" ? " active" : ""}`}
              onClick={() => onChangeView("list")}
              title={t("header.listView", "List view")}
              aria-label={t("header.listView", "List view")}
              aria-pressed={view === "list"}
            >
              <List size={16} />
            </button>
            {showAgentsTab && (
              <button
                className={`view-toggle-btn${view === "agents" ? " active" : ""}`}
                onClick={() => onChangeView("agents")}
                title={t("header.agentsView", "Agents view")}
                aria-label={t("header.agentsView", "Agents view")}
                aria-pressed={view === "agents"}
              >
                <Bot size={16} />
              </button>
            )}
            {isTablet && (
              /*
              FNXC:Navigation 2026-06-19-12:00:
              Tablet navigation promotes Command Center immediately after Agents while desktop keeps Command Center in the More-views overflow.
              Documents moves to the tablet More-views overflow below to conserve horizontal space without changing desktop ordering.
              */
              <button
                className={`view-toggle-btn${view === "command-center" ? " active" : ""}`}
                onClick={() => onChangeView("command-center")}
                title={t("header.commandCenterView", "Command Center")}
                aria-label={t("header.commandCenterView", "Command Center")}
                aria-pressed={view === "command-center"}
                data-testid="view-toggle-command-center"
              >
                <Gauge size={16} />
              </button>
            )}
            <button
              className={`view-toggle-btn${view === "missions" ? " active" : ""}`}
              onClick={() => onChangeView("missions")}
              title={t("header.missionsView", "Missions view")}
              aria-label={t("header.missionsView", "Missions view")}
              aria-pressed={view === "missions"}
            >
              <Target size={16} />
            </button>
            <button
              className={`view-toggle-btn${view === "chat" ? " active" : ""}`}
              onClick={() => onChangeView("chat")}
              title={t("header.chatView", "Chat view")}
              aria-label={t("header.chatView", "Chat view")}
              aria-pressed={view === "chat"}
              data-testid="header-chat-view-btn"
            >
              <MessageSquare size={16} />
              {chatHasUnreadResponse && view !== "chat" && (
                <span className="status-dot status-dot--pending header-chat-unread-dot" aria-label={t("header.unreadChatResponse", "Unread chat response")} />
              )}
            </button>
            {!isTablet && (
              <button
                className={`view-toggle-btn${view === "documents" ? " active" : ""}`}
                onClick={() => onChangeView("documents")}
                title={t("header.documentsView", "Documents view")}
                aria-label={t("header.documentsView", "Documents view")}
                aria-pressed={view === "documents"}
              >
                <FileText size={16} />
              </button>
            )}
            <button
              className={`view-toggle-btn${view === "mailbox" ? " active" : ""}`}
              onClick={() => onChangeView("mailbox")}
              title={t("header.mailboxView", "Mailbox view")}
              aria-label={t("header.mailboxView", "Mailbox view")}
              aria-pressed={view === "mailbox"}
            >
              <Mail size={16} />
              {view !== "mailbox" && mailboxPendingApprovalCount > 0 ? (
                <span className="status-dot status-dot--pending header-chat-unread-dot" aria-label={t("header.pendingApprovals", "Pending approvals")} />
              ) : view !== "mailbox" && mailboxUnreadCount > 0 ? (
                <span
                  className="status-dot status-dot--online header-chat-unread-dot"
                  aria-label={t("header.unreadMessages", "{{count}} unread messages", { count: mailboxUnreadCount })}
                />
              ) : null}
            </button>
            {pluginDashboardViews
              .filter((entry) => entry.view.placement === "primary")
              .sort((a, b) => (a.view.order ?? Number.MAX_SAFE_INTEGER) - (b.view.order ?? Number.MAX_SAFE_INTEGER))
              .map((entry) => {
                const pluginTaskView = buildPluginTaskViewId(entry.pluginId, entry.view.viewId);
                const PluginIcon = getPluginNavIcon(entry.view.icon);
                return (
                  <button
                    key={`${entry.pluginId}:${entry.view.viewId}`}
                    className={`view-toggle-btn${view === pluginTaskView || (view === "graph" && entry.pluginId === "fusion-plugin-dependency-graph" && entry.view.viewId === "graph") ? " active" : ""}`}
                    onClick={() => onChangeView(entry.pluginId === "fusion-plugin-dependency-graph" && entry.view.viewId === "graph" ? "graph" : pluginTaskView)}
                    title={`${entry.view.label} view`}
                    aria-label={`${entry.view.label} view`}
                    aria-pressed={view === pluginTaskView}
                    data-testid={`view-toggle-plugin-${entry.pluginId}-${entry.view.viewId}`}
                  >
                    <PluginIcon size={16} />
                  </button>
                );
              })}
            {hasViewOverflowItems && (
              <>
                <button
                  ref={viewOverflowTriggerRef}
                  className={`view-toggle-btn${["research", "skills", "insights", "memory", "secrets", "dev-server", "devserver", "graph", "stash-recovery"].includes(view) || (!isTablet && view === "command-center") || (isTablet && view === "documents") || (experimentalFeatures?.evalsView && view === "evals") || (experimentalFeatures?.goalsView && view === "goalsView") || (todosEnabled && todosOpen) || isPluginViewId(view) ? " active" : ""}`}
                  onClick={() => setIsViewOverflowOpen((prev) => !prev)}
                  title={t("header.moreViews", "More views")}
                  aria-label={t("header.moreViews", "More views")}
                  aria-haspopup="menu"
                  aria-expanded={isViewOverflowOpen}
                  data-testid="view-toggle-overflow-trigger"
                >
                  <ChevronDown size={12} />
                </button>
                {isViewOverflowOpen && (
                  <div
                    ref={viewOverflowRef}
                    className="view-toggle-overflow-menu"
                    role="menu"
                    aria-label={t("header.moreViews", "More views")}
                  >
                    {experimentalFeatures?.evalsView && (
                      <button
                        className={`view-toggle-overflow-item${view === "evals" ? " active" : ""}`}
                        onClick={() => {
                          onChangeView("evals");
                          setIsViewOverflowOpen(false);
                        }}
                        role="menuitem"
                        data-testid="view-overflow-evals"
                      >
                        <Target size={14} />
                        <span>{t("header.evalsView", "Evals")}</span>
                      </button>
                    )}
                    {experimentalFeatures?.goalsView && (
                      <button
                        className={`view-toggle-overflow-item${view === "goalsView" ? " active" : ""}`}
                        onClick={() => {
                          onChangeView("goalsView");
                          setIsViewOverflowOpen(false);
                        }}
                        role="menuitem"
                        data-testid="view-overflow-goals"
                      >
                        <Target size={14} />
                        <span>{t("header.goalsView", "Goals")}</span>
                      </button>
                    )}
                    <button
                      className={`view-toggle-overflow-item${view === "stash-recovery" ? " active" : ""}`}
                      onClick={() => {
                        onChangeView("stash-recovery");
                        setIsViewOverflowOpen(false);
                      }}
                      role="menuitem"
                      data-testid="view-overflow-stash-recovery"
                    >
                      <History size={14} />
                      <span>{t("header.stashRecoveryView", "Stash Recovery")}</span>
                      {stashOrphanCount > 0 ? <span className="btn-badge">{stashOrphanCount}</span> : null}
                    </button>

                    {experimentalFeatures?.researchView && (
                      <button
                        className={`view-toggle-overflow-item${view === "research" ? " active" : ""}`}
                        onClick={() => {
                          onChangeView("research");
                          setIsViewOverflowOpen(false);
                        }}
                        role="menuitem"
                        data-testid="view-overflow-research"
                      >
                        <Search size={14} />
                        <span>{t("header.researchView", "Research")}</span>
                      </button>
                    )}
                    {experimentalFeatures?.insights && (
                      <button
                        className={`view-toggle-overflow-item${view === "insights" ? " active" : ""}`}
                        onClick={() => {
                          onChangeView("insights");
                          setIsViewOverflowOpen(false);
                        }}
                        role="menuitem"
                        data-testid="view-overflow-insights"
                      >
                        <Sparkles size={14} />
                        <span>{t("header.insightsView", "Insights")}</span>
                      </button>
                    )}

                    {showSkillsTab && (
                      <button
                        className={`view-toggle-overflow-item${view === "skills" ? " active" : ""}`}
                        onClick={() => {
                          onChangeView("skills");
                          setIsViewOverflowOpen(false);
                        }}
                        role="menuitem"
                        data-testid="view-overflow-skills"
                      >
                        <Zap size={14} />
                        <span>{t("header.skillsView", "Skills")}</span>
                      </button>
                    )}
                    {experimentalFeatures?.memoryView && (
                      <button
                        className={`view-toggle-overflow-item${view === "memory" ? " active" : ""}`}
                        onClick={() => {
                          onChangeView("memory");
                          setIsViewOverflowOpen(false);
                        }}
                        role="menuitem"
                        data-testid="view-toggle-memory"
                      >
                        <Brain size={14} />
                        <span>{t("header.memoryView", "Memory")}</span>
                      </button>
                    )}
                    <button
                      className={`view-toggle-overflow-item${view === "secrets" ? " active" : ""}`}
                      onClick={() => {
                        onChangeView("secrets");
                        setIsViewOverflowOpen(false);
                      }}
                      role="menuitem"
                      data-testid="view-overflow-secrets"
                    >
                      <Lock size={14} />
                      <span>{t("header.secretsView", "Secrets")}</span>
                    </button>
                    {isTablet && (
                      <button
                        className={`view-toggle-overflow-item${view === "documents" ? " active" : ""}`}
                        onClick={() => {
                          onChangeView("documents");
                          setIsViewOverflowOpen(false);
                        }}
                        role="menuitem"
                        data-testid="view-overflow-documents"
                      >
                        <FileText size={14} />
                        <span>{t("header.documentsView", "Documents view")}</span>
                      </button>
                    )}
                    {!isTablet && (
                      <button
                        className={`view-toggle-overflow-item${view === "command-center" ? " active" : ""}`}
                        onClick={() => {
                          onChangeView("command-center");
                          setIsViewOverflowOpen(false);
                        }}
                        role="menuitem"
                        data-testid="view-overflow-command-center"
                      >
                        <Gauge size={14} />
                        <span>{t("header.commandCenterView", "Command Center")}</span>
                      </button>
                    )}
                    {experimentalFeatures?.devServerView && (
                      <button
                        className={`view-toggle-overflow-item${view === "dev-server" || view === "devserver" ? " active" : ""}`}
                        onClick={() => {
                          onChangeView("devserver");
                          setIsViewOverflowOpen(false);
                        }}
                        role="menuitem"
                        data-testid="view-toggle-devserver"
                      >
                        <Monitor size={14} />
                        <span>{t("header.devServerView", "Dev Server")}</span>
                        <span className="visually-hidden" data-testid="view-toggle-dev-server" />
                      </button>
                    )}
                    {todosEnabled && onOpenTodos && (
                      <button
                        className={`view-toggle-overflow-item${todosOpen ? " active" : ""}`}
                        onClick={() => {
                          onOpenTodos();
                          setIsViewOverflowOpen(false);
                        }}
                        role="menuitem"
                        data-testid="view-overflow-todos"
                      >
                        <CheckSquare size={14} />
                        <span>{t("header.todosView", "Todos")}</span>
                      </button>
                    )}
                    {pluginDashboardViews
                      .filter((entry) => entry.view.placement !== "primary")
                      .sort((a, b) => (a.view.order ?? Number.MAX_SAFE_INTEGER) - (b.view.order ?? Number.MAX_SAFE_INTEGER))
                      .map((entry) => {
                        const pluginTaskView = buildPluginTaskViewId(entry.pluginId, entry.view.viewId);
                        const PluginIcon = getPluginNavIcon(entry.view.icon);
                        return (
                          <button
                            key={`${entry.pluginId}:${entry.view.viewId}`}
                            className={`view-toggle-overflow-item${view === pluginTaskView || (view === "graph" && entry.pluginId === "fusion-plugin-dependency-graph" && entry.view.viewId === "graph") ? " active" : ""}`}
                            onClick={() => {
                              onChangeView(entry.pluginId === "fusion-plugin-dependency-graph" && entry.view.viewId === "graph" ? "graph" : pluginTaskView);
                              setIsViewOverflowOpen(false);
                            }}
                            role="menuitem"
                            data-testid={`view-overflow-plugin-${entry.pluginId}-${entry.view.viewId}`}
                          >
                            <PluginIcon size={14} />
                            <span>{entry.view.label}</span>
                          </button>
                        );
                      })}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* Usage button - desktop only (moved to overflow on mobile/tablet) */}
        {!isCompact && onOpenUsage && (
          <button
            className="btn-icon"
            onClick={(event) => onOpenUsage(event.currentTarget.getBoundingClientRect())}
            title={t("header.viewUsage", "View usage")}
            data-testid="desktop-header-usage-btn"
          >
            <Activity size={16} />
          </button>
        )}

        {/* Activity Log button - desktop only (moved to overflow on mobile/tablet) */}
        {!isCompact && onOpenActivityLog && (
          <button className="btn-icon" onClick={onOpenActivityLog} title={t("header.viewActivityLog", "View Activity Log")}>
            <History size={16} />
          </button>
        )}

        {/* Desktop actions */}
        {!isCompact && !isDesktopShell && (
          <button className="btn-icon" onClick={onOpenGitHubImport} title={t("header.importFromGitHub", "Import from GitHub")}>
            <GitHubLogo size={16} />
          </button>
        )}

        {!isCompact && (
          <button
            className={`btn-icon${activePlanningSessionCount > 0 ? " btn-icon--has-indicator" : ""}`}
            onClick={activePlanningSessionCount > 0 && onResumePlanning ? onResumePlanning : onOpenPlanning}
            title={activePlanningSessionCount > 0 ? t("header.resumePlanningSession", "Resume planning session") : t("header.createTaskWithPlanning", "Create a task with AI planning")}
            data-testid="planning-btn"
            style={{ position: "relative" }}
          >
            <Lightbulb size={16} />
            {activePlanningSessionCount > 0 && (
              <span
                className="header-badge header-badge--pulse"
                data-testid="planning-badge"
                aria-label={t("header.activePlanningSessions", { count: activePlanningSessionCount, defaultValue_one: "{{count}} active planning session", defaultValue_other: "{{count}} active planning sessions" })}
              >
                {activePlanningSessionCount}
              </span>
            )}
          </button>
        )}

        {/* Terminal split button - desktop only (moved to overflow on mobile/tablet) */}
        {!isCompact && (
          <div className="terminal-split-btn" ref={scriptsSplitButtonRef}>
            <button
              className="btn-icon btn-icon--terminal terminal-split-btn__main"
              onClick={onToggleTerminal}
              title={t("header.openTerminal", "Open Terminal")}
              data-testid="terminal-toggle-btn"
            >
              <Terminal size={16} />
            </button>
            {onOpenScripts && onRunScript && (
              <>
                <span className="terminal-split-btn__divider" />
                <button
                  ref={scriptsChevronButtonRef}
                  className={`btn-icon terminal-split-btn__chevron${isScriptsOpen ? " btn-icon--active" : ""}`}
                  onClick={() => setIsScriptsOpen((prev) => !prev)}
                  title={t("header.scripts", "Scripts")}
                  aria-haspopup="listbox"
                  aria-expanded={isScriptsOpen}
                  aria-label={t("header.quickScripts", "Quick scripts")}
                  data-testid="scripts-btn"
                >
                  <ChevronDown size={12} className={`quick-scripts-dropdown__trigger-chevron${isScriptsOpen ? " rotate" : ""}`} />
                </button>
                {isScriptsOpen && (
                  <div
                    ref={scriptsMenuRef}
                    tabIndex={-1}
                    className="quick-scripts-dropdown__menu"
                    role="listbox"
                    aria-label={t("header.scripts", "Scripts")}
                    onKeyDown={handleScriptsDropdownKeyDown}
                    data-testid="quick-scripts-dropdown"
                    style={
                      scriptsDropdownPosition
                        ? {
                            position: "fixed",
                            top: `${scriptsDropdownPosition.top}px`,
                            left: `${scriptsDropdownPosition.left}px`,
                            width: `${scriptsDropdownPosition.width}px`,
                            right: "auto",
                          }
                        : undefined
                    }
                  >
                    {scriptsLoading ? (
                      <div className="quick-scripts-dropdown__loading" data-testid="quick-scripts-loading">
                        <Loader2 size={16} className="animate-spin" />
                        <span>{t("header.loadingScripts", "Loading scripts...")}</span>
                      </div>
                    ) : scriptEntries.length === 0 ? (
                      <div className="quick-scripts-dropdown__empty" data-testid="quick-scripts-empty">
                        <div className="quick-scripts-dropdown__empty-icon">
                          <Terminal size={16} />
                        </div>
                        <p>{t("header.noScriptsConfigured", "No scripts configured")}</p>
                        <button
                          className="quick-scripts-dropdown__empty-action btn"
                          onClick={handleManageScripts}
                        >
                          {t("header.addFirstScript", "Add your first script")}
                        </button>
                      </div>
                    ) : (
                      <>
                        <div className="quick-scripts-dropdown__list">
                          {scriptEntries.map(([name, command], index) => (
                            <button
                              key={name}
                              className={`quick-scripts-dropdown__item ${
                                highlightedScriptIndex === index ? "highlighted" : ""
                              }`}
                              onClick={() => handleRunQuickScript(name, command)}
                              role="option"
                              aria-selected={highlightedScriptIndex === index}
                              data-testid={`quick-script-item-${name}`}
                            >
                              <Play size={14} className="quick-scripts-dropdown__item-icon" />
                              <div className="quick-scripts-dropdown__item-info">
                                <span className="quick-scripts-dropdown__item-name">{name}</span>
                                <span className="quick-scripts-dropdown__item-command" title={command}>
                                  {command.length > 50 ? `${command.slice(0, 50)}...` : command}
                                </span>
                              </div>
                            </button>
                          ))}
                        </div>

                        <div className="quick-scripts-dropdown__footer">
                          <button
                            className={`quick-scripts-dropdown__manage ${
                              showScriptsFooter && highlightedScriptIndex === scriptEntries.length ? "highlighted" : ""
                            }`}
                            onClick={handleManageScripts}
                            data-testid="quick-scripts-manage"
                          >
                            <Settings size={14} />
                            <span>{t("header.manageScripts", "Manage Scripts...")}</span>
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* Files button - desktop only (moved to overflow on mobile/tablet) */}
        {!isCompact && onOpenFiles && (
          <button
            className={`btn-icon${filesOpen ? " btn-icon--active" : ""}`}
            onClick={() => onOpenFiles()}
            title={t("header.browseFiles", "Browse files")}
            data-testid="files-toggle-btn"
          >
            <Folder size={16} />
          </button>
        )}

        {/* Git Manager button - desktop only (moved to overflow on mobile/tablet) */}
        {!isCompact && onOpenGitManager && (
          <button
            className="btn-icon"
            onClick={onOpenGitManager}
            title={t("header.gitManager", "Git Manager")}
            data-testid="git-manager-btn"
          >
            <GitBranch size={16} />
          </button>
        )}

        {/* Workflows - desktop only (moved to overflow on mobile/tablet) */}
        {!isCompact && onOpenWorkflowEditor && (
          <button
            className="btn-icon"
            onClick={onOpenWorkflowEditor}
            title={t("header.workflows", "Workflows")}
            data-testid="workflow-steps-btn"
          >
            <Workflow size={16} />
          </button>
        )}

        {/* Desktop overflow menu for Nodes and Schedules */}
        {!isCompact && (
          <div style={{ position: "relative" }}>
            <button
              ref={desktopOverflowTriggerRef}
              className="btn-icon"
              onClick={() => setIsDesktopOverflowOpen((prev) => !prev)}
              title={t("header.moreActions", "More actions")}
              aria-label={t("header.moreActions", "More actions")}
              aria-expanded={isDesktopOverflowOpen}
              aria-haspopup="menu"
              data-testid="desktop-overflow-trigger"
            >
              <MoreHorizontal size={16} />
            </button>
            {isDesktopOverflowOpen && (
              <div
                ref={desktopOverflowRef}
                className="desktop-overflow-menu"
                role="menu"
                aria-label={t("header.moreActions", "More actions")}
              >
                {onOpenNodes && showNodesButton !== false && (
                  <button
                    className="view-toggle-overflow-item"
                    onClick={() => {
                      onOpenNodes();
                      setIsDesktopOverflowOpen(false);
                    }}
                    role="menuitem"
                    data-testid="desktop-overflow-nodes-btn"
                  >
                    <Server size={14} />
                    <span>{t("header.nodes", "Nodes")}</span>
                  </button>
                )}
                <button
                  className="view-toggle-overflow-item"
                  onClick={() => {
                    handleOverflowAction(onOpenSchedules);
                    setIsDesktopOverflowOpen(false);
                  }}
                  role="menuitem"
                  data-testid="desktop-overflow-schedules-btn"
                >
                  <Clock size={14} />
                  <span>{t("header.automation", "Automation")}</span>
                </button>
              </div>
            )}
          </div>
        )}

        {/* Engine control split-button: main=stop/start, chevron dropdown=pause triage */}
        <div className="engine-control-split-btn" ref={engineMenuRef}>
          <button
            className={`btn-icon engine-control-split-btn__main${globalPaused ? " btn-icon--stopped" : ""}`}
            onClick={onToggleGlobalPause}
            title={globalPaused ? t("header.startAiEngine", "Start AI engine") : t("header.stopAiEngine", "Stop AI engine")}
            data-testid="engine-control-main-btn"
          >
            {globalPaused ? <Play size={16} /> : <Square size={16} />}
          </button>
          <span className="engine-control-split-btn__divider" />
          <button
            className={`btn-icon engine-control-split-btn__chevron${isEngineMenuOpen ? " btn-icon--active" : ""}`}
            onClick={() => setIsEngineMenuOpen((prev) => !prev)}
            title={t("header.engineOptions", "Engine options")}
            aria-haspopup="menu"
            aria-expanded={isEngineMenuOpen}
            data-testid="engine-control-chevron-btn"
          >
            <ChevronDown size={12} />
          </button>
          {isEngineMenuOpen && (
            <div className="engine-control-split-btn__menu" role="menu">
              <button
                className={`engine-control-split-btn__menu-item${enginePaused ? " engine-control-split-btn__menu-item--active" : ""}`}
                onClick={() => {
                  onToggleEnginePause?.();
                  setIsEngineMenuOpen(false);
                }}
                role="menuitem"
                title={enginePaused ? t("header.resumeScheduling", "Resume scheduling") : t("header.pauseTriage", "Pause triage")}
                disabled={!!globalPaused}
                data-testid="engine-control-pause-triage-btn"
              >
                {enginePaused ? <Play size={14} /> : <Pause size={14} />}
                <span>{enginePaused ? t("header.resumeScheduling", "Resume scheduling") : t("header.pauseTriage", "Pause triage")}</span>
              </button>
            </div>
          )}
        </div>

        {/* Settings - always inline on desktop, placed after engine controls */}
        {!isCompact && (
          <button className="btn-icon" onClick={onOpenSettings} title={t("header.settings", "Settings")}>
            <Settings size={16} />
          </button>
        )}

        {/* Plugin UI slot for header actions */}
        <PluginSlot slotId="header-action" projectId={projectId} />

        {/* Compact overflow menu trigger (mobile + tablet) */}
        {isCompact && !hideFullNav && (
          <button
            ref={overflowButtonRef}
            className="btn-icon compact-overflow-trigger"
            onClick={handleOverflowToggle}
            title={t("header.moreHeaderActions", "More header actions")}
            aria-label={t("header.moreHeaderActions", "More header actions")}
            aria-expanded={isOverflowMenuOpen}
            aria-haspopup="menu"
          >
            <MoreHorizontal size={16} />
          </button>
        )}

        {/* Compact overflow menu (mobile + tablet) */}
        {isCompact && !hideFullNav && isOverflowMenuOpen && (
          <div
            ref={overflowMenuRef}
            className="mobile-overflow-menu"
            role="menu"
            aria-label={t("header.additionalHeaderActions", "Additional header actions")}
          >
            {/* Projects - in overflow on mobile */}
            {isMobile && projects.length >= 1 && onViewAllProjects && (
              <button
                className="mobile-overflow-item"
                onClick={() => handleOverflowAction(onViewAllProjects)}
                role="menuitem"
                data-testid="overflow-project-selector-btn"
              >
                <Grid3X3 size={16} />
                <span>{t("header.projects", "Projects")}</span>
              </button>
            )}
            {/* Files - in overflow on mobile */}
            {onOpenFiles && (
              <button
                className="mobile-overflow-item"
                onClick={() => handleOverflowAction(onOpenFiles)}
                role="menuitem"
                data-testid="overflow-files-btn"
              >
                <Folder size={16} />
                <span>{t("header.browseFiles", "Browse Files")}</span>
              </button>
            )}
            <button
              className={`mobile-overflow-item${activePlanningSessionCount > 0 ? " mobile-overflow-item--has-indicator" : ""}`}
              onClick={() => handleOverflowAction(activePlanningSessionCount > 0 && onResumePlanning ? onResumePlanning : onOpenPlanning)}
              role="menuitem"
              data-testid="overflow-planning-btn"
            >
              <span className="mobile-overflow-icon-wrapper">
                <Lightbulb size={16} />
                {activePlanningSessionCount > 0 && (
                  <span className="header-badge header-badge--pulse" data-testid="overflow-planning-badge">
                    {activePlanningSessionCount}
                  </span>
                )}
              </span>
              <span>{activePlanningSessionCount > 0 ? t("header.resumePlanningSessionCount", "Resume planning session ({{count}})", { count: activePlanningSessionCount }) : t("header.createTaskWithPlanning", "Create a task with AI planning")}</span>
            </button>
            {/* Git Manager - in overflow on mobile */}
            {onOpenGitManager && (
              <button
                className="mobile-overflow-item"
                onClick={() => handleOverflowAction(onOpenGitManager)}
                role="menuitem"
                data-testid="overflow-git-btn"
              >
                <GitBranch size={16} />
                <span>{t("header.gitManager", "Git Manager")}</span>
              </button>
            )}
            {/* Nodes - in overflow on mobile */}
            {onOpenNodes && showNodesButton !== false && (
              <button
                className="mobile-overflow-item"
                onClick={() => handleOverflowAction(onOpenNodes)}
                role="menuitem"
                data-testid="overflow-nodes-btn"
              >
                <Server size={16} />
                <span>{t("header.nodes", "Nodes")}</span>
              </button>
            )}
            {!isDesktopShell && (
              <button
                className="mobile-overflow-item"
                onClick={() => handleOverflowAction(onOpenGitHubImport)}
                role="menuitem"
              >
                <GitHubLogo size={16} />
                <span>{t("header.importFromGitHub", "Import from GitHub")}</span>
              </button>
            )}
            <div
              className="mobile-overflow-group"
              data-testid="overflow-terminal-group"
            >
              <div className="mobile-overflow-split-row">
                <button
                  className="mobile-overflow-item mobile-overflow-split-primary"
                  onClick={() => handleOverflowAction(onToggleTerminal)}
                  role="menuitem"
                  data-testid="overflow-terminal-primary-btn"
                >
                  <Terminal size={16} />
                  <span>{t("header.terminal", "Terminal")}</span>
                </button>
                <button
                  className="mobile-overflow-split-toggle"
                  onClick={() => setIsTerminalSubmenuOpen((prev) => !prev)}
                  role="menuitem"
                  aria-expanded={isTerminalSubmenuOpen}
                  aria-haspopup="menu"
                  aria-label={t("header.showScripts", "Show scripts")}
                  data-testid="overflow-terminal-submenu-toggle"
                >
                  <ChevronRight
                    size={14}
                    className={`mobile-overflow-chevron${isTerminalSubmenuOpen ? " mobile-overflow-chevron--open" : ""}`}
                  />
                </button>
              </div>
              {isTerminalSubmenuOpen && (
                <div className="mobile-overflow-submenu" role="menu" aria-label={t("header.scriptsSubmenu", "Scripts submenu")}>
                  {overflowScriptsLoading ? (
                    <div className="mobile-overflow-submenu-loading" data-testid="overflow-scripts-loading">
                      <Loader2 size={14} className="animate-spin" />
                      <span>{t("header.loadingScripts", "Loading scripts...")}</span>
                    </div>
                  ) : overflowScriptEntries.length > 0 ? (
                    <>
                      {overflowScriptEntries.map(([name, command]) => (
                        <button
                          key={name}
                          className="mobile-overflow-item mobile-overflow-subitem"
                          onClick={() => {
                            if (onRunScript) onRunScript(name, command);
                            setIsOverflowMenuOpen(false);
                            setIsTerminalSubmenuOpen(false);
                          }}
                          role="menuitem"
                          data-testid={`overflow-script-item-${name}`}
                        >
                          <Play size={14} />
                          <span>{name}</span>
                        </button>
                      ))}
                      {onOpenScripts && (
                        <button
                          className="mobile-overflow-item mobile-overflow-subitem mobile-overflow-subitem--manage"
                          onClick={() => handleOverflowAction(onOpenScripts)}
                          role="menuitem"
                          data-testid="overflow-scripts-manage"
                        >
                          <FileCode size={14} />
                          <span>{t("header.manageScripts", "Manage Scripts...")}</span>
                        </button>
                      )}
                    </>
                  ) : (
                    onOpenScripts && (
                      <button
                        className="mobile-overflow-item mobile-overflow-subitem"
                        onClick={() => handleOverflowAction(onOpenScripts)}
                        role="menuitem"
                        data-testid="overflow-scripts-manage"
                      >
                        <FileCode size={14} />
                        <span>{t("header.noScriptsAddOne", "No scripts — add one…")}</span>
                      </button>
                    )
                  )}
                </div>
              )}
            </div>
            <button
              className="mobile-overflow-item"
              onClick={() => handleOverflowAction(onOpenSchedules)}
              role="menuitem"
              data-testid="overflow-schedules-btn"
            >
              <Clock size={16} />
              <span>{t("header.automation", "Automation")}</span>
            </button>
            {/* Activity Log - in overflow on mobile */}
            {onOpenActivityLog && (
              <button
                className="mobile-overflow-item"
                onClick={() => handleOverflowAction(onOpenActivityLog)}
                role="menuitem"
                data-testid="overflow-activity-log-btn"
              >
                <History size={16} />
                <span>{t("header.viewActivityLog", "View Activity Log")}</span>
              </button>
            )}
            {/* Mailbox - in overflow on mobile */}
            {onOpenMailbox && (
              <button
                className="mobile-overflow-item"
                onClick={() => handleOverflowAction(onOpenMailbox)}
                role="menuitem"
                data-testid="overflow-mailbox-btn"
              >
                <Mail size={16} />
                <span>{mailboxUnreadCount > 0 ? t("header.mailboxWithCount", "Mailbox ({{count}})", { count: mailboxUnreadCount }) : t("header.mailbox", "Mailbox")}</span>
                {mailboxPendingApprovalCount > 0 && (
                  <span className="header-badge" data-testid="overflow-mailbox-approval-badge">{mailboxPendingApprovalCount}</span>
                )}
              </button>
            )}
            {/* Usage - in overflow on mobile */}
            {onOpenUsage && (
              <button
                className="mobile-overflow-item"
                onClick={(event) =>
                  handleOverflowAction(() => onOpenUsage(event.currentTarget.getBoundingClientRect()))
                }
                role="menuitem"
                data-testid="overflow-usage-btn"
              >
                <Activity size={16} />
                <span>{t("header.viewUsage", "View Usage")}</span>
              </button>
            )}
            {/* Workflows - in overflow on mobile */}
            {onOpenWorkflowEditor && (
              <button
                className="mobile-overflow-item"
                onClick={() => handleOverflowAction(onOpenWorkflowEditor)}
                role="menuitem"
                data-testid="overflow-workflow-steps-btn"
              >
                <Workflow size={16} />
                <span>{t("header.workflows", "Workflows")}</span>
              </button>
            )}
            {/* Settings - always last in overflow menu */}
            <button
              className="mobile-overflow-item"
              onClick={() => handleOverflowAction(onOpenSettings)}
              role="menuitem"
            >
              <Settings size={16} />
              <span>{t("header.settings", "Settings")}</span>
            </button>
          </div>
        )}
      </div>
    </header>

    {/* Desktop/Tablet Search - floating below header, in board or list view */}
    {canShowNonMobileSearch && shouldShowNonMobileSearch && (
      <div className="header-floating-search">
        <div className="header-search">
          <Search size={14} className="header-search-icon" />
          <input
            autoFocus
            type="text"
            placeholder={t("header.searchTasks", "Search tasks...")}
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            className="header-search-input"
          />
          <button
            className="header-search-clear"
            onClick={handleNonMobileSearchClose}
            aria-label={t("header.closeSearch", "Close search")}
          >
            <X size={14} />
          </button>
        </div>
        {showBoardBranchFilters && (
          <div className="header-branch-filters" data-testid="header-branch-filters-desktop">
            <label className="header-branch-filter-label">
              <span>{t("header.workingBranch", "Working branch")}</span>
              <select
                className="header-branch-filter-select"
                value={branchFilter}
                onChange={(event) => onBranchFilterChange?.(event.target.value)}
                data-testid="working-branch-filter"
              >
                <option value="">{t("header.allWorkingBranches", "All working branches")}</option>
                <option value={NO_BRANCH_FILTER_VALUE}>{t("header.noWorkingBranch", "No working branch")}</option>
                {branchOptions.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </label>
            <label className="header-branch-filter-label">
              <span>{t("header.baseBranch", "Base branch")}</span>
              <select
                className="header-branch-filter-select"
                value={baseBranchFilter}
                onChange={(event) => onBaseBranchFilterChange?.(event.target.value)}
                data-testid="target-branch-filter"
              >
                <option value="">{t("header.allBaseBranches", "All base branches")}</option>
                <option value={NO_BRANCH_FILTER_VALUE}>{t("header.noBaseBranch", "No base branch")}</option>
                {baseBranchOptions.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
      </div>
    )}

    {/* Mobile Search Expanded - floating below header */}
    {onSearchChange && isMobile && shouldShowMobileSearch && (
      <div className="header-floating-search">
        <div
          ref={mobileSearchRef}
          className="header-search mobile-search-expanded"
        >
          <Search size={14} className="header-search-icon" />
          <input
            ref={mobileSearchInputRef}
            autoFocus
            type="text"
            placeholder={t("header.searchTasks", "Search tasks...")}
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            className="header-search-input"
          />
          <button
            className="header-search-clear"
            onClick={handleMobileSearchClose}
            aria-label={t("header.closeSearch", "Close search")}
          >
            <X size={14} />
          </button>
        </div>
        {showBoardBranchFilters && (
          <div className="header-branch-filters" data-testid="header-branch-filters-mobile">
            <label className="header-branch-filter-label">
              <span>{t("header.workingBranch", "Working branch")}</span>
              <select
                className="header-branch-filter-select"
                value={branchFilter}
                onChange={(event) => onBranchFilterChange?.(event.target.value)}
                data-testid="working-branch-filter-mobile"
              >
                <option value="">{t("header.allWorkingBranches", "All working branches")}</option>
                <option value={NO_BRANCH_FILTER_VALUE}>{t("header.noWorkingBranch", "No working branch")}</option>
                {branchOptions.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </label>
            <label className="header-branch-filter-label">
              <span>{t("header.baseBranch", "Base branch")}</span>
              <select
                className="header-branch-filter-select"
                value={baseBranchFilter}
                onChange={(event) => onBaseBranchFilterChange?.(event.target.value)}
                data-testid="target-branch-filter-mobile"
              >
                <option value="">{t("header.allBaseBranches", "All base branches")}</option>
                <option value={NO_BRANCH_FILTER_VALUE}>{t("header.noBaseBranch", "No base branch")}</option>
                {baseBranchOptions.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
      </div>
    )}
  </div>
);
}
