import "./AgentsView.css";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { useState, useEffect, useCallback, useRef, useMemo, useId, useLayoutEffect, lazy, Suspense, type CSSProperties, type ReactNode, type MutableRefObject, type RefObject, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Plus, Play, Pause, Activity, Trash2, RefreshCw, Bot, List, ChevronRight, Filter, Upload, Network, SlidersHorizontal, ZoomIn, ZoomOut, Minimize2, Move, Info } from "lucide-react";
import type { Agent, AgentCapability, AgentOnboardingSummary, AgentState, OrgTreeNode } from "../api";
import { fetchAgents, updateAgent, updateAgentState, deleteAgent, startAgentRun, fetchOrgTree, fetchSettings, updateSettings } from "../api";

const AgentDetailView = lazy(() => import("./AgentDetailView").then((m) => ({ default: m.AgentDetailView })));
import { AgentTokenStatsPanel } from "./AgentTokenStatsPanel";
import { AgentsOverviewBar } from "./AgentsOverviewBar";
import { ViewHeader } from "./ViewHeader";
import { AgentEmptyState } from "./AgentEmptyState";
import { useAgents } from "../hooks/useAgents";
import { useConfirm } from "../hooks/useConfirm";
import { NewAgentDialog } from "./NewAgentDialog";
import { AgentImportModal } from "./AgentImportModal";
import { getScopedItem, setScopedItem } from "../utils/projectStorage";
import { useViewportMode } from "../hooks/useViewportMode";
import { getAgentHealthStatus } from "../utils/agentHealth";
import type { AgentHealthStatus } from "../utils/agentHealth";
import {
  formatHeartbeatInterval,
  getHeartbeatIntervalOptions,
  resolveHeartbeatIntervalMs,
  MIN_HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_INTERVAL_PRESETS,
} from "../utils/heartbeatIntervals";
import { isEphemeralAgent, getErrorMessage } from "@fusion/core";
import { formatAgentSkillBadgeLabel } from "../utils/agentSkills";
import {
  ORG_CHART_LAYOUT_STORAGE_KEY,
  isOrgChartLayoutPreference,
  resolveOrgChartLayoutMode,
  type OrgChartLayoutMode,
  type OrgChartLayoutPreference,
} from "./agentsOrgChartLayout";
import { AgentAvatar } from "./AgentAvatar";
import { AgentErrorIndicator } from "./AgentErrorDetailsModal";
import { AgentTaskBadge } from "./AgentTaskBadge";
import { RuntimeFallbackBadge } from "./RuntimeFallbackBadge";

export interface AgentsViewProps {
  addToast: (message: string, type?: "success" | "error") => void;
  projectId?: string;
  onOpenTaskLogs?: (taskId: string) => void;
  agentOnboardingEnabled?: boolean;
}

function getAgentRoles(t: TFunction<"app">): { value: AgentCapability; label: string; icon: string }[] {
  return [
    { value: "triage", label: t("agents.roleTriage", "Triage"), icon: "⊕" },
    { value: "executor", label: t("agents.roleExecutor", "Executor"), icon: "▶" },
    { value: "reviewer", label: t("agents.roleReviewer", "Reviewer"), icon: "⊙" },
    { value: "merger", label: t("agents.roleMerger", "Merger"), icon: "⊞" },
    { value: "scheduler", label: t("agents.roleScheduler", "Scheduler"), icon: "◷" },
    { value: "engineer", label: t("agents.roleEngineer", "Engineer"), icon: "⎔" },
    { value: "custom", label: t("agents.roleCustom", "Custom"), icon: "✦" },
  ];
}

const HEARTBEAT_MULTIPLIER_PRESETS = [0.1, 0.25, 0.5, 1, 2, 3, 5, 10] as const;

const ORG_CHART_SCALE_MIN = 0.25;
const ORG_CHART_SCALE_MAX = 3;
const ORG_CHART_KEYBOARD_PAN_STEP = 16;
const ORG_CHART_OVERSCROLL = 32;

/*
FNXC:AgentsView 2026-06-20-00:00:
The Agents split view needs a wider tablet default than the old fixed CSS column and the sidebar must be user-resizable on non-mobile viewports.
Persist the clamped width per project so desktop and tablet users keep their preferred agent-list/detail balance without affecting the stacked mobile layout.
*/
const AGENTS_SIDEBAR_DEFAULT_WIDTH = 320;
const AGENTS_SIDEBAR_MIN_WIDTH = 260;
const AGENTS_SIDEBAR_MAX_WIDTH = 520;
const AGENTS_SIDEBAR_WIDTH_STORAGE_KEY = "kb-dashboard-agents-sidebar-width";

function clampAgentsSidebarWidth(width: number): number {
  return Math.max(AGENTS_SIDEBAR_MIN_WIDTH, Math.min(AGENTS_SIDEBAR_MAX_WIDTH, width));
}

function readAgentsSidebarWidth(projectId?: string): number {
  if (typeof window === "undefined") return AGENTS_SIDEBAR_DEFAULT_WIDTH;
  const stored = getScopedItem(AGENTS_SIDEBAR_WIDTH_STORAGE_KEY, projectId);
  const parsed = stored ? Number(stored) : NaN;
  if (!Number.isFinite(parsed)) return AGENTS_SIDEBAR_DEFAULT_WIDTH;
  return clampAgentsSidebarWidth(parsed);
}

function getStateBadgeClass(state: AgentState): string {
  switch (state) {
    case "running":
      return "agent-badge--running";
    case "active":
      return "agent-badge--active";
    case "paused":
      return "agent-badge--paused";
    case "error":
      return "agent-badge--error";
    case "idle":
    default:
      return "agent-badge--idle";
  }
}

function getStateCardClass(
  prefix: "agent-card" | "agent-board-card" | "org-chart-node-card",
  state: AgentState,
): string {
  switch (state) {
    case "running":
      return `${prefix}--running`;
    case "active":
      return `${prefix}--active`;
    case "paused":
      return `${prefix}--paused`;
    case "error":
      return `${prefix}--error`;
    case "idle":
    default:
      return `${prefix}--idle`;
  }
}

interface AgentModelLabel {
  label: string | null;
  isRuntime: boolean;
}

/*
FNXC:AgentsView 2026-06-23-04:00:
Agent list cards must expose the configured model or plugin runtime without requiring a detail-view open.
Use the same runtimeHint/modelProvider+modelId/legacy model fallback order as the detail view and leave no-override agents as Auto at render time.
*/
function getAgentModelLabel(agent: Agent): AgentModelLabel {
  const runtimeConfig = agent.runtimeConfig ?? {};
  const runtimeHint = typeof runtimeConfig.runtimeHint === "string" ? runtimeConfig.runtimeHint : "";
  if (runtimeHint) {
    return { label: runtimeHint, isRuntime: true };
  }

  const modelProvider = typeof runtimeConfig.modelProvider === "string" ? runtimeConfig.modelProvider : "";
  const modelId = typeof runtimeConfig.modelId === "string" ? runtimeConfig.modelId : "";
  if (modelProvider && modelId) {
    return { label: `${modelProvider}/${modelId}`, isRuntime: false };
  }

  const legacyModel = typeof runtimeConfig.model === "string" ? runtimeConfig.model : "";
  if (legacyModel.includes("/")) {
    const slashIdx = legacyModel.indexOf("/");
    return { label: legacyModel.slice(slashIdx + 1), isRuntime: false };
  }

  return { label: null, isRuntime: false };
}

function getOrgChartLeafCount(node: OrgTreeNode): number {
  if (node.children.length === 0) {
    return 1;
  }

  return node.children.reduce((sum, child) => sum + getOrgChartLeafCount(child), 0);
}

function getHealthSummary(agent: Agent, health: AgentHealthStatus, t: TFunction<"app">): { title: string | undefined; label: string | null } {
  if (agent.state === "error") {
    return { title: undefined, label: t("agents.healthError", "Error") };
  }

  return {
    title: health.reason ?? health.label,
    label: health.stateDerived ? null : health.label,
  };
}

type OrgChartLink = { parentId: string; childId: string };
type OrgChartTransform = { scale: number; x: number; y: number };

type OrgChartNodeProps = {
  node: OrgTreeNode;
  onSelect: (id: string) => void;
  getHealthStatus: (agent: Agent) => AgentHealthStatus;
  selectedAgentId: string | null;
  registerNodeElement: (id: string, element: HTMLDivElement | null) => void;
  linksRef: MutableRefObject<OrgChartLink[]>;
};

function OrgChartNode({ node, onSelect, getHealthStatus, selectedAgentId, registerNodeElement, linksRef }: OrgChartNodeProps) {
  const { t } = useTranslation("app");
  const { agent, children } = node;
  const health = getHealthStatus(agent);
  const healthSummary = getHealthSummary(agent, health, t);
  const stateBadgeClass = getStateBadgeClass(agent.state);
  const stateNodeClass = getStateCardClass("org-chart-node-card", agent.state);
  const subtreeLeafCount = getOrgChartLeafCount(node);
  const nodeStyle = { "--org-chart-subtree-leaves": String(subtreeLeafCount) } as CSSProperties;

  return (
    <div className={`org-chart-node${children.length > 0 ? " org-chart-node--has-children" : ""}`} style={nodeStyle}>
      <div
        ref={(element) => registerNodeElement(agent.id, element)}
        data-agent-id={agent.id}
        className={`org-chart-node-card ${stateNodeClass}${selectedAgentId === agent.id ? " agent-card--selected" : ""}`}
        onClick={() => onSelect(agent.id)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            if (e.key === " ") {
              e.preventDefault();
            }
            onSelect(agent.id);
          }
        }}
      >
        <div className="org-chart-node__header">
          <span className="org-chart-node__icon"><AgentAvatar agent={agent} size={20} /></span>
          <span className="org-chart-node__name">{agent.name}</span>
        </div>
        <div className="org-chart-node__meta">
          <span className={`org-chart-node__badge ${stateBadgeClass}`}>{agent.state}</span>
          <span className="org-chart-node__health" style={{ color: health.color }} title={healthSummary.title}>
            {health.icon}
            {healthSummary.label && <span className="text-secondary">{healthSummary.label}</span>}
          </span>
        </div>
      </div>
      {children.length > 0 && (
        <div className="org-chart-children" role="group" aria-label={t("agents.orgChartEmployees", "{{name}} employees", { name: agent.name })}>
          {children.map((child) => {
            linksRef.current.push({ parentId: agent.id, childId: child.agent.id });
            return (
              <OrgChartNode
                key={child.agent.id}
                node={child}
                onSelect={onSelect}
                getHealthStatus={getHealthStatus}
                selectedAgentId={selectedAgentId}
                registerNodeElement={registerNodeElement}
                linksRef={linksRef}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

function OrgChartConnectors({
  links,
  nodeElements,
  canvasRef,
  viewportRef,
  layoutMode,
  transform,
}: {
  links: OrgChartLink[];
  nodeElements: Map<string, HTMLDivElement>;
  canvasRef: RefObject<HTMLDivElement | null>;
  viewportRef: RefObject<HTMLDivElement | null>;
  layoutMode: OrgChartLayoutMode;
  transform: OrgChartTransform;
}) {
  const [paths, setPaths] = useState<string[]>([]);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const viewport = viewportRef.current;
    if (!canvas || !viewport || links.length === 0) {
      setPaths([]);
      return;
    }

    const recompute = () => {
      const canvasRect = canvas.getBoundingClientRect();
      const next = links.flatMap(({ parentId, childId }) => {
        const parent = nodeElements.get(parentId);
        const child = nodeElements.get(childId);
        if (!parent || !child) return [];
        const parentRect = parent.getBoundingClientRect();
        const childRect = child.getBoundingClientRect();
        const pLeft = (parentRect.left - canvasRect.left) / transform.scale;
        const pTop = (parentRect.top - canvasRect.top) / transform.scale;
        const cLeft = (childRect.left - canvasRect.left) / transform.scale;
        const cTop = (childRect.top - canvasRect.top) / transform.scale;

        if (layoutMode === "vertical") {
          const startX = pLeft;
          const startY = pTop + parentRect.height / transform.scale / 2;
          const endX = cLeft;
          const endY = cTop + childRect.height / transform.scale / 2;
          const midX = startX - (startX - endX) / 2;
          return [`M ${startX} ${startY} L ${midX} ${startY} L ${midX} ${endY} L ${endX} ${endY}`];
        }

        const startX = pLeft + parentRect.width / transform.scale / 2;
        const startY = pTop + parentRect.height / transform.scale;
        const endX = cLeft + childRect.width / transform.scale / 2;
        const endY = cTop;
        const midY = startY + (endY - startY) / 2;
        return [`M ${startX} ${startY} L ${startX} ${midY} L ${endX} ${midY} L ${endX} ${endY}`];
      });
      setPaths(next);
    };

    recompute();
    const resizeObserver = new ResizeObserver(recompute);
    resizeObserver.observe(canvas);
    resizeObserver.observe(viewport);
    nodeElements.forEach((node) => resizeObserver.observe(node));
    return () => resizeObserver.disconnect();
  }, [canvasRef, layoutMode, links, nodeElements, transform.scale, viewportRef]);

  return (
    <svg className="agent-org-chart-connectors" aria-hidden="true">
      {paths.map((d, index) => (
        <path key={`${index}-${d}`} d={d} />
      ))}
    </svg>
  );
}

export function AgentsView({ addToast, projectId, onOpenTaskLogs, agentOnboardingEnabled = false }: AgentsViewProps) {
  const { t } = useTranslation("app");
  const agentRoles = getAgentRoles(t);
  const [showSystemAgents, setShowSystemAgents] = useState(false);
  const viewportMode = useViewportMode();
  const isMobileViewport = viewportMode === "mobile";
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => readAgentsSidebarWidth(projectId));
  const [filterState, setFilterState] = useState<AgentState | "all">("all");
  const { agents, stats, isLoading, loadAgents, refreshAgents } = useAgents(projectId, {
    filterState,
    showSystemAgents,
  });
  const [isCreating, setIsCreating] = useState(false);
  const [onboardingDraft, setOnboardingDraft] = useState<AgentOnboardingSummary | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [selectedOrgChartAgentId, setSelectedOrgChartAgentId] = useState<string | null>(null);
  const isMobileDetailOpen = isMobileViewport && !!selectedAgentId;
  const [selectedAgentInitialTab, setSelectedAgentInitialTab] = useState<"dashboard" | "runs">("dashboard");
  const [selectedAgentInitialRunId, setSelectedAgentInitialRunId] = useState<string | null>(null);
  const [selectedAgentPreferActiveRun, setSelectedAgentPreferActiveRun] = useState(false);

  // FUX-039: real viewport gating for RuntimeFallbackBadge on the board and
  // list card surfaces. Both surfaces render inline inside .map() calls, so
  // a naive per-item useState/useEffect would violate the rules of hooks.
  // Instead, a single shared IntersectionObserver instance observes every
  // registered card element, keyed distinctly per surface ("board:{id}" vs
  // "list:{id}") so the two surfaces never share visibility state. The
  // registration function below MUST return a cached, stable callback per
  // key (never a fresh closure per render) — a fresh closure would look like
  // an unmount+remount to React on every render, and in environments without
  // IntersectionObserver support that reproduces a real infinite re-render
  // loop (including jsdom test environments).
  const intersectionObserverSupported = typeof IntersectionObserver !== "undefined";
  const agentCardObserverRef = useRef<IntersectionObserver | null>(null);
  const agentCardElementsRef = useRef<Map<string, Element>>(new Map());
  const agentCardRefCallbacksRef = useRef<Map<string, (el: HTMLDivElement | null) => void>>(new Map());
  const [visibleAgentCardKeys, setVisibleAgentCardKeys] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!intersectionObserverSupported) return;
    const observer = new IntersectionObserver(
      (entries) => {
        setVisibleAgentCardKeys((prev) => {
          let changed = false;
          const next = new Set(prev);
          for (const entry of entries) {
            const key = (entry.target as HTMLElement).dataset.viewportKey;
            if (!key) continue;
            if (entry.isIntersecting) {
              if (!next.has(key)) {
                next.add(key);
                changed = true;
              }
            } else if (next.has(key)) {
              next.delete(key);
              changed = true;
            }
          }
          return changed ? next : prev;
        });
      },
      { rootMargin: "200px" },
    );
    agentCardObserverRef.current = observer;
    // Ref callbacks run during the commit phase, BEFORE this effect. Any card
    // element registered on the initial mount (or during a render that
    // happened before this observer existed) is already recorded in
    // agentCardElementsRef but was never actually passed to .observe(), since
    // the observer didn't exist yet at ref-callback time. Catch those up here.
    for (const el of agentCardElementsRef.current.values()) {
      observer.observe(el);
    }
    return () => {
      observer.disconnect();
      agentCardObserverRef.current = null;
    };
  }, [intersectionObserverSupported]);

  const registerAgentCardRef = useCallback((key: string) => {
    const cached = agentCardRefCallbacksRef.current.get(key);
    if (cached) return cached;
    const callback = (el: HTMLDivElement | null) => {
      const prevElement = agentCardElementsRef.current.get(key);
      const observer = agentCardObserverRef.current;
      if (prevElement && observer) {
        observer.unobserve(prevElement);
      }
      if (el) {
        el.dataset.viewportKey = key;
        agentCardElementsRef.current.set(key, el);
        observer?.observe(el);
      } else {
        agentCardElementsRef.current.delete(key);
        setVisibleAgentCardKeys((prev) => {
          if (!prev.has(key)) return prev;
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
      }
    };
    agentCardRefCallbacksRef.current.set(key, callback);
    return callback;
  }, []);

  const isAgentCardKeyInViewport = useCallback(
    (key: string) => (intersectionObserverSupported ? visibleAgentCardKeys.has(key) : true),
    [intersectionObserverSupported, visibleAgentCardKeys],
  );
  const [agentView, setAgentView] = useState<"list" | "board" | "org">(() => {
    if (typeof window === "undefined") return "list";
    const saved = getScopedItem("fn-agent-view", projectId);
    return (saved === "list" || saved === "board" || saved === "org") ? saved : "list";
  });
  const [orgChartLayoutPreference, setOrgChartLayoutPreference] = useState<OrgChartLayoutPreference>(() => {
    if (typeof window === "undefined") return "auto";
    const saved = getScopedItem(ORG_CHART_LAYOUT_STORAGE_KEY, projectId);
    return isOrgChartLayoutPreference(saved) ? saved : "auto";
  });
  const [orgTree, setOrgTree] = useState<OrgTreeNode[]>([]);
  const [isOrgTreeLoading, setIsOrgTreeLoading] = useState(false);
  const [orgChartViewportWidth, setOrgChartViewportWidth] = useState(0);
  const [isControlsPanelOpen, setIsControlsPanelOpen] = useState(false);
  const [isOverviewOpen, setIsOverviewOpen] = useState(false);
  const [isBulkActionRunning, setIsBulkActionRunning] = useState(false);
  const [isBulkEligibilityLoading, setIsBulkEligibilityLoading] = useState(false);
  const [bulkPauseEligibleCount, setBulkPauseEligibleCount] = useState(0);
  const [bulkResumeEligibleCount, setBulkResumeEligibleCount] = useState(0);
  const [orgChartTransform, setOrgChartTransform] = useState<OrgChartTransform>({ scale: 1, x: 0, y: 0 });
  const [isOrgChartPanning, setIsOrgChartPanning] = useState(false);
  const controlsPanelRef = useRef<HTMLDivElement>(null);
  const orgChartViewportRef = useRef<HTMLDivElement>(null);
  const orgChartCanvasRef = useRef<HTMLDivElement>(null);
  const orgChartNodeRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const orgChartLinksRef = useRef<OrgChartLink[]>([]);
  const activePointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const panStartRef = useRef<{ x: number; y: number; pointerId: number } | null>(null);
  const pinchStartRef = useRef<{ distance: number; scale: number; centerX: number; centerY: number } | null>(null);
  const orgChartFitDoneRef = useRef(false);
  const { confirm } = useConfirm();
  const controlsTriggerRef = useRef<HTMLButtonElement>(null);
  const controlsPanelId = useId();

  useEffect(() => {
    setSidebarWidth(readAgentsSidebarWidth(projectId));
  }, [projectId]);

  useEffect(() => {
    const saved = getScopedItem("fn-agent-view", projectId);
    if (saved === "list" || saved === "board" || saved === "org") {
      setAgentView(saved);
      return;
    }
    setAgentView("list");
  }, [projectId]);

  // Persist view preference to localStorage
  useEffect(() => {
    setScopedItem("fn-agent-view", agentView, projectId);
  }, [agentView, projectId]);

  useEffect(() => {
    const saved = getScopedItem(ORG_CHART_LAYOUT_STORAGE_KEY, projectId);
    setOrgChartLayoutPreference(isOrgChartLayoutPreference(saved) ? saved : "auto");
  }, [projectId]);

  useEffect(() => {
    setScopedItem(ORG_CHART_LAYOUT_STORAGE_KEY, orgChartLayoutPreference, projectId);
  }, [orgChartLayoutPreference, projectId]);

  const persistSidebarWidth = useCallback((width: number) => {
    try {
      setScopedItem(AGENTS_SIDEBAR_WIDTH_STORAGE_KEY, String(width), projectId);
    } catch {
      // Ignore storage errors.
    }
  }, [projectId]);

  const handleSidebarResizeStart = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (isMobileViewport) return;
    event.preventDefault();
    event.stopPropagation();
    const handle = event.currentTarget;
    if (typeof handle.setPointerCapture === "function") {
      handle.setPointerCapture(event.pointerId);
    }
    const startX = event.clientX;
    const startWidth = sidebarWidth;
    let latestWidth = startWidth;
    document.body.style.userSelect = "none";

    const onPointerMove = (moveEvent: PointerEvent) => {
      const deltaX = moveEvent.clientX - startX;
      const nextWidth = clampAgentsSidebarWidth(startWidth + deltaX);
      latestWidth = nextWidth;
      setSidebarWidth(nextWidth);
    };

    const onPointerUp = (upEvent: PointerEvent) => {
      if (typeof handle.releasePointerCapture === "function") {
        handle.releasePointerCapture(upEvent.pointerId);
      }
      document.body.style.userSelect = "";
      document.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("pointerup", onPointerUp);
      persistSidebarWidth(latestWidth);
    };

    document.addEventListener("pointermove", onPointerMove);
    document.addEventListener("pointerup", onPointerUp);
  }, [isMobileViewport, persistSidebarWidth, sidebarWidth]);

  const handleSidebarResizeKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (isMobileViewport) return;
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const step = event.shiftKey ? 50 : 10;
    const delta = event.key === "ArrowLeft" ? -step : step;
    const nextWidth = clampAgentsSidebarWidth(sidebarWidth + delta);
    setSidebarWidth(nextWidth);
    persistSidebarWidth(nextWidth);
  }, [isMobileViewport, persistSidebarWidth, sidebarWidth]);

  const [editingRoleForAgent, setEditingRoleForAgent] = useState<string | null>(null);
  const roleSelectRef = useRef<HTMLSelectElement>(null);
  const [updatingHeartbeatAgentId, setUpdatingHeartbeatAgentId] = useState<string | null>(null);
  /** Agent ID currently showing custom heartbeat input */
  const [customHeartbeatAgentId, setCustomHeartbeatAgentId] = useState<string | null>(null);
  /** Custom minutes input value for each agent */
  const [customHeartbeatMinutes, setCustomHeartbeatMinutes] = useState<Record<string, string>>({});
  /** Global heartbeat multiplier loaded from project settings */
  const [heartbeatMultiplier, setHeartbeatMultiplier] = useState<number>(1);
  /** Whether the heartbeat multiplier is currently being saved */
  const [isSavingMultiplier, setIsSavingMultiplier] = useState(false);
  /** Agent IDs with an in-flight state transition (for optimistic update guard) */
  const [transitioningAgentIds, setTransitioningAgentIds] = useState<Set<string>>(new Set());
  /** Optimistic state overrides keyed by agent ID while pause/resume/start API call is in-flight */
  const [optimisticStateOverrides, setOptimisticStateOverrides] = useState<Map<string, AgentState>>(new Map());
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // Load heartbeat multiplier from project settings on mount
  useEffect(() => {
    fetchSettings(projectId)
      .then((settings) => {
        if (!isMountedRef.current) return;
        setHeartbeatMultiplier(settings.heartbeatMultiplier ?? 1);
      })
      .catch(() => {
        // Use default on error
      });
  }, [projectId]);

  /** Handle saving heartbeat multiplier to project settings */
  const handleHeartbeatMultiplierChange = useCallback(async (multiplier: number) => {
    const clampedValue = Number.isFinite(multiplier) && multiplier > 0 ? multiplier : 1;
    setHeartbeatMultiplier(clampedValue);
    setIsSavingMultiplier(true);
    try {
      await updateSettings({ heartbeatMultiplier: clampedValue }, projectId);
      addToast(t("agents.heartbeatSpeedSet", "Heartbeat speed set to ×{{value}}", { value: clampedValue.toFixed(1) }), "success");
    } catch (err) {
      addToast(t("agents.heartbeatSpeedSaveFailed", "Failed to save heartbeat multiplier: {{error}}", { error: getErrorMessage(err) }), "error");
    } finally {
      if (isMountedRef.current) {
        setIsSavingMultiplier(false);
      }
    }
  }, [projectId, addToast]);

  const optimisticAgents = useMemo(() => {
    if (optimisticStateOverrides.size === 0) {
      return agents;
    }

    return agents.map((agent) => {
      const optimisticState = optimisticStateOverrides.get(agent.id);
      return optimisticState ? { ...agent, state: optimisticState } : agent;
    });
  }, [agents, optimisticStateOverrides]);


  // Filter agents for display. "All States" means all non-ephemeral agents,
  // including paused/error agents and heartbeat-disabled agents that still carry configuration.
  // When "Show system agents" is enabled, include ephemeral/internal agents.
  const displayAgents = useMemo(() => {
    return optimisticAgents.filter((agent) => showSystemAgents || !isEphemeralAgent(agent));
  }, [optimisticAgents, showSystemAgents]);

  const displayActiveAgents = useMemo(() => {
    return optimisticAgents.filter((agent) => {
      if (agent.state !== "active" && agent.state !== "running") {
        return false;
      }
      return showSystemAgents || !isEphemeralAgent(agent);
    });
  }, [optimisticAgents, showSystemAgents]);

  // Filter org tree to exclude ephemeral agents in default view.
  const displayOrgTree = useMemo(() => {
    if (showSystemAgents) {
      return orgTree;
    }

    // Recursively filter out ephemeral agents from the org tree.
    const filterNode = (node: OrgTreeNode): OrgTreeNode | null => {
      if (isEphemeralAgent(node.agent)) return null;
      return {
        ...node,
        children: node.children
          .map(filterNode)
          .filter((n): n is OrgTreeNode => n !== null),
      };
    };
    return orgTree
      .map(filterNode)
      .filter((n): n is OrgTreeNode => n !== null);
  }, [orgTree, showSystemAgents]);

  useEffect(() => {
    if (agentView !== "org") return;

    const viewport = orgChartViewportRef.current;
    if (!viewport) return;

    const updateWidth = () => {
      setOrgChartViewportWidth(viewport.clientWidth);
    };

    updateWidth();
    const resizeObserver = typeof ResizeObserver !== "undefined" ? new ResizeObserver(updateWidth) : null;
    resizeObserver?.observe(viewport);
    window.addEventListener("resize", updateWidth);

    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", updateWidth);
    };
  }, [agentView, displayOrgTree.length]);

  useEffect(() => {
    if (agentView !== "org") return;

    let cancelled = false;
    setIsOrgTreeLoading(true);
    fetchOrgTree(projectId, { includeEphemeral: showSystemAgents })
      .then((data) => {
        if (!cancelled) {
          setOrgTree(data);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          addToast(t("agents.orgChartLoadFailed", "Failed to load org chart: {{error}}", { error: getErrorMessage(err) }), "error");
          setOrgTree([]);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsOrgTreeLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [agentView, projectId, showSystemAgents, addToast]);

  // Poll for agent updates to keep health statuses fresh (every 30 seconds)
  // This ensures health badges stay current while the view is open.
  // SSE refreshes are handled by useAgents.
  useEffect(() => {
    const pollInterval = setInterval(() => {
      void loadAgents();
    }, 30_000);

    return () => {
      clearInterval(pollInterval);
    };
  }, [loadAgents]);

  useEffect(() => {
    if (!isControlsPanelOpen) return;

    let cancelled = false;
    setIsBulkEligibilityLoading(true);
    void fetchAgents(undefined, projectId)
      .then((projectAgents) => {
        if (cancelled) return;
        const nonEphemeralAgents = projectAgents.filter((projectAgent) => !isEphemeralAgent(projectAgent));
        setBulkPauseEligibleCount(
          nonEphemeralAgents.filter((projectAgent) => projectAgent.state === "active" || projectAgent.state === "running").length,
        );
        setBulkResumeEligibleCount(nonEphemeralAgents.filter((projectAgent) => projectAgent.state === "paused").length);
      })
      .catch((err) => {
        if (cancelled) return;
        setBulkPauseEligibleCount(0);
        setBulkResumeEligibleCount(0);
        addToast(t("agents.bulkActionsLoadFailed", "Failed to load bulk agent actions: {{error}}", { error: getErrorMessage(err) }), "error");
      })
      .finally(() => {
        if (!cancelled) {
          setIsBulkEligibilityLoading(false);
        }
      });

    const handlePointerDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (controlsPanelRef.current?.contains(target)) return;
      if (controlsTriggerRef.current?.contains(target)) return;
      setIsControlsPanelOpen(false);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setIsControlsPanelOpen(false);
      controlsTriggerRef.current?.focus();
    };

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("touchstart", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      cancelled = true;
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("touchstart", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [addToast, isControlsPanelOpen, projectId]);

  const handleBulkStateChange = async (targetState: "paused" | "active") => {
    if (isBulkActionRunning) return;
    setIsBulkActionRunning(true);

    try {
      const projectAgents = await fetchAgents(undefined, projectId);
      const nonEphemeralAgents = projectAgents.filter((projectAgent) => !isEphemeralAgent(projectAgent));
      const eligibleAgents = nonEphemeralAgents.filter((projectAgent) => (
        targetState === "paused"
          ? projectAgent.state === "active" || projectAgent.state === "running"
          : projectAgent.state === "paused"
      ));
      const skippedCount = nonEphemeralAgents.length - eligibleAgents.length;

      if (eligibleAgents.length === 0) {
        addToast(
          targetState === "paused"
            ? t("agents.noAgentsToPause", "No agents eligible to pause")
            : t("agents.noAgentsToResume", "No agents eligible to resume"),
          "error",
        );
        return;
      }

      const confirmed = await confirm({
        title: targetState === "paused" ? t("agents.pauseAllTitle", "Pause All Agents") : t("agents.resumeAllTitle", "Resume All Agents"),
        message: targetState === "paused"
          ? t("agents.pauseAllConfirm", { count: eligibleAgents.length, defaultValue_one: "Pause {{count}} agent in this project?", defaultValue_other: "Pause {{count}} agents in this project?" })
          : t("agents.resumeAllConfirm", { count: eligibleAgents.length, defaultValue_one: "Resume {{count}} agent in this project?", defaultValue_other: "Resume {{count}} agents in this project?" }),
        danger: targetState === "paused",
      });
      if (!confirmed) return;

      const results = await Promise.allSettled(
        eligibleAgents.map((projectAgent) => updateAgentState(projectAgent.id, targetState, projectId)),
      );
      const failedResults = results
        .map((result, index) => ({ result, agent: eligibleAgents[index] }))
        .filter((entry): entry is { result: PromiseRejectedResult; agent: Agent } => entry.result.status === "rejected");
      const successCount = results.length - failedResults.length;
      const failureCount = failedResults.length;
      const baseSummary = targetState === "paused"
        ? t("agents.pausedSummary", { count: successCount, skipped: skippedCount, defaultValue_one: "Paused {{count}} agent; skipped {{skipped}}", defaultValue_other: "Paused {{count}} agents; skipped {{skipped}}" })
        : t("agents.resumedSummary", { count: successCount, skipped: skippedCount, defaultValue_one: "Resumed {{count}} agent; skipped {{skipped}}", defaultValue_other: "Resumed {{count}} agents; skipped {{skipped}}" });

      if (failureCount > 0) {
        const failureSummary = failedResults
          .slice(0, 3)
          .map(({ agent, result }) => `${agent.name || agent.id}: ${getErrorMessage(result.reason)}`)
          .join("; ");
        addToast(`${baseSummary}; failed ${failureCount}${failureSummary ? ` (${failureSummary})` : ""}`, "error");
      } else {
        addToast(baseSummary, "success");
      }

      await loadAgents();
    } catch (err) {
      addToast(
        targetState === "paused"
          ? t("agents.pauseAgentsFailed", "Failed to pause agents: {{error}}", { error: getErrorMessage(err) })
          : t("agents.resumeAgentsFailed", "Failed to resume agents: {{error}}", { error: getErrorMessage(err) }),
        "error",
      );
    } finally {
      setIsBulkActionRunning(false);
    }
  };

  const handleStateChange = async (agentId: string, newState: AgentState) => {
    if (transitioningAgentIds.has(agentId)) return;

    setTransitioningAgentIds((prev) => new Set(prev).add(agentId));
    setOptimisticStateOverrides((prev) => {
      const next = new Map(prev);
      next.set(agentId, newState);
      return next;
    });

    try {
      await updateAgentState(agentId, newState, projectId);
      addToast(t("agents.stateUpdated", "Agent state updated to {{state}}", { state: newState }), "success");
      await loadAgents();
      setOptimisticStateOverrides((prev) => {
        const next = new Map(prev);
        next.delete(agentId);
        return next;
      });
    } catch (err) {
      setOptimisticStateOverrides((prev) => {
        const next = new Map(prev);
        next.delete(agentId);
        return next;
      });
      addToast(t("agents.stateUpdateFailed", "Failed to update state: {{error}}", { error: getErrorMessage(err) }), "error");
    } finally {
      setTransitioningAgentIds((prev) => {
        const next = new Set(prev);
        next.delete(agentId);
        return next;
      });
    }
  };

  const handleDelete = async (agentId: string, agentName: string) => {
    const shouldDelete = await confirm({
      title: t("agents.deleteTitle", "Delete Agent"),
      message: t("agents.deleteConfirm", "Delete agent \"{{name}}\"? This cannot be undone.", { name: agentName }),
      danger: true,
    });
    if (!shouldDelete) return;
    try {
      await deleteAgent(agentId, projectId);
      addToast(t("agents.deleted", "Agent \"{{name}}\" deleted", { name: agentName }), "success");
      await loadAgents();
    } catch (err) {
      addToast(t("agents.deleteFailed", "Failed to delete agent: {{error}}", { error: getErrorMessage(err) }), "error");
    }
  };

  const handleRoleChange = async (agentId: string, newRole: AgentCapability) => {
    const agent = agents.find(a => a.id === agentId);
    if (!agent) return;

    // If same role, just cancel editing without API call
    if (agent.role === newRole) {
      setEditingRoleForAgent(null);
      return;
    }

    try {
      await updateAgent(agentId, { role: newRole }, projectId);
      addToast(t("agents.roleUpdated", "Agent role updated to {{role}}", { role: agentRoles.find(r => r.value === newRole)?.label ?? newRole }), "success");
      setEditingRoleForAgent(null);
      void loadAgents();
    } catch (err) {
      addToast(t("agents.roleUpdateFailed", "Failed to update role: {{error}}", { error: getErrorMessage(err) }), "error");
    }
  };

  const handleRoleKeyDown = (e: React.KeyboardEvent, _agentId: string) => {
    if (e.key === "Escape") {
      setEditingRoleForAgent(null);
    }
  };

  const handleHeartbeatIntervalChange = async (agent: Agent, newIntervalMs: number) => {
    // Clear custom input state when selecting a preset
    if (customHeartbeatAgentId === agent.id) {
      setCustomHeartbeatAgentId(null);
      setCustomHeartbeatMinutes((prev) => {
        const next = { ...prev };
        delete next[agent.id];
        return next;
      });
    }

    setUpdatingHeartbeatAgentId(agent.id);
    try {
      await updateAgent(
        agent.id,
        {
          runtimeConfig: {
            ...(agent.runtimeConfig ?? {}),
            heartbeatIntervalMs: newIntervalMs,
          },
        },
        projectId,
      );
      addToast(t("agents.heartbeatIntervalUpdated", "Heartbeat interval updated to {{interval}} for {{name}}", { interval: formatHeartbeatInterval(newIntervalMs), name: agent.name }), "success");
      void loadAgents();
    } catch (err) {
      addToast(t("agents.heartbeatIntervalUpdateFailed", "Failed to update heartbeat interval: {{error}}", { error: getErrorMessage(err) }), "error");
    } finally {
      setUpdatingHeartbeatAgentId(null);
    }
  };

  /**
   * Handle saving custom heartbeat interval from typed minutes input.
   * Validation behavior:
   * - Empty value: do not save; show validation toast
   * - Non-numeric value: do not save; show validation toast
   * - Value <= 0: do not save; show validation toast
   * - Value 1-4: save as 5 minutes (300000 ms) and show clamp-info toast
   * - Value >= 5: save exact minute value converted to ms
   */
  const handleCustomHeartbeatSave = async (agent: Agent) => {
    const inputValue = customHeartbeatMinutes[agent.id] ?? "";

    // Validate: empty value
    if (inputValue.trim() === "") {
      addToast(t("agents.heartbeatEnterMinutes", "Please enter a heartbeat interval in minutes"), "error");
      return;
    }

    // Validate: non-numeric value
    const minutes = Number(inputValue);
    if (isNaN(minutes)) {
      addToast(t("agents.heartbeatMustBeNumber", "Heartbeat interval must be a valid number"), "error");
      return;
    }

    // Validate: zero or negative
    if (minutes <= 0) {
      addToast(t("agents.heartbeatMustBePositive", "Heartbeat interval must be greater than 0"), "error");
      return;
    }

    // Handle values 1-4: clamp to 5 minutes
    if (minutes >= 1 && minutes < 5) {
      setUpdatingHeartbeatAgentId(agent.id);
      try {
        await updateAgent(
          agent.id,
          {
            runtimeConfig: {
              ...(agent.runtimeConfig ?? {}),
              heartbeatIntervalMs: MIN_HEARTBEAT_INTERVAL_MS,
            },
          },
          projectId,
        );
        addToast(t("agents.heartbeatClampedToMin", { count: minutes, defaultValue_one: "Heartbeat interval set to 5 minutes (minimum). {{count}} minute was below the 5-minute minimum.", defaultValue_other: "Heartbeat interval set to 5 minutes (minimum). {{count}} minutes was below the 5-minute minimum." }), "success");
        setCustomHeartbeatAgentId(null);
        setCustomHeartbeatMinutes((prev) => {
          const next = { ...prev };
          delete next[agent.id];
          return next;
        });
        void loadAgents();
      } catch (err) {
        addToast(t("agents.heartbeatIntervalUpdateFailed", "Failed to update heartbeat interval: {{error}}", { error: getErrorMessage(err) }), "error");
      } finally {
        setUpdatingHeartbeatAgentId(null);
      }
      return;
    }

    // Handle values >= 5: save exact minute value
    const intervalMs = Math.round(minutes * 60_000);
    setUpdatingHeartbeatAgentId(agent.id);
    try {
      await updateAgent(
        agent.id,
        {
          runtimeConfig: {
            ...(agent.runtimeConfig ?? {}),
            heartbeatIntervalMs: intervalMs,
          },
        },
        projectId,
      );
      addToast(t("agents.heartbeatIntervalUpdated", "Heartbeat interval updated to {{interval}} for {{name}}", { interval: formatHeartbeatInterval(intervalMs), name: agent.name }), "success");
      setCustomHeartbeatAgentId(null);
      setCustomHeartbeatMinutes((prev) => {
        const next = { ...prev };
        delete next[agent.id];
        return next;
      });
      void loadAgents();
    } catch (err) {
      addToast(t("agents.heartbeatIntervalUpdateFailed", "Failed to update heartbeat interval: {{error}}", { error: getErrorMessage(err) }), "error");
    } finally {
      setUpdatingHeartbeatAgentId(null);
    }
  };

  /** Handle selecting custom option from dropdown */
  const handleSelectCustomHeartbeat = (agent: Agent) => {
    const configuredIntervalMs = resolveHeartbeatIntervalMs(agent.runtimeConfig?.heartbeatIntervalMs);
    // Convert ms to minutes for the input field
    const currentMinutes = Math.round(configuredIntervalMs / 60_000);
    setCustomHeartbeatAgentId(agent.id);
    setCustomHeartbeatMinutes((prev) => ({
      ...prev,
      [agent.id]: String(currentMinutes),
    }));
  };

  const openAgentDetail = useCallback((agentId: string, options?: { initialTab?: "dashboard" | "runs"; initialRunId?: string | null; preferActiveRun?: boolean }) => {
    setSelectedAgentId(agentId);
    setSelectedAgentInitialTab(options?.initialTab ?? "dashboard");
    setSelectedAgentInitialRunId(options?.initialRunId ?? null);
    setSelectedAgentPreferActiveRun(options?.preferActiveRun ?? false);
  }, []);

  const handleCloseDetail = useCallback(() => {
    setSelectedAgentId(null);
    setSelectedAgentInitialTab("dashboard");
    setSelectedAgentInitialRunId(null);
    setSelectedAgentPreferActiveRun(false);
  }, []);

  const handleChildClick = useCallback((childId: string) => {
    openAgentDetail(childId);
  }, [openAgentDetail]);

  const handleOrgChartNodeSelect = useCallback((agentId: string) => {
    setSelectedOrgChartAgentId(agentId);
    openAgentDetail(agentId);
  }, [openAgentDetail]);

  const handleDetailMutationSuccess = useCallback(async ({ agentId, deleted }: { agentId: string; deleted?: boolean }) => {
    await refreshAgents();
    if (deleted && selectedAgentId === agentId) {
      handleCloseDetail();
    }
  }, [refreshAgents, selectedAgentId, handleCloseDetail]);

  const handleOverviewAgentSelect = useCallback((agentId: string) => {
    openAgentDetail(agentId);
    if (isMobileViewport) {
      setIsOverviewOpen(false);
    }
  }, [isMobileViewport, openAgentDetail]);

  const handleRunHeartbeat = async (agentId: string, agentName: string) => {
    // Optimistic state flip: the API call can take several seconds before the
    // backend transitions the agent to running, and the user clicking "Run
    // Now" reasonably expects the card to react immediately. We mirror the
    // pattern handleStateChange uses: stamp the override, await the API,
    // refetch on success, roll back on failure.
    setOptimisticStateOverrides((prev) => {
      const next = new Map(prev);
      next.set(agentId, "running");
      return next;
    });
    try {
      await startAgentRun(agentId, projectId, { source: "on_demand", triggerDetail: "Triggered from dashboard" });
      addToast(t("agents.heartbeatRunStarted", "Heartbeat run started for {{name}}", { name: agentName }), "success");
      await loadAgents();
      setOptimisticStateOverrides((prev) => {
        const next = new Map(prev);
        next.delete(agentId);
        return next;
      });
    } catch (err) {
      setOptimisticStateOverrides((prev) => {
        const next = new Map(prev);
        next.delete(agentId);
        return next;
      });
      addToast(t("agents.heartbeatRunFailed", "Failed to start heartbeat run: {{error}}", { error: getErrorMessage(err) }), "error");
    }
  };

  const clampScale = useCallback((scale: number) => Math.min(ORG_CHART_SCALE_MAX, Math.max(ORG_CHART_SCALE_MIN, scale)), []);

  const clampTransform = useCallback((next: OrgChartTransform): OrgChartTransform => {
    const viewport = orgChartViewportRef.current;
    const chart = orgChartCanvasRef.current?.querySelector(".agent-org-chart") as HTMLDivElement | null;
    if (!viewport || !chart) return { ...next, scale: clampScale(next.scale) };
    const scale = clampScale(next.scale);
    const contentWidth = chart.scrollWidth * scale;
    const contentHeight = chart.scrollHeight * scale;
    const viewportWidth = viewport.clientWidth;
    const viewportHeight = viewport.clientHeight;
    const minX = Math.min(ORG_CHART_OVERSCROLL, viewportWidth - contentWidth - ORG_CHART_OVERSCROLL);
    const maxX = ORG_CHART_OVERSCROLL;
    const minY = Math.min(ORG_CHART_OVERSCROLL, viewportHeight - contentHeight - ORG_CHART_OVERSCROLL);
    const maxY = ORG_CHART_OVERSCROLL;
    return {
      scale,
      x: Math.max(minX, Math.min(maxX, next.x)),
      y: Math.max(minY, Math.min(maxY, next.y)),
    };
  }, [clampScale]);

  const zoomAtPoint = useCallback((nextScale: number, clientX: number, clientY: number) => {
    const viewport = orgChartViewportRef.current;
    if (!viewport) return;
    setOrgChartTransform((current) => {
      const scale = clampScale(nextScale);
      const viewportRect = viewport.getBoundingClientRect();
      const offsetX = clientX - viewportRect.left;
      const offsetY = clientY - viewportRect.top;
      const worldX = (offsetX - current.x) / current.scale;
      const worldY = (offsetY - current.y) / current.scale;
      return clampTransform({
        scale,
        x: offsetX - worldX * scale,
        y: offsetY - worldY * scale,
      });
    });
  }, [clampScale, clampTransform]);

  const fitToViewport = useCallback(() => {
    const viewport = orgChartViewportRef.current;
    const chart = orgChartCanvasRef.current?.querySelector(".agent-org-chart") as HTMLDivElement | null;
    if (!viewport || !chart) return;
    const viewportWidth = viewport.clientWidth;
    const viewportHeight = viewport.clientHeight;
    const contentWidth = chart.scrollWidth;
    const contentHeight = chart.scrollHeight;
    if (contentWidth <= 0 || contentHeight <= 0) return;
    const scale = clampScale(Math.min(viewportWidth / contentWidth, viewportHeight / contentHeight, 1));
    const x = (viewportWidth - contentWidth * scale) / 2;
    const y = (viewportHeight - contentHeight * scale) / 2;
    setOrgChartTransform(clampTransform({ scale, x, y }));
  }, [clampScale, clampTransform]);

  const handleAgentViewChange = useCallback((nextView: "list" | "board" | "org") => {
    setAgentView(nextView);
    if (nextView !== "org") {
      setOrgChartTransform({ scale: 1, x: 0, y: 0 });
    }
    if (isMobileViewport && selectedAgentId) {
      handleCloseDetail();
    }
  }, [handleCloseDetail, isMobileViewport, selectedAgentId]);

  const getRoleLabel = (role: AgentCapability) => agentRoles.find(r => r.value === role)?.label ?? role;
  const orgChartLayoutMode: OrgChartLayoutMode = useMemo(() => resolveOrgChartLayoutMode({
    tree: displayOrgTree,
    availableWidth: orgChartViewportWidth,
    preference: orgChartLayoutPreference,
  }), [displayOrgTree, orgChartLayoutPreference, orgChartViewportWidth]);
  const handleOrgChartLayoutPreferenceChange = useCallback((preference: OrgChartLayoutPreference) => {
    setOrgChartLayoutPreference(preference);
    setOrgChartTransform({ scale: 1, x: 0, y: 0 });
  }, []);

  useEffect(() => {
    setOrgChartTransform({ scale: 1, x: 0, y: 0 });
    orgChartFitDoneRef.current = false;
  }, [projectId, orgChartLayoutMode]);

  useLayoutEffect(() => {
    if (agentView !== "org" || isOrgTreeLoading || displayOrgTree.length === 0 || orgChartFitDoneRef.current) return;
    fitToViewport();
    orgChartFitDoneRef.current = true;
  }, [agentView, displayOrgTree.length, fitToViewport, isOrgTreeLoading]);

  const registerOrgChartNodeElement = useCallback((id: string, element: HTMLDivElement | null) => {
    if (element) {
      orgChartNodeRefs.current.set(id, element);
    } else {
      orgChartNodeRefs.current.delete(id);
    }
  }, []);

  const renderOrgChartZoomControls = useCallback(() => (
    <>
      <button type="button" className="btn-icon touch-target" onClick={() => setOrgChartTransform((current) => clampTransform({ ...current, scale: current.scale * 0.9 }))} aria-label={t("agents.orgChartZoomOut", "Zoom out org chart")} title={t("agents.zoomOut", "Zoom out")}>
        <ZoomOut size={16} />
      </button>
      <span className="agent-org-chart-controls__zoom-label" aria-live="polite">{Math.round(orgChartTransform.scale * 100)}%</span>
      <button type="button" className="btn-icon touch-target" onClick={() => setOrgChartTransform((current) => clampTransform({ ...current, scale: current.scale * 1.1 }))} aria-label={t("agents.orgChartZoomIn", "Zoom in org chart")} title={t("agents.zoomIn", "Zoom in")}>
        <ZoomIn size={16} />
      </button>
      <button type="button" className="btn touch-target btn-sm agent-org-chart-controls__fit-btn" onClick={fitToViewport} aria-label={t("agents.orgChartFit", "Fit org chart")} title={t("agents.orgChartFit", "Fit org chart")}>
        <Minimize2 size={16} />
        {t("agents.fit", "Fit")}
      </button>
      <button type="button" className="btn touch-target btn-sm" onClick={() => setOrgChartTransform((current) => clampTransform({ ...current, x: 0, y: 0 }))} aria-label={t("agents.orgChartCenter", "Center org chart")} title={t("agents.orgChartCenter", "Center org chart")}>
        <Move size={16} />
        {t("agents.center", "Center")}
      </button>
    </>
  ), [clampTransform, fitToViewport, orgChartTransform.scale]);

  const handleOrgChartWheel = useCallback((event: ReactWheelEvent<HTMLDivElement>) => {
    if (!(event.ctrlKey || event.metaKey)) return;
    event.preventDefault();
    const factor = event.deltaY > 0 ? 0.9 : 1.1;
    zoomAtPoint(orgChartTransform.scale * factor, event.clientX, event.clientY);
  }, [orgChartTransform.scale, zoomAtPoint]);

  const handleOrgChartPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest(".org-chart-node-card")) return;
    const viewport = event.currentTarget;
    viewport.setPointerCapture?.(event.pointerId);
    activePointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (activePointersRef.current.size === 1) {
      panStartRef.current = { x: event.clientX - orgChartTransform.x, y: event.clientY - orgChartTransform.y, pointerId: event.pointerId };
      setIsOrgChartPanning(true);
      return;
    }
    if (activePointersRef.current.size === 2) {
      const points = Array.from(activePointersRef.current.values());
      const dx = points[0].x - points[1].x;
      const dy = points[0].y - points[1].y;
      pinchStartRef.current = {
        distance: Math.hypot(dx, dy),
        scale: orgChartTransform.scale,
        centerX: (points[0].x + points[1].x) / 2,
        centerY: (points[0].y + points[1].y) / 2,
      };
      panStartRef.current = null;
    }
  }, [orgChartTransform.scale, orgChartTransform.x, orgChartTransform.y]);

  const handleOrgChartPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!activePointersRef.current.has(event.pointerId)) return;
    activePointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (activePointersRef.current.size >= 2) {
      const points = Array.from(activePointersRef.current.values());
      const start = pinchStartRef.current;
      if (!start) return;
      const dx = points[0].x - points[1].x;
      const dy = points[0].y - points[1].y;
      const nextDistance = Math.hypot(dx, dy);
      const nextScale = start.scale * (nextDistance / start.distance);
      zoomAtPoint(nextScale, start.centerX, start.centerY);
      return;
    }
    if (!panStartRef.current || panStartRef.current.pointerId !== event.pointerId) return;
    setOrgChartTransform((current) => clampTransform({ ...current, x: event.clientX - panStartRef.current!.x, y: event.clientY - panStartRef.current!.y }));
  }, [clampTransform, zoomAtPoint]);

  const handleOrgChartPointerEnd = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    activePointersRef.current.delete(event.pointerId);
    if (activePointersRef.current.size < 2) {
      pinchStartRef.current = null;
    }
    if (activePointersRef.current.size === 0) {
      panStartRef.current = null;
      setIsOrgChartPanning(false);
    }
  }, []);

  const handleOrgChartKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowLeft") setOrgChartTransform((current) => clampTransform({ ...current, x: current.x + ORG_CHART_KEYBOARD_PAN_STEP }));
    else if (event.key === "ArrowRight") setOrgChartTransform((current) => clampTransform({ ...current, x: current.x - ORG_CHART_KEYBOARD_PAN_STEP }));
    else if (event.key === "ArrowUp") setOrgChartTransform((current) => clampTransform({ ...current, y: current.y + ORG_CHART_KEYBOARD_PAN_STEP }));
    else if (event.key === "ArrowDown") setOrgChartTransform((current) => clampTransform({ ...current, y: current.y - ORG_CHART_KEYBOARD_PAN_STEP }));
    else if (event.key === "+" || event.key === "=") setOrgChartTransform((current) => clampTransform({ ...current, scale: current.scale * 1.1 }));
    else if (event.key === "-") setOrgChartTransform((current) => clampTransform({ ...current, scale: current.scale * 0.9 }));
    else if (event.key === "0") fitToViewport();
    else if (event.key === "Home") setOrgChartTransform({ scale: 1, x: 0, y: 0 });
    else return;
    event.preventDefault();
  }, [clampTransform, fitToViewport]);

  const renderOrgChartLayoutToggle = useCallback(() => {
    const options: Array<{ value: OrgChartLayoutPreference; label: string; icon: ReactNode; ariaLabel: string }> = [
      { value: "horizontal", label: t("agents.layoutHorizontal", "Horizontal"), icon: <Network size={16} />, ariaLabel: t("agents.layoutHorizontalAria", "Horizontal layout") },
      { value: "vertical", label: t("agents.layoutVertical", "Vertical"), icon: <List size={16} />, ariaLabel: t("agents.layoutVerticalAria", "Vertical layout") },
      { value: "auto", label: t("agents.layoutAuto", "Auto"), icon: <RefreshCw size={16} />, ariaLabel: t("agents.layoutAutoAria", "Automatic layout") },
    ];

    return (
      <div className="agent-org-chart-layout-toggle" data-testid="agent-org-chart-layout-toggle">
        {options.map((option) => {
          const isActive = orgChartLayoutPreference === option.value;
          return (
            <button
              key={option.value}
              type="button"
              className={`btn-icon touch-target agent-org-chart-layout-toggle__button${isActive ? " btn-icon--active" : ""}`}
              onClick={() => handleOrgChartLayoutPreferenceChange(option.value)}
              aria-pressed={isActive}
              aria-label={option.ariaLabel}
              title={option.ariaLabel}
              data-layout-value={option.value}
            >
              {option.icon}
              <span className="agent-org-chart-layout-toggle__text">{option.label}</span>
            </button>
          );
        })}
      </div>
    );
  }, [handleOrgChartLayoutPreferenceChange, orgChartLayoutPreference]);

  /** Get skill badges from agent metadata */
  const getSkillBadges = (agent: Agent): string[] => {
    if (Array.isArray(agent.metadata?.skills)) {
      return agent.metadata.skills as string[];
    }
    return [];
  };

  // Use centralized health status utility for consistent labels across all views
  const getHealthStatus = (agent: Agent): AgentHealthStatus => {
    return getAgentHealthStatus(agent);
  };

  const isPauseAllDisabled = isBulkEligibilityLoading || isBulkActionRunning || bulkPauseEligibleCount === 0;
  const isResumeAllDisabled = isBulkEligibilityLoading || isBulkActionRunning || bulkResumeEligibleCount === 0;
  const showInitialAgentsLoading = isLoading && agents.length === 0;

  const handleOpenNewAgent = useCallback(() => {
    setIsCreating(true);
  }, []);

  return (
    <div className="agents-view">
      {/*
      FNXC:Navigation 2026-06-22-01:10:
      Agents adopts the shared ViewHeader (Command Center-modeled) title row for cross-view consistency. The deeply-integrated controls (view-toggle, controls popup, refresh, import, new-agent) keep working by passing the existing agents-view-controls cluster through the header actions prop. The agents-view-controls / agents-view-primary-actions class names are preserved so existing scoped CSS (incl. mobile rules covered by the CSS string-match test) still applies.

      FNXC:Agents 2026-06-23-02:00:
      The Agents header must read identically to the Missions header. Both use icon size 20 + a 1.125rem/600 title via ViewHeader / .mission-manager__title. To fully match, AgentsView.css scopes .agents-view .view-header to the Missions inline header chrome (--space-lg/--space-xl padding, border-bottom, surface background) and colors the leading icon --todo (the same token .mission-manager__header-icon uses), since the shared ViewHeader leaves the icon at --text.
      */}
      <ViewHeader
        icon={Bot}
        title={t("agents.title", "Agents")}
        actions={
        <div className="agents-view-controls">
          <div className="view-toggle">
            <button
              className={`view-toggle-btn${agentView === "list" ? " active" : ""}`}
              onClick={() => handleAgentViewChange("list")}
              title={t("agents.listView", "List view")}
              aria-label={t("agents.listView", "List view")}
              aria-pressed={agentView === "list"}
            >
              <List size={16} />
            </button>
            <button
              className={`view-toggle-btn${agentView === "board" ? " active" : ""}`}
              onClick={() => handleAgentViewChange("board")}
              title={t("agents.boardView", "Board view")}
              aria-label={t("agents.boardView", "Board view")}
              aria-pressed={agentView === "board"}
            >
              <Activity size={16} />
            </button>
            <button
              className={`view-toggle-btn${agentView === "org" ? " active" : ""}`}
              onClick={() => handleAgentViewChange("org")}
              title={t("agents.orgChartView", "Org Chart view")}
              aria-label={t("agents.orgChartView", "Org Chart view")}
              aria-pressed={agentView === "org"}
            >
              <Network size={16} />
            </button>
          </div>
          <div className="agents-view-primary-actions">
            <button
              ref={controlsTriggerRef}
              className={`btn-icon agent-controls-trigger${isControlsPanelOpen ? " agent-controls-trigger--active" : ""}`}
              onClick={() => setIsControlsPanelOpen((open) => !open)}
              title={t("agents.controls", "Controls")}
              aria-label={t("agents.controls", "Controls")}
              aria-haspopup="dialog"
              aria-expanded={isControlsPanelOpen}
              aria-controls={controlsPanelId}
            >
              <SlidersHorizontal size={16} />
            </button>
            <button
              className="btn-icon"
              onClick={() => void loadAgents()}
              title={t("agents.refresh", "Refresh")}
              aria-label={t("agents.refresh", "Refresh")}
            >
              <RefreshCw size={16} className={isLoading ? "spin" : undefined} />
            </button>
            {!isMobileViewport && (
              <>
                <button
                  className="btn btn-sm agent-import-trigger"
                  onClick={() => {
                    setIsImporting(true);
                    setIsControlsPanelOpen(false);
                  }}
                  aria-label={t("agents.import", "Import")}
                  title={t("agents.import", "Import")}
                >
                  <Upload size={16} />
                  {t("agents.import", "Import")}
                </button>
                <button
                  className="btn btn-task-create btn-sm"
                  onClick={() => {
                    handleOpenNewAgent();
                    setIsControlsPanelOpen(false);
                  }}
                  aria-label={t("agents.newAgent", "New Agent")}
                  title={t("agents.newAgent", "New Agent")}
                >
                  <Plus size={16} />
                  {t("agents.newAgent", "New Agent")}
                </button>
              </>
            )}
            {isControlsPanelOpen && (
              <div
                ref={controlsPanelRef}
                id={controlsPanelId}
                className="agent-controls-panel agent-controls-panel--scrollable"
                role="dialog"
                aria-label={t("agents.agentControls", "Agent controls")}
                aria-modal="false"
              >
                <div className="agent-controls">
                  <div className="agent-controls-filters">
                    <div className="agent-state-filter">
                      <Filter size={14} />
                      <select
                        className="agent-state-filter-select"
                        value={filterState}
                        onChange={(e) => setFilterState(e.target.value as AgentState | "all")}
                        aria-label={t("agents.filterByState", "Filter agents by state")}
                      >
                        <option value="all">{t("agents.stateAll", "All States")}</option>
                        <option value="idle">{t("agents.stateIdle", "Idle")}</option>
                        <option value="active">{t("agents.stateActive", "Active")}</option>
                        <option value="running">{t("agents.stateRunning", "Running")}</option>
                        <option value="paused">{t("agents.statePaused", "Paused")}</option>
                        <option value="error">{t("agents.stateError", "Error")}</option>
                      </select>
                    </div>

                    <label className="checkbox-label agent-system-filter">
                      <input
                        type="checkbox"
                        checked={showSystemAgents}
                        onChange={(e) => setShowSystemAgents(e.target.checked)}
                        aria-label={t("agents.showSystemAgents", "Show system agents")}
                      />
                      {t("agents.showSystemAgents", "Show system agents")}
                    </label>
                  </div>
                </div>

                {isMobileViewport && (
                  <div className="agent-controls-mobile-actions">
                    <button
                      className="btn btn-sm agent-import-trigger"
                      onClick={() => {
                        setIsImporting(true);
                        setIsControlsPanelOpen(false);
                      }}
                      aria-label={t("agents.import", "Import")}
                      title={t("agents.import", "Import")}
                    >
                      <Upload size={16} />
                      {t("agents.import", "Import")}
                    </button>
                    <button
                      className="btn btn-task-create btn-sm"
                      onClick={() => {
                        handleOpenNewAgent();
                        setIsControlsPanelOpen(false);
                      }}
                      aria-label={t("agents.newAgent", "New Agent")}
                      title={t("agents.newAgent", "New Agent")}
                    >
                      <Plus size={16} />
                      {t("agents.newAgent", "New Agent")}
                    </button>
                  </div>
                )}

                <div className="agent-controls-bulk-actions" role="menu" aria-label={t("agents.bulkAgentActions", "Bulk agent actions")}>
                  <button
                    type="button"
                    className="agent-detail-bulk-menu-item"
                    role="menuitem"
                    disabled={isPauseAllDisabled}
                    onClick={() => {
                      setIsControlsPanelOpen(false);
                      void handleBulkStateChange("paused");
                    }}
                  >
                    <span className="agent-controls-bulk-actions__label">
                      <Pause />
                      <span>{t("agents.pauseAllAgents", "Pause All Agents")}</span>
                    </span>
                    <span className="agent-detail-bulk-menu-item-hint">
                      {isBulkEligibilityLoading
                        ? t("agents.loadingEligibility", "Loading eligibility…")
                        : bulkPauseEligibleCount === 0
                          ? t("agents.noAgentsToPauseHint", "No active or running project agents to pause")
                          : t("agents.pauseCountHint", { count: bulkPauseEligibleCount, defaultValue_one: "Pause {{count}} active/running agent", defaultValue_other: "Pause {{count}} active/running agents" })}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="agent-detail-bulk-menu-item"
                    role="menuitem"
                    disabled={isResumeAllDisabled}
                    onClick={() => {
                      setIsControlsPanelOpen(false);
                      void handleBulkStateChange("active");
                    }}
                  >
                    <span className="agent-controls-bulk-actions__label">
                      <Play />
                      <span>{t("agents.resumeAllAgents", "Resume All Agents")}</span>
                    </span>
                    <span className="agent-detail-bulk-menu-item-hint">
                      {isBulkEligibilityLoading
                        ? t("agents.loadingEligibility", "Loading eligibility…")
                        : bulkResumeEligibleCount === 0
                          ? t("agents.noAgentsToResumeHint", "No paused project agents to resume")
                          : t("agents.resumeCountHint", { count: bulkResumeEligibleCount, defaultValue_one: "Resume {{count}} paused agent", defaultValue_other: "Resume {{count}} paused agents" })}
                    </span>
                  </button>
                </div>

                <div className="agent-global-controls agent-controls-actions">
                  <div className="heartbeat-multiplier-group">
                    <div className="heartbeat-multiplier-controls">
                      <label htmlFor="globalHeartbeatMultiplier" className="heartbeat-multiplier-label">
                        {t("agents.heartbeatSpeed", "Heartbeat Speed")}
                      </label>
                      <input
                        id="globalHeartbeatMultiplier"
                        className="heartbeat-multiplier-slider touch-target"
                        type="range"
                        min={0.1}
                        max={10}
                        step={0.1}
                        value={heartbeatMultiplier}
                        onChange={(e) => {
                          const val = Number(e.target.value);
                          void handleHeartbeatMultiplierChange(Number.isFinite(val) && val > 0 ? val : 1);
                        }}
                        disabled={isSavingMultiplier}
                      />
                      <span className="heartbeat-multiplier-value">×{heartbeatMultiplier.toFixed(1)}</span>
                      <select
                        className="heartbeat-multiplier-preset"
                        value={String(
                          HEARTBEAT_MULTIPLIER_PRESETS.reduce((closest, candidate) => {
                            return Math.abs(candidate - heartbeatMultiplier) < Math.abs(closest - heartbeatMultiplier) ? candidate : closest;
                          }, HEARTBEAT_MULTIPLIER_PRESETS[0])
                        )}
                        onChange={(e) => {
                          const val = Number(e.target.value);
                          void handleHeartbeatMultiplierChange(Number.isFinite(val) && val > 0 ? val : 1);
                        }}
                        disabled={isSavingMultiplier}
                        aria-label={t("agents.heartbeatSpeedPreset", "Heartbeat speed preset")}
                      >
                        {HEARTBEAT_MULTIPLIER_PRESETS.map((multiplier) => (
                          <option key={multiplier} value={String(multiplier)}>
                            ×{multiplier}
                          </option>
                        ))}
                      </select>
                    </div>
                    <small className="text-secondary">
                      {t("agents.heartbeatSpeedHint", "Scales all agent heartbeat intervals. ×0.5 = twice as fast, ×2.0 = twice as slow. Default: ×1.0")}
                    </small>
                  </div>
                </div>

                <AgentTokenStatsPanel agents={displayAgents} />
              </div>
            )}
          </div>
        </div>
        }
      />

      <NewAgentDialog
        isOpen={isCreating}
        onClose={() => {
          setIsCreating(false);
          setOnboardingDraft(null);
        }}
        onCreated={() => { setIsCreating(false); setOnboardingDraft(null); void loadAgents(); }}
        projectId={projectId}
        prefillDraft={onboardingDraft}
        agentOnboardingEnabled={agentOnboardingEnabled}
        existingAgents={agents}
        onPrefillDraft={setOnboardingDraft}
      />

      <AgentImportModal
        isOpen={isImporting}
        onClose={() => setIsImporting(false)}
        onImported={() => void loadAgents()}
        projectId={projectId}
      />

      <AgentsOverviewBar
        stats={stats}
        activeAgents={displayActiveAgents}
        projectId={projectId}
        isOpen={isOverviewOpen}
        onToggle={() => setIsOverviewOpen((open) => !open)}
        onSelectAgent={handleOverviewAgentSelect}
        onOpenTaskLogs={onOpenTaskLogs}
      />

      {agentView === "org" ? (
        <div className="agents-org-full-view">
          <div className="agents-view-content agents-view-content--org-full">
            {selectedAgentId ? (
              <div className="agents-org-detail-view" data-testid="agents-org-detail-view">
                <button
                  type="button"
                  className="btn btn-sm agents-org-detail-back"
                  onClick={handleCloseDetail}
                  aria-label={t("agents.backToOrgChart", "Back to org chart")}
                >
                  {t("agents.backToOrgChart", "Back to org chart")}
                </button>
                <Suspense fallback={null}>
                  <AgentDetailView
                    key={selectedAgentId}
                    inline
                    showInlineBackButton={false}
                    agentId={selectedAgentId}
                    projectId={projectId}
                    onClose={handleCloseDetail}
                    addToast={addToast}
                    onChildClick={handleChildClick}
                    initialTab={selectedAgentInitialTab}
                    initialRunId={selectedAgentInitialRunId}
                    preferActiveRun={selectedAgentPreferActiveRun}
                  />
                </Suspense>
              </div>
            ) : showInitialAgentsLoading ? (
              <div className="agents-view-loading" role="status" aria-live="polite">
                <RefreshCw size={18} className="spin" />
                <span>{t("agents.loadingAgents", "Loading agents...")}</span>
              </div>
            ) : (
              <div className="agent-org-chart-shell" data-testid="agent-org-chart-shell">
                {isMobileViewport ? (
                  <div className="agent-org-chart-controls" data-testid="agent-org-chart-controls">
                    {renderOrgChartLayoutToggle()}
                    {renderOrgChartZoomControls()}
                  </div>
                ) : (
                  <div className="agent-org-chart-toolbar">
                    {renderOrgChartLayoutToggle()}
                    <div className="agent-org-chart-controls" data-testid="agent-org-chart-controls">
                      {renderOrgChartZoomControls()}
                    </div>
                  </div>
                )}
                <div
                  ref={orgChartViewportRef}
                  className="agent-org-chart-viewport"
                  data-testid="agent-org-chart-viewport"
                  tabIndex={0}
                  role="region"
                  aria-label={t("agents.orgChartCanvas", "Org chart canvas")}
                  onWheel={handleOrgChartWheel}
                  onPointerDown={handleOrgChartPointerDown}
                  onPointerMove={handleOrgChartPointerMove}
                  onPointerUp={handleOrgChartPointerEnd}
                  onPointerCancel={handleOrgChartPointerEnd}
                  onKeyDown={handleOrgChartKeyDown}
                  data-panning={isOrgChartPanning ? "true" : "false"}
                >
                  <div
                    ref={orgChartCanvasRef}
                    className={`agent-org-chart-canvas agent-org-chart-canvas--zoom-${Math.round((orgChartTransform.scale ?? 1) * 100)}`}
                    data-panning={isOrgChartPanning ? "true" : "false"}
                    style={{ transform: `translate(${orgChartTransform.x}px, ${orgChartTransform.y}px) scale(${orgChartTransform.scale})` }}
                  >
                    <div
                      className={`agent-org-chart${orgChartLayoutMode === "vertical" ? " agent-org-chart--vertical" : ""}`}
                      data-testid="agent-org-chart"
                      data-layout-mode={orgChartLayoutMode}
                    >
                      {isOrgTreeLoading ? (
                        <div className="agent-org-chart__loading" role="status" aria-live="polite">
                          <RefreshCw size={18} className="spin" />
                          <span>{t("agents.loadingOrgChart", "Loading org chart...")}</span>
                        </div>
                      ) : displayOrgTree.length === 0 ? (
                        <AgentEmptyState onCtaClick={handleOpenNewAgent} />
                      ) : (
                        (() => {
                          orgChartLinksRef.current = [];
                          return displayOrgTree.map((node) => (
                            <OrgChartNode
                              key={node.agent.id}
                              node={node}
                              onSelect={handleOrgChartNodeSelect}
                              getHealthStatus={getHealthStatus}
                              selectedAgentId={selectedOrgChartAgentId}
                              registerNodeElement={registerOrgChartNodeElement}
                              linksRef={orgChartLinksRef}
                            />
                          ));
                        })()
                      )}
                    </div>
                    <OrgChartConnectors
                      links={orgChartLinksRef.current}
                      nodeElements={orgChartNodeRefs.current}
                      canvasRef={orgChartCanvasRef}
                      viewportRef={orgChartViewportRef}
                      layoutMode={orgChartLayoutMode}
                      transform={orgChartTransform}
                    />
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      ) : (
      <div
        className="agents-split-layout"
        style={isMobileViewport ? undefined : { gridTemplateColumns: `${sidebarWidth}px var(--space-sm) minmax(0, 1fr)` }}
      >
        <div className={`agents-split-sidebar${isMobileDetailOpen ? " agents-split-sidebar--hidden-mobile" : ""}`}>
          <div className="agents-view-content">
        {/* Agent Collection */}
        {showInitialAgentsLoading ? (
          <div className="agents-view-loading" role="status" aria-live="polite">
            <RefreshCw size={18} className="spin" />
            <span>{t("agents.loadingAgents", "Loading agents...")}</span>
          </div>
        ) : agentView === "board" ? (
          <div className="agent-board">
            {displayAgents.length === 0 ? (
              <AgentEmptyState onCtaClick={handleOpenNewAgent} />
            ) : (
              displayAgents.map((agent) => {
                const health = getHealthStatus(agent);
                const healthSummary = getHealthSummary(agent, health, t);
                const stateBadgeClass = getStateBadgeClass(agent.state);
                const stateCardClass = getStateCardClass("agent-board-card", agent.state);
                const viewportKey = `board:${agent.id}`;
                return (
                  <div
                    key={agent.id}
                    ref={registerAgentCardRef(viewportKey)}
                    className={`agent-board-card ${stateCardClass}${selectedAgentId === agent.id ? " agent-card--selected" : ""}`}
                  >
                    <div
                      className="agent-board-clickable"
                      onClick={() => openAgentDetail(agent.id)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          if (e.key === " ") {
                            e.preventDefault();
                          }
                          openAgentDetail(agent.id);
                        }
                      }}
                    >
                      <div className="agent-board-header">
                        <span className="agent-board-icon"><AgentAvatar agent={agent} size={20} /></span>
                        <span className="agent-board-badge badge text-secondary">{getRoleLabel(agent.role)}</span>
                        <span className={`agent-board-badge badge ${stateBadgeClass}`}>{agent.state}</span>
                        {(agent.pendingApprovalCount ?? 0) > 0 ? (
                          <span className="agent-board-badge badge agent-approval-badge" title={t("agents.pendingApprovals", "Pending approvals")}>
                            <span className="status-dot status-dot--pending" />
                            {agent.pendingApprovalCount}
                          </span>
                        ) : null}
                      </div>
                      <div className="agent-board-name">{agent.name}</div>
                      <div className="agent-board-id">{agent.id}</div>
                      {agent.taskId && (
                        <RuntimeFallbackBadge taskId={agent.taskId} isInViewport={isAgentCardKeyInViewport(viewportKey)} projectId={projectId} />
                      )}
                      <div className="agent-board-health" style={{ color: health.color }} title={healthSummary.title}>
                        {health.icon}{healthSummary.label ? ` ${healthSummary.label}` : ""}
                      </div>
                    </div>
                    {(agent.state === "idle" || agent.state === "paused" || agent.state === "error") && (
                      <div className="agent-board-actions">
                        <button
                          className="btn btn-sm btn-danger"
                          onClick={() => void handleDelete(agent.id, agent.name)}
                          title={t("agents.delete", "Delete")}
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        ) : (
        <div className="agent-list">
          {displayAgents.length === 0 ? (
            <AgentEmptyState onCtaClick={handleOpenNewAgent} />
          ) : (
            // List view: detailed card layout
            displayAgents.map(agent => {
              const health = getHealthStatus(agent);
              const healthSummary = getHealthSummary(agent, health, t);
              const stateBadgeClass = getStateBadgeClass(agent.state);
              const stateCardClass = getStateCardClass("agent-card", agent.state);
              const configuredIntervalMs = resolveHeartbeatIntervalMs(agent.runtimeConfig?.heartbeatIntervalMs);
              const heartbeatOptions = getHeartbeatIntervalOptions(configuredIntervalMs);
              const isUpdatingHeartbeat = updatingHeartbeatAgentId === agent.id;
              const modelLabel = getAgentModelLabel(agent);
              const viewportKey = `list:${agent.id}`;
              return (
                <div
                  key={agent.id}
                  ref={registerAgentCardRef(viewportKey)}
                  className={`agent-card agent-card--clickable ${stateCardClass}${selectedAgentId === agent.id ? " agent-card--selected" : ""}`}
                  onClick={(e) => {
                    // Open detail when the user clicks the card body, but
                    // bail when the click landed on an interactive
                    // descendant (action buttons, the role-edit select,
                    // the role-icon button) so those keep their dedicated
                    // behaviors instead of double-firing. Use currentTarget
                    // as the boundary so the card's own role="button" is
                    // not treated as an interactive descendant.
                    const target = e.target as HTMLElement;
                    if (target === e.currentTarget) {
                      openAgentDetail(agent.id);
                      return;
                    }
                    const interactive = target.closest('button, select, input, [role="button"]');
                    if (interactive && interactive !== e.currentTarget) return;
                    openAgentDetail(agent.id);
                  }}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.target !== e.currentTarget) return;
                    if (e.key === "Enter" || e.key === " ") {
                      if (e.key === " ") e.preventDefault();
                      openAgentDetail(agent.id);
                    }
                  }}
                  aria-label={t("agents.openDetails", "Open details for {{name}}", { name: agent.name })}
                >
                  <div className="agent-card-header">
                    <div className="agent-info">
                      {editingRoleForAgent === agent.id ? (
                        <select
                          ref={roleSelectRef}
                          className="select agent-role-select"
                          value={agent.role}
                          onChange={(e) => void handleRoleChange(agent.id, e.target.value as AgentCapability)}
                          onKeyDown={(e) => handleRoleKeyDown(e, agent.id)}
                          onBlur={() => setEditingRoleForAgent(null)}
                          autoFocus
                        >
                          {agentRoles.map(role => (
                            <option key={role.value} value={role.value}>
                              {role.icon} {role.label}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span
                          className="agent-icon agent-icon--clickable"
                          onClick={(e) => {
                            e.stopPropagation();
                            setEditingRoleForAgent(agent.id);
                          }}
                          title={t("agents.clickToChangeRole", "Click to change role")}
                          role="button"
                          tabIndex={0}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.stopPropagation();
                              setEditingRoleForAgent(agent.id);
                            }
                          }}
                        >
                          <AgentAvatar agent={agent} size={20} />
                        </span>
                      )}
                      <div className="agent-meta">
                        <span className="agent-name">{agent.name}</span>
                        <span className="agent-id text-secondary">{agent.id}</span>
                      </div>
                      <ChevronRight size={20} className="agent-card-chevron" />
                    </div>
                    <div className="agent-badges">
                      <span
                        className={`badge ${stateBadgeClass}`}
                      >
                        {agent.state}
                      </span>
                      <span className="badge" style={{ color: health.color }} title={healthSummary.title}>
                        {health.icon}{healthSummary.label ? ` ${healthSummary.label}` : ""}
                      </span>
                      <span className="badge text-secondary">
                        {getRoleLabel(agent.role)}
                      </span>
                      {(agent.pendingApprovalCount ?? 0) > 0 ? (
                        <span className="badge agent-approval-badge" title={t("agents.pendingApprovals", "Pending approvals")}>
                          <span className="status-dot status-dot--pending" />
                          {agent.pendingApprovalCount}
                        </span>
                      ) : null}
                      {/* List view: up to 2 skill badges */}
                      {(() => {
                        const skills = getSkillBadges(agent);
                        if (skills.length === 0) return null;
                        const displaySkills = skills.slice(0, 2);
                        const extraCount = skills.length - 2;
                        return (
                          <>
                            {displaySkills.map((skillId) => (
                              <span key={skillId} className="badge badge-skill" title={skillId}>{formatAgentSkillBadgeLabel(skillId)}</span>
                            ))}
                            {extraCount > 0 && <span className="badge badge-skill">+{extraCount}</span>}
                          </>
                        );
                      })()}
                    </div>
                  </div>

                  <div className="agent-card-body">
                    <div className="agent-model-runtime">
                      <span className="text-secondary">{modelLabel.isRuntime ? t("agents.runtime", "Runtime") : t("agents.model", "Model")}:</span>
                      <span className="badge agent-model-runtime__value" title={modelLabel.label ?? t("agents.auto", "Auto")}>
                        {modelLabel.label ?? t("agents.auto", "Auto")}
                      </span>
                    </div>
                    {agent.state === "error" && agent.lastError ? (
                      <AgentErrorIndicator
                        errorText={agent.lastError}
                        issueContext={{
                          surface: "AgentsView list",
                          agentId: agent.id,
                          agentName: agent.name,
                          agentState: agent.state,
                          taskId: agent.taskId,
                        }}
                      />
                    ) : null}
                    {agent.taskId && (
                      <div className="agent-task">
                        <span className="text-secondary">{t("agents.workingOn", "Working on:")}</span>
                        <span className="badge"><AgentTaskBadge taskId={agent.taskId} taskColumn={agent.taskColumn} /></span>
                        <RuntimeFallbackBadge taskId={agent.taskId} isInViewport={isAgentCardKeyInViewport(viewportKey)} projectId={projectId} />
                      </div>
                    )}
                    <div className="agent-heartbeat-control">
                      <span className="text-secondary">{t("agents.heartbeat", "Heartbeat:")}</span>
                      {customHeartbeatAgentId === agent.id ? (
                        // Custom input mode
                        <>
                          <input
                            type="text"
                            inputMode="numeric"
                            pattern="[0-9]*"
                            className="input agent-heartbeat-custom-input"
                            value={customHeartbeatMinutes[agent.id] ?? ""}
                            onChange={(e) => setCustomHeartbeatMinutes((prev) => ({
                              ...prev,
                              [agent.id]: e.target.value,
                            }))}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                void handleCustomHeartbeatSave(agent);
                              } else if (e.key === "Escape") {
                                setCustomHeartbeatAgentId(null);
                                setCustomHeartbeatMinutes((prev) => {
                                  const next = { ...prev };
                                  delete next[agent.id];
                                  return next;
                                });
                              }
                            }}
                            disabled={isUpdatingHeartbeat}
                            aria-label={t("agents.customHeartbeatAria", "Custom heartbeat interval in minutes for {{name}}", { name: agent.name })}
                          />
                          <span className="text-secondary">{t("agents.minutesUnit", "min")}</span>
                          <button
                            className="btn btn-sm"
                            onClick={() => void handleCustomHeartbeatSave(agent)}
                            disabled={isUpdatingHeartbeat}
                            title={t("agents.saveCustomInterval", "Save custom interval")}
                          >
                            {t("agents.save", "Save")}
                          </button>
                          <button
                            className="btn btn-sm"
                            onClick={() => {
                              setCustomHeartbeatAgentId(null);
                              setCustomHeartbeatMinutes((prev) => {
                                const next = { ...prev };
                                delete next[agent.id];
                                return next;
                              });
                            }}
                            disabled={isUpdatingHeartbeat}
                            title={t("agents.cancelCustomInterval", "Cancel custom interval")}
                          >
                            {t("agents.cancel", "Cancel")}
                          </button>
                        </>
                      ) : (
                        // Preset selection mode
                        <>
                          <select
                            className="select agent-heartbeat-select"
                            value={configuredIntervalMs}
                            onChange={(e) => {
                              const value = e.target.value;
                              if (value === "__custom__") {
                                handleSelectCustomHeartbeat(agent);
                              } else {
                                void handleHeartbeatIntervalChange(agent, Number(value));
                              }
                            }}
                            disabled={isUpdatingHeartbeat}
                            aria-label={t("agents.setHeartbeatAria", "Set heartbeat interval for {{name}}", { name: agent.name })}
                          >
                            {heartbeatOptions.map((option) => (
                              <option key={option.value} value={option.value}>
                                {option.label}
                              </option>
                            ))}
                            {/* Only show "Custom..." if current value is a preset; if it's already custom, it's already in the list */}
                            {HEARTBEAT_INTERVAL_PRESETS.some((p) => p.value === configuredIntervalMs) && (
                              <option value="__custom__">{t("agents.customHeartbeatOption", "Custom...")}</option>
                            )}
                          </select>
                        </>
                      )}
                      {isUpdatingHeartbeat && <span className="agent-heartbeat-saving text-secondary">{t("agents.saving", "Saving…")}</span>}
                      {agent.lastHeartbeatAt && (() => {
                        const lastAt = new Date(agent.lastHeartbeatAt);
                        const nextAt = new Date(lastAt.getTime() + configuredIntervalMs);
                        const isTicking = agent.state === "active" || agent.state === "running";
                        return (
                          <>
                            <span className="agent-heartbeat-last text-secondary" title={lastAt.toLocaleString()}>
                              {t("agents.lastHeartbeatAt", "Last: {{time}}", { time: lastAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) })}
                            </span>
                            {isTicking && (
                              <span className="agent-heartbeat-next text-secondary" title={nextAt.toLocaleString()}>
                                {t("agents.nextHeartbeatAt", "Next: {{time}}", { time: nextAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) })}
                              </span>
                            )}
                          </>
                        );
                      })()}
                    </div>
                  </div>

                  <div className="agent-card-actions">
                    <div className="agent-card-actions-group agent-card-actions-group--primary">
                      {agent.state === "idle" && (
                        <button
                          className="btn btn-sm"
                          onClick={() => void handleStateChange(agent.id, "active")}
                          disabled={transitioningAgentIds.has(agent.id)}
                          title={t("agents.activate", "Activate")}
                        >
                          <Play size={14} /> <span className="agent-card-action-label">{t("agents.start", "Start")}</span>
                        </button>
                      )}
                      {agent.state === "active" && (
                        <>
                          <button
                            className="btn btn-sm"
                            onClick={() => void handleRunHeartbeat(agent.id, agent.name)}
                            disabled={transitioningAgentIds.has(agent.id)}
                            title={t("agents.runNow", "Run Now")}
                            aria-label={t("agents.runNowAria", "Run now for {{name}}", { name: agent.name })}
                          >
                            <Activity size={14} /> <span className="agent-card-action-label">{t("agents.runNow", "Run Now")}</span>
                          </button>
                          <button
                            className="btn btn-sm"
                            onClick={() => void handleStateChange(agent.id, "paused")}
                            disabled={transitioningAgentIds.has(agent.id)}
                            title={t("agents.pause", "Pause")}
                          >
                            <Pause size={14} /> <span className="agent-card-action-label">{t("agents.pause", "Pause")}</span>
                          </button>
                        </>
                      )}
                      {agent.state === "paused" && (
                        <button
                          className="btn btn-sm"
                          onClick={() => void handleStateChange(agent.id, "active")}
                          disabled={transitioningAgentIds.has(agent.id)}
                          title={t("agents.resume", "Resume")}
                        >
                          <Play size={14} /> <span className="agent-card-action-label">{t("agents.resume", "Resume")}</span>
                        </button>
                      )}
                      {agent.state === "running" && (
                        <>
                          <button
                            className="btn btn-sm"
                            onClick={() => openAgentDetail(agent.id, { initialTab: "runs", initialRunId: null, preferActiveRun: true })}
                            title={t("agents.viewLiveRun", "View live run details")}
                            aria-label={t("agents.viewLiveRunAria", "View live run details for {{name}}", { name: agent.name })}
                          >
                            <Activity size={14} /> <span className="agent-card-action-label">{t("agents.running", "Running")}</span>
                          </button>
                          <button
                            className="btn btn-sm"
                            onClick={() => void handleStateChange(agent.id, "paused")}
                            disabled={transitioningAgentIds.has(agent.id)}
                            title={t("agents.pause", "Pause")}
                          >
                            <Pause size={14} /> <span className="agent-card-action-label">{t("agents.pause", "Pause")}</span>
                          </button>
                        </>
                      )}
                      {agent.state === "error" && (
                        <button
                          className="btn btn-sm"
                          onClick={() => void handleStateChange(agent.id, "active")}
                          disabled={transitioningAgentIds.has(agent.id)}
                          title={t("agents.retry", "Retry")}
                        >
                          <Play size={14} /> <span className="agent-card-action-label">{t("agents.retry", "Retry")}</span>
                        </button>
                      )}
                    </div>
                    <div className="agent-card-actions-group agent-card-actions-group--secondary">
                      <button
                        className="btn btn-sm agent-card-details-btn"
                        onClick={() => openAgentDetail(agent.id)}
                        title={t("agents.viewDetailsFor", "View details for {{name}}", { name: agent.name })}
                        aria-label={t("agents.viewDetailsFor", "View details for {{name}}", { name: agent.name })}
                      >
                        <Info size={14} /> <span className="agent-card-action-label">{t("agents.details", "Details")}</span>
                      </button>
                      {(agent.state === "idle" || agent.state === "paused" || agent.state === "error") && (
                        <button
                          className="btn btn-sm btn-danger"
                          onClick={() => void handleDelete(agent.id, agent.name)}
                          title={t("agents.delete", "Delete")}
                        >
                          <Trash2 size={14} /> <span className="agent-card-action-label">{t("agents.delete", "Delete")}</span>
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
        )}
          </div>

        </div>

        {!isMobileViewport && (
          <div
            className="agents-split-resize-handle"
            data-testid="agents-sidebar-resize-handle"
            role="separator"
            aria-orientation="vertical"
            aria-valuemin={AGENTS_SIDEBAR_MIN_WIDTH}
            aria-valuemax={AGENTS_SIDEBAR_MAX_WIDTH}
            aria-valuenow={sidebarWidth}
            aria-label={t("agents.resizeSidebar", "Resize agents sidebar")}
            tabIndex={0}
            onPointerDown={handleSidebarResizeStart}
            onKeyDown={handleSidebarResizeKeyDown}
          />
        )}

        <div className={`agents-split-detail${isMobileViewport && !selectedAgentId ? " agents-split-detail--hidden-mobile" : ""}`}>
          {selectedAgentId ? (
            <Suspense fallback={null}>
              <AgentDetailView
                key={selectedAgentId}
                inline
                showInlineBackButton={isMobileViewport}
                agentId={selectedAgentId}
                projectId={projectId}
                onClose={handleCloseDetail}
                addToast={addToast}
                onChildClick={handleChildClick}
                initialTab={selectedAgentInitialTab}
                initialRunId={selectedAgentInitialRunId}
                preferActiveRun={selectedAgentPreferActiveRun}
                onMutationSuccess={handleDetailMutationSuccess}
              />
            </Suspense>
          ) : (
            <div className="agents-detail-empty-state">
              <Bot size={48} />
              <h3>{t("agents.selectAnAgent", "Select an agent")}</h3>
              <p>{t("agents.selectAgentHint", "Choose an agent from the sidebar to view details")}</p>
            </div>
          )}
        </div>
      </div>
      )}
    </div>
  );
}
