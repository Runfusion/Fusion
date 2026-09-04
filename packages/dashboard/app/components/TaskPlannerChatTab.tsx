import type { ChatInFlightGenerationState, ChatMessage, ChatSnippet, ResolvedModelSelection, Settings, Task, TaskDetail } from "@fusion/core";
import { isWipColumnRole } from "../utils/columnRoles";
import { getErrorMessage, isExperimentalFeatureEnabled, CHAT_FOCUS_FLAG } from "@fusion/core";
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Loader2, Maximize2, Minimize2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ToastType } from "../hooks/useToast";
import { useComposerDictation } from "../hooks/useComposerDictation";
import { getPersistedPendingChatMessages, setPersistedPendingChatMessages } from "../hooks/chatPendingMessageStorage";
import { MicButton } from "./MicButton";
import type { ChatMessageInfo, ToolCallInfo } from "../hooks/chatTypes";
import { attachChatStream, cancelChatResponse, ensureTaskPlannerChatSession, fetchChatMessages, fetchChatSession, fetchSettings, fetchTaskDetail, fetchTaskPlannerChatSession, streamChatResponse, updateChatSession, type ChatFailureInfo, type ChatStreamErrorMeta } from "../api";
import { parseQuestionToolCall, type ParsedQuestionToolCall } from "../utils/parseQuestionToolCall";
import { ChatQuestionResponse } from "./ChatQuestionResponse";
import { PendingChatMessageQueue } from "./PendingChatMessageQueue";
import { ProviderIcon } from "./ProviderIcon";
import { ChatThinkingLevelControl } from "./ChatThinkingLevelControl";
import { useModelsCache } from "../hooks/useModelsCache";
import { useChatSnippets } from "../hooks/useChatSnippetsCache";
import { StandardChatActionButton, StandardChatMessageItem, StandardStreamingMessage, formatModelTag } from "./StandardChatSurface";
import { filterChatCommands, getSlashTriggerMatch, matchChatCommand, selectChatCommands, type ChatCommand } from "./chat-commands";
import { applySnippetToDraft, filterChatSnippets, matchStandaloneSnippetInvocation } from "./chat-snippets";
import { useChatMessageLayout } from "../context/ChatMessageLayoutContext";
import {
  createChatInputAutosizeController,
  type ChatInputAutosizeController,
} from "../utils/chatInputAutosize";
import { ChatFocusSelector } from "./ChatFocusSelector";
import "./TaskPlannerChatTab.css";

interface TaskPlannerChatTabProps {
  /** Resolved column flags for this task, from TaskDetailModal. */
  columnFlags?: Parameters<typeof isWipColumnRole>[0];
  task: Task | TaskDetail;
  projectId?: string;
  active: boolean;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  taskChatModel: ResolvedModelSelection & { thinkingLevel?: string };
  addToast: (msg: string, type?: ToastType) => void;
  onTaskUpdated?: (task: Task) => void;
}

type ComposerState = "idle" | "sending";

type PlannerSlashMenuEntry =
  | { kind: "command"; command: ChatCommand }
  | { kind: "snippet"; snippet: ChatSnippet };

type PendingQueueReservation = {
  sessionId: string;
  text: string;
  index: number;
};

type PlannerQuestionRenderState = {
  parsed: ParsedQuestionToolCall;
  answered: boolean;
  submittedAnswer?: string;
  hiddenDuplicate: boolean;
};

interface StarterPromptDefinition {
  id: string;
  labelKey: string;
  labelFallback: string;
  descriptionKey: string;
  descriptionFallback: string;
  messageKey: string;
  messageFallback: string;
}

const BOTTOM_FOLLOW_THRESHOLD = 48;

function isTranscriptNearBottom(container: HTMLElement): boolean {
  return container.scrollHeight - (container.scrollTop + container.clientHeight) <= BOTTOM_FOLLOW_THRESHOLD;
}

function normalizePendingMessages(messages: readonly string[]): string[] {
  return messages.map((message) => message.trim()).filter(Boolean);
}

const TASK_PLANNER_CHAT_STARTER_PROMPTS: StarterPromptDefinition[] = [
  {
    id: "recent-activity",
    labelKey: "taskDetail.plannerChat.starters.recentActivity.label",
    labelFallback: "Summarize recent activity",
    descriptionKey: "taskDetail.plannerChat.starters.recentActivity.description",
    descriptionFallback: "Get a concise recap before reading the full Activity feed.",
    messageKey: "taskDetail.plannerChat.starters.recentActivity.message",
    messageFallback: "Summarize the recent activity for this task and call out anything important I should know.",
  },
  {
    id: "status-blockers",
    labelKey: "taskDetail.plannerChat.starters.statusBlockers.label",
    labelFallback: "Explain status and blockers",
    descriptionKey: "taskDetail.plannerChat.starters.statusBlockers.description",
    descriptionFallback: "Understand where the task stands and what might be blocking it.",
    messageKey: "taskDetail.plannerChat.starters.statusBlockers.message",
    messageFallback: "Explain the current status of this task, including any blockers, risks, or dependencies.",
  },
  {
    id: "next-action",
    labelKey: "taskDetail.plannerChat.starters.nextAction.label",
    labelFallback: "Identify the next best action",
    descriptionKey: "taskDetail.plannerChat.starters.nextAction.description",
    descriptionFallback: "Ask for a practical next step for this task's current state.",
    messageKey: "taskDetail.plannerChat.starters.nextAction.message",
    messageFallback: "What is the next best action for this task, and why?",
  },
  {
    id: "plan-review",
    labelKey: "taskDetail.plannerChat.starters.planReview.label",
    labelFallback: "Review the plan or definition",
    descriptionKey: "taskDetail.plannerChat.starters.planReview.description",
    descriptionFallback: "Check whether the task definition is ready to execute.",
    messageKey: "taskDetail.plannerChat.starters.planReview.message",
    messageFallback: "Review this task's plan or definition and tell me what is clear, missing, or risky.",
  },
];

function isUsableModel(model: ResolvedModelSelection): model is ResolvedModelSelection & { provider: string; modelId: string } {
  return Boolean(model.provider?.trim() && model.modelId?.trim());
}

function sortMessages(messages: ChatMessage[]): ChatMessage[] {
  return [...messages].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

function makeOptimisticUserMessage(sessionId: string, content: string): ChatMessage {
  return {
    id: `optimistic-${Date.now()}`,
    sessionId,
    role: "user",
    content,
    thinkingOutput: null,
    metadata: { optimistic: true },
    createdAt: new Date().toISOString(),
  };
}

function mergePlannerTranscriptWithOptimistic(current: ChatMessage[], refreshed: ChatMessage[]): ChatMessage[] {
  let next = current.filter((message) => message.id !== "streaming-assistant");
  for (const persisted of sortMessages(refreshed)) {
    if (next.some((message) => message.id === persisted.id)) continue;
    if (persisted.role === "user") {
      const optimisticIndex = next.findIndex((candidate) =>
        candidate.role === "user"
        && candidate.id.startsWith("optimistic-")
        && candidate.sessionId === persisted.sessionId
        && candidate.content.trim() === persisted.content.trim(),
      );
      if (optimisticIndex >= 0) {
        next = next.map((candidate, index) => index === optimisticIndex ? persisted : candidate);
        continue;
      }
    }
    next = [...next, persisted];
  }
  return sortMessages(next);
}

function makeStreamingAssistantMessage(sessionId: string, content: string, toolCalls: ToolCallInfo[] = [], thinkingOutput = ""): ChatMessage {
  return {
    id: "streaming-assistant",
    sessionId,
    role: "assistant",
    content,
    thinkingOutput: thinkingOutput || null,
    metadata: { streaming: true, ...(toolCalls.length > 0 ? { toolCalls } : {}) },
    createdAt: new Date().toISOString(),
  };
}

const TASK_PLANNER_STEERING_TOOL_NAME = "fn_task_planner_add_steering";
const TASK_PLANNER_REFINEMENT_TOOL_NAME = "fn_task_planner_create_refinement";

interface PlannerSteeringResult {
  text: string;
  id?: string;
  createdAt?: string;
}

interface PlannerRefinementResult {
  sourceTaskId: string;
  refinementTaskId: string;
  description?: string;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function extractPlannerSteeringResult(toolCall: ToolCallInfo): PlannerSteeringResult | null {
  if (toolCall.toolName !== TASK_PLANNER_STEERING_TOOL_NAME || toolCall.isError || toolCall.status === "running") return null;
  const resultRecord = readRecord(toolCall.result);
  const detailsRecord = readRecord(resultRecord?.details) ?? resultRecord;
  const commentRecord = readRecord(detailsRecord?.steeringComment);
  const text = typeof commentRecord?.text === "string" && commentRecord.text.trim()
    ? commentRecord.text.trim()
    : typeof detailsRecord?.text === "string" && detailsRecord.text.trim()
      ? detailsRecord.text.trim()
      : typeof toolCall.args?.text === "string" && toolCall.args.text.trim()
        ? toolCall.args.text.trim()
        : "";
  if (!text) return null;
  return {
    text,
    ...(typeof commentRecord?.id === "string" && commentRecord.id.trim() ? { id: commentRecord.id.trim() } : {}),
    ...(typeof commentRecord?.createdAt === "string" && commentRecord.createdAt.trim() ? { createdAt: commentRecord.createdAt.trim() } : {}),
  };
}

function extractPlannerSteeringTextFromResult(result: unknown): string | null {
  const resultRecord = readRecord(result);
  const detailsRecord = readRecord(resultRecord?.details) ?? resultRecord;
  const commentRecord = readRecord(detailsRecord?.steeringComment);
  const text = typeof commentRecord?.text === "string" && commentRecord.text.trim()
    ? commentRecord.text.trim()
    : typeof detailsRecord?.text === "string" && detailsRecord.text.trim()
      ? detailsRecord.text.trim()
      : "";
  return text || null;
}

function extractPlannerRefinementResult(toolCall: ToolCallInfo): PlannerRefinementResult | null {
  if (toolCall.toolName !== TASK_PLANNER_REFINEMENT_TOOL_NAME || toolCall.isError || toolCall.status === "running") return null;
  const resultRecord = readRecord(toolCall.result);
  const detailsRecord = readRecord(resultRecord?.details) ?? resultRecord;
  const sourceTaskId = typeof detailsRecord?.sourceTaskId === "string" ? detailsRecord.sourceTaskId.trim() : "";
  const refinementTaskId = typeof detailsRecord?.refinementTaskId === "string" ? detailsRecord.refinementTaskId.trim() : "";
  if (!sourceTaskId || !refinementTaskId) return null;
  return {
    sourceTaskId,
    refinementTaskId,
    ...(typeof detailsRecord?.description === "string" && detailsRecord.description.trim() ? { description: detailsRecord.description.trim() } : {}),
  };
}

function normalizeChatFailureSummary(error: string | ChatFailureInfo, fallback: string): string {
  return typeof error === "string" ? error || fallback : error.summary || fallback;
}

function cloneToolCalls(toolCalls: readonly ToolCallInfo[] | readonly ChatInFlightGenerationState["toolCalls"][number][] | undefined): ToolCallInfo[] {
  return (toolCalls ?? []).map((toolCall) => ({
    toolName: toolCall.toolName,
    ...(toolCall.args ? { args: { ...toolCall.args } } : {}),
    isError: toolCall.isError,
    ...(toolCall.result !== undefined ? { result: toolCall.result } : {}),
    status: toolCall.status,
  }));
}

function extractToolCalls(message: Pick<ChatMessage, "metadata">): ToolCallInfo[] {
  const rawToolCalls = message.metadata?.toolCalls;
  if (!Array.isArray(rawToolCalls)) return [];
  return rawToolCalls
    .map((toolCall): ToolCallInfo | null => {
      if (!toolCall || typeof toolCall !== "object") return null;
      const record = toolCall as Record<string, unknown>;
      const toolName = typeof record.toolName === "string" ? record.toolName : "";
      if (!toolName) return null;
      const args = record.args;
      return {
        toolName,
        ...(args && typeof args === "object" ? { args: args as Record<string, unknown> } : {}),
        isError: Boolean(record.isError),
        result: record.result,
        status: record.status === "running" ? "running" : "completed",
      };
    })
    .filter((toolCall): toolCall is ToolCallInfo => toolCall !== null);
}

function getPlannerQuestionKey(parsed: ParsedQuestionToolCall): string {
  return JSON.stringify(parsed.questions.map((question) => ({
    id: question.id,
    type: question.type,
    question: question.question,
    options: question.options?.map((option) => [option.id, option.label]),
  })));
}

function isQuestionAnswerFor(message: ChatMessage, parsed: ParsedQuestionToolCall): boolean {
  if (message.role !== "user") return false;
  const trimmed = message.content.trim();
  if (!trimmed) return false;
  return parsed.questions.some((question) => trimmed.includes(`> Q: ${question.question}`));
}

function toStandardChatMessage(message: ChatMessage): ChatMessageInfo {
  /*
  FNXC:AITransparency 2026-09-04-04:44:
  Planner Chat reuses the shared persisted-message renderer, so per-turn provider/model metadata
  must survive this mapping. Dropping it would make historic planner output inherit displayedModel.
  */
  return {
    id: message.id,
    sessionId: message.sessionId,
    role: message.role,
    content: message.content,
    thinkingOutput: message.thinkingOutput,
    toolCalls: extractToolCalls(message),
    ...(message.metadata ? { metadata: message.metadata } : {}),
    createdAt: message.createdAt,
  };
}

function buildPlannerQuestionRenderStates(messages: readonly ChatMessage[]): Map<string, PlannerQuestionRenderState> {
  const states = new Map<string, PlannerQuestionRenderState>();
  const latestUnansweredByQuestion = new Map<string, string>();

  messages.forEach((message, messageIndex) => {
    if (message.role !== "assistant") return;
    extractToolCalls(message).forEach((toolCall, toolCallIndex) => {
      const parsed = parseQuestionToolCall(toolCall);
      if (!parsed) return;
      const stateKey = `${message.id}:${toolCallIndex}`;
      const questionKey = getPlannerQuestionKey(parsed);
      const nextUserAnswer = messages.slice(messageIndex + 1).find((candidate) => isQuestionAnswerFor(candidate, parsed));
      const answered = Boolean(nextUserAnswer);
      if (!answered) {
        const previousPendingKey = latestUnansweredByQuestion.get(questionKey);
        if (previousPendingKey) {
          const previous = states.get(previousPendingKey);
          if (previous) {
            states.set(previousPendingKey, { ...previous, hiddenDuplicate: true });
          }
        }
        latestUnansweredByQuestion.set(questionKey, stateKey);
      }
      states.set(stateKey, {
        parsed,
        answered,
        submittedAnswer: nextUserAnswer?.content,
        hiddenDuplicate: false,
      });
    });
  });

  return states;
}

export function TaskPlannerChatTab({ task, columnFlags, projectId, active, expanded = false, onExpandedChange, taskChatModel, addToast, onTaskUpdated }: TaskPlannerChatTabProps) {
  const { t } = useTranslation("app");
  const chatMessageLayout = useChatMessageLayout();
  const [sessionId, setSessionId] = useState<string | null>(null);
  /*
  FNXC:ChatMemoryFocus 2026-08-13:
  RUFU-068: local mirror of chat_sessions.memory_focus for the planner-chat composer. Read
  once at session load and updated by ChatFocusSelector.onPersist so the chip reflects the
  persisted per-conversation focus without a full session refetch.
  */
  const [sessionMemoryFocus, setSessionMemoryFocus] = useState<string | null>(null);
  const [chatSettings, setChatSettings] = useState<Settings | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [pendingMessages, setPendingMessages] = useState<string[]>([]);
  const [queueActionPending, setQueueActionPending] = useState(false);
  const composerTextareaRef = useRef<HTMLTextAreaElement>(null);
  const autosizeRef = useRef<ChatInputAutosizeController | null>(null);
  const dictation = useComposerDictation({ textareaRef: composerTextareaRef, value: draft, onChange: setDraft, projectId });
  const chatSnippets = useChatSnippets();
  const [showCommandMenu, setShowCommandMenu] = useState(false);
  const [commandFilter, setCommandFilter] = useState("");
  const [highlightedCommandIndex, setHighlightedCommandIndex] = useState(0);
  const [streamingThinking, setStreamingThinking] = useState("");
  const [composerState, setComposerState] = useState<ComposerState>("idle");
  const composerStateRef = useRef<ComposerState>("idle");
  const [loading, setLoading] = useState(false);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const streamRef = useRef<{ close: () => void } | null>(null);
  const pendingMessagesRef = useRef<string[]>([]);
  const sessionIdRef = useRef<string | null>(null);
  const queueDispatchRef = useRef<((sessionId: string, selectedIndex?: number) => void) | null>(null);
  const streamSnapshotRef = useRef<{
    requestId: number;
    sessionId: string;
    text: string;
    thinking: string;
    toolCalls: ToolCallInfo[];
  } | null>(null);
  const cancellationInProgressRef = useRef<Promise<void> | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const [isTranscriptAtBottom, setIsTranscriptAtBottom] = useState(true);
  const isTranscriptAtBottomRef = useRef(true);
  const previousMessageCountRef = useRef(0);
  const previousActiveRef = useRef(false);
  const isProgrammaticTranscriptScrollRef = useRef(false);
  const loadRequestRef = useRef(0);
  const streamRequestRef = useRef(0);
  const addToastRef = useRef(addToast);
  const onTaskUpdatedRef = useRef(onTaskUpdated);
  const taskChatModelRef = useRef(taskChatModel);

  useEffect(() => {
    addToastRef.current = addToast;
    onTaskUpdatedRef.current = onTaskUpdated;
    taskChatModelRef.current = taskChatModel;
  }, [addToast, onTaskUpdated, taskChatModel]);

  useEffect(() => {
    let cancelled = false;
    setChatSettings(null);
    fetchSettings(projectId)
      .then((settings) => {
        if (!cancelled) setChatSettings(settings);
      })
      .catch(() => {
        if (!cancelled) setChatSettings(null);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const chatFocusEnabled = isExperimentalFeatureEnabled(chatSettings ?? undefined, CHAT_FOCUS_FLAG);
  const selectedChatCommands = useMemo(() => selectChatCommands({ chatFocusEnabled }), [chatFocusEnabled]);
  const [sessionModel, setSessionModel] = useState<ResolvedModelSelection & { thinkingLevel?: string }>(taskChatModel);
  const hasLocalTargetOverrideRef = useRef(false);
  const { models, favoriteProviders, favoriteModels } = useModelsCache();
  const displayedModel = sessionModel;
  const displayedModelProvider = isUsableModel(displayedModel) ? displayedModel.provider : undefined;
  const displayedModelId = isUsableModel(displayedModel) ? displayedModel.modelId : undefined;
  const displayedModelLabel = displayedModelProvider && displayedModelId ? `${displayedModelProvider}/${displayedModelId}` : "";
  const activeModelTag = formatModelTag(displayedModelProvider, displayedModelId);
  const modelPayload = useMemo(() => {
    return displayedModelProvider && displayedModelId
      ? {
          modelProvider: displayedModelProvider,
          modelId: displayedModelId,
          ...(displayedModel.thinkingLevel ? { thinkingLevel: displayedModel.thinkingLevel } : {}),
        }
      : {};
  }, [displayedModel, displayedModelId, displayedModelProvider]);

  /*
  FNXC:TaskChatDefaultModel 2026-08-19-12:12:
  Task Chat exposes the same model and thinking controls as Direct Chat, but keeps model-only targeting so a selection never impersonates a durable agent or bypasses the synthetic task authorization contract. Before the first send selections stay local; an existing session is patched in its project scope.
  */
  const handleTaskChatModelChange = useCallback(async (value: string) => {
    const slashIndex = value.indexOf("/");
    const useProjectDefault = value === "";
    if (!useProjectDefault && (slashIndex <= 0 || slashIndex === value.length - 1)) return;
    const modelProvider = useProjectDefault ? taskChatModel.provider : value.slice(0, slashIndex);
    const modelId = useProjectDefault ? taskChatModel.modelId : value.slice(slashIndex + 1);
    if (!modelProvider || !modelId) return;
    hasLocalTargetOverrideRef.current = !useProjectDefault;
    setSessionModel((current) => ({
      ...current,
      provider: modelProvider,
      modelId,
      ...(useProjectDefault ? { thinkingLevel: taskChatModel.thinkingLevel } : {}),
    }));
    const resolvedSessionId = sessionIdRef.current;
    if (!resolvedSessionId) return;
    try {
      const { session } = await updateChatSession(
        resolvedSessionId,
        {
          modelProvider,
          modelId,
          thinkingLevel: useProjectDefault ? taskChatModel.thinkingLevel ?? null : displayedModel.thinkingLevel ?? null,
        },
        projectId,
      );
      if (sessionIdRef.current !== resolvedSessionId) return;
      setSessionModel({
        ...(session.modelProvider && session.modelId ? { provider: session.modelProvider, modelId: session.modelId } : {}),
        ...(session.thinkingLevel ? { thinkingLevel: session.thinkingLevel } : {}),
      });
    } catch (err) {
      const message = getErrorMessage(err) || t("taskDetail.plannerChat.modelChangeFailed", "Failed to change task chat model");
      setError(message);
      addToastRef.current(message, "error");
    }
  }, [displayedModel.thinkingLevel, projectId, t, taskChatModel]);

  const handleTaskChatThinkingChange = useCallback(async (thinkingLevel: string) => {
    hasLocalTargetOverrideRef.current = true;
    setSessionModel((current) => ({ ...current, ...(thinkingLevel ? { thinkingLevel } : { thinkingLevel: undefined }) }));
    const resolvedSessionId = sessionIdRef.current;
    if (!resolvedSessionId) return;
    try {
      const { session } = await updateChatSession(resolvedSessionId, { thinkingLevel: thinkingLevel || null }, projectId);
      if (sessionIdRef.current !== resolvedSessionId) return;
      setSessionModel((current) => ({
        ...current,
        ...(session.thinkingLevel ? { thinkingLevel: session.thinkingLevel } : { thinkingLevel: undefined }),
      }));
    } catch (err) {
      const message = getErrorMessage(err) || t("taskDetail.plannerChat.thinkingChangeFailed", "Failed to change task chat thinking level");
      setError(message);
      addToastRef.current(message, "error");
    }
  }, [projectId, t]);

  const plannerChatScopeKey = `${task.id}\u0000${projectId ?? ""}`;

  useEffect(() => {
    if (
      !sessionId
      && !hasLocalTargetOverrideRef.current
      && (sessionModel.provider !== taskChatModel.provider
        || sessionModel.modelId !== taskChatModel.modelId
        || sessionModel.thinkingLevel !== taskChatModel.thinkingLevel)
    ) {
      setSessionModel(taskChatModel);
    }
  }, [sessionId, sessionModel, taskChatModel]);

  const handleComposerRef = useCallback((textarea: HTMLTextAreaElement | null) => {
    autosizeRef.current?.destroy();
    autosizeRef.current = null;
    composerTextareaRef.current = textarea;
    if (!textarea) return;
    autosizeRef.current = createChatInputAutosizeController(textarea);
  }, []);

  useLayoutEffect(() => {
    autosizeRef.current?.resize();
  }, [draft]);

  const replacePendingMessages = useCallback((nextMessages: readonly string[], resolvedSessionId = sessionIdRef.current) => {
    const normalizedMessages = normalizePendingMessages(nextMessages);
    pendingMessagesRef.current = normalizedMessages;
    setPendingMessages(normalizedMessages);
    setPersistedPendingChatMessages(resolvedSessionId, normalizedMessages);
  }, []);

  const restorePendingQueueReservation = useCallback((reservation: PendingQueueReservation) => {
    if (sessionIdRef.current !== reservation.sessionId) return;
    const current = pendingMessagesRef.current;
    const insertionIndex = Math.min(Math.max(reservation.index, 0), current.length);
    const next = [...current.slice(0, insertionIndex), reservation.text, ...current.slice(insertionIndex)];
    replacePendingMessages(next, reservation.sessionId);
  }, [replacePendingMessages]);

  /*
   * FNXC:TaskPlannerChatSlashCommands 2026-07-08-00:00:
   * /steer is only dispatchable when this task's bound agent is actively
   * running (task.column === "in-progress"), mirroring how TaskChatTab gates
   * its own done-task affordance on task.column. Any other state (todo,
   * in-review, done, archived, triage) shows the command in the menu but
   * disabled with a hint instead of hiding it outright, and dispatch itself
   * is refused with the same hint rather than silently sending plain chat.
   */
  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-15:20 (batch-dashboard-app):
  WIP role, resolved. `agentRunning` suppresses the planner composer while an implementation agent
  holds the card. Keyed on the literal, a renamed wip lane left the composer ENABLED during a run, so
  planner edits could land against a task already being implemented.
  */
  const agentRunning = isWipColumnRole(columnFlags, task.column);
  const filteredCommands = useMemo(
    () => filterChatCommands(commandFilter, selectedChatCommands),
    [commandFilter, selectedChatCommands],
  );
  const filteredSnippets = useMemo(
    () => filterChatSnippets(commandFilter, chatSnippets),
    [chatSnippets, commandFilter],
  );
  const slashMenuEntries = useMemo<PlannerSlashMenuEntry[]>(() => [
    ...filteredCommands.map((command) => ({ kind: "command" as const, command })),
    ...filteredSnippets.map((snippet) => ({ kind: "snippet" as const, snippet })),
  ], [filteredCommands, filteredSnippets]);

  useEffect(() => {
    setHighlightedCommandIndex(0);
  }, [commandFilter]);

  const applyStreamingSnapshot = useCallback((resolvedSessionId: string, text: string, thinking: string, toolCalls: ToolCallInfo[]) => {
    setStreamingThinking(thinking);
    setMessages((current) => {
      const withoutStreaming = current.filter((message) => message.id !== "streaming-assistant");
      return [...withoutStreaming, makeStreamingAssistantMessage(resolvedSessionId, text, toolCalls, thinking)];
    });
  }, []);

  const refreshMessagesForSession = useCallback(async (resolvedSessionId: string, isCurrentRequest: () => boolean, options?: { mergeOptimistic?: boolean }) => {
    try {
      const { messages: refreshed } = await fetchChatMessages(resolvedSessionId, { order: "asc" }, projectId);
      if (!isCurrentRequest()) return;
      if (options?.mergeOptimistic) {
        setMessages((current) => mergePlannerTranscriptWithOptimistic(current, refreshed));
      } else {
        setMessages(sortMessages(refreshed));
      }
      setHistoryLoaded(true);
    } catch (refreshError) {
      if (!isCurrentRequest()) return;
      const message = getErrorMessage(refreshError) || t("taskDetail.plannerChat.loadFailed", "Failed to load task chat");
      setError(message);
      addToastRef.current(message, "error");
    }
  }, [projectId, t]);

  const refreshTaskAfterSteering = useCallback(async () => {
    try {
      const refreshedTask = await fetchTaskDetail(task.id, projectId);
      onTaskUpdatedRef.current?.(refreshedTask);
      addToastRef.current(t("taskDetail.plannerChat.steeringAddedToast", "Added as steering comment"), "success");
    } catch (refreshError) {
      const message = getErrorMessage(refreshError) || t("taskDetail.plannerChat.refreshTaskFailed", "Steering was added, but task details could not refresh");
      setError(message);
      addToastRef.current(message, "error");
    }
  }, [projectId, task.id, t]);

  const startPlannerStream = useCallback((options: {
    resolvedSessionId: string;
    content?: string;
    inFlightGeneration?: ChatInFlightGenerationState | null;
    requestId: number;
    attach: boolean;
    queueReservation?: PendingQueueReservation;
    replacementMessageId?: string;
    replacementTargetIndex?: number;
    replacementMessage?: ChatMessage;
    onAccepted?: () => void;
    onRejected?: (message: string) => void;
  }) => {
    const {
      resolvedSessionId,
      content = "",
      inFlightGeneration,
      requestId,
      attach,
      queueReservation,
      replacementMessageId,
      replacementTargetIndex,
      replacementMessage,
      onAccepted,
      onRejected,
    } = options;
    const isCurrentStreamRequest = () => streamRequestRef.current === requestId;
    const inFlightSnapshot = attach ? inFlightGeneration : null;
    let accumulated = inFlightSnapshot?.streamingText ?? "";
    let accumulatedThinking = inFlightSnapshot?.streamingThinking ?? "";
    const streamingToolCalls = cloneToolCalls(inFlightSnapshot?.toolCalls);
    const updateStreamSnapshot = (): void => {
      streamSnapshotRef.current = {
        requestId,
        sessionId: resolvedSessionId,
        text: accumulated,
        thinking: accumulatedThinking,
        toolCalls: cloneToolCalls(streamingToolCalls),
      };
    };
    updateStreamSnapshot();

    /*
     * FNXC:TaskDetailPlannerChat 2026-07-15-00:00:
     * A fresh reply, and an attach without a persisted in-flight snapshot, must start with empty
     * streaming carriers so no previous turn appears before its first event. Only an attach with a
     * valid snapshot restores text, thinking, and tools because that data belongs to the still-live
     * generation the user is returning to.
     */
    if (!inFlightSnapshot) {
      setStreamingThinking("");
      setMessages((current) => current.filter((message) => message.id !== "streaming-assistant"));
    }

    streamRef.current?.close();
    if (!isCurrentStreamRequest()) return;

    composerStateRef.current = "sending";
    setComposerState("sending");
    setError(null);
    applyStreamingSnapshot(resolvedSessionId, accumulated, accumulatedThinking, streamingToolCalls);

    const handlers = {
      onAccepted: () => {
        if (replacementMessageId && replacementTargetIndex !== undefined && replacementMessage) {
          setMessages((current) => [
            ...current.filter((message) => message.id !== replacementMessage.id).slice(0, replacementTargetIndex),
            replacementMessage,
          ]);
        }
        onAccepted?.();
      },
      onText: (delta: string) => {
        if (!isCurrentStreamRequest()) return;
        accumulated += delta;
        updateStreamSnapshot();
        applyStreamingSnapshot(resolvedSessionId, accumulated, accumulatedThinking, streamingToolCalls);
      },
      onThinking: (delta: string) => {
        if (!isCurrentStreamRequest()) return;
        accumulatedThinking += delta;
        updateStreamSnapshot();
        applyStreamingSnapshot(resolvedSessionId, accumulated, accumulatedThinking, streamingToolCalls);
      },
      onToolStart: ({ toolName, args }: { toolName: string; args?: Record<string, unknown> }) => {
        if (!isCurrentStreamRequest()) return;
        streamingToolCalls.push({ toolName, args, isError: false, status: "running" });
        updateStreamSnapshot();
        applyStreamingSnapshot(resolvedSessionId, accumulated, accumulatedThinking, streamingToolCalls);
      },
      onToolEnd: ({ toolName, isError, result }: { toolName: string; isError: boolean; result?: unknown }) => {
        if (!isCurrentStreamRequest()) return;
        const running = [...streamingToolCalls].reverse().find((toolCall) => toolCall.toolName === toolName && toolCall.status === "running");
        if (running) {
          running.status = "completed";
          running.isError = isError;
          running.result = result;
        } else {
          streamingToolCalls.push({ toolName, isError, result, status: "completed" });
        }
        const steeringText = toolName === TASK_PLANNER_STEERING_TOOL_NAME && !isError
          ? extractPlannerSteeringTextFromResult(result)
          : null;
        if (steeringText) {
          void refreshTaskAfterSteering();
        }
        updateStreamSnapshot();
        applyStreamingSnapshot(resolvedSessionId, accumulated, accumulatedThinking, streamingToolCalls);
      },
      onDone: (data: { messageId: string; message?: ChatMessage }) => {
        if (!isCurrentStreamRequest()) return;
        composerStateRef.current = "idle";
        setComposerState("idle");
        setStreamingThinking("");
        streamSnapshotRef.current = null;
        streamRef.current = null;
        if (data.message) {
          setMessages((current) => {
            const withoutTemporary = current.filter((message) => message.id !== "streaming-assistant");
            return sortMessages([...withoutTemporary, data.message!]);
          });
        } else {
          void refreshMessagesForSession(resolvedSessionId, isCurrentStreamRequest, { mergeOptimistic: Boolean(content) });
        }
        queueDispatchRef.current?.(resolvedSessionId);
      },
      onError: (streamError: string | ChatFailureInfo, meta?: ChatStreamErrorMeta) => {
        if (!isCurrentStreamRequest()) return;
        const message = normalizeChatFailureSummary(streamError, t("taskDetail.plannerChat.sendFailed", "Task chat failed to respond"));
        setError(message);
        composerStateRef.current = "idle";
        setComposerState("idle");
        setStreamingThinking("");
        streamSnapshotRef.current = null;
        streamRef.current = null;
        setMessages((current) => {
          const withoutStreaming = current.filter((candidate) => candidate.id !== "streaming-assistant");
          if (meta?.requestAccepted === false && content) {
            return withoutStreaming.filter((candidate) => !(candidate.role === "user" && candidate.id.startsWith("optimistic-") && candidate.content.trim() === content.trim()));
          }
          return withoutStreaming;
        });
        if (meta?.requestAccepted === false) {
          if (queueReservation) restorePendingQueueReservation(queueReservation);
          onRejected?.(message);
          return;
        }
        void refreshMessagesForSession(resolvedSessionId, isCurrentStreamRequest, { mergeOptimistic: Boolean(content) });
        queueDispatchRef.current?.(resolvedSessionId);
      },
    };

    streamRef.current = attach
      ? attachChatStream(
          resolvedSessionId,
          handlers,
          projectId,
          typeof inFlightGeneration?.replayFromEventId === "number"
            ? { lastEventId: inFlightGeneration.replayFromEventId }
            : undefined,
        )
      : streamChatResponse(
          resolvedSessionId,
          content,
          handlers,
          undefined,
          projectId,
          {
            taskId: task.id,
            ...(replacementMessageId ? { replacementMessageId } : {}),
          },
        );
  }, [applyStreamingSnapshot, projectId, refreshMessagesForSession, refreshTaskAfterSteering, restorePendingQueueReservation, task.id, t]);

  const loadSession = useCallback(async () => {
    const requestId = loadRequestRef.current + 1;
    loadRequestRef.current = requestId;
    setLoading(true);
    setHistoryLoaded(false);
    setError(null);
    try {
      const { session: lookupSession } = await fetchTaskPlannerChatSession(task.id, {}, projectId);
      if (loadRequestRef.current !== requestId) return;
      if (!lookupSession) {
        sessionIdRef.current = null;
        setSessionId(null);
        setSessionModel(taskChatModelRef.current);
        replacePendingMessages([], null);
        setSessionMemoryFocus(null);
        setMessages([]);
        setHistoryLoaded(true);
        return;
      }
      sessionIdRef.current = lookupSession.id;
      setSessionId(lookupSession.id);
      replacePendingMessages(getPersistedPendingChatMessages(lookupSession.id), lookupSession.id);
      const [{ messages: loadedMessages }, refreshedSessionResult] = await Promise.all([
        fetchChatMessages(lookupSession.id, { order: "asc" }, projectId),
        fetchChatSession(lookupSession.id, projectId).catch(() => ({ session: lookupSession })),
      ]);
      if (loadRequestRef.current !== requestId) return;
      const resolvedSession = refreshedSessionResult.session;
      setSessionModel(
        resolvedSession.modelProvider && resolvedSession.modelId
          ? {
              provider: resolvedSession.modelProvider,
              modelId: resolvedSession.modelId,
              ...(resolvedSession.thinkingLevel ? { thinkingLevel: resolvedSession.thinkingLevel } : {}),
            }
          : taskChatModelRef.current,
      );
      setSessionMemoryFocus(resolvedSession.memoryFocus ?? null);
      setMessages(sortMessages(loadedMessages));
      setHistoryLoaded(true);
      if (resolvedSession.isGenerating || resolvedSession.inFlightGeneration) {
        const streamRequestId = streamRequestRef.current + 1;
        streamRequestRef.current = streamRequestId;
        startPlannerStream({
          resolvedSessionId: lookupSession.id,
          inFlightGeneration: resolvedSession.inFlightGeneration,
          requestId: streamRequestId,
          attach: true,
        });
      } else {
        queueDispatchRef.current?.(lookupSession.id);
      }
    } catch (err) {
      if (loadRequestRef.current !== requestId) return;
      const message = getErrorMessage(err) || t("taskDetail.plannerChat.loadFailed", "Failed to load task chat");
      setError(message);
      setHistoryLoaded(false);
    } finally {
      if (loadRequestRef.current === requestId) {
        setLoading(false);
      }
    }
  }, [projectId, replacePendingMessages, startPlannerStream, task.id, t]);

  useEffect(() => {
    loadRequestRef.current += 1;
    streamRequestRef.current += 1;
    streamRef.current?.close();
    streamRef.current = null;
    sessionIdRef.current = null;
    setSessionId(null);
    hasLocalTargetOverrideRef.current = false;
    setSessionModel(taskChatModelRef.current);
    pendingMessagesRef.current = [];
    setPendingMessages([]);
    setQueueActionPending(false);
    setSessionMemoryFocus(null);
    setMessages([]);
    setDraft("");
    composerStateRef.current = "idle";
    setStreamingThinking("");
    setComposerState("idle");
    setLoading(false);
    setHistoryLoaded(false);
    setError(null);
  }, [plannerChatScopeKey]);

  useEffect(() => {
    if (!active) return;
    void loadSession();
    return () => {
      loadRequestRef.current += 1;
    };
  }, [active, loadSession]);

  useEffect(() => {
    return () => {
      streamRequestRef.current += 1;
      streamRef.current?.close();
      streamRef.current = null;
    };
  }, []);

  const setTranscriptAtBottom = useCallback((atBottom: boolean) => {
    isTranscriptAtBottomRef.current = atBottom;
    setIsTranscriptAtBottom(atBottom);
  }, []);

  const anchorTranscriptToBottom = useCallback((container: HTMLElement) => {
    // Assignment does not normally emit scroll, but preserve the user-pinned state if a host does.
    isProgrammaticTranscriptScrollRef.current = true;
    try {
      container.scrollTop = container.scrollHeight;
      setTranscriptAtBottom(true);
    } finally {
      isProgrammaticTranscriptScrollRef.current = false;
    }
  }, [setTranscriptAtBottom]);

  const handleTranscriptScroll = useCallback(() => {
    if (isProgrammaticTranscriptScrollRef.current) return;
    const container = transcriptRef.current;
    if (!container) return;
    setTranscriptAtBottom(isTranscriptNearBottom(container));
  }, [setTranscriptAtBottom]);

  useEffect(() => {
    const container = transcriptRef.current;
    const wasActive = previousActiveRef.current;
    previousActiveRef.current = active;
    if (!container) return;

    if (messages.length === 0) {
      container.scrollTop = 0;
      previousMessageCountRef.current = 0;
      setTranscriptAtBottom(true);
      return;
    }

    const becameActive = active && !wasActive;
    const receivedInitialMessages = previousMessageCountRef.current === 0;
    /*
     * FNXC:TaskDetailPlannerChat 2026-07-18-16:10:
     * FN-8344 applies FN-8339's TaskChatTab sticky-bottom/manual-unsnap invariant to
     * Planner Chat. Initial history and tab activation intentionally anchor the reader,
     * while streamed snapshots follow only when the reader remains within the 48px tail
     * threshold so manually reading earlier planner output is never overridden.
     */
    if (active && (becameActive || receivedInitialMessages || (isTranscriptAtBottomRef.current && isTranscriptAtBottom))) {
      anchorTranscriptToBottom(container);
    }
    previousMessageCountRef.current = messages.length;
  }, [active, anchorTranscriptToBottom, composerState, isTranscriptAtBottom, messages, setTranscriptAtBottom]);

  const enqueuePendingMessage = useCallback((messageContent: string) => {
    const content = messageContent.trim();
    if (!content) return;
    const resolvedSessionId = sessionIdRef.current;
    replacePendingMessages([...pendingMessagesRef.current, content], resolvedSessionId);
    setDraft("");
    setError(null);
  }, [replacePendingMessages]);

  const dispatchQueuedMessage = useCallback((resolvedSessionId: string, selectedIndex = 0) => {
    if (sessionIdRef.current !== resolvedSessionId || composerStateRef.current === "sending" || cancellationInProgressRef.current) return;
    const current = pendingMessagesRef.current;
    const content = current[selectedIndex]?.trim();
    if (!content) return;

    const reservation: PendingQueueReservation = { sessionId: resolvedSessionId, text: content, index: selectedIndex };
    replacePendingMessages(current.filter((_, index) => index !== selectedIndex), resolvedSessionId);
    const streamRequestId = streamRequestRef.current + 1;
    streamRequestRef.current = streamRequestId;
    composerStateRef.current = "sending";
    setComposerState("sending");
    setError(null);
    setMessages((currentMessages) => [...currentMessages, makeOptimisticUserMessage(resolvedSessionId, content)]);
    try {
      startPlannerStream({
        resolvedSessionId,
        content,
        requestId: streamRequestId,
        attach: false,
        queueReservation: reservation,
      });
    } catch (err) {
      restorePendingQueueReservation(reservation);
      composerStateRef.current = "idle";
      setComposerState("idle");
      const message = getErrorMessage(err) || t("taskDetail.plannerChat.sendFailed", "Task chat failed to respond");
      setError(message);
      addToastRef.current(message, "error");
    }
  }, [restorePendingQueueReservation, replacePendingMessages, startPlannerStream, t]);

  queueDispatchRef.current = dispatchQueuedMessage;

  const sendMessageContent = useCallback(async (messageContent: string) => {
    const content = messageContent.trim();
    if (!content) return;
    if (composerStateRef.current === "sending" || cancellationInProgressRef.current) {
      enqueuePendingMessage(content);
      return;
    }
    composerStateRef.current = "sending";

    const streamRequestId = streamRequestRef.current + 1;
    streamRequestRef.current = streamRequestId;
    const isCurrentStreamRequest = () => streamRequestRef.current === streamRequestId;

    setDraft("");
    setComposerState("sending");
    setError(null);

    try {
      const { session } = await ensureTaskPlannerChatSession(task.id, modelPayload, projectId);
      if (!isCurrentStreamRequest()) return;
      const resolvedSessionId = session.id;
      setSessionModel(
        session.modelProvider && session.modelId
          ? {
              provider: session.modelProvider,
              modelId: session.modelId,
              ...(session.thinkingLevel ? { thinkingLevel: session.thinkingLevel } : {}),
            }
          : taskChatModel,
      );
      sessionIdRef.current = resolvedSessionId;
      setSessionId(resolvedSessionId);
      // FNXC:TaskPlannerChatQueue 2026-08-18-23:13:
      // Planner queue entries are browser-local and keyed by the resolved session. Persist any
      // follow-up typed before session creation completes only after that session becomes known.
      replacePendingMessages(pendingMessagesRef.current, resolvedSessionId);
      // A brand-new planner session has no focus yet (whole-project scope); seed the
      // mirror from whatever the created session carries (always null today).
      setSessionMemoryFocus((session as { memoryFocus?: string | null }).memoryFocus ?? null);
      setMessages((current) => [...current, makeOptimisticUserMessage(resolvedSessionId, content)]);
      if (!isCurrentStreamRequest()) return;
      startPlannerStream({
        resolvedSessionId,
        content,
        requestId: streamRequestId,
        attach: false,
      });
    } catch (err) {
      if (!isCurrentStreamRequest()) return;
      const message = getErrorMessage(err) || t("taskDetail.plannerChat.sendFailed", "Task chat failed to respond");
      setError(message);
      addToast(message, "error");
      composerStateRef.current = "idle";
      setComposerState("idle");
      setStreamingThinking("");
    }
  }, [addToast, enqueuePendingMessage, modelPayload, projectId, replacePendingMessages, startPlannerStream, task.id, taskChatModel, t]);

  const refreshTaskAfterEdit = useCallback(async (hadDiscardedSideEffect: boolean) => {
    try {
      const refreshedTask = await fetchTaskDetail(task.id, projectId);
      onTaskUpdatedRef.current?.(refreshedTask);
    } catch {
      // Best-effort: the edit itself already succeeded and resent; a task-detail refresh
      // failure here is non-fatal and must not be surfaced as an edit failure.
    }
    if (hadDiscardedSideEffect) {
      addToastRef.current(
        t(
          "taskDetail.plannerChat.editDiscardedSideEffectsToast",
          "Earlier steering comments or refinement tasks from the discarded messages were not undone",
        ),
        "info",
      );
    }
  }, [projectId, t, task.id]);

  /*
   * FNXC:TaskDetailPlannerChat 2026-08-19-03:34:
   * Planner edits share Direct Chat's replacement-aware POST. The target/later range remains
   * visible until SSE acceptance; the server owns deletion and pi rewind, while task refresh and
   * the existing side-effect notice happen only after that accepted replacement begins.
   * Discarded steering comments/refinement tasks remain durable and are never rolled back.
   */
  const editMessageAndResend = useCallback(async (messageId: string, newContent: string) => {
    if (composerStateRef.current === "sending" || !sessionId) return;
    if (messageId.startsWith("optimistic-") || messageId === "streaming-assistant") return;
    const trimmed = newContent.trim();
    if (!trimmed) return;

    const resolvedSessionId = sessionId;
    const targetIndex = messages.findIndex((candidate) => candidate.id === messageId);
    if (targetIndex === -1) return;
    const discardedRange = messages.slice(targetIndex);
    const hadDiscardedSideEffect = discardedRange.some((candidate) =>
      extractToolCalls(candidate).some((toolCall) =>
        extractPlannerSteeringResult(toolCall) !== null || extractPlannerRefinementResult(toolCall) !== null,
      ),
    );
    const replacementMessage = makeOptimisticUserMessage(resolvedSessionId, trimmed);
    const streamRequestId = streamRequestRef.current + 1;
    streamRequestRef.current = streamRequestId;
    composerStateRef.current = "sending";
    setComposerState("sending");
    setError(null);
    // Keep the old range mounted; this temporary row is removed/replaced on acceptance.
    setMessages((current) => [...current, replacementMessage]);

    await new Promise<void>((resolve, reject) => {
      startPlannerStream({
        resolvedSessionId,
        content: trimmed,
        requestId: streamRequestId,
        attach: false,
        replacementMessageId: messageId,
        replacementTargetIndex: targetIndex,
        replacementMessage,
        onAccepted: resolve,
        onRejected: (message) => {
          const failureMessage = message || t("taskDetail.plannerChat.editFailed", "Failed to edit task chat message");
          setError(failureMessage);
          addToastRef.current(failureMessage, "error");
          void refreshMessagesForSession(resolvedSessionId, () => true).finally(() => reject(new Error(failureMessage)));
        },
      });
    });

    await refreshTaskAfterEdit(hadDiscardedSideEffect);
  }, [messages, refreshMessagesForSession, refreshTaskAfterEdit, sessionId, startPlannerStream, t]);

  const dispatchSlashCommand = useCallback(async (command: ChatCommand, remainder: string) => {
    if (command.requiresAgent && !agentRunning) {
      // Do not silently fall back to a normal chat message: /steer with no
      // running agent is a no-op with feedback, not a plain send.
      addToastRef.current(t("taskDetail.plannerChat.commandNoRunningAgent", "No running agent to steer"), "warning");
      return;
    }

    /*
    FNXC:ChatSlashCommands 2026-07-10-11:40:
    Clear the draft immediately on submit — BEFORE awaiting command.run — not after it resolves. Clearing in the success path wipes any text the user typed while the command was in flight (composer-wipe race, FUX-015).
    */
    setDraft("");
    try {
      await command.run({ taskId: task.id, sessionId: sessionId ?? "", projectId, remainder });
      if (command.name === "focus") {
        /*
        FNXC:ChatMemoryFocus 2026-08-13:
        The /focus command persists the topic directly; reflect it locally so the chip
        matches. "all"/"*"/empty collapse to whole-project scope on display by the selector.
        */
        setSessionMemoryFocus(remainder);
        addToastRef.current(t("taskDetail.plannerChat.focusSetToast", "Memory focus updated"), "success");
      } else {
        // Reuse the existing steering-refresh path (same toast + task refresh already
        // used by the tool-call-driven steering flow above) instead of a second,
        // divergent success toast for the same underlying action.
        await refreshTaskAfterSteering();
      }
    } catch (err) {
      const message = getErrorMessage(err) || t("taskDetail.plannerChat.commandSteerFailed", "Failed to send to the running agent");
      addToastRef.current(message, "error");
    }
  }, [agentRunning, projectId, refreshTaskAfterSteering, sessionId, t, task.id]);

  const handleCommandMenuSelect = useCallback((command: ChatCommand) => {
    /*
    FNXC:ChatMemoryFocus 2026-08-13:
    The /focus command is not agent-gated, so it remains selectable and dispatchable
    when no agent is running (it is a local session-setting command).
    */
    if (command.requiresAgent && !agentRunning) {
      addToastRef.current(t("taskDetail.plannerChat.commandNoRunningAgent", "No running agent to steer"), "warning");
      return;
    }

    setDraft((current) => {
      const triggerMatch = getSlashTriggerMatch(current);
      if (!triggerMatch) return current;
      const replacement = `${command.trigger} `;
      return current.slice(0, triggerMatch.start) + replacement + current.slice(triggerMatch.end);
    });

    setShowCommandMenu(false);
    setCommandFilter("");
    setHighlightedCommandIndex(0);
  }, [agentRunning, t]);

  const handleSnippetMenuSelect = useCallback((snippet: ChatSnippet) => {
    const applied = applySnippetToDraft(
      draft,
      snippet,
      composerTextareaRef.current?.selectionStart ?? draft.length,
    );
    if (!applied) return;
    setDraft(applied.value);
    setShowCommandMenu(false);
    setCommandFilter("");
    setHighlightedCommandIndex(0);
    window.requestAnimationFrame(() => {
      composerTextareaRef.current?.focus();
      composerTextareaRef.current?.setSelectionRange(applied.cursorPosition, applied.cursorPosition);
      autosizeRef.current?.resize();
    });
  }, [draft]);

  const sendMessage = useCallback(() => {
    const trimmed = draft.trim();
    const snippetInvocation = matchStandaloneSnippetInvocation(trimmed, chatSnippets);
    if (snippetInvocation) {
      /*
      FNXC:ChatSnippets 2026-09-03-15:56:
      A standalone /name expands before command dispatch, streaming, optimistic transcript work, or persistent pending-queue writes. The operator must explicitly submit the inserted prompt a second time.
      */
      setDraft(snippetInvocation.prompt);
      setShowCommandMenu(false);
      setCommandFilter("");
      window.requestAnimationFrame(() => {
        composerTextareaRef.current?.focus();
        composerTextareaRef.current?.setSelectionRange(snippetInvocation.prompt.length, snippetInvocation.prompt.length);
        autosizeRef.current?.resize();
      });
      return;
    }
    const commandMatch = matchChatCommand(trimmed, selectedChatCommands);
    if (commandMatch) {
      setShowCommandMenu(false);
      return dispatchSlashCommand(commandMatch.command, commandMatch.remainder);
    }
    return sendMessageContent(draft);
  }, [chatSnippets, draft, dispatchSlashCommand, selectedChatCommands, sendMessageContent]);

  const handleDraftChange = useCallback((event: React.ChangeEvent<HTMLTextAreaElement>) => {
    const nextValue = event.target.value;
    setDraft(nextValue);

    const triggerMatch = getSlashTriggerMatch(nextValue.slice(0, event.target.selectionStart ?? nextValue.length));
    if (triggerMatch) {
      setShowCommandMenu(true);
      setCommandFilter(triggerMatch.filter);
    } else {
      setShowCommandMenu(false);
      setCommandFilter("");
    }
  }, []);

  const cancelPlannerGeneration = useCallback((snapshot: NonNullable<typeof streamSnapshotRef.current>, selectedIndex?: number) => {
    if (cancellationInProgressRef.current) return;
    setQueueActionPending(true);
    streamRequestRef.current += 1;
    streamRef.current?.close();
    streamRef.current = null;
    composerStateRef.current = "idle";
    setComposerState("idle");
    setStreamingThinking("");

    const interruptedLocalId = `interrupted-${snapshot.requestId}`;
    const hasInterruptedOutput = Boolean(snapshot.text || snapshot.thinking || snapshot.toolCalls.length > 0);
    if (hasInterruptedOutput) {
      // FNXC:ChatCancellation 2026-08-18-21:55:
      // Planner Stop keeps its displayed prefix as a normal transcript bubble until the
      // scoped cancellation response confirms the durable interrupted assistant message.
      setMessages((current) => [
        ...current.filter((message) => message.id !== "streaming-assistant" && message.id !== interruptedLocalId),
        {
          id: interruptedLocalId,
          sessionId: snapshot.sessionId,
          role: "assistant",
          content: snapshot.text,
          thinkingOutput: snapshot.thinking || null,
          metadata: snapshot.toolCalls.length > 0 ? { toolCalls: snapshot.toolCalls, interrupted: true } : { interrupted: true },
          createdAt: new Date().toISOString(),
        },
      ]);
    } else {
      setMessages((current) => current.filter((message) => message.id !== "streaming-assistant"));
    }

    const cancellation = Promise.resolve(cancelChatResponse(snapshot.sessionId, projectId))
      .then(async (result) => {
        const cancellationResult = result ?? { success: true, interrupted: false };
        if (!cancellationResult.success) {
          throw new Error(t("taskDetail.plannerChat.cancelFailed", "Failed to save the interrupted planner response"));
        }

        // Reconciliation is part of the cancellation barrier: queued text is not released
        // until the durable interrupted assistant row can be read back from chat history.
        const refreshed = (await fetchChatMessages(snapshot.sessionId, { order: "asc" }, projectId)).messages;
        if (sessionIdRef.current !== snapshot.sessionId) return;
        const persisted = cancellationResult.message ? [cancellationResult.message] : [];
        const reconciled = [
          ...refreshed,
          ...persisted.filter((message) => !refreshed.some((candidate) => candidate.id === message.id)),
        ];
        const hasDurableInterruptedMessage = Boolean(cancellationResult.message)
          || reconciled.some((message) =>
            message.role === "assistant"
            && message.content === snapshot.text
            && message.metadata?.interrupted === true,
          );
        setMessages((current) => mergePlannerTranscriptWithOptimistic(
          current.filter((message) =>
            message.id !== "streaming-assistant"
            && (!hasDurableInterruptedMessage || message.id !== interruptedLocalId),
          ),
          reconciled,
        ));

        if (cancellationInProgressRef.current === cancellation) {
          cancellationInProgressRef.current = null;
        }
        queueDispatchRef.current?.(snapshot.sessionId, selectedIndex);
      })
      .catch((cancelError) => {
        if (sessionIdRef.current === snapshot.sessionId) {
          const message = getErrorMessage(cancelError) || t("taskDetail.plannerChat.cancelFailed", "Failed to save the interrupted planner response");
          setError(message);
          addToastRef.current(message, "error");
        }
      })
      .finally(() => {
        streamSnapshotRef.current = null;
        if (cancellationInProgressRef.current === cancellation) {
          cancellationInProgressRef.current = null;
        }
        setQueueActionPending(false);
      });
    cancellationInProgressRef.current = cancellation;
  }, [projectId, t]);

  const stopPlannerStreaming = useCallback(() => {
    const snapshot = streamSnapshotRef.current;
    if (!snapshot) return;
    cancelPlannerGeneration(snapshot);
  }, [cancelPlannerGeneration]);

  const updatePendingMessage = useCallback((index: number, content: string) => {
    const current = pendingMessagesRef.current;
    if (index < 0 || index >= current.length) return;
    replacePendingMessages(
      current.map((pendingMessage, pendingIndex) => pendingIndex === index ? content : pendingMessage),
      sessionIdRef.current,
    );
    setError(null);
  }, [replacePendingMessages]);

  const movePendingMessage = useCallback((index: number, direction: -1 | 1) => {
    if (queueActionPending) return;
    const targetIndex = index + direction;
    const current = pendingMessagesRef.current;
    if (index < 0 || targetIndex < 0 || targetIndex >= current.length) return;
    const next = [...current];
    [next[index], next[targetIndex]] = [next[targetIndex]!, next[index]!];
    replacePendingMessages(next, sessionIdRef.current);
  }, [queueActionPending, replacePendingMessages]);

  const deletePendingMessage = useCallback((index: number) => {
    if (queueActionPending) return;
    const current = pendingMessagesRef.current;
    if (index < 0 || index >= current.length) return;
    replacePendingMessages(current.filter((_, pendingIndex) => pendingIndex !== index), sessionIdRef.current);
  }, [queueActionPending, replacePendingMessages]);

  const forceSendPendingMessage = useCallback((index: number) => {
    if (queueActionPending) return;
    const resolvedSessionId = sessionIdRef.current;
    if (!resolvedSessionId || !pendingMessagesRef.current[index]) return;
    const snapshot = streamSnapshotRef.current;
    if (snapshot) {
      cancelPlannerGeneration(snapshot, index);
      return;
    }
    queueDispatchRef.current?.(resolvedSessionId, index);
  }, [cancelPlannerGeneration, queueActionPending]);

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (showCommandMenu && event.key === "ArrowDown") {
      event.preventDefault();
      if (slashMenuEntries.length > 0) {
        setHighlightedCommandIndex((prev) => (prev + 1) % slashMenuEntries.length);
      }
      return;
    }

    if (showCommandMenu && event.key === "ArrowUp") {
      event.preventDefault();
      if (slashMenuEntries.length > 0) {
        setHighlightedCommandIndex((prev) => (prev === 0 ? slashMenuEntries.length - 1 : prev - 1));
      }
      return;
    }

    if (showCommandMenu && (event.key === "Enter" || event.key === "Tab") && !event.shiftKey && slashMenuEntries.length > 0) {
      event.preventDefault();
      const entryToSelect = slashMenuEntries[highlightedCommandIndex] ?? slashMenuEntries[0];
      if (entryToSelect?.kind === "command") {
        handleCommandMenuSelect(entryToSelect.command);
      } else if (entryToSelect?.kind === "snippet") {
        handleSnippetMenuSelect(entryToSelect.snippet);
      }
      return;
    }

    if (showCommandMenu && event.key === "Escape") {
      event.preventDefault();
      setShowCommandMenu(false);
      return;
    }

    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    void sendMessage();
  }, [showCommandMenu, slashMenuEntries, highlightedCommandIndex, handleCommandMenuSelect, handleSnippetMenuSelect, sendMessage]);

  const canSend = draft.trim().length > 0 && composerState !== "sending" && !queueActionPending;
  const showEmptyState = historyLoaded && !loading && !error && messages.length === 0;
  const questionRenderStates = useMemo(() => buildPlannerQuestionRenderStates(messages), [messages]);
  const starterPrompts = useMemo(() => {
    const seenLabels = new Set<string>();
    return TASK_PLANNER_CHAT_STARTER_PROMPTS.flatMap((prompt) => {
      const label = t(prompt.labelKey, prompt.labelFallback).trim();
      const message = t(prompt.messageKey, prompt.messageFallback).trim();
      if (!label || !message) return [];
      const labelKey = label.toLocaleLowerCase();
      if (seenLabels.has(labelKey)) return [];
      seenLabels.add(labelKey);
      return [{
        id: prompt.id,
        label,
        description: t(prompt.descriptionKey, prompt.descriptionFallback).trim(),
        message,
      }];
    });
  }, [t]);

  const renderPlannerToolCall = useCallback((message: ChatMessage, toolCall: ToolCallInfo, index: number) => {
    const steeringResult = extractPlannerSteeringResult(toolCall);
    if (steeringResult) {
      return (
        <div key={`${toolCall.toolName}-${index}`} className="task-planner-chat-steering-confirmation" data-testid="task-planner-chat-steering-confirmation">
          <strong>{t("taskDetail.plannerChat.steeringAdded", "Added as steering comment")}</strong>
          <p>{steeringResult.text}</p>
        </div>
      );
    }
    const refinementResult = extractPlannerRefinementResult(toolCall);
    if (refinementResult) {
      return (
        <div key={`${toolCall.toolName}-${index}`} className="task-planner-chat-steering-confirmation" data-testid="task-planner-chat-refinement-confirmation">
          <strong>{t("taskDetail.plannerChat.refinementCreated", "Created refinement task")} {refinementResult.refinementTaskId}</strong>
          {refinementResult.description && <p>{refinementResult.description}</p>}
        </div>
      );
    }
    const isRunningRefinement = toolCall.toolName === TASK_PLANNER_REFINEMENT_TOOL_NAME && toolCall.status === "running";
    if (isRunningRefinement) {
      return (
        <div key={`${toolCall.toolName}-${index}`} className="task-planner-chat-steering-confirmation task-planner-chat-steering-confirmation--pending" data-testid="task-planner-chat-refinement-pending">
          <strong>{t("taskDetail.plannerChat.refinementCreating", "Creating refinement task…")}</strong>
        </div>
      );
    }
    if (toolCall.toolName === TASK_PLANNER_REFINEMENT_TOOL_NAME && toolCall.isError) {
      return (
        <div key={`${toolCall.toolName}-${index}`} className="task-planner-chat-steering-confirmation task-planner-chat-steering-confirmation--error" role="alert" data-testid="task-planner-chat-refinement-error">
          <strong>{t("taskDetail.plannerChat.refinementFailed", "Refinement task was not created")}</strong>
        </div>
      );
    }
    const isRunningSteering = toolCall.toolName === TASK_PLANNER_STEERING_TOOL_NAME && toolCall.status === "running";
    if (isRunningSteering) {
      return (
        <div key={`${toolCall.toolName}-${index}`} className="task-planner-chat-steering-confirmation task-planner-chat-steering-confirmation--pending" data-testid="task-planner-chat-steering-pending">
          <strong>{t("taskDetail.plannerChat.steeringAdding", "Adding steering comment…")}</strong>
        </div>
      );
    }
    if (toolCall.toolName === TASK_PLANNER_STEERING_TOOL_NAME && toolCall.isError) {
      return (
        <div key={`${toolCall.toolName}-${index}`} className="task-planner-chat-steering-confirmation task-planner-chat-steering-confirmation--error" role="alert" data-testid="task-planner-chat-steering-error">
          <strong>{t("taskDetail.plannerChat.steeringFailed", "Steering comment was not added")}</strong>
        </div>
      );
    }
    const questionState = questionRenderStates.get(`${message.id}:${index}`);
    if (!questionState) return undefined;
    if (questionState.hiddenDuplicate) return null;
    return (
      <ChatQuestionResponse
        key={`${toolCall.toolName}-${index}`}
        parsed={questionState.parsed}
        answered={questionState.answered}
        submittedAnswer={questionState.submittedAnswer}
        disabled={composerState === "sending" || questionState.answered}
        compact
        onSubmit={(answerText) => void sendMessageContent(answerText)}
      />
    );
  }, [composerState, questionRenderStates, sendMessageContent, t]);

  /*
  FNXC:TaskDetailPlannerChat 2026-06-30-23:58:
  Planner Chat is a separate task-detail surface from Activity steering. It can answer from task context, offer starter prompts, ask structured follow-up questions, and convert explicit live-task operator intent into steering through the server-side planner-chat tool instead of posting every chat message as steering by default.

  FNXC:TaskDetailPlannerChat 2026-07-01-21:58:
  Done-task Planner Chat remains sendable after completion and renders model-created refinement tool results inline, but tab activation stays lookup-only and the source task id still travels only through the server-bound `task-planner:<taskId>` session and stream metadata.

  FNXC:TaskDetailChat 2026-06-30-23:59:
  When the planner steering tool succeeds, the Chat transcript must show an explicit confirmation and refresh task detail data immediately so Activity/current steering reflects the persisted comment without closing the modal. Clarification tool calls stay as questions and never insert optimistic steering bubbles.

  FNXC:TaskDetailPlannerChat 2026-06-30-23:59:
  The empty Chat tab starts with guided task-state prompts that submit ordinary user messages through the same task-context-aware planner-chat stream as the composer. Steering conversion and structured question-modal rendering remain owned by later planner-chat subtasks, so starter prompts are only message text plus accessible affordances here.

  FNXC:TaskDetailPlannerChat 2026-06-30-23:59:
  Session loads are scoped to the current task/project/model and stale responses are ignored so a delayed previous task load cannot attach starter-prompt sends to the wrong planner-chat session.

  FNXC:TaskDetailPlannerChat 2026-07-01-14:47:
  Task-detail Planner Chat must survive Activity tab switches and modal remounts by rehydrating the persisted session's in-flight generation snapshot, then reattaching to `/chat/sessions/:id/stream`. Lookup-only tab activation stays non-mutating; explicit sends remain the only path that creates a planner-chat session.

  FNXC:TaskDetailPlannerChat 2026-07-01-00:00:
  Provider failures after planner-chat stream acceptance must keep the user's visible turn because the server may have persisted it and included it in model context. Reconcile accepted optimistic rows with refreshed history, but roll back only explicit pre-acceptance failures.

  FNXC:TaskDetailPlannerChat 2026-06-30-18:20:
  Opening or switching to the task-detail Chat tab performs lookup-only history loading. Planner-chat rows are lazily created only by explicit user messages (composer sends, starter prompts, or planner-question answers), so unvisited conversations do not clutter global Chat history.

  FNXC:TaskDetailPlannerChat 2026-06-30-23:59:
  Stream callbacks are guarded by a per-send token because closing an EventSource/stream is not enough to prevent queued text, tool, done, error, or fallback refresh callbacks from mutating the newly selected task's Chat tab.

  FNXC:TaskDetailPlannerChat 2026-06-30-23:59:
  Planner-generated clarification questions in the task-detail Chat transcript must reuse ChatQuestionResponse instead of bespoke chat text. Submitted answers stay in the planner-chat lane as ordinary follow-up user messages, render the prior question read-only, and duplicate refetched pending tool calls hide older live forms so users never see competing submit affordances.

  FNXC:TaskDetailPlannerChat 2026-07-01-09:20:
  Task-detail Planner Chat must keep `fn_ask_question` actionable when streamed or persisted alongside other tools such as `bash`. The planner renderer owns task-scoped answer submission and dedupe while StandardChatSurface extracts the question card outside grouped tool-call details.

  FNXC:TaskDetailPlannerChat 2026-07-01-09:34:
  Planner Chat delegates transcript bubbles, thinking details, tool-call framing, and mobile send/stop gestures to StandardChatSurface. TaskPlannerChatTab keeps lookup-only session loading, task-context sends, starter prompts, and steering confirmations local so reuse does not collapse the lazy ChatView chunk or merge planner chat with Activity.

  FNXC:TaskDetailPlannerChat 2026-06-30-23:58:
  The planner Chat tab owns an in-view expand/collapse button so mobile users can reclaim vertical room while keeping close/back/task identity controls reachable. This state is independent from Activity Live expansion because Activity still represents operational steering/history, not planner-model conversation.
  */
  return (
    <section className={`task-planner-chat${chatMessageLayout === "full-width" ? " task-planner-chat--full-width" : ""}`} aria-label={t("taskDetail.plannerChat.label", "Task-aware chat")} data-testid="task-planner-chat-panel">
      {onExpandedChange && (
        <button
          type="button"
          className="btn btn-icon btn-sm task-planner-chat-expand-toggle task-planner-chat-expand-toggle--overlay"
          onClick={() => onExpandedChange(!expanded)}
          aria-label={expanded ? t("taskDetail.plannerChat.collapse", "Collapse task chat") : t("taskDetail.plannerChat.expand", "Expand task chat")}
          aria-pressed={expanded}
          aria-expanded={expanded}
          data-testid="task-planner-chat-expand-toggle"
        >
          {expanded ? <Minimize2 aria-hidden="true" /> : <Maximize2 aria-hidden="true" />}
        </button>
      )}
      <div className="task-planner-chat-transcript" ref={transcriptRef} onScroll={handleTranscriptScroll} data-testid="task-planner-chat-transcript">
        {error && <div className="task-planner-chat-error" role="alert">{error}</div>}
        {loading ? (
          <div className="task-planner-chat-state" role="status" aria-live="polite">
            <Loader2 className="animate-spin" aria-hidden="true" />
            <span>{t("taskDetail.plannerChat.loading", "Loading task chat…")}</span>
          </div>
        ) : showEmptyState ? (
          <div className="task-planner-chat-empty" data-testid="task-planner-chat-empty">
            {isUsableModel(displayedModel) && (
              <span
                className="task-planner-chat-empty-model"
                data-testid="task-planner-chat-model"
                title={displayedModelLabel}
                aria-label={displayedModelLabel}
              >
                <ProviderIcon provider={displayedModel.provider} size="sm" />
              </span>
            )}
            <div className="task-planner-chat-empty-copy">
              <h5>{t("taskDetail.plannerChat.emptyTitle", "Start a task-aware chat")}</h5>
              <p>{t("taskDetail.plannerChat.emptyBody", "Ask questions about this task's current status, recent activity, blockers, next steps, or definition. Starter prompts send as normal chat messages.")}</p>
            </div>
            {starterPrompts.length > 0 && (
              <div className="task-planner-chat-starters" aria-label={t("taskDetail.plannerChat.startersLabel", "Task chat starter prompts")}>
                {starterPrompts.map((prompt) => (
                  <button
                    key={prompt.id}
                    type="button"
                    className="btn task-planner-chat-starter"
                    data-testid={`task-planner-chat-starter-${prompt.id}`}
                    onClick={() => void sendMessageContent(prompt.message)}
                    disabled={composerState === "sending"}
                  >
                    <span className="task-planner-chat-starter-label">{prompt.label}</span>
                    {prompt.description && <span className="task-planner-chat-starter-description">{prompt.description}</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <>
            {messages.map((message) => {
              if (message.id === "streaming-assistant") {
                const streamingToolCalls = extractToolCalls(message);
                return (
                  <StandardStreamingMessage
                    key={message.id}
                    streamingText={message.content}
                    streamingThinking={message.thinkingOutput ?? streamingThinking}
                    streamingToolCalls={streamingToolCalls}
                    forcePlain={false}
                    agentName={t("taskDetail.plannerChat.assistant", "Task Chat")}
                    hideAssistantIdentity={false}
                    showAssistantModelTag={Boolean(activeModelTag)}
                    activeModelTag={activeModelTag}
                    activeModelProvider={displayedModelProvider ?? null}
                    activeModelId={displayedModelId ?? null}
                    toolCallRenderer={(toolCall, index) => renderPlannerToolCall(message, toolCall, index)}
                  />
                );
              }
              /*
               * FNXC:ChatMessageEdit 2026-07-07-10:15:
               * Planner Chat (task-planner:<id> synthetic session) is model-loop and reuses FN-7628's
               * rewind-and-resend path via the local editMessageAndResend orchestration above. The
               * affordance is only offered on persisted user rows (never optimistic-<ts>/
               * streaming-assistant placeholders, never assistant/system rows, and never while a
               * generation is in flight) so StandardChatMessageItem never renders a dead/no-op button.
               */
              return (
                <StandardChatMessageItem
                  key={message.id}
                  message={toStandardChatMessage(message)}
                  forcePlain={false}
                  agentName={t("taskDetail.plannerChat.assistant", "Task Chat")}
                  hideAssistantIdentity={false}
                  showAssistantModelTag={Boolean(activeModelTag)}
                  activeModelTag={activeModelTag}
                  activeModelProvider={displayedModelProvider ?? null}
                  activeModelId={displayedModelId ?? null}
                  activeSessionId={sessionId}
                  projectId={projectId}
                  isAwaitingQuestionAnswer={message.role === "assistant"}
                  onQuestionSubmit={(answerText) => void sendMessageContent(answerText)}
                  toolCallRenderer={(toolCall, index) => renderPlannerToolCall(message, toolCall, index)}
                  onEditMessage={editMessageAndResend}
                  canEdit={
                    message.role === "user"
                    && !message.id.startsWith("optimistic-")
                    && message.id !== "streaming-assistant"
                    && composerState !== "sending"
                  }
                />
              );
            })}
            {composerState === "sending" && !messages.some((message) => message.id === "streaming-assistant") && (
              <StandardStreamingMessage
                streamingText=""
                streamingThinking={streamingThinking}
                streamingToolCalls={[]}
                forcePlain={false}
                agentName={t("taskDetail.plannerChat.assistant", "Task Chat")}
                hideAssistantIdentity={false}
                showAssistantModelTag={Boolean(activeModelTag)}
                activeModelTag={activeModelTag}
                activeModelProvider={displayedModelProvider ?? null}
                activeModelId={displayedModelId ?? null}
              />
            )}
          </>
        )}
      </div>

      <PendingChatMessageQueue
        messages={pendingMessages}
        disabled={queueActionPending}
        onEdit={updatePendingMessage}
        onMove={movePendingMessage}
        onDelete={deletePendingMessage}
        onForceSend={forceSendPendingMessage}
        testIdPrefix="task-planner-chat-pending"
      />

      {showCommandMenu && (
        <div
          className="chat-skill-menu task-planner-chat-command-menu"
          data-testid="task-planner-chat-command-menu"
          role="listbox"
          aria-label={t("chat.slashSuggestions", "Slash suggestions")}
        >
          {slashMenuEntries.length === 0 ? (
            <div className="chat-skill-menu-empty">{t("chat.noSlashSuggestions", "No suggestions found")}</div>
          ) : (
            slashMenuEntries.map((entry, index) => {
              if (entry.kind === "snippet") {
                return (
                  <button
                    key={`snippet-${entry.snippet.name}`}
                    type="button"
                    role="option"
                    aria-selected={index === highlightedCommandIndex}
                    className={`chat-skill-menu-item${index === highlightedCommandIndex ? " chat-skill-menu-item--highlighted" : ""}`}
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseEnter={() => setHighlightedCommandIndex(index)}
                    onClick={() => handleSnippetMenuSelect(entry.snippet)}
                  >
                    <span className="chat-skill-menu-item-name">/{entry.snippet.name}</span>
                    <span className="chat-skill-menu-item-description">{t("chat.snippetSuggestion", "Insert saved prompt")}</span>
                  </button>
                );
              }

              /*
              FNXC:ChatMemoryFocus 2026-08-13:
              RUFU-068: disable only agent-gated commands (steer) when no agent is
              running. The /focus command is a local session-setting command and never
              appears disabled. Only the disabled item shows the no-running-agent hint so
              the focus menu entry keeps its real description.
              */
              const commandDisabled = entry.command.requiresAgent && !agentRunning;
              return (
                <button
                  key={entry.command.trigger}
                  type="button"
                  role="option"
                  aria-selected={index === highlightedCommandIndex}
                  aria-disabled={commandDisabled}
                  className={`chat-skill-menu-item chat-command-menu-item${index === highlightedCommandIndex ? " chat-skill-menu-item--highlighted" : ""}${commandDisabled ? " chat-command-menu-item--disabled" : ""}`}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setHighlightedCommandIndex(index)}
                  onClick={() => handleCommandMenuSelect(entry.command)}
                >
                  <span className="chat-skill-menu-item-name">{entry.command.trigger}</span>
                  <span className="chat-skill-menu-item-description">
                    {commandDisabled
                      ? t("chat.commandNoRunningAgentHint", "No running agent to steer")
                      : entry.command.description}
                  </span>
                </button>
              );
            })
          )}
        </div>
      )}
      {/*
      FNXC:ChatMemoryFocus 2026-08-24-04:21:
      Suppress the focus chip and its padded wrapper together until experimentalFeatures.chatFocus
      is enabled, so default-off planner chat leaves no empty composer shell.
      */}
      {chatFocusEnabled && (
        <div className="task-planner-chat-focus-row">
          <ChatFocusSelector
            sessionId={sessionId}
            projectId={projectId}
            memoryFocus={sessionMemoryFocus}
            onPersist={(focus) => setSessionMemoryFocus(focus)}
            addToast={(message, type) => addToastRef.current(message, type)}
          />
        </div>
      )}
      <div className="task-planner-chat-composer">
        <ChatThinkingLevelControl
          level={displayedModel.thinkingLevel}
          defaultThinkingLevel={taskChatModel.thinkingLevel ?? "off"}
          showTargetSection
          showAgentTarget={false}
          targetKey={plannerChatScopeKey}
          models={models}
          favoriteProviders={favoriteProviders}
          favoriteModels={favoriteModels}
          modelProvider={displayedModelProvider ?? null}
          modelId={displayedModelId ?? null}
          modelPickerLabel={t("taskDetail.plannerChat.modelLabel", "Chat model")}
          modelDefaultOptionLabel={t("models.useDefault", "Use project default")}
          defaultModelValue={taskChatModel.provider && taskChatModel.modelId ? `${taskChatModel.provider}/${taskChatModel.modelId}` : ""}
          onChange={(level) => void handleTaskChatThinkingChange(level)}
          onChangeModel={(selection) => void handleTaskChatModelChange(
            selection.modelProvider && selection.modelId ? `${selection.modelProvider}/${selection.modelId}` : "",
          )}
          disabled={queueActionPending || composerState === "sending"}
        />
        <textarea
          ref={handleComposerRef}
          className="input task-planner-chat-input"
          aria-label={t("taskDetail.plannerChat.inputLabel", "Message task chat")}
          placeholder={t("taskDetail.plannerChat.placeholder", "Ask about this task… Type / for commands")}
          value={draft}
          onChange={handleDraftChange}
          onKeyDown={handleKeyDown}
          disabled={queueActionPending}
          rows={1}
        />
        <MicButton {...dictation.micProps} disabled={queueActionPending} />
        <StandardChatActionButton
          isStreaming={composerState === "sending"}
          canSend={canSend}
          onSend={sendMessage}
          onStop={stopPlannerStreaming}
          classNameSend="btn btn-primary task-planner-chat-send chat-input-send"
          classNameStop="btn btn-primary task-planner-chat-send chat-input-stop"
          sendLabel={t("taskDetail.plannerChat.send", "Send")}
          stopLabel={t("chat.stopGeneration", "Stop generation")}
          // FNXC:TaskPlannerChat 2026-07-08-00:00: FN-7685 made the idle send button
          // icon-only (no visible "Send" text span) to match regular chat's TaskChatTab;
          // sendLabel above still feeds the button's aria-label so the accessible name
          // stays "Send" for screen readers.
          // FNXC:TaskPlannerChat 2026-07-07-00:00: planner stop button is icon-only
          // per FN-7655 — aria-label above keeps the accessible name "Stop generation".
          showStopText={false}
        />
      </div>
    </section>
  );
}
