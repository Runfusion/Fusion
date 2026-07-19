import "./PlanningModeModal.css";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { useState, useCallback, useEffect, useRef, useMemo, type MouseEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Task, PlanningQuestion, PlanningSummary, TaskPriority, ThinkingLevel } from "@fusion/core";
import {
  DEFAULT_TASK_PRIORITY,
  TASK_PRIORITIES,
  THINKING_LEVELS,
  getErrorMessage,
} from "@fusion/core";
import {
  startPlanningStreaming,
  createPlanningDraft,
  respondToPlanning,
  rewindPlanningSession,
  retryPlanningSession,
  createTaskFromPlanning,
  validatePlanningSession,
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
  fetchGlobalSettings,
  type PlanningSession,
  type SubtaskItem,
  type PlanningSubtaskDraft,
  type ModelInfo,
  type ConversationHistoryEntry,
  type AiSessionSummary,
} from "../api";
import { subscribeSse } from "../sse-bus";
import { useModalResizePersist } from "../hooks/useModalResizePersist";
import { useEmbeddedPresentation, type ModalPresentation } from "../hooks/useEmbeddedPresentation";
import {
  savePlanningDescription,
  getPlanningDescription,
  clearPlanningDescription,
} from "../hooks/modalPersistence";
import { getRelativeTimeBucket } from "../utils/relativeTimeAgo";
import { Lightbulb, X, Loader2, CheckCircle, ArrowLeft, ArrowRight, Sparkles, ListTree, GripVertical, ArrowUp, ArrowDown, Plus, Trash2, RefreshCw, ChevronLeft, MessageSquarePlus, AlertCircle, Clock, HelpCircle, StopCircle, Archive, ArchiveRestore, Copy } from "lucide-react";
import { CustomModelDropdown } from "./CustomModelDropdown";
import { ConversationHistory } from "./ConversationHistory";
import { MailboxMessageContent } from "./MailboxMessageContent";
import { OnboardingDisclosure } from "./OnboardingDisclosure";
import { useViewportMode } from "../hooks/useViewportMode";
import { useMobileKeyboard } from "../hooks/useMobileKeyboard";
import { useNavigationHistoryContext } from "../hooks/useNavigationHistory";
import { useMobileScrollLock } from "../hooks/useMobileScrollLock";
import { useAutosizeTextarea } from "../hooks/useAutosizeTextarea";
import { useToast } from "../hooks/useToast";
import { copyTextToClipboard } from "../utils/copyToClipboard";

const WARNING_ICON = "⚠️";

/*
FNXC:Planning 2026-06-23-02:00:
The embedded Planning sidebar is resizable exactly like Missions (MissionManager's MISSION_SIDEBAR_* constants). Default 300px matches Missions' default (calc(--space-lg 16px * 18.75)); min/max/storage mirror Missions so the two views resize identically and persist independently.
*/
const PLANNING_SIDEBAR_DEFAULT_WIDTH = 300;
const PLANNING_SIDEBAR_MIN_WIDTH = 220;
const PLANNING_SIDEBAR_MAX_WIDTH = 560;
const PLANNING_SIDEBAR_STORAGE_KEY = "fusion:planning-sidebar-width";

const MAX_PLANNING_AUTO_RETRIES = 3;

interface PlanningModeModalProps {
  isOpen: boolean;
  onClose: () => void;
  onTaskCreated: (task: Task) => void;
  onTasksCreated: (tasks: Task[]) => void;
  tasks: Task[];
  initialPlan?: string;
  projectId?: string;
  /** Active workflow lane selected when Planning Mode was opened. */
  workflowId?: string | null;
  /** When set, reconnect to a persisted background session instead of starting fresh */
  resumeSessionId?: string;
  /** Already-loaded active planning sessions used to populate the sidebar before its full refresh. */
  initialSessions?: AiSessionSummary[];
  /** Render without the full-screen modal chrome when Planning Mode is mounted as a top-level app view. */
  presentation?: ModalPresentation;
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

function getExamplePlans(t: TFunction<"app">): string[] {
  return [
    t("planning.examplePlan1", "Build a user authentication system with login and signup"),
    t("planning.examplePlan2", "Add dark mode support to the dashboard"),
    t("planning.examplePlan3", "Create an API endpoint for exporting tasks as CSV"),
    t("planning.examplePlan4", "Refactor the task card component for better performance"),
  ];
}

function normalizeTaskPriority(priority?: TaskPriority): TaskPriority {
  if (priority && (TASK_PRIORITIES as readonly string[]).includes(priority)) {
    return priority;
  }
  return DEFAULT_TASK_PRIORITY;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      continue;
    }
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

/*
FNXC:PlanningNormalization 2026-06-25-00:00:
Planning Mode treats AI and persisted session payloads as untrusted runtime data. Missing summary arrays, question options, and subtask dependency arrays normalize before render/action state so #1743 cannot crash React with undefined `.map`.
*/
function normalizePlanningSummary(summary: PlanningSummary): PlanningSummary {
  const raw = summary as PlanningSummary & Record<string, unknown>;
  const title = typeof raw.title === "string" && raw.title.trim().length > 0
    ? raw.title.trim()
    : "Untitled planning task";
  /*
  FNXC:PlanningMode 2026-06-30-12:54:
  Final summary description is an editable draft. Preserve internal and trailing whitespace during render so mobile text entry can insert a space before the next word; only whitespace-only server payloads fall back to the normalized title.
  */
  const rawDescription = typeof raw.description === "string" ? raw.description : "";
  const description = rawDescription.trim().length > 0
    ? rawDescription
    : title;
  return {
    ...summary,
    title,
    description,
    suggestedSize: raw.suggestedSize === "S" || raw.suggestedSize === "M" || raw.suggestedSize === "L" ? raw.suggestedSize : "M",
    priority: normalizeTaskPriority(summary.priority),
    suggestedDependencies: normalizeStringArray(raw.suggestedDependencies),
    keyDeliverables: normalizeStringArray(raw.keyDeliverables),
  };
}

const PLANNING_OTHER_RESPONSE_KEY = "_other";
const PLANNING_OTHER_OPTION_ID = "__other__";

function normalizeQuestionOptions(question: PlanningQuestion): PlanningQuestion {
  if (question.type !== "single_select" && question.type !== "multi_select") {
    return question;
  }
  const options = Array.isArray(question.options)
    ? question.options
        .filter((option): option is { id: string; label: string; description?: string } =>
          Boolean(
            option &&
            typeof option === "object" &&
            typeof option.id === "string" &&
            option.id.trim().length > 0 &&
            typeof option.label === "string" &&
            option.label.trim().length > 0 &&
            (option.description === undefined || typeof option.description === "string"),
          ),
        )
        .map((option) => ({
          ...option,
          id: option.id.trim(),
          label: option.label.trim(),
          ...(option.description ? { description: option.description.trim() } : {}),
        }))
    : [];
  return { ...question, options };
}

function normalizeSubtaskItem(subtask: SubtaskItem): SubtaskItem {
  const raw = subtask as SubtaskItem & Record<string, unknown>;
  return {
    ...subtask,
    title: typeof raw.title === "string" ? raw.title : "",
    description: typeof raw.description === "string" ? raw.description : "",
    suggestedSize: raw.suggestedSize === "S" || raw.suggestedSize === "M" || raw.suggestedSize === "L" ? raw.suggestedSize : "M",
    priority: normalizeTaskPriority(subtask.priority),
    dependsOn: normalizeStringArray(raw.dependsOn),
  };
}

function areStringArraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function parseSessionUpdatedAt(updatedAt: string): number {
  const parsed = Date.parse(updatedAt);
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

export function dedupeSessionsById(sessions: AiSessionSummary[]): AiSessionSummary[] {
  const byId = new Map<string, { session: AiSessionSummary; updatedAtMs: number; firstSeen: number }>();

  sessions.forEach((session, index) => {
    const updatedAtMs = parseSessionUpdatedAt(session.updatedAt);
    const existing = byId.get(session.id);
    if (!existing) {
      byId.set(session.id, { session, updatedAtMs, firstSeen: index });
      return;
    }

    if (updatedAtMs > existing.updatedAtMs) {
      byId.set(session.id, {
        session,
        updatedAtMs,
        firstSeen: existing.firstSeen,
      });
    }
  });

  return [...byId.values()]
    .sort((left, right) => right.updatedAtMs - left.updatedAtMs || left.firstSeen - right.firstSeen)
    .map(({ session }) => session);
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

export function PlanningModeModal({ isOpen, onClose, onTaskCreated, onTasksCreated, tasks, initialPlan: initialPlanProp, projectId, workflowId, resumeSessionId, initialSessions, presentation = "modal" }: PlanningModeModalProps) {
  const { t } = useTranslation("app");
  // FNXC:EmbeddedPresentation 2026-06-22-12:00: shared hook supplies isEmbedded (DOM branching) plus the modal-only gates.
  // Note: the Escape handler intentionally does NOT gate on embedded here — embedded planning preserves its historical
  // Escape-to-close behavior (the back-stack/onClose path), so escapeEnabled is deliberately not wired below.
  const { isEmbedded, scrollLockEnabled, resizePersistEnabled } = useEmbeddedPresentation(presentation);
  const [initialPlan, setInitialPlan] = useState("");
  /*
  FNXC:Planning 2026-07-15-00:00:
  FN-8003 keeps the started prompt separate from the editable composer so users can recover the original idea when an interview errors or drifts off track. The composer may be reset or reused, but this value belongs only to the active session.
  */
  const [activePlanPrompt, setActivePlanPrompt] = useState("");
  const [view, setView] = useState<ViewState>({ type: "initial" });
  const [error, setError] = useState<string | null>(null);
  const [responseHistory, setResponseHistory] = useState<QuestionResponse[]>([]);
  const [conversationHistory, setConversationHistory] = useState<ConversationHistoryEntry[]>([]);
  const [editedSummary, setEditedSummary] = useState<PlanningSummary | null>(null);
  const [branchMode, setBranchMode] = useState<"project-default" | "auto-new" | "existing" | "custom-new">("project-default");
  const [branchName, setBranchName] = useState("");
  const [baseBranch, setBaseBranch] = useState("");
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
  const [isAutoRetrying, setIsAutoRetrying] = useState(false);
  const [autoRetryAttempt, setAutoRetryAttempt] = useState(0);
  const [isCreatingTask, setIsCreatingTask] = useState(false);
  const [isStartingBreakdown, setIsStartingBreakdown] = useState(false);
  const [isCreatingFromBreakdown, setIsCreatingFromBreakdown] = useState(false);
  /*
  FNXC:PlanningMode 2026-07-05-00:00:
  FN-7615: Back is deterministic history navigation (a pure server-side rewind that pops the last
  history entry), not AI generation. isBackPending drives a lightweight inline pending state on the
  Back button itself so the QuestionForm stays mounted throughout — it must never trigger the
  `.planning-loading` generation view (spinner + "Generating next question..."), which is reserved
  for real model-generation turns.
  */
  const [isBackPending, setIsBackPending] = useState(false);
  const [isRefiningSummary, setIsRefiningSummary] = useState(false);
  const [generationStartTime, setGenerationStartTime] = useState<number | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  // Align long-form planning composers with FN-5146's 640px chat convention so
  // multi-paragraph drafts stay visible; SummaryView keeps a larger expanded
  // cap so the two-tier collapsed/expanded editing UX remains intact.
  const { ref: initialPlanAutosizeRef } = useAutosizeTextarea({
    value: initialPlan,
    minHeight: 120,
    maxHeight: 640,
  });
  const setInitialPlanTextareaRef = useCallback((node: HTMLTextAreaElement | null) => {
    textareaRef.current = node;
    initialPlanAutosizeRef(node);
  }, [initialPlanAutosizeRef]);
  /*
  FNXC:Planning 2026-07-14-00:00:
  FN-7959 requires New session to focus the compose textarea even when the blank compose view is already active, so this is a click-driven signal instead of a view/selectedSessionId effect whose dependencies can no-op. The focus runs after requestAnimationFrame because mobile swaps the detail pane from display:none to visible after mobileShowDetail commits.
  */
  const [newSessionFocusSignal, setNewSessionFocusSignal] = useState(0);
  const modalRef = useRef<HTMLDivElement>(null);
  const streamConnectionRef = useRef<{ close: () => void; isConnected: () => boolean } | null>(null);
  const currentSessionIdRef = useRef<string | null>(null);
  const viewRef = useRef<ViewState>({ type: "initial" });
  /*
  FNXC:PlanningRetry 2026-07-15-00:00:
  FN-8332 permits automatic retry only for a generation this mounted Planning
  Mode instance started. A reloaded session may reconnect to observe a server
  turn, but its persisted error must stay manual instead of spending another
  generation.
  */
  const liveGenerationSessionIdRef = useRef<string | null>(null);
  /*
  FNXC:PlanningRetry 2026-07-13-00:00:
  FN-7946 requires stuck or terminal Planning Mode generation errors to auto-retry at most three times before the permanent error view appears. Keep the budget in refs for async SSE/poll/loadSession handlers, mirror the current attempt in state for the visible "Retrying" loading message, and reset the budget when successful progress reaches question or summary.
  */
  const planningAutoRetryAttemptRef = useRef(0);
  const planningAutoRetryInFlightRef = useRef(false);
  const startPlanningAutoRetryRef = useRef<(sessionId: string, errorMessage: string) => Promise<boolean>>(async () => false);
  /*
  FNXC:PlanningMode 2026-07-02-07:56:
  Refine Further is a single-flight completed-summary turn. Guard synchronously with a ref so duplicate click, touch, or keyboard activations cannot submit a second refine request or close the active stream with a generation-in-progress error before React renders the disabled state.
  */
  const refineSummaryInFlightRef = useRef(false);
  const draftSessionIdRef = useRef<string | null>(null);
  /*
  FNXC:PlanningMode 2026-07-01-00:00:
  A single draft session must back the whole "what to build" textarea; typing must not spawn one draft per keystroke.
  draftSessionIdRef is only populated after createPlanningDraft resolves, so it cannot gate concurrent creates while a request is in flight. This synchronous sentinel flips true before the await and gates all subsequent debounce fires, collapsing the create path to exactly one call. Cleared on failure so a later keystroke can retry.
  */
  const draftCreateInFlightRef = useRef(false);
  const draftDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Tracks resumeSessionId values the user has explicitly dismissed (via "New
  // Session"). Without this, the resume effect re-fires on every callback
  // identity change (e.g. typing into the textarea recreates loadSession) and
  // yanks the user back into the previous session's question view.
  const dismissedResumeRef = useRef<string | null>(null);

  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  useEffect(() => {
    if (newSessionFocusSignal === 0 || !isOpen) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) {
        return;
      }
      textarea.focus();
      const valueEnd = textarea.value.length;
      textarea.setSelectionRange(valueEnd, valueEnd);
    });

    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [isOpen, newSessionFocusSignal]);

  const resetPlanningAutoRetryBudget = useCallback(() => {
    planningAutoRetryAttemptRef.current = 0;
    planningAutoRetryInFlightRef.current = false;
    setAutoRetryAttempt(0);
    setIsAutoRetrying(false);
  }, []);
  /*
  FNXC:PlanningMultiTab 2026-07-14-00:00:
  Planning Mode has no cross-tab coordination. The persisted session row is the single source
  of truth: every tab may read and interact, the per-session SSE stream plus the global
  ai_session:updated events (consumed by useBackgroundSessions) keep all tabs current, and the
  server's generation-in-progress guard resolves concurrent writes. The former tab-lock
  (useSessionLock, per-tab lock 409s, Take Control overlay) and BroadcastChannel tab-ownership sync
  (useAiSessionSync broadcasts) were removed from planning.
  */
  const [planningModelProvider, setPlanningModelProvider] = useState<string | undefined>(undefined);
  const [planningModelId, setPlanningModelId] = useState<string | undefined>(undefined);
  const [planningThinkingLevel, setPlanningThinkingLevel] = useState<ThinkingLevel | "">("");
  const [clarificationEnabled, setClarificationEnabled] = useState(true);
  const [clarificationSettingsLoading, setClarificationSettingsLoading] = useState(true);
  const [loadedModels, setLoadedModels] = useState<ModelInfo[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [favoriteProviders, setFavoriteProviders] = useState<string[]>([]);
  const [favoriteModels, setFavoriteModels] = useState<string[]>([]);
  const [resolvedPlanningModel, setResolvedPlanningModel] = useState<{
    provider?: string;
    modelId?: string;
  }>({});

  // Sidebar list state
  const [planningSessions, setPlanningSessions] = useState<AiSessionSummary[]>(() => dedupeSessionsById(initialSessions ?? []));
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
    thinkingLevel?: ThinkingLevel | "";
  } | null>(null);

  useModalResizePersist(modalRef, isOpen && resizePersistEnabled, "fusion:planning-modal-size");
  const viewportMode = useViewportMode();
  const isMobile = viewportMode === "mobile";
  const { addToast } = useToast();
  const { pushNav } = useNavigationHistoryContext();

  /*
  FNXC:Planning 2026-06-23-02:00:
  Resizable Planning sidebar — pointer-drag + arrow-key resize with localStorage persistence, mirroring MissionManager.handleSidebarResizeStart/handleSidebarResizeKeyDown. Width is clamped to PLANNING_SIDEBAR_MIN/MAX and applied as an inline width on the sidebar <aside>. Disabled on mobile where the sidebar stacks full-width.
  */
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    if (typeof window === "undefined") return PLANNING_SIDEBAR_DEFAULT_WIDTH;
    const stored = window.localStorage.getItem(PLANNING_SIDEBAR_STORAGE_KEY);
    const parsed = stored ? Number(stored) : NaN;
    if (!Number.isFinite(parsed)) return PLANNING_SIDEBAR_DEFAULT_WIDTH;
    return Math.max(PLANNING_SIDEBAR_MIN_WIDTH, Math.min(PLANNING_SIDEBAR_MAX_WIDTH, parsed));
  });

  const persistSidebarWidth = useCallback((width: number) => {
    try {
      window.localStorage.setItem(PLANNING_SIDEBAR_STORAGE_KEY, String(width));
    } catch {
      // Ignore storage errors.
    }
  }, []);

  const handleSidebarResizeStart = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (isMobile) return;
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
      const nextWidth = Math.max(
        PLANNING_SIDEBAR_MIN_WIDTH,
        Math.min(PLANNING_SIDEBAR_MAX_WIDTH, startWidth + deltaX),
      );
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
  }, [isMobile, persistSidebarWidth, sidebarWidth]);

  const handleSidebarResizeKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (isMobile) return;
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const step = event.shiftKey ? 50 : 10;
    const delta = event.key === "ArrowLeft" ? -step : step;
    const nextWidth = Math.max(
      PLANNING_SIDEBAR_MIN_WIDTH,
      Math.min(PLANNING_SIDEBAR_MAX_WIDTH, sidebarWidth + delta),
    );
    setSidebarWidth(nextWidth);
    persistSidebarWidth(nextWidth);
  }, [isMobile, persistSidebarWidth, sidebarWidth]);

  const { keyboardOverlap, viewportHeight, viewportOffsetTop, keyboardOpen } =
    useMobileKeyboard({ enabled: viewportMode === "mobile" });
  useMobileScrollLock(viewportMode === "mobile" && isOpen && scrollLockEnabled);

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

    let cancelled = false;
    /*
    FNXC:PlanningMultiTab 2026-07-14-00:00:
    Resolve the session id inside each tick instead of at effect setup. The loading view can
    begin before the session id exists (Start Planning resolves it async), and the removed
    cross-tab lock state used to be the dependency that re-armed this effect afterwards. Reading
    the ref per-tick keeps the poll armed for the whole loading window with no extra state.
    */
    const tick = async () => {
      const sessionId = currentSessionIdRef.current;
      if (!sessionId) return;
      try {
        const session = await fetchAiSession(sessionId);
        if (cancelled || !session) return;
        if (currentSessionIdRef.current !== sessionId) return;
        if (session.status === "awaiting_input" && session.currentQuestion) {
          resetPlanningAutoRetryBudget();
          const question = JSON.parse(session.currentQuestion) as PlanningQuestion;
          setView({
            type: "question",
            session: { sessionId, currentQuestion: question, summary: null },
          });
          setStreamingOutput("");
        } else if (session.status === "complete" && session.result) {
          resetPlanningAutoRetryBudget();
          const summary = normalizePlanningSummary(JSON.parse(session.result) as PlanningSummary);
          setView({
            type: "summary",
            session: { sessionId, currentQuestion: null, summary },
            summary,
          });
          setEditedSummary(summary);
          setStreamingOutput("");
        } else if (session.status === "error") {
          const errorMessage = session.error || t("planning.sessionFailed2", "Session failed");
          const handled = liveGenerationSessionIdRef.current === sessionId
            && await startPlanningAutoRetryRef.current(sessionId, errorMessage);
          if (handled) return;
          if (cancelled || currentSessionIdRef.current !== sessionId) return;
          /*
          FNXC:PlanningRetry 2026-07-13-00:05:
          Mirror the SSE onError terminal-error transition here: when this poll is the one that
          discovers a terminal session error (missed SSE event) and the auto-retry budget is
          already exhausted, startPlanningAutoRetryRef resolves false and previously nothing
          transitioned the view out of "loading" — the modal was stuck spinning on
          "Generating next question..." forever, re-polling every 8s with no visible progress.
          Build the permanent error view exactly like connectToPlanningStream's onError does.
          */
          setIsRetrying(false);
          setIsAutoRetrying(false);
          setIsRefiningSummary(false);
          refineSummaryInFlightRef.current = false;
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
  }, [projectId, resetPlanningAutoRetryBudget, t, view.type]);

  const resetDetailState = useCallback((options?: { preserveInitialPlan?: boolean }) => {
    if (!options?.preserveInitialPlan) {
      setInitialPlan("");
    }
    setActivePlanPrompt("");
    setView({ type: "initial" });
    setError(null);
    setResponseHistory([]);
    setConversationHistory([]);
    setEditedSummary(null);
    setBranchMode("project-default");
    setBranchName("");
    setBaseBranch("");
    setStreamingOutput("");
    setIsReconnecting(false);
    setIsRetrying(false);
    resetPlanningAutoRetryBudget();
    setIsRefiningSummary(false);
    refineSummaryInFlightRef.current = false;
    setPlanningModelProvider(undefined);
    setPlanningModelId(undefined);
    setPlanningThinkingLevel("");
    currentSessionIdRef.current = null;
  }, [resetPlanningAutoRetryBudget]);

  const planningSelectionValue = getModelSelectionValue(planningModelProvider, planningModelId);

  const getModelBadgeLabel = useCallback(
    (provider?: string, modelId?: string) => {
      if (!provider || !modelId) {
        return resolvedPlanningModel.provider && resolvedPlanningModel.modelId
          ? `${resolvedPlanningModel.provider}/${resolvedPlanningModel.modelId}`
          : t("planning.usingDefault", "Using default");
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
      setModelsError(getErrorMessage(err) || t("planning.failedLoadModels", "Failed to load models"));
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
          setStreamingOutput((prev) => {
            const next = prev + data;
            // Keep the ref synchronized inside the event handler so
            // back-to-back thinking/question events in the same flush can
            // still preserve the full reasoning payload.
            streamingOutputRef.current = next;
            return next;
          });
        },
        onQuestion: (question) => {
          if (isStaleEvent()) return;
          const normalizedQuestion = normalizeQuestionOptions(question);
          setIsReconnecting(false);
          setIsRetrying(false);
          resetPlanningAutoRetryBudget();
          setIsRefiningSummary(false);
          refineSummaryInFlightRef.current = false;
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
            session: { sessionId, currentQuestion: normalizedQuestion, summary: null },
          });
          setStreamingOutput("");
        },
        onSummary: (summary) => {
          if (isStaleEvent()) return;
          const normalizedSummary = normalizePlanningSummary(summary);
          setIsReconnecting(false);
          setIsRetrying(false);
          resetPlanningAutoRetryBudget();
          setIsRefiningSummary(false);
          refineSummaryInFlightRef.current = false;
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
            session: { sessionId, currentQuestion: null, summary: normalizedSummary },
            summary: normalizedSummary,
          });
          setEditedSummary(normalizedSummary);
          setStreamingOutput("");
        },
        onError: (message) => {
          const errorMessage = message || t("planning.sessionFailed", "Session failed while contacting the AI.");

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
            /*
            FNXC:PlanningRetry 2026-07-15-00:00:
            FN-8332 limits the stuck-turn retry budget to generations started by
            this mounted UI. A resumed stream may observe a terminal persisted
            error, but it must surface the manual Retry/Dismiss panel instead;
            overlapping live SSE and poll signals still share the single-flight guard.
            */
            if (
              liveGenerationSessionIdRef.current === sessionId
              && await startPlanningAutoRetryRef.current(sessionId, errorMessage)
            ) {
              return;
            }
            setIsRetrying(false);
            setIsAutoRetrying(false);
            setIsRefiningSummary(false);
            refineSummaryInFlightRef.current = false;
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
          })();
        },
        onComplete: () => {
          setIsReconnecting(false);
          setIsRetrying(false);
          resetPlanningAutoRetryBudget();
          setIsRefiningSummary(false);
          refineSummaryInFlightRef.current = false;
          currentSessionIdRef.current = null;
        },
        onConnectionStateChange: (state) => {
          setIsReconnecting(state === "reconnecting");
        },
      });

      streamConnectionRef.current = connection;
    },
    [projectId, resetPlanningAutoRetryBudget, t],
  );

  const startPlanningRetry = useCallback(
    async (retryTarget: { sessionId: string; currentQuestion: PlanningQuestion | null; summary: PlanningSummary | null }, options: { auto: boolean }) => {
      setError(null);
      setIsRetrying(!options.auto);
      setIsAutoRetrying(options.auto);
      setStreamingOutput("");
      setView({ type: "loading" });

      currentSessionIdRef.current = retryTarget.sessionId;
      liveGenerationSessionIdRef.current = retryTarget.sessionId;
      connectToPlanningStream(retryTarget.sessionId);

      try {
        await retryPlanningSession(retryTarget.sessionId, projectId);
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

            if (session.status === "generating") {
              setStreamingOutput(session.thinkingOutput ?? "");
              setView({ type: "loading" });
            } else if (session.status === "awaiting_input") {
              if (!session.currentQuestion) {
                throw new Error("Planning session is awaiting input but has no current question.");
              }
              resetPlanningAutoRetryBudget();
              const question = normalizeQuestionOptions(JSON.parse(session.currentQuestion) as PlanningQuestion);
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
              resetPlanningAutoRetryBudget();
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
                errorMessage: session.error || t("planning.retryFailed", "Retry failed. Please try again."),
              });
              setIsAutoRetrying(false);
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
          errorMessage: getErrorMessage(retryError) || t("planning.retryFailed", "Retry failed. Please try again."),
        });
        setIsReconnecting(false);
        setIsAutoRetrying(false);
      } finally {
        if (!options.auto) {
          setIsRetrying(false);
        }
        planningAutoRetryInFlightRef.current = false;
      }
    },
    [connectToPlanningStream, projectId, resetPlanningAutoRetryBudget, t],
  );

  const startPlanningAutoRetry = useCallback(
    async (sessionId: string, _errorMessage: string) => {
      if (viewRef.current.type === "error") {
        return false;
      }
      if (planningAutoRetryInFlightRef.current) {
        return true;
      }
      if (planningAutoRetryAttemptRef.current >= MAX_PLANNING_AUTO_RETRIES) {
        setIsAutoRetrying(false);
        return false;
      }

      const attempt = planningAutoRetryAttemptRef.current + 1;
      planningAutoRetryAttemptRef.current = attempt;
      planningAutoRetryInFlightRef.current = true;
      setAutoRetryAttempt(attempt);
      setIsAutoRetrying(true);
      await startPlanningRetry(
        { sessionId, currentQuestion: null, summary: null },
        { auto: true },
      );
      return true;
    },
    [startPlanningRetry],
  );

  startPlanningAutoRetryRef.current = startPlanningAutoRetry;

  /*
  FNXC:Planning 2026-07-15-00:00:
  FN-8003 exposes recovery only through the shared clipboard helper so Copy prompt works on secure desktop origins and non-secure LAN/mobile origins alike. Do not replace this with navigator.clipboard directly.
  */
  const handleCopyPlanPrompt = useCallback(async () => {
    if (!activePlanPrompt.trim()) {
      return;
    }

    const copied = await copyTextToClipboard(activePlanPrompt);
    addToast(
      copied
        ? t("planning.copyPromptSuccess", "Prompt copied to clipboard")
        : t("planning.copyPromptFailure", "Failed to copy prompt"),
      copied ? "success" : "error",
    );
  }, [activePlanPrompt, addToast, t]);

  const handleStartPlanning = useCallback(async (planOverride?: string) => {
    if (clarificationSettingsLoading) return;
    const plan = planOverride ?? initialPlan;
    const startedPlan = plan.trim();
    if (!startedPlan) return;

    setActivePlanPrompt(startedPlan);
    setError(null);
    setStreamingOutput("");
    setConversationHistory([]);
    setResponseHistory([]);
    setIsReconnecting(false);
    resetPlanningAutoRetryBudget();
    setIsRefiningSummary(false);
    refineSummaryInFlightRef.current = false;
    setView({ type: "loading" });

    try {
      // Use streaming mode for real-time AI thinking display
      const modelOverride =
        planningModelProvider && planningModelId
          ? { planningModelProvider, planningModelId, thinkingLevel: planningThinkingLevel || undefined }
          : (planningThinkingLevel ? { thinkingLevel: planningThinkingLevel } : undefined);

      const draftSessionId = draftSessionIdRef.current;
      const { sessionId } = await startPlanningStreaming(
        startedPlan,
        projectId,
        modelOverride,
        { clarificationEnabled },
        draftSessionId ?? undefined,
      );
      draftSessionIdRef.current = null;
      currentSessionIdRef.current = sessionId;
      liveGenerationSessionIdRef.current = sessionId;
      setSelectedSessionId(sessionId);

      connectToPlanningStream(sessionId);
      setResponseHistory([]);
    } catch (err) {
      setIsReconnecting(false);
      setError(getErrorMessage(err) || t("planning.failedStartSession", "Failed to start planning session"));
      setView({ type: "initial" });
      currentSessionIdRef.current = null;
    }
  }, [
    clarificationEnabled,
    clarificationSettingsLoading,
    connectToPlanningStream,
    initialPlan,
    planningModelId,
    planningModelProvider,
    planningThinkingLevel,
    projectId,
    resetPlanningAutoRetryBudget,
  ]);

  useEffect(() => {
    if (!isOpen) return;
    let active = true;
    setClarificationSettingsLoading(true);
    void fetchGlobalSettings()
      .then((settings) => { if (active) setClarificationEnabled(settings.agentClarificationEnabled !== false); })
      // A missing settings response keeps the default full interview; disabled only limits follow-ups.
      .catch(() => { if (active) setClarificationEnabled(true); })
      .finally(() => { if (active) setClarificationSettingsLoading(false); });
    return () => { active = false; };
  }, [isOpen]);

  /*
  FNXC:PlanningFocus 2026-06-23-00:00:
  Viewing Planning Mode must not auto-focus the initial composer because mobile browsers open the keyboard before the user chooses to type. Keep the textarea ref for autosize and explicit user focus only; populated initialPlan handoffs still auto-start through the separate effect below.
  */

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    void loadModels();
  }, [isOpen, loadModels]);

  // Auto-start planning when initialPlan prop is provided
  useEffect(() => {
    if (isOpen && initialPlanProp && !clarificationSettingsLoading && !hasAutoStartedRef.current && view.type === "initial") {
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
  }, [isOpen, initialPlanProp, clarificationSettingsLoading, view.type, handleStartPlanning, projectId]);

  // Load a specific persisted session into the right pane.
  const loadSession = useCallback(
    async (sessionId: string) => {
      streamConnectionRef.current?.close();
      streamConnectionRef.current = null;
      // Loading a database row never makes its in-flight turn local to this mount.
      liveGenerationSessionIdRef.current = null;

      setError(null);
      setStreamingOutput("");
      setResponseHistory([]);
      setConversationHistory([]);
      setEditedSummary(null);
      setIsRetrying(false);
      setIsRefiningSummary(false);
      refineSummaryInFlightRef.current = false;
      setView({ type: "loading" });

      try {
        const session = await fetchAiSession(sessionId);
        if (!session) {
          // The session was deleted (commonly: this tab just turned it into
          // tasks via Create Task / Create Tasks). Quietly fall back to the
          // new-session view rather than surfacing a scary error banner.
          setSelectedSessionId(null);
          setMobileShowDetail(false);
          setActivePlanPrompt("");
          setView({ type: "initial" });
          return;
        }

        currentSessionIdRef.current = sessionId;
        let inputPayload: Record<string, unknown> | null = null;
        try {
          const parsedPayload: unknown = session.inputPayload ? JSON.parse(session.inputPayload) : null;
          if (parsedPayload && typeof parsedPayload === "object" && !Array.isArray(parsedPayload)) {
            inputPayload = parsedPayload as Record<string, unknown>;
          }
        } catch {
          // An unavailable payload cannot provide a safe copy target.
        }
        setActivePlanPrompt(typeof inputPayload?.initialPlan === "string" ? inputPayload.initialPlan : "");
        const parsedHistory = parseConversationHistory(session.conversationHistory);
        setConversationHistory(parsedHistory);
        setResponseHistory(
          parsedHistory
            .map((entry) => entry.response)
            .filter((response): response is QuestionResponse =>
              Boolean(response && typeof response === "object" && !Array.isArray(response)),
            ),
        );

        if (session.status === "error") {
          const errorMessage = session.error || t("planning.sessionFailed2", "Session failed");
          /*
          FNXC:PlanningRetry 2026-07-15-00:00:
          FN-8332 requires browser-reload/session-resume to render the durable planning state verbatim and never dispatch a new generation. Auto-retry remains exclusively for live in-session SSE and loading-poll failures; persisted errors must expose the manual Retry/Dismiss panel.
          */
          setView({
            type: "error",
            session: { sessionId, currentQuestion: null, summary: null },
            errorMessage,
          });
          return;
        }

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
          let savedThinkingLevel: ThinkingLevel | "" = "";
          if (typeof inputPayload?.initialPlan === "string") {
            savedPlan = inputPayload.initialPlan;
          }
          if (typeof inputPayload?.modelProvider === "string" && typeof inputPayload.modelId === "string") {
            savedProvider = inputPayload.modelProvider;
            savedModelId = inputPayload.modelId;
          }
          if (inputPayload && THINKING_LEVELS.includes(inputPayload.thinkingLevel as ThinkingLevel)) {
            savedThinkingLevel = inputPayload.thinkingLevel as ThinkingLevel;
          }
          setInitialPlan(savedPlan);
          setPlanningModelProvider(savedProvider);
          setPlanningModelId(savedModelId);
          setPlanningThinkingLevel(savedThinkingLevel);
          draftSessionIdRef.current = sessionId;
          lastSyncedDraftRef.current = savedPlan
            ? {
                sessionId,
                initialPlan: savedPlan.trim(),
                modelProvider: savedProvider,
                modelId: savedModelId,
                thinkingLevel: savedThinkingLevel,
              }
            : null;
          setView({ type: "initial" });
        } else if (session.status === "awaiting_input" && session.currentQuestion) {
          resetPlanningAutoRetryBudget();
          clearPlanningDescription(projectId);
          const question = normalizeQuestionOptions(JSON.parse(session.currentQuestion));
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
          resetPlanningAutoRetryBudget();
          clearPlanningDescription(projectId);
          const summary = normalizePlanningSummary(JSON.parse(session.result));
          setView({ type: "summary", session: { sessionId, currentQuestion: null, summary }, summary });
          setEditedSummary(summary);
        } else if (session.status === "generating") {
          setView({ type: "loading" });
          if (session.thinkingOutput) setStreamingOutput(session.thinkingOutput);
          connectToPlanningStream(sessionId);
        }
      } catch (err) {
        currentSessionIdRef.current = sessionId;
        setActivePlanPrompt("");
        setError(null);
        setView({
          type: "error",
          session: { sessionId, currentQuestion: null, summary: null },
          errorMessage: getErrorMessage(err) || t("planning.failedLoadSession", "Failed to load session"),
        });
      }
    },
    [connectToPlanningStream, projectId, resetPlanningAutoRetryBudget],
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
        type: "planning",
      });
      const planning = all.filter((s) => s.type === "planning");
      setPlanningSessions(dedupeSessionsById(planning));
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
        setPlanningSessions((prev) => dedupeSessionsById([updated, ...prev]));
      } catch {
        // ignore malformed payload
      }
    };

    const handleDeleted = (e: MessageEvent) => {
      try {
        const id = JSON.parse(e.data) as string;
        setPlanningSessions((prev) => dedupeSessionsById(prev.filter((s) => s.id !== id)));
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
    const preserveActiveDraft = selectedSessionId === null && viewRef.current.type === "initial";
    resetDetailState({ preserveInitialPlan: preserveActiveDraft });
    setSelectedSessionId(null);
    setMobileShowDetail(true);
    setNewSessionFocusSignal((signal) => signal + 1);
  }, [resetDetailState, resumeSessionId, selectedSessionId]);

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
        lastSyncedDraftRef.current.modelId === planningModelId &&
        lastSyncedDraftRef.current.thinkingLevel === planningThinkingLevel;
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
            thinkingLevel: planningThinkingLevel || undefined,
          },
          projectId,
        );
        lastSyncedDraftRef.current = {
          sessionId,
          initialPlan: trimmedPlan,
          modelProvider: planningModelProvider,
          modelId: planningModelId,
          thinkingLevel: planningThinkingLevel,
        };
      } catch {
        // best-effort draft sync; avoid blocking typing UX on transient failures
      }
    },
    [planningModelId, planningModelProvider, planningThinkingLevel, projectId],
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
          await cancelPlanning(sessionId, projectId);
        } catch {
          // best-effort
        }
      }

      try {
        await deleteAiSession(sessionId);
      } catch (err) {
        addToast(getErrorMessage(err) || t("planning.failedDeleteSession", "Failed to delete session"), "error");
        void refreshSessionsList();
        setPendingDeleteId(null);
        return;
      }

      // The server-side ai_session:deleted SSE event prunes this session from
      // every tab's useBackgroundSessions state; the local list update below
      // just keeps this modal responsive without waiting for the event.
      setPlanningSessions((prev) => dedupeSessionsById(prev.filter((s) => s.id !== sessionId)));

      if (selectedSessionId === sessionId) {
        streamConnectionRef.current?.close();
        streamConnectionRef.current = null;
        resetDetailState();
        setSelectedSessionId(null);
        setMobileShowDetail(false);
      }
      setPendingDeleteId(null);
    },
    [addToast, planningSessions, projectId, refreshSessionsList, resetDetailState, selectedSessionId],
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
          return dedupeSessionsById(prev.filter((s) => s.id !== sessionId));
        }
        return dedupeSessionsById(prev.map((s) => (s.id === sessionId ? { ...s, archived: !wasArchived } : s)));
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
    }
  }, [isOpen]);

  // Cleanup stream connection on unmount
  useEffect(() => {
    return () => {
      if (draftDebounceRef.current) {
        clearTimeout(draftDebounceRef.current);
        draftDebounceRef.current = null;
      }
      streamConnectionRef.current?.close();
      streamConnectionRef.current = null;
    };
  }, []);

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
    setIsRefiningSummary(false);
    refineSummaryInFlightRef.current = false;
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
        setError(t("planning.noActiveQuestion", "No active question in session"));
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
      resetPlanningAutoRetryBudget();
      setView({ type: "loading" });
      setStreamingOutput(""); // Clear old thinking output when entering loading state
      liveGenerationSessionIdRef.current = sessionId;

      try {
        // Submit response - AI will broadcast events via the already-connected stream
        await respondToPlanning(sessionId, responses, projectId);
        // Events (question/summary) will arrive via the existing SSE stream
      } catch (err) {
        setError(getErrorMessage(err) || t("planning.failedSubmitResponse", "Failed to submit response"));
        setView({ type: "question", session });
      }
    },
    [projectId, resetPlanningAutoRetryBudget, view]
  );

  const handleStopGeneration = useCallback(async () => {
    const sessionId = currentSessionIdRef.current;
    if (!sessionId) {
      return;
    }

    try {
      await stopPlanningGeneration(sessionId, projectId);
    } catch {
      // best-effort; server-side timeout/stop event may have already fired
    }

    streamConnectionRef.current?.close();
    streamConnectionRef.current = null;
    setIsReconnecting(false);
    setIsRetrying(false);
    setIsAutoRetrying(false);
    setIsRefiningSummary(false);
    refineSummaryInFlightRef.current = false;
    setView({
      type: "error",
      session: { sessionId, currentQuestion: null, summary: null },
      errorMessage: t("planning.generationStopped", "Generation stopped by user. You can retry or start a new session."),
    });
    setStreamingOutput("");
  }, [projectId, t]);

  const handleRetryFromError = useCallback(async () => {
    if (view.type !== "error") {
      return;
    }

    resetPlanningAutoRetryBudget();
    await startPlanningRetry(view.session, { auto: false });
  }, [resetPlanningAutoRetryBudget, startPlanningRetry, view]);

  const handleValidatePlan = useCallback(async () => {
    if (view.type !== "question") return;
    setError(null);
    try {
      const result = await validatePlanningSession(view.session.sessionId, projectId);
      const summary = normalizePlanningSummary(result.summary);
      setEditedSummary(summary);
      setView({ type: "summary", session: { ...view.session, summary }, summary });
    } catch (err) {
      setError(getErrorMessage(err) || t("planning.failedValidatePlan", "Failed to validate plan"));
    }
  }, [projectId, t, view]);

  const handleCreateTask = useCallback(async () => {
    if (view.type !== "summary") return;
    if ((branchMode === "existing" || branchMode === "custom-new") && !branchName.trim()) return;

    setError(null);
    setIsCreatingTask(true);

    try {
      const completedSessionId = view.session.sessionId;
      await validatePlanningSession(completedSessionId, projectId);
      const normalizedSummary = editedSummary ? normalizePlanningSummary(editedSummary) : undefined;
      const task = await createTaskFromPlanning(completedSessionId, normalizedSummary, projectId, {
        branchSelection: {
          mode: branchMode,
          ...(branchMode === "existing" || branchMode === "custom-new" ? { branchName: branchName.trim() } : {}),
          ...(baseBranch.trim() ? { baseBranch: baseBranch.trim() } : {}),
        },
        /*
        FNXC:WorkflowSelection 2026-06-20-16:48:
        Planning Mode saves must carry the workflow lane that opened the modal so created tasks do not land on the main board before appearing on the selected sub-board.
        */
        ...(workflowId !== undefined ? { workflowId } : {}),
      });
      onTaskCreated(task);
      // Single-task creation should preserve completed planning history, so
      // only clear the active selection before closing; keep the sidebar row
      // in local state to match persisted server truth.
      setSelectedSessionId(null);
      handleClose();
    } catch (err) {
      setError(getErrorMessage(err) || t("planning.failedCreateTask", "Failed to create task"));
    } finally {
      setIsCreatingTask(false);
    }
  }, [baseBranch, branchMode, branchName, editedSummary, view, projectId, workflowId, onTaskCreated, handleClose]);

  const handleStartBreakdown = useCallback(async () => {
    if (view.type !== "summary") return;

    setError(null);
    setIsStartingBreakdown(true);

    try {
      const normalizedSummary = editedSummary ? normalizePlanningSummary(editedSummary) : undefined;
      await validatePlanningSession(view.session.sessionId, projectId);
      const result = await startPlanningBreakdown(view.session.sessionId, normalizedSummary, projectId);
      const normalizedSubtasks = (Array.isArray(result.subtasks) ? result.subtasks : []).map(normalizeSubtaskItem);
      setView({
        type: "breakdown",
        sessionId: result.sessionId,
        originalSubtasks: normalizedSubtasks.map((subtask) => ({ ...subtask, dependsOn: [...subtask.dependsOn] })),
        subtasks: normalizedSubtasks.map((subtask) => ({ ...subtask, dependsOn: [...subtask.dependsOn] })),
        dirty: false,
      });
    } catch (err) {
      setError(getErrorMessage(err) || t("planning.failedStartBreakdown", "Failed to start breakdown"));
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
      await validatePlanningSession(completedSessionId, projectId);
      const result = await createTasksFromPlanning(
        completedSessionId,
        buildCompactPlanningSubtaskDrafts(
          view.originalSubtasks.map(normalizeSubtaskItem),
          view.subtasks.map(normalizeSubtaskItem),
        ),
        projectId,
        {
          branchSelection: {
            mode: branchMode,
            ...(branchMode === "existing" || branchMode === "custom-new" ? { branchName: branchName.trim() } : {}),
            ...(baseBranch.trim() ? { baseBranch: baseBranch.trim() } : {}),
          },
          /*
          FNXC:WorkflowSelection 2026-06-20-16:48:
          Planning breakdown saves create several tasks, and every child must inherit the modal's workflow lane selection.
          */
          ...(workflowId !== undefined ? { workflowId } : {}),
        },
      );
      onTasksCreated(result.tasks);
      // Server cleans up the planning session after task creation; mirror that
      // locally so reopen doesn't try to load a 404 and the footer count drops.
      setPlanningSessions((prev) => dedupeSessionsById(prev.filter((s) => s.id !== completedSessionId)));
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
      setPlanningThinkingLevel("");
      currentSessionIdRef.current = null;
      setSelectedSessionId(null);
      handleClose();
    } catch (err) {
      setError(getErrorMessage(err) || t("planning.failedCreateTasks", "Failed to create tasks"));
    } finally {
      setIsCreatingFromBreakdown(false);
    }
  }, [baseBranch, branchMode, branchName, handleClose, view, onTasksCreated, projectId, workflowId]);

  /*
  FNXC:PlanningMode 2026-07-05-00:00:
  FN-7615: Back must never render `.planning-loading`. rewindSession (src/planning.ts) is a
  deterministic history pop + `question` SSE broadcast — it performs no model call — so treating it
  like a generation turn (setView({type:"loading"})) was a bug: the user perceives Back as "not
  working" because it flashes a spinner/"Generating next question..." screen for an instant,
  synchronous-feeling navigation. Stay on the question view throughout; use isBackPending only to
  disable the Back/submit controls while the request is in flight. On success, apply the
  authoritative rewound history/question (same mapping as before). On failure, surface
  planning.failedGoBack and remain on the question view — never loading.
  */
  const handleBack = useCallback(async () => {
    if (view.type !== "question" || responseHistory.length === 0) {
      return;
    }

    const sessionId = view.session.sessionId;
    setError(null);
    setIsBackPending(true);

    try {
      const rewound = await rewindPlanningSession(sessionId, projectId);
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
      setError(getErrorMessage(err) || t("planning.failedGoBack", "Failed to go back to the previous question"));
      setView({ type: "question", session: view.session });
    } finally {
      setIsBackPending(false);
    }
  }, [projectId, responseHistory.length, t, view]);

  const getProgress = () => {
    if (view.type === "question") {
      return Math.min(responseHistory.length + 1, 3);
    }
    return 3;
  };

  /*
  FNXC:PlanningMode 2026-06-21-00:00:
  FN-6886 keeps the existing Planning Mode workflow component but lets App mount it as an embedded main-content view. Embedded mode must not draw a full-screen overlay, close on backdrop clicks, lock mobile scrolling, or persist resizable modal dimensions.
  */
  if (!isOpen) return null;

  return (
    <div
      className={isEmbedded ? "planning-view open" : "modal-overlay open"}
      data-testid={isEmbedded ? "planning-view" : undefined}
      onMouseDown={isEmbedded ? undefined : (e: MouseEvent<HTMLDivElement>) => {
        overlayMouseDownOnSelfRef.current = e.target === e.currentTarget;
      }}
      onClick={isEmbedded ? undefined : (e: MouseEvent<HTMLDivElement>) => {
        if (e.target === e.currentTarget && overlayMouseDownOnSelfRef.current) {
          handleClose();
        }
        overlayMouseDownOnSelfRef.current = false;
      }}
      role={isEmbedded ? "region" : "dialog"}
      aria-label={isEmbedded ? t("planning.title", "Planning Mode") : undefined}
      aria-modal={isEmbedded ? undefined : "true"}
    >
      <div className={isEmbedded ? "modal modal-lg planning-modal planning-modal--embedded" : "modal modal-lg planning-modal"} ref={modalRef}>
        {/*
        FNXC:PlanningMode 2026-06-22-00:00:
        Embedded planning is a main-content destination, not a dialog: it drops the modal close button and renders a plain common title (modal-header--embedded) matching other embedded views like Command Center. The mobile back affordance stays because it navigates the session list, not the view.
        */}
        <div className={isEmbedded ? "modal-header modal-header--embedded" : "modal-header"}>
          <div className="detail-title-row">
            {mobileShowDetail && (
              <button
                className="modal-back planning-mobile-back"
                onClick={handleBackToList}
                aria-label={t("planning.backToSessions", "Back to sessions")}
                title={t("planning.backToSessions", "Back to sessions")}
              >
                <ChevronLeft size={18} />
              </button>
            )}
            {/*
            FNXC:Planning 2026-06-23-03:00:
            Header icon mirrors MissionManager's <Target size={20} className="mission-manager__header-icon" />: same size (20) and same var(--todo) tint + flex-shrink:0, applied via the scoped .planning-modal--embedded .modal-header--embedded .detail-title-row > svg rule (it overrides the shared icon-triage brown so the two headers read as siblings).
            */}
            <Lightbulb size={20} className="icon-triage" />
            <h3>{t("planning.title", "Planning Mode")}</h3>
          </div>
          {!isEmbedded && (
            <div className="modal-header-actions">
              <button className="modal-close" onClick={handleClose} aria-label={t("common.close", "Close")}>
                <X size={20} />
              </button>
            </div>
          )}
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
            sidebarWidth={isMobile ? undefined : sidebarWidth}
            onToggleShowArchived={() => setShowArchived((v) => !v)}
            onArchive={(id) => void handleArchiveSession(id)}
            onSelectSession={handleSelectSession}
            onNewSession={handleNewSession}
            onRequestDelete={setPendingDeleteId}
            onConfirmDelete={(id) => void handleDeleteSession(id)}
            onCancelDelete={() => setPendingDeleteId(null)}
          />

          {/*
          FNXC:Planning 2026-06-23-02:00:
          Sidebar resize handle — parity with MissionManager's mission-manager__sidebar-resize-handle. Rendered only on desktop (sidebar stacks on mobile). Pointer-drag and arrow-key resize both clamp + persist width.
          */}
          {!isMobile && (
            <div
              className="planning-sidebar-resize-handle"
              role="separator"
              aria-orientation="vertical"
              aria-valuemin={PLANNING_SIDEBAR_MIN_WIDTH}
              aria-valuemax={PLANNING_SIDEBAR_MAX_WIDTH}
              aria-valuenow={sidebarWidth}
              aria-label={t("planning.resizeSidebar", "Resize planning sidebar")}
              tabIndex={0}
              onPointerDown={handleSidebarResizeStart}
              onKeyDown={handleSidebarResizeKeyDown}
            />
          )}

          <div className="planning-detail">
          {error && <div className="form-error planning-error">{error}</div>}
          {/*
          FNXC:PlanningMode 2026-07-15-00:00:
          Awaiting-input questions are persisted database state, so transient idle SSE reconnects must not imply that the question is being regenerated. Reserve this hint for the active loading view, where live generation genuinely depends on the stream.
          */}
          {isReconnecting && view.type === "loading" && <div className="form-hint text-muted">{t("planning.reconnecting", "Reconnecting…")}</div>}

          {view.type === "initial" && (
            <div className="planning-initial">
              <div className="planning-view-scroll">
                <div className="planning-intro">
                  <Sparkles size={32} className="icon-triage-lg" />
                  <h4>{t("planning.initialHeading", "Transform your idea into a detailed task")}</h4>
                  <p className="text-muted">
                    {t("planning.initialSubheading", "Describe what you want to build in plain language. The AI will ask clarifying questions and help you structure a well-defined task.")}
                  </p>
                </div>

                <div className="form-group">
                  <label htmlFor="initial-plan">{t("planning.whatToBuild", "What do you want to build?")}</label>
                  <textarea
                    ref={setInitialPlanTextareaRef}
                    id="initial-plan"
                    className="planning-textarea"
                    placeholder={t("planning.whatToBuildPlaceholder", "e.g., Build a user authentication system with login, signup, and password reset...")}
                    value={initialPlan}
                    onChange={(e) => {
                      const nextValue = e.target.value;
                      setInitialPlan(nextValue);
                      if (draftSessionIdRef.current || draftCreateInFlightRef.current || nextValue.trim().length === 0) {
                        return;
                      }
                      if (draftDebounceRef.current) {
                        clearTimeout(draftDebounceRef.current);
                      }
                      draftDebounceRef.current = setTimeout(() => {
                        if (draftSessionIdRef.current || draftCreateInFlightRef.current) {
                          return;
                        }
                        const content = nextValue.trim();
                        if (!content) {
                          return;
                        }
                        const modelOverride =
                          planningModelProvider && planningModelId
                            ? { planningModelProvider, planningModelId, thinkingLevel: planningThinkingLevel || undefined }
                            : (planningThinkingLevel ? { thinkingLevel: planningThinkingLevel } : undefined);
                        // FNXC:PlanningMode 2026-07-01-00:00: mark in-flight synchronously so debounce fires during the round-trip don't spawn duplicate drafts.
                        draftCreateInFlightRef.current = true;
                        void createPlanningDraft(content, projectId, modelOverride)
                          .then((response) => {
                            draftSessionIdRef.current = response.sessionId;
                            setPlanningSessions((prev) => {
                              const draft: AiSessionSummary = {
                                id: response.sessionId,
                                type: "planning",
                                status: "draft",
                                title: response.title,
                                preview: content.length > 80 ? `${content.slice(0, 79).trimEnd()}…` : content,
                                projectId: projectId ?? null,
                                updatedAt: new Date().toISOString(),
                                archived: false,
                              };
                              return dedupeSessionsById([draft, ...prev]);
                            });
                            setSelectedSessionId(response.sessionId);
                          })
                          .catch(() => {
                            // best-effort; clear the in-flight sentinel so a
                            // later keystroke can retry creating the draft.
                            draftCreateInFlightRef.current = false;
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
                  <span className="planning-examples-label">{t("planning.tryAnExample", "Try an example:")}</span>
                  <div className="planning-example-chips">
                    {getExamplePlans(t).map((plan, i) => (
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

                <OnboardingDisclosure summary={t("planning.advancedSettings", "Advanced planning settings")} className="planning-advanced-disclosure">
                  <div className="planning-advanced-content">
                    <div className="planning-advanced-section planning-model-select-group">
                    <label htmlFor="planning-modal-model" className="form-label">
                      {t("planning.planningModel", "Planning Model")}
                      {modelsLoading && (
                        <span className="text-muted text-muted-sm">
                          {t("planning.loadingModels", "Loading models…")}
                        </span>
                      )}
                    </label>
                    <p className="planning-advanced-blurb">
                      {t("planning.planningModelBlurb", "Selects which model runs the planning interview and writes the final draft.")}
                    </p>
                    <CustomModelDropdown
                      id="planning-modal-model"
                      label={t("planning.planningModel", "Planning Model")}
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
                      showThinkingLevel
                      thinkingLevel={planningThinkingLevel}
                      onThinkingLevelChange={(level) => setPlanningThinkingLevel(THINKING_LEVELS.includes(level as ThinkingLevel) ? (level as ThinkingLevel) : "")}
                      defaultThinkingLevel="off"
                    />
                    {/* FNXC:Planning 2026-07-12-00:00: Planning Mode now renders the inline thinking selector only after drafts/sessions can persist the selected reasoning effort in inputPayload and restore it on reopen, matching chat semantics without a dangling control. */}
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
                          {t("common.retry", "Retry")}
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

                    <div className="planning-advanced-section">
                      <label className="checkbox-label" htmlFor="planning-clarification-enabled">
                        <input id="planning-clarification-enabled" type="checkbox" checked={clarificationEnabled} disabled={clarificationSettingsLoading} onChange={(event) => setClarificationEnabled(event.target.checked)} />
                        {t("planning.agentClarification", " Allow follow-up clarification questions")}
                      </label>
                    </div>
                  </div>
                </OnboardingDisclosure>
              </div>

              <div className="planning-view-footer">
                <button
                  className="btn btn-primary planning-start-btn"
                  onClick={() => handleStartPlanning()}
                  disabled={!initialPlan.trim() || clarificationSettingsLoading}
                >
                  <Lightbulb size={16} className="icon-mr-8" />
                  {t("planning.startPlanning", "Start Planning")}
                </button>
              </div>
            </div>
          )}

          {view.type === "loading" && (
            <div className="planning-loading">
              <Loader2 size={40} className="spin icon-todo" />
              <p>
                {isAutoRetrying && autoRetryAttempt > 0
                  ? t("planning.autoRetrying", "Retrying… (attempt {{attempt}} of {{max}})", {
                      attempt: autoRetryAttempt,
                      max: MAX_PLANNING_AUTO_RETRIES,
                    })
                  : streamingOutput
                    ? t("planning.aiThinking", "AI is thinking...")
                    : t("planning.generatingQuestion", "Generating next question...")}
              </p>
              {generationStartTime && (
                <div className="planning-elapsed">{t("planning.thinkingElapsed", "Thinking… ({{seconds}}s)", { seconds: elapsedSeconds })}</div>
              )}
              <div className="planning-thinking-container">
                <button
                  className="planning-thinking-toggle"
                  onClick={() => setShowThinking(!showThinking)}
                  type="button"
                >
                  {showThinking ? t("planning.hideThinking", "Hide thinking") : t("planning.showThinking", "Show thinking")}
                </button>
                <div className="planning-loading-actions">
                  <button className="btn planning-stop-btn" type="button" onClick={() => void handleStopGeneration()}>
                    <StopCircle size={14} />
                    <span className="icon-ml-6">{t("planning.stop", "Stop")}</span>
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
                  <div className="ai-error-icon">{WARNING_ICON}</div>
                  <div className="ai-error-message">{view.errorMessage}</div>
                  <div className="ai-error-actions">
                    <button className="btn btn-primary" onClick={() => void handleRetryFromError()} disabled={isRetrying}>
                      {isRetrying ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
                      <span className="icon-ml-6">{isRetrying ? t("planning.retrying", "Retrying...") : t("common.retry", "Retry")}</span>
                    </button>
                    {activePlanPrompt.trim() && (
                      <button
                        className="btn"
                        type="button"
                        onClick={() => void handleCopyPlanPrompt()}
                        aria-label={t("planning.copyPromptLabel", "Copy original prompt to clipboard")}
                        title={t("planning.copyPromptLabel", "Copy original prompt to clipboard")}
                      >
                        <Copy size={14} />
                        <span className="icon-ml-6">{t("planning.copyPrompt", "Copy prompt")}</span>
                      </button>
                    )}
                    <button className="btn" onClick={handleClose} disabled={isRetrying}>{t("planning.dismiss", "Dismiss")}</button>
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
                isBackPending={isBackPending}
                onCopyPlanPrompt={activePlanPrompt.trim() ? handleCopyPlanPrompt : undefined}
              />
              <button type="button" className="btn" onClick={() => { void handleValidatePlan(); }}>
                {t("planning.validatePlan", "Validate plan")}
              </button>
            </div>
          )}

          {view.type === "summary" && editedSummary && (
            <SummaryView
              summary={editedSummary}
              historyEntries={conversationHistory}
              onSummaryChange={setEditedSummary}
              tasks={tasks}
              branchMode={branchMode}
              branchName={branchName}
              baseBranch={baseBranch}
              onBranchModeChange={setBranchMode}
              onBranchNameChange={setBranchName}
              onBaseBranchChange={setBaseBranch}
              onCreateTask={handleCreateTask}
              onBreakIntoTasks={handleStartBreakdown}
              isCreatingTask={isCreatingTask}
              isStartingBreakdown={isStartingBreakdown}
              isRefiningSummary={isRefiningSummary}
            />
          )}

          {view.type === "breakdown" && (
            <BreakdownView
              subtasks={view.subtasks}
              isLoading={isCreatingFromBreakdown}
              onUpdateSubtasks={(newSubtasks) =>
                setView({ ...view, subtasks: newSubtasks.map(normalizeSubtaskItem), dirty: true })
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

        </div>
      </div>
    </div>
  );
}

/*
FNXC:Planning 2026-07-15-00:00:
FN-8003 places Copy prompt inside QuestionForm's progress header because the recovery control is part of the active interview panel, keeping it visible with the question on desktop and mobile rather than separating related interview actions at the modal level.
*/
interface QuestionFormProps {
  question: PlanningQuestion;
  progress: number;
  historyEntries: ConversationHistoryEntry[];
  onSubmit: (responses: QuestionResponse) => void;
  onBack?: () => void;
  isBackPending?: boolean;
  onCopyPlanPrompt?: () => void | Promise<void>;
}

function QuestionForm({ question: rawQuestion, progress, historyEntries, onSubmit, onBack, isBackPending = false, onCopyPlanPrompt }: QuestionFormProps) {
  const { t } = useTranslation("app");
  const question = normalizeQuestionOptions(rawQuestion);
  const questionOptions = question.options ?? [];
  const [response, setResponse] = useState<QuestionResponse>({});
  const [textValue, setTextValue] = useState("");
  const [commentValue, setCommentValue] = useState("");
  const [otherValue, setOtherValue] = useState("");
  const [isOtherSelected, setIsOtherSelected] = useState(false);
  const { ref: textAnswerAutosizeRef } = useAutosizeTextarea({
    value: textValue,
    minHeight: 120,
    maxHeight: 640,
    deps: [question.id],
  });
  const { ref: commentAutosizeRef } = useAutosizeTextarea({
    value: commentValue,
    minHeight: 80,
    maxHeight: 640,
    deps: [question.id],
  });
  const { ref: otherAutosizeRef } = useAutosizeTextarea({
    value: otherValue,
    minHeight: 80,
    maxHeight: 640,
    deps: [question.id],
  });

  const handleSubmit = useCallback(() => {
    let nextResponse: QuestionResponse;

    if (question.type === "text") {
      nextResponse = { [question.id]: textValue };
    } else if (question.type === "confirm") {
      const trimmedOther = otherValue.trim();
      /*
      FNXC:PlanningInterview 2026-07-01-00:00:
      GitHub #1832 requires Yes/No Planning Mode questions to offer an Other path so users can replace a forced boolean with their own answer. Reuse the reserved `_other` payload shape used by structured selection questions instead of inventing a confirm-only custom-answer contract.
      */
      nextResponse = isOtherSelected && trimmedOther.length > 0
        ? { [PLANNING_OTHER_RESPONSE_KEY]: trimmedOther }
        : { [question.id]: response[question.id] === true };
    } else if (question.type === "single_select") {
      const trimmedOther = otherValue.trim();
      /*
      FNXC:PlanningInterview 2026-06-26-00:00:
      GitHub #1794 requires dashboard planning interviews to let users reject every AI-provided single-select option and submit their own framing instead. Store that answer under the reserved `_other` key so agent prompts and history can distinguish it from an option id.
      */
      nextResponse = isOtherSelected && trimmedOther.length > 0
        ? { [PLANNING_OTHER_RESPONSE_KEY]: trimmedOther }
        : response;
    } else if (question.type === "multi_select") {
      const trimmedOther = otherValue.trim();
      /*
      FNXC:PlanningInterview 2026-06-26-00:00:
      Multi-select planning questions can combine provided choices with a user-authored Other answer. Preserve selected option ids and append `_other` only while the Other checkbox is active and non-empty.

      FNXC:PlanningMode 2026-07-02-00:00:
      The mandatory deepening checkpoint reuses multi-select payloads, with the server-reserved proceed option acting as an explicit final-summary gate. Other/custom topics stay additive only for deepening choices, never hidden final-summary actions.
      */
      nextResponse = isOtherSelected && trimmedOther.length > 0
        ? { ...response, [PLANNING_OTHER_RESPONSE_KEY]: trimmedOther }
        : response;
    } else {
      nextResponse = response;
    }

    const trimmedComment = commentValue.trim();
    if (trimmedComment.length > 0) {
      nextResponse = { ...nextResponse, _comment: trimmedComment };
    }

    onSubmit(nextResponse);
  }, [commentValue, isOtherSelected, otherValue, question, response, textValue, onSubmit]);

  // Reset state when question changes
  useEffect(() => {
    setResponse({});
    setTextValue("");
    setCommentValue("");
    setOtherValue("");
    setIsOtherSelected(false);
  }, [question.id]);

  const isValid = () => {
    switch (question.type) {
      case "text":
        return textValue.trim().length > 0;
      case "single_select":
        /*
        FNXC:PlanningInterview 2026-06-26-00:00:
        The Other radio is a first-class valid answer only when it has non-whitespace text; the Continue button must not force an unwanted provided option.
        */
        return response[question.id] !== undefined || (isOtherSelected && otherValue.trim().length > 0);
      case "multi_select":
        /*
        FNXC:PlanningInterview 2026-06-26-00:00:
        The Other checkbox may be the only multi-select answer, but empty Other text is incomplete so users do not submit a blank custom answer.
        */
        return (Array.isArray(response[question.id] as unknown) && (response[question.id] as unknown[]).length > 0) || (isOtherSelected && otherValue.trim().length > 0);
      case "confirm":
        return response[question.id] !== undefined || (isOtherSelected && otherValue.trim().length > 0);
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
            <div className="planning-progress-header">
              <div className="planning-progress-bar">
                {[1, 2, 3].map((step) => (
                  <div
                    key={step}
                    className={`planning-progress-step ${step <= progress ? "active" : ""}`}
                  />
                ))}
              </div>
              {onCopyPlanPrompt && (
                <button
                  className="btn btn-sm planning-copy-prompt-btn"
                  type="button"
                  onClick={() => void onCopyPlanPrompt()}
                  aria-label={t("planning.copyPromptLabel", "Copy original prompt to clipboard")}
                  title={t("planning.copyPromptLabel", "Copy original prompt to clipboard")}
                >
                  <Copy size={14} />
                  <span className="icon-ml-6">{t("planning.copyPrompt", "Copy prompt")}</span>
                </button>
              )}
            </div>
            <span className="planning-progress-text">{t("planning.questionProgress", "Question {{progress}} of ~3", { progress })}</span>
          </div>

          <div className="planning-question-content">
            {/*
            FNXC:PlanningInterview 2026-07-16-00:00:
            GitHub #2152 requires AI-authored interview questions and descriptions to use the
            sanitized GFM renderer, so bold text, hard line breaks, and lists remain readable
            without trusting generated HTML.
            */}
            <MailboxMessageContent
              className="planning-question-text markdown-body"
              content={question.question}
              testId="planning-question-text"
            />
            {question.description && (
              <MailboxMessageContent
                className="planning-question-desc markdown-body"
                content={question.description}
              />
            )}

            <div className="planning-options">
              {question.type === "text" && (
                <textarea
                  ref={textAnswerAutosizeRef}
                  className="planning-textarea"
                  placeholder={t("planning.typeAnswerPlaceholder", "Type your answer here...")}
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

              {question.type === "single_select" && (
                <div className="planning-radio-group" role="radiogroup">
                  {questionOptions.map((option) => (
                    <label key={option.id} className="planning-option planning-option--radio">
                      <input
                        type="radio"
                        name={question.id}
                        value={option.id}
                        checked={response[question.id] === option.id && !isOtherSelected}
                        onChange={() => {
                          setIsOtherSelected(false);
                          setOtherValue("");
                          setResponse({ [question.id]: option.id });
                        }}
                      />
                      <div className="planning-option-content">
                        <span className="planning-option-label">{option.label}</span>
                        {option.description && (
                          <span className="planning-option-desc">{option.description}</span>
                        )}
                      </div>
                    </label>
                  ))}
                  {/* FNXC:PlanningInterview 2026-06-26-00:00: The synthetic Other radio must appear beside provided options so planning users can decline all suggested answers without leaving the structured question flow. */}
                  <label className="planning-option planning-option--radio" data-testid="planning-option-other">
                    <input
                      type="radio"
                      name={question.id}
                      value={PLANNING_OTHER_OPTION_ID}
                      checked={isOtherSelected}
                      onChange={() => {
                        setIsOtherSelected(true);
                        setResponse({});
                      }}
                    />
                    <div className="planning-option-content">
                      <span className="planning-option-label">{t("planning.otherOptionLabel", "Other (write your own)")}</span>
                    </div>
                  </label>
                  {isOtherSelected && (
                    <div className="planning-other-answer">
                      <textarea
                        ref={otherAutosizeRef}
                        className="planning-textarea"
                        data-testid="planning-other-input"
                        placeholder={t("planning.otherOptionPlaceholder", "Write your own answer...")}
                        value={otherValue}
                        onChange={(e) => setOtherValue(e.target.value)}
                      />
                    </div>
                  )}
                </div>
              )}

              {question.type === "multi_select" && (
                <div className="planning-checkbox-group">
                  {questionOptions.map((option) => {
                    const selected = Array.isArray(response[question.id]) ? (response[question.id] as string[]) : [];
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
                  {/* FNXC:PlanningInterview 2026-06-26-00:00: The synthetic Other checkbox is additive for multi-select so users can mix provided answers with their own answer or use only their own answer. */}
                  <label className="planning-option planning-option--checkbox" data-testid="planning-option-other">
                    <input
                      type="checkbox"
                      value={PLANNING_OTHER_OPTION_ID}
                      checked={isOtherSelected}
                      onChange={(e) => {
                        setIsOtherSelected(e.target.checked);
                        if (!e.target.checked) {
                          setOtherValue("");
                        }
                      }}
                    />
                    <div className="planning-option-content">
                      <span className="planning-option-label">{t("planning.otherOptionLabel", "Other (write your own)")}</span>
                    </div>
                  </label>
                  {isOtherSelected && (
                    <div className="planning-other-answer">
                      <textarea
                        ref={otherAutosizeRef}
                        className="planning-textarea"
                        data-testid="planning-other-input"
                        placeholder={t("planning.otherOptionPlaceholder", "Write your own answer...")}
                        value={otherValue}
                        onChange={(e) => setOtherValue(e.target.value)}
                      />
                    </div>
                  )}
                </div>
              )}

              {question.type === "confirm" && (
                <div className="planning-confirm-answer">
                  <div className="planning-confirm-group">
                    <button
                      className={`planning-confirm-btn ${response[question.id] === true && !isOtherSelected ? "selected" : ""}`}
                      onClick={() => {
                        setIsOtherSelected(false);
                        setOtherValue("");
                        setResponse({ [question.id]: true });
                      }}
                    >
                      <CheckCircle size={18} />
                      {t("common.yes", "Yes")}
                    </button>
                    <button
                      className={`planning-confirm-btn ${response[question.id] === false && !isOtherSelected ? "selected" : ""}`}
                      onClick={() => {
                        setIsOtherSelected(false);
                        setOtherValue("");
                        setResponse({ [question.id]: false });
                      }}
                    >
                      <X size={18} />
                      {t("common.no", "No")}
                    </button>
                    <button
                      className={`planning-confirm-btn ${isOtherSelected ? "selected" : ""}`}
                      data-testid="planning-option-other"
                      onClick={() => {
                        setIsOtherSelected(true);
                        setResponse({});
                      }}
                    >
                      <HelpCircle size={18} />
                      {t("planning.otherOptionLabel", "Other (write your own)")}
                    </button>
                  </div>
                  {isOtherSelected && (
                    <div className="planning-other-answer">
                      <textarea
                        ref={otherAutosizeRef}
                        className="planning-textarea"
                        data-testid="planning-other-input"
                        placeholder={t("planning.otherOptionPlaceholder", "Write your own answer...")}
                        value={otherValue}
                        onChange={(e) => setOtherValue(e.target.value)}
                      />
                    </div>
                  )}
                </div>
              )}
            </div>

            {question.type !== "text" && (
              <div className="planning-comment-section">
                <label className="planning-comment-label" htmlFor={`planning-comment-${question.id}`}>
                  {t("planning.additionalComments", "Additional comments (optional)")}
                </label>
                <textarea
                  ref={commentAutosizeRef}
                  id={`planning-comment-${question.id}`}
                  className="planning-textarea"
                  placeholder={t("planning.additionalCommentsPlaceholder", "Add any extra context or direction...")}
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
          <button className="btn" onClick={onBack} disabled={isBackPending}>
            {isBackPending ? <Loader2 size={16} className="icon-mr-4 spin" /> : <ArrowLeft size={16} className="icon-mr-4" />}
            {t("common.back", "Back")}
          </button>
        )}
        <button
          className="btn btn-primary planning-actions-primary"
          onClick={handleSubmit}
          disabled={!isValid() || isBackPending}
        >
          {t("planning.continue", "Continue")}
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
  branchMode: "project-default" | "auto-new" | "existing" | "custom-new";
  branchName: string;
  baseBranch: string;
  onBranchModeChange: (mode: "project-default" | "auto-new" | "existing" | "custom-new") => void;
  onBranchNameChange: (name: string) => void;
  onBaseBranchChange: (branch: string) => void;
  onCreateTask: () => void;
  onBreakIntoTasks: () => void;
  onRefine?: () => void;
  isCreatingTask: boolean;
  isStartingBreakdown: boolean;
  isRefiningSummary: boolean;
}

function SummaryView({
  summary: rawSummary,
  historyEntries,
  onSummaryChange,
  tasks,
  branchMode,
  branchName,
  baseBranch,
  onBranchModeChange,
  onBranchNameChange,
  onBaseBranchChange,
  onCreateTask,
  onBreakIntoTasks,
  onRefine,
  isCreatingTask,
  isStartingBreakdown,
  isRefiningSummary,
}: SummaryViewProps) {
  const { t } = useTranslation("app");
  const summary = normalizePlanningSummary(rawSummary);
  const [isExpanded, setIsExpanded] = useState(false);
  /*
  FNXC:PlanningSummaryDescription 2026-07-15-12:00:
  Planning summaries must show formatted Markdown on first display. The existing toggle switches to raw Plain text for editing and back to the preview.
  */
  const [renderMarkdown, setRenderMarkdown] = useState(true);
  const [selectedDependencies, setSelectedDependencies] = useState<string[]>(
    summary.suggestedDependencies
  );
  const { ref: descriptionAutosizeRef } = useAutosizeTextarea({
    value: summary.description,
    minHeight: isExpanded ? 200 : 120,
    maxHeight: isExpanded ? 800 : 640,
    deps: [isExpanded],
  });
  const selectedPriority = normalizeTaskPriority(summary.priority);
  const isBranchNameRequired = branchMode === "existing" || branchMode === "custom-new";
  const hasInvalidBranchSelection = isBranchNameRequired && !branchName.trim();
  const isLoading = isCreatingTask || isStartingBreakdown || isRefiningSummary;

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
          <OnboardingDisclosure summary={t("planning.showQA", "Show user Q&A")} className="planning-summary-qa-disclosure">
            <ConversationHistory entries={historyEntries} />
            <div className="conversation-separator" />
          </OnboardingDisclosure>
        )}

        <div className="planning-summary-header">
          <CheckCircle size={24} className="icon-success" />
          <h4>{t("planning.planningComplete", "Planning Complete!")}</h4>
          <p className="text-muted">{t("planning.planningCompleteSubheading", "Review and refine your task before creating it.")}</p>
        </div>

        <div className="planning-summary-form">
          <div className="form-group">
            {/*
            FNXC:PlanningSummaryMobile 2026-06-30-12:00:
            Keep Description controls adjacent but outside the label. Mobile browsers can retarget taps from interactive descendants inside labels, which made the Expand/Collapse control appear inert while the textarea/preview state already supported expansion.
            */}
            <div className="planning-summary-description-header">
              <label id="planning-summary-description-label" htmlFor="planning-summary-description">
                {t("planning.description", "Description")}
              </label>
              <div className="planning-summary-description-actions">
                <button
                  type="button"
                  className="planning-expand-btn"
                  aria-pressed={renderMarkdown}
                  aria-label={renderMarkdown ? t("planning.showRawText", "Show raw text") : t("planning.showFormattedMarkdown", "Show formatted markdown")}
                  title={renderMarkdown ? t("planning.showRawText", "Show raw text") : t("planning.showFormattedMarkdown", "Show formatted markdown")}
                  data-testid="planning-description-markdown-toggle"
                  onClick={() => setRenderMarkdown(!renderMarkdown)}
                >
                  {renderMarkdown ? t("planning.plain", "Plain") : t("planning.markdown", "Markdown")}
                </button>
                <button
                  type="button"
                  className="planning-expand-btn"
                  aria-pressed={isExpanded}
                  aria-label={isExpanded ? t("planning.collapseDescription", "Collapse description") : t("planning.expandDescription", "Expand description")}
                  onClick={() => setIsExpanded(!isExpanded)}
                >
                  {isExpanded ? t("planning.collapse", "Collapse") : t("planning.expand", "Expand")}
                </button>
              </div>
            </div>
            {renderMarkdown ? (
              <div
                className={`planning-description-preview markdown-body ${isExpanded ? "expanded" : ""}`}
                aria-labelledby="planning-summary-description-label"
              >
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{summary.description}</ReactMarkdown>
              </div>
            ) : (
              <textarea
                id="planning-summary-description"
                ref={descriptionAutosizeRef}
                className={`planning-textarea ${isExpanded ? "expanded" : ""}`}
                value={summary.description}
                onChange={(e) => onSummaryChange({ ...summary, description: e.target.value })}
              />
            )}
          </div>

          <div className="task-detail-section">
            <div className="form-group">
              <label htmlFor="planning-branch-strategy">{t("planning.branchStrategy", "Branch strategy")}</label>
              <select
                id="planning-branch-strategy"
                value={branchMode}
                onChange={(event) => onBranchModeChange(event.target.value as "project-default" | "auto-new" | "existing" | "custom-new")}
                disabled={isLoading}
              >
                <option value="project-default">{t("planning.branchProjectDefault", "Use project/default branch")}</option>
                <option value="auto-new">{t("planning.branchAutoNew", "Create auto-named branch per task")}</option>
                <option value="existing">{t("planning.branchExisting", "Use existing branch")}</option>
                <option value="custom-new">{t("planning.branchCustomNew", "Create custom new branch")}</option>
              </select>
            </div>
            {isBranchNameRequired && (
              <div className="form-group">
                <label htmlFor="planning-branch-name">{t("planning.branchName", "Branch name")}</label>
                <input
                  id="planning-branch-name"
                  value={branchName}
                  onChange={(event) => onBranchNameChange(event.target.value)}
                  disabled={isLoading}
                />
              </div>
            )}
            <div className="form-group">
              <label htmlFor="planning-base-branch">{t("planning.baseBranch", "Merge target / base branch (optional)")}</label>
              <input
                id="planning-base-branch"
                value={baseBranch}
                onChange={(event) => onBaseBranchChange(event.target.value)}
                disabled={isLoading}
                placeholder={t("planning.baseBranchPlaceholder", "main")}
              />
            </div>
            {hasInvalidBranchSelection && (
              <div className="form-error planning-error">{t("planning.branchNameRequired", "Branch name is required for this branch strategy.")}</div>
            )}
          </div>

          <div className="planning-summary-meta-row">
            <div className="form-group">
              <label htmlFor="planning-summary-size">{t("planning.suggestedSize", "Suggested Size")}</label>
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
                <option value="S">{t("planning.sizeSmall", "S (Small)")}</option>
                <option value="M">{t("planning.sizeMedium", "M (Medium)")}</option>
                <option value="L">{t("planning.sizeLarge", "L (Large)")}</option>
              </select>
            </div>

            <div className="form-group">
              <label htmlFor="planning-summary-priority">{t("planning.priority", "Priority")}</label>
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
              <label>{t("planning.suggestedDependencies", "Suggested Dependencies")}</label>
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
            <label>{t("planning.keyDeliverables", "Key Deliverables")}</label>
            <ul className="planning-deliverables">
              {summary.keyDeliverables.length > 0 ? (
                summary.keyDeliverables.map((item, i) => (
                  <li key={i}>{item}</li>
                ))
              ) : (
                <li className="text-muted">{t("planning.noKeyDeliverables", "No key deliverables were provided.")}</li>
              )}
            </ul>
          </div>
        </div>
      </div>

      <div className="planning-actions planning-summary-actions">
        {onRefine && (
          <button className="btn" onClick={onRefine} disabled={isLoading}>
            <ArrowLeft size={16} className="icon-mr-4" />
            {t("planning.refineFurther", "Refine Further")}
          </button>
        )}
        <div className="planning-summary-actions-right">
          <button className="btn" onClick={onCreateTask} disabled={isLoading || hasInvalidBranchSelection}>
            {isCreatingTask ? (
              <>
                <Loader2 size={16} className="spin icon-mr-8" />
                {t("planning.creating", "Creating...")}
              </>
            ) : (
              <>
                <CheckCircle size={16} className="icon-mr-8" />
                {t("planning.createSingleTask", "Create Single Task")}
              </>
            )}
          </button>
          <button
            className="btn btn-primary"
            onClick={onBreakIntoTasks}
            disabled={isLoading}
            title={t("planning.breakIntoTasksTitle", "Break the plan into multiple tasks with dependencies")}
          >
            {isStartingBreakdown ? (
              <>
                <Loader2 size={16} className="spin icon-mr-8" />
                {t("planning.breakingDown", "Breaking down...")}
              </>
            ) : (
              <>
                <ListTree size={16} className="icon-mr-8" />
                {t("planning.breakIntoTasks", "Break into Tasks")}
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
  const { t } = useTranslation("app");
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
          <h4>{t("planning.breakIntoTasks", "Break into Tasks")}</h4>
          <p className="text-muted">
            {t("planning.breakdownSubheading", "Review and edit the subtasks generated from your plan. Adjust titles, descriptions, sizes, priorities, and dependencies before creating.")}
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
                  <div className="subtask-drag-handle" title={t("planning.dragToReorder", "Drag to reorder")}>
                    <GripVertical size={16} />
                    <strong>{subtask.id}</strong>
                  </div>
                  <div className="subtask-item-actions">
                    <button
                      type="button"
                      className="btn btn-icon btn-sm"
                      onClick={() => moveSubtask(index, index - 1)}
                      disabled={isLoading || index === 0}
                      title={t("planning.moveUp", "Move up")}
                      aria-label={t("planning.moveSubtaskUp", "Move subtask up")}
                    >
                      <ArrowUp size={14} />
                    </button>
                    <button
                      type="button"
                      className="btn btn-icon btn-sm"
                      onClick={() => moveSubtask(index, index + 1)}
                      disabled={isLoading || index === subtasks.length - 1}
                      title={t("planning.moveDown", "Move down")}
                      aria-label={t("planning.moveSubtaskDown", "Move subtask down")}
                    >
                      <ArrowDown size={14} />
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => removeSubtask(subtask.id)}
                      disabled={isLoading}
                    >
                      <Trash2 size={14} /> {t("planning.remove", "Remove")}
                    </button>
                  </div>
                </div>

                <div className="form-group">
                  <label>{t("planning.subtaskTitle", "Title")}</label>
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
                  <label>{t("planning.subtaskDescription", "Description")}</label>
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
                    <label htmlFor={`${subtask.id}-size`}>{t("planning.subtaskSize", "Size")}</label>
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
                    <label htmlFor={`${subtask.id}-priority`}>{t("planning.subtaskPriority", "Priority")}</label>
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
                  <label>{t("planning.dependencies", "Dependencies")}</label>
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
                              {candidate.title || t("planning.untitled", "Untitled")}
                            </span>
                          </label>
                        );
                      })}
                    {index === 0 && (
                      <div className="text-muted">{t("planning.firstSubtaskNoDeps", "First subtask cannot have dependencies.")}</div>
                    )}
                    {index > 0 &&
                      subtasks
                        .slice(0, index)
                        .filter((item) => item.id !== subtask.id).length === 0 && (
                        <div className="text-muted">{t("planning.noPreviousSubtasks", "No previous subtasks available.")}</div>
                      )}
                  </div>
                </div>
              </div>
            );
          })}

          <button type="button" className="btn" onClick={addSubtask} disabled={isLoading}>
            <Plus size={16} className="icon-mr-6" /> {t("planning.addSubtask", "Add subtask")}
          </button>

          {hasDependencyCycle(subtasks) && (
            <div className="form-error planning-error">
              {t("planning.dependencyCycle", "Dependencies contain a cycle. Remove circular references before creating tasks.")}
            </div>
          )}
        </div>
      </div>

      <div className="planning-actions planning-summary-actions">
        <button className="btn" onClick={onBack} disabled={isLoading}>
          <ArrowLeft size={16} className="icon-mr-4" />
          {t("planning.backToSummary", "Back to Summary")}
        </button>
        <button
          className="btn btn-primary"
          onClick={onCreateTasks}
          disabled={isLoading || isInvalid}
        >
          {isLoading ? (
            <>
              <Loader2 size={16} className="spin icon-mr-6" />
              {t("planning.creating", "Creating...")}
            </>
          ) : (
            <>{t("planning.createTasks", "Create Tasks")}</>
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
  /** Resizable sidebar width (px) on desktop; undefined on mobile where it stacks full-width. */
  sidebarWidth?: number;
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
  sidebarWidth,
  onToggleShowArchived,
  onArchive,
  onSelectSession,
  onNewSession,
  onRequestDelete,
  onConfirmDelete,
  onCancelDelete,
}: PlanningSessionListProps) {
  const { t } = useTranslation("app");
  return (
    <aside
      className="planning-sidebar"
      aria-label={t("planning.planningSessions", "Planning sessions")}
      style={sidebarWidth === undefined ? undefined : { width: `${sidebarWidth}px` }}
    >
      {/*
      FNXC:Planning 2026-06-23-01:15:
      The embedded Planning view reads as a real two-pane layout matching Missions: the left sidebar is a full-height flex column whose session list scrolls and whose primary action ("New session") is pinned to a bottom footer (parity with MissionManager's mission-manager__sidebar-footer + sidebar-cta). The header that previously held the New session button is removed so the list owns the top of the sidebar like the Missions list.
      */}
      <div className="planning-sidebar-list">
        {/*
        FNXC:PlanningMode 2026-07-15-00:00:
        FN-7994 requires the sidebar to never become an empty pane during its
        authoritative session refresh. Skeleton rows provide immediate loading
        feedback, while existing rows remain visible during refreshes.
        */}
        {loading && sessions.length === 0 && (
          <div className="planning-sidebar-skeleton" data-testid="planning-sidebar-skeleton" aria-label={t("planning.loadingSessions", "Loading planning sessions")}>
            {Array.from({ length: 4 }, (_, index) => (
              <div key={index} className="planning-sidebar-skeleton-row" aria-hidden="true">
                <span className="planning-sidebar-skeleton-icon" />
                <span className="planning-sidebar-skeleton-copy">
                  <span className="planning-sidebar-skeleton-title" />
                  <span className="planning-sidebar-skeleton-meta" />
                </span>
              </div>
            ))}
          </div>
        )}

        {sessions.length === 0 && !loading && (
          <div className="planning-sidebar-empty text-muted">
            {t("planning.noSavedSessions", "No saved sessions yet. Start one on the right to see it here.")}
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
                      ? (session.preview ?? t("planning.newPlanningSession", "New planning session"))
                      : session.title || t("planning.untitledSession", "Untitled session")}
                  </span>
                  <span className="planning-sidebar-item-meta">
                    <PlanningSessionStatusLabel status={session.status} />
                    <span aria-hidden> · </span>
                    <span>{formatRelativeTime(session.updatedAt, t)}</span>
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
                    {t("planning.delete", "Delete")}
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={onCancelDelete}
                  >
                    {t("common.cancel", "Cancel")}
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
                      aria-label={isArchived ? t("planning.unarchiveSession", "Unarchive session") : t("planning.archiveSession", "Archive session")}
                      title={isArchived ? t("planning.unarchiveSession", "Unarchive session") : t("planning.archiveSession", "Archive session")}
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
                    aria-label={t("planning.deleteSession", "Delete session")}
                    title={t("planning.deleteSession", "Delete session")}
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
        {/*
        FNXC:Planning 2026-06-23-01:15:
        The New session CTA mirrors Missions' primary sidebar action: it reuses the shared "btn btn-primary" look (same base button class MissionManager pairs with mission-manager__sidebar-cta) so size and color match the Missions create button exactly, full-width and bottom-anchored. The "active" state (no session selected) keeps a subtle accent so the user can tell they're on the new-session view.
        */}
        <button
          className={`btn btn-primary planning-sidebar-new ${selectedSessionId === null ? "active" : ""}`}
          onClick={onNewSession}
          type="button"
        >
          <MessageSquarePlus size={16} />
          <span>{t("planning.newSession", "New session")}</span>
        </button>
        <a
          href="#"
          className="planning-sidebar-toggle-archived-link"
          onClick={(e) => {
            e.preventDefault();
            onToggleShowArchived();
          }}
          aria-pressed={showArchived}
        >
          {showArchived ? t("planning.hideArchived", "Hide archived") : t("planning.showArchived", "Show archived")}
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
  const { t } = useTranslation("app");
  switch (status) {
    case "generating":
      return <span>{t("planning.statusGenerating", "Generating")}</span>;
    case "awaiting_input":
      return <span>{t("planning.statusNeedsInput", "Needs input")}</span>;
    case "complete":
      return <span>{t("planning.statusComplete", "Complete")}</span>;
    case "error":
      return <span>{t("planning.statusError", "Error")}</span>;
    default:
      return <span>{status}</span>;
  }
}

/*
FNXC:PlanningTimestamps 2026-06-17-17:34:
FN-6601 shares relative-time bucket math while preserving Planning Mode's empty invalid/future fallback and weeks-specific translation branch.
*/
function formatRelativeTime(iso: string, t: TFunction<"app">): string {
  const bucket = getRelativeTimeBucket(iso);
  if (!bucket) return "";

  switch (bucket.bucket) {
    case "just-now":
      return t("planning.relativeTimeJustNow", "just now");
    case "minutes":
      return t("planning.relativeTimeMinutes", "{{count}}m ago", { count: bucket.count });
    case "hours":
      return t("planning.relativeTimeHours", "{{count}}h ago", { count: bucket.count });
    case "days":
      return t("planning.relativeTimeDays", "{{count}}d ago", { count: bucket.count });
    case "weeks":
      return t("planning.relativeTimeWeeks", "{{count}}w ago", { count: bucket.count });
    case "older":
      return bucket.date.toLocaleDateString();
  }
}
