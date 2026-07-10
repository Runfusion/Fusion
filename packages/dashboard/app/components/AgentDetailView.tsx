import "./AgentDetailView.css";
import "./MailboxModal.css";
import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  Bot, Heart, Activity, Pause, Play, Square, Trash2, RefreshCw, 
  Settings, FileText, ActivitySquare, X, Copy, 
  ExternalLink, CheckCircle, XCircle, Loader2, GitBranch, ListChecks,
  AlertCircle,
  ChevronDown, ChevronRight, ChevronLeft, BarChart3, BookOpen, Eye, FileEdit,
  Mail, Send, Inbox as InboxIcon, User, MoreVertical
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { AgentDetail, AgentState, AgentHeartbeatRun, AgentBudgetStatus, ModelInfo, MemoryFileInfo, AgentCapability, PluginRuntimeInfo, SkillContent, AgentOnboardingSummary, AgentMailboxResponse, AgentPromptSizePoint } from "../api";
import { fetchAgent, updateAgent, updateAgentState, deleteAgent, fetchAgentLogsWithMeta, fetchAgentRunLogs, fetchAgentChildren, fetchAgentRuns, fetchAgentRunDetail, startAgentRun, stopAgentRun, updateAgentInstructions, updateAgentSoul, updateAgentMemory, fetchAgentMemoryFiles, fetchAgentMemoryFile, saveAgentMemoryFile, fetchAgentTasks, fetchChainOfCommand, fetchAgentBudgetStatus, resetAgentBudget, fetchWorkspaceFileContent, saveWorkspaceFileContent, fetchModels, fetchPluginRuntimes, fetchAgents, fetchSettingsByScope, upgradeAgentHeartbeatProcedure, fetchSkillContent, uploadAgentAvatar, deleteAgentAvatar, fetchAgentMailbox, markMessageRead, fetchAgentPromptSizes } from "../api";
import type { Agent } from "../api";
import type { AgentLogEntry, Task, Message, ParticipantType, AgentPermissionPolicy, AgentPermissionPolicyRules, AgentPermission } from "@fusion/core";
import { AGENT_PERMISSIONS, getErrorMessage, isEphemeralAgent } from "@fusion/core";
import { AgentLogViewer } from "./AgentLogViewer";
import { LoadingSpinner } from "./LoadingSpinner";
import { AgentReflectionsTab } from "./AgentReflectionsTab";
import { getAgentHealthStatus } from "../utils/agentHealth";
import type { AgentHealthStatus } from "../utils/agentHealth";
import { SkillMultiselect } from "./SkillMultiselect";
import { subscribeSse } from "../sse-bus";
import { DEFAULT_HEARTBEAT_INTERVAL_MS, formatHeartbeatInterval, resolveHeartbeatIntervalMs } from "../utils/heartbeatIntervals";
import { formatAgentSkillBadgeLabel } from "../utils/agentSkills";
import { CustomModelDropdown } from "./CustomModelDropdown";
import { useConfirm } from "../hooks/useConfirm";
import { useModalResizePersist } from "../hooks/useModalResizePersist";
import { AgentAvatar } from "./AgentAvatar";
import { AgentErrorIndicator } from "./AgentErrorDetailsModal";
import { AgentTaskBadge } from "./AgentTaskBadge";
import { ExperimentalAgentOnboardingModal } from "./ExperimentalAgentOnboardingModal";
import { AgentPermissionPolicyEditor } from "./AgentPermissionPolicyEditor";
import { useFavorites } from "../hooks/useFavorites";

/**
 * Simple className utility - joins class names conditionally
 */
function cn(...classes: (string | boolean | undefined | null)[]): string {
  return classes.filter(Boolean).join(" ");
}

/*
FNXC:AgentPermissions 2026-07-02-00:00:
Agent Detail must show explicit capability grants next to role-default grants for both permanent and ephemeral agents. Keep this UI map aligned with core ROLE_DEFAULT_PERMISSIONS while the dashboard source build imports constants through the core types surface.
*/
const AGENT_ROLE_DEFAULT_PERMISSION_MAP: Record<AgentCapability, AgentPermission[]> = {
  triage: ["tasks:create", "agents:view", "messages:read"],
  executor: ["tasks:execute", "agents:view", "messages:read", "messages:send"],
  reviewer: ["tasks:review", "agents:view", "messages:read", "messages:send"],
  merger: ["tasks:merge", "agents:view", "messages:read"],
  scheduler: ["tasks:assign", "tasks:create", "tasks:archive", "agents:view", "automations:manage", "missions:manage", "messages:read"],
  engineer: ["tasks:execute", "tasks:review", "agents:view", "messages:read", "messages:send"],
  custom: [],
};

/**
 * Format an ISO timestamp to a relative time string.
 */
export function relativeTime(iso: string, t?: (key: string, defaultValue: string, options?: Record<string, unknown>) => string): string {
  const now = Date.now();
  const then = new Date(iso).getTime();
  const diffMs = now - then;
  // Fallback interpolates {{n}} manually when no t() is provided
  const tr = t ?? ((_key: string, def: string, opts?: Record<string, unknown>) => {
    if (!opts) return def;
    return def.replace(/\{\{(\w+)\}\}/g, (_, k) => String(opts[k] ?? ""));
  });

  // Future
  if (diffMs < 0) {
    const absDiff = Math.abs(diffMs);
    if (absDiff < 60_000) return tr("time.inAMoment", "in a moment");
    if (absDiff < 3_600_000) { const n = Math.floor(absDiff / 60_000); return tr("time.inMinutes", "in {{n}}m", { n }); }
    if (absDiff < 86_400_000) { const n = Math.floor(absDiff / 3_600_000); return tr("time.inHours", "in {{n}}h", { n }); }
    const n = Math.floor(absDiff / 86_400_000);
    return tr("time.inDays", "in {{n}}d", { n });
  }

  // Past
  if (diffMs < 60_000) return tr("time.justNow", "just now");
  if (diffMs < 3_600_000) { const n = Math.floor(diffMs / 60_000); return tr("time.minutesAgo", "{{n}}m ago", { n }); }
  if (diffMs < 86_400_000) { const n = Math.floor(diffMs / 3_600_000); return tr("time.hoursAgo", "{{n}}h ago", { n }); }
  const n = Math.floor(diffMs / 86_400_000);
  return tr("time.daysAgo", "{{n}}d ago", { n });
}

const WARNING_ICON = "⚠️";

interface AgentDetailViewProps {
  agentId: string;
  projectId?: string;
  onClose: () => void;
  addToast: (message: string, type?: "success" | "error") => void;
  onChildClick?: (childId: string) => void;
  inline?: boolean;
  showInlineBackButton?: boolean;
  initialTab?: TabId;
  initialRunId?: string | null;
  preferActiveRun?: boolean;
  onMutationSuccess?: (context: { agentId: string; deleted?: boolean }) => void | Promise<void>;
}

type TabId = "dashboard" | "logs" | "mail" | "config" | "runs" | "tasks" | "employees" | "soul" | "instructions" | "memory" | "reflections";

const TABS: { id: TabId; label: string; icon: typeof Activity }[] = [
  { id: "dashboard", label: "Dashboard", icon: ActivitySquare },
  { id: "logs", label: "Logs", icon: FileText },
  { id: "mail", label: "Mail", icon: Mail },
  { id: "runs", label: "Runs", icon: Activity },
  { id: "tasks", label: "Tasks", icon: ListChecks },
  { id: "employees", label: "Employees", icon: GitBranch },
  { id: "soul", label: "Soul", icon: Heart },
  { id: "instructions", label: "Instructions", icon: BookOpen },
  { id: "memory", label: "Agent Memory", icon: FileText },
  { id: "reflections", label: "Evaluation", icon: BarChart3 },
  { id: "config", label: "Settings", icon: Settings },
];

const STATE_COLORS: Record<AgentState, { bg: string; text: string; border: string }> = {
  idle: { bg: "var(--state-idle-bg)", text: "var(--state-idle-text)", border: "var(--state-idle-border)" },
  active: { bg: "var(--state-active-bg)", text: "var(--state-active-text)", border: "var(--state-active-border)" },
  running: { bg: "var(--state-active-bg)", text: "var(--state-active-text)", border: "var(--state-active-border)" },
  paused: { bg: "var(--state-paused-bg)", text: "var(--state-paused-text)", border: "var(--state-paused-border)" },
  error: { bg: "var(--state-error-bg)", text: "var(--state-error-text)", border: "var(--state-error-border)" },
};

const RUN_STATUS_ICONS: Record<string, { icon: typeof CheckCircle; color: string }> = {
  completed: { icon: CheckCircle, color: "var(--color-success)" },
  failed: { icon: XCircle, color: "var(--color-error)" },
  active: { icon: Loader2, color: "var(--in-progress)" },
  terminated: { icon: Square, color: "var(--text-muted)" },
};

const DEFAULT_HEARTBEAT_INTERVAL_LABEL = formatHeartbeatInterval(DEFAULT_HEARTBEAT_INTERVAL_MS);
const CONFIG_AUTOSAVE_DEBOUNCE_MS = 700;

function pickDefaultAgentMemoryPath(files: MemoryFileInfo[], currentPath: string): string {
  if (files.some((file) => file.path === currentPath)) {
    return currentPath;
  }

  return files.find((file) => file.layer === "long-term")?.path
    ?? files[0]?.path
    ?? "";
}

export function AgentDetailView({ agentId, projectId, onClose, addToast, onChildClick, inline = false, showInlineBackButton = false, initialTab, initialRunId, preferActiveRun = false, onMutationSuccess }: AgentDetailViewProps) {
  const { t } = useTranslation("app");
  const [agent, setAgent] = useState<AgentDetail | null>(null);
  const { confirm } = useConfirm();
  const [logs, setLogs] = useState<AgentLogEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<TabId>(initialTab ?? "dashboard");
  const [isStreaming, setIsStreaming] = useState(false);
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [isStartingRun, setIsStartingRun] = useState(false);
  const [isBulkMenuOpen, setIsBulkMenuOpen] = useState(false);
  const [isBulkActionRunning, setIsBulkActionRunning] = useState(false);
  const [isBulkEligibilityLoading, setIsBulkEligibilityLoading] = useState(false);
  const [bulkPauseEligibleCount, setBulkPauseEligibleCount] = useState(0);
  const [bulkResumeEligibleCount, setBulkResumeEligibleCount] = useState(0);
  const [runNowRefreshToken, setRunNowRefreshToken] = useState(0);
  const [latestRun, setLatestRun] = useState<AgentHeartbeatRun | null>(null);
  const [agentMailbox, setAgentMailbox] = useState<AgentMailboxResponse | null>(null);
  const [isLoadingMailbox, setIsLoadingMailbox] = useState(false);
  const [mailboxError, setMailboxError] = useState<string | null>(null);
  const agentDetailModalRef = useRef<HTMLDivElement>(null);
  const bulkMenuRef = useRef<HTMLDivElement | null>(null);
  const overlayMouseDownRef = useRef(false);
  useModalResizePersist(agentDetailModalRef, !inline, "fusion:agent-detail-modal-size");
  const onCloseRef = useRef(onClose);
  const addToastRef = useRef(addToast);
  const agentRef = useRef<AgentDetail | null>(null);
  const hasConfigChangesRef = useRef(false);
  const loadedLatestRunLogsRef = useRef<string | null>(null);

  // Track the context version to detect stale events after project/agent switches.
  // Incremented whenever agentId or projectId changes, invalidating any in-flight SSE handlers.
  const contextVersionRef = useRef(0);
  const previousAgentIdRef = useRef(agentId);
  const previousProjectIdRef = useRef(projectId);

  onCloseRef.current = onClose;
  addToastRef.current = addToast;
  agentRef.current = agent;

  const loadAgent = useCallback(async () => {
    const showLoadingSpinner = agentRef.current === null;
    if (showLoadingSpinner) {
      setIsLoading(true);
    }

    try {
      const data = await fetchAgent(agentId, projectId);
      setAgent(data);
    } catch (err) {
      addToastRef.current(`Failed to load agent: ${getErrorMessage(err)}`, "error");
      onCloseRef.current();
    } finally {
      setIsLoading(false);
    }
  }, [agentId, projectId]);

  const loadLogs = useCallback(async () => {
    // Capture context version at callback creation - stale responses will be rejected
    const contextVersionAtCapture = contextVersionRef.current;
    const currentAgentId = agentId;
    const currentProjectId = projectId;

    const isStale = () =>
      contextVersionRef.current !== contextVersionAtCapture ||
      agentId !== currentAgentId ||
      projectId !== currentProjectId;

    try {
      if (agent?.taskId) {
        setLatestRun(null);
        loadedLatestRunLogsRef.current = null;
        const result = await fetchAgentLogsWithMeta(agent.taskId, currentProjectId, { limit: 100 });
        if (isStale()) return;
        setLogs(result.entries);
        return;
      }

      // Fallback: show the latest run's logs so the Logs tab is populated even
      // when no task is currently assigned.
      const runs = await fetchAgentRuns(currentAgentId, 1, currentProjectId);
      if (isStale()) return;
      const latest = runs[0] ?? null;
      setLatestRun(latest);
      if (!latest) {
        loadedLatestRunLogsRef.current = null;
        setLogs([]);
        return;
      }
      if (loadedLatestRunLogsRef.current === latest.id) {
        return;
      }
      const entries = await fetchAgentRunLogs(currentAgentId, latest.id, currentProjectId);
      if (isStale()) return;
      setLogs(entries);
      loadedLatestRunLogsRef.current = latest.id;
    } catch (err) {
      if (isStale()) return;
      console.error("Failed to load agent logs:", err);
    }
  }, [agent?.taskId, agentId, projectId]);

  const loadMailbox = useCallback(async () => {
    setIsLoadingMailbox(true);
    setMailboxError(null);
    try {
      const mailbox = await fetchAgentMailbox(agentId, projectId);
      setAgentMailbox(mailbox);
    } catch (err) {
      setMailboxError(getErrorMessage(err));
      setAgentMailbox(null);
    } finally {
      setIsLoadingMailbox(false);
    }
  }, [agentId, projectId]);

  const handleConfigChangesState = useCallback((hasChanges: boolean) => {
    hasConfigChangesRef.current = hasChanges;
  }, []);

  const notifyMutationSuccess = useCallback(async (deleted = false) => {
    await onMutationSuccess?.({ agentId, deleted });
  }, [agentId, onMutationSuccess]);

  const handleSavedMutation = useCallback(async () => {
    await loadAgent();
    await notifyMutationSuccess(false);
  }, [loadAgent, notifyMutationSuccess]);

  useEffect(() => {
    void loadAgent();
  }, [loadAgent]);

  // Poll for agent updates to keep health status fresh (every 30 seconds)
  // This ensures health badges stay current while the detail view is open
  useEffect(() => {
    const pollInterval = setInterval(() => {
      void loadAgent();
    }, 30_000);

    return () => {
      clearInterval(pollInterval);
    };
  }, [loadAgent]);

  useEffect(() => {
    if (agent && activeTab === "logs") {
      void loadLogs();
    }
  }, [agent, activeTab, loadLogs]);

  useEffect(() => {
    if (activeTab !== "logs") {
      loadedLatestRunLogsRef.current = null;
    }
  }, [activeTab]);

  useEffect(() => {
    if (agent && activeTab === "mail") {
      void loadMailbox();
    }
  }, [agent, activeTab, loadMailbox]);

  useEffect(() => {
    if (!isBulkMenuOpen) return;

    const onDocumentMouseDown = (event: MouseEvent) => {
      if (!bulkMenuRef.current?.contains(event.target as Node)) {
        setIsBulkMenuOpen(false);
      }
    };

    const onDocumentKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsBulkMenuOpen(false);
      }
    };

    document.addEventListener("mousedown", onDocumentMouseDown);
    document.addEventListener("keydown", onDocumentKeyDown);

    return () => {
      document.removeEventListener("mousedown", onDocumentMouseDown);
      document.removeEventListener("keydown", onDocumentKeyDown);
    };
  }, [isBulkMenuOpen]);

  useEffect(() => {
    if (!isBulkMenuOpen) return;

    let cancelled = false;
    setIsBulkEligibilityLoading(true);

    fetchAgents(undefined, projectId)
      .then((projectAgents) => {
        if (cancelled) return;
        const nonEphemeralAgents = projectAgents.filter((projectAgent) => !isEphemeralAgent(projectAgent));
        setBulkPauseEligibleCount(nonEphemeralAgents.filter((projectAgent) => projectAgent.state === "active" || projectAgent.state === "running").length);
        setBulkResumeEligibleCount(nonEphemeralAgents.filter((projectAgent) => projectAgent.state === "paused").length);
      })
      .catch(() => {
        if (cancelled) return;
        setBulkPauseEligibleCount(0);
        setBulkResumeEligibleCount(0);
      })
      .finally(() => {
        if (!cancelled) {
          setIsBulkEligibilityLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [isBulkMenuOpen, projectId]);

  // When falling back to latest-run logs (no taskId) and that run is active,
  // subscribe to the run-scoped SSE stream so the Logs tab tails updates.
  useEffect(() => {
    if (activeTab !== "logs" || agent?.taskId) return;
    if (!latestRun || latestRun.status !== "active") return;

    const contextVersionAtStart = contextVersionRef.current;
    const currentAgentId = agentId;
    const currentRunId = latestRun.id;
    const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";

    const unsubscribe = subscribeSse(
      `/api/agents/${encodeURIComponent(currentAgentId)}/runs/${encodeURIComponent(currentRunId)}/logs/stream${query}`,
      {
        events: {
          "agent:log": (e) => {
            if (contextVersionRef.current !== contextVersionAtStart) return;
            try {
              const entry: AgentLogEntry = JSON.parse(e.data);
              setLogs(prev => [...prev, entry]);
            } catch {
              // ignore malformed events
            }
          },
        },
        onOpen: () => {
          if (contextVersionRef.current === contextVersionAtStart) {
            setIsStreaming(true);
          }
        },
        onError: () => {
          if (contextVersionRef.current === contextVersionAtStart) {
            setIsStreaming(false);
          }
        },
      },
    );

    return () => {
      unsubscribe();
      if (contextVersionRef.current === contextVersionAtStart) {
        setIsStreaming(false);
      }
    };
  }, [activeTab, agent?.taskId, agentId, projectId, latestRun]);

  // Detect context changes (agentId or projectId) and invalidate stale handlers
  useEffect(() => {
    if (previousAgentIdRef.current !== agentId || previousProjectIdRef.current !== projectId) {
      previousAgentIdRef.current = agentId;
      previousProjectIdRef.current = projectId;
      contextVersionRef.current++;

      // Clear stale logs and streaming state immediately
      setLogs([]);
      setIsStreaming(false);
      setLatestRun(null);
      setAgentMailbox(null);
      setMailboxError(null);
      loadedLatestRunLogsRef.current = null;
      hasConfigChangesRef.current = false;
    }
  }, [agentId, projectId]);

  // Refresh this view when the current agent is updated elsewhere, unless there are unsaved edits.
  useEffect(() => {
    const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
    const contextVersionAtStart = contextVersionRef.current;

    const refreshAgentForApprovalEvent = (event: MessageEvent) => {
      if (contextVersionRef.current !== contextVersionAtStart) return;
      try {
        const payload: unknown = JSON.parse(event.data);
        if (!payload || typeof payload !== "object") return;
        const approvalAgentId = (payload as { agentId?: unknown }).agentId;
        if (approvalAgentId !== agentId) return;
        void loadAgent();
      } catch {
        // Ignore malformed events
      }
    };

    return subscribeSse(`/api/events${query}`, {
      events: {
        "agent:updated": (event) => {
          if (contextVersionRef.current !== contextVersionAtStart) return;
          try {
            const payload: unknown = JSON.parse(event.data);
            if (!payload || typeof payload !== "object") return;
            const updatedId = (payload as { id?: unknown }).id;
            if (updatedId !== agentId) return;
            if (hasConfigChangesRef.current) return;
            void loadAgent();
          } catch {
            // Ignore malformed events
          }
        },
        "approval:requested": refreshAgentForApprovalEvent,
        "approval:updated": refreshAgentForApprovalEvent,
        "approval:decided": refreshAgentForApprovalEvent,
      },
    });
  }, [agentId, projectId, loadAgent]);

  // Set up SSE for live log streaming when viewing logs tab with a task
  useEffect(() => {
    if (activeTab !== "logs" || !agent?.taskId) {
      setIsStreaming(false);
      return;
    }

    // Capture context version at effect start - stale events will be rejected
    const contextVersionAtStart = contextVersionRef.current;
    const currentTaskId = agent.taskId;
    const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";

    const unsubscribe = subscribeSse(
      `/api/tasks/${encodeURIComponent(currentTaskId)}/logs/stream${query}`,
      {
        events: {
          "agent:log": (e) => {
            if (contextVersionRef.current !== contextVersionAtStart) return;
            try {
              const entry: AgentLogEntry = JSON.parse(e.data);
              setLogs(prev => [...prev, entry]);
            } catch {
              // Ignore parse errors
            }
          },
        },
        onOpen: () => {
          if (contextVersionRef.current === contextVersionAtStart) {
            setIsStreaming(true);
          }
        },
        onError: () => {
          if (contextVersionRef.current === contextVersionAtStart) {
            setIsStreaming(false);
          }
        },
      },
    );

    return () => {
      unsubscribe();
      if (contextVersionRef.current === contextVersionAtStart) {
        setIsStreaming(false);
      }
    };
  }, [agent?.taskId, activeTab, projectId]);

  const handleStateChange = async (newState: AgentState) => {
    if (isTransitioning || !agentRef.current) return;

    const previousState = agentRef.current.state;
    if (previousState === newState) return;

    setIsTransitioning(true);
    setAgent((prev) => (prev ? { ...prev, state: newState } : prev));

    try {
      await updateAgentState(agentId, newState, projectId);
      addToast(t("agents.stateUpdated", "Agent state updated to {{newState}}", { newState }), "success");
      await handleSavedMutation();
    } catch (err) {
      setAgent((prev) => (prev ? { ...prev, state: previousState } : prev));
      addToast(t("agents.stateUpdateFailed", "Failed to update state: {{error}}", { error: getErrorMessage(err) }), "error");
    } finally {
      setIsTransitioning(false);
    }
  };

  const handleBulkStateChange = async (targetState: "paused" | "active") => {
    if (isBulkActionRunning) return;
    setIsBulkMenuOpen(false);
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
        addToast(t("agents.bulkNoEligible", "No agents eligible to {{action}}", { action: targetState === "paused" ? t("agents.pause", "pause") : t("agents.resume", "resume") }), "error");
        return;
      }

      const confirmed = await confirm({
        title: targetState === "paused" ? t("agents.pauseAllTitle", "Pause All Agents") : t("agents.resumeAllTitle", "Resume All Agents"),
        message: t("agents.bulkConfirmMessage", "{{action}} {{count}} agent(s) in this project?", { action: targetState === "paused" ? t("agents.pauseAction", "Pause") : t("agents.resumeAction", "Resume"), count: eligibleAgents.length }),
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
      const actionWord = targetState === "paused" ? t("agents.pausedPast", "Paused") : t("agents.resumedPast", "Resumed");
      const agentWord = successCount === 1 ? t("agents.agentSingular", "agent") : t("agents.agentPlural", "agents");
      const baseSummary = t(successCount === 1 ? "agents.bulkResult_one" : "agents.bulkResult_other", "{{action}} {{successCount}} {{agentWord}}; skipped {{skippedCount}}", { action: actionWord, successCount, agentWord, skippedCount });

      if (failureCount > 0) {
        const failureSummary = failedResults
          .slice(0, 3)
          .map(({ agent, result }) => `${agent.name || agent.id}: ${getErrorMessage(result.reason)}`)
          .join("; ");
        addToast(t("agents.bulkResultWithFailures", "{{summary}}; failed {{failureCount}}{{detail}}", { summary: baseSummary, failureCount, detail: failureSummary ? ` (${failureSummary})` : "" }), "error");
      } else {
        addToast(baseSummary, "success");
      }

      await handleSavedMutation();
    } catch (err) {
      addToast(t("agents.bulkActionFailed", "Failed to {{action}} agents: {{error}}", { action: targetState === "paused" ? t("agents.pause", "pause") : t("agents.resume", "resume"), error: getErrorMessage(err) }), "error");
    } finally {
      setIsBulkActionRunning(false);
    }
  };

  const handleRunHeartbeat = async () => {
    if (isStartingRun) return;
    setIsStartingRun(true);
    try {
      await startAgentRun(agentId, projectId, { source: "on_demand", triggerDetail: "Triggered from dashboard" });
      addToast(t("agents.heartbeatStarted", "Heartbeat run started for {{name}}", { name: agent?.name ?? agentId }), "success");
      setRunNowRefreshToken((prev) => prev + 1);
    } catch (err) {
      addToast(t("agents.heartbeatStartFailed", "Failed to start heartbeat run: {{error}}", { error: getErrorMessage(err) }), "error");
    } finally {
      setIsStartingRun(false);
    }
  };

  const handleDelete = async () => {
    if (!agent) return;
    const shouldDelete = await confirm({
      title: t("agents.deleteTitle", "Delete Agent"),
      message: t("agents.deleteConfirm", "Delete agent \"{{name}}\"? This cannot be undone.", { name: agent.name }),
      danger: true,
    });
    if (!shouldDelete) return;
    try {
      await deleteAgent(agentId, projectId);
      addToast(t("agents.deleted", "Agent \"{{name}}\" deleted", { name: agent.name }), "success");
      await notifyMutationSuccess(true);
      onClose();
    } catch (err) {
      addToast(t("agents.deleteFailed", "Failed to delete agent: {{error}}", { error: getErrorMessage(err) }), "error");
    }
  };

  // Use centralized health status utility for consistent labels across all views
  const getHealthStatus = (): AgentHealthStatus => {
    if (!agent) {
      return {
        label: "Unknown",
        icon: <Bot size={14} />,
        color: "var(--text-muted)",
        stateDerived: false,
      };
    }

    return getAgentHealthStatus(agent);
  };

  const copyAgentId = () => {
    if (agent) {
      navigator.clipboard.writeText(agent.id);
      addToast(t("agents.idCopied", "Agent ID copied to clipboard"), "success");
    }
  };

  if (isLoading) {
    if (inline) {
      return (
        <div className="agent-detail-inline-loading" role="region" aria-label={t("agents.detailLoadingLabel", "Agent detail loading")}>
          <div className="agent-detail-loading">
            <Loader2 className="animate-spin" size={24} />
            <span>{t("agents.loading", "Loading agent...")}</span>
          </div>
        </div>
      );
    }

    return (
      <div
        className="agent-detail-overlay"
        onMouseDown={(e) => { if (e.target === e.currentTarget) overlayMouseDownRef.current = true; }}
        onMouseUp={(e) => {
          if (overlayMouseDownRef.current && e.target === e.currentTarget) onClose();
          overlayMouseDownRef.current = false;
        }}
        role="dialog"
        aria-modal="true"
      >
        <div className="agent-detail-modal" ref={agentDetailModalRef}>
          <div className="agent-detail-loading">
            <Loader2 className="animate-spin" size={24} />
            <span>{t("agents.loading", "Loading agent...")}</span>
          </div>
        </div>
      </div>
    );
  }

  if (!agent) {
    return null;
  }

  const stateStyle = STATE_COLORS[agent.state];
  const health = getHealthStatus();
  const detailShellClassName = inline ? "agent-detail-inline" : "agent-detail-modal";
  const isPauseAllDisabled = isBulkEligibilityLoading || bulkPauseEligibleCount === 0;
  const isResumeAllDisabled = isBulkEligibilityLoading || bulkResumeEligibleCount === 0;

  return (
    <div
      className={inline ? "agent-detail-inline-shell" : "agent-detail-overlay"}
      onClick={(e) => !inline && e.target === e.currentTarget && onClose()}
      role={inline ? "region" : "dialog"}
      aria-label={inline ? "Agent detail" : undefined}
      aria-modal={inline ? undefined : "true"}
    >
      <div className={detailShellClassName} ref={agentDetailModalRef}>
        {/* Header */}
        <div className="agent-detail-header">
          {/* Identity area: icon + name + badges */}
          <div className="agent-detail-identity">
            {inline && showInlineBackButton ? (
              <button
                type="button"
                className="btn agent-detail-inline-back"
                onClick={onClose}
                aria-label={t("agents.backToAgents", "Back to agents")}
              >
                <ChevronLeft size={16} />
                {t("agents.agentsLabel", "Agents")}
              </button>
            ) : null}
            <div className="agent-detail-icon">
              <AgentAvatar agent={agent} size={36} />
            </div>
            <div className="agent-detail-info">
              <h2>{agent.name}</h2>
              <div className="agent-detail-badges">
                <span 
                  className="badge"
                  style={{ background: stateStyle.bg, color: stateStyle.text, border: `1px solid ${stateStyle.border}` }}
                >
                  {agent.state}
                </span>
                <span className="badge" style={{ color: health.color }} title={health.reason ?? health.label}>
                  {health.icon}
                  {!health.stateDerived && health.label}
                </span>
              </div>
            </div>
          </div>

          <div className="agent-detail-header-actions">
            {/* Lifecycle controls: compact action buttons */}
            <div className="agent-detail-controls">
              {/* State-dependent action buttons */}
              {agent.state === "idle" && (
                <>
                  <button className="btn btn-task-create btn--compact" onClick={() => void handleStateChange("active")} disabled={isTransitioning}>
                    <Play size={14} />
                    {t("agents.start", "Start")}
                  </button>
                  <button
                    className="btn btn-task-create btn--compact"
                    onClick={() => void handleRunHeartbeat()}
                    aria-label={t("agents.runNowFor", "Run now for {{name}}", { name: agent.name })}
                    disabled={isStartingRun || isTransitioning}
                  >
                    <Activity size={14} />
                    {t("agents.runNow", "Run Now")}
                  </button>
                  <button className="btn btn--danger btn--compact" onClick={handleDelete}>
                    <Trash2 size={14} />
                    {t("agents.delete", "Delete")}
                  </button>
                </>
              )}
              {agent.state === "active" && (
                <>
                  <button className="btn btn--compact agent-detail-mobile-icon-control" onClick={() => void handleStateChange("paused")} disabled={isTransitioning} aria-label={t("agents.pause", "Pause")}>
                    <Pause size={14} />
                    <span className="agent-detail-control-label">{t("agents.pause", "Pause")}</span>
                  </button>
                  <button className="btn btn--danger btn--compact agent-detail-mobile-icon-control" onClick={() => void handleStateChange("paused")} disabled={isTransitioning} aria-label={t("agents.stop", "Stop")}>
                    <Square size={14} />
                    <span className="agent-detail-control-label">{t("agents.stop", "Stop")}</span>
                  </button>
                  <button
                    className="btn btn-task-create btn--compact agent-detail-mobile-icon-control"
                    onClick={() => void handleRunHeartbeat()}
                    aria-label={t("agents.runNowFor", "Run now for {{name}}", { name: agent.name })}
                    disabled={isStartingRun || isTransitioning}
                  >
                    <Activity size={14} />
                    <span className="agent-detail-control-label">{t("agents.runNow", "Run Now")}</span>
                  </button>
                </>
              )}
              {agent.state === "paused" && (
                <>
                  <button className="btn btn-task-create btn--compact agent-detail-mobile-icon-control" onClick={() => void handleStateChange("active")} disabled={isTransitioning} aria-label={t("agents.resume", "Resume")}>
                    <Play size={14} />
                    <span className="agent-detail-control-label">{t("agents.resume", "Resume")}</span>
                  </button>
                  <button className="btn btn--danger btn--compact" onClick={handleDelete}>
                    <Trash2 size={14} />
                    {t("agents.delete", "Delete")}
                  </button>
                </>
              )}
              {agent.state === "running" && (
                <>
                  <button className="btn btn--compact agent-detail-mobile-icon-control" onClick={() => void handleStateChange("paused")} disabled={isTransitioning} aria-label={t("agents.pause", "Pause")}>
                    <Pause size={14} />
                    <span className="agent-detail-control-label">{t("agents.pause", "Pause")}</span>
                  </button>
                  <button className="btn btn--danger btn--compact agent-detail-mobile-icon-control" onClick={() => void handleStateChange("paused")} disabled={isTransitioning} aria-label={t("agents.stop", "Stop")}>
                    <Square size={14} />
                    <span className="agent-detail-control-label">{t("agents.stop", "Stop")}</span>
                  </button>
                </>
              )}
              {agent.state === "error" && (
                <>
                  <button className="btn btn-task-create btn--compact" onClick={() => void handleStateChange("active")} disabled={isTransitioning}>
                    <Play size={14} />
                    {t("agents.retry", "Retry")}
                  </button>
                  <button className="btn btn--danger btn--compact agent-detail-mobile-icon-control" onClick={() => void handleStateChange("paused")} disabled={isTransitioning} aria-label={t("agents.stop", "Stop")}>
                    <Square size={14} />
                    <span className="agent-detail-control-label">{t("agents.stop", "Stop")}</span>
                  </button>
                  <button className="btn btn--danger btn--compact agent-detail-mobile-icon-control" onClick={handleDelete} aria-label={t("agents.delete", "Delete")}>
                    <Trash2 size={14} />
                    <span className="agent-detail-control-label">{t("agents.delete", "Delete")}</span>
                  </button>
                </>
              )}
            </div>

            {/* Utility actions: refresh + close */}
            <div className="agent-detail-utility-actions">
              <div className="agent-detail-bulk-menu" ref={bulkMenuRef}>
                <button
                  type="button"
                  className="btn-icon"
                  onClick={() => setIsBulkMenuOpen((open) => !open)}
                  aria-haspopup="menu"
                  aria-expanded={isBulkMenuOpen}
                  aria-label={t("agents.bulkActions", "Bulk agent actions")}
                  title={t("agents.bulkActions", "Bulk agent actions")}
                  disabled={isTransitioning || isBulkActionRunning}
                >
                  <MoreVertical size={16} />
                </button>
                {isBulkMenuOpen && (
                  <div className="agent-detail-bulk-menu-popover" role="menu">
                    <button
                      type="button"
                      role="menuitem"
                      className="agent-detail-bulk-menu-item"
                      onClick={() => void handleBulkStateChange("paused")}
                      disabled={isPauseAllDisabled || isBulkActionRunning}
                    >
                      {t("agents.pauseAll", "Pause All Agents")}
                      <span className="agent-detail-bulk-menu-item-hint">
                        {isBulkEligibilityLoading
                          ? t("agents.loadingEligible", "Loading eligible agents...")
                          : isPauseAllDisabled
                            ? t("agents.noActiveEligible", "No active agents eligible")
                            : t(bulkPauseEligibleCount === 1 ? "agents.pauseCountHint_one" : "agents.pauseCountHint_other", bulkPauseEligibleCount === 1 ? "Pause {{count}} active/running agent" : "Pause {{count}} active/running agents", { count: bulkPauseEligibleCount })}
                      </span>
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      className="agent-detail-bulk-menu-item"
                      onClick={() => void handleBulkStateChange("active")}
                      disabled={isResumeAllDisabled || isBulkActionRunning}
                    >
                      {t("agents.resumeAll", "Resume All Agents")}
                      <span className="agent-detail-bulk-menu-item-hint">
                        {isBulkEligibilityLoading
                          ? t("agents.loadingEligible", "Loading eligible agents...")
                          : isResumeAllDisabled
                            ? t("agents.noPausedEligible", "No paused agents eligible")
                            : t(bulkResumeEligibleCount === 1 ? "agents.resumeCountHint_one" : "agents.resumeCountHint_other", bulkResumeEligibleCount === 1 ? "Resume {{count}} paused agent" : "Resume {{count}} paused agents", { count: bulkResumeEligibleCount })}
                      </span>
                    </button>
                  </div>
                )}
              </div>
              <button className="btn-icon" onClick={() => void loadAgent()} title={t("common.refresh", "Refresh")} aria-label={t("common.refresh", "Refresh")}>
                <RefreshCw size={16} />
              </button>
              {!inline && (
                <button className="btn-icon" onClick={onClose} aria-label={t("common.close", "Close")} title={t("common.close", "Close")}>
                  <X size={20} />
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Tabs */}
        <div className="agent-detail-tabs">
          {TABS.map(tab => {
            const tabLabels: Record<TabId, string> = {
              dashboard: t("agents.tabDashboard", "Dashboard"),
              logs: t("agents.tabLogs", "Logs"),
              mail: t("agents.tabMail", "Mail"),
              runs: t("agents.tabRuns", "Runs"),
              tasks: t("agents.tabTasks", "Tasks"),
              employees: t("agents.tabEmployees", "Employees"),
              soul: t("agents.tabSoul", "Soul"),
              instructions: t("agents.tabInstructions", "Instructions"),
              memory: t("agents.tabMemory", "Agent Memory"),
              reflections: t("agents.tabReflections", "Evaluation"),
              config: t("agents.tabConfig", "Settings"),
            };
            return (
              <button
                key={tab.id}
                className={cn("agent-detail-tab", activeTab === tab.id && "active")}
                onClick={() => setActiveTab(tab.id)}
              >
                <tab.icon size={16} />
                {tabLabels[tab.id]}
              </button>
            );
          })}
        </div>

        {/* Tab Content */}
        <div className="agent-detail-content">
          {activeTab === "dashboard" && (
            <DashboardTab
              agent={agent}
              health={health}
              onChildClick={onChildClick}
              projectId={projectId}
            />
          )}
          
          {activeTab === "logs" && (
            <LogsTab
              logs={logs}
              isStreaming={isStreaming}
              hasTask={!!agent.taskId || logs.length > 0 || latestRun !== null}
              fallbackLabel={!agent.taskId && latestRun ? t("agents.latestRunLabel", "Latest run · {{id}}", { id: latestRun.id.slice(0, 8) }) : null}
            />
          )}

          {activeTab === "mail" && (
            <MailTab
              agent={agent}
              mailbox={agentMailbox}
              isLoading={isLoadingMailbox}
              error={mailboxError}
              projectId={projectId}
              addToast={addToast}
              onRefresh={() => void loadMailbox()}
            />
          )}
          
          {activeTab === "runs" && (
            <RunsTab 
              addToast={addToast}
              agentId={agent.id}
              projectId={projectId}
              agentState={agent.state}
              agentName={agent.name}
              initialRunId={initialRunId}
              preferActiveRun={preferActiveRun}
              runNowRefreshToken={runNowRefreshToken}
              isEphemeral={isEphemeralAgent(agent)}
            />
          )}

          {activeTab === "tasks" && (
            <TasksTab
              agentId={agent.id}
              projectId={projectId}
              addToast={addToast}
            />
          )}
          
          {activeTab === "employees" && (
            <EmployeesTab
              agentId={agent.id}
              projectId={projectId}
              onChildClick={onChildClick}
            />
          )}

          {activeTab === "soul" && (
            <SoulTab
              agent={agent}
              projectId={projectId}
              addToast={addToast}
              onSaved={handleSavedMutation}
            />
          )}

          {activeTab === "instructions" && (
            <InstructionsTab
              agent={agent}
              projectId={projectId}
              addToast={addToast}
              onSaved={handleSavedMutation}
            />
          )}

          {activeTab === "memory" && (
            <MemoryTab
              agent={agent}
              projectId={projectId}
              addToast={addToast}
              onSaved={handleSavedMutation}
            />
          )}

          {activeTab === "reflections" && (
            <AgentReflectionsTab
              agentId={agent.id}
              projectId={projectId}
              addToast={addToast}
            />
          )}

          {activeTab === "config" && (
            <ConfigTab
              key={agent.id}
              agent={agent}
              projectId={projectId}
              addToast={addToast}
              onSaved={handleSavedMutation}
              onHasChangesChange={handleConfigChangesState}
              onDelete={handleDelete}
              onAgentDraftApplied={(updates) => {
                setAgent((current) => (current ? { ...current, ...updates } : current));
              }}
            />
          )}
        </div>

        {/* Footer with agent ID */}
        {!inline && (
          <div className="agent-detail-footer">
            <button className="btn-icon" onClick={copyAgentId} title={t("agents.copyId", "Copy Agent ID")}>
              <Copy />
            </button>
            <span className="agent-detail-id" onClick={copyAgentId}>
              {agent.id}
            </span>
            {agent.taskId && (
              <>
                <span className="divider">|</span>
                <span className="text-muted">{t("agents.workingOn", "Working on:")}</span>
                <a href={`/tasks/${agent.taskId}`} className="link">
                  <AgentTaskBadge taskId={agent.taskId} taskColumn={agent.taskColumn} />
                  <ExternalLink size={12} />
                </a>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Dashboard Tab ───────────────────────────────────────────────────────────

function DashboardTab({
  agent,
  health,
  onChildClick,
  projectId,
}: {
  agent: AgentDetail;
  health: AgentHealthStatus;
  onChildClick?: (childId: string) => void;
  projectId?: string;
}) {
  const { t } = useTranslation("app");
  const stateStyle = STATE_COLORS[agent.state];
  const [chainOfCommand, setChainOfCommand] = useState<Agent[]>([]);
  const [isLoadingChainOfCommand, setIsLoadingChainOfCommand] = useState(true);
  const [budgetStatus, setBudgetStatus] = useState<AgentBudgetStatus | null>(null);
  const [availableRuntimes, setAvailableRuntimes] = useState<PluginRuntimeInfo[]>([]);
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const [selectedSkillContent, setSelectedSkillContent] = useState<SkillContent | null>(null);
  const [isLoadingSkillContent, setIsLoadingSkillContent] = useState(false);
  const [skillContentError, setSkillContentError] = useState<string | null>(null);

  const runtimeHint = typeof agent.runtimeConfig?.runtimeHint === "string"
    ? agent.runtimeConfig.runtimeHint
    : "";

  const modelDisplay = (() => {
    const rc = agent.runtimeConfig ?? {};
    if (runtimeHint) {
      const selectedRuntime = availableRuntimes.find((runtime) => runtime.runtimeId === runtimeHint);
      return selectedRuntime ? selectedRuntime.name : runtimeHint;
    }
    if (rc.modelProvider && rc.modelId) {
      return `${rc.modelProvider}/${rc.modelId}`;
    }
    if (typeof rc.model === "string" && rc.model.includes("/")) {
      const slashIdx = rc.model.indexOf("/");
      return rc.model.slice(slashIdx + 1);
    }
    return null;
  })();

  // Fetch budget status on mount
  useEffect(() => {
    fetchAgentBudgetStatus(agent.id, projectId)
      .then(setBudgetStatus)
      .catch(() => setBudgetStatus(null));
  }, [agent.id, projectId]);

  useEffect(() => {
    fetchPluginRuntimes(projectId)
      .then(setAvailableRuntimes)
      .catch(() => setAvailableRuntimes([]));
  }, [projectId]);

  useEffect(() => {
    let cancelled = false;
    setIsLoadingChainOfCommand(true);

    void fetchChainOfCommand(agent.id, projectId)
      .then((chain) => {
        if (cancelled) return;
        const normalized = chain.length > 0 && chain[0]?.id === agent.id
          ? [...chain].reverse()
          : chain;
        setChainOfCommand(normalized);
      })
      .catch(() => {
        if (!cancelled) {
          setChainOfCommand([]);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoadingChainOfCommand(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [agent.id, projectId]);

  const stats = useMemo(() => {
    const runs = agent.completedRuns || [];
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const todayRuns = runs.filter((r: AgentHeartbeatRun) => 
      new Date(r.startedAt) >= today
    );
    
    const successfulRuns = runs.filter((r: AgentHeartbeatRun) => 
      r.status === "completed"
    );
    
    return {
      totalRuns: runs.length,
      todayRuns: todayRuns.length,
      successfulRuns: successfulRuns.length,
      successRate: runs.length > 0 
        ? Math.round((successfulRuns.length / runs.length) * 100) 
        : 0,
    };
  }, [agent]);

  const recentRuns = (agent.completedRuns || []).slice(0, 5);
  const agentSkills = Array.isArray(agent.metadata?.skills) ? (agent.metadata.skills as string[]) : [];
  const selectedSkillLabel = selectedSkillId ? formatAgentSkillBadgeLabel(selectedSkillId) : null;
  const loadSkillContent = useCallback(async (skillId: string) => {
    setIsLoadingSkillContent(true);
    setSkillContentError(null);
    setSelectedSkillContent(null);

    try {
      const content = await fetchSkillContent(skillId, projectId);
      setSelectedSkillContent(content);
    } catch (err) {
      setSkillContentError(getErrorMessage(err));
    } finally {
      setIsLoadingSkillContent(false);
    }
  }, [projectId]);

  const handleSkillBadgeClick = useCallback((skillId: string) => {
    if (selectedSkillId === skillId) {
      setSelectedSkillId(null);
      setSelectedSkillContent(null);
      setSkillContentError(null);
      setIsLoadingSkillContent(false);
      return;
    }

    setSelectedSkillId(skillId);
    void loadSkillContent(skillId);
  }, [loadSkillContent, selectedSkillId]);

  const isTicking = agent.state === "active" || agent.state === "running";
  const heartbeatIntervalMs = resolveHeartbeatIntervalMs(agent.runtimeConfig?.heartbeatIntervalMs);
  const nextHeartbeatAt = isTicking && agent.lastHeartbeatAt
    ? new Date(new Date(agent.lastHeartbeatAt).getTime() + heartbeatIntervalMs).toISOString()
    : null;

  return (
    <div className="dashboard-tab dashboard-summary-layout">
      {budgetStatus?.isOverBudget && (
        <div className="budget-warning-banner" role="alert">
          <span>{WARNING_ICON}</span>
          <span><strong>{t("agents.budgetExhaustedTitle", "Budget Exhausted:")}</strong> {t("agents.budgetExhaustedBody", "This agent has exceeded its token budget and may operate with limited functionality.")}</span>
        </div>
      )}

      <section className="dashboard-summary-card dashboard-summary-hero">
        <div className="dashboard-summary-hero__heading">
          <Bot />
          <h3>{t("agents.overview", "Overview")}</h3>
          <strong>{agent.name}</strong>
          <span className="inline-badge" style={{ background: stateStyle.bg, color: stateStyle.text }}>{agent.state}</span>
        </div>
        <div className="dashboard-summary-hero__meta">
          <span className="dashboard-summary-hero__health" title={health.reason ?? health.label}>{health.icon} {health.label}</span>
          {(agent.pendingApprovalCount ?? 0) > 0 ? (
            <span className="badge agent-detail-approval-badge" title={t("agents.pendingApprovals", "Pending approvals")}>
              <span className="status-dot status-dot--pending" />
              {t("agents.pendingApprovalsCount", "{{count}} pending approvals", { count: agent.pendingApprovalCount })}
            </span>
          ) : null}
          <span>{t("agents.roleLabel", "Role: {{role}}", { role: agent.role })}</span>
          <span>
            <span className="dashboard-summary-label">{runtimeHint ? t("agents.runtime", "Runtime") : t("agents.model", "Model")}</span>
            <span> {modelDisplay ?? t("agents.auto", "Auto")}</span>
          </span>
          {agentSkills.length > 0 ? (
            <span className="dashboard-summary-skills">
              <span className="dashboard-summary-label">{t("agents.skills", "Skills")}</span>
              <span className="dashboard-summary-skill-badges" role="list" aria-label={t("agents.assignedSkills", "Assigned skills")}>
                {agentSkills.map((skillId) => {
                  const isSelected = selectedSkillId === skillId;
                  return (
                    <button
                      key={skillId}
                      type="button"
                      className={cn("badge", "badge-skill", "dashboard-summary-skill-badge", "dashboard-summary-skill-badge-btn", isSelected && "dashboard-summary-skill-badge--selected")}
                      title={skillId}
                      onClick={() => handleSkillBadgeClick(skillId)}
                      aria-expanded={isSelected}
                      aria-label={t("agents.viewSkillDetails", "View details for {{skill}}", { skill: formatAgentSkillBadgeLabel(skillId) })}
                    >
                      {formatAgentSkillBadgeLabel(skillId)}
                    </button>
                  );
                })}
              </span>
            </span>
          ) : (
            <span>{t("agents.skillsNone", "Skills: —")}</span>
          )}
        </div>
        {selectedSkillId ? (
          <div className="dashboard-summary-skill-detail" data-testid="agent-skill-detail">
            <div className="dashboard-summary-skill-detail-header">
              <span className="dashboard-summary-skill-detail-title">{selectedSkillLabel}</span>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => handleSkillBadgeClick(selectedSkillId)}
              >
                <X size={14} />
                {t("common.close", "Close")}
              </button>
            </div>
            {isLoadingSkillContent ? (
              <div className="dashboard-summary-skill-detail-loading" role="status" aria-live="polite">
                <Loader2 size={14} className="animate-spin" />
                {t("agents.loadingSkillContent", "Loading skill content...")}
              </div>
            ) : skillContentError ? (
              <div className="dashboard-summary-skill-detail-error" role="alert">
                <AlertCircle size={14} />
                <span>{skillContentError}</span>
                <button type="button" className="btn btn-sm" onClick={() => void loadSkillContent(selectedSkillId)}>
                  {t("common.retry", "Retry")}
                </button>
              </div>
            ) : selectedSkillContent ? (
              <pre className="dashboard-summary-skill-detail-content">{selectedSkillContent.skillMd || t("agents.noSkillMd", "(No SKILL.md found)")}</pre>
            ) : (
              <div className="dashboard-summary-skill-detail-empty">{t("agents.noSkillContent", "No skill content available")}</div>
            )}
          </div>
        ) : null}
      </section>

      <section className="dashboard-summary-card">
        <h3>{t("agents.heartbeatAndHealth", "Heartbeat & Health")}</h3>
        <div className="dashboard-summary-grid">
          <div>
            <p className="dashboard-summary-label">{t("agents.lastHeartbeat", "Last heartbeat")}</p>
            <p>{agent.lastHeartbeatAt ? relativeTime(agent.lastHeartbeatAt, t) : t("agents.never", "Never")}</p>
          </div>
          <div>
            <p className="dashboard-summary-label">{t("agents.nextExpected", "Next expected")}</p>
            <p>{nextHeartbeatAt ? relativeTime(nextHeartbeatAt, t) : t("agents.notScheduled", "Not scheduled")}</p>
          </div>
          <div>
            <p className="dashboard-summary-label">{t("agents.interval", "Interval")}</p>
            <p>{formatHeartbeatInterval(heartbeatIntervalMs)}</p>
          </div>
          <div>
            <p className="dashboard-summary-label">{t("agents.status", "Status")}</p>
            <p className="dashboard-summary-health-row"><span className={cn("status-dot", agent.state === "running" && "status-dot--running")} />{health.label}{health.reason && <span className="text-secondary dashboard-summary-health-reason" title={health.reason}>({health.reason})</span>}</p>
          </div>
        </div>
      </section>

      <section className="dashboard-summary-card">
        <h3>{t("agents.currentWork", "Current Work")}</h3>
        {agent.taskId ? (
          <div className="current-task">
            <a href={`/tasks/${agent.taskId}`} className="task-badge"><AgentTaskBadge taskId={agent.taskId} taskColumn={agent.taskColumn} /></a>
            <a href={`/tasks/${agent.taskId}`} className="btn btn-sm">{t("agents.viewTask", "View Task")} <ExternalLink size={14} /></a>
          </div>
        ) : (
          <p className="text-muted">{t("agents.noActiveAssignment", "No active assignment")}</p>
        )}
      </section>

      <section className="dashboard-summary-card">
        <h3>{t("agents.recentRuns", "Recent Runs")}</h3>
        <p className="dashboard-summary-label">{t("agents.runsSuccessRate", "{{successful}}/{{total}} successful ({{rate}}%)", { successful: stats.successfulRuns, total: stats.totalRuns, rate: stats.successRate })}</p>
        {recentRuns.length === 0 ? (
          <p className="text-muted">{t("agents.noRunsYet", "No runs yet")}</p>
        ) : (
          <div className="runs-list">
            {recentRuns.map((run) => {
              const statusSpec = RUN_STATUS_ICONS[run.status] || RUN_STATUS_ICONS.terminated;
              const StatusIcon = statusSpec.icon;
              return (
                <div key={run.id} className="run-item">
                  <StatusIcon size={14} style={{ color: statusSpec.color }} />
                  <span>{relativeTime(run.startedAt, t)}</span>
                  <span className="text-muted">{Math.max(0, Math.round((new Date(run.endedAt || run.startedAt).getTime() - new Date(run.startedAt).getTime()) / 1000))}s</span>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="dashboard-summary-card">
        <h3>{t("agents.throughput", "Throughput")}</h3>
        <div className="stats-grid">
          <div className="stat-card"><div className="stat-value">{stats.totalRuns}</div><div className="stat-label">{t("agents.totalRuns", "Total Runs")}</div></div>
          <div className="stat-card"><div className="stat-value">{stats.todayRuns}</div><div className="stat-label">{t("agents.runsToday", "Runs Today")}</div></div>
          <div className="stat-card"><div className="stat-value">{stats.successRate}%</div><div className="stat-label">{t("agents.successRate", "Success Rate")}</div></div>
        </div>
      </section>

      <section className="dashboard-summary-card">
        <h3>{t("agents.chainOfCommand", "Chain of Command")}</h3>
        {isLoadingChainOfCommand ? (
          <div className="chain-of-command-loading" role="status" aria-live="polite"><Loader2 size={14} className="animate-spin" /><span>{t("agents.loadingReportingChain", "Loading reporting chain...")}</span></div>
        ) : chainOfCommand.length <= 1 ? (
          <p className="text-muted">{t("agents.noReportingChain", "No reporting chain")}</p>
        ) : (
          <div className="chain-of-command-path" aria-label={t("agents.chainOfCommand", "Chain of command")}>
            {chainOfCommand.map((chainAgent, index) => {
              const isCurrent = index === chainOfCommand.length - 1;
              const isAncestor = !isCurrent;
              return (
                <div key={chainAgent.id} className="chain-of-command-item">
                  <button type="button" className={`chain-of-command-node${isCurrent ? " chain-of-command-node--current" : ""}`} onClick={() => isAncestor && onChildClick?.(chainAgent.id)} disabled={!isAncestor || !onChildClick} title={isCurrent ? t("agents.currentAgent", "Current agent") : t("agents.viewAgent", "View {{name}}", { name: chainAgent.name })}>
                    {chainAgent.name}
                  </button>
                  {!isCurrent && <span className="chain-of-command-separator" aria-hidden="true">→</span>}
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

// ── Logs Tab ──────────────────────────────────────────────────────────────

function LogsTab({
  logs,
  isStreaming,
  hasTask,
  fallbackLabel,
}: {
  logs: AgentLogEntry[];
  isStreaming: boolean;
  hasTask: boolean;
  fallbackLabel?: string | null;
}) {
  const { t } = useTranslation("app");

  if (!hasTask) {
    return (
      <div className="logs-tab">
        <div className="logs-empty">
          <FileText size={48} opacity={0.3} />
          <p>{t("agents.noActivityYet", "No activity yet")}</p>
          <p className="text-muted">
            {t("agents.logsWillAppear", "Agent logs will appear here from the current task or most recent run")}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="logs-tab">
      <div className="logs-header">
        <span className="logs-count">{t("agents.logEntries", "{{count}} entries", { count: logs.length })}</span>
        {fallbackLabel && (
          <span className="text-muted logs-fallback-label">{fallbackLabel}</span>
        )}
        {isStreaming && (
          <span className="streaming-indicator">
            <span className="streaming-dot" />
            {t("agents.live", "Live")}
          </span>
        )}
      </div>
      {logs.length === 0 ? (
        <div className="logs-empty">
          <FileText size={48} opacity={0.3} />
          <p>{t("agents.noLogEntriesYet", "No log entries yet")}</p>
          <p className="text-muted">
            {isStreaming ? t("agents.waitingForActivity", "Waiting for activity...") : t("agents.logsWillAppearActive", "Logs will appear here when the agent is active")}
          </p>
        </div>
      ) : (
        <AgentLogViewer entries={logs} loading={false} />
      )}
    </div>
  );
}

function formatMailboxTimestamp(ts: string, t?: (key: string, defaultValue: string, options?: Record<string, unknown>) => string): string {
  const date = new Date(ts);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);
  const tr = t ?? ((_key: string, def: string, opts?: Record<string, unknown>) => {
    if (!opts) return def;
    return def.replace(/\{\{(\w+)\}\}/g, (_, k) => String(opts[k] ?? ""));
  });

  if (diffMins < 1) return tr("time.justNow", "just now");
  if (diffMins < 60) return tr("time.minutesAgo", "{{n}}m ago", { n: diffMins });
  if (diffHours < 24) return tr("time.hoursAgo", "{{n}}h ago", { n: diffHours });
  if (diffDays < 7) return tr("time.daysAgo", "{{n}}d ago", { n: diffDays });

  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function mailboxParticipantLabel(
  id: string,
  type: ParticipantType,
  agentNamesById?: ReadonlyMap<string, string>,
  t?: (key: string, defaultValue: string, options?: Record<string, unknown>) => string,
): string {
  const tr = t ?? ((_key: string, def: string, opts?: Record<string, unknown>) => {
    if (!opts) return def;
    return def.replace(/\{\{(\w+)\}\}/g, (_, k) => String(opts[k] ?? ""));
  });
  if (type === "user") return id === "dashboard" ? tr("mailbox.you", "You") : tr("mailbox.userLabel", "User: {{id}}", { id });
  if (type === "agent") {
    const name = agentNamesById?.get(id)?.trim();
    if (!name || name === id) return tr("mailbox.agentById", "Agent: {{id}}", { id });
    return tr("mailbox.agentByName", "Agent: {{name}}", { name });
  }
  return tr("mailbox.system", "System");
}

function MailTab({
  agent,
  mailbox,
  isLoading,
  error,
  projectId,
  addToast,
  onRefresh,
}: {
  agent: AgentDetail;
  mailbox: AgentMailboxResponse | null;
  isLoading: boolean;
  error: string | null;
  projectId?: string;
  addToast?: (message: string, type?: "success" | "error") => void;
  onRefresh: () => void;
}) {
  const { t } = useTranslation("app");
  const [activeSubtab, setActiveSubtab] = useState<"inbox" | "outbox">("inbox");
  const [knownAgents, setKnownAgents] = useState<Agent[]>([]);

  useEffect(() => {
    let cancelled = false;

    fetchAgents(undefined, projectId)
      .then((agents) => {
        if (!cancelled) {
          setKnownAgents(agents);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setKnownAgents([]);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const agentNamesById = useMemo(() => {
    const map = new Map<string, string>();
    for (const knownAgent of knownAgents) {
      if (!knownAgent.id) continue;
      const name = typeof knownAgent.name === "string" ? knownAgent.name.trim() : "";
      if (name.length > 0) {
        map.set(knownAgent.id, name);
      }
    }
    const currentAgentName = typeof agent.name === "string" ? agent.name.trim() : "";
    if (currentAgentName.length > 0) {
      map.set(agent.id, currentAgentName);
    }
    return map;
  }, [knownAgents, agent.id, agent.name]);
  const [selectedMessageId, setSelectedMessageId] = useState<string | null>(null);
  const messages = activeSubtab === "inbox" ? (mailbox?.inbox ?? []) : (mailbox?.outbox ?? []);
  const selectedMessage = selectedMessageId ? messages.find((message) => message.id === selectedMessageId) ?? null : null;

  useEffect(() => {
    setSelectedMessageId(null);
  }, [activeSubtab, agent.id]);

  const handleMessageClick = async (message: Message) => {
    setSelectedMessageId(message.id);

    if (activeSubtab !== "inbox" || message.read) {
      return;
    }

    try {
      await markMessageRead(message.id, projectId);
      onRefresh();
    } catch (err) {
      const errorMessage = `Failed to mark message as read: ${getErrorMessage(err)}`;
      if (addToast) {
        addToast(errorMessage, "error");
      } else {
        console.warn(errorMessage);
      }
    }
  };

  const handleRefresh = () => {
    setSelectedMessageId(null);
    onRefresh();
  };

  const renderMessage = (message: Message) => (
    <button
      key={message.id}
      type="button"
      className={cn("mailbox-item", "agent-mail-tab-message", activeSubtab === "inbox" && !message.read && "unread", selectedMessageId === message.id && "agent-mail-tab-message--selected")}
      onClick={() => void handleMessageClick(message)}
      aria-pressed={selectedMessageId === message.id}
    >
      <div className="mailbox-item-avatar">
        {(activeSubtab === "inbox" ? message.fromType : message.toType) === "agent" ? <Bot size={16} /> : <User size={16} />}
      </div>
      <div className="mailbox-item-content">
        <div className="mailbox-item-header">
          {activeSubtab === "inbox" ? (
            <span className="mailbox-item-from">{mailboxParticipantLabel(message.fromId, message.fromType, agentNamesById, t)}</span>
          ) : (
            <span className="mailbox-item-to">{t("agents.mailTo", "To: {{recipient}}", { recipient: mailboxParticipantLabel(message.toId, message.toType, agentNamesById, t) })}</span>
          )}
          <span className="mailbox-item-time">{formatMailboxTimestamp(message.createdAt, t)}</span>
        </div>
        <div className="mailbox-item-preview">{message.content.slice(0, 80)}{message.content.length > 80 ? "…" : ""}</div>
      </div>
      {activeSubtab === "inbox" && !message.read ? <div className="mailbox-item-unread-dot" aria-label={t("agents.unreadMessage", "Unread message")} /> : null}
    </button>
  );

  return (
    <div className="agent-mail-tab">
      <div className="agent-mail-tab-header">
        <h3>{t("agents.agentMail", "{{name}} Mail", { name: agent.name })}</h3>
        <button className="btn btn-sm" onClick={handleRefresh} disabled={isLoading}>
          <RefreshCw size={14} />
          {t("common.refresh", "Refresh")}
        </button>
      </div>

      <div className="mailbox-agent-subtabs" data-testid="agent-detail-mail-subtabs">
        <button
          className={cn("btn", "btn-sm", "btn-secondary", "mailbox-agent-subtab", activeSubtab === "inbox" && "active")}
          onClick={() => setActiveSubtab("inbox")}
        >
          <InboxIcon size={12} />
          <span>{t("agents.inbox", "Inbox")}</span>
          {(mailbox?.unreadCount ?? 0) > 0 ? <span className="mailbox-tab-badge">{mailbox?.unreadCount}</span> : null}
        </button>
        <button
          className={cn("btn", "btn-sm", "btn-secondary", "mailbox-agent-subtab", activeSubtab === "outbox" && "active")}
          onClick={() => setActiveSubtab("outbox")}
        >
          <Send size={12} />
          <span>{t("agents.outbox", "Outbox")}</span>
        </button>
      </div>

      {isLoading && !mailbox ? (
        <div className="agent-detail-loading agent-detail-loading--inline" role="status" aria-live="polite">
          <Loader2 className="animate-spin" size={16} />
          <span>{t("agents.loadingMailbox", "Loading mailbox...")}</span>
        </div>
      ) : null}

      {!isLoading && error ? (
        <div className="agent-mail-tab-error" role="alert">
          <AlertCircle size={16} />
          <span>{t("agents.mailboxLoadFailed", "Failed to load mailbox: {{error}}", { error })}</span>
        </div>
      ) : null}

      {!isLoading && !error ? (
        selectedMessage ? (
          <div className="agent-mail-tab-detail" data-testid="agent-detail-mail-message">
            <button
              type="button"
              className="btn btn-sm agent-mail-tab-back"
              data-testid="agent-detail-mail-back"
              onClick={() => setSelectedMessageId(null)}
            >
              <ChevronLeft size={14} />
              {activeSubtab === "inbox" ? t("agents.backToInbox", "Back to Inbox") : t("agents.backToOutbox", "Back to Outbox")}
            </button>
            <div className="agent-mail-tab-detail-meta">
              <div className="agent-mail-tab-detail-row">
                <span className="agent-mail-tab-detail-label">{t("agents.mailFrom", "From")}</span>
                <span>{mailboxParticipantLabel(selectedMessage.fromId, selectedMessage.fromType, agentNamesById, t)}</span>
              </div>
              <div className="agent-mail-tab-detail-row">
                <span className="agent-mail-tab-detail-label">{t("agents.mailToLabel", "To")}</span>
                <span>{mailboxParticipantLabel(selectedMessage.toId, selectedMessage.toType, agentNamesById, t)}</span>
              </div>
              <div className="agent-mail-tab-detail-row">
                <span className="agent-mail-tab-detail-label">{t("agents.mailType", "Type")}</span>
                <span>{selectedMessage.type}</span>
              </div>
              <div className="agent-mail-tab-detail-row">
                <span className="agent-mail-tab-detail-label">{t("agents.mailSent", "Sent")}</span>
                <span>{new Date(selectedMessage.createdAt).toLocaleString()}</span>
              </div>
              {selectedMessage.metadata?.replyTo?.messageId ? (
                <div className="agent-mail-tab-reply-context">{t("agents.replyingTo", "↪ Replying to message {{id}}", { id: selectedMessage.metadata.replyTo.messageId })}</div>
              ) : null}
            </div>
            <div className="agent-mail-tab-detail-body">{selectedMessage.content}</div>
          </div>
        ) : (
          <div className="mailbox-list" data-testid="agent-detail-mail-list">
            {messages.length === 0 ? (
              <div className="mailbox-empty" data-testid="agent-detail-mail-empty">
                {activeSubtab === "inbox" ? <InboxIcon size={32} /> : <Send size={32} />}
                <p>{activeSubtab === "inbox" ? t("agents.noInboxMessages", "No received messages for this agent") : t("agents.noOutboxMessages", "No sent messages for this agent")}</p>
              </div>
            ) : (
              messages.map(renderMessage)
            )}
          </div>
        )
      ) : null}
    </div>
  );
}

// ── Runs Tab ───────────────────────────────────────────────────────────────

interface AgentTokenUsageWindowSummary {
  totalInputTokens: number;
  totalCachedTokens: number;
  totalCacheWriteTokens: number;
  totalOutputTokens: number;
  nTasks: number;
  hitRatio: number;
}

interface AgentTokenUsageSummary {
  last24h: AgentTokenUsageWindowSummary;
  last7d: AgentTokenUsageWindowSummary;
  allTime: AgentTokenUsageWindowSummary;
}

function RunsTab({
  addToast,
  agentId,
  projectId,
  agentState,
  agentName,
  initialRunId,
  preferActiveRun,
  runNowRefreshToken,
  isEphemeral,
}: {
  addToast: (msg: string, type?: "success" | "error") => void;
  agentId: string;
  projectId?: string;
  agentState?: AgentState;
  agentName?: string;
  initialRunId?: string | null;
  preferActiveRun?: boolean;
  runNowRefreshToken: number;
  isEphemeral: boolean;
}) {
  const { t } = useTranslation("app");
  const [runs, setRuns] = useState<AgentHeartbeatRun[]>([]);
  const { confirm } = useConfirm();
  const [isLoadingRuns, setIsLoadingRuns] = useState(true);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [runLogs, setRunLogs] = useState<AgentLogEntry[]>([]);
  const [isLoadingLogs, setIsLoadingLogs] = useState(false);
  const [detailRun, setDetailRun] = useState<AgentHeartbeatRun | null>(null);
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);
  const [tokenUsageSummary, setTokenUsageSummary] = useState<AgentTokenUsageSummary | null>(null);
  const [promptSizes, setPromptSizes] = useState<AgentPromptSizePoint[]>([]);
  const hasAutoExpandedInitialRunRef = useRef(false);
  const didMountRunNowRefreshRef = useRef(false);

  // Load runs on mount
  const loadRuns = useCallback(async () => {
    try {
      const data = await fetchAgentRuns(agentId, 50, projectId);
      setRuns(data);
    } catch (err) {
      addToast(`Failed to load runs: ${getErrorMessage(err)}`, "error");
    } finally {
      setIsLoadingRuns(false);
    }
  }, [agentId, projectId, addToast]);

  useEffect(() => {
    void loadRuns();
  }, [loadRuns]);

  useEffect(() => {
    if (isEphemeral) {
      setTokenUsageSummary(null);
      setPromptSizes([]);
      return;
    }

    const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
    void fetch(`/api/agents/${encodeURIComponent(agentId)}/token-usage${query}`)
      .then(async (res) => {
        if (!res.ok) {
          if (res.status === 400) {
            setTokenUsageSummary(null);
            return;
          }
          throw new Error(`Request failed: ${res.status}`);
        }
        const data = (await res.json()) as AgentTokenUsageSummary;
        setTokenUsageSummary(data);
      })
      .catch((err) => {
        addToast(`Failed to load cache hit ratio: ${getErrorMessage(err)}`, "error");
      });

    void fetchAgentPromptSizes(agentId, 7, projectId)
      .then((data) => setPromptSizes(data))
      .catch((err) => {
        const message = getErrorMessage(err).toLowerCase();
        if (message.includes("ephemeral") || message.includes("400")) {
          setPromptSizes([]);
          return;
        }
        addToast(`Failed to load prompt sizes: ${getErrorMessage(err)}`, "error");
      });
  }, [agentId, projectId, addToast, isEphemeral]);

  useEffect(() => {
    if (!didMountRunNowRefreshRef.current) {
      didMountRunNowRefreshRef.current = true;
      return;
    }
    setIsLoadingRuns(true);
    void loadRuns();
  }, [loadRuns, runNowRefreshToken]);

  // Poll for active runs
  const hasActiveRun = runs.some(r => r.status === "active");
  const selectedRunStatus = selectedRunId
    ? runs.find((run) => run.id === selectedRunId)?.status
    : undefined;
  useEffect(() => {
    if (!hasActiveRun) return;
    const interval = setInterval(() => {
      void loadRuns();
    }, 5000);
    return () => clearInterval(interval);
  }, [hasActiveRun, loadRuns]);

  // While a selected run is still active, subscribe to its log stream so the
  // expanded view tails updates without a refresh.  Mirrors the per-task log
  // SSE pattern in useAgentLogs.
  useEffect(() => {
    if (!selectedRunId) return;
    if (selectedRunStatus !== "active") return;

    const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
    return subscribeSse(
      `/api/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(selectedRunId)}/logs/stream${query}`,
      {
        events: {
          "agent:log": (e) => {
            try {
              const entry: AgentLogEntry = JSON.parse(e.data);
              setRunLogs(prev => [...prev, entry]);
            } catch {
              // ignore malformed events
            }
          },
        },
      },
    );
  }, [selectedRunId, selectedRunStatus, agentId, projectId]);

  // Load run detail when a run is selected
  const handleRunClick = useCallback(async (runId: string) => {
    if (selectedRunId === runId) {
      setSelectedRunId(null);
      setRunLogs([]);
      setDetailRun(null);
      return;
    }
    setSelectedRunId(runId);
    setIsLoadingLogs(true);
    setIsLoadingDetail(true);
    setRunLogs([]);
    setDetailRun(null);
    try {
      const [logs, detail] = await Promise.all([
        fetchAgentRunLogs(agentId, runId, projectId),
        fetchAgentRunDetail(agentId, runId, projectId),
      ]);
      setRunLogs(logs);
      setDetailRun(detail);
    } catch (err) {
      addToast(t("agents.runDetailsFailed", "Failed to load run details: {{error}}", { error: getErrorMessage(err) }), "error");
      setRunLogs([]);
      setDetailRun(null);
    } finally {
      setIsLoadingLogs(false);
      setIsLoadingDetail(false);
    }
  }, [selectedRunId, agentId, projectId, addToast]);

  useEffect(() => {
    hasAutoExpandedInitialRunRef.current = false;
  }, [agentId, initialRunId, preferActiveRun]);

  useEffect(() => {
    if (runs.length === 0 || isLoadingRuns || hasAutoExpandedInitialRunRef.current) {
      return;
    }

    const runToExpand = initialRunId
      ? runs.find((run) => run.id === initialRunId)
      : (preferActiveRun ? runs.find((run) => run.status === "active") : null);

    hasAutoExpandedInitialRunRef.current = true;
    if (runToExpand) {
      void handleRunClick(runToExpand.id);
    }
  }, [initialRunId, preferActiveRun, runs, isLoadingRuns, handleRunClick]);

  const handleStopRun = async () => {
    const shouldStop = await confirm({
      title: t("agents.stopRunTitle", "Stop Active Run"),
      message: t("agents.stopRunConfirm", "Stop the active run? The agent's work will be interrupted."),
      danger: true,
    });
    if (!shouldStop) {
      return;
    }

    try {
      await stopAgentRun(agentId, projectId);
      addToast(t("agents.runStopped", "Run stopped"), "success");
      setIsLoadingRuns(true);
      void loadRuns();
    } catch (err) {
      addToast(t("agents.stopRunFailed", "Failed to stop run: {{error}}", { error: getErrorMessage(err) }), "error");
    }
  };

  if (isLoadingRuns && runs.length === 0) {
    return (
      <div className="runs-tab">
        <div className="runs-loading-row">
          <Loader2 size={16} className="animate-spin" />
          <span className="text-muted">{t("agents.loadingRuns", "Loading runs...")}</span>
        </div>
      </div>
    );
  }

  if (runs.length === 0) {
    return (
      <div className="runs-tab">
        <div className="runs-empty">
          <Activity size={48} opacity={0.3} />
          <p>{t("agents.noRunsYet", "No runs yet")}</p>
          <p className="text-muted">{t("agents.heartbeatRunsWillAppear", "Heartbeat runs will appear here")}</p>
        </div>
      </div>
    );
  }

  const sortedRuns = [...runs].sort(
    (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
  );

  const activeRuns = sortedRuns.filter(r => r.status === "active");
  const completedRuns = sortedRuns.filter(r => r.status !== "active");

  const renderUsage = (usage: { inputTokens: number; outputTokens: number; cachedTokens: number; cacheWriteTokens?: number } | undefined) => {
    if (!usage) return null;
    return (
      <div className="run-usage">
        <span>{t("agents.inputTokens", "Input: {{value}}", { value: usage.inputTokens.toLocaleString() })}</span>
        <span>{t("agents.outputTokens", "Output: {{value}}", { value: usage.outputTokens.toLocaleString() })}</span>
        {usage.cachedTokens > 0 && <span>{t("agents.cacheReadTokens", "Cache read: {{value}}", { value: usage.cachedTokens.toLocaleString() })}</span>}
        {(usage.cacheWriteTokens ?? 0) > 0 && <span>{t("agents.cacheWriteTokens", "Cache write: {{value}}", { value: (usage.cacheWriteTokens ?? 0).toLocaleString() })}</span>}
      </div>
    );
  };

  const renderRunCard = (run: AgentHeartbeatRun, index: number, isActive: boolean) => {
    const statusInfo = RUN_STATUS_ICONS[run.status] || RUN_STATUS_ICONS.completed;
    const StatusIcon = statusInfo.icon;
    const duration = run.endedAt
      ? formatDuration(new Date(run.startedAt), new Date(run.endedAt))
      : t("agents.inProgress", "In progress");
    const isSelected = selectedRunId === run.id;

    return (
      <div key={run.id}>
        <div 
          className={cn("run-card", isActive && "run-card--active", isSelected && "run-card--selected", "run-card--clickable")}
          onClick={() => void handleRunClick(run.id)}
          role="button"
          tabIndex={0}
          aria-expanded={isSelected}
          aria-label={t("agents.runAriaLabel", "{{active}}run {{id}}, {{status}}", { active: isActive ? t("agents.activePrefix", "Active ") : "", id: run.id.slice(0, 8), status: run.status })}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              void handleRunClick(run.id);
            }
          }}
        >
          <div className="run-header">
            <div className="run-header-group">
              {isSelected ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              {isActive ? (
                <span className="run-live-indicator">
                  <span className="live-dot" />
                  {t("agents.liveRun", "Live Run")}
                </span>
              ) : (
                <span className="run-id">#{index + 1} {run.id.slice(0, 8)}</span>
              )}
            </div>
            <div className="run-header-group">
              {run.invocationSource && (
                <span className="badge run-badge--compact">
                  {run.invocationSource}
                </span>
              )}
              {isActive && (
                <button
                  className="btn btn--sm btn--danger"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    void handleStopRun();
                  }}
                  aria-label={t("agents.stopActiveRun", "Stop active run")}
                >
                  <Square size={12} /> {t("agents.stop", "Stop")}
                </button>
              )}
              <span className={cn("run-status", run.status)}>
                <StatusIcon size={14} style={{ color: statusInfo.color }} />
                {run.status}
              </span>
              {run.heartbeatProcedureSource === "custom" && (
                <span className="badge run-badge--compact">
                  {t("agents.heartbeatCustom", "Heartbeat: custom")}
                </span>
              )}
            </div>
          </div>
          <div className="run-details">
            <span>{t("agents.runStarted", "Started {{time}}", { time: relativeTime(run.startedAt, t) })}</span>
            <span>•</span>
            <span>{duration}</span>
            {run.triggerDetail && (
              <>
                <span>•</span>
                <span className="text-muted">{run.triggerDetail}</span>
              </>
            )}
          </div>
        </div>
        {isSelected && (
          <div className="run-logs-container">
            {/* Execution Details */}
            {isLoadingDetail ? (
              <div className="run-details-loading-state">
                <Loader2 size={14} className="animate-spin" />
                <span className="text-muted">{t("agents.loadingDetails", "Loading details...")}</span>
              </div>
            ) : detailRun && (
              <div className="run-output-sections">
                {/* System Prompt */}
                <div className="run-output-section">
                  <details>
                    <summary className="run-output-label run-output-summary">{t("agents.systemPrompt", "System Prompt")}</summary>
                    {detailRun.systemPrompt ? (
                      <pre className="run-output-panel">{detailRun.systemPrompt}</pre>
                    ) : (
                      <div className="text-muted run-output-empty">{t("agents.systemPromptNotCaptured", "System prompt not captured for this run")}</div>
                    )}
                  </details>
                </div>

                {/* Execution Prompt */}
                <div className="run-output-section">
                  <details>
                    <summary className="run-output-label run-output-summary">{t("agents.executionPrompt", "Execution Prompt")}</summary>
                    {detailRun.executionPrompt ? (
                      <pre className="run-output-panel">{detailRun.executionPrompt}</pre>
                    ) : (
                      <div className="text-muted run-output-empty">{t("agents.executionPromptNotCaptured", "Execution prompt not captured for this run")}</div>
                    )}
                  </details>
                </div>

                {/* Token Usage */}
                {detailRun.usageJson && (
                  <div className="run-output-section">
                    <div className="run-output-label">{t("agents.tokenUsage", "Token Usage")}</div>
                    {renderUsage(detailRun.usageJson)}
                  </div>
                )}

                {/* Output */}
                {detailRun.stdoutExcerpt && (
                  <div className="run-output-section">
                    <div className="run-output-label">{t("agents.output", "Output")}</div>
                    <pre className="run-output-panel">
                      {detailRun.stdoutExcerpt.length > 2000
                        ? `${detailRun.stdoutExcerpt.slice(0, 2000)}\n\n... (truncated, ${detailRun.stdoutExcerpt.length} chars total)`
                        : detailRun.stdoutExcerpt}
                    </pre>
                  </div>
                )}

                {/* Errors */}
                {detailRun.stderrExcerpt && (
                  <div className="run-output-section">
                    <div className="run-output-label run-output-label--error">{t("agents.errors", "Errors")}</div>
                    <AgentErrorIndicator
                      errorText={detailRun.stderrExcerpt}
                      summaryPrefix="Run error"
                      issueContext={{
                        surface: "AgentDetailView runs",
                        agentId,
                        agentName,
                        agentState,
                        runId: detailRun.id,
                        taskId: undefined,
                        timestamp: detailRun.startedAt,
                      }}
                    />
                  </div>
                )}

                {/* Result */}
                {detailRun.resultJson && (
                  <div className="run-output-section">
                    <div className="run-output-label">{t("agents.result", "Result")}</div>
                    <pre className="run-output-panel">{JSON.stringify(detailRun.resultJson, null, 2)}</pre>
                  </div>
                )}

                {/* Context */}
                {detailRun.contextSnapshot && Object.keys(detailRun.contextSnapshot).length > 0 && (
                  <div className="run-output-section">
                    <div className="run-output-label">{t("agents.context", "Context")}</div>
                    <div className="run-context-grid">
                      {Object.entries(detailRun.contextSnapshot).map(([key, value]) => (
                        <span key={key} className="run-context-item">
                          <span className="text-muted">{key}:</span>{" "}
                          <span>{String(value)}</span>
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {/* No output state */}
                {!detailRun.stdoutExcerpt && !detailRun.stderrExcerpt && !detailRun.resultJson && (
                  <div className="text-muted run-output-empty">{t("agents.noOutputCaptured", "No output captured")}</div>
                )}
              </div>
            )}

            {/* Run Logs */}
            <div className="run-agent-logs-section">
              <div className="run-output-label">{t("agents.agentLogs", "Agent Logs")}</div>
              {isLoadingLogs ? (
                <div className="run-details-loading-state">
                  <Loader2 size={14} className="animate-spin" />
                  <span className="text-muted">{t("agents.loadingLogs", "Loading logs...")}</span>
                </div>
              ) : runLogs.length === 0 ? (
                <div className="text-muted run-output-empty">{t("agents.noLogsForRun", "No logs available for this run")}</div>
              ) : (
                <AgentLogViewer entries={runLogs} loading={false} />
              )}
            </div>
          </div>
        )}
      </div>
    );
  };

  const renderCacheWindow = (label: string, window: AgentTokenUsageWindowSummary) => (
    <div className="run-context-item" key={label}>
      <span className="text-muted">{label}:</span>{" "}
      <span>{t("agents.cacheWindowSummary", "{{percent}}% ({{cached}} / {{written}} / {{input}} / {{tasks}})", { percent: (window.hitRatio * 100).toFixed(1), cached: window.totalCachedTokens.toLocaleString(), written: window.totalCacheWriteTokens.toLocaleString(), input: window.totalInputTokens.toLocaleString(), tasks: window.nTasks.toLocaleString() })}</span>
    </div>
  );

  const latestPrompt = promptSizes[0];
  const promptPoints = [...promptSizes].reverse();
  const maxExecChars = Math.max(1, ...promptPoints.map((point) => point.execChars));
  const promptPolyline = promptPoints
    .map((point, index) => {
      const x = promptPoints.length <= 1 ? 0 : (index / (promptPoints.length - 1)) * 100;
      const y = 100 - Math.round((point.execChars / maxExecChars) * 100);
      return `${x},${y}`;
    })
    .join(" ");

  return (
    <div className="runs-tab">
      {promptSizes.length > 0 && latestPrompt && (
        <div className="run-output-section">
          <div className="run-output-label">{t("agents.promptSize", "Prompt Size")}</div>
          <div className="prompt-size-summary">
            <svg className="prompt-size-sparkline" viewBox="0 0 100 100" role="img" aria-label={t("agents.promptSizeChart", "Execution prompt size over last 7 runs")}>
              <polyline className="prompt-size-sparkline-grid" points="0,100 100,100" />
              <polyline className="prompt-size-sparkline-line" points={promptPolyline} />
            </svg>
            <span className="prompt-size-values">
              {latestPrompt.systemChars.toLocaleString()} / {latestPrompt.execChars.toLocaleString()} / {latestPrompt.totalChars.toLocaleString()}
            </span>
          </div>
        </div>
      )}
      {tokenUsageSummary && (
        <div className="run-output-section">
          <div className="run-output-label">{t("agents.cacheHitRatio", "Cache hit ratio")}</div>
          <div className="run-context-grid">
            {renderCacheWindow(t("agents.last24h", "Last 24h"), tokenUsageSummary.last24h)}
            {renderCacheWindow(t("agents.last7d", "Last 7d"), tokenUsageSummary.last7d)}
            {renderCacheWindow(t("agents.allTime", "All time"), tokenUsageSummary.allTime)}
          </div>
        </div>
      )}
      <div className="runs-toolbar runs-toolbar--between">
        <span className="runs-toolbar-meta">
          {t("agents.runsCount", { count: runs.length, defaultValue_one: "{{count}} run", defaultValue_other: "{{count}} runs" })}
          {hasActiveRun && <span className="run-live-indicator run-live-indicator--with-margin"><span className="live-dot" />{t("agents.live", "Live")}</span>}
        </span>
        <div className="run-header-group">
          {hasActiveRun && (
            <button
              className="btn btn--sm btn--danger"
              onClick={() => void handleStopRun()}
              aria-label={t("agents.stopActiveRunFor", "Stop active run for {{name}}", { name: agentName ?? agentId })}
            >
              <Square size={14} /> {t("agents.stopRun", "Stop Run")}
            </button>
          )}
        </div>
      </div>
      {activeRuns.map((run, i) => renderRunCard(run, i, true))}
      {completedRuns.map((run, i) => renderRunCard(run, activeRuns.length + i, false))}
    </div>
  );
}

function formatDuration(start: Date, end: Date): string {
  const diff = Math.floor((end.getTime() - start.getTime()) / 1000);
  
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ${diff % 60}s`;
  return `${Math.floor(diff / 3600)}h ${Math.floor((diff % 3600) / 60)}m`;
}

function truncateTaskLabel(task: Task): string {
  const source = task.title?.trim() || task.description?.trim() || task.id;
  return source.length > 80 ? `${source.slice(0, 77)}...` : source;
}

function TasksTab({
  agentId,
  projectId,
  addToast,
}: {
  agentId: string;
  projectId?: string;
  addToast: (msg: string, type?: "success" | "error") => void;
}) {
  const { t } = useTranslation("app");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);

    void fetchAgentTasks(agentId, projectId)
      .then((assignedTasks) => {
        if (!cancelled) {
          setTasks(assignedTasks);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setTasks([]);
          addToast(t("agents.loadTasksFailed", "Failed to load assigned tasks: {{error}}", { error: getErrorMessage(err) }), "error");
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [agentId, projectId, addToast]);

  if (isLoading) {
    return (
      <div className="agent-tasks-empty">
        <Loader2 size={16} className="animate-spin" />
        <p>{t("agents.loadingTasks", "Loading assigned tasks...")}</p>
      </div>
    );
  }

  if (tasks.length === 0) {
    return (
      <div className="agent-tasks-empty">
        <ListChecks size={18} />
        <p>{t("agents.noTasksAssigned", "No tasks assigned to this agent")}</p>
      </div>
    );
  }

  return (
    <div className="agent-tasks-list">
      {tasks.map((task) => (
        <a key={task.id} className="agent-task-item" href={`/tasks/${task.id}`}>
          <div className="agent-task-row">
            <span className="agent-task-id">{task.id}</span>
            <span className={`agent-task-column column-${task.column}`}>{
              ({
                triage: t("board.triage", "Planning"),
                todo: t("board.todo", "Todo"),
                "in-progress": t("board.inProgress", "In Progress"),
                "in-review": t("board.inReview", "In Review"),
                done: t("board.done", "Done"),
                archived: t("board.archived", "Archived"),
              } as Record<string, string>)[task.column] ?? task.column
            }</span>
          </div>
          <div className="agent-task-title" title={task.title || task.description || task.id}>
            {truncateTaskLabel(task)}
          </div>
          <div className="agent-task-status">
            {task.status ?? "idle"} · {t("agents.taskUpdated", "Updated {{time}}", { time: relativeTime(task.updatedAt, t) })}
          </div>
        </a>
      ))}
    </div>
  );
}

// ── Config Tab ─────────────────────────────────────────────────────────────

/** Shape of a single advanced setting field stored in agent.metadata */
interface AdvancedSettingField {
  key: string;
  label: string;
  type: "text" | "number" | "select";
  placeholder?: string;
  hint?: string;
  options?: Array<{ value: string; label: string }>;
  /** Minimum value for number fields */
  min?: number;
  /** Maximum value for number fields */
  max?: number;
}

/** Well-known advanced setting definitions backed by agent.metadata */
const ADVANCED_SETTINGS: AdvancedSettingField[] = [
  {
    key: "maxRetries",
    label: "Max Retries",
    type: "number",
    placeholder: "3",
    hint: "Maximum number of automatic retries on task failure (0–10, default 3)",
    min: 0,
    max: 10,
  },
  {
    key: "timeoutMs",
    label: "Task Timeout (ms)",
    type: "number",
    placeholder: "600000",
    hint: "Maximum time in ms before a task is considered timed out (minimum 60000ms, default 600000ms)",
    min: 60000,
    max: 86400000,
  },
  {
    key: "logLevel",
    label: "Log Level",
    type: "select",
    hint: "Verbosity of agent log output",
    options: [
      { value: "debug", label: "Debug" },
      { value: "info", label: "Info" },
      { value: "warn", label: "Warning" },
      { value: "error", label: "Error" },
    ],
  },
];

/** Validation errors keyed by setting key */
type ValidationErrors = Record<string, string>;

function validateAdvancedSettings(
  values: Record<string, string>,
): ValidationErrors {
  const errors: ValidationErrors = {};

  for (const field of ADVANCED_SETTINGS) {
    const raw = values[field.key]?.trim();

    // Empty is fine — it means "use default"
    if (!raw) continue;

    if (field.type === "number") {
      const num = Number(raw);
      if (Number.isNaN(num) || !Number.isFinite(num)) {
        errors[field.key] = `"${field.label}" must be a valid number`;
        continue;
      }
      if (field.min !== undefined && num < field.min) {
        errors[field.key] = `"${field.label}" must be at least ${field.min.toLocaleString()}`;
      }
      if (field.max !== undefined && num > field.max) {
        errors[field.key] = `"${field.label}" must be at most ${field.max.toLocaleString()}`;
      }
    }

    if (field.type === "select") {
      const validOptions = field.options?.map((o) => o.value) ?? [];
      if (validOptions.length > 0 && !validOptions.includes(raw)) {
        errors[field.key] = `"${field.label}" must be one of: ${validOptions.join(", ")}`;
      }
    }
  }

  return errors;
}

function SoulTab({
  agent,
  projectId,
  addToast,
  onSaved,
}: {
  agent: AgentDetail;
  projectId?: string;
  addToast: (message: string, type?: "success" | "error") => void;
  onSaved: () => Promise<void>;
}) {
  const { t } = useTranslation("app");
  const [soul, setSoul] = useState(agent.soul ?? "");
  const [isSaving, setIsSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const justSavedTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setSoul(agent.soul ?? "");
    setJustSaved(false);
    setShowPreview(false);
  }, [agent.id, agent.soul]);

  useEffect(() => {
    return () => {
      if (justSavedTimeoutRef.current) {
        clearTimeout(justSavedTimeoutRef.current);
      }
    };
  }, []);

  const hasChanges = soul !== (agent.soul ?? "");

  const handleSave = async () => {
    if (soul.length > 10000) {
      addToast(t("agents.soulTooLong", "Soul must be at most 10,000 characters"), "error");
      return;
    }

    setIsSaving(true);
    try {
      await updateAgentSoul(agent.id, soul, projectId);
      addToast(t("agents.soulSaved", "Soul saved"), "success");
      setJustSaved(true);
      if (justSavedTimeoutRef.current) {
        clearTimeout(justSavedTimeoutRef.current);
      }
      justSavedTimeoutRef.current = setTimeout(() => setJustSaved(false), 3000);
      await onSaved();
    } catch (err) {
      addToast(t("agents.soulSaveFailed", "Failed to save soul: {{error}}", { error: getErrorMessage(err) }), "error");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="config-tab">
      <div className="config-section">
        <h3>{t("agents.soulTitle", "Soul")}</h3>
        <p className="config-description">
          {t("agents.soulDescription", "Define this agent's personality and identity.")}
        </p>

        <div className="config-fields">
          <div className="config-field">
            <label htmlFor="agent-soul">{t("agents.agentSoulLabel", "Agent Soul")}</label>
            <div className="agent-content-toolbar">
              <div className="agent-content-mode-toggle">
                <button
                  className={`btn btn-sm ${!showPreview ? "btn-primary" : ""}`}
                  onClick={() => setShowPreview(false)}
                  disabled={!showPreview}
                  aria-label={t("common.editMode", "Edit mode")}
                >
                  <FileEdit size={14} />
                  {t("common.edit", "Edit")}
                </button>
                <button
                  className={`btn btn-sm ${showPreview ? "btn-primary" : ""}`}
                  onClick={() => setShowPreview(true)}
                  disabled={showPreview}
                  aria-label={t("common.previewMode", "Preview mode")}
                >
                  <Eye size={14} />
                  {t("common.preview", "Preview")}
                </button>
              </div>
            </div>
            {showPreview ? (
              soul.trim() ? (
                <div className="agent-content-preview markdown-body">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {soul}
                  </ReactMarkdown>
                </div>
              ) : (
                <div className="agent-content-preview agent-content-placeholder">
                  {t("agents.soulEmptyPreview", "No soul defined yet. Switch to Edit mode to define the agent's personality.")}
                </div>
              )
            ) : (
              <textarea
                id="agent-soul"
                className="input config-textarea-mono"
                rows={12}
                placeholder={t("agents.soulPlaceholder", "Describe this agent's personality, tone, and behavioral traits...")}
                value={soul}
                onChange={(e) => {
                  setSoul(e.target.value);
                  setJustSaved(false);
                }}
              />
            )}
            {!showPreview && (
              <span className="config-hint">{t("agents.soulHint", "Defines the agent's character and identity. Max 10,000 characters.")}</span>
            )}
          </div>
        </div>

        {!showPreview && (
          <div className="config-actions">
            <button
              className="btn btn-task-create"
              disabled={!hasChanges || isSaving}
              onClick={() => void handleSave()}
            >
              {isSaving ? (
                <>
                  <Loader2 size={16} className="animate-spin" />
                  {t("common.saving", "Saving…")}
                </>
              ) : (
                <>
                  <CheckCircle size={16} />
                  {t("agents.saveSoul", "Save Soul")}
                </>
              )}
            </button>
            {!hasChanges && justSaved && (
              <span className="config-saved-indicator">
                <CheckCircle size={14} />
                {t("agents.soulSaved", "Soul saved")}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function MemoryTab({
  agent,
  projectId,
  addToast,
  onSaved,
}: {
  agent: AgentDetail;
  projectId?: string;
  addToast: (message: string, type?: "success" | "error") => void;
  onSaved: () => Promise<void>;
}) {
  const { t } = useTranslation("app");
  const [memory, setMemory] = useState(agent.memory ?? "");
  const [isSaving, setIsSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [showFilePreview, setShowFilePreview] = useState(false);

  const [memoryFiles, setMemoryFiles] = useState<MemoryFileInfo[]>([]);
  const [memoryFilesLoading, setMemoryFilesLoading] = useState(false);
  const [selectedFilePath, setSelectedFilePath] = useState("");
  const [selectedFileContent, setSelectedFileContent] = useState("");
  const [selectedFileDirty, setSelectedFileDirty] = useState(false);
  const [selectedFileLoading, setSelectedFileLoading] = useState(false);
  const [savingSelectedFile, setSavingSelectedFile] = useState(false);
  const [selectedFileJustSaved, setSelectedFileJustSaved] = useState(false);
  const [fileSwitchHint, setFileSwitchHint] = useState("");
  const justSavedTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selectedFileJustSavedTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isReadOnly = agent.state === "running";
  const hasInlineChanges = memory !== (agent.memory ?? "");

  const selectedMemoryFile = useMemo(
    () => memoryFiles.find((file) => file.path === selectedFilePath),
    [memoryFiles, selectedFilePath],
  );

  const selectedLayerDescription = selectedMemoryFile
    ? ({
        "long-term": t("agents.memoryLayerLongTermDesc", "Curated durable decisions, conventions, constraints, and pitfalls for this specific agent."),
        daily: t("agents.memoryLayerDailyDesc", "Raw daily observations and open loops recorded by this agent."),
        dreams: t("agents.memoryLayerDreamsDesc", "Synthesized patterns and emerging themes distilled from this agent's daily memory."),
      } as Record<string, string>)[selectedMemoryFile.layer] ?? selectedMemoryFile.layer
    : t("agents.selectMemoryFile", "Select a memory file to view or edit.");

  const loadSelectedMemoryFile = useCallback(async (path: string) => {
    setSelectedFileLoading(true);
    try {
      const result = await fetchAgentMemoryFile(agent.id, path, projectId);
      setSelectedFilePath(result.path);
      setSelectedFileContent(result.content);
      setSelectedFileDirty(false);
      setSelectedFileJustSaved(false);
    } catch (err) {
      addToast(t("agents.memoryFileLoadFailed", "Failed to load agent memory file: {{error}}", { error: getErrorMessage(err) }), "error");
    } finally {
      setSelectedFileLoading(false);
    }
  }, [agent.id, projectId, addToast]);

  const loadMemoryFiles = useCallback(async (preferredPath = "") => {
    setMemoryFilesLoading(true);
    try {
      const { files } = await fetchAgentMemoryFiles(agent.id, projectId);
      setMemoryFiles(files);

      if (files.length === 0) {
        setSelectedFilePath("");
        setSelectedFileContent("");
        setSelectedFileDirty(false);
        return;
      }

      const nextPath = pickDefaultAgentMemoryPath(files, preferredPath);
      await loadSelectedMemoryFile(nextPath);
    } catch (err) {
      addToast(t("agents.memoryFilesLoadFailed", "Failed to load memory files: {{error}}", { error: getErrorMessage(err) }), "error");
      setMemoryFiles([]);
      setSelectedFilePath("");
      setSelectedFileContent("");
      setSelectedFileDirty(false);
    } finally {
      setMemoryFilesLoading(false);
    }
  }, [agent.id, projectId, addToast, loadSelectedMemoryFile]);

  useEffect(() => {
    setMemory(agent.memory ?? "");
    setJustSaved(false);
    setShowPreview(false);
    setShowFilePreview(false);
    setFileSwitchHint("");
    setSelectedFileJustSaved(false);
    void loadMemoryFiles();
  }, [agent.id, agent.memory, loadMemoryFiles]);

  useEffect(() => {
    return () => {
      if (justSavedTimeoutRef.current) {
        clearTimeout(justSavedTimeoutRef.current);
      }
      if (selectedFileJustSavedTimeoutRef.current) {
        clearTimeout(selectedFileJustSavedTimeoutRef.current);
      }
    };
  }, []);

  const handleSaveInlineMemory = async () => {
    if (memory.length > 50000) {
      addToast(t("agents.memoryTooLong", "Memory must be at most 50,000 characters"), "error");
      return;
    }

    setIsSaving(true);
    try {
      await updateAgentMemory(agent.id, memory, projectId);
      addToast(t("agents.memorySaved", "Memory saved"), "success");
      setJustSaved(true);
      if (justSavedTimeoutRef.current) {
        clearTimeout(justSavedTimeoutRef.current);
      }
      justSavedTimeoutRef.current = setTimeout(() => setJustSaved(false), 3000);
      await onSaved();
    } catch (err) {
      addToast(t("agents.memorySaveFailed", "Failed to save memory: {{error}}", { error: getErrorMessage(err) }), "error");
    } finally {
      setIsSaving(false);
    }
  };

  const handleSelectMemoryFile = async (path: string) => {
    if (!path || path === selectedFilePath) {
      return;
    }
    if (selectedFileDirty) {
      setFileSwitchHint(t("agents.saveBeforeSwitch", "Save the current file before switching to another file."));
      return;
    }

    setFileSwitchHint("");
    await loadSelectedMemoryFile(path);
  };

  const handleSaveSelectedMemoryFile = async () => {
    if (!selectedFilePath) {
      return;
    }

    setSavingSelectedFile(true);
    try {
      await saveAgentMemoryFile(agent.id, selectedFilePath, selectedFileContent, projectId);
      setSelectedFileDirty(false);
      setSelectedFileJustSaved(true);
      if (selectedFileJustSavedTimeoutRef.current) {
        clearTimeout(selectedFileJustSavedTimeoutRef.current);
      }
      selectedFileJustSavedTimeoutRef.current = setTimeout(() => setSelectedFileJustSaved(false), 3000);
      setFileSwitchHint("");
      await loadMemoryFiles(selectedFilePath);
      addToast(t("agents.memoryFileSaved", "Agent memory file saved"), "success");
      await onSaved();
    } catch (err) {
      addToast(t("agents.memoryFileSaveFailed", "Failed to save agent memory file: {{error}}", { error: getErrorMessage(err) }), "error");
    } finally {
      setSavingSelectedFile(false);
    }
  };

  return (
    <div className="config-tab">
      <div className="config-section">
        <h3>{t("agents.memoryTitle", "Agent Memory")}</h3>
        <p className="config-description">
          {t("agents.memoryDescription", "Store context that belongs to this agent only. Workspace memory, daily notes, dreams, and qmd search live in project settings under Project Memory.")}
        </p>
        {isReadOnly && (
          <p className="config-hint config-hint--block-spacing">
            {t("agents.memoryReadOnly", "Read-only while this agent is running.")}
          </p>
        )}

        <div className="config-fields">
          <div className="config-field">
            <label htmlFor="agent-memory">{t("agents.inlineMemoryLabel", "Inline Memory")}</label>
            <span className="config-hint config-hint--block">
              {t("agents.inlineMemoryHint", "Short-form memory stored directly on the agent record and injected into prompts.")}
            </span>
            <div className="agent-content-toolbar">
              <div className="agent-content-mode-toggle">
                {!isReadOnly && (
                  <button
                    className={`btn btn-sm ${!showPreview ? "btn-primary" : ""}`}
                    onClick={() => setShowPreview(false)}
                    disabled={!showPreview}
                    aria-label={t("common.editMode", "Edit mode")}
                  >
                    <FileEdit size={14} />
                    {t("common.edit", "Edit")}
                  </button>
                )}
                <button
                  className={`btn btn-sm ${showPreview ? "btn-primary" : ""}`}
                  onClick={() => setShowPreview(true)}
                  disabled={showPreview}
                  aria-label={t("common.previewMode", "Preview mode")}
                >
                  <Eye size={14} />
                  {t("common.preview", "Preview")}
                </button>
              </div>
            </div>
            {showPreview ? (
              memory.trim() ? (
                <div className="agent-content-preview markdown-body">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {memory}
                  </ReactMarkdown>
                </div>
              ) : (
                <div className="agent-content-preview agent-content-placeholder">
                  {t("agents.memoryEmptyPreview", "No agent memory defined yet. Switch to Edit mode to add memory content.")}
                </div>
              )
            ) : (
              <textarea
                id="agent-memory"
                aria-label={t("agents.memoryTitle", "Agent Memory")}
                className="input config-textarea-mono"
                rows={10}
                placeholder={t("agents.memoryPlaceholder", "Durable preferences, operating habits, and context this agent should carry across tasks...")}
                value={memory}
                readOnly={isReadOnly}
                onChange={(e) => {
                  setMemory(e.target.value);
                  setJustSaved(false);
                }}
              />
            )}
            {!showPreview && (
              <span className="config-hint">{t("agents.inlineMemoryFieldHint", "This is the inline memory field on the agent JSON record. Max 50,000 characters.")}</span>
            )}
          </div>

          <div className="config-field">
            <label htmlFor="agent-memory-file-select">{t("agents.memoryFilesLabel", "Memory Files")}</label>
            <span className="config-hint config-hint--block">
              {t("agents.memoryFilesHint", "Full OpenClaw memory files at")} <code>agent/{agent.name || agent.id}/memory/</code> {t("agents.memoryFilesHintSuffix", "(MEMORY.md, DREAMS.md, and daily notes).")}
            </span>

            <select
              id="agent-memory-file-select"
              className="select"
              value={selectedFilePath}
              disabled={memoryFilesLoading || selectedFileLoading || savingSelectedFile || memoryFiles.length === 0}
              onChange={(e) => {
                void handleSelectMemoryFile(e.target.value);
              }}
            >
              {memoryFiles.length === 0 ? (
                <option value="">{t("agents.noMemoryFiles", "No memory files found")}</option>
              ) : (
                memoryFiles.map((file) => {
                  const layerName = ({ "long-term": t("agents.memoryLayerLongTerm", "Long-term"), daily: t("agents.memoryLayerDaily", "Daily"), dreams: t("agents.memoryLayerDreams", "Dreams") } as Record<string, string>)[file.layer] ?? file.layer;
                  return (
                    <option key={file.path} value={file.path}>
                      {layerName} • {file.label}
                    </option>
                  );
                })
              )}
            </select>

            {memoryFilesLoading && (
              <span className="config-hint config-hint--inline-loader">
                <Loader2 size={14} className="animate-spin" />
                {t("agents.loadingMemoryFiles", "Loading memory files…")}
              </span>
            )}

            {selectedMemoryFile && (
              <div className="config-hint config-hint--top-spacing">
                <strong>{({ "long-term": t("agents.memoryLayerLongTerm", "Long-term"), daily: t("agents.memoryLayerDaily", "Daily"), dreams: t("agents.memoryLayerDreams", "Dreams") } as Record<string, string>)[selectedMemoryFile.layer] ?? selectedMemoryFile.layer}</strong> · {selectedLayerDescription}
                <br />
                {t("agents.memoryFileMeta", "{{size}} bytes · Updated {{time}}", { size: selectedMemoryFile.size.toLocaleString(), time: relativeTime(selectedMemoryFile.updatedAt, t) })}
              </div>
            )}

            <div className="agent-content-toolbar config-textarea-top-spacing">
              <div className="agent-content-mode-toggle">
                {!isReadOnly && (
                  <button
                    className={`btn btn-sm ${!showFilePreview ? "btn-primary" : ""}`}
                    onClick={() => setShowFilePreview(false)}
                    disabled={!showFilePreview}
                    aria-label={t("agents.memoryFileEditMode", "Memory file edit mode")}
                  >
                    <FileEdit size={14} />
                    {t("common.edit", "Edit")}
                  </button>
                )}
                <button
                  className={`btn btn-sm ${showFilePreview ? "btn-primary" : ""}`}
                  onClick={() => setShowFilePreview(true)}
                  disabled={showFilePreview}
                  aria-label={t("agents.memoryFilePreviewMode", "Memory file preview mode")}
                >
                  <Eye size={14} />
                  {t("common.preview", "Preview")}
                </button>
              </div>
            </div>

            {showFilePreview ? (
              selectedFileContent.trim() ? (
                <div className="agent-content-preview markdown-body">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {selectedFileContent}
                  </ReactMarkdown>
                </div>
              ) : (
                <div className="agent-content-preview agent-content-placeholder">
                  {t("agents.memoryFileEmptyPreview", "No memory file content yet. Switch to Edit mode to add content.")}
                </div>
              )
            ) : (
              <textarea
                className="input config-textarea-mono"
                rows={14}
                placeholder={t("agents.memoryFilePlaceholder", "Select a memory file to view and edit its content...")}
                value={selectedFileContent}
                readOnly={isReadOnly || !selectedFilePath || selectedFileLoading}
                onChange={(e) => {
                  setSelectedFileContent(e.target.value);
                  setSelectedFileDirty(true);
                  setSelectedFileJustSaved(false);
                  setFileSwitchHint("");
                }}
              />
            )}

            {selectedFileLoading && (
              <span className="config-hint config-hint--inline-loader">
                <Loader2 size={14} className="animate-spin" />
                {t("agents.loadingFileContent", "Loading file content…")}
              </span>
            )}

            {fileSwitchHint && (
              <span className="config-hint config-hint--top-spacing config-hint--block">
                {fileSwitchHint}
              </span>
            )}
          </div>
        </div>

        <div className="config-actions">
          {!showPreview && (
            <button
              className="btn btn-task-create"
              disabled={!hasInlineChanges || isSaving || isReadOnly}
              onClick={() => void handleSaveInlineMemory()}
            >
              {isSaving ? (
                <>
                  <Loader2 size={16} className="animate-spin" />
                  {t("common.saving", "Saving…")}
                </>
              ) : (
                <>
                  <CheckCircle size={16} />
                  {t("agents.saveMemory", "Save Memory")}
                </>
              )}
            </button>
          )}
          {!showFilePreview && (
            <button
              className="btn"
              disabled={!selectedFileDirty || savingSelectedFile || !selectedFilePath || isReadOnly}
              onClick={() => void handleSaveSelectedMemoryFile()}
            >
              {savingSelectedFile ? (
                <>
                  <Loader2 size={16} className="animate-spin" />
                  {t("agents.savingFile", "Saving file…")}
                </>
              ) : (
                <>
                  <CheckCircle size={16} />
                  {t("agents.saveMemoryFile", "Save Memory File")}
                </>
              )}
            </button>
          )}
          {!hasInlineChanges && justSaved && (
            <span className="config-saved-indicator">
              <CheckCircle size={14} />
              {t("agents.memorySaved", "Memory saved")}
            </span>
          )}
          {!selectedFileDirty && selectedFileJustSaved && (
            <span className="config-saved-indicator">
              <CheckCircle size={14} />
              {t("agents.memoryFileSaved", "Memory file saved")}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function InstructionsTab({
  agent,
  projectId,
  addToast,
  onSaved,
}: {
  agent: AgentDetail;
  projectId?: string;
  addToast: (message: string, type?: "success" | "error") => void;
  onSaved: () => Promise<void>;
}) {
  const { t } = useTranslation("app");
  // Inline instructions state
  const [instructionsText, setInstructionsText] = useState(agent.instructionsText ?? "");
  const [instructionsPath, setInstructionsPath] = useState(agent.instructionsPath ?? "");
  const [showPreview, setShowPreview] = useState(false);

  // File content state (when instructionsPath is set)
  const [fileContent, setFileContent] = useState("");
  const [isLoadingFile, setIsLoadingFile] = useState(false);
  const [fileContentDirty, setFileContentDirty] = useState(false);

  // Save state
  const [isSaving, setIsSaving] = useState(false);
  const [isSavingFile, setIsSavingFile] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [justSavedFile, setJustSavedFile] = useState(false);
  const justSavedTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const justSavedFileTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load file content when instructionsPath changes
  useEffect(() => {
    const path = instructionsPath.trim();
    if (!path) {
      setFileContent("");
      setFileContentDirty(false);
      return;
    }

    setIsLoadingFile(true);
    fetchWorkspaceFileContent("project", path)
      .then((data) => {
        setFileContent(data.content);
        setFileContentDirty(false);
      })
      .catch((err) => {
        // ENOENT means file doesn't exist yet - treat as empty "new file" state
        const msg = getErrorMessage(err);
        if (msg.includes("ENOENT") || msg.includes("Not found") || msg.includes("not found")) {
          setFileContent("");
          setFileContentDirty(false);
        } else {
          addToast(`Failed to load instructions file: ${msg}`, "error");
          setFileContent("");
        }
      })
      .finally(() => {
        setIsLoadingFile(false);
      });
  }, [instructionsPath, addToast]);

  // Sync with agent data changes
  useEffect(() => {
    setInstructionsText(agent.instructionsText ?? "");
    setInstructionsPath(agent.instructionsPath ?? "");
    setJustSaved(false);
    setJustSavedFile(false);
    setShowPreview(false);
  }, [agent.id, agent.instructionsText, agent.instructionsPath]);

  useEffect(() => {
    return () => {
      if (justSavedTimeoutRef.current) {
        clearTimeout(justSavedTimeoutRef.current);
      }
      if (justSavedFileTimeoutRef.current) {
        clearTimeout(justSavedFileTimeoutRef.current);
      }
    };
  }, []);

  const hasInstructionsChanges = (() => {
    const currentText = instructionsText ?? "";
    const persistedText = agent.instructionsText ?? "";
    const currentPath = instructionsPath?.trim() ?? "";
    const persistedPath = agent.instructionsPath?.trim() ?? "";
    return currentText !== persistedText || currentPath !== persistedPath;
  })();

  const handleSaveInstructions = async () => {
    setIsSaving(true);
    try {
      await updateAgentInstructions(
        agent.id,
        {
          instructionsText: instructionsText || undefined,
          instructionsPath: instructionsPath.trim() || undefined,
        },
        projectId,
      );
      addToast(t("agents.instructionsSaved", "Instructions saved"), "success");
      setJustSaved(true);
      if (justSavedTimeoutRef.current) {
        clearTimeout(justSavedTimeoutRef.current);
      }
      justSavedTimeoutRef.current = setTimeout(() => setJustSaved(false), 3000);
      await onSaved();
    } catch (err) {
      addToast(t("agents.instructionsSaveFailed", "Failed to save instructions: {{error}}", { error: getErrorMessage(err) }), "error");
    } finally {
      setIsSaving(false);
    }
  };

  const handleSaveFile = async () => {
    const path = instructionsPath.trim();
    if (!path) {
      addToast(t("agents.noInstructionsPath", "No instructions file path set"), "error");
      return;
    }

    setIsSavingFile(true);
    try {
      await saveWorkspaceFileContent("project", path, fileContent);
      addToast(t("agents.instructionsFileSaved", "Instructions file saved"), "success");
      setFileContentDirty(false);
      setJustSavedFile(true);
      if (justSavedFileTimeoutRef.current) {
        clearTimeout(justSavedFileTimeoutRef.current);
      }
      justSavedFileTimeoutRef.current = setTimeout(() => setJustSavedFile(false), 3000);
      await onSaved();
    } catch (err) {
      addToast(t("agents.instructionsFileSaveFailed", "Failed to save instructions file: {{error}}", { error: getErrorMessage(err) }), "error");
    } finally {
      setIsSavingFile(false);
    }
  };

  const hasFilePath = !!instructionsPath.trim();

  return (
    <div className="config-tab">
      <div className="config-section">
        <h3>{t("agents.instructionsTitle", "Custom Instructions")}</h3>
        <p className="config-description">
          {t("agents.instructionsDescription", "Append custom instructions to this agent's system prompt at execution time. Use this to customize behavior, coding style, or project conventions without modifying built-in prompts.")}
        </p>

        <div className="config-fields">
          <div className="config-field">
            <label htmlFor="instructions-text">{t("agents.inlineInstructions", "Inline Instructions")}</label>
            <div className="agent-content-toolbar">
              <div className="agent-content-mode-toggle">
                <button
                  className={`btn btn-sm ${!showPreview ? "btn-primary" : ""}`}
                  onClick={() => setShowPreview(false)}
                  disabled={!showPreview}
                  aria-label={t("common.editMode", "Edit mode")}
                  data-testid="instructions-edit-toggle"
                >
                  <FileEdit size={14} />
                  {t("common.edit", "Edit")}
                </button>
                <button
                  className={`btn btn-sm ${showPreview ? "btn-primary" : ""}`}
                  onClick={() => setShowPreview(true)}
                  disabled={showPreview}
                  aria-label={t("common.previewMode", "Preview mode")}
                  data-testid="instructions-preview-toggle"
                >
                  <Eye size={14} />
                  {t("common.preview", "Preview")}
                </button>
              </div>
            </div>
            {showPreview ? (
              instructionsText.trim() ? (
                <div className="agent-content-preview markdown-body">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {instructionsText}
                  </ReactMarkdown>
                </div>
              ) : (
                <div className="agent-content-preview agent-content-placeholder">
                  {t("agents.instructionsEmptyPreview", "No inline instructions defined yet. Switch to Edit mode to add instructions.")}
                </div>
              )
            ) : (
              <textarea
                id="instructions-text"
                className="input"
                rows={10}
                placeholder={t("agents.instructionsPlaceholder", "Enter custom instructions to append to this agent's system prompt...")}
                value={instructionsText}
                onChange={(e) => {
                  setInstructionsText(e.target.value);
                  setJustSaved(false);
                }}
              />
            )}
            {!showPreview && (
              <span className="config-hint">{t("agents.instructionsHint", "Markdown formatting supported. Max 50,000 characters.")}</span>
            )}
          </div>

          <div className="config-field">
            <label htmlFor="instructions-path">{t("agents.instructionsPathLabel", "Instructions File Path")}</label>
            <input
              id="instructions-path"
              type="text"
              className="input"
              placeholder={t("agents.instructionsPathPlaceholder", "e.g., .fusion/agents/my-agent-instructions.md")}
              value={instructionsPath}
              onChange={(e) => {
                setInstructionsPath(e.target.value);
                setJustSaved(false);
              }}
            />
            <span className="config-hint">{t("agents.instructionsPathHint", "Path to a .md file (relative to project root). Contents are read and appended at execution time.")}</span>
          </div>
        </div>

        {!showPreview && (
          <div className="config-actions">
            <button
              className="btn btn-task-create"
              disabled={!hasInstructionsChanges || isSaving}
              onClick={() => void handleSaveInstructions()}
            >
              {isSaving ? (
                <>
                  <Loader2 size={16} className="animate-spin" />
                  {t("common.saving", "Saving…")}
                </>
              ) : (
                <>
                  <CheckCircle size={16} />
                  {t("agents.saveInstructions", "Save Instructions")}
                </>
              )}
            </button>
            {!hasInstructionsChanges && justSaved && (
              <span className="config-saved-indicator">
                <CheckCircle size={14} />
                {t("agents.instructionsSaved", "Instructions saved")}
              </span>
            )}
          </div>
        )}
      </div>

      {hasFilePath && (
        <div className="config-section">
          <h3>{t("agents.instructionsFileEditorTitle", "Instructions File Editor")}</h3>
          <p className="config-description">
            {t("agents.instructionsFileEditorDesc", "Edit the instructions file directly. Changes are saved separately from the path configuration.")}
          </p>

          <div className="config-fields">
            <div className="config-field">
              <div className="config-inline-header">
                <label htmlFor="instructions-file-content">{t("agents.fileContentLabel", "File Content")}</label>
                {isLoadingFile && (
                  <span className="config-hint config-hint--inline-tight">
                    <Loader2 size={12} className="animate-spin" />
                    {t("common.loading", "Loading...")}
                  </span>
                )}
                {fileContentDirty && !isLoadingFile && (
                  <span className="config-hint config-hint--warning">
                    {t("common.unsavedChanges", "Unsaved changes")}
                  </span>
                )}
              </div>
              <textarea
                id="instructions-file-content"
                className="input config-textarea-mono"
                rows={20}
                placeholder={t("agents.fileContentPlaceholder", "File content will appear here when loaded...")}
                value={fileContent}
                readOnly={isLoadingFile}
                onChange={(e) => {
                  setFileContent(e.target.value);
                  setFileContentDirty(true);
                  setJustSavedFile(false);
                }}
              />
              <span className="config-hint">{t("agents.fileContentHint", "Edit the markdown file content directly. Save separately using the button below.")}</span>
            </div>
          </div>

          <div className="config-actions">
            <button
              className="btn btn-task-create"
              disabled={!fileContentDirty || isSavingFile}
              onClick={() => void handleSaveFile()}
            >
              {isSavingFile ? (
                <>
                  <Loader2 size={16} className="animate-spin" />
                  {t("common.saving", "Saving…")}
                </>
              ) : (
                <>
                  <CheckCircle size={16} />
                  {t("agents.saveFile", "Save File")}
                </>
              )}
            </button>
            {!fileContentDirty && justSavedFile && (
              <span className="config-saved-indicator">
                <CheckCircle size={14} />
                {t("agents.fileSaved", "File saved")}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function deriveHeartbeatValues(runtimeConfig: AgentDetail["runtimeConfig"] | undefined): Record<string, string> {
  const rc = runtimeConfig ?? {};
  const nextValues: Record<string, string> = {};

  if (rc.heartbeatIntervalMs !== undefined && rc.heartbeatIntervalMs !== null) {
    nextValues.heartbeatIntervalMs = String(Number(rc.heartbeatIntervalMs) / 1000);
  }
  if (rc.heartbeatTimeoutMs !== undefined && rc.heartbeatTimeoutMs !== null) {
    nextValues.heartbeatTimeoutMs = String(Number(rc.heartbeatTimeoutMs) / 1000);
  }
  if (rc.maxConcurrentRuns !== undefined && rc.maxConcurrentRuns !== null) {
    nextValues.maxConcurrentRuns = String(rc.maxConcurrentRuns);
  }
  if (rc.messageResponseMode === "immediate" || rc.messageResponseMode === "on-heartbeat") {
    nextValues.messageResponseMode = rc.messageResponseMode;
  }
  if (rc.autoClaimCandidatesInPrompt !== undefined && rc.autoClaimCandidatesInPrompt !== null) {
    nextValues.autoClaimCandidatesInPrompt = String(rc.autoClaimCandidatesInPrompt);
  }

  return nextValues;
}

function deriveHeartbeatEnabled(runtimeConfig: AgentDetail["runtimeConfig"] | undefined): boolean {
  return runtimeConfig?.enabled !== false;
}

function deriveAutoClaimRelevantTasksEnabled(runtimeConfig: AgentDetail["runtimeConfig"] | undefined): boolean {
  return runtimeConfig?.autoClaimRelevantTasks !== false;
}

function deriveEngineerBacklogAutoClaim(runtimeConfig: AgentDetail["runtimeConfig"] | undefined): boolean {
  return runtimeConfig?.engineerBacklogAutoClaim === true;
}

function deriveRunMissedHeartbeatOnStartup(runtimeConfig: AgentDetail["runtimeConfig"] | undefined): boolean {
  return runtimeConfig?.runMissedHeartbeatOnStartup === true;
}

function deriveAllowParallelExecution(runtimeConfig: AgentDetail["runtimeConfig"] | undefined): boolean {
  return runtimeConfig?.allowParallelExecution !== false;
}

function deriveSkipHeartbeatWhenIdle(runtimeConfig: AgentDetail["runtimeConfig"] | undefined): boolean {
  return runtimeConfig?.skipHeartbeatWhenIdle === true;
}

function deriveHeartbeatScopeDiscipline(runtimeConfig: AgentDetail["runtimeConfig"] | undefined): "strict" | "lite" | "off" | "" {
  const mode = runtimeConfig?.heartbeatScopeDiscipline;
  return mode === "strict" || mode === "lite" || mode === "off" ? mode : "";
}

function deriveHeartbeatPromptTemplate(runtimeConfig: AgentDetail["runtimeConfig"] | undefined): "default" | "compact" | "" {
  const template = runtimeConfig?.heartbeatPromptTemplate;
  return template === "default" || template === "compact" ? template : "";
}

function deriveBudgetValues(runtimeConfig: AgentDetail["runtimeConfig"] | undefined): Record<string, string> {
  const bc = (runtimeConfig ?? {}).budgetConfig as Record<string, unknown> | undefined;
  const nextValues: Record<string, string> = {};

  if (!bc) {
    return nextValues;
  }

  if (bc.tokenBudget !== undefined && bc.tokenBudget !== null) {
    nextValues.tokenBudget = String(bc.tokenBudget);
  }
  if (bc.usageThreshold !== undefined && bc.usageThreshold !== null) {
    // Convert fraction (0-1) to percentage (0-100) for display
    nextValues.usageThreshold = String(Number(bc.usageThreshold) * 100);
  }
  if (bc.budgetPeriod !== undefined && bc.budgetPeriod !== null) {
    nextValues.budgetPeriod = String(bc.budgetPeriod);
  }
  if (bc.resetDay !== undefined && bc.resetDay !== null) {
    nextValues.resetDay = String(bc.resetDay);
  }

  return nextValues;
}

function HeartbeatProcedureSection({
  agent,
  projectId,
  addToast,
  onSaved,
}: {
  agent: AgentDetail;
  projectId?: string;
  addToast: (message: string, type?: "success" | "error") => void;
  onSaved: () => Promise<void>;
}) {
  const { t } = useTranslation("app");
  const [isUpgrading, setIsUpgrading] = useState(false);
  const [showFileViewer, setShowFileViewer] = useState(false);
  const [isLoadingFile, setIsLoadingFile] = useState(false);
  const [isSavingFile, setIsSavingFile] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [fileContent, setFileContent] = useState("");
  const [fileContentDirty, setFileContentDirty] = useState(false);
  const [fileLoadError, setFileLoadError] = useState<string | null>(null);
  const [justSavedFile, setJustSavedFile] = useState(false);
  const justSavedFileTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentPath = agent.heartbeatProcedurePath?.trim();
  const canonicalDefaultPath = `.fusion/agents/${agent.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || agent.id.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "agent"}-${agent.id
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "agent"}/HEARTBEAT.md`;
  const legacyDefaultPath = `.fusion/agents/${agent.id}/HEARTBEAT.md`;
  const safeId = agent.id.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
  const onDefault = Boolean(
    currentPath
      && (currentPath === canonicalDefaultPath
        || currentPath === legacyDefaultPath
        || new RegExp(`^\\.fusion/agents/[^/]+-${safeId}/HEARTBEAT\\.md$`).test(currentPath)),
  );
  const hasFilePath = Boolean(currentPath);

  const loadHeartbeatFile = useCallback(async (path: string) => {
    setIsLoadingFile(true);
    setFileLoadError(null);
    try {
      const data = await fetchWorkspaceFileContent("project", path, projectId);
      setFileContent(data.content);
      setFileContentDirty(false);
    } catch (err) {
      const message = getErrorMessage(err);
      setFileLoadError(message);
      addToast(t("agents.heartbeatFileLoadFailed", "Failed to load heartbeat procedure file: {{error}}", { error: message }), "error");
    } finally {
      setIsLoadingFile(false);
    }
  }, [addToast, projectId]);

  useEffect(() => {
    setShowFileViewer(false);
    setShowPreview(false);
    setFileContent("");
    setFileContentDirty(false);
    setFileLoadError(null);
    setIsLoadingFile(false);
    setIsSavingFile(false);
    setJustSavedFile(false);
  }, [agent.id, currentPath]);

  useEffect(() => {
    return () => {
      if (justSavedFileTimeoutRef.current) {
        clearTimeout(justSavedFileTimeoutRef.current);
      }
    };
  }, []);

  const handleOpenViewer = async () => {
    if (!currentPath) return;
    setShowFileViewer(true);
    await loadHeartbeatFile(currentPath);
  };

  const handleSaveFile = async () => {
    if (!currentPath) return;
    setIsSavingFile(true);
    try {
      await saveWorkspaceFileContent("project", currentPath, fileContent, projectId);
      setFileContentDirty(false);
      setJustSavedFile(true);
      addToast(t("agents.heartbeatFileSaved", "Heartbeat procedure file saved"), "success");
      if (justSavedFileTimeoutRef.current) {
        clearTimeout(justSavedFileTimeoutRef.current);
      }
      justSavedFileTimeoutRef.current = setTimeout(() => setJustSavedFile(false), 3000);
      await onSaved();
    } catch (err) {
      addToast(t("agents.heartbeatFileSaveFailed", "Failed to save heartbeat procedure file: {{error}}", { error: getErrorMessage(err) }), "error");
    } finally {
      setIsSavingFile(false);
    }
  };

  const handleUpgrade = async () => {
    setIsUpgrading(true);
    try {
      const result = await upgradeAgentHeartbeatProcedure(agent.id, projectId);
      addToast(
        result.procedureFileSeeded
          ? t("agents.heartbeatProcedureFileReady", "Heartbeat procedure file ready at {{path}}", { path: result.heartbeatProcedurePath })
          : t("agents.heartbeatProcedurePathSet", "Heartbeat procedure path set to {{path}}", { path: result.heartbeatProcedurePath }),
        "success",
      );
      await onSaved();
    } catch (err) {
      addToast(t("agents.heartbeatUpgradeFailed", "Failed to upgrade heartbeat procedure: {{error}}", { error: getErrorMessage(err) }), "error");
    } finally {
      setIsUpgrading(false);
    }
  };

  return (
    <div className="config-section">
      <h3>{t("agents.heartbeatProcedureTitle", "Heartbeat Procedure")}</h3>
      <p className="config-description">
        {t("agents.heartbeatProcedureDesc", "The per-tick procedure this agent runs every wake. Defaults to a per-agent markdown file (for example")} <code>.fusion/agents/ceo-agent2736/HEARTBEAT.md</code>{t("agents.heartbeatProcedureDescSuffix", ") that you can edit. Legacy id-only default paths remain valid. Resets on every tick — no need to restart the agent after editing.")}
      </p>
      <div className="config-fields">
        <div className="config-field">
          <span className="config-hint">
            {t("agents.currentPath", "Current path:")} <code>{currentPath || t("agents.noneUsingBuiltIn", "(none — using built-in default)")}</code>
          </span>
          {hasFilePath && (
            <div className="heartbeat-procedure-actions">
              <button
                className="btn btn-sm"
                onClick={() => void handleOpenViewer()}
                disabled={isLoadingFile}
              >
                {isLoadingFile ? (
                  <>
                    <Loader2 size={16} className="animate-spin" />
                    {t("agents.loadingFile", "Loading file…")}
                  </>
                ) : (
                  <>
                    <FileText size={16} />
                    {t("agents.viewHeartbeatMarkdown", "View Heartbeat Markdown")}
                  </>
                )}
              </button>
            </div>
          )}
        </div>
        <div className="config-field">
          <button
            className="btn"
            disabled={isUpgrading || onDefault}
            onClick={() => void handleUpgrade()}
            aria-label={t("agents.upgradeToDefaultAriaLabel", "Upgrade agent to default heartbeat procedure file")}
          >
            {isUpgrading ? (
              <>
                <Loader2 size={16} className="animate-spin" />
                {t("agents.upgrading", "Upgrading…")}
              </>
            ) : onDefault ? (
              <>
                <CheckCircle size={16} />
                {t("agents.alreadyOnDefault", "Already on default")}
              </>
            ) : (
              t("agents.upgradeToDefault", "Upgrade to Default Heartbeat Procedure")
            )}
          </button>
          <span className="config-hint">
            {t("agents.upgradeHint", "Sets")} <code>heartbeatProcedurePath</code> {t("agents.upgradeHintTo", "to")}{" "}
            <code>{canonicalDefaultPath}</code>
            {" "}{t("agents.upgradeHintSuffix", "and seeds the file from the built-in template if it doesn't exist. Each agent gets its own per-agent file, so edits stay scoped to this agent. Operator edits to the file are preserved.")}
          </span>
        </div>
      </div>

      {showFileViewer && hasFilePath && currentPath && (
        <div className="config-fields heartbeat-procedure-viewer">
          <div className="config-field">
            <label htmlFor="heartbeat-procedure-file-content">{t("agents.heartbeatProcedureFileLabel", "Heartbeat Procedure File")}</label>
            <div className="agent-content-toolbar">
              <div className="agent-content-mode-toggle">
                <button
                  className={`btn btn-sm ${!showPreview ? "btn-primary" : ""}`}
                  onClick={() => setShowPreview(false)}
                  disabled={!showPreview}
                  aria-label={t("agents.heartbeatFileEditMode", "Heartbeat file edit mode")}
                >
                  <FileEdit size={14} />
                  {t("common.edit", "Edit")}
                </button>
                <button
                  className={`btn btn-sm ${showPreview ? "btn-primary" : ""}`}
                  onClick={() => setShowPreview(true)}
                  disabled={showPreview}
                  aria-label={t("agents.heartbeatFilePreviewMode", "Heartbeat file preview mode")}
                >
                  <Eye size={14} />
                  {t("common.preview", "Preview")}
                </button>
              </div>
              {isLoadingFile && (
                <span className="config-hint heartbeat-procedure-status">
                  <Loader2 size={12} className="animate-spin" />
                  {t("common.loading", "Loading...")}
                </span>
              )}
              {fileContentDirty && !isLoadingFile && (
                <span className="config-hint heartbeat-procedure-status heartbeat-procedure-status--warning">
                  {t("common.unsavedChanges", "Unsaved changes")}
                </span>
              )}
            </div>
            {showPreview ? (
              fileContent.trim() ? (
                <div className="agent-content-preview markdown-body">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{fileContent}</ReactMarkdown>
                </div>
              ) : (
                <div className="agent-content-preview agent-content-placeholder">
                  {t("agents.heartbeatFileEmptyPreview", "No heartbeat procedure markdown content yet.")}
                </div>
              )
            ) : (
              <textarea
                id="heartbeat-procedure-file-content"
                className="input"
                rows={16}
                value={fileContent}
                readOnly={isLoadingFile}
                placeholder={t("agents.heartbeatFilePlaceholder", "Heartbeat procedure markdown file content will appear here...")}
                onChange={(e) => {
                  setFileContent(e.target.value);
                  setFileContentDirty(true);
                  setJustSavedFile(false);
                }}
              />
            )}
            {fileLoadError && (
              <span className="config-error">{t("agents.fileLoadError", "Failed to load file: {{error}}", { error: fileLoadError })}</span>
            )}
            <span className="config-hint">
              {t("agents.heartbeatFileEditorHint", "This editor writes directly to")} <code>{currentPath}</code>.
            </span>
          </div>
          {!showPreview && (
            <div className="config-actions">
              <button
                className="btn btn-task-create"
                disabled={!fileContentDirty || isSavingFile || isLoadingFile}
                onClick={() => void handleSaveFile()}
              >
                {isSavingFile ? (
                  <>
                    <Loader2 size={16} className="animate-spin" />
                    {t("common.saving", "Saving…")}
                  </>
                ) : (
                  <>
                    <CheckCircle size={16} />
                    {t("agents.saveHeartbeatFile", "Save Heartbeat File")}
                  </>
                )}
              </button>
              {!fileContentDirty && justSavedFile && (
                <span className="config-saved-indicator">
                  <CheckCircle size={14} />
                  {t("agents.fileSaved", "File saved")}
                </span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ConfigTab({
  agent,
  projectId,
  addToast,
  onSaved,
  onHasChangesChange,
  onDelete,
  onAgentDraftApplied,
}: {
  agent: AgentDetail;
  projectId?: string;
  addToast: (message: string, type?: "success" | "error") => void;
  onSaved: () => Promise<void>;
  onHasChangesChange?: (hasChanges: boolean) => void;
  onDelete?: () => Promise<void> | void;
  onAgentDraftApplied?: (updates: Partial<AgentDetail>) => void;
}) {
  const { t } = useTranslation("app");
  // Identity field state
  const [nameValue, setNameValue] = useState(agent.name);
  const [roleValue, setRoleValue] = useState(agent.role);
  const [titleValue, setTitleValue] = useState(agent.title ?? "");
  const [iconValue, setIconValue] = useState(agent.icon ?? "");
  const [reportsToValue, setReportsToValue] = useState(agent.reportsTo ?? "");
  const [managerOptions, setManagerOptions] = useState<Agent[]>([]);
  const [isLoadingManagers, setIsLoadingManagers] = useState(false);
  const [isAvatarPending, setIsAvatarPending] = useState(false);
  const [isAiInterviewOpen, setIsAiInterviewOpen] = useState(false);
  const avatarInputRef = useRef<HTMLInputElement>(null);

  // Local form state initialised from agent.metadata
  const [formValues, setFormValues] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const field of ADVANCED_SETTINGS) {
      const raw = agent.metadata[field.key];
      if (raw !== undefined && raw !== null) {
        initial[field.key] = String(raw);
      }
    }
    return initial;
  });

  // Heartbeat config state initialised from agent.runtimeConfig
  const [heartbeatValues, setHeartbeatValues] = useState<Record<string, string>>(
    () => deriveHeartbeatValues(agent.runtimeConfig),
  );
  const [heartbeatEnabled, setHeartbeatEnabled] = useState<boolean>(
    () => deriveHeartbeatEnabled(agent.runtimeConfig),
  );
  const [autoClaimRelevantTasksEnabled, setAutoClaimRelevantTasksEnabled] = useState<boolean>(
    () => deriveAutoClaimRelevantTasksEnabled(agent.runtimeConfig),
  );
  const [engineerBacklogAutoClaimEnabled, setEngineerBacklogAutoClaimEnabled] = useState<boolean>(
    () => deriveEngineerBacklogAutoClaim(agent.runtimeConfig),
  );
  const [runMissedHeartbeatOnStartup, setRunMissedHeartbeatOnStartup] = useState<boolean>(
    () => deriveRunMissedHeartbeatOnStartup(agent.runtimeConfig),
  );
  const [allowParallelExecution, setAllowParallelExecution] = useState<boolean>(
    () => deriveAllowParallelExecution(agent.runtimeConfig),
  );
  const [skipHeartbeatWhenIdle, setSkipHeartbeatWhenIdle] = useState<boolean>(
    () => deriveSkipHeartbeatWhenIdle(agent.runtimeConfig),
  );
  const [heartbeatScopeDiscipline, setHeartbeatScopeDiscipline] = useState<"strict" | "lite" | "off" | "">(
    () => deriveHeartbeatScopeDiscipline(agent.runtimeConfig),
  );
  const [heartbeatPromptTemplate, setHeartbeatPromptTemplate] = useState<"default" | "compact" | "">(
    () => deriveHeartbeatPromptTemplate(agent.runtimeConfig),
  );

  // Budget config state initialised from agent.runtimeConfig.budgetConfig
  const [budgetValues, setBudgetValues] = useState<Record<string, string>>(
    () => deriveBudgetValues(agent.runtimeConfig),
  );

  // Bundle config state
  const [bundleMode, setBundleMode] = useState<string>(agent.bundleConfig?.mode ?? "");
  const [bundleEntryFile, setBundleEntryFile] = useState(agent.bundleConfig?.entryFile ?? "AGENTS.md");
  const [bundleExternalPath, setBundleExternalPath] = useState(agent.bundleConfig?.externalPath ?? "");
  const [bundleFiles, setBundleFiles] = useState<string[]>(agent.bundleConfig?.files ?? []);

  // Skills state initialized from agent.metadata.skills
  const [selectedSkills, setSelectedSkills] = useState<string[]>(
    Array.isArray(agent.metadata?.skills) ? agent.metadata.skills as string[] : []
  );

  // Model/runtime selector state
  const { favoriteProviders, favoriteModels, toggleFavoriteProvider, toggleFavoriteModel } = useFavorites();
  const [availableModels, setAvailableModels] = useState<ModelInfo[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [availableRuntimes, setAvailableRuntimes] = useState<PluginRuntimeInfo[]>([]);
  const [runtimesLoading, setRuntimesLoading] = useState(false);

  const initialModelValue = (() => {
    const rc = agent.runtimeConfig ?? {};
    if (rc.modelProvider && rc.modelId) {
      return `${rc.modelProvider}/${rc.modelId}`;
    }
    if (typeof rc.model === "string" && rc.model.includes("/")) {
      return rc.model;
    }
    return "";
  })();
  const initialRuntimeHint = typeof agent.runtimeConfig?.runtimeHint === "string"
    ? agent.runtimeConfig.runtimeHint
    : "";
  const [runtimeMode, setRuntimeMode] = useState<"model" | "runtime">(initialRuntimeHint ? "runtime" : "model");
  const [modelValue, setModelValue] = useState(initialModelValue);
  const [selectedRuntimeId, setSelectedRuntimeId] = useState(initialRuntimeHint);
  const [permissionPolicyValue, setPermissionPolicyValue] = useState<AgentPermissionPolicy | undefined>(agent.permissionPolicy);
  const [permissionsValue, setPermissionsValue] = useState<Record<string, boolean>>(agent.permissions ?? {});
  const [projectDefaultPermissionPolicy, setProjectDefaultPermissionPolicy] = useState<{ rules?: Partial<AgentPermissionPolicyRules>; toolRules?: AgentPermissionPolicy["toolRules"] } | undefined>(undefined);

  const managerSelection = reportsToValue.trim();
  const availableManagers = useMemo(
    () => managerOptions.filter((candidate) => candidate.id !== agent.id),
    [managerOptions, agent.id],
  );
  const hasMissingManagerSelection = !!managerSelection
    && !availableManagers.some((candidate) => candidate.id === managerSelection);

  const existingAgentConfig = useMemo(() => ({
    name: nameValue,
    role: roleValue,
    title: titleValue || undefined,
    instructionsText: agent.instructionsText,
    soul: agent.soul,
    memory: agent.memory,
    reportsTo: reportsToValue || undefined,
    skills: selectedSkills,
    model: modelValue || undefined,
    runtimeHint: runtimeMode === "runtime" ? selectedRuntimeId || undefined : undefined,
    thinkingLevel: (formValues.thinkingLevel as "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | undefined) ?? undefined,
    maxTurns: formValues.maxTurns ? Number(formValues.maxTurns) : undefined,
    heartbeatIntervalMs: heartbeatValues.heartbeatIntervalMs ? Number(heartbeatValues.heartbeatIntervalMs) * 1000 : undefined,
    heartbeatTimeoutMs: heartbeatValues.heartbeatTimeoutMs ? Number(heartbeatValues.heartbeatTimeoutMs) * 1000 : undefined,
    maxConcurrentRuns: heartbeatValues.maxConcurrentRuns ? Number(heartbeatValues.maxConcurrentRuns) : undefined,
    messageResponseMode: heartbeatValues.messageResponseMode as "immediate" | "on-heartbeat" | undefined,
  }), [
    agent.instructionsText,
    agent.memory,
    agent.soul,
    formValues.maxTurns,
    formValues.thinkingLevel,
    heartbeatValues.heartbeatIntervalMs,
    heartbeatValues.heartbeatTimeoutMs,
    heartbeatValues.maxConcurrentRuns,
    heartbeatValues.messageResponseMode,
    modelValue,
    nameValue,
    reportsToValue,
    roleValue,
    runtimeMode,
    selectedRuntimeId,
    selectedSkills,
    titleValue,
  ]);

  const applyInterviewDraft = useCallback((summary: AgentOnboardingSummary) => {
    setNameValue(summary.name);
    setRoleValue(summary.role);
    setTitleValue(summary.title ?? "");
    setIconValue(summary.icon ?? "");
    setReportsToValue(summary.reportsTo ?? "");

    if (summary.skills) {
      setSelectedSkills(summary.skills);
    }
    if (summary.thinkingLevel) {
      setFormValues((prev) => ({ ...prev, thinkingLevel: summary.thinkingLevel }));
    }
    if (summary.maxTurns !== undefined) {
      setFormValues((prev) => ({ ...prev, maxTurns: String(summary.maxTurns) }));
    }
    if (summary.runtimeHint !== undefined) {
      setRuntimeMode("runtime");
      setSelectedRuntimeId(summary.runtimeHint ?? "");
      if (summary.runtimeHint) {
        setModelValue("");
      }
    } else if (summary.model !== undefined) {
      setRuntimeMode("model");
      setModelValue(summary.model ?? "");
      setSelectedRuntimeId("");
    }

    const draftUpdates = Object.fromEntries(
      Object.entries({
        name: summary.name,
        role: summary.role,
        title: summary.title,
        icon: summary.icon,
        reportsTo: summary.reportsTo,
        instructionsText: summary.instructionsText,
        soul: summary.soul,
        memory: summary.memory,
      }).filter(([, value]) => value !== undefined),
    ) as Partial<AgentDetail>;
    onAgentDraftApplied?.(draftUpdates);

    setIsAiInterviewOpen(false);
    addToast(t("agents.interviewDraftApplied", "Interview draft applied. Review and save when ready."), "success");
  }, [addToast, onAgentDraftApplied]);

  useEffect(() => {
    setPermissionPolicyValue(agent.permissionPolicy);
  }, [agent.permissionPolicy]);

  useEffect(() => {
    setPermissionsValue(agent.permissions ?? {});
  }, [agent.permissions]);

  useEffect(() => {
    fetchSettingsByScope(projectId)
      .then((scoped) => setProjectDefaultPermissionPolicy(scoped.project?.defaultAgentPermissionPolicy))
      .catch(() => setProjectDefaultPermissionPolicy(undefined));
  }, [projectId]);

  const handlePermissionPolicyChange = async (next: AgentPermissionPolicy | undefined) => {
    setPermissionPolicyValue(next);
    try {
      await updateAgent(agent.id, { permissionPolicy: next }, projectId);
      await onSaved();
      addToast(t("agents.permissionPolicyUpdated", "Permission policy updated"), "success");
    } catch (err) {
      addToast(t("agents.permissionPolicyFailed", "Failed to update permission policy: {{error}}", { error: getErrorMessage(err) }), "error");
    }
  };

  const roleDefaultPermissions = useMemo(() => new Set<AgentPermission>(AGENT_ROLE_DEFAULT_PERMISSION_MAP[roleValue] ?? []), [roleValue]);
  const explicitPermissionSet = useMemo(() => new Set<AgentPermission>(
    AGENT_PERMISSIONS.filter((permission) => permissionsValue[permission] === true),
  ), [permissionsValue]);

  const handleCapabilityPermissionChange = async (permission: AgentPermission, granted: boolean) => {
    const next = { ...permissionsValue };
    if (granted) {
      next[permission] = true;
    } else {
      delete next[permission];
    }
    setPermissionsValue(next);
    try {
      await updateAgent(agent.id, { permissions: next }, projectId);
      await onSaved();
      addToast(t("agents.capabilityPermissionsUpdated", "Capability grants updated"), "success");
    } catch (err) {
      setPermissionsValue(agent.permissions ?? {});
      addToast(t("agents.capabilityPermissionsFailed", "Failed to update capability grants: {{error}}", { error: getErrorMessage(err) }), "error");
    }
  };

  // Load candidate managers for reports-to dropdown
  useEffect(() => {
    let cancelled = false;
    setIsLoadingManagers(true);

    fetchAgents(undefined, projectId)
      .then((agents) => {
        if (cancelled) return;
        setManagerOptions(agents);
      })
      .catch(() => {
        if (!cancelled) {
          setManagerOptions([]);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoadingManagers(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // Load available models on mount
  useEffect(() => {
    setModelsLoading(true);
    fetchModels()
      .then((response) => {
        setAvailableModels(response.models);
      })
      .catch(() => {
        // Gracefully handle unavailable models endpoint
      })
      .finally(() => setModelsLoading(false));
  }, []);

  useEffect(() => {
    setRuntimesLoading(true);
    fetchPluginRuntimes(projectId)
      .then(setAvailableRuntimes)
      .catch(() => setAvailableRuntimes([]))
      .finally(() => setRuntimesLoading(false));
  }, [projectId]);

  // Budget status for progress bar display
  const [budgetStatus, setBudgetStatus] = useState<AgentBudgetStatus | null>(null);
  const [isResettingBudget, setIsResettingBudget] = useState(false);

  // Fetch budget status on mount
  useEffect(() => {
    fetchAgentBudgetStatus(agent.id, projectId)
      .then(setBudgetStatus)
      .catch(() => setBudgetStatus(null));
  }, [agent.id, projectId]);

  const handleResetBudget = async () => {
    setIsResettingBudget(true);
    try {
      await resetAgentBudget(agent.id, projectId);
      addToast(t("agents.budgetResetSuccess", "Budget usage reset successfully"), "success");
      // Refresh budget status
      const status = await fetchAgentBudgetStatus(agent.id, projectId);
      setBudgetStatus(status);
    } catch (err) {
      addToast(t("agents.budgetResetFailed", "Failed to reset budget: {{error}}", { error: getErrorMessage(err) }), "error");
    } finally {
      setIsResettingBudget(false);
    }
  };

  const [isSaving, setIsSaving] = useState(false);
  const [errors, setErrors] = useState<ValidationErrors>({});
  const [justSaved, setJustSaved] = useState(false);
  const [autoSaveError, setAutoSaveError] = useState<string | null>(null);
  const isDeletableState = agent.state === "idle" || agent.state === "paused";
  const justSavedTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previousAgentRuntimeSyncRef = useRef<{ id: string; updatedAt: string } | null>(null);
  const lastSavedSignatureRef = useRef<string | null>(null);
  const saveRevisionRef = useRef(0);

  useEffect(() => {
    return () => {
      if (justSavedTimeoutRef.current) {
        clearTimeout(justSavedTimeoutRef.current);
      }
    };
  }, []);

  /** Detect whether any local value differs from the persisted metadata */
  const hasChanges = (() => {
    // Check identity fields
    if (nameValue !== agent.name) return true;
    if (roleValue !== agent.role) return true;
    if (titleValue !== (agent.title ?? "")) return true;
    if (iconValue !== (agent.icon ?? "")) return true;
    if (reportsToValue !== (agent.reportsTo ?? "")) return true;

    // Check bundle config
    if (bundleMode !== (agent.bundleConfig?.mode ?? "")) return true;
    if (bundleEntryFile !== (agent.bundleConfig?.entryFile ?? "AGENTS.md")) return true;
    if (bundleExternalPath !== (agent.bundleConfig?.externalPath ?? "")) return true;
    if (JSON.stringify(bundleFiles) !== JSON.stringify(agent.bundleConfig?.files ?? [])) return true;

    for (const field of ADVANCED_SETTINGS) {
      const current = formValues[field.key]?.trim() ?? "";
      const persisted = agent.metadata[field.key] !== undefined && agent.metadata[field.key] !== null
        ? String(agent.metadata[field.key])
        : "";
      if (current !== persisted) return true;
    }
    // Check heartbeat values
    const rc = agent.runtimeConfig ?? {};
    if (heartbeatEnabled !== deriveHeartbeatEnabled(agent.runtimeConfig)) return true;
    if (autoClaimRelevantTasksEnabled !== deriveAutoClaimRelevantTasksEnabled(agent.runtimeConfig)) return true;
    if (engineerBacklogAutoClaimEnabled !== deriveEngineerBacklogAutoClaim(agent.runtimeConfig)) return true;
    if (runMissedHeartbeatOnStartup !== deriveRunMissedHeartbeatOnStartup(agent.runtimeConfig)) return true;
    if (allowParallelExecution !== deriveAllowParallelExecution(agent.runtimeConfig)) return true;
    if (skipHeartbeatWhenIdle !== deriveSkipHeartbeatWhenIdle(agent.runtimeConfig)) return true;
    if (heartbeatScopeDiscipline !== deriveHeartbeatScopeDiscipline(agent.runtimeConfig)) return true;
    if (heartbeatPromptTemplate !== deriveHeartbeatPromptTemplate(agent.runtimeConfig)) return true;
    for (const key of ["heartbeatIntervalMs", "heartbeatTimeoutMs", "maxConcurrentRuns", "messageResponseMode", "autoClaimCandidatesInPrompt"] as const) {
      const current = heartbeatValues[key]?.trim() ?? "";
      let persisted = rc[key] !== undefined && rc[key] !== null ? String(rc[key]) : "";

      if ((key === "heartbeatIntervalMs" || key === "heartbeatTimeoutMs") && persisted) {
        persisted = String(Number(persisted) / 1000);
      }

      if (current !== persisted) return true;
    }
    // Check budget config values
    const persistedBc = rc.budgetConfig as Record<string, unknown> | undefined;
    for (const key of ["tokenBudget", "budgetPeriod", "resetDay"] as const) {
      const current = budgetValues[key]?.trim() ?? "";
      const persisted = persistedBc?.[key] !== undefined && persistedBc?.[key] !== null
        ? String(persistedBc[key])
        : "";
      if (current !== persisted) return true;
    }
    // usageThreshold: compare percentage (UI) against fraction * 100 (persisted)
    const currentThreshold = budgetValues.usageThreshold?.trim() ?? "";
    const persistedThreshold = persistedBc?.usageThreshold !== undefined && persistedBc?.usageThreshold !== null
      ? String(Number(persistedBc.usageThreshold) * 100)
      : "";
    if (currentThreshold !== persistedThreshold) return true;

    // Check skills
    const persistedSkills = Array.isArray(agent.metadata?.skills) ? agent.metadata.skills as string[] : [];
    if (JSON.stringify(selectedSkills) !== JSON.stringify(persistedSkills)) return true;

    // Check model/runtime override
    if (runtimeMode !== (initialRuntimeHint ? "runtime" : "model")) return true;
    if (modelValue !== initialModelValue) return true;
    if (selectedRuntimeId !== initialRuntimeHint) return true;

    return false;
  })();

  const previousHasChangesRef = useRef<boolean | null>(null);

  useEffect(() => {
    if (!onHasChangesChange) return;
    if (previousHasChangesRef.current === hasChanges) return;

    previousHasChangesRef.current = hasChanges;
    onHasChangesChange(hasChanges);
  }, [hasChanges, onHasChangesChange]);

  useEffect(() => {
    return () => {
      onHasChangesChange?.(false);
    };
  }, [onHasChangesChange]);

  useEffect(() => {
    const nextSnapshot = { id: agent.id, updatedAt: agent.updatedAt };
    const previousSnapshot = previousAgentRuntimeSyncRef.current;
    const hasNewAgentData =
      !previousSnapshot
      || previousSnapshot.id !== nextSnapshot.id
      || previousSnapshot.updatedAt !== nextSnapshot.updatedAt;

    if (!hasNewAgentData) {
      return;
    }

    if (hasChanges) {
      return;
    }

    previousAgentRuntimeSyncRef.current = nextSnapshot;
    setHeartbeatValues(deriveHeartbeatValues(agent.runtimeConfig));
    setHeartbeatEnabled(deriveHeartbeatEnabled(agent.runtimeConfig));
    setAutoClaimRelevantTasksEnabled(deriveAutoClaimRelevantTasksEnabled(agent.runtimeConfig));
    setEngineerBacklogAutoClaimEnabled(deriveEngineerBacklogAutoClaim(agent.runtimeConfig));
    setRunMissedHeartbeatOnStartup(deriveRunMissedHeartbeatOnStartup(agent.runtimeConfig));
    setAllowParallelExecution(deriveAllowParallelExecution(agent.runtimeConfig));
    setSkipHeartbeatWhenIdle(deriveSkipHeartbeatWhenIdle(agent.runtimeConfig));
    setHeartbeatScopeDiscipline(deriveHeartbeatScopeDiscipline(agent.runtimeConfig));
    setBudgetValues(deriveBudgetValues(agent.runtimeConfig));
    setModelValue(initialModelValue);
    setSelectedRuntimeId(initialRuntimeHint);
    setRuntimeMode(initialRuntimeHint ? "runtime" : "model");
  }, [agent, hasChanges, initialModelValue, initialRuntimeHint]);

  const handleFieldChange = (key: string, value: string) => {
    setFormValues((prev) => ({ ...prev, [key]: value }));
    setJustSaved(false);
    // Clear individual field error on change
    if (errors[key]) {
      setErrors((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
    }
  };

  const handleHeartbeatFieldChange = (key: string, value: string) => {
    setHeartbeatValues((prev) => ({ ...prev, [key]: value }));
    setJustSaved(false);
    if (errors[key]) {
      setErrors((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
    }
  };

  const handleHeartbeatEnabledChange = (enabled: boolean) => {
    setHeartbeatEnabled(enabled);
    setJustSaved(false);
  };

  const handleBudgetFieldChange = (key: string, value: string) => {
    setBudgetValues((prev) => ({ ...prev, [key]: value }));
    setJustSaved(false);
    if (errors[key]) {
      setErrors((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
    }
  };

  const validationErrors = useMemo(() => {
    const nextErrors = validateAdvancedSettings(formValues);

    for (const [key, config] of Object.entries({
      heartbeatIntervalMs: { label: "Heartbeat Interval", min: 1 },
      heartbeatTimeoutMs: { label: "Heartbeat Timeout", min: 5 },
      maxConcurrentRuns: { label: "Max Concurrent Runs", min: 1 },
    })) {
      const raw = heartbeatValues[key]?.trim();
      if (!raw) continue;
      const num = Number(raw);
      if (Number.isNaN(num) || !Number.isFinite(num)) {
        nextErrors[key] = `"${config.label}" must be a valid number`;
      } else if (num < config.min) {
        nextErrors[key] = `"${config.label}" must be at least ${config.min.toLocaleString()}`;
      }
    }

    const autoClaimCandidatesInPromptRaw = heartbeatValues.autoClaimCandidatesInPrompt?.trim();
    if (autoClaimCandidatesInPromptRaw) {
      const num = Number(autoClaimCandidatesInPromptRaw);
      if (!Number.isInteger(num) || num < 0 || num > 10) {
        nextErrors.autoClaimCandidatesInPrompt = "\"Auto-claim candidates in prompt\" must be an integer between 0 and 10";
      }
    }

    const messageResponseModeForValidation = heartbeatValues.messageResponseMode?.trim();
    if (messageResponseModeForValidation && !["immediate", "on-heartbeat"].includes(messageResponseModeForValidation)) {
      nextErrors.messageResponseMode = "\"Message Response Mode\" must be either immediate or on-heartbeat";
    }

    const tokenBudgetRaw = budgetValues.tokenBudget?.trim();
    if (tokenBudgetRaw) {
      const num = Number(tokenBudgetRaw);
      if (Number.isNaN(num) || !Number.isFinite(num)) {
        nextErrors.tokenBudget = "\"Token Budget\" must be a valid number";
      } else if (num <= 0) {
        nextErrors.tokenBudget = "\"Token Budget\" must be greater than 0";
      }
    }

    const usageThresholdRaw = budgetValues.usageThreshold?.trim();
    if (usageThresholdRaw) {
      const num = Number(usageThresholdRaw);
      if (Number.isNaN(num) || !Number.isFinite(num)) {
        nextErrors.usageThreshold = "\"Usage Threshold\" must be a valid number";
      } else if (num < 1 || num > 100) {
        nextErrors.usageThreshold = "\"Usage Threshold\" must be between 1 and 100";
      }
    }

    const budgetPeriodRaw = budgetValues.budgetPeriod?.trim();
    if (budgetPeriodRaw && !["daily", "weekly", "monthly", "lifetime"].includes(budgetPeriodRaw)) {
      nextErrors.budgetPeriod = "\"Budget Period\" must be one of: daily, weekly, monthly, lifetime";
    }

    const resetDayRaw = budgetValues.resetDay?.trim();
    const periodForResetDay = budgetPeriodRaw || "lifetime";
    if (resetDayRaw) {
      const num = Number(resetDayRaw);
      if (Number.isNaN(num) || !Number.isFinite(num)) {
        nextErrors.resetDay = "\"Reset Day\" must be a valid number";
      } else if (periodForResetDay === "weekly") {
        if (num < 0 || num > 6 || !Number.isInteger(num)) {
          nextErrors.resetDay = "\"Reset Day\" must be between 0 (Sunday) and 6 (Saturday) for weekly period";
        }
      } else if (periodForResetDay === "monthly") {
        if (num < 1 || num > 31 || !Number.isInteger(num)) {
          nextErrors.resetDay = "\"Reset Day\" must be between 1 and 31 for monthly period";
        }
      }
    }

    return nextErrors;
  }, [formValues, heartbeatValues, budgetValues]);

  const buildSavePayload = useCallback(() => {
    if (Object.keys(validationErrors).length > 0) {
      return null;
    }

    // Build the metadata payload — only include non-empty values
    const newMetadata: Record<string, unknown> = { ...agent.metadata };
    for (const field of ADVANCED_SETTINGS) {
      const raw = formValues[field.key]?.trim();
      if (!raw) {
        // Remove the key to use system default
        delete newMetadata[field.key];
      } else if (field.type === "number") {
        newMetadata[field.key] = Number(raw);
      } else {
        newMetadata[field.key] = raw;
      }
    }

    // Handle skills in metadata
    if (selectedSkills.length > 0) {
      newMetadata.skills = selectedSkills;
    } else {
      delete newMetadata.skills;
    }

    // Build the runtimeConfig payload — only include non-empty values
    const newRuntimeConfig: Record<string, unknown> = { ...agent.runtimeConfig };
    newRuntimeConfig.enabled = heartbeatEnabled;
    newRuntimeConfig.autoClaimRelevantTasks = autoClaimRelevantTasksEnabled;
    newRuntimeConfig.engineerBacklogAutoClaim = engineerBacklogAutoClaimEnabled;
    newRuntimeConfig.runMissedHeartbeatOnStartup = runMissedHeartbeatOnStartup;
    newRuntimeConfig.allowParallelExecution = allowParallelExecution;
    newRuntimeConfig.skipHeartbeatWhenIdle = skipHeartbeatWhenIdle;
    for (const key of ["heartbeatIntervalMs", "heartbeatTimeoutMs", "maxConcurrentRuns", "autoClaimCandidatesInPrompt"] as const) {
      const raw = heartbeatValues[key]?.trim();
      if (!raw) {
        delete newRuntimeConfig[key];
      } else {
        const num = Number(raw);
        newRuntimeConfig[key] = key === "maxConcurrentRuns" || key === "autoClaimCandidatesInPrompt" ? num : num * 1000;
      }
    }

    const messageResponseMode = heartbeatValues.messageResponseMode?.trim();
    if (!messageResponseMode) {
      delete newRuntimeConfig.messageResponseMode;
    } else {
      newRuntimeConfig.messageResponseMode = messageResponseMode;
    }

    if (!heartbeatScopeDiscipline) {
      delete newRuntimeConfig.heartbeatScopeDiscipline;
    } else {
      newRuntimeConfig.heartbeatScopeDiscipline = heartbeatScopeDiscipline;
    }

    if (!heartbeatPromptTemplate) {
      delete newRuntimeConfig.heartbeatPromptTemplate;
    } else {
      newRuntimeConfig.heartbeatPromptTemplate = heartbeatPromptTemplate;
    }

    if (runtimeMode === "runtime") {
      if (selectedRuntimeId.trim()) {
        newRuntimeConfig.runtimeHint = selectedRuntimeId.trim();
      } else {
        delete newRuntimeConfig.runtimeHint;
      }
      delete newRuntimeConfig.modelProvider;
      delete newRuntimeConfig.modelId;
      delete newRuntimeConfig.model;
    } else {
      delete newRuntimeConfig.runtimeHint;

      // Model override: parse "provider/modelId" into separate fields
      if (modelValue.trim()) {
        const slashIdx = modelValue.indexOf("/");
        if (slashIdx !== -1) {
          newRuntimeConfig.modelProvider = modelValue.slice(0, slashIdx);
          newRuntimeConfig.modelId = modelValue.slice(slashIdx + 1);
          newRuntimeConfig.model = modelValue.trim();
        }
      } else {
        delete newRuntimeConfig.modelProvider;
        delete newRuntimeConfig.modelId;
        delete newRuntimeConfig.model;
      }
    }

    // Build budgetConfig payload — only include non-empty values
    const newBudgetConfig: Record<string, unknown> = {};
    const tokenBudget = budgetValues.tokenBudget?.trim();
    const usageThreshold = budgetValues.usageThreshold?.trim();
    const budgetPeriod = budgetValues.budgetPeriod?.trim();
    const resetDay = budgetValues.resetDay?.trim();

    if (tokenBudget) {
      newBudgetConfig.tokenBudget = Number(tokenBudget);
    }
    if (usageThreshold) {
      // Convert percentage (UI) to fraction (storage)
      newBudgetConfig.usageThreshold = Number(usageThreshold) / 100;
    }
    if (budgetPeriod) {
      newBudgetConfig.budgetPeriod = budgetPeriod;
    }
    if (resetDay) {
      newBudgetConfig.resetDay = Number(resetDay);
    }

    // Only persist budgetConfig if it has any values
    if (Object.keys(newBudgetConfig).length > 0) {
      newRuntimeConfig.budgetConfig = newBudgetConfig;
    } else {
      delete newRuntimeConfig.budgetConfig;
    }

    // Build bundleConfig payload — only include if mode is set
    let newBundleConfig: { mode: "managed" | "external"; entryFile: string; files: string[]; externalPath?: string } | undefined;
    if (bundleMode) {
      newBundleConfig = {
        mode: bundleMode as "managed" | "external",
        entryFile: bundleEntryFile || "AGENTS.md",
        files: bundleFiles.length > 0 ? bundleFiles : ["AGENTS.md"],
      };
      if (bundleMode === "external" && bundleExternalPath.trim()) {
        newBundleConfig.externalPath = bundleExternalPath.trim();
      }
    }

    return {
      name: nameValue.trim() || undefined,
      role: roleValue,
      title: titleValue.trim() || undefined,
      icon: iconValue.trim() || undefined,
      reportsTo: reportsToValue.trim() || undefined,
      metadata: newMetadata,
      runtimeConfig: newRuntimeConfig,
      bundleConfig: newBundleConfig,
    };
  }, [agent.metadata, agent.runtimeConfig, allowParallelExecution, autoClaimRelevantTasksEnabled, budgetValues, bundleEntryFile, bundleExternalPath, bundleFiles, bundleMode, engineerBacklogAutoClaimEnabled, formValues, heartbeatEnabled, heartbeatPromptTemplate, heartbeatScopeDiscipline, heartbeatValues, iconValue, modelValue, nameValue, reportsToValue, roleValue, runMissedHeartbeatOnStartup, runtimeMode, selectedRuntimeId, selectedSkills, skipHeartbeatWhenIdle, titleValue, validationErrors]);

  const persistSettings = useCallback(async (showValidationToast: boolean, source: "auto" | "manual") => {
    const payload = buildSavePayload();
    if (!payload) {
      setErrors(validationErrors);
      if (showValidationToast) {
        addToast(t("agents.fixValidationErrors", "Please fix validation errors before saving"), "error");
      }
      if (source === "auto") {
        setAutoSaveError(t("agents.fixValidationToSave", "Fix validation errors to save changes"));
      }
      return false;
    }

    const signature = JSON.stringify(payload);
    if (signature === lastSavedSignatureRef.current) {
      return false;
    }

    const revision = ++saveRevisionRef.current;
    setErrors({});
    setAutoSaveError(null);
    setIsSaving(true);
    try {
      await updateAgent(agent.id, payload, projectId);
      if (revision !== saveRevisionRef.current) {
        return false;
      }
      lastSavedSignatureRef.current = signature;
      if (source === "manual") {
        addToast(t("agents.settingsSaved", "Settings saved"), "success");
      }
      setAutoSaveError(null);
      setJustSaved(true);
      if (justSavedTimeoutRef.current) {
        clearTimeout(justSavedTimeoutRef.current);
      }
      justSavedTimeoutRef.current = setTimeout(() => setJustSaved(false), 3000);
      await onSaved();
      return true;
    } catch (err) {
      if (revision === saveRevisionRef.current) {
        const message = getErrorMessage(err);
        setAutoSaveError(message);
        addToast(t("agents.settingsSaveFailed", "Failed to save settings: {{error}}", { error: message }), "error");
      }
      return false;
    } finally {
      if (revision === saveRevisionRef.current) {
        setIsSaving(false);
      }
    }
  }, [addToast, agent.id, buildSavePayload, onSaved, projectId, validationErrors]);

  const handleSave = async () => {
    await persistSettings(true, "manual");
  };

  const scheduleAutoSave = useCallback(() => {
    if (!hasChanges || isSaving) {
      return;
    }

    if (Object.keys(validationErrors).length > 0) {
      setErrors(validationErrors);
      return;
    }

    void persistSettings(false, "auto");
  }, [hasChanges, isSaving, persistSettings, validationErrors]);

  useEffect(() => {
    if (!hasChanges || isSaving) {
      return;
    }

    if (Object.keys(validationErrors).length > 0) {
      setErrors(validationErrors);
      return;
    }

    const timeout = setTimeout(() => {
      void persistSettings(false, "auto");
    }, CONFIG_AUTOSAVE_DEBOUNCE_MS);

    return () => clearTimeout(timeout);
  }, [hasChanges, isSaving, persistSettings, validationErrors]);

  const handleAvatarUpload = useCallback(async (file: File) => {
    setIsAvatarPending(true);
    try {
      await uploadAgentAvatar(agent.id, file, projectId);
      await onSaved();
      addToast(t("agents.avatarUploaded", "Avatar uploaded"), "success");
    } catch (error: unknown) {
      addToast(getErrorMessage(error), "error");
    } finally {
      setIsAvatarPending(false);
      if (avatarInputRef.current) {
        avatarInputRef.current.value = "";
      }
    }
  }, [addToast, agent.id, onSaved, projectId]);

  const handleAvatarDelete = useCallback(async () => {
    setIsAvatarPending(true);
    try {
      await deleteAgentAvatar(agent.id, projectId);
      await onSaved();
      addToast(t("agents.avatarRemoved", "Avatar removed"), "success");
    } catch (error: unknown) {
      addToast(getErrorMessage(error), "error");
    } finally {
      setIsAvatarPending(false);
    }
  }, [addToast, agent.id, onSaved, projectId]);

  const saveStatusLabel = isSaving
    ? t("agents.savingChanges", "Saving changes…")
    : autoSaveError
      ? t("agents.saveFailed", "Save failed: {{error}}", { error: autoSaveError })
      : !hasChanges && justSaved
        ? t("agents.allChangesSaved", "All changes saved")
        : null;

  return (
    <div className="config-tab">
      <div className="config-section">
        <h3>{t("agents.configTitle", "Agent Configuration")}</h3>
        <p className="config-description">
          {t("agents.configDescription", "Configure agent settings and behavior.")}
        </p>
        <div className="config-actions-row">
          <button type="button" className="btn btn-sm" onClick={() => setIsAiInterviewOpen(true)}>
            {t("agents.aiInterview", "AI Interview")}
          </button>
        </div>

        <div className="config-fields">
          <div className="config-field">
            <label htmlFor="agent-name">{t("agents.nameLabel", "Name")}</label>
            <input 
              id="agent-name"
              type="text" 
              className="input" 
              value={nameValue}
              onChange={(e) => setNameValue(e.target.value)}
              onBlur={() => { void scheduleAutoSave(); }}
            />
          </div>
          
          <div className="config-field">
            <label htmlFor="agent-role">{t("agents.roleLabel2", "Role")}</label>
            <select
              id="agent-role"
              className="select"
              value={roleValue}
              onChange={(e) => {
                setRoleValue(e.target.value as AgentCapability);
                void scheduleAutoSave();
              }}
            >
              <option value="triage">{t("agents.roleTriage", "Triage")}</option>
              <option value="executor">{t("agents.roleExecutor", "Executor")}</option>
              <option value="reviewer">{t("agents.roleReviewer", "Reviewer")}</option>
              <option value="merger">{t("agents.roleMerger", "Merger")}</option>
              <option value="scheduler">{t("agents.roleScheduler", "Scheduler")}</option>
              <option value="custom">{t("agents.roleCustom", "Custom")}</option>
            </select>
          </div>

          <div className="config-field">
            <label htmlFor="agent-title">{t("agents.titleLabel", "Title")}</label>
            <input
              id="agent-title"
              type="text"
              className="input"
              placeholder={t("agents.titlePlaceholder", "e.g. Senior Code Reviewer")}
              value={titleValue}
              onChange={(e) => setTitleValue(e.target.value)}
              onBlur={() => { void scheduleAutoSave(); }}
            />
          </div>

          <div className="config-field">
            <label>{t("agents.avatarLabel", "Avatar")}</label>
            <div className="agent-avatar-editor">
              <AgentAvatar agent={agent} size={64} className="agent-avatar-editor-preview" />
              <div className="agent-avatar-editor-actions">
                <input
                  ref={avatarInputRef}
                  id="agent-avatar-upload"
                  type="file"
                  accept="image/png,image/jpeg,image/gif,image/webp"
                  className="visually-hidden"
                  disabled={isAvatarPending}
                  onChange={(event) => {
                    const selectedFile = event.target.files?.[0];
                    if (selectedFile) {
                      void handleAvatarUpload(selectedFile);
                    }
                  }}
                />
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={isAvatarPending}
                  onClick={() => avatarInputRef.current?.click()}
                >
                  {t("agents.uploadAvatar", "Upload Avatar")}
                </button>
                {agent.imageUrl ? (
                  <button type="button" className="btn btn-sm" onClick={() => void handleAvatarDelete()} disabled={isAvatarPending}>
                    {t("agents.removeAvatar", "Remove Avatar")}
                  </button>
                ) : null}
              </div>
            </div>
          </div>

          <div className="config-field">
            <label htmlFor="agent-icon">{t("agents.iconLabel", "Icon")}</label>
            <input
              id="agent-icon"
              type="text"
              className="input"
              placeholder={t("agents.iconPlaceholder", "e.g. 🤖")}
              value={iconValue}
              onChange={(e) => setIconValue(e.target.value)}
              onBlur={() => { void scheduleAutoSave(); }}
            />
          </div>

          <div className="config-field">
            <label htmlFor="agent-reports-to">{t("agents.reportsToLabel", "Reports To")}</label>
            <select
              id="agent-reports-to"
              className="select"
              value={reportsToValue}
              onChange={(e) => {
                setReportsToValue(e.target.value);
                void scheduleAutoSave();
              }}
              disabled={isLoadingManagers}
            >
              <option value="">{t("agents.noManager", "No manager")}</option>
              {hasMissingManagerSelection && (
                <option value={managerSelection}>{t("agents.unknownManager", "Unknown manager ({{id}})", { id: managerSelection })}</option>
              )}
              {availableManagers.map((manager) => (
                <option key={manager.id} value={manager.id}>
                  {manager.name} ({manager.id})
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      <div className="config-section">
        <h3>{t("agents.skillsTitle", "Skills")}</h3>
        <p className="config-description">
          {t("agents.skillsDescription", "Assign skills to this agent for specialized behavior.")}
        </p>

        <div className="config-fields">
          <div className="config-field">
            <SkillMultiselect
              id="agent-skills"
              label="Skills"
              value={selectedSkills}
              onChange={(nextSkills) => {
                setSelectedSkills(nextSkills);
                void scheduleAutoSave();
              }}
              projectId={projectId}
            />
          </div>
        </div>
      </div>

      <div className="config-section">
        <h3>{t("agents.modelTitle", "Model")}</h3>
        <p className="config-description">
          {t("agents.modelDescription", "Choose either a built-in model or a plugin runtime for this agent. These options are mutually exclusive.")}
        </p>

        <div className="config-fields">
          <div className="config-field">
            <label>{t("agents.runtimeSource", "Runtime Source")}</label>
            <div className="config-runtime-tabs" role="tablist" aria-label={t("agents.runtimeSource", "Runtime source")}>
              <button
                type="button"
                className={`config-runtime-tab${runtimeMode === "model" ? " active" : ""}`}
                role="tab"
                aria-selected={runtimeMode === "model"}
                tabIndex={runtimeMode === "model" ? 0 : -1}
                onClick={() => {
                  setRuntimeMode("model");
                  setSelectedRuntimeId("");
                  void scheduleAutoSave();
                }}
              >
                {t("agents.builtInModel", "Built-in Model")}
              </button>
              <button
                type="button"
                className={`config-runtime-tab${runtimeMode === "runtime" ? " active" : ""}`}
                role="tab"
                aria-selected={runtimeMode === "runtime"}
                tabIndex={runtimeMode === "runtime" ? 0 : -1}
                onClick={() => {
                  setRuntimeMode("runtime");
                  void scheduleAutoSave();
                }}
              >
                {t("agents.pluginRuntime", "Plugin Runtime")}
              </button>
            </div>
          </div>

          {runtimeMode === "model" ? (
            <div className="config-field">
              <CustomModelDropdown
                models={availableModels}
                value={modelValue}
                onChange={(value) => {
                  setModelValue(value);
                  void scheduleAutoSave();
                }}
                placeholder={t("agents.useGlobalDefault", "Use global default")}
                label={t("agents.agentModelLabel", "Agent Model")}
                disabled={modelsLoading}
                favoriteProviders={favoriteProviders}
                onToggleFavorite={toggleFavoriteProvider}
                favoriteModels={favoriteModels}
                onToggleModelFavorite={toggleFavoriteModel}
              />
            </div>
          ) : (
            <div className="config-field">
              <label htmlFor="agent-runtime-hint">{t("agents.runtimeLabel", "Runtime")}</label>
              {runtimesLoading ? (
                <span className="config-hint"><LoadingSpinner label={t("agents.loadingRuntimes", "Loading runtimes…")} /></span>
              ) : (
                <select
                  id="agent-runtime-hint"
                  className="select"
                  value={selectedRuntimeId}
                  onChange={(e) => {
                    setSelectedRuntimeId(e.target.value);
                    void scheduleAutoSave();
                  }}
                >
                  <option value="">
                    {availableRuntimes.length > 0 ? t("agents.selectRuntime", "Select a plugin runtime…") : t("agents.noRuntimes", "No plugin runtimes available")}
                  </option>
                  {availableRuntimes.map((runtime) => (
                    <option key={`${runtime.pluginId}:${runtime.runtimeId}`} value={runtime.runtimeId}>
                      {runtime.description ? `${runtime.name} — ${runtime.description}` : runtime.name}
                    </option>
                  ))}
                </select>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="config-section">
        <h3>{t("agents.permissionsTitle", "Permissions")}</h3>
        <p className="config-description">
          {t("agents.permissionsDescription", "Per-agent settings override project defaults. Each category controls a separate approval gate.")}
        </p>
        <div className="agent-capability-grants" data-testid="agent-capability-grants">
          <h4>{t("agents.capabilityGrantsTitle", "Capability grants")}</h4>
          <p className="config-hint">
            {t("agents.capabilityGrantsDescription", "Explicit grants add to this agent's role defaults and apply to both permanent and ephemeral agents.")}
          </p>
          <div className="agent-capability-grants-grid">
            {AGENT_PERMISSIONS.map((permission) => {
              const roleDefault = roleDefaultPermissions.has(permission);
              const explicitGrant = explicitPermissionSet.has(permission);
              const inputId = `agent-capability-${agent.id}-${permission.replace(/[^a-z0-9]+/gi, "-")}`;
              return (
                <label key={permission} className="agent-capability-grant-row" htmlFor={inputId}>
                  <span>
                    <span className="agent-capability-grant-name">{permission}</span>
                    <span className="config-hint">
                      {roleDefault
                        ? t("agents.roleDefaultGrant", "Role default grant")
                        : explicitGrant
                          ? t("agents.explicitGrant", "Explicit grant")
                          : t("agents.notGranted", "Not granted")}
                    </span>
                  </span>
                  <input
                    id={inputId}
                    type="checkbox"
                    checked={explicitGrant}
                    aria-label={t("agents.toggleCapabilityGrant", "Toggle explicit grant for {{permission}}", { permission })}
                    onChange={(event) => { void handleCapabilityPermissionChange(permission, event.target.checked); }}
                  />
                </label>
              );
            })}
          </div>
        </div>

        {permissionPolicyValue === undefined ? (
          <div className="agent-permission-inherit-banner">
            <span>{t("agents.inheritingProjectDefault", "Inheriting project default — no per-agent override set")}</span>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => void handlePermissionPolicyChange({
                presetId: "custom",
                rules: {
                  git_write: projectDefaultPermissionPolicy?.rules?.git_write ?? "allow",
                  file_write_delete: projectDefaultPermissionPolicy?.rules?.file_write_delete ?? "allow",
                  command_execution: projectDefaultPermissionPolicy?.rules?.command_execution ?? "allow",
                  network_api: projectDefaultPermissionPolicy?.rules?.network_api ?? "allow",
                  task_agent_mutation: projectDefaultPermissionPolicy?.rules?.task_agent_mutation ?? "allow",
                  // FNXC:ToolPermissions 2026-07-09-00:00: FN-7728 — review_gate_bypass defaults stricter than the other categories (require-approval, not allow) to mirror the unrestricted preset's targeted override for this merge-gate bypass category.
                  review_gate_bypass: projectDefaultPermissionPolicy?.rules?.review_gate_bypass ?? "require-approval",
                  // FNXC:ToolPermissions 2026-07-09-08:30: FN-7737 — file_scope keeps the uniform grant-all default (allow), unlike review_gate_bypass.
                  file_scope: projectDefaultPermissionPolicy?.rules?.file_scope ?? "allow",
                },
              })}
            >
              {t("agents.customizeForAgent", "Customize for this agent")}
            </button>
          </div>
        ) : null}
        {/* Provisioning policy (fn_agent_create/fn_agent_delete) is project-scoped only; no per-agent override UI here by design. */}
        <AgentPermissionPolicyEditor
          mode="agent-override"
          value={permissionPolicyValue}
          projectDefault={projectDefaultPermissionPolicy?.rules}
          projectDefaultToolRules={projectDefaultPermissionPolicy?.toolRules}
          onChange={(next) => { void handlePermissionPolicyChange(next); }}
        />
      </div>

      <div className="config-section">
        <h3>{t("agents.heartbeatSettingsTitle", "Heartbeat Settings")}</h3>
        <p className="config-description">
          {t("agents.heartbeatSettingsDesc", "Configure how this agent's heartbeat is monitored. Leave a field empty to use system defaults.")}
        </p>

        <div className="config-fields">
          <div className="config-field agent-heartbeat-auto-claim-card">
            <div className="agent-heartbeat-preset-row">
              <div>
                <label className="agent-heartbeat-preset-label">{t("agents.coordinationOnlyAgent", "Coordination-only agent")}</label>
                <span className="config-hint">{t("agents.coordinationOnlyHint", "Disables auto-claim and removes the candidate section from heartbeat prompts. Recommended for routing/CEO-style agents.")}</span>
              </div>
              <button
                type="button"
                className="btn btn-sm agent-heartbeat-preset-btn"
                onClick={() => {
                  setAutoClaimRelevantTasksEnabled(false);
                  setHeartbeatValues((prev) => ({ ...prev, autoClaimCandidatesInPrompt: "0" }));
                  void scheduleAutoSave();
                }}
              >
                {t("agents.applyPreset", "Apply preset")}
              </button>
            </div>
            <label className="checkbox-label" htmlFor="hb-autoClaimRelevantTasks">
              <input
                id="hb-autoClaimRelevantTasks"
                type="checkbox"
                checked={autoClaimRelevantTasksEnabled}
                onChange={(e) => {
                  setAutoClaimRelevantTasksEnabled(e.target.checked);
                  void scheduleAutoSave();
                }}
              />
              {t("agents.autoClaimRelevantTasks", "Auto-Claim Relevant Tasks")}
            </label>
            <span className="config-hint">{t("agents.autoClaimHint", "When enabled (default), no-task heartbeats scan open unowned work and auto-claim tasks aligned with this agent's role and soul.")}</span>
            <label className="checkbox-label" htmlFor="hb-engineerBacklogAutoClaim">
              <input
                id="hb-engineerBacklogAutoClaim"
                type="checkbox"
                checked={engineerBacklogAutoClaimEnabled}
                onChange={(e) => {
                  setEngineerBacklogAutoClaimEnabled(e.target.checked);
                  void scheduleAutoSave();
                }}
              />
              {t("agents.engineerBacklogAutoClaim", "Engineer Backlog Auto-Claim")}
            </label>
            <span className="config-hint">{t("agents.engineerBacklogAutoClaimHint", "Per-agent override of the project default. Allows this engineer-role agent to auto-claim unowned backlog tasks; explicit assignment and delegation are unchanged.")}</span>
          </div>

          <div className="config-field">
            <label className="checkbox-label" htmlFor="hb-enabled">
              <input
                id="hb-enabled"
                type="checkbox"
                checked={heartbeatEnabled}
                onChange={(e) => {
                  handleHeartbeatEnabledChange(e.target.checked);
                  void scheduleAutoSave();
                }}
              />
              {t("agents.heartbeatEnabled", "Heartbeat Enabled")}
            </label>
            <span className="config-hint">{t("agents.heartbeatEnabledHint", "When enabled, this agent receives scheduled heartbeat runs based on its interval.")}</span>
          </div>

          <div className="config-field">
            <label className="checkbox-label" htmlFor="hb-runMissedHeartbeatOnStartup">
              <input
                id="hb-runMissedHeartbeatOnStartup"
                type="checkbox"
                checked={runMissedHeartbeatOnStartup}
                onChange={(e) => {
                  setRunMissedHeartbeatOnStartup(e.target.checked);
                  void scheduleAutoSave();
                }}
              />
              {t("agents.runMissedHeartbeat", "Run Missed Heartbeat On Startup")}
            </label>
            <span className="config-hint">{t("agents.runMissedHeartbeatHint", "When enabled, if the server was down across this agent's scheduled heartbeat tick, fire a single catch-up heartbeat at startup. Default: off.")}</span>
          </div>

          <div className="config-field">
            <label className="checkbox-label" htmlFor="hb-allowParallelExecution">
              <input
                id="hb-allowParallelExecution"
                type="checkbox"
                checked={allowParallelExecution}
                onChange={(e) => {
                  setAllowParallelExecution(e.target.checked);
                  void scheduleAutoSave();
                }}
              />
              {t("agents.allowParallelExecution", "Allow Parallel Execution")}
            </label>
            <span className="config-hint">{t("agents.allowParallelExecutionHint", "When disabled, the heartbeat and task execution paths serialize for this agent (heartbeat will not start while the agent's task is executing, and vice versa). Permanent agents only.")}</span>
          </div>

          <div className="config-field">
            <label className="checkbox-label" htmlFor="hb-skipHeartbeatWhenIdle">
              <input
                id="hb-skipHeartbeatWhenIdle"
                type="checkbox"
                checked={skipHeartbeatWhenIdle}
                onChange={(e) => {
                  setSkipHeartbeatWhenIdle(e.target.checked);
                  void scheduleAutoSave();
                }}
              />
              {t("agents.skipHeartbeatWhenIdle", "Skip heartbeat when idle")}
            </label>
            <span className="config-hint">{t("agents.skipHeartbeatWhenIdleHint", "When enabled, scheduled (timer) heartbeats are skipped while this agent has no assigned task. The agent still wakes immediately when a task is assigned or you trigger a run manually. Default: off.")}</span>
          </div>

          <div className="config-field">
            <label htmlFor="hb-heartbeatScopeDiscipline">{t("agents.heartbeatScopeDiscipline", "Heartbeat Scope Discipline")}</label>
            <select
              id="hb-heartbeatScopeDiscipline"
              className="select"
              value={heartbeatScopeDiscipline}
              onChange={(e) => {
                const value = e.target.value;
                setHeartbeatScopeDiscipline(value === "strict" || value === "lite" || value === "off" ? value : "");
                void scheduleAutoSave();
              }}
            >
              <option value="">{t("agents.inheritProjectDefault", "Inherit project default")}</option>
              <option value="strict">{t("agents.strict", "Strict")}</option>
              <option value="lite">{t("agents.lite", "Lite")}</option>
              <option value="off">{t("agents.off", "Off")}</option>
            </select>
            <span className="config-hint">{t("agents.scopeDisciplineHint", "Strict — coordination-focused; higher per-tick tokens. Lite — pre-2026-05-11 behavior. Off — minimal procedure.")}</span>
          </div>

          <div className="config-field">
            <label htmlFor="hb-heartbeatPromptTemplate">{t("agents.heartbeatPromptTemplate", "Heartbeat Prompt Template")}</label>
            <select
              id="hb-heartbeatPromptTemplate"
              className="select"
              value={heartbeatPromptTemplate}
              onChange={(e) => {
                const value = e.target.value;
                setHeartbeatPromptTemplate(value === "default" || value === "compact" ? value : "");
                void scheduleAutoSave();
              }}
            >
              <option value="">{t("agents.inheritProjectDefault", "Inherit project default")}</option>
              <option value="default">{t("agents.templateDefault", "Default")}</option>
              <option value="compact">{t("agents.templateCompact", "Compact")}</option>
            </select>
          </div>

          <div className="config-field">
            <label htmlFor="hb-heartbeatIntervalMs">{t("agents.heartbeatIntervalLabel", "Heartbeat Interval (s)")}</label>
            <input
              id="hb-heartbeatIntervalMs"
              type="text"
              inputMode="numeric"
              className={cn("input", !!errors.heartbeatIntervalMs && "input--error")}
              placeholder={String(DEFAULT_HEARTBEAT_INTERVAL_MS / 1000)}
              value={heartbeatValues.heartbeatIntervalMs ?? ""}
              onChange={(e) => handleHeartbeatFieldChange("heartbeatIntervalMs", e.target.value)}
            />
            {errors.heartbeatIntervalMs ? (
              <span className="config-error">{errors.heartbeatIntervalMs}</span>
            ) : (
              <span className="config-hint">
                {t("agents.heartbeatIntervalHint", "How often heartbeats are checked. Leave empty for system default ({{seconds}}s / {{label}}).", { seconds: DEFAULT_HEARTBEAT_INTERVAL_MS / 1000, label: DEFAULT_HEARTBEAT_INTERVAL_LABEL })}
              </span>
            )}
          </div>

          <div className="config-field">
            <label htmlFor="hb-heartbeatTimeoutMs">{t("agents.heartbeatTimeoutLabel", "Heartbeat Timeout (s)")}</label>
            <input
              id="hb-heartbeatTimeoutMs"
              type="text"
              inputMode="numeric"
              className={cn("input", !!errors.heartbeatTimeoutMs && "input--error")}
              placeholder="60"
              value={heartbeatValues.heartbeatTimeoutMs ?? ""}
              onChange={(e) => handleHeartbeatFieldChange("heartbeatTimeoutMs", e.target.value)}
            />
            {errors.heartbeatTimeoutMs ? (
              <span className="config-error">{errors.heartbeatTimeoutMs}</span>
            ) : (
              <span className="config-hint">{t("agents.heartbeatTimeoutHint", "Time without heartbeat before agent is considered unresponsive. Leave empty for system default (60s)")}</span>
            )}
          </div>

          <div className="config-field">
            <label htmlFor="hb-maxConcurrentRuns">{t("agents.maxConcurrentRunsLabel", "Max Concurrent Runs")}</label>
            <input
              id="hb-maxConcurrentRuns"
              type="text"
              inputMode="numeric"
              className={cn("input", !!errors.maxConcurrentRuns && "input--error")}
              placeholder="1"
              value={heartbeatValues.maxConcurrentRuns ?? ""}
              onChange={(e) => handleHeartbeatFieldChange("maxConcurrentRuns", e.target.value)}
            />
            {errors.maxConcurrentRuns ? (
              <span className="config-error">{errors.maxConcurrentRuns}</span>
            ) : (
              <span className="config-hint">{t("agents.maxConcurrentRunsHint", "Maximum simultaneous heartbeat runs for this agent. Leave empty for system default (1).")}</span>
            )}
          </div>

          <div className="config-field">
            <label htmlFor="hb-messageResponseMode">{t("agents.messageResponseModeLabel", "Message Response Mode")}</label>
            <select
              id="hb-messageResponseMode"
              className={cn("select", !!errors.messageResponseMode && "input--error")}
              value={heartbeatValues.messageResponseMode ?? ""}
              onChange={(e) => handleHeartbeatFieldChange("messageResponseMode", e.target.value)}
            >
              <option value="">{t("agents.systemDefaultOnHeartbeat", "System Default (On Heartbeat)")}</option>
              <option value="on-heartbeat">{t("agents.onHeartbeat", "On Heartbeat")}</option>
              <option value="immediate">{t("agents.immediate", "Immediate")}</option>
            </select>
            {errors.messageResponseMode ? (
              <span className="config-error">{errors.messageResponseMode}</span>
            ) : (
              <span className="config-hint">{t("agents.messageResponseModeHint", "How this agent responds to incoming messages. 'Immediate' wakes the agent as soon as a message arrives. 'On Heartbeat' defers processing to the next scheduled heartbeat.")}</span>
            )}
          </div>
        </div>
      </div>

      <div className="config-section">
        <h3>{t("agents.budgetSettingsTitle", "Budget Settings")}</h3>
        <p className="config-description">
          {t("agents.budgetSettingsDesc", "Configure token budget limits for this agent. Leave all fields empty to disable budget tracking.")}
        </p>

        <div className="config-fields">
          <div className="config-field">
            <label htmlFor="budget-tokenBudget">{t("agents.tokenBudgetLabel", "Token Budget")}</label>
            <input
              id="budget-tokenBudget"
              type="text"
              inputMode="numeric"
              className={cn("input", !!errors.tokenBudget && "input--error")}
              placeholder={t("agents.noLimit", "No limit")}
              value={budgetValues.tokenBudget ?? ""}
              onChange={(e) => handleBudgetFieldChange("tokenBudget", e.target.value)}
            />
            {errors.tokenBudget ? (
              <span className="config-error">{errors.tokenBudget}</span>
            ) : (
              <span className="config-hint">{t("agents.tokenBudgetHint", "Total token cap (input + output) for this agent. Leave empty for no limit.")}</span>
            )}
          </div>

          <div className="config-field">
            <label htmlFor="budget-usageThreshold">{t("agents.usageThresholdLabel", "Usage Threshold (%)")}</label>
            <input
              id="budget-usageThreshold"
              type="text"
              inputMode="numeric"
              className={cn("input", !!errors.usageThreshold && "input--error")}
              placeholder="80"
              value={budgetValues.usageThreshold ?? ""}
              onChange={(e) => handleBudgetFieldChange("usageThreshold", e.target.value)}
            />
            {errors.usageThreshold ? (
              <span className="config-error">{errors.usageThreshold}</span>
            ) : (
              <span className="config-hint">{t("agents.usageThresholdHint", "Warning threshold as a percentage. Agent warns when usage reaches this level. Default: 80%.")}</span>
            )}
          </div>

          <div className="config-field">
            <label htmlFor="budget-budgetPeriod">{t("agents.budgetPeriodLabel", "Budget Period")}</label>
            <select
              id="budget-budgetPeriod"
              className={cn("select", !!errors.budgetPeriod && "input--error")}
              value={budgetValues.budgetPeriod ?? ""}
              onChange={(e) => handleBudgetFieldChange("budgetPeriod", e.target.value)}
            >
              <option value="">{t("agents.noReset", "No reset (lifetime)")}</option>
              <option value="daily">{t("agents.daily", "Daily")}</option>
              <option value="weekly">{t("agents.weekly", "Weekly")}</option>
              <option value="monthly">{t("agents.monthly", "Monthly")}</option>
            </select>
            {errors.budgetPeriod ? (
              <span className="config-error">{errors.budgetPeriod}</span>
            ) : (
              <span className="config-hint">{t("agents.budgetPeriodHint", "How often the budget counter resets. Leave empty for lifetime budget.")}</span>
            )}
          </div>

          <div className="config-field">
            <label htmlFor="budget-resetDay">{t("agents.resetDayLabel", "Reset Day")}</label>
            <input
              id="budget-resetDay"
              type="text"
              inputMode="numeric"
              className={cn("input", !!errors.resetDay && "input--error")}
              placeholder={t("agents.auto", "Auto")}
              value={budgetValues.resetDay ?? ""}
              onChange={(e) => handleBudgetFieldChange("resetDay", e.target.value)}
            />
            {errors.resetDay ? (
              <span className="config-error">{errors.resetDay}</span>
            ) : (
              <span className="config-hint">
                {budgetValues.budgetPeriod === "weekly"
                  ? t("agents.resetDayWeekly", "Day of week (0=Sunday to 6=Saturday) for reset.")
                  : budgetValues.budgetPeriod === "monthly"
                    ? t("agents.resetDayMonthly", "Day of month (1-31) for reset.")
                    : t("agents.resetDayHint", "Day for reset (weekly: 0-6, monthly: 1-31). Leave empty for automatic.")}
              </span>
            )}
          </div>

          {/* Budget Usage Progress Bar */}
          {budgetStatus?.budgetLimit != null && (
            <div className="config-field">
              <label>{t("agents.currentUsage", "Current Usage")}</label>
              <div className="budget-progress-container">
                <div className="budget-progress-bar">
                  <div
                    className={cn(
                      "budget-progress-bar__fill",
                      (budgetStatus.usagePercent ?? 0) >= 100
                        ? "budget-progress-bar__fill--red"
                        : (budgetStatus.usagePercent ?? 0) >= 80
                          ? "budget-progress-bar__fill--amber"
                          : "budget-progress-bar__fill--green"
                    )}
                    style={{ width: `${Math.min(budgetStatus.usagePercent ?? 0, 100)}%` }}
                  />
                </div>
                <span className="budget-progress-label">
                  {t("agents.budgetUsageDisplay", "{{used}} / {{limit}} tokens ({{percent}}% used)", { used: (budgetStatus.currentUsage ?? 0).toLocaleString(), limit: (budgetStatus.budgetLimit ?? 0).toLocaleString(), percent: Math.round(budgetStatus.usagePercent ?? 0) })}
                </span>
              </div>
            </div>
          )}

          {/* Reset Budget Button */}
          {budgetStatus?.budgetLimit != null && (
            <div className="config-field">
              <button
                className="btn btn-reset-budget"
                onClick={() => void handleResetBudget()}
                disabled={isResettingBudget}
              >
                {isResettingBudget ? (
                  <>
                    <Loader2 size={14} className="animate-spin" />
                    {t("agents.resetting", "Resetting…")}
                  </>
                ) : (
                  <>
                    <RefreshCw size={14} />
                    {t("agents.resetBudgetUsage", "Reset Budget Usage")}
                  </>
                )}
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="config-section">
        <h3>{t("agents.bundleTitle", "Instruction Bundle")}</h3>
        <p className="config-description">
          {t("agents.bundleDescription", "Configure the agent's instruction bundle. Leave empty to use inline instructions only.")}
        </p>

        <div className="config-fields">
          <div className="config-field">
            <label htmlFor="bundle-mode">{t("agents.bundleModeLabel", "Bundle Mode")}</label>
            <select
              id="bundle-mode"
              className="select"
              value={bundleMode}
              onChange={(e) => setBundleMode(e.target.value)}
            >
              <option value="">{t("agents.bundleNone", "None (use inline instructions)")}</option>
              <option value="managed">{t("agents.bundleManaged", "Managed (system-managed directory)")}</option>
              <option value="external">{t("agents.bundleExternal", "External (user-specified path)")}</option>
            </select>
            <span className="config-hint">
              {bundleMode === "managed" && t("agents.bundleManagedHint", "Files will be stored in a system-managed directory within .fusion/agents/")}
              {bundleMode === "external" && t("agents.bundleExternalHint", "Specify an external directory path for the instruction files")}
              {!bundleMode && t("agents.bundleSelectMode", "Select a mode to enable instruction bundling")}
            </span>
          </div>

          {bundleMode && (
            <>
              <div className="config-field">
                <label htmlFor="bundle-entry-file">{t("agents.bundleEntryFileLabel", "Entry File")}</label>
                <input
                  id="bundle-entry-file"
                  type="text"
                  className="input"
                  placeholder="AGENTS.md"
                  value={bundleEntryFile}
                  onChange={(e) => setBundleEntryFile(e.target.value)}
                />
                <span className="config-hint">{t("agents.bundleEntryFileHint", "Primary instructions file name (default: AGENTS.md)")}</span>
              </div>

              {bundleMode === "external" && (
                <div className="config-field">
                  <label htmlFor="bundle-external-path">{t("agents.bundleExternalPathLabel", "External Path")}</label>
                  <input
                    id="bundle-external-path"
                    type="text"
                    className="input"
                    placeholder={t("agents.bundleExternalPathPlaceholder", "e.g. .fusion/agents/my-agent")}
                    value={bundleExternalPath}
                    onChange={(e) => setBundleExternalPath(e.target.value)}
                  />
                  <span className="config-hint">{t("agents.bundleExternalPathHint", "Absolute or relative path to the external directory")}</span>
                </div>
              )}

              <div className="config-field">
                <label htmlFor="bundle-files">{t("agents.bundleFilesLabel", "Files (comma-separated)")}</label>
                <input
                  id="bundle-files"
                  type="text"
                  className="input"
                  placeholder="AGENTS.md, PROMPTS.md"
                  value={bundleFiles.join(", ")}
                  onChange={(e) => setBundleFiles(
                    e.target.value.split(",").map(f => f.trim()).filter(Boolean)
                  )}
                />
                <span className="config-hint">{t("agents.bundleFilesHint", "List of file names in the bundle directory")}</span>
              </div>
            </>
          )}
        </div>
      </div>

      <div className="config-section">
        <h3>{t("agents.advancedSettingsTitle", "Advanced Settings")}</h3>
        <p className="config-description">
          {t("agents.advancedSettingsDesc", "Advanced configuration options for this agent. Leave a field empty to use system defaults.")}
        </p>

        <div className="config-fields">
          {ADVANCED_SETTINGS.map((field) => {
            const hasError = !!errors[field.key];
            return (
              <div className="config-field" key={field.key}>
                <label htmlFor={`adv-${field.key}`}>{field.label}</label>
                {field.type === "select" ? (
                  <select
                    id={`adv-${field.key}`}
                    className={cn("select", hasError && "input--error")}
                    value={formValues[field.key] ?? ""}
                    onChange={(e) => handleFieldChange(field.key, e.target.value)}
                  >
                    <option value="">{t("agents.systemDefault", "System Default")}</option>
                    {field.options?.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    id={`adv-${field.key}`}
                    type="text"
                    inputMode={field.type === "number" ? "numeric" : undefined}
                    className={cn("input", hasError && "input--error")}
                    placeholder={field.placeholder}
                    value={formValues[field.key] ?? ""}
                    onChange={(e) => handleFieldChange(field.key, e.target.value)}
                  />
                )}
                {hasError && (
                  <span className="config-error">{errors[field.key]}</span>
                )}
                {!hasError && field.hint && (
                  <span className="config-hint">{field.hint}</span>
                )}
              </div>
            );
          })}
        </div>

        <div className="config-actions">
          <button
            className="btn btn-task-create"
            disabled={!hasChanges || isSaving}
            onClick={() => void handleSave()}
          >
            {isSaving ? (
              <>
                <Loader2 size={16} className="animate-spin" />
                {t("common.saving", "Saving…")}
              </>
            ) : (
              <>
                <CheckCircle size={16} />
                {t("agents.saveSettings", "Save Settings")}
              </>
            )}
          </button>
          {saveStatusLabel && (
            <span className={cn("config-saved-indicator", autoSaveError && "config-saved-indicator--error")}>
              {isSaving ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle size={14} />}
              {saveStatusLabel}
            </span>
          )}
        </div>
      </div>

      <HeartbeatProcedureSection
        agent={agent}
        projectId={projectId}
        addToast={addToast}
        onSaved={onSaved}
      />

      <div className="config-section config-section--danger">
        <h3>{t("agents.dangerZone", "Danger Zone")}</h3>
        <p className="config-description">
          {t("agents.dangerZoneDesc", "Permanently delete this agent from the project.")}
        </p>
        <div className="config-fields">
          <div className="config-field">
            <button
              className="btn btn--danger"
              disabled={!isDeletableState || !onDelete}
              onClick={() => void onDelete?.()}
            >
              <Trash2 size={16} />
              {t("agents.deleteAgent", "Delete Agent")}
            </button>
            <span className="config-danger-note">
              {isDeletableState
                ? t("agents.deletionPermanent", "Deletion is permanent and cannot be undone.")
                : t("agents.deletionNotAvailable", "Agent deletion is only available when state is idle or paused (current state: {{state}}).", { state: agent.state })}
            </span>
          </div>
        </div>
      </div>

      <ExperimentalAgentOnboardingModal
        isOpen={isAiInterviewOpen}
        onClose={() => setIsAiInterviewOpen(false)}
        onUseDraft={applyInterviewDraft}
        projectId={projectId}
        existingAgents={managerOptions}
        mode="edit"
        existingAgentConfig={existingAgentConfig}
      />
    </div>
  );
}

// ── Employees Tab ───────────────────────────────────────────────────────────

function EmployeesTab({
  agentId,
  projectId,
  onChildClick,
}: {
  agentId: string;
  projectId?: string;
  onChildClick?: (childId: string) => void;
}) {
  const { t } = useTranslation("app");
  const [children, setChildren] = useState<Agent[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    setIsLoading(true);
    fetchAgentChildren(agentId, projectId)
      .then(setChildren)
      .finally(() => setIsLoading(false));
  }, [agentId, projectId]);

  if (isLoading) {
    return (
      <div className="detail-section">
        <div className="detail-section-header">
          <h3>{t("agents.employeesTitle", "Employees")}</h3>
        </div>
        <div className="detail-section-body detail-section-body--loading">
          <Loader2 size={16} className="spin" />
          <span className="text-muted">{t("agents.loadingEmployees", "Loading employees...")}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="detail-section">
      <div className="detail-section-header">
        <h3>{t("agents.employeesTitle", "Employees")}</h3>
        <span className="text-muted">({children.length})</span>
      </div>
      <div className="detail-section-body">
        {children.length === 0 ? (
          <div className="agent-empty agent-empty--padded">
            <GitBranch size={32} opacity={0.3} />
            <p>{t("agents.noEmployees", "No employees")}</p>
            <p className="text-muted">{t("agents.noEmployeesDesc", "This agent has no employees")}</p>
          </div>
        ) : (
          <div className="agent-tree__children">
            {children.map((child) => {
              const stateStyle = STATE_COLORS[child.state as AgentState];
              return (
                <div
                  key={child.id}
                  className={`agent-tree__node agent-is-child`}
                  onClick={() => onChildClick?.(child.id)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      if (e.key === " ") {
                        e.preventDefault();
                      }
                      onChildClick?.(child.id);
                    }
                  }}
                  style={{ cursor: onChildClick ? "pointer" : "default" }}
                >
                  <span className="agent-tree__icon">{child.icon ?? "🤖"}</span>
                  <span className="agent-tree__name">{child.name}</span>
                  <span
                    className="agent-tree__badge"
                    style={{
                      background: stateStyle?.bg ?? "var(--state-idle-bg)",
                      color: stateStyle?.text ?? "var(--state-idle-text)",
                      border: `1px solid ${stateStyle?.border ?? "var(--state-idle-border)"}`,
                    }}
                  >
                    {child.state}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
