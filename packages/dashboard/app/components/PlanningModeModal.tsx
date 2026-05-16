import "./PlanningModeModal.css";
import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import type { Task, PlanningQuestion, PlanningSummary, TaskPriority } from "@fusion/core";
import { DEFAULT_TASK_PRIORITY, TASK_PRIORITIES, getErrorMessage } from "@fusion/core";
import {
  startPlanningStreaming,
  createPlanningDraft,
  respondToPlanning,
  rewindPlanningSession,
  retryPlanningSession,
  createTaskFromPlanning,
  connectPlanningStream,
  fetchAiSession,
  fetchAiSessions,
  deleteAiSession,
  archiveAiSession,
  unarchiveAiSession,
  parseConversationHistory,
  startPlanningBreakdown,
  createTasksFromPlanning,
  fetchModels,
  cancelPlanning,
  stopPlanningGeneration,
  updatePlanningSessionDraft,
  summarizePlanningDraftTitle,
  updateGlobalSettings,
  type PlanningSession,
  type SubtaskItem,
  type PlanningSubtaskDraft,
  type ModelInfo,
  type ConversationHistoryEntry,
  type AiSessionSummary,
} from "../api";
import { subscribeSse } from "../sse-bus";
import { useModalResizePersist } from "../hooks/useModalResizePersist";
import {
  savePlanningDescription,
  getPlanningDescription,
  clearPlanningDescription,
} from "../hooks/modalPersistence";
import { Lightbulb, X, Loader2, CheckCircle, ArrowLeft, ArrowRight, Sparkles, ListTree, GripVertical, ArrowUp, ArrowDown, Plus, Trash2, RefreshCw, Lock, ChevronLeft, MessageSquarePlus, AlertCircle, Clock, HelpCircle, StopCircle, Archive, ArchiveRestore } from "lucide-react";
import { CustomModelDropdown } from "./CustomModelDropdown";
import { ConversationHistory } from "./ConversationHistory";
import { OnboardingDisclosure } from "./OnboardingDisclosure";
import { useSessionLock } from "../hooks/useSessionLock";
import { useAiSessionSync } from "../hooks/useAiSessionSync";
import { useViewportMode } from "../hooks/useViewportMode";
import { useMobileKeyboard } from "../hooks/useMobileKeyboard";
import { useNavigationHistoryContext } from "../hooks/useNavigationHistory";
import { useMobileScrollLock } from "../hooks/useMobileScrollLock";
import { useAutosizeTextarea } from "../hooks/useAutosizeTextarea";
import { getSessionTabId } from "../utils/getSessionTabId";

interface PlanningModeModalProps {
  isOpen: boolean;
  onClose: () => void;
  onTaskCreated: (task: Task) => void;
  onTasksCreated: (tasks: Task[]) => void;
  tasks: Task[];
  initialPlan?: string;
  projectId?: string;
  /** When set, reconnect to a persisted background session instead of starting fresh */
  resumeSessionId?: string;
}

interface QuestionResponse {
  [key: string]: unknown;
}

type ViewState =
  | { type: "initial" }
  | { type: "question"; session: PlanningSession }
  | { type: "summary"; session: PlanningSession; summary: PlanningSummary }
  | { type: "error"; session: PlanningSession; errorMessage: string }
  | { type: "breakdown"; sessionId: string; originalSubtasks: SubtaskItem[]; subtasks: SubtaskItem[]; dirty: boolean }
  | { type: "loading" };

const EXAMPLE_PLANS = [
  "Build a user authentication system with login and signup",
  "Add dark mode support to the dashboard",
  "Create an API endpoint for exporting tasks as CSV",
  "Refactor the task card component for better performance",
];

function normalizeTaskPriority(priority?: TaskPriority): TaskPriority {
  if (priority && (TASK_PRIORITIES as readonly string[]).includes(priority)) {
    return priority;
  }
  return DEFAULT_TASK_PRIORITY;
}

function normalizePlanningSummary(summary: PlanningSummary): PlanningSummary {
  return {
    ...summary,
    priority: normalizeTaskPriority(summary.priority),
  };
}

function areStringArraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function buildCompactPlanningSubtaskDrafts(
  originalSubtasks: SubtaskItem[],
  editedSubtasks: SubtaskItem[],
): PlanningSubtaskDraft[] {
  const originalById = new Map(originalSubtasks.map((subtask) => [subtask.id, subtask]));

  return editedSubtasks.map((subtask) => {
    const original = originalById.get(subtask.id);
    const normalizedPriority = normalizeTaskPriority(subtask.priority);
    const draft: PlanningSubtaskDraft = { id: subtask.id };

    if (!original || subtask.title !== original.title) {
      draft.title = subtask.title;
    }
    if (!original || subtask.description !== original.description) {
      draft.description = subtask.description;
    }
    if (!original || subtask.suggestedSize !== original.suggestedSize) {
      draft.suggestedSize = subtask.suggestedSize;
    }
    if (!original || normalizedPriority !== normalizeTaskPriority(original.priority)) {
      draft.priority = normalizedPriority;
    }
    if (!original || !areStringArraysEqual(subtask.dependsOn, original.dependsOn)) {
      draft.dependsOn = subtask.dependsOn;
    }

    return draft;
  });
}

function getModelSelectionValue(provider?: string, modelId?: string): string {
  return provider && modelId ? `${provider}/${modelId}` : "";
}

function parseModelSelection(value: string): { provider?: string; modelId?: string } {
  if (!value) {
    return { provider: undefined, modelId: undefined };
  }

  const slashIndex = value.indexOf("/");
  if (slashIndex === -1) {
    return { provider: undefined, modelId: undefined };
  }

  return {
    provider: value.slice(0, slashIndex),
    modelId: value.slice(slashIndex + 1),
  };
}

export function PlanningModeModal({ isOpen, onClose, onTaskCreated, onTasksCreated, tasks, initialPlan: initialPlanProp, projectId, resumeSessionId }: PlanningModeModalProps) {
  const [initialPlan, setInitialPlan] = useState("");
  const [view, setView] = useState<ViewState>({ type: "initial" });
  const [error, setError] = useState<string | null>(null);
  const [responseHistory, setResponseHistory] = useState<QuestionResponse[]>([]);
  const [conversationHistory, setConversationHistory] = useState<ConversationHistoryEntry[]>([]);
  const [editedSummary, setEditedSummary] = useState<PlanningSummary | null>(null);
  // Use ref instead of state for hasAutoStarted to handle React StrictMode double-render.
  // In StrictMode, components render twice but state persists across renders,
  // which would skip auto-start on the second (committed) render. Refs are
  // re-initialized on each render, ensuring the auto-start effect runs correctly.
  const hasAutoStartedRef = useRef(false);
  const hasLoadedPersistedRef = useRef(false);
  const [streamingOutput, setStreamingOutput] = useState<string>("");
  const [showThinking, setShowThinking] = useState(true);
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [isRetrying, setIsRetrying] = useState(false);
  const [isCreatingTask, setIsCreatingTask] = useState(false);
  const [isStartingBreakdown, setIsStartingBreakdown] = useState(false);
  const [isCreatingFromBreakdown, setIsCreatingFromBreakdown] = useState(false);
  const [generationStartTime, setGenerationStartTime] = useState<number | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const { ref: initialPlanAutosizeRef } = useAutosizeTextarea({
    value: initialPlan,
    minHeight: 120,
    maxHeight: 320,
  });
  const setInitialPlanTextareaRef = useCallback((node: HTMLTextAreaElement | null) => {
    textareaRef.current = node;
    initialPlanAutosizeRef(node);
  }, [initialPlanAutosizeRef]);
  const modalRef = useRef<HTMLDivElement>(null);
  const streamConnectionRef = useRef<{ close: () => void; isConnected: () => boolean } | null>(null);
  const currentSessionIdRef = useRef<string | null>(null);
  const draftSessionIdRef = useRef<string | null>(null);
  const draftDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Tracks resumeSessionId values the user has explicitly dismissed (via "New
  // Session"). Without this, the resume effect re-fires on every callback
  // identity change (e.g. typing into the textarea recreates loadSession) and
  // yanks the user back into the previous session's question view.
  const dismissedResumeRef = useRef<string | null>(null);
  const [lockSessionId, setLockSessionId] = useState<string | null>(resumeSessionId ?? null);
  const sessionTabId = useMemo(() => getSessionTabId(), []);
  const {
    isLockedByOther,
    takeControl,
    isLoading: isLockLoading,
  } = useSessionLock(isOpen ? lockSessionId : null);
  const {
    activeTabMap,
    broadcastUpdate,
    broadcastCompleted,
    broadcastLock,
    broadcastUnlock,
    broadcastHeartbeat,
  } = useAiSessionSync();
  const [planningModelProvider, setPlanningModelProvider] = useState<string | undefined>(undefined);
  const [planningModelId, setPlanningModelId] = useState<string | undefined>(undefined);
  const [planningDepth, setPlanningDepth] = useState<"small" | "medium" | "large">("medium");
  const [customQuestionCount, setCustomQuestionCount] = useState("");
  const [loadedModels, setLoadedModels] = useState<ModelInfo[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [favoriteProviders, setFavoriteProviders] = useState<string[]>([]);
  const [favoriteModels, setFavoriteModels] = useState<string[]>([]);
  const [resolvedPlanningModel, setResolvedPlanningModel] = useState<{
    provider?: string;
    modelId?: string;
  }>({});
  const trackedLockSessionRef = useRef<string | null>(null);

  // Sidebar list state
  const [planningSessions, setPlanningSessions] = useState<AiSessionSummary[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(resumeSessionId ?? null);
  // Mobile: when the modal is narrow, only one pane is visible at a time.
  // `mobileShowDetail` toggles between list (false) and detail (true).
  const [mobileShowDetail, setMobileShowDetail] = useState<boolean>(Boolean(resumeSessionId));
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  // Track whether the mousedown that initiated a click came from inside the
  // modal. Resizing via the bottom-right grip can release the mouse outside
  // the modal element; without this guard, that release fires a click whose
  // target is the overlay and would dismiss the modal mid-resize.
  const overlayMouseDownOnSelfRef = useRef(false);
  const thinkingOutputRef = useRef<HTMLDivElement>(null);
  // Mirrors `streamingOutput` state for reading inside callbacks without
  // stale closure issues (e.g. capturing reasoning before onQuestion clears it).
  const streamingOutputRef = useRef<string>("" );
  const draftSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSyncedDraftRef = useRef<{
    sessionId: string;
    initialPlan: string;
    modelProvider?: string;
    modelId?: string;
  } | null>(null);

  useModalResizePersist(modalRef, isOpen, "fusion:planning-modal-size");
  const viewportMode = useViewportMode();
  const isMobile = viewportMode === "mobile";
  const { pushNav } = useNavigationHistoryContext();

  const { keyboardOverlap, viewportHeight, viewportOffsetTop, keyboardOpen } =
    useMobileKeyboard({ enabled: viewportMode === "mobile" });
  useMobileScrollLock(viewportMode === "mobile" && isOpen);

  // Drive --vv-height / --keyboard-overlap / --vv-offset-top imperatively
  // rather than via React's style prop. Reason: when React removes a CSS
  // custom property between renders it sets it to empty string instead of
  // calling removeProperty(). On iOS Safari that leaves the variable defined
  // as "", so `height: var(--vv-height, 100dvh)` resolves to empty (the
  // fallback only applies when the var is *undefined*) and the modal
  // collapses to content height after the keyboard is dismissed.
  useEffect(() => {
    const node = modalRef.current;
    if (!node) return;
    if (keyboardOpen) {
      node.style.setProperty("--keyboard-overlap", `${keyboardOverlap}px`);
      node.style.setProperty("--vv-offset-top", `${viewportOffsetTop}px`);
      if (viewportHeight !== null) {
        node.style.setProperty("--vv-height", `${viewportHeight}px`);
      } else {
        node.style.removeProperty("--vv-height");
      }
    } else {
      node.style.removeProperty("--keyboard-overlap");
      node.style.removeProperty("--vv-offset-top");
      node.style.removeProperty("--vv-height");
    }
  }, [keyboardOpen, keyboardOverlap, viewportOffsetTop, viewportHeight]);

  // Mirror streamingOutput into a ref so SSE handlers can read the latest
  // value without stale closure issues.
  useEffect(() => {
    streamingOutputRef.current = streamingOutput;
  }, [streamingOutput]);

  // Keep the streaming AI thinking pane pinned to the bottom as new tokens
  // arrive. If the user has scrolled up to read earlier output, we leave the
  // scroll position alone — only auto-follow when they're already near the
  // tail. The 32px slack accounts for line-height jitter.
  useEffect(() => {
    const node = thinkingOutputRef.current;
    if (!node) return;
    const distanceFromBottom = node.scrollHeight - node.scrollTop - node.clientHeight;
    if (distanceFromBottom < 32) {
      node.scrollTop = node.scrollHeight;
    }
  }, [streamingOutput]);

  useEffect(() => {
    if (view.type !== "loading") {
      setGenerationStartTime(null);
      setElapsedSeconds(0);
      return;
    }

    const startedAt = Date.now();
    setGenerationStartTime(startedAt);
    setElapsedSeconds(0);

    const timer = setInterval(() => {
      setElapsedSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    }, 1000);

    return () => clearInterval(timer);
  }, [view.type]);

  // Fallback for missed SSE 'question'/'summary' events: when the loading
  // state lingers, periodically refetch the session and transition the view
  // if the server has already moved past generating. Without this, a dropped
  // event leaves the panel stuck on "thinking" until the user closes and
  // reopens the modal (which calls loadSession). Eight seconds is short
  // enough to feel responsive but long enough to avoid hammering the API
  // during normal generation.
  useEffect(() => {
    if (view.type !== "loading") return;
    const sessionId = currentSessionIdRef.current;
    if (!sessionId) return;

    let cancelled = false;
    const tick = async () => {
      try {
        const session = await fetchAiSession(sessionId);
        if (cancelled || !session) return;
        if (currentSessionIdRef.current !== sessionId) return;
        if (session.status === "awaiting_input" && session.currentQuestion) {
          const question = JSON.parse(session.currentQuestion) as PlanningQuestion;
          setView({
            type: "question",
            session: { sessionId, currentQuestion: question, summary: null },
          });
          setStreamingOutput("");
        } else if (session.status === "complete" && session.result) {
          const summary = normalizePlanningSummary(JSON.parse(session.result) as PlanningSummary);
          setView({
            type: "summary",
            session: { sessionId, currentQuestion: null, summary },
            summary,
          });
          setEditedSummary(summary);
          setStreamingOutput("");
        }
      } catch {
        // best-effort; keep polling
      }
    };

    const interval = setInterval(tick, 8000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [view.type]);

  const resetDetailState = useCallback(() => {
    setInitialPlan("");
    setView({ type: "initial" });
    setError(null);
    setResponseHistory([]);
    setConversationHistory([]);
    setEditedSummary(null);
    setStreamingOutput("");
    setIsReconnecting(false);
    setIsRetrying(false);
    setPlanningModelProvider(undefined);
    setPlanningModelId(undefined);
    setPlanningDepth("medium");
    setCustomQuestionCount("");
    currentSessionIdRef.current = null;
    setLockSessionId(null);
  }, []);

  const planningSelectionValue = getModelSelectionValue(planningModelProvider, planningModelId);

  const getModelBadgeLabel = useCallback(
    (provider?: string, modelId?: string) => {
      if (!provider || !modelId) {
        return resolvedPlanningModel.provider && resolvedPlanningModel.modelId
          ? `${resolvedPlanningModel.provider}/${resolvedPlanningModel.modelId}`
          : "Using default";
      }
      const matched = loadedModels.find((model) => model.provider === provider && model.id === modelId);
      return matched ? `${matched.provider}/${matched.id}` : `${provider}/${modelId}`;
    },
    [loadedModels, resolvedPlanningModel.modelId, resolvedPlanningModel.provider],
  );

  const loadModels = useCallback(async () => {
    setModelsLoading(true);
    setModelsError(null);

    try {
      const response = await fetchModels();
      setLoadedModels(response.models);
      setFavoriteProviders(response.favoriteProviders);
      setFavoriteModels(response.favoriteModels);
      setResolvedPlanningModel({
        provider: response.resolvedPlanningProvider,
        modelId: response.resolvedPlanningModelId,
      });
    } catch (err) {
      setModelsError(getErrorMessage(err) || "Failed to load models");
    } finally {
      setModelsLoading(false);
    }
  }, []);

  const handleToggleFavoriteProvider = useCallback((provider: string) => {
    setFavoriteProviders((prev) => {
      const currentFavorites = prev;
      const isFavorite = currentFavorites.includes(provider);
      const newFavorites = isFavorite
        ? currentFavorites.filter((item) => item !== provider)
        : [provider, ...currentFavorites];

      updateGlobalSettings({ favoriteProviders: newFavorites, favoriteModels }).catch(() => {
        setFavoriteProviders(currentFavorites);
      });

      return newFavorites;
    });
  }, [favoriteModels]);

  const handleToggleFavoriteModel = useCallback((modelId: string) => {
    setFavoriteModels((prev) => {
      const currentFavorites = prev;
      const isFavorite = currentFavorites.includes(modelId);
      const newFavorites = isFavorite
        ? currentFavorites.filter((item) => item !== modelId)
        : [modelId, ...currentFavorites];

      updateGlobalSettings({ favoriteProviders, favoriteModels: newFavorites }).catch(() => {
        setFavoriteModels(currentFavorites);
      });

      return newFavorites;
    });
  }, [favoriteProviders]);

  const connectToPlanningStream = useCallback(
    (sessionId: string) => {
      streamConnectionRef.current?.close();
      // Guard handlers against late events from a connection the user has
      // already navigated away from (e.g. clicked "New Session" while the
      // previous SSE flushed a buffered question). currentSessionIdRef is
      // cleared by resetDetailState and reassigned by handleStartPlanning /
      // loadSession before each connectToPlanningStream call.
      const isStaleEvent = () => currentSessionIdRef.current !== sessionId;

      const connection = connectPlanningStream(sessionId, projectId, {
        onThinking: (data) => {
          if (isStaleEvent()) return;
          setStreamingOutput((prev) => prev + data);
          broadcastUpdate({
            sessionId,
            status: "generating",
            needsInput: false,
            owningTabId: sessionTabId,
            type: "planning",
            title: initialPlan.trim() || undefined,
            projectId: projectId ?? null,
          });
        },
        onQuestion: (question) => {
          if (isStaleEvent()) return;
          setIsReconnecting(false);
          setIsRetrying(false);
          clearPlanningDescription(projectId);

          // Preserve reasoning accumulated during the loading turn as a
          // visible conversation-history entry so the user can expand it
          // from the question view. Without this, setStreamingOutput("")
          // would silently discard everything the model produced before the
          // first question arrived.
          const capturedThinking = streamingOutputRef.current.trim();
          if (capturedThinking) {
            setConversationHistory((prev) => {
              // De-duplicate: if the last entry already carries this exact
              // thinking text (e.g. from a prior transition or resume), skip.
              const lastEntry = prev[prev.length - 1];
              if (lastEntry?.thinkingOutput === capturedThinking) return prev;
              return [...prev, { thinkingOutput: capturedThinking }];
            });
          }

          setView({
            type: "question",
            session: { sessionId, currentQuestion: question, summary: null },
          });
          setStreamingOutput("");

          broadcastUpdate({
            sessionId,
            status: "awaiting_input",
            needsInput: true,
            owningTabId: sessionTabId,
            type: "planning",
            title: initialPlan.trim() || undefined,
            projectId: projectId ?? null,
          });
        },
        onSummary: (summary) => {
          if (isStaleEvent()) return;
          setIsReconnecting(false);
          setIsRetrying(false);
          clearPlanningDescription(projectId);

          // Preserve reasoning accumulated during the loading turn.
          const capturedThinking = streamingOutputRef.current.trim();
          if (capturedThinking) {
            setConversationHistory((prev) => {
              const lastEntry = prev[prev.length - 1];
              if (lastEntry?.thinkingOutput === capturedThinking) return prev;
              return [...prev, { thinkingOutput: capturedThinking }];
            });
          }

          setView({
            type: "summary",
            session: { sessionId, currentQuestion: null, summary },
            summary,
          });
          setEditedSummary(summary);
          setStreamingOutput("");

          broadcastUpdate({
            sessionId,
            status: "complete",
            needsInput: false,
            owningTabId: sessionTabId,
            type: "planning",
            title: initialPlan.trim() || undefined,
            projectId: projectId ?? null,
          });
        },
        onError: (message) => {
          const errorMessage = message || "Session failed while contacting the AI.";

          // A single transient stream error (e.g. tab was backgrounded long
          // enough for the SSE to time out) should not bounce the user to a
          // permanent error view. Refetch the session state — if the server
          // still has it in a recoverable state, silently reconnect; only
          // surface the error if the server actually persisted one.
          setIsReconnecting(true);
          (async () => {
            try {
              const session = await fetchAiSession(sessionId);
              if (
                session &&
                (session.status === "generating" || session.status === "awaiting_input")
              ) {
                connectToPlanningStream(sessionId);
                return;
              }
            } catch {
              // fall through to error view below
            }

            setIsReconnecting(false);
            setIsRetrying(false);
            setError(null);
            setView((prev) => {
              if (prev.type === "question" || prev.type === "summary" || prev.type === "error") {
                return { type: "error", session: prev.session, errorMessage };
              }
              return {
                type: "error",
                session: { sessionId, currentQuestion: null, summary: null },
                errorMessage,
              };
            });
            setStreamingOutput("");
            currentSessionIdRef.current = sessionId;

            broadcastUpdate({
              sessionId,
              status: "error",
              needsInput: false,
              owningTabId: sessionTabId,
              type: "planning",
              title: initialPlan.trim() || undefined,
              projectId: projectId ?? null,
            });
            broadcastCompleted({ sessionId, status: "error" });
          })();
        },
        onComplete: () => {
          setIsReconnecting(false);
          setIsRetrying(false);
          currentSessionIdRef.current = null;
          broadcastCompleted({ sessionId, status: "complete" });
        },
        onConnectionStateChange: (state) => {
          setIsReconnecting(state === "reconnecting");
        },
      });

      streamConnectionRef.current = connection;
    },
    [broadcastCompleted, broadcastUpdate, initialPlan, projectId, sessionTabId],
  );

  const handleStartPlanning = useCallback(async (planOverride?: string) => {
    const plan = planOverride ?? initialPlan;
    if (!plan.trim()) return;

    setError(null);
    setStreamingOutput("");
    setConversationHistory([]);
    setResponseHistory([]);
    setIsReconnecting(false);
    setView({ type: "loading" });

    try {
      // Use streaming mode for real-time AI thinking display
      const modelOverride =
        planningModelProvider && planningModelId
          ? { planningModelProvider, planningModelId }
          : undefined;

      const parsedCustomQuestionCount = customQuestionCount.trim()
        ? Number.parseInt(customQuestionCount, 10)
        : undefined;

      const draftSessionId = draftSessionIdRef.current;
      const { sessionId } = await startPlanningStreaming(
        plan.trim(),
        projectId,
        modelOverride,
        {
          planningDepth,
          customQuestionCount: Number.isInteger(parsedCustomQuestionCount)
            ? parsedCustomQuestionCount
            : undefined,
        },
        draftSessionId ?? undefined,
      );
      draftSessionIdRef.current = null;
      currentSessionIdRef.current = sessionId;
      setLockSessionId(sessionId);
      setSelectedSessionId(sessionId);

      connectToPlanningStream(sessionId);
      setResponseHistory([]);
    } catch (err) {
      setIsReconnecting(false);
      setError(getErrorMessage(err) || "Failed to start planning session");
      setView({ type: "initial" });
      currentSessionIdRef.current = null;
      setLockSessionId(null);
    }
  }, [
    connectToPlanningStream,
    customQuestionCount,
    initialPlan,
    planningDepth,
    planningModelId,
    planningModelProvider,
    projectId,
  ]);

  // Focus textarea when opening
  useEffect(() => {
    if (isOpen && view.type === "initial") {
      textareaRef.current?.focus();
    }
  }, [isOpen, view.type]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    void loadModels();
  }, [isOpen, loadModels]);

  // Auto-start planning when initialPlan prop is provided
  useEffect(() => {
    if (isOpen && initialPlanProp && !hasAutoStartedRef.current && view.type === "initial") {
      setInitialPlan(initialPlanProp);
      // Use a small timeout to allow state update to propagate before starting
      const timer = setTimeout(() => {
        // Only mark as auto-started when we actually start planning
        hasAutoStartedRef.current = true;
        handleStartPlanning(initialPlanProp);
      }, 0);
      return () => clearTimeout(timer);
    } else if (
      isOpen &&
      !initialPlanProp &&
      !hasAutoStartedRef.current &&
      !hasLoadedPersistedRef.current &&
      view.type === "initial"
    ) {
      // Restore the persisted description from localStorage on first open only.
      // Without the ref this effect re-fires on every keystroke (handleStart-
      // Planning depends on initialPlan), and each fire would clobber what
      // the user just typed back to the persisted value.
      hasLoadedPersistedRef.current = true;
      const persisted = getPlanningDescription(projectId);
      if (persisted) {
        setInitialPlan(persisted);
      }
    }
  }, [isOpen, initialPlanProp, view.type, handleStartPlanning, projectId]);

  // Load a specific persisted session into the right pane.
  const loadSession = useCallback(
    async (sessionId: string) => {
      streamConnectionRef.current?.close();
      streamConnectionRef.current = null;

      setError(null);
      setStreamingOutput("");
      setResponseHistory([]);
      setConversationHistory([]);
      setEditedSummary(null);
      setIsRetrying(false);
      setView({ type: "loading" });

      try {
        const session = await fetchAiSession(sessionId);
        if (!session) {
          // The session was deleted (commonly: this tab just turned it into
          // tasks via Create Task / Create Tasks). Quietly fall back to the
          // new-session view rather than surfacing a scary error banner.
          setSelectedSessionId(null);
          setMobileShowDetail(false);
          setView({ type: "initial" });
          return;
        }

        currentSessionIdRef.current = sessionId;
        setLockSessionId(sessionId);
        const parsedHistory = parseConversationHistory(session.conversationHistory);
        setConversationHistory(parsedHistory);
        setResponseHistory(
          parsedHistory
            .map((entry) => entry.response)
            .filter((response): response is QuestionResponse =>
              Boolean(response && typeof response === "object" && !Array.isArray(response)),
            ),
        );

        if (session.status === "draft") {
          // Draft hasn't been started yet — restore the user's saved text +
          // model selection into the editor, reattach the draft id so a
          // future Start Planning call reuses this row, and route them back
          // to the initial editor. Restoring the model ensures the start
          // request uses the selection the user made when creating the
          // draft, not whatever the modal's local state currently holds.
          let savedPlan = "";
          let savedProvider: string | undefined;
          let savedModelId: string | undefined;
          try {
            const payload = session.inputPayload ? JSON.parse(session.inputPayload) : null;
            if (payload && typeof payload.initialPlan === "string") {
              savedPlan = payload.initialPlan;
            }
            if (payload && typeof payload.modelProvider === "string" && typeof payload.modelId === "string") {
              savedProvider = payload.modelProvider;
              savedModelId = payload.modelId;
            }
          } catch {
            // Fall through with empty text; the row will remain editable.
          }
          setInitialPlan(savedPlan);
          setPlanningModelProvider(savedProvider);
          setPlanningModelId(savedModelId);
          draftSessionIdRef.current = sessionId;
          lastSyncedDraftRef.current = savedPlan
            ? {
                sessionId,
                initialPlan: savedPlan.trim(),
                modelProvider: savedProvider,
                modelId: savedModelId,
              }
            : null;
          setView({ type: "initial" });
        } else if (session.status === "awaiting_input" && session.currentQuestion) {
          clearPlanningDescription(projectId);
          const question = JSON.parse(session.currentQuestion);
          setView({ type: "question", session: { sessionId, currentQuestion: question, summary: null } });
          // Transfer persisted thinking into conversation history so it's
          // visible as expandable reasoning in the question view, instead of
          // setting streamingOutput which is only rendered in the loading
          // state.
          if (session.thinkingOutput) {
            const trimmed = session.thinkingOutput.trim();
            if (trimmed) {
              setConversationHistory((prev) => {
                const lastEntry = prev[prev.length - 1];
                if (lastEntry?.thinkingOutput === trimmed) return prev;
                return [...prev, { thinkingOutput: trimmed }];
              });
            }
          }
          connectToPlanningStream(sessionId);
        } else if (session.status === "complete" && session.result) {
          clearPlanningDescription(projectId);
          const summary = normalizePlanningSummary(JSON.parse(session.result));
          setView({ type: "summary", session: { sessionId, currentQuestion: null, summary }, summary });
          setEditedSummary(summary);
        } else if (session.status === "generating") {
          setView({ type: "loading" });
          if (session.thinkingOutput) setStreamingOutput(session.thinkingOutput);
          connectToPlanningStream(sessionId);
        } else if (session.status === "error") {
          setView({
            type: "error",
            session: { sessionId, currentQuestion: null, summary: null },
            errorMessage: session.error || "Session failed",
          });
        }
      } catch {
        setError("Failed to load session");
        setView({ type: "initial" });
      }
    },
    [connectToPlanningStream, projectId],
  );

  // Resume the externally-requested session when the modal first opens.
  // (Selecting from the sidebar uses handleSelectSession instead.)
  // Note: loadSession intentionally omitted from deps. It is recreated when
  // connectToPlanningStream changes (which depends on initialPlan), so
  // including it would re-fire this effect on every keystroke and re-resume
  // a session the user already dismissed via "New Session".
  useEffect(() => {
    if (!isOpen || !resumeSessionId) return;
    if (currentSessionIdRef.current === resumeSessionId) return;
    if (dismissedResumeRef.current === resumeSessionId) return;
    setSelectedSessionId(resumeSessionId);
    setMobileShowDetail(true);
    void loadSession(resumeSessionId);
  }, [isOpen, resumeSessionId]);

  // Re-sync the selected session whenever the planning screen is shown.
  // loadSession tears down any existing stream and reconnects, so the right
  // view always reflects the freshest server state for whatever row is
  // selected in the sidebar — no stale "loading" frames after a missed
  // terminal SSE event, no divergence from server progress while the modal
  // was closed.
  useEffect(() => {
    if (!isOpen) return;
    if (!selectedSessionId) return;
    if (resumeSessionId && resumeSessionId === selectedSessionId) return; // resume effect handles this case
    void loadSession(selectedSessionId);
    // We intentionally do not depend on selectedSessionId or loadSession here:
    // handleSelectSession already drives loadSession when the user picks a
    // different row, and this effect only needs to fire on the open
    // transition. Listing them here would cause it to re-run mid-session.
  }, [isOpen]);

  // Load + maintain the planning sessions list (sidebar).
  const refreshSessionsList = useCallback(async () => {
    setSessionsLoading(true);
    try {
      const all = await fetchAiSessions(projectId, {
        includeCompleted: true,
        includeArchived: showArchived,
      });
      const planning = all
        .filter((s) => s.type === "planning")
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
      setPlanningSessions(planning);
    } catch {
      // Best-effort: list errors should not block the modal
    } finally {
      setSessionsLoading(false);
    }
  }, [projectId, showArchived]);

  useEffect(() => {
    if (!isOpen) return;
    void refreshSessionsList();
  }, [isOpen, refreshSessionsList]);

  // Mobile empty-session routing: when the session list finishes loading and
  // is empty, and there is no resumeSessionId or selected session, auto-
  // switch to the detail pane so mobile users land on the composer instead
  // of an empty sidebar. Desktop/tablet split-view is unaffected because
  // both panes are visible simultaneously.
  //
  // We gate on sessionsLoading to avoid firing on the initial render (where
  // planningSessions is empty but hasn't been fetched yet). When the sessions
  // list finishes loading, planningSessions reflects the server response and
  // we can make an informed routing decision.
  const prevSessionsLoadingRef = useRef(false);
  useEffect(() => {
    const justFinishedLoading = prevSessionsLoadingRef.current && !sessionsLoading;
    prevSessionsLoadingRef.current = sessionsLoading;
    if (!justFinishedLoading) return;
    if (viewportMode !== "mobile") return;
    if (mobileShowDetail) return;
    if (resumeSessionId) return;
    if (selectedSessionId) return;
    if (planningSessions.length > 0) return;
    setMobileShowDetail(true);
  }, [viewportMode, mobileShowDetail, resumeSessionId, selectedSessionId, sessionsLoading, planningSessions.length]);

  // SSE subscription keeps the list live (mirrors useBackgroundSessions, but
  // unfiltered by status so completed/errored sessions stay visible).
  useEffect(() => {
    if (!isOpen) return;
    const params = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";

    const handleUpdated = (e: MessageEvent) => {
      try {
        const updated = JSON.parse(e.data) as AiSessionSummary;
        if (updated.type !== "planning") return;
        setPlanningSessions((prev) => {
          const idx = prev.findIndex((s) => s.id === updated.id);
          const next = idx >= 0 ? [...prev.slice(0, idx), updated, ...prev.slice(idx + 1)] : [updated, ...prev];
          return next.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
        });
      } catch {
        // ignore malformed payload
      }
    };

    const handleDeleted = (e: MessageEvent) => {
      try {
        const id = JSON.parse(e.data) as string;
        setPlanningSessions((prev) => prev.filter((s) => s.id !== id));
      } catch {
        // ignore malformed payload
      }
    };

    return subscribeSse(`/api/events${params}`, {
      events: {
        "ai_session:updated": handleUpdated,
        "ai_session:deleted": handleDeleted,
      },
      // Re-fetch on reconnect so terminal events that fired while the
      // channel was down don't leave stale rows in the sidebar.
      onReconnect: () => {
        void refreshSessionsList();
      },
    });
  }, [isOpen, projectId, refreshSessionsList]);

  // Sidebar handlers
  const handleSelectSession = useCallback(
    (sessionId: string) => {
      if (selectedSessionId === sessionId) {
        setMobileShowDetail(true);
        return;
      }
      setSelectedSessionId(sessionId);
      setMobileShowDetail(true);
      void loadSession(sessionId);
    },
    [loadSession, selectedSessionId],
  );

  const handleNewSession = useCallback(() => {
    streamConnectionRef.current?.close();
    streamConnectionRef.current = null;
    draftSessionIdRef.current = null;
    if (draftDebounceRef.current) {
      clearTimeout(draftDebounceRef.current);
      draftDebounceRef.current = null;
    }
    if (resumeSessionId) {
      dismissedResumeRef.current = resumeSessionId;
    }
    resetDetailState();
    setSelectedSessionId(null);
    setMobileShowDetail(true);
  }, [resetDetailState, resumeSessionId]);

  const handleBackToList = useCallback(() => {
    setMobileShowDetail(false);
  }, []);

  const previousMobileShowDetailRef = useRef<boolean>(false);

  useEffect(() => {
    if (!isOpen) {
      previousMobileShowDetailRef.current = false;
    }
  }, [isOpen]);

  useEffect(() => {
    const previousMobileShowDetail = previousMobileShowDetailRef.current;

    if (!isMobile) {
      // Keep the previous mobile detail state untouched on desktop so viewport flips don't trigger stale pushes.
      return;
    }

    if (!mobileShowDetail) {
      previousMobileShowDetailRef.current = false;
      return;
    }

    // FN-4187: Push on mobileShowDetail transitions (not selectedSessionId) so New Session also gets a back-stack entry.
    if (!previousMobileShowDetail) {
      pushNav({
        type: "view",
        revert: handleBackToList,
      });
    }

    previousMobileShowDetailRef.current = true;
  }, [handleBackToList, isMobile, mobileShowDetail, pushNav]);

  const syncPlanningDraft = useCallback(
    async (sessionId: string, planText: string) => {
      const trimmedPlan = planText.trim();
      if (!trimmedPlan) {
        return;
      }

      // Re-sync whenever the model selection changes, even if the plan text
      // is unchanged — otherwise the persisted draft would silently keep the
      // model the user picked at create time after they've switched.
      const alreadySynced =
        lastSyncedDraftRef.current?.sessionId === sessionId &&
        lastSyncedDraftRef.current.initialPlan === trimmedPlan &&
        lastSyncedDraftRef.current.modelProvider === planningModelProvider &&
        lastSyncedDraftRef.current.modelId === planningModelId;
      if (alreadySynced) {
        return;
      }

      try {
        await updatePlanningSessionDraft(
          sessionId,
          {
            initialPlan: trimmedPlan,
            modelProvider: planningModelProvider && planningModelId ? planningModelProvider : undefined,
            modelId: planningModelProvider && planningModelId ? planningModelId : undefined,
          },
          projectId,
        );
        lastSyncedDraftRef.current = {
          sessionId,
          initialPlan: trimmedPlan,
          modelProvider: planningModelProvider,
          modelId: planningModelId,
        };
      } catch {
        // best-effort draft sync; avoid blocking typing UX on transient failures
      }
    },
    [planningModelId, planningModelProvider, projectId],
  );

  useEffect(() => {
    if (draftSyncTimerRef.current) {
      clearTimeout(draftSyncTimerRef.current);
      draftSyncTimerRef.current = null;
    }

    if (!isOpen || view.type !== "initial" || !selectedSessionId) {
      return;
    }

    draftSyncTimerRef.current = setTimeout(() => {
      void syncPlanningDraft(selectedSessionId, initialPlan);
    }, 500);

    return () => {
      if (draftSyncTimerRef.current) {
        clearTimeout(draftSyncTimerRef.current);
        draftSyncTimerRef.current = null;
      }
    };
  }, [initialPlan, isOpen, selectedSessionId, syncPlanningDraft, view.type]);

  useEffect(() => {
    lastSyncedDraftRef.current = null;
  }, [selectedSessionId]);

  useEffect(() => {
    return () => {
      if (draftSyncTimerRef.current) {
        clearTimeout(draftSyncTimerRef.current);
        draftSyncTimerRef.current = null;
      }
    };
  }, []);

  const handleDeleteSession = useCallback(
    async (sessionId: string) => {
      const isActiveServerSession = (status: AiSessionSummary["status"]) =>
        status === "generating" || status === "awaiting_input";

      const target = planningSessions.find((s) => s.id === sessionId);

      // Cancel an in-flight server session before deleting so the engine stops
      // generating; for terminal sessions skip the cancel call.
      if (target && isActiveServerSession(target.status)) {
        try {
          await cancelPlanning(sessionId, projectId, sessionTabId);
        } catch {
          // best-effort
        }
      }

      try {
        await deleteAiSession(sessionId);
      } catch {
        // best-effort: SSE will reconcile if the delete actually succeeded
      }

      // Broadcast completion so sibling consumers (BackgroundTasksIndicator's
      // useBackgroundSessions hook, other tabs) prune this session from their
      // active lists. The server-side SSE delete event covers the in-flight
      // path, but the cross-tab broadcast is what keeps the footer pill in
      // lockstep when this modal initiates the delete.
      broadcastCompleted({
        sessionId,
        status: "complete",
        timestamp: Date.now(),
      });

      setPlanningSessions((prev) => prev.filter((s) => s.id !== sessionId));

      if (selectedSessionId === sessionId) {
        streamConnectionRef.current?.close();
        streamConnectionRef.current = null;
        resetDetailState();
        setSelectedSessionId(null);
        setMobileShowDetail(false);
      }
      setPendingDeleteId(null);
    },
    [broadcastCompleted, planningSessions, projectId, resetDetailState, selectedSessionId, sessionTabId],
  );

  const handleArchiveSession = useCallback(
    async (sessionId: string) => {
      const target = planningSessions.find((s) => s.id === sessionId);
      const wasArchived = target?.archived === true;
      try {
        if (wasArchived) {
          await unarchiveAiSession(sessionId);
        } else {
          await archiveAiSession(sessionId);
        }
      } catch {
        // best-effort; SSE will reconcile on success and the row stays put on
        // failure so the user can retry.
        return;
      }
      // Optimistic local update — SSE will deliver the authoritative version.
      // When hiding (archive while showArchived=false) drop the row; when
      // unarchiving keep it visible with the new flag flipped.
      setPlanningSessions((prev) => {
        if (!wasArchived && !showArchived) {
          return prev.filter((s) => s.id !== sessionId);
        }
        return prev.map((s) => (s.id === sessionId ? { ...s, archived: !wasArchived } : s));
      });
      if (!wasArchived && selectedSessionId === sessionId && !showArchived) {
        // The currently-open archived session is no longer in the visible list;
        // collapse the detail pane so the user lands on a sensible default.
        streamConnectionRef.current?.close();
        streamConnectionRef.current = null;
        resetDetailState();
        setSelectedSessionId(null);
        setMobileShowDetail(false);
      }
    },
    [planningSessions, resetDetailState, selectedSessionId, setMobileShowDetail, showArchived],
  );

  // Reset hasAutoStarted when modal closes
  useEffect(() => {
    if (!isOpen) {
      hasAutoStartedRef.current = false;
      hasLoadedPersistedRef.current = false;
      setIsReconnecting(false);
      setIsRetrying(false);
      setLockSessionId(null);
    }
  }, [isOpen]);

  // Broadcast lock ownership transitions for cross-tab awareness.
  useEffect(() => {
    if (!isOpen) {
      if (trackedLockSessionRef.current) {
        broadcastUnlock(trackedLockSessionRef.current, sessionTabId);
        trackedLockSessionRef.current = null;
      }
      return;
    }

    if (lockSessionId && trackedLockSessionRef.current !== lockSessionId) {
      if (trackedLockSessionRef.current) {
        broadcastUnlock(trackedLockSessionRef.current, sessionTabId);
      }
      broadcastLock(lockSessionId, sessionTabId);
      trackedLockSessionRef.current = lockSessionId;
      return;
    }

    if (!lockSessionId && trackedLockSessionRef.current) {
      broadcastUnlock(trackedLockSessionRef.current, sessionTabId);
      trackedLockSessionRef.current = null;
    }
  }, [broadcastLock, broadcastUnlock, isOpen, lockSessionId, sessionTabId]);

  // Emit heartbeat while this tab actively owns the current session lock.
  useEffect(() => {
    if (!isOpen || !lockSessionId || trackedLockSessionRef.current !== lockSessionId) {
      return;
    }

    broadcastHeartbeat(sessionTabId);
    const timer = setInterval(() => {
      broadcastHeartbeat(sessionTabId);
    }, 30_000);

    return () => {
      clearInterval(timer);
    };
  }, [broadcastHeartbeat, isOpen, lockSessionId, sessionTabId]);

  // Cleanup stream connection on unmount
  useEffect(() => {
    return () => {
      if (draftDebounceRef.current) {
        clearTimeout(draftDebounceRef.current);
        draftDebounceRef.current = null;
      }
      streamConnectionRef.current?.close();
      streamConnectionRef.current = null;

      if (trackedLockSessionRef.current) {
        broadcastUnlock(trackedLockSessionRef.current, sessionTabId);
        trackedLockSessionRef.current = null;
      }
    };
  }, [broadcastUnlock, sessionTabId]);

  // Handle browser unload while modal is open
  useEffect(() => {
    if (!isOpen) return;

    const handleBeforeUnload = () => {
      // Session is preserved server-side; just disconnect the local stream.
      streamConnectionRef.current?.close();
      streamConnectionRef.current = null;
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [isOpen]);

  // Flush any pending debounced draft sync, then ask the server to (re)derive
  // the sidebar title from the persisted initialPlan. Fire-and-forget — the
  // server is idempotent and a no-op once the session has started, so it's
  // safe to invoke on textarea blur and on modal close. Awaiting the sync
  // first guarantees the summary reflects the user's freshest text rather
  // than whatever the last 500ms-debounced PATCH happened to persist.
  const flushDraftAndSummarize = useCallback(
    (sessionId: string, planText: string) => {
      if (draftSyncTimerRef.current) {
        clearTimeout(draftSyncTimerRef.current);
        draftSyncTimerRef.current = null;
      }
      void (async () => {
        try {
          await syncPlanningDraft(sessionId, planText);
          await summarizePlanningDraftTitle(sessionId, projectId);
        } catch {
          // best-effort title polish; don't surface to the user
        }
      })();
    },
    [projectId, syncPlanningDraft],
  );

  // Close the modal without abandoning the active server session. Sessions
  // remain in the list and can be resumed later. Only an explicit Delete
  // (from the sidebar) cancels and removes a session.
  const resetMobileViewportAfterClose = useCallback(() => {
    if (viewportMode !== "mobile") {
      return;
    }

    const activeElement = document.activeElement;
    if (activeElement instanceof HTMLElement) {
      activeElement.blur();
    }

    window.scrollTo(0, 0);
    requestAnimationFrame(() => {
      window.scrollTo(0, 0);
    });
  }, [viewportMode]);

  const handleClose = useCallback(() => {
    // Save the in-progress draft so the next open restores it.
    if (initialPlan && view.type === "initial") {
      savePlanningDescription(initialPlan, projectId);
    }

    // Capture before clearing — we want to fire summarize for this draft even
    // though we're tearing down local state.
    const draftSessionId = draftSessionIdRef.current;
    if (draftSessionId && initialPlan.trim()) {
      flushDraftAndSummarize(draftSessionId, initialPlan);
    }

    draftSessionIdRef.current = null;
    if (draftDebounceRef.current) {
      clearTimeout(draftDebounceRef.current);
      draftDebounceRef.current = null;
    }
    streamConnectionRef.current?.close();
    streamConnectionRef.current = null;
    setIsReconnecting(false);
    setIsRetrying(false);
    resetMobileViewportAfterClose();
    onClose();
  }, [flushDraftAndSummarize, initialPlan, onClose, projectId, resetMobileViewportAfterClose, view.type]);

  // Handle escape key to close
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        handleClose();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, handleClose]);

  const handleSubmitResponse = useCallback(
    async (responses: QuestionResponse) => {
      if (view.type !== "question") return;

      const { session } = view;
      const sessionId = session.sessionId;
      const activeQuestion = session.currentQuestion;
      if (!activeQuestion) {
        setError("No active question in session");
        return;
      }

      setError(null);

      // Keep the existing SSE connection alive - do NOT close it!
      // The connection established in handleStartPlanning will continue
      // to receive events (thinking, question, summary) throughout the session.
      // This prevents the race condition where events are missed because
      // the frontend disconnects and reconnects after the API call.

      setResponseHistory((prev) => [...prev, responses]);
      setConversationHistory((prev) => {
        // Capture any reasoning that accumulated since the last question
        // (e.g. thinking streamed while the user was reading the question).
        const currentThinking = streamingOutputRef.current.trim();
        let updated = prev;
        if (currentThinking) {
          const lastEntry = updated[updated.length - 1];
          if (lastEntry?.thinkingOutput !== currentThinking) {
            updated = [...updated, { thinkingOutput: currentThinking }];
          }
        }
        return [
          ...updated,
          {
            question: activeQuestion,
            response: responses,
          },
        ];
      });
      setView({ type: "loading" });
      setStreamingOutput(""); // Clear old thinking output when entering loading state

      try {
        // Submit response - AI will broadcast events via the already-connected stream
        await respondToPlanning(sessionId, responses, projectId, sessionTabId);
        // Events (question/summary) will arrive via the existing SSE stream
      } catch (err) {
        setError(getErrorMessage(err) || "Failed to submit response");
        setView({ type: "question", session });
      }
    },
    [projectId, sessionTabId, view]
  );

  const handleRefineFurther = useCallback(async () => {
    if (view.type !== "summary") {
      return;
    }

    const { session, summary } = view;
    const sessionId = session.sessionId;
    currentSessionIdRef.current = sessionId;
    setLockSessionId(sessionId);

    setError(null);
    setIsRetrying(false);
    setStreamingOutput("");
    setView({ type: "loading" });

    connectToPlanningStream(sessionId);

    try {
      await respondToPlanning(sessionId, { refine: true }, projectId, sessionTabId);
    } catch (err) {
      streamConnectionRef.current?.close();
      streamConnectionRef.current = null;
      setError(getErrorMessage(err) || "Failed to refine plan");
      setView({ type: "summary", session, summary: editedSummary ?? summary });
    }
  }, [connectToPlanningStream, editedSummary, projectId, sessionTabId, view]);

  const handleStopGeneration = useCallback(async () => {
    const sessionId = currentSessionIdRef.current;
    if (!sessionId) {
      return;
    }

    try {
      await stopPlanningGeneration(sessionId, projectId, sessionTabId);
    } catch {
      // best-effort; server-side timeout/stop event may have already fired
    }

    streamConnectionRef.current?.close();
    streamConnectionRef.current = null;
    setIsReconnecting(false);
    setIsRetrying(false);
    setView({
      type: "error",
      session: { sessionId, currentQuestion: null, summary: null },
      errorMessage: "Generation stopped by user. You can retry or start a new session.",
    });
    setStreamingOutput("");
  }, [projectId, sessionTabId]);

  const handleRetryFromError = useCallback(async () => {
    if (view.type !== "error") {
      return;
    }

    const retryTarget = view.session;
    setError(null);
    setIsRetrying(true);
    setStreamingOutput("");
    setView({ type: "loading" });

    connectToPlanningStream(retryTarget.sessionId);

    try {
      currentSessionIdRef.current = retryTarget.sessionId;
      setLockSessionId(retryTarget.sessionId);
      await retryPlanningSession(retryTarget.sessionId, projectId, sessionTabId);
    } catch (err) {
      let retryError: unknown = err;
      const retryErrorMessage = getErrorMessage(err) || "";

      if (retryErrorMessage.includes("not in an error state")) {
        try {
          const session = await fetchAiSession(retryTarget.sessionId);
          if (!session) {
            throw new Error("Failed to refresh planning session.");
          }

          currentSessionIdRef.current = session.id;
          setLockSessionId(session.id);

          if (session.status === "generating") {
            setStreamingOutput(session.thinkingOutput ?? "");
            setView({ type: "loading" });
          } else if (session.status === "awaiting_input") {
            if (!session.currentQuestion) {
              throw new Error("Planning session is awaiting input but has no current question.");
            }
            const question = JSON.parse(session.currentQuestion) as PlanningQuestion;
            clearPlanningDescription(projectId);
            setView({
              type: "question",
              session: { sessionId: session.id, currentQuestion: question, summary: null },
            });
            if (session.thinkingOutput) {
              const trimmed = session.thinkingOutput.trim();
              if (trimmed) {
                setConversationHistory((prev) => {
                  const lastEntry = prev[prev.length - 1];
                  if (lastEntry?.thinkingOutput === trimmed) return prev;
                  return [...prev, { thinkingOutput: trimmed }];
                });
              }
            }
            if (!streamConnectionRef.current?.isConnected()) {
              connectToPlanningStream(session.id);
            }
          } else if (session.status === "complete") {
            if (!session.result) {
              throw new Error("Planning session is complete but has no result.");
            }
            const summary = normalizePlanningSummary(JSON.parse(session.result) as PlanningSummary);
            clearPlanningDescription(projectId);
            setView({
              type: "summary",
              session: { sessionId: session.id, currentQuestion: null, summary },
              summary,
            });
            setEditedSummary(summary);
          } else if (session.status === "error") {
            setView({
              type: "error",
              session: { sessionId: session.id, currentQuestion: null, summary: null },
              errorMessage: session.error || "Retry failed. Please try again.",
            });
          }

          setIsReconnecting(false);
          return;
        } catch (sessionRefreshError) {
          retryError = sessionRefreshError;
        }
      }

      streamConnectionRef.current?.close();
      streamConnectionRef.current = null;
      setView({
        type: "error",
        session: retryTarget,
        errorMessage: getErrorMessage(retryError) || "Retry failed. Please try again.",
      });
      setIsReconnecting(false);
    } finally {
      setIsRetrying(false);
    }
  }, [connectToPlanningStream, projectId, sessionTabId, view]);

  const handleCreateTask = useCallback(async () => {
    if (view.type !== "summary") return;

    setError(null);
    setIsCreatingTask(true);

    try {
      const completedSessionId = view.session.sessionId;
      const task = await createTaskFromPlanning(completedSessionId, editedSummary ?? undefined, projectId);
      onTaskCreated(task);
      // The server cleans up the planning session after task creation. Drop
      // the local selection so a future reopen doesn't try to fetch a deleted
      // id (which would otherwise show "Session not found"). Also broadcast
      // completion so the footer's useBackgroundSessions prunes its count.
      setSelectedSessionId(null);
      setPlanningSessions((prev) => prev.filter((s) => s.id !== completedSessionId));
      broadcastCompleted({
        sessionId: completedSessionId,
        status: "complete",
        timestamp: Date.now(),
      });
      handleClose();
    } catch (err) {
      setError(getErrorMessage(err) || "Failed to create task");
    } finally {
      setIsCreatingTask(false);
    }
  }, [broadcastCompleted, editedSummary, view, projectId, onTaskCreated, handleClose]);

  const handleStartBreakdown = useCallback(async () => {
    if (view.type !== "summary") return;

    setError(null);
    setIsStartingBreakdown(true);

    try {
      const result = await startPlanningBreakdown(view.session.sessionId, editedSummary ?? undefined, projectId);
      const normalizedSubtasks = result.subtasks.map((subtask) => ({
        ...subtask,
        priority: normalizeTaskPriority(subtask.priority),
        dependsOn: [...subtask.dependsOn],
      }));
      setLockSessionId(result.sessionId);
      setView({
        type: "breakdown",
        sessionId: result.sessionId,
        originalSubtasks: normalizedSubtasks.map((subtask) => ({ ...subtask, dependsOn: [...subtask.dependsOn] })),
        subtasks: normalizedSubtasks.map((subtask) => ({ ...subtask, dependsOn: [...subtask.dependsOn] })),
        dirty: false,
      });
    } catch (err) {
      setError(getErrorMessage(err) || "Failed to start breakdown");
    } finally {
      setIsStartingBreakdown(false);
    }
  }, [editedSummary, view, projectId]);

  const handleCreateTasksFromBreakdown = useCallback(async () => {
    if (view.type !== "breakdown") return;

    setError(null);
    setIsCreatingFromBreakdown(true);

    try {
      const completedSessionId = view.sessionId;
      const result = await createTasksFromPlanning(
        completedSessionId,
        buildCompactPlanningSubtaskDrafts(
          view.originalSubtasks,
          view.subtasks.map((subtask) => ({
            ...subtask,
            priority: normalizeTaskPriority(subtask.priority),
          })),
        ),
        projectId,
      );
      onTasksCreated(result.tasks);
      // Server cleans up the planning session after task creation; mirror that
      // locally so reopen doesn't try to load a 404 and the footer count drops.
      setPlanningSessions((prev) => prev.filter((s) => s.id !== completedSessionId));
      broadcastCompleted({
        sessionId: completedSessionId,
        status: "complete",
        timestamp: Date.now(),
      });
      // Reset and close
      setInitialPlan("");
      setView({ type: "initial" });
      setError(null);
      setResponseHistory([]);
      setConversationHistory([]);
      setEditedSummary(null);
      setStreamingOutput("");
      setPlanningModelProvider(undefined);
      setPlanningModelId(undefined);
      setPlanningDepth("medium");
      setCustomQuestionCount("");
      currentSessionIdRef.current = null;
      setLockSessionId(null);
      setSelectedSessionId(null);
      handleClose();
    } catch (err) {
      setError(getErrorMessage(err) || "Failed to create tasks");
    } finally {
      setIsCreatingFromBreakdown(false);
    }
  }, [broadcastCompleted, handleClose, view, onTasksCreated, projectId]);

  const handleBack = useCallback(async () => {
    if (view.type !== "question" || responseHistory.length === 0) {
      return;
    }

    const sessionId = view.session.sessionId;
    setError(null);
    setView({ type: "loading" });

    try {
      const rewound = await rewindPlanningSession(sessionId, projectId, sessionTabId);
      setResponseHistory(rewound.history.map((entry) => {
        if (entry.response && typeof entry.response === "object" && !Array.isArray(entry.response)) {
          return entry.response as QuestionResponse;
        }
        return { [entry.question.id]: entry.response };
      }));
      setConversationHistory(rewound.history.map((entry) => ({
        question: entry.question,
        response:
          entry.response && typeof entry.response === "object" && !Array.isArray(entry.response)
            ? (entry.response as Record<string, unknown>)
            : { [entry.question.id]: entry.response },
        thinkingOutput: entry.thinkingOutput,
      })));
      setStreamingOutput("");
      setView({
        type: "question",
        session: {
          ...view.session,
          currentQuestion: rewound.currentQuestion,
          summary: null,
        },
      });
    } catch (err) {
      setError(getErrorMessage(err) || "Failed to go back to the previous question");
      setView({ type: "question", session: view.session });
    }
  }, [projectId, responseHistory.length, sessionTabId, view]);

  const getProgress = () => {
    if (view.type === "question") {
      return Math.min(responseHistory.length + 1, 3);
    }
    return 3;
  };

  const activeLockInfo = lockSessionId ? activeTabMap.get(lockSessionId) : null;
  const activeRemoteTab = activeLockInfo && activeLockInfo.tabId !== sessionTabId;
  const allowTakeover = isLockedByOther && (!activeRemoteTab || activeLockInfo.stale);

  if (!isOpen) return null;

  return (
    <div
      className="modal-overlay open"
      onMouseDown={(e) => {
        overlayMouseDownOnSelfRef.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && overlayMouseDownOnSelfRef.current) {
          handleClose();
        }
        overlayMouseDownOnSelfRef.current = false;
      }}
      role="dialog"
      aria-modal="true"
    >
      <div className="modal modal-lg planning-modal" ref={modalRef}>
        <div className="modal-header">
          <div className="detail-title-row">
            {mobileShowDetail && (
              <button
                className="modal-back planning-mobile-back"
                onClick={handleBackToList}
                aria-label="Back to sessions"
                title="Back to sessions"
              >
                <ChevronLeft size={18} />
              </button>
            )}
            <Lightbulb size={20} className="icon-triage" />
            <h3>Planning Mode</h3>
          </div>
          <div className="modal-header-actions">
            <button className="modal-close" onClick={handleClose} aria-label="Close">
              <X size={20} />
            </button>
          </div>
        </div>

        <div
          className={`planning-modal-body planning-modal-body--split ${
            mobileShowDetail ? "planning-modal-body--show-detail" : "planning-modal-body--show-list"
          }`}
        >
          <PlanningSessionList
            sessions={planningSessions}
            loading={sessionsLoading}
            selectedSessionId={selectedSessionId}
            pendingDeleteId={pendingDeleteId}
            showArchived={showArchived}
            onToggleShowArchived={() => setShowArchived((v) => !v)}
            onArchive={(id) => void handleArchiveSession(id)}
            onSelectSession={handleSelectSession}
            onNewSession={handleNewSession}
            onRequestDelete={setPendingDeleteId}
            onConfirmDelete={(id) => void handleDeleteSession(id)}
            onCancelDelete={() => setPendingDeleteId(null)}
          />

          <div className="planning-detail">
          {error && <div className="form-error planning-error">{error}</div>}
          {isReconnecting && <div className="form-hint text-muted">Reconnecting…</div>}

          {view.type === "initial" && (
            <div className="planning-initial">
              <div className="planning-view-scroll">
                <div className="planning-intro">
                  <Sparkles size={32} className="icon-triage-lg" />
                  <h4>Transform your idea into a detailed task</h4>
                  <p className="text-muted">
                    Describe what you want to build in plain language. The AI will ask clarifying
                    questions and help you structure a well-defined task.
                  </p>
                </div>

                <div className="form-group">
                  <label htmlFor="initial-plan">What do you want to build?</label>
                  <textarea
                    ref={setInitialPlanTextareaRef}
                    id="initial-plan"
                    className="planning-textarea"
                    placeholder="e.g., Build a user authentication system with login, signup, and password reset..."
                    value={initialPlan}
                    onChange={(e) => {
                      const nextValue = e.target.value;
                      setInitialPlan(nextValue);
                      if (draftSessionIdRef.current || nextValue.trim().length === 0) {
                        return;
                      }
                      if (draftDebounceRef.current) {
                        clearTimeout(draftDebounceRef.current);
                      }
                      draftDebounceRef.current = setTimeout(() => {
                        if (draftSessionIdRef.current) {
                          return;
                        }
                        const content = nextValue.trim();
                        if (!content) {
                          return;
                        }
                        const modelOverride =
                          planningModelProvider && planningModelId
                            ? { planningModelProvider, planningModelId }
                            : undefined;
                        void createPlanningDraft(content, projectId, modelOverride)
                          .then((response) => {
                            draftSessionIdRef.current = response.sessionId;
                            setPlanningSessions((prev) => {
                              if (prev.some((s) => s.id === response.sessionId)) {
                                return prev;
                              }
                              const draft: AiSessionSummary = {
                                id: response.sessionId,
                                type: "planning",
                                status: "draft",
                                title: response.title,
                                preview: content.length > 80 ? `${content.slice(0, 79).trimEnd()}…` : content,
                                projectId: projectId ?? null,
                                lockedByTab: null,
                                updatedAt: new Date().toISOString(),
                                archived: false,
                              };
                              return [draft, ...prev].sort(
                                (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
                              );
                            });
                            setSelectedSessionId(response.sessionId);
                          })
                          .catch(() => {
                            // best-effort
                          });
                      }, 300);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey && initialPlan.trim()) {
                        e.preventDefault();
                        handleStartPlanning();
                      }
                    }}
                    onBlur={() => {
                      // User paused or moved focus away — good moment to
                      // upgrade the sidebar from "New planning session" to a
                      // model-summarized title. No-op if the draft hasn't
                      // been persisted yet or if it's already been started.
                      const draftSessionId = draftSessionIdRef.current;
                      if (draftSessionId && initialPlan.trim()) {
                        flushDraftAndSummarize(draftSessionId, initialPlan);
                      }
                    }}
                  />
                </div>

                <div className="planning-examples">
                  <span className="planning-examples-label">Try an example:</span>
                  <div className="planning-example-chips">
                    {EXAMPLE_PLANS.map((plan, i) => (
                      <button
                        key={i}
                        className="planning-example-chip"
                        onClick={() => setInitialPlan(plan)}
                      >
                        {plan.length > 40 ? plan.slice(0, 40) + "..." : plan}
                      </button>
                    ))}
                  </div>
                </div>

                <OnboardingDisclosure summary="Advanced planning settings" className="planning-advanced-disclosure">
                  <div className="planning-advanced-content">
                    <div className="planning-advanced-section planning-model-select-group">
                    <label htmlFor="planning-modal-model" className="form-label">
                      Planning Model
                      {modelsLoading && (
                        <span className="text-muted text-muted-sm">
                          Loading models…
                        </span>
                      )}
                    </label>
                    <p className="planning-advanced-blurb">
                      Selects which model runs the planning interview and writes the final draft.
                    </p>
                    <CustomModelDropdown
                      id="planning-modal-model"
                      label="Planning Model"
                      value={planningSelectionValue}
                      onChange={(value) => {
                        const { provider, modelId } = parseModelSelection(value);
                        setPlanningModelProvider(provider);
                        setPlanningModelId(modelId);
                      }}
                      models={loadedModels}
                      disabled={modelsLoading}
                      favoriteProviders={favoriteProviders}
                      onToggleFavorite={handleToggleFavoriteProvider}
                      favoriteModels={favoriteModels}
                      onToggleModelFavorite={handleToggleFavoriteModel}
                    />
                    {modelsError && (
                      <div className="form-hint form-hint-error">
                        {modelsError}{" "}
                        <button
                          type="button"
                          className="text-link-btn"
                          onClick={() => {
                            void loadModels();
                          }}
                        >
                          Retry
                        </button>
                      </div>
                    )}
                    <div className="model-selector-current model-selector-current--spaced">
                      <span
                        className={`model-badge ${
                          planningModelProvider && planningModelId
                            ? "model-badge-custom"
                            : "model-badge-default"
                        }`}
                      >
                        {getModelBadgeLabel(planningModelProvider, planningModelId)}
                      </span>
                    </div>
                  </div>

                    <div className="planning-advanced-section planning-depth-selector">
                      <p className="planning-advanced-blurb">
                        Plan size sets default interview depth. Questions lets you override with an exact count.
                      </p>
                      <div className="planning-depth-controls-row">
                        <div className="planning-depth-chip-group" role="group" aria-label="Planning depth">
                          {([
                            { value: "small", label: "Small" },
                            { value: "medium", label: "Medium" },
                            { value: "large", label: "Large" },
                          ] as const).map((depthOption) => (
                            <button
                              key={depthOption.value}
                              type="button"
                              className={`planning-depth-chip btn ${planningDepth === depthOption.value ? "btn-primary planning-depth-chip-active" : ""}`}
                              onClick={() => setPlanningDepth(depthOption.value)}
                              aria-pressed={planningDepth === depthOption.value}
                            >
                              {depthOption.label}
                            </button>
                          ))}
                        </div>

                        <label className="planning-depth-question-count" htmlFor="planning-depth-questions">
                          <span>Questions</span>
                          <input
                            id="planning-depth-questions"
                            className="input planning-depth-question-input"
                            type="number"
                            min={1}
                            max={20}
                            value={customQuestionCount}
                            onChange={(e) => setCustomQuestionCount(e.target.value)}
                            placeholder="Auto"
                          />
                        </label>
                      </div>
                    </div>
                  </div>
                </OnboardingDisclosure>
              </div>

              <div className="planning-view-footer">
                <button
                  className="btn btn-primary planning-start-btn"
                  onClick={() => handleStartPlanning()}
                  disabled={!initialPlan.trim()}
                >
                  <Lightbulb size={16} className="icon-mr-8" />
                  Start Planning
                </button>
              </div>
            </div>
          )}

          {view.type === "loading" && (
            <div className="planning-loading">
              <Loader2 size={40} className="spin icon-todo" />
              <p>{streamingOutput ? "AI is thinking..." : "Generating next question..."}</p>
              {generationStartTime && (
                <div className="planning-elapsed">Thinking… ({elapsedSeconds}s)</div>
              )}
              <div className="planning-thinking-container">
                <button
                  className="planning-thinking-toggle"
                  onClick={() => setShowThinking(!showThinking)}
                  type="button"
                >
                  {showThinking ? "Hide thinking" : "Show thinking"}
                </button>
                <div className="planning-loading-actions">
                  <button className="btn planning-stop-btn" type="button" onClick={() => void handleStopGeneration()}>
                    <StopCircle size={14} />
                    <span className="icon-ml-6">Stop</span>
                  </button>
                </div>
                {showThinking && streamingOutput && (
                  <div className="planning-thinking-output" ref={thinkingOutputRef}>
                    <pre>{streamingOutput}</pre>
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
                    <ConversationHistory entries={conversationHistory} />
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
                    <button className="btn btn-primary" onClick={() => void handleRetryFromError()} disabled={isRetrying}>
                      {isRetrying ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
                      <span className="icon-ml-6">{isRetrying ? "Retrying..." : "Retry"}</span>
                    </button>
                    <button className="btn" onClick={handleClose} disabled={isRetrying}>Dismiss</button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {view.type === "question" && view.session.currentQuestion && (
            <div className="planning-question">
              <QuestionForm
                question={view.session.currentQuestion}
                progress={getProgress()}
                historyEntries={conversationHistory}
                onSubmit={handleSubmitResponse}
                onBack={responseHistory.length > 0 ? handleBack : undefined}
              />
            </div>
          )}

          {view.type === "summary" && editedSummary && (
            <SummaryView
              summary={editedSummary}
              historyEntries={conversationHistory}
              onSummaryChange={setEditedSummary}
              tasks={tasks}
              onCreateTask={handleCreateTask}
              onBreakIntoTasks={handleStartBreakdown}
              onRefine={() => {
                void handleRefineFurther();
              }}
              isLoading={isCreatingTask || isStartingBreakdown}
            />
          )}

          {view.type === "breakdown" && (
            <BreakdownView
              subtasks={view.subtasks}
              isLoading={isCreatingFromBreakdown}
              onUpdateSubtasks={(newSubtasks) =>
                setView({ ...view, subtasks: newSubtasks, dirty: true })
              }
              onCreateTasks={handleCreateTasksFromBreakdown}
              onBack={() => {
                // Return to summary view — re-fetch the session
                const sessionId = view.sessionId;
                const session: PlanningSession = {
                  sessionId,
                  currentQuestion: null,
                  summary: editedSummary ?? null,
                };
                if (editedSummary) {
                  setView({ type: "summary", session, summary: editedSummary });
                }
              }}
            />
          )}
          </div>

          {isLockedByOther && (
            <div className="session-lock-overlay" data-testid="session-lock-overlay">
              <div className="session-lock-banner">
                <Lock size={16} />
                <span>
                  {allowTakeover
                    ? "This session is active in another tab"
                    : "This session is active in another tab (live heartbeat)"}
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
                    {isLockLoading ? "Taking control..." : "Take Control"}
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

interface QuestionFormProps {
  question: PlanningQuestion;
  progress: number;
  historyEntries: ConversationHistoryEntry[];
  onSubmit: (responses: QuestionResponse) => void;
  onBack?: () => void;
}

function QuestionForm({ question, progress, historyEntries, onSubmit, onBack }: QuestionFormProps) {
  const [response, setResponse] = useState<QuestionResponse>({});
  const [textValue, setTextValue] = useState("");
  const [commentValue, setCommentValue] = useState("");
  const { ref: textAnswerAutosizeRef } = useAutosizeTextarea({
    value: textValue,
    minHeight: 120,
    maxHeight: 320,
    deps: [question.id],
  });
  const { ref: commentAutosizeRef } = useAutosizeTextarea({
    value: commentValue,
    minHeight: 80,
    maxHeight: 320,
    deps: [question.id],
  });

  const handleSubmit = useCallback(() => {
    let nextResponse: QuestionResponse;

    if (question.type === "text") {
      nextResponse = { [question.id]: textValue };
    } else if (question.type === "confirm") {
      nextResponse = { [question.id]: response[question.id] === true };
    } else {
      nextResponse = response;
    }

    const trimmedComment = commentValue.trim();
    if (trimmedComment.length > 0) {
      nextResponse = { ...nextResponse, _comment: trimmedComment };
    }

    onSubmit(nextResponse);
  }, [commentValue, question, response, textValue, onSubmit]);

  // Reset state when question changes
  useEffect(() => {
    setResponse({});
    setTextValue("");
    setCommentValue("");
  }, [question.id]);

  const isValid = () => {
    switch (question.type) {
      case "text":
        return textValue.trim().length > 0;
      case "single_select":
        return response[question.id] !== undefined;
      case "multi_select":
        return Array.isArray(response[question.id] as unknown) && (response[question.id] as unknown[]).length > 0;
      case "confirm":
        return response[question.id] !== undefined;
      default:
        return true;
    }
  };

  return (
    <div className="planning-question-form">
      <div className="planning-view-scroll planning-question-scroll">
        {historyEntries.length > 0 && (
          <>
            <ConversationHistory entries={historyEntries} />
            <div className="conversation-separator" />
          </>
        )}

        <div className="planning-question-panel">
          <div className="planning-progress">
            <div className="planning-progress-bar">
              {[1, 2, 3].map((step) => (
                <div
                  key={step}
                  className={`planning-progress-step ${step <= progress ? "active" : ""}`}
                />
              ))}
            </div>
            <span className="planning-progress-text">Question {progress} of ~3</span>
          </div>

          <div className="planning-question-content">
            <h4 className="planning-question-text">{question.question}</h4>
            {question.description && (
              <p className="planning-question-desc">{question.description}</p>
            )}

            <div className="planning-options">
              {question.type === "text" && (
                <textarea
                  ref={textAnswerAutosizeRef}
                  className="planning-textarea"
                  placeholder="Type your answer here..."
                  value={textValue}
                  onChange={(e) => setTextValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey && textValue.trim()) {
                      e.preventDefault();
                      handleSubmit();
                    }
                  }}
                />
              )}

              {question.type === "single_select" && question.options && (
                <div className="planning-radio-group" role="radiogroup">
                  {question.options.map((option) => (
                    <label key={option.id} className="planning-option planning-option--radio">
                      <input
                        type="radio"
                        name={question.id}
                        value={option.id}
                        checked={response[question.id] === option.id}
                        onChange={() => setResponse({ [question.id]: option.id })}
                      />
                      <div className="planning-option-content">
                        <span className="planning-option-label">{option.label}</span>
                        {option.description && (
                          <span className="planning-option-desc">{option.description}</span>
                        )}
                      </div>
                    </label>
                  ))}
                </div>
              )}

              {question.type === "multi_select" && question.options && (
                <div className="planning-checkbox-group">
                  {question.options.map((option) => {
                    const selected = (response[question.id] as string[]) || [];
                    return (
                      <label key={option.id} className="planning-option planning-option--checkbox">
                        <input
                          type="checkbox"
                          value={option.id}
                          checked={selected.includes(option.id)}
                          onChange={(e) => {
                            const newSelected = e.target.checked
                              ? [...selected, option.id]
                              : selected.filter((id) => id !== option.id);
                            setResponse({ [question.id]: newSelected });
                          }}
                        />
                        <div className="planning-option-content">
                          <span className="planning-option-label">{option.label}</span>
                          {option.description && (
                            <span className="planning-option-desc">{option.description}</span>
                          )}
                        </div>
                      </label>
                    );
                  })}
                </div>
              )}

              {question.type === "confirm" && (
                <div className="planning-confirm-group">
                  <button
                    className={`planning-confirm-btn ${response[question.id] === true ? "selected" : ""}`}
                    onClick={() => setResponse({ [question.id]: true })}
                  >
                    <CheckCircle size={18} />
                    Yes
                  </button>
                  <button
                    className={`planning-confirm-btn ${response[question.id] === false ? "selected" : ""}`}
                    onClick={() => setResponse({ [question.id]: false })}
                  >
                    <X size={18} />
                    No
                  </button>
                </div>
              )}
            </div>

            {question.type !== "text" && (
              <div className="planning-comment-section">
                <label className="planning-comment-label" htmlFor={`planning-comment-${question.id}`}>
                  Additional comments (optional)
                </label>
                <textarea
                  ref={commentAutosizeRef}
                  id={`planning-comment-${question.id}`}
                  className="planning-textarea"
                  placeholder="Add any extra context or direction..."
                  value={commentValue}
                  onChange={(e) => setCommentValue(e.target.value)}
                />
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="planning-actions">
        {onBack && (
          <button className="btn" onClick={onBack}>
            <ArrowLeft size={16} className="icon-mr-4" />
            Back
          </button>
        )}
        <button
          className="btn btn-primary planning-actions-primary"
          onClick={handleSubmit}
          disabled={!isValid()}
        >
          Continue
          <ArrowRight size={16} className="icon-ml-4" />
        </button>
      </div>
    </div>
  );
}

interface SummaryViewProps {
  summary: PlanningSummary;
  historyEntries: ConversationHistoryEntry[];
  onSummaryChange: (summary: PlanningSummary) => void;
  tasks: Task[];
  onCreateTask: () => void;
  onBreakIntoTasks: () => void;
  onRefine: () => void;
  isLoading: boolean;
}

function SummaryView({
  summary,
  historyEntries,
  onSummaryChange,
  tasks,
  onCreateTask,
  onBreakIntoTasks,
  onRefine,
  isLoading,
}: SummaryViewProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [selectedDependencies, setSelectedDependencies] = useState<string[]>(
    summary.suggestedDependencies
  );
  const { ref: descriptionAutosizeRef } = useAutosizeTextarea({
    value: summary.description,
    minHeight: isExpanded ? 200 : 120,
    maxHeight: isExpanded ? 480 : 320,
    deps: [isExpanded],
  });
  const selectedPriority = normalizeTaskPriority(summary.priority);

  const handleDependencyToggle = (taskId: string) => {
    const newDeps = selectedDependencies.includes(taskId)
      ? selectedDependencies.filter((id) => id !== taskId)
      : [...selectedDependencies, taskId];
    setSelectedDependencies(newDeps);
    onSummaryChange({ ...summary, suggestedDependencies: newDeps });
  };

  return (
    <div className="planning-summary">
      <div className="planning-view-scroll planning-summary-scroll">
        {historyEntries.length > 0 && (
          <OnboardingDisclosure summary="Show user Q&A" className="planning-summary-qa-disclosure">
            <ConversationHistory entries={historyEntries} />
            <div className="conversation-separator" />
          </OnboardingDisclosure>
        )}

        <div className="planning-summary-header">
          <CheckCircle size={24} className="icon-success" />
          <h4>Planning Complete!</h4>
          <p className="text-muted">Review and refine your task before creating it.</p>
        </div>

        <div className="planning-summary-form">
          <div className="form-group">
            <label>
              Description
              <button
                type="button"
                className="planning-expand-btn"
                onClick={() => setIsExpanded(!isExpanded)}
              >
                {isExpanded ? "Collapse" : "Expand"}
              </button>
            </label>
            <textarea
              ref={descriptionAutosizeRef}
              className={`planning-textarea ${isExpanded ? "expanded" : ""}`}
              value={summary.description}
              onChange={(e) => onSummaryChange({ ...summary, description: e.target.value })}
            />
          </div>

          <div className="planning-summary-meta-row">
            <div className="form-group">
              <label htmlFor="planning-summary-size">Suggested Size</label>
              <select
                id="planning-summary-size"
                className="planning-size-select"
                value={summary.suggestedSize}
                onChange={(event) =>
                  onSummaryChange({
                    ...summary,
                    suggestedSize: event.target.value as "S" | "M" | "L",
                  })
                }
                disabled={isLoading}
              >
                <option value="S">S (Small)</option>
                <option value="M">M (Medium)</option>
                <option value="L">L (Large)</option>
              </select>
            </div>

            <div className="form-group">
              <label htmlFor="planning-summary-priority">Priority</label>
              <select
                id="planning-summary-priority"
                className="planning-size-select"
                value={selectedPriority}
                onChange={(event) =>
                  onSummaryChange({
                    ...summary,
                    priority: event.target.value as TaskPriority,
                  })
                }
                disabled={isLoading}
              >
                {TASK_PRIORITIES.map((priorityOption) => (
                  <option key={priorityOption} value={priorityOption}>
                    {priorityOption[0].toUpperCase() + priorityOption.slice(1)}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {tasks.length > 0 && (
            <div className="form-group">
              <label>Suggested Dependencies</label>
              <div className="planning-deps-list">
                {tasks.map((task) => (
                  <label
                    key={task.id}
                    className={`planning-dep-chip ${selectedDependencies.includes(task.id) ? "selected" : ""}`}
                  >
                    <input
                      type="checkbox"
                      checked={selectedDependencies.includes(task.id)}
                      onChange={() => handleDependencyToggle(task.id)}
                    />
                    <span className="planning-dep-id">{task.id}</span>
                    <span className="planning-dep-title">
                      {task.title || task.description.slice(0, 30)}
                    </span>
                  </label>
                ))}
              </div>
            </div>
          )}

          <div className="form-group">
            <label>Key Deliverables</label>
            <ul className="planning-deliverables">
              {summary.keyDeliverables.map((item, i) => (
                <li key={i}>{item}</li>
              ))}
            </ul>
          </div>
        </div>
      </div>

      <div className="planning-actions planning-summary-actions">
        <button className="btn" onClick={onRefine} disabled={isLoading}>
          <ArrowLeft size={16} className="icon-mr-4" />
          Refine Further
        </button>
        <div className="planning-summary-actions-right">
          <button className="btn" onClick={onCreateTask} disabled={isLoading}>
            {isLoading ? (
              <>
                <Loader2 size={16} className="spin icon-mr-8" />
                Creating...
              </>
            ) : (
              <>
                <CheckCircle size={16} className="icon-mr-8" />
                Create Single Task
              </>
            )}
          </button>
          <button
            className="btn btn-primary"
            onClick={onBreakIntoTasks}
            disabled={isLoading}
            title="Break the plan into multiple tasks with dependencies"
          >
            {isLoading ? (
              <>
                <Loader2 size={16} className="spin icon-mr-8" />
                Breaking down...
              </>
            ) : (
              <>
                <ListTree size={16} className="icon-mr-8" />
                Break into Tasks
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── BreakdownView (subtask editing in planning modal) ──────────────────────

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

function createEmptySubtask(index: number): SubtaskItem {
  return {
    id: `subtask-${index}`,
    title: "",
    description: "",
    suggestedSize: "M",
    priority: DEFAULT_TASK_PRIORITY,
    dependsOn: [],
  };
}

interface BreakdownViewProps {
  subtasks: SubtaskItem[];
  isLoading: boolean;
  onUpdateSubtasks: (subtasks: SubtaskItem[]) => void;
  onCreateTasks: () => void;
  onBack: () => void;
}

function BreakdownView({
  subtasks,
  isLoading,
  onUpdateSubtasks,
  onCreateTasks,
  onBack,
}: BreakdownViewProps) {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [dragOverPosition, setDragOverPosition] = useState<"before" | "after" | null>(null);
  const titleRefs = useRef<Array<HTMLInputElement | null>>([]);

  const isInvalid = useMemo(() => {
    if (subtasks.length === 0) return true;
    if (subtasks.some((s) => !s.title.trim())) return true;
    return hasDependencyCycle(subtasks);
  }, [subtasks]);

  const updateSubtask = useCallback(
    (id: string, patch: Partial<SubtaskItem>) => {
      onUpdateSubtasks(subtasks.map((item) => (item.id === id ? { ...item, ...patch } : item)));
    },
    [subtasks, onUpdateSubtasks],
  );

  const addSubtask = useCallback(() => {
    onUpdateSubtasks([...subtasks, createEmptySubtask(subtasks.length + 1)]);
  }, [subtasks, onUpdateSubtasks]);

  const removeSubtask = useCallback(
    (id: string) => {
      onUpdateSubtasks(
        subtasks
          .filter((item) => item.id !== id)
          .map((item) => ({ ...item, dependsOn: item.dependsOn.filter((dep) => dep !== id) })),
      );
    },
    [subtasks, onUpdateSubtasks],
  );

  const moveSubtask = useCallback(
    (fromIndex: number, toIndex: number) => {
      if (toIndex < 0 || toIndex >= subtasks.length) return;
      const newSubtasks = [...subtasks];
      const [moved] = newSubtasks.splice(fromIndex, 1);
      newSubtasks.splice(toIndex, 0, moved);
      onUpdateSubtasks(newSubtasks);
    },
    [subtasks, onUpdateSubtasks],
  );

  // Drag-and-drop handlers
  const handleDragStart = useCallback((subtaskId: string) => (e: React.DragEvent) => {
    setDraggingId(subtaskId);
    e.dataTransfer.setData("text/plain", subtaskId);
    e.dataTransfer.effectAllowed = "move";
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
    const position: "before" | "after" = e.clientY < midY ? "before" : "after";
    setDragOverId(targetId);
    setDragOverPosition(position);
  }, [draggingId]);

  const handleDrop = useCallback((targetId: string) => (e: React.DragEvent) => {
    e.preventDefault();
    const draggedId = e.dataTransfer.getData("text/plain");
    if (!draggedId || draggedId === targetId) {
      handleDragEnd();
      return;
    }
    const fromIndex = subtasks.findIndex((s) => s.id === draggedId);
    const toIndex = subtasks.findIndex((s) => s.id === targetId);
    if (fromIndex === -1 || toIndex === -1) {
      handleDragEnd();
      return;
    }
    const newSubtasks = [...subtasks];
    const [moved] = newSubtasks.splice(fromIndex, 1);
    let insertIndex = toIndex;
    if (dragOverPosition === "after" && fromIndex < toIndex) insertIndex--;
    if (dragOverPosition === "after") insertIndex++;
    newSubtasks.splice(insertIndex, 0, moved);
    onUpdateSubtasks(newSubtasks);
    handleDragEnd();
  }, [subtasks, dragOverPosition, onUpdateSubtasks, handleDragEnd]);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = e.clientX;
    const y = e.clientY;
    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
      setDragOverId(null);
      setDragOverPosition(null);
    }
  }, []);

  return (
    <div className="planning-summary">
      <div className="planning-view-scroll planning-summary-scroll">
        <div className="planning-summary-header">
          <ListTree size={24} className="icon-triage" />
          <h4>Break into Tasks</h4>
          <p className="text-muted">
            Review and edit the subtasks generated from your plan. Adjust titles,
            descriptions, sizes, priorities, and dependencies before creating.
          </p>
        </div>

        <div className="planning-summary-form">
          {subtasks.map((subtask, index) => {
            const isDragging = draggingId === subtask.id;
            const isDragOver = dragOverId === subtask.id;
            const dragClasses = [
              "task-detail-section",
              "subtask-item",
              isDragging ? "subtask-item-dragging" : "",
              isDragOver ? "subtask-item-drop-target" : "",
              isDragOver && dragOverPosition === "before" ? "subtask-item-drop-before" : "",
              isDragOver && dragOverPosition === "after" ? "subtask-item-drop-after" : "",
            ]
              .filter(Boolean)
              .join(" ");

            return (
              <div
                key={subtask.id}
                className={dragClasses}
                data-testid={`subtask-item-${index}`}
                draggable={!isLoading}
                onDragStart={handleDragStart(subtask.id)}
                onDragEnd={handleDragEnd}
                onDragOver={handleDragOver(subtask.id)}
                onDrop={handleDrop(subtask.id)}
                onDragLeave={handleDragLeave}
              >
                <div
                  className="detail-title-row subtask-item-header subtask-item-header--between"
                >
                  <div className="subtask-drag-handle" title="Drag to reorder">
                    <GripVertical size={16} />
                    <strong>{subtask.id}</strong>
                  </div>
                  <div className="subtask-item-actions">
                    <button
                      type="button"
                      className="btn btn-icon btn-sm"
                      onClick={() => moveSubtask(index, index - 1)}
                      disabled={isLoading || index === 0}
                      title="Move up"
                      aria-label="Move subtask up"
                    >
                      <ArrowUp size={14} />
                    </button>
                    <button
                      type="button"
                      className="btn btn-icon btn-sm"
                      onClick={() => moveSubtask(index, index + 1)}
                      disabled={isLoading || index === subtasks.length - 1}
                      title="Move down"
                      aria-label="Move subtask down"
                    >
                      <ArrowDown size={14} />
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => removeSubtask(subtask.id)}
                      disabled={isLoading}
                    >
                      <Trash2 size={14} /> Remove
                    </button>
                  </div>
                </div>

                <div className="form-group">
                  <label>Title</label>
                  <input
                    ref={(element) => {
                      titleRefs.current[index] = element;
                    }}
                    value={subtask.title}
                    onChange={(event) => updateSubtask(subtask.id, { title: event.target.value })}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        if (index < subtasks.length - 1) {
                          titleRefs.current[index + 1]?.focus();
                        }
                      }
                    }}
                    disabled={isLoading}
                  />
                </div>

                <div className="form-group">
                  <label>Description</label>
                  <textarea
                    rows={3}
                    value={subtask.description}
                    onChange={(event) =>
                      updateSubtask(subtask.id, { description: event.target.value })
                    }
                    disabled={isLoading}
                  />
                </div>

                <div className="planning-summary-meta-row">
                  <div className="form-group">
                    <label htmlFor={`${subtask.id}-size`}>Size</label>
                    <select
                      id={`${subtask.id}-size`}
                      className="planning-size-select"
                      value={subtask.suggestedSize}
                      onChange={(event) =>
                        updateSubtask(subtask.id, {
                          suggestedSize: event.target.value as "S" | "M" | "L",
                        })
                      }
                      disabled={isLoading}
                    >
                      <option value="S">S</option>
                      <option value="M">M</option>
                      <option value="L">L</option>
                    </select>
                  </div>

                  <div className="form-group">
                    <label htmlFor={`${subtask.id}-priority`}>Priority</label>
                    <select
                      id={`${subtask.id}-priority`}
                      className="planning-size-select"
                      value={normalizeTaskPriority(subtask.priority)}
                      onChange={(event) =>
                        updateSubtask(subtask.id, {
                          priority: event.target.value as TaskPriority,
                        })
                      }
                      disabled={isLoading}
                    >
                      {TASK_PRIORITIES.map((priorityOption) => (
                        <option key={priorityOption} value={priorityOption}>
                          {priorityOption[0].toUpperCase() + priorityOption.slice(1)}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="form-group">
                  <label>Dependencies</label>
                  <div className="planning-deps-list">
                    {subtasks
                      .slice(0, index)
                      .filter((item) => item.id !== subtask.id)
                      .map((candidate) => {
                        const selected = subtask.dependsOn.includes(candidate.id);
                        return (
                          <label
                            key={candidate.id}
                            className={`planning-dep-chip ${selected ? "selected" : ""}`}
                          >
                            <input
                              type="checkbox"
                              checked={selected}
                              onChange={() => {
                                const nextDeps = selected
                                  ? subtask.dependsOn.filter((dep) => dep !== candidate.id)
                                  : [...subtask.dependsOn, candidate.id];
                                updateSubtask(subtask.id, { dependsOn: nextDeps });
                              }}
                              disabled={isLoading}
                            />
                            <span className="planning-dep-id">{candidate.id}</span>
                            <span className="planning-dep-title">
                              {candidate.title || "Untitled"}
                            </span>
                          </label>
                        );
                      })}
                    {index === 0 && (
                      <div className="text-muted">First subtask cannot have dependencies.</div>
                    )}
                    {index > 0 &&
                      subtasks
                        .slice(0, index)
                        .filter((item) => item.id !== subtask.id).length === 0 && (
                        <div className="text-muted">No previous subtasks available.</div>
                      )}
                  </div>
                </div>
              </div>
            );
          })}

          <button type="button" className="btn" onClick={addSubtask} disabled={isLoading}>
            <Plus size={16} className="icon-mr-6" /> Add subtask
          </button>

          {hasDependencyCycle(subtasks) && (
            <div className="form-error planning-error">
              Dependencies contain a cycle. Remove circular references before creating tasks.
            </div>
          )}
        </div>
      </div>

      <div className="planning-actions planning-summary-actions">
        <button className="btn" onClick={onBack} disabled={isLoading}>
          <ArrowLeft size={16} className="icon-mr-4" />
          Back to Summary
        </button>
        <button
          className="btn btn-primary"
          onClick={onCreateTasks}
          disabled={isLoading || isInvalid}
        >
          {isLoading ? (
            <>
              <Loader2 size={16} className="spin icon-mr-6" />
              Creating...
            </>
          ) : (
            <>Create Tasks</>
          )}
        </button>
      </div>
    </div>
  );
}

// ── PlanningSessionList (sidebar) ──────────────────────────────────────────

interface PlanningSessionListProps {
  sessions: AiSessionSummary[];
  loading: boolean;
  selectedSessionId: string | null;
  pendingDeleteId: string | null;
  showArchived: boolean;
  onToggleShowArchived: () => void;
  onArchive: (id: string) => void;
  onSelectSession: (id: string) => void;
  onNewSession: () => void;
  onRequestDelete: (id: string) => void;
  onConfirmDelete: (id: string) => void;
  onCancelDelete: () => void;
}

function PlanningSessionList({
  sessions,
  loading,
  selectedSessionId,
  pendingDeleteId,
  showArchived,
  onToggleShowArchived,
  onArchive,
  onSelectSession,
  onNewSession,
  onRequestDelete,
  onConfirmDelete,
  onCancelDelete,
}: PlanningSessionListProps) {
  return (
    <aside className="planning-sidebar" aria-label="Planning sessions">
      <div className="planning-sidebar-header">
        <button
          className={`planning-sidebar-new ${selectedSessionId === null ? "active" : ""}`}
          onClick={onNewSession}
          type="button"
        >
          <MessageSquarePlus size={16} />
          <span>New session</span>
        </button>
      </div>

      <div className="planning-sidebar-list">
        {sessions.length === 0 && !loading && (
          <div className="planning-sidebar-empty text-muted">
            No saved sessions yet. Start one on the right to see it here.
          </div>
        )}

        {sessions.map((session) => {
          const isSelected = session.id === selectedSessionId;
          const isPendingDelete = pendingDeleteId === session.id;
          const isArchived = session.archived === true;
          const isTerminal = session.status === "complete" || session.status === "error";
          return (
            <div
              key={session.id}
              className={`planning-sidebar-item ${isSelected ? "selected" : ""} ${isPendingDelete ? "pending-delete" : ""} ${isArchived ? "archived" : ""}`}
            >
              <button
                type="button"
                className="planning-sidebar-item-button"
                onClick={() => onSelectSession(session.id)}
              >
                <PlanningSessionStatusIcon status={session.status} />
                <span className="planning-sidebar-item-body">
                  <span className="planning-sidebar-item-title">
                    {/*
                      Drafts hold a generic placeholder as their persisted
                      title until the user blurs/closes (which fires
                      summarizeTitle) or starts the session. While the title
                      is still the placeholder, surface the inputPayload-
                      derived preview so multiple drafts are distinguishable.
                      Once a real title has been summarized, prefer it —
                      otherwise the blur/close summarize would do model work
                      that the user never sees in the sidebar.
                    */}
                    {session.status === "draft" && (!session.title || session.title === "New planning session")
                      ? (session.preview ?? "New planning session")
                      : session.title || "Untitled session"}
                  </span>
                  <span className="planning-sidebar-item-meta">
                    <PlanningSessionStatusLabel status={session.status} />
                    <span aria-hidden> · </span>
                    <span>{formatRelativeTime(session.updatedAt)}</span>
                  </span>
                </span>
              </button>

              {isPendingDelete ? (
                <div className="planning-sidebar-confirm">
                  <button
                    type="button"
                    className="btn btn-sm btn-danger"
                    onClick={() => onConfirmDelete(session.id)}
                  >
                    Delete
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={onCancelDelete}
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <div className="planning-sidebar-item-actions">
                  {isTerminal && (
                    <button
                      type="button"
                      className="planning-sidebar-item-archive"
                      onClick={(e) => {
                        e.stopPropagation();
                        onArchive(session.id);
                      }}
                      aria-label={isArchived ? "Unarchive session" : "Archive session"}
                      title={isArchived ? "Unarchive session" : "Archive session"}
                    >
                      {isArchived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
                    </button>
                  )}
                  <button
                    type="button"
                    className="planning-sidebar-item-delete"
                    onClick={(e) => {
                      e.stopPropagation();
                      onRequestDelete(session.id);
                    }}
                    aria-label="Delete session"
                    title="Delete session"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="planning-sidebar-footer">
        <a
          href="#"
          className="planning-sidebar-toggle-archived-link"
          onClick={(e) => {
            e.preventDefault();
            onToggleShowArchived();
          }}
          aria-pressed={showArchived}
        >
          {showArchived ? "Hide archived" : "Show archived"}
        </a>
      </div>
    </aside>
  );
}

function PlanningSessionStatusIcon({ status }: { status: AiSessionSummary["status"] }) {
  switch (status) {
    case "generating":
      return <Loader2 size={14} className="spin planning-sidebar-status-icon planning-sidebar-status-generating" />;
    case "awaiting_input":
      return <HelpCircle size={14} className="planning-sidebar-status-icon planning-sidebar-status-awaiting" />;
    case "complete":
      return <CheckCircle size={14} className="planning-sidebar-status-icon planning-sidebar-status-complete" />;
    case "error":
      return <AlertCircle size={14} className="planning-sidebar-status-icon planning-sidebar-status-error" />;
    default:
      return <Clock size={14} className="planning-sidebar-status-icon" />;
  }
}

function PlanningSessionStatusLabel({ status }: { status: AiSessionSummary["status"] }) {
  switch (status) {
    case "generating":
      return <span>Generating</span>;
    case "awaiting_input":
      return <span>Needs input</span>;
    case "complete":
      return <span>Complete</span>;
    case "error":
      return <span>Error</span>;
    default:
      return <span>{status}</span>;
  }
}

function formatRelativeTime(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return "";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 4) return `${weeks}w ago`;
  return new Date(iso).toLocaleDateString();
}
