import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import type { Task } from "@fusion/core";
import { getErrorMessage } from "@fusion/core";
import {
  startSubtaskBreakdown,
  retrySubtaskSession,
  connectSubtaskStream,
  createTasksFromBreakdown,
  fetchAiSession,
  parseConversationHistory,
  type SubtaskItem,
  type ConversationHistoryEntry,
} from "../api";
import {
  saveSubtaskDescription,
  getSubtaskDescription,
  clearSubtaskDescription,
} from "../hooks/modalPersistence";
import { CheckCircle, Loader2, ListTree, Plus, Trash2, X, GripVertical, ArrowUp, ArrowDown, Minimize2, RefreshCw, Lock } from "lucide-react";
import { ConversationHistory } from "./ConversationHistory";
import { useSessionLock } from "../hooks/useSessionLock";
import { useAiSessionSync } from "../hooks/useAiSessionSync";
import { useConfirm } from "../hooks/useConfirm";
import { useMobileKeyboard } from "../hooks/useMobileKeyboard";
import { useMobileScrollLock } from "../hooks/useMobileScrollLock";
import { useViewportMode } from "../hooks/useViewportMode";
import { getSessionTabId } from "../utils/getSessionTabId";

interface SubtaskBreakdownModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialDescription: string;
  onTasksCreated: (tasks: Task[]) => void;
  parentTaskId?: string;
  projectId?: string;
  resumeSessionId?: string;
  onOpenGroupModal?: (groupId: string) => void;
}

type ViewState =
  | { type: "initial" }
  | { type: "generating"; sessionId: string }
  | { type: "editing"; sessionId: string }
  | { type: "error"; sessionId: string; errorMessage: string }
  | { type: "creating"; sessionId: string };

function createEmptySubtask(index: number): SubtaskItem {
  return {
    id: `subtask-${index}`,
    title: "",
    description: "",
    suggestedSize: "M",
    dependsOn: [],
  };
}

function hasDependencyCycle(subtasks: SubtaskItem[]): boolean {
  const graph = new Map(subtasks.map((item) => [item.id, item.dependsOn]));
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const dep of graph.get(id) ?? []) {
      if (graph.has(dep) && visit(dep)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };

  return subtasks.some((item) => visit(item.id));
}

export function SubtaskBreakdownModal({ isOpen, onClose, initialDescription, onTasksCreated, parentTaskId, projectId, resumeSessionId, onOpenGroupModal }: SubtaskBreakdownModalProps) {
  const { t } = useTranslation("app");
  const viewportMode = useViewportMode();
  useMobileScrollLock(isOpen);
  const { keyboardOverlap, viewportHeight, viewportOffsetTop, keyboardOpen } = useMobileKeyboard({
    enabled: viewportMode === "mobile",
  });
  const keyboardStyle: CSSProperties = keyboardOpen
    ? ({
        "--keyboard-overlap": `${keyboardOverlap}px`,
        "--vv-offset-top": `${viewportOffsetTop}px`,
        ...(viewportHeight !== null ? { "--vv-height": `${viewportHeight}px` } : {}),
      } as CSSProperties)
    : {};
  const [view, setView] = useState<ViewState>({ type: "initial" });
  const [subtasks, setSubtasks] = useState<SubtaskItem[]>([]);
  const [conversationHistory, setConversationHistory] = useState<ConversationHistoryEntry[]>([]);
  const [thinkingOutput, setThinkingOutput] = useState("");
  const [showThinking, setShowThinking] = useState(true);
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [isRetrying, setIsRetrying] = useState(false);
  const [isStartingBreakdown, setIsStartingBreakdown] = useState(false);
  // Local description: synced from prop, can fall back to localStorage
  const [localDescription, setLocalDescription] = useState(initialDescription);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [branchMode, setBranchMode] = useState<"project-default" | "auto-new" | "existing" | "custom-new">("project-default");
  const [branchName, setBranchName] = useState("");
  const [baseBranch, setBaseBranch] = useState("");
  const [branchAssignmentMode, setBranchAssignmentMode] = useState<"shared" | "per-task-derived">("shared");
  
  // Drag-and-drop state
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [dragOverPosition, setDragOverPosition] = useState<'before' | 'after' | null>(null);
  
  const streamRef = useRef<{ close: () => void; isConnected: () => boolean } | null>(null);
  const titleRefs = useRef<Array<HTMLInputElement | null>>([]);
  const autoStartedRef = useRef(false);
  const trackedLockSessionRef = useRef<string | null>(null);

  const sessionId = view.type === "generating" || view.type === "editing" || view.type === "creating" || view.type === "error"
    ? view.sessionId
    : null;
  const sessionTabId = useMemo(() => getSessionTabId(), []);
  const {
    isLockedByOther,
    takeControl,
    isLoading: isLockLoading,
  } = useSessionLock(isOpen ? sessionId : null);
  const {
    activeTabMap,
    broadcastUpdate,
    broadcastCompleted,
    broadcastLock,
    broadcastUnlock,
    broadcastHeartbeat,
  } = useAiSessionSync();

  const isInvalid = useMemo(() => {
    if (subtasks.length === 0) return true;
    if (subtasks.some((subtask) => !subtask.title.trim())) return true;
    if ((branchMode === "existing" || branchMode === "custom-new") && !branchName.trim()) return true;
    return hasDependencyCycle(subtasks);
  }, [branchMode, branchName, subtasks]);

  const showSendToBackgroundButton = view.type === "generating" || view.type === "editing" || view.type === "error";
  const activeLockInfo = sessionId ? activeTabMap.get(sessionId) : null;
  const { confirm } = useConfirm();
  const activeRemoteTab = activeLockInfo && activeLockInfo.tabId !== sessionTabId;
  const activeInAnotherTab = Boolean(activeRemoteTab && !activeLockInfo.stale);
  const allowTakeover = isLockedByOther && (!activeRemoteTab || activeLockInfo.stale);

  const resetState = useCallback(() => {
    // Save to localStorage before cleanup (preserve for re-entry)
    if (localDescription) {
      saveSubtaskDescription(localDescription, projectId);
    }
    streamRef.current?.close();
    streamRef.current = null;
    setView({ type: "initial" });
    setSubtasks([]);
    setConversationHistory([]);
    setThinkingOutput("");
    setShowThinking(true);
    setIsReconnecting(false);
    setIsRetrying(false);
    setIsStartingBreakdown(false);
    setError(null);
    setDirty(false);
    setBranchMode("project-default");
    setBranchName("");
    setBaseBranch("");
    setBranchAssignmentMode("shared");
    autoStartedRef.current = false;
  }, [localDescription, projectId]);

  const keepSessionReachableInBackground = useCallback(() => {
    if (!sessionId) return;

    /**
     * FNXC:SubtaskBreakdown 2026-06-16-21:10:
     * Closing the modal is an exit affordance, not an explicit discard. Preserve running and review-ready subtask sessions in the background-session list so users can resume from BackgroundTasksIndicator instead of losing AI work.
     */
    if (view.type !== "generating" && view.type !== "editing") return;

    const resumableStatus = view.type === "generating" ? "generating" : "awaiting_input";
    broadcastUpdate({
      sessionId,
      status: resumableStatus,
      needsInput: resumableStatus === "awaiting_input",
      owningTabId: sessionTabId,
      type: "subtask",
      title: localDescription.trim() || undefined,
      projectId: projectId ?? null,
    });
  }, [broadcastUpdate, localDescription, projectId, sessionId, sessionTabId, view.type]);

  const handleSendToBackground = useCallback(() => {
    keepSessionReachableInBackground();
    streamRef.current?.close();
    streamRef.current = null;
    onClose();
  }, [keepSessionReachableInBackground, onClose]);

  const handleClose = useCallback(async () => {
    const hasUnsavedChanges = dirty || view.type === "editing" || view.type === "creating";
    if (hasUnsavedChanges) {
      const shouldClose = await confirm({
        title: t("subtasks.keepSessionTitle", "Keep subtask session available?"),
        message: t("subtasks.keepSessionMessage", "Close this modal and keep the subtask session available from Background Tasks? Edited fields that have not been saved to the session may be reset when you resume."),
      });
      if (!shouldClose) {
        return;
      }
    }

    keepSessionReachableInBackground();
    streamRef.current?.close();
    streamRef.current = null;
    resetState();
    onClose();
  }, [dirty, keepSessionReachableInBackground, onClose, resetState, view.type, confirm, t]);

  const connectToSubtaskStream = useCallback(
    (activeSessionId: string) => {
      streamRef.current?.close();
      streamRef.current = connectSubtaskStream(activeSessionId, projectId, {
        onThinking: (data) => {
          setThinkingOutput((prev) => prev + data);
          broadcastUpdate({
            sessionId: activeSessionId,
            status: "generating",
            needsInput: false,
            owningTabId: sessionTabId,
            type: "subtask",
            title: localDescription.trim() || undefined,
            projectId: projectId ?? null,
          });
        },
        onSubtasks: (items) => {
          setIsReconnecting(false);
          setIsRetrying(false);
          clearSubtaskDescription(projectId);
          setSubtasks(items);
          setView({ type: "editing", sessionId: activeSessionId });
          setDirty(false);

          broadcastUpdate({
            sessionId: activeSessionId,
            status: "awaiting_input",
            needsInput: true,
            owningTabId: sessionTabId,
            type: "subtask",
            title: localDescription.trim() || undefined,
            projectId: projectId ?? null,
          });
        },
        onError: (message) => {
          const errorMessage = message || t("subtasks.errorSessionFailed", "Session failed while contacting the AI.");
          setIsReconnecting(false);
          setIsRetrying(false);
          setError(null);
          setView({ type: "error", sessionId: activeSessionId, errorMessage });

          broadcastUpdate({
            sessionId: activeSessionId,
            status: "error",
            needsInput: false,
            owningTabId: sessionTabId,
            type: "subtask",
            title: localDescription.trim() || undefined,
            projectId: projectId ?? null,
          });
          broadcastCompleted({ sessionId: activeSessionId, status: "error" });
        },
        onComplete: () => {
          broadcastCompleted({ sessionId: activeSessionId, status: "complete" });
        },
        onConnectionStateChange: (state) => {
          setIsReconnecting(state === "reconnecting");
        },
      });
    },
    [
      broadcastCompleted,
      broadcastUpdate,
      localDescription,
      projectId,
      sessionTabId,
    ],
  );

  const beginBreakdown = useCallback(async () => {
    if (!localDescription.trim()) return;
    setError(null);
    setConversationHistory([]);
    setThinkingOutput("");
    setIsReconnecting(false);
    setIsStartingBreakdown(true);

    try {
      const { sessionId } = await startSubtaskBreakdown(localDescription.trim(), projectId);
      setView({ type: "generating", sessionId });
      broadcastUpdate({
        sessionId,
        status: "generating",
        needsInput: false,
        owningTabId: sessionTabId,
        type: "subtask",
        title: localDescription.trim() || undefined,
        projectId: projectId ?? null,
      });
      connectToSubtaskStream(sessionId);
    } catch (err) {
      setError(getErrorMessage(err) || t("subtasks.errorStartBreakdown", "Failed to start subtask breakdown"));
      setView({ type: "initial" });
    } finally {
      setIsStartingBreakdown(false);
    }
  }, [broadcastUpdate, connectToSubtaskStream, localDescription, projectId, sessionTabId, t]);

  useEffect(() => {
    if (!isOpen) {
      resetState();
      return;
    }

    if (isOpen && initialDescription && !autoStartedRef.current) {
      setLocalDescription(initialDescription);
      autoStartedRef.current = true;
      void beginBreakdown();
    } else if (isOpen && !initialDescription && !autoStartedRef.current) {
      // Check localStorage for persisted description when no prop provided
      const persisted = getSubtaskDescription(projectId);
      if (persisted) {
        setLocalDescription(persisted);
      }
    }
  }, [isOpen, initialDescription, beginBreakdown, resetState]);

  useEffect(() => {
    if (!isOpen || !resumeSessionId || view.type !== "initial") return;

    void (async () => {
      try {
        const session = await fetchAiSession(resumeSessionId);
        if (!session) return;

        const parsedHistory = parseConversationHistory(session.conversationHistory);
        setConversationHistory(parsedHistory);

        if (session.status === "generating" || session.status === "awaiting_input") {
          setThinkingOutput(session.thinkingOutput ?? "");
          setView({ type: "generating", sessionId: resumeSessionId });
          connectToSubtaskStream(resumeSessionId);
        } else if (session.status === "complete" && session.result) {
          clearSubtaskDescription(projectId);
          const items = JSON.parse(session.result) as SubtaskItem[];
          setSubtasks(items);
          setView({ type: "editing", sessionId: resumeSessionId });
        } else if (session.status === "error") {
          setError(null);
          setView({
            type: "error",
            sessionId: resumeSessionId,
            errorMessage: session.error ?? t("subtasks.errorSessionEncountered", "Session encountered an error"),
          });
        }
      } catch (err) {
        setError(getErrorMessage(err) || t("subtasks.errorResumeSession", "Failed to resume session"));
      }
    })();
  }, [connectToSubtaskStream, isOpen, resumeSessionId, view.type, projectId]);

  // Broadcast lock ownership transitions across tabs.
  useEffect(() => {
    if (!isOpen) {
      if (trackedLockSessionRef.current) {
        broadcastUnlock(trackedLockSessionRef.current, sessionTabId);
        trackedLockSessionRef.current = null;
      }
      return;
    }

    if (sessionId && trackedLockSessionRef.current !== sessionId) {
      if (trackedLockSessionRef.current) {
        broadcastUnlock(trackedLockSessionRef.current, sessionTabId);
      }
      broadcastLock(sessionId, sessionTabId);
      trackedLockSessionRef.current = sessionId;
      return;
    }

    if (!sessionId && trackedLockSessionRef.current) {
      broadcastUnlock(trackedLockSessionRef.current, sessionTabId);
      trackedLockSessionRef.current = null;
    }
  }, [broadcastLock, broadcastUnlock, isOpen, sessionId, sessionTabId]);

  // Keep ownership heartbeat alive while this tab is interacting with the session.
  useEffect(() => {
    if (!isOpen || !sessionId || trackedLockSessionRef.current !== sessionId) {
      return;
    }

    broadcastHeartbeat(sessionTabId);
    const timer = setInterval(() => {
      broadcastHeartbeat(sessionTabId);
    }, 30_000);

    return () => {
      clearInterval(timer);
    };
  }, [broadcastHeartbeat, isOpen, sessionId, sessionTabId]);

  useEffect(() => {
    return () => {
      streamRef.current?.close();
      if (trackedLockSessionRef.current) {
        broadcastUnlock(trackedLockSessionRef.current, sessionTabId);
        trackedLockSessionRef.current = null;
      }
    };
  }, [broadcastUnlock, sessionTabId]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        void handleClose();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, handleClose]);

  const updateSubtask = useCallback((id: string, patch: Partial<SubtaskItem>) => {
    setSubtasks((current) => current.map((item) => item.id === id ? { ...item, ...patch } : item));
    setDirty(true);
  }, []);

  const addSubtask = useCallback(() => {
    setSubtasks((current) => [...current, createEmptySubtask(current.length + 1)]);
    setDirty(true);
  }, []);

  const removeSubtask = useCallback((id: string) => {
    setSubtasks((current) => current
      .filter((item) => item.id !== id)
      .map((item) => ({ ...item, dependsOn: item.dependsOn.filter((dep) => dep !== id) })));
    setDirty(true);
  }, []);

  // Drag-and-drop handlers
  const handleDragStart = useCallback((subtaskId: string) => (e: React.DragEvent) => {
    setDraggingId(subtaskId);
    e.dataTransfer.setData('text/plain', subtaskId);
    e.dataTransfer.effectAllowed = 'move';
  }, []);

  const handleDragEnd = useCallback(() => {
    setDraggingId(null);
    setDragOverId(null);
    setDragOverPosition(null);
  }, []);

  const handleDragOver = useCallback((targetId: string) => (e: React.DragEvent) => {
    e.preventDefault();
    if (targetId === draggingId) return;
    
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    const position: 'before' | 'after' = e.clientY < midY ? 'before' : 'after';
    
    setDragOverId(targetId);
    setDragOverPosition(position);
  }, [draggingId]);

  const handleDrop = useCallback((targetId: string) => (e: React.DragEvent) => {
    e.preventDefault();
    const draggedId = e.dataTransfer.getData('text/plain');
    
    if (!draggedId || draggedId === targetId) {
      setDraggingId(null);
      setDragOverId(null);
      setDragOverPosition(null);
      return;
    }

    setSubtasks((current) => {
      const fromIndex = current.findIndex((s) => s.id === draggedId);
      const toIndex = current.findIndex((s) => s.id === targetId);
      
      if (fromIndex === -1 || toIndex === -1) return current;
      
      const newSubtasks = [...current];
      const [moved] = newSubtasks.splice(fromIndex, 1);
      
      let insertIndex = toIndex;
      if (dragOverPosition === 'after' && fromIndex < toIndex) insertIndex--;
      if (dragOverPosition === 'after') insertIndex++;
      
      newSubtasks.splice(insertIndex, 0, moved);
      return newSubtasks;
    });
    
    setDirty(true);
    setDraggingId(null);
    setDragOverId(null);
    setDragOverPosition(null);
  }, [dragOverPosition]);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = e.clientX;
    const y = e.clientY;
    
    // Only clear if leaving the element entirely, not just moving between children
    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
      setDragOverId(null);
      setDragOverPosition(null);
    }
  }, []);

  // Keyboard reordering handlers
  const moveSubtask = useCallback((fromIndex: number, toIndex: number) => {
    if (toIndex < 0 || toIndex >= subtasks.length) return;
    
    setSubtasks((current) => {
      const newSubtasks = [...current];
      const [moved] = newSubtasks.splice(fromIndex, 1);
      newSubtasks.splice(toIndex, 0, moved);
      return newSubtasks;
    });
    setDirty(true);
  }, [subtasks.length]);

  const moveFocusToNext = useCallback((index: number) => {
    titleRefs.current[index + 1]?.focus();
  }, []);

  const handleCreateTasks = useCallback(async () => {
    if (!sessionId || isInvalid) return;
    setError(null);
    setView({ type: "creating", sessionId });
    try {
      const result = await createTasksFromBreakdown(sessionId, subtasks, parentTaskId, projectId, {
        branchSelection: {
          mode: branchMode,
          ...(branchMode === "existing" || branchMode === "custom-new" ? { branchName } : {}),
          ...(baseBranch.trim() ? { baseBranch: baseBranch.trim() } : {}),
        },
        branchAssignment: { mode: branchAssignmentMode },
      });
      onTasksCreated(result.tasks);
      resetState();
      onClose();
    } catch (err) {
      setError(getErrorMessage(err) || t("subtasks.errorCreateTasks", "Failed to create tasks"));
      setView({ type: "editing", sessionId });
    }
  }, [baseBranch, branchAssignmentMode, branchMode, branchName, isInvalid, onClose, onTasksCreated, parentTaskId, projectId, resetState, sessionId, subtasks]);

  const handleRetry = useCallback(async () => {
    if (view.type !== "error") {
      return;
    }

    const retrySessionId = view.sessionId;
    setError(null);
    setIsRetrying(true);
    setThinkingOutput("");
    setView({ type: "generating", sessionId: retrySessionId });
    connectToSubtaskStream(retrySessionId);

    try {
      await retrySubtaskSession(retrySessionId, projectId, sessionTabId);
    } catch (err) {
      let retryError: unknown = err;
      const retryErrorMessage = getErrorMessage(err) || "";

      if (retryErrorMessage.includes("not in an error state")) {
        try {
          const session = await fetchAiSession(retrySessionId);
          if (!session) {
            throw new Error(t("subtasks.errorRefreshSession", "Failed to refresh subtask session."));
          }

          setConversationHistory(parseConversationHistory(session.conversationHistory));

          if (session.status === "generating" || session.status === "awaiting_input") {
            setThinkingOutput(session.thinkingOutput ?? "");
            setView({ type: "generating", sessionId: session.id });
            if (!streamRef.current?.isConnected()) {
              connectToSubtaskStream(session.id);
            }
          } else if (session.status === "complete") {
            if (!session.result) {
              throw new Error(t("subtasks.errorSessionNoResult", "Subtask session is complete but has no result."));
            }
            clearSubtaskDescription(projectId);
            const items = JSON.parse(session.result) as SubtaskItem[];
            setSubtasks(items);
            setView({ type: "editing", sessionId: session.id });
            setDirty(false);
          } else if (session.status === "error") {
            setView({
              type: "error",
              sessionId: session.id,
              errorMessage: session.error ?? t("subtasks.errorRetryFailed", "Retry failed. Please try again."),
            });
          }

          setIsReconnecting(false);
          return;
        } catch (sessionRefreshError) {
          retryError = sessionRefreshError;
        }
      }

      streamRef.current?.close();
      streamRef.current = null;
      setView({
        type: "error",
        sessionId: retrySessionId,
        errorMessage: getErrorMessage(retryError) || t("subtasks.errorRetryFailed", "Retry failed. Please try again."),
      });
      setIsReconnecting(false);
    } finally {
      setIsRetrying(false);
    }
  }, [connectToSubtaskStream, projectId, sessionTabId, view]);

  if (!isOpen) return null;

  return (
    <div className="modal-overlay open" onClick={(event) => event.target === event.currentTarget && void handleClose()} role="dialog" aria-modal="true">
      <div className="modal modal-lg planning-modal" style={keyboardStyle}>
        <div className="modal-header">
          <div className="detail-title-row">
            <ListTree size={20} className="icon-triage" />
            <h3>{t("subtasks.modalTitle", "Subtask Breakdown")}</h3>
          </div>
          <div className="modal-header-actions">
            {showSendToBackgroundButton && (
              <button
                className="modal-send-to-background"
                onClick={handleSendToBackground}
                title={t("subtasks.sendToBackgroundTitle", "Send to background")}
                aria-label={t("subtasks.sendToBackgroundAriaLabel", "Send to background")}
              >
                <Minimize2 size={16} />
              </button>
            )}
            <button className="modal-close" onClick={() => void handleClose()} aria-label={t("common.close", "Close")}>
              <X size={20} />
            </button>
          </div>
        </div>

        <div className="planning-modal-body">
          {error && <div className="form-error planning-error">{error}</div>}
          {isReconnecting && <div className="form-hint text-muted">{t("subtasks.reconnecting", "Reconnecting…")}</div>}
          {activeInAnotherTab && (
            <div className="form-hint text-muted" data-testid="session-active-another-tab-banner">
              {t("subtasks.sessionActiveAnotherTab", "Session is active in another tab.")}
            </div>
          )}

          {view.type === "initial" && (
            <div className="planning-loading" data-testid="subtask-progress-state">
              <div className="planning-view-scroll">
                {/*
                 * FNXC:SubtaskBreakdown 2026-06-16-00:00:
                 * Subtask generation must show live progress as soon as a run is requested, before the session id or streamed thinking exists, so users do not see a dead static preparation state.
                 */}
                <Loader2 size={40} className="spin icon-todo" aria-hidden="true" />
                <p>{isStartingBreakdown ? t("subtasks.startingBreakdown", "Starting subtask breakdown...") : t("subtasks.preparingBreakdown", "Preparing to break this task into subtasks.")}</p>
                <p className="text-muted">{t("subtasks.progressHint", "Fusion will keep working while the AI prepares subtasks.")}</p>
                <pre className="planning-thinking-output">{localDescription}</pre>
              </div>
            </div>
          )}

          {view.type === "generating" && (
            <div className="planning-loading" data-testid="subtask-progress-state">
              {conversationHistory.length > 0 && (
                <>
                  <ConversationHistory entries={conversationHistory} defaultShowThinking={true} />
                  <div className="conversation-separator" />
                </>
              )}
              <Loader2 size={40} className="spin icon-todo" aria-hidden="true" />
              <p>{isReconnecting ? t("subtasks.reconnecting", "Reconnecting…") : t("subtasks.generatingSubtasks", "AI is generating subtasks...")}</p>
              <p className="text-muted">{t("subtasks.progressHint", "Fusion will keep working while the AI prepares subtasks.")}</p>
              <div className="planning-thinking-container">
                <button className="planning-thinking-toggle" onClick={() => setShowThinking(!showThinking)} type="button">
                  {showThinking ? t("subtasks.hideThinking", "Hide thinking") : t("subtasks.showThinking", "Show thinking")}
                </button>
                {showThinking && (
                  <div className="planning-thinking-output">
                    {thinkingOutput ? <pre>{thinkingOutput}</pre> : <p className="text-muted">{t("subtasks.waitingForThinking", "Waiting for AI progress updates...")}</p>}
                  </div>
                )}
              </div>
            </div>
          )}

          {view.type === "error" && (
            <div className="planning-summary">
              <div className="planning-view-scroll planning-summary-scroll">
                {conversationHistory.length > 0 && (
                  <>
                    <ConversationHistory entries={conversationHistory} defaultShowThinking={true} />
                    <div className="conversation-separator" />
                  </>
                )}
                <div
                  className="ai-error-panel"
                  role="alert"
                >
                  <div className="ai-error-icon">⚠️</div>
                  <div className="ai-error-message">{view.errorMessage}</div>
                  <div className="ai-error-actions">
                    <button className="btn btn-primary" onClick={() => void handleRetry()} disabled={isRetrying}>
                      {isRetrying ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
                      <span className="icon-ml-6">{isRetrying ? t("subtasks.retrying", "Retrying...") : t("subtasks.retry", "Retry")}</span>
                    </button>
                    <button className="btn" onClick={() => void handleClose()} disabled={isRetrying}>{t("common.cancel", "Cancel")}</button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {(view.type === "editing" || view.type === "creating") && (
            <div className="planning-summary">
              <div className="planning-view-scroll planning-summary-scroll">
                {conversationHistory.length > 0 && (
                  <>
                    <ConversationHistory entries={conversationHistory} />
                    <div className="conversation-separator" />
                  </>
                )}

                <div className="planning-summary-header">
                  <CheckCircle size={24} className="icon-success" />
                  <h4>{t("subtasks.reviewSubtasksHeading", "Review your subtasks")}</h4>
                  <p className="text-muted">{t("subtasks.reviewSubtasksHint", "Edit titles, descriptions, sizes, and dependencies before creating all tasks at once.")}</p>
                </div>

                <div className="planning-summary-form">
                  <div className="task-detail-section">
                    <div className="form-group">
                      <label>{t("subtasks.branchStrategyLabel", "Branch strategy")}</label>
                      <select value={branchMode} onChange={(event) => setBranchMode(event.target.value as typeof branchMode)} disabled={view.type === "creating"}>
                        <option value="project-default">{t("subtasks.branchModeProjectDefault", "Use project/default branch")}</option>
                        <option value="auto-new">{t("subtasks.branchModeAutoNew", "Create auto-named branch per task")}</option>
                        <option value="existing">{t("subtasks.branchModeExisting", "Use existing branch")}</option>
                        <option value="custom-new">{t("subtasks.branchModeCustomNew", "Create custom new branch")}</option>
                      </select>
                    </div>
                    {(branchMode === "existing" || branchMode === "custom-new") && (
                      <div className="form-group">
                        <label>{t("subtasks.branchNameLabel", "Branch name")}</label>
                        <input value={branchName} onChange={(event) => setBranchName(event.target.value)} disabled={view.type === "creating"} />
                      </div>
                    )}
                    <div className="form-group">
                      <label>{t("subtasks.baseBranchLabel", "Merge target / base branch (optional)")}</label>
                      <input value={baseBranch} onChange={(event) => setBaseBranch(event.target.value)} disabled={view.type === "creating"} placeholder={t("subtasks.baseBranchPlaceholder", "main")} />
                    </div>
                    <div className="form-group">
                      <label>{t("subtasks.planningBranchModeLabel", "Planning branch mode")}</label>
                      <select value={branchAssignmentMode} onChange={(event) => setBranchAssignmentMode(event.target.value as typeof branchAssignmentMode)} disabled={view.type === "creating"}>
                        <option value="shared">{t("subtasks.branchAssignmentShared", "Shared merge target — subtasks run on their own branches")}</option>
                        <option value="per-task-derived">{t("subtasks.branchAssignmentPerTask", "Per-task branches derived from planning branch")}</option>
                      </select>
                      {branchAssignmentMode === "shared" && branchName.trim() && (
                        <p className="text-muted">
                          {t("subtasks.groupedOnSharedBranch", "Grouped on shared branch")} <strong>{branchName.trim()}</strong>
                          {onOpenGroupModal && (
                            <button
                              type="button"
                              className="btn btn-sm"
                              onClick={() => onOpenGroupModal(`BG-${branchName.trim()}`)}
                            >
                              {t("subtasks.openGroupModal", "Open group modal")}
                            </button>
                          )}
                        </p>
                      )}
                    </div>
                  </div>
                  {subtasks.map((subtask, index) => {
                    const isDragging = draggingId === subtask.id;
                    const isDragOver = dragOverId === subtask.id;
                    const dragClasses = [
                      'task-detail-section',
                      'subtask-item',
                      isDragging ? 'subtask-item-dragging' : '',
                      isDragOver ? 'subtask-item-drop-target' : '',
                      isDragOver && dragOverPosition === 'before' ? 'subtask-item-drop-before' : '',
                      isDragOver && dragOverPosition === 'after' ? 'subtask-item-drop-after' : '',
                    ].filter(Boolean).join(' ');

                    return (
                      <div
                        key={subtask.id}
                        className={dragClasses}
                        data-testid={`subtask-item-${index}`}
                        draggable={view.type !== "creating"}
                        onDragStart={handleDragStart(subtask.id)}
                        onDragEnd={handleDragEnd}
                        onDragOver={handleDragOver(subtask.id)}
                        onDrop={handleDrop(subtask.id)}
                        onDragLeave={handleDragLeave}
                      >
                        <div className="detail-title-row subtask-item-header subtask-item-header--between">
                          <div className="subtask-drag-handle" title={t("subtasks.dragToReorder", "Drag to reorder")}>
                            <GripVertical size={16} />
                            <strong>{subtask.id}</strong>
                          </div>
                          <div className="subtask-item-actions">
                            <button
                              type="button"
                              className="btn btn-icon btn-sm"
                              onClick={() => moveSubtask(index, index - 1)}
                              disabled={view.type === "creating" || index === 0}
                              title={t("subtasks.moveUp", "Move up")}
                              aria-label={t("subtasks.moveSubtaskUpAriaLabel", "Move subtask up")}
                            >
                              <ArrowUp />
                            </button>
                            <button
                              type="button"
                              className="btn btn-icon btn-sm"
                              onClick={() => moveSubtask(index, index + 1)}
                              disabled={view.type === "creating" || index === subtasks.length - 1}
                              title={t("subtasks.moveDown", "Move down")}
                              aria-label={t("subtasks.moveSubtaskDownAriaLabel", "Move subtask down")}
                            >
                              <ArrowDown />
                            </button>
                            <button type="button" className="btn btn-sm" onClick={() => removeSubtask(subtask.id)} disabled={view.type === "creating"}>
                              <Trash2 size={14} /> {t("subtasks.remove", "Remove")}
                            </button>
                          </div>
                        </div>

                      <div className="form-group">
                        <label>{t("subtasks.titleLabel", "Title")}</label>
                        <input
                          ref={(element) => { titleRefs.current[index] = element; }}
                          value={subtask.title}
                          onChange={(event) => updateSubtask(subtask.id, { title: event.target.value })}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault();
                              moveFocusToNext(index);
                            }
                          }}
                          disabled={view.type === "creating"}
                        />
                      </div>

                      <div className="form-group">
                        <label>{t("subtasks.descriptionLabel", "Description")}</label>
                        <textarea
                          rows={8}
                          value={subtask.description}
                          onChange={(event) => updateSubtask(subtask.id, { description: event.target.value })}
                          disabled={view.type === "creating"}
                        />
                      </div>

                      <div className="form-group">
                        <label>{t("subtasks.sizeLabel", "Size")}</label>
                        <select
                          className="planning-size-select"
                          value={subtask.suggestedSize}
                          onChange={(event) => updateSubtask(subtask.id, { suggestedSize: event.target.value as "S" | "M" | "L" })}
                          disabled={view.type === "creating"}
                        >
                          <option value="S">S</option>
                          <option value="M">M</option>
                          <option value="L">L</option>
                        </select>
                      </div>

                      <div className="form-group">
                        <label>{t("subtasks.dependenciesLabel", "Dependencies")}</label>
                        <div className="planning-deps-list">
                          {/* Only show subtasks that come BEFORE this one in the list (prevents cycles) */}
                          {subtasks.slice(0, index).filter((item) => item.id !== subtask.id).map((candidate) => {
                            const selected = subtask.dependsOn.includes(candidate.id);
                            return (
                              <label key={candidate.id} className={`planning-dep-chip ${selected ? "selected" : ""}`}>
                                <input
                                  type="checkbox"
                                  checked={selected}
                                  onChange={() => {
                                    const nextDeps = selected
                                      ? subtask.dependsOn.filter((dep) => dep !== candidate.id)
                                      : [...subtask.dependsOn, candidate.id];
                                    updateSubtask(subtask.id, { dependsOn: nextDeps });
                                  }}
                                  disabled={view.type === "creating"}
                                />
                                <span className="planning-dep-id">{candidate.id}</span>
                                <span className="planning-dep-title">{candidate.title || t("subtasks.untitled", "Untitled")}</span>
                              </label>
                            );
                          })}
                          {index === 0 && (
                            <div className="text-muted">{t("subtasks.noDepsFirstSubtask", "First subtask cannot have dependencies.")}</div>
                          )}
                          {index > 0 && subtasks.slice(0, index).filter((item) => item.id !== subtask.id).length === 0 && (
                            <div className="text-muted">{t("subtasks.noPreviousSubtasks", "No previous subtasks available.")}</div>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                  })}

                  <button type="button" className="btn" onClick={addSubtask} disabled={view.type === "creating"}>
                    <Plus size={16} className="icon-mr-6" /> {t("subtasks.addSubtask", "Add subtask")}
                  </button>

                  {hasDependencyCycle(subtasks) && (
                    <div className="form-error planning-error">{t("subtasks.dependencyCycleError", "Dependencies contain a cycle. Remove circular references before creating tasks.")}</div>
                  )}
                </div>
              </div>

              <div className="planning-actions planning-summary-actions">
                <button className="btn" onClick={() => void handleClose()} disabled={view.type === "creating"}>
                  {t("common.cancel", "Cancel")}
                </button>
                <button className="btn btn-primary" onClick={() => void handleCreateTasks()} disabled={view.type === "creating" || isInvalid}>
                  {view.type === "creating" ? (
                    <>
                      <Loader2 size={16} className="spin icon-mr-6" />
                      {t("subtasks.creating", "Creating...")}
                    </>
                  ) : (
                    <>{t("subtasks.createTasks", "Create Tasks")}</>
                  )}
                </button>
              </div>
            </div>
          )}

          {isLockedByOther && (
            <div className="session-lock-overlay" data-testid="session-lock-overlay">
              <div className="session-lock-banner">
                <Lock size={16} />
                <span>
                  {allowTakeover
                    ? t("subtasks.sessionActiveAnotherTabTakeover", "This session is active in another tab")
                    : t("subtasks.sessionActiveAnotherTabLive", "This session is active in another tab (live heartbeat)")}
                </span>
                {allowTakeover && (
                  <button
                    type="button"
                    onClick={() => {
                      void takeControl();
                    }}
                    disabled={isLockLoading}
                    className="btn btn-primary session-lock-take-control"
                  >
                    {isLockLoading ? t("subtasks.takingControl", "Taking control...") : t("subtasks.takeControl", "Take Control")}
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export type { SubtaskBreakdownModalProps };
