import type { ChatInFlightGenerationState, ChatMessage, ResolvedModelSelection, Task, TaskDetail } from "@fusion/core";
import { getErrorMessage } from "@fusion/core";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Maximize2, Minimize2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ToastType } from "../hooks/useToast";
import type { ChatMessageInfo, ToolCallInfo } from "../hooks/chatTypes";
import { attachChatStream, editChatMessage, ensureTaskPlannerChatSession, fetchChatMessages, fetchChatSession, fetchTaskDetail, fetchTaskPlannerChatSession, streamChatResponse, type ChatFailureInfo, type ChatStreamErrorMeta } from "../api";
import { parseQuestionToolCall, type ParsedQuestionToolCall } from "../utils/parseQuestionToolCall";
import { ChatQuestionResponse } from "./ChatQuestionResponse";
import { ProviderIcon } from "./ProviderIcon";
import { StandardChatActionButton, StandardChatMessageItem, StandardStreamingMessage, formatModelTag } from "./StandardChatSurface";
import { CHAT_COMMANDS, filterChatCommands, getSlashTriggerMatch, matchChatCommand, type ChatCommand } from "./chat-commands";
import "./TaskPlannerChatTab.css";

interface TaskPlannerChatTabProps {
  task: Task | TaskDetail;
  projectId?: string;
  active: boolean;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  planningModel: ResolvedModelSelection;
  addToast: (msg: string, type?: ToastType) => void;
  onTaskUpdated?: (task: Task) => void;
}

type ComposerState = "idle" | "sending";

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
  return {
    id: message.id,
    sessionId: message.sessionId,
    role: message.role,
    content: message.content,
    thinkingOutput: message.thinkingOutput,
    toolCalls: extractToolCalls(message),
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

export function TaskPlannerChatTab({ task, projectId, active, expanded = false, onExpandedChange, planningModel, addToast, onTaskUpdated }: TaskPlannerChatTabProps) {
  const { t } = useTranslation("app");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
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
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const loadRequestRef = useRef(0);
  const streamRequestRef = useRef(0);
  const addToastRef = useRef(addToast);
  const onTaskUpdatedRef = useRef(onTaskUpdated);

  useEffect(() => {
    addToastRef.current = addToast;
    onTaskUpdatedRef.current = onTaskUpdated;
  }, [addToast, onTaskUpdated]);

  const planningModelProvider = isUsableModel(planningModel) ? planningModel.provider : undefined;
  const planningModelId = isUsableModel(planningModel) ? planningModel.modelId : undefined;
  const planningModelLabel = planningModelProvider && planningModelId ? `${planningModelProvider}/${planningModelId}` : "";
  const activeModelTag = formatModelTag(planningModelProvider, planningModelId);
  const modelPayload = useMemo(() => {
    return planningModelProvider && planningModelId
      ? { modelProvider: planningModelProvider, modelId: planningModelId }
      : {};
  }, [planningModelId, planningModelProvider]);
  const plannerChatScopeKey = `${task.id}\u0000${projectId ?? ""}\u0000${planningModelProvider ?? ""}\u0000${planningModelId ?? ""}`;

  /*
   * FNXC:TaskPlannerChatSlashCommands 2026-07-08-00:00:
   * /steer is only dispatchable when this task's bound agent is actively
   * running (task.column === "in-progress"), mirroring how TaskChatTab gates
   * its own done-task affordance on task.column. Any other state (todo,
   * in-review, done, archived, triage) shows the command in the menu but
   * disabled with a hint instead of hiding it outright, and dispatch itself
   * is refused with the same hint rather than silently sending plain chat.
   */
  const agentRunning = task.column === "in-progress";
  const filteredCommands = useMemo(() => filterChatCommands(commandFilter, CHAT_COMMANDS), [commandFilter]);

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
      const message = getErrorMessage(refreshError) || t("taskDetail.plannerChat.loadFailed", "Failed to load planner chat");
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
  }) => {
    const { resolvedSessionId, content = "", inFlightGeneration, requestId, attach } = options;
    const isCurrentStreamRequest = () => streamRequestRef.current === requestId;
    let accumulated = inFlightGeneration?.streamingText ?? "";
    let accumulatedThinking = inFlightGeneration?.streamingThinking ?? "";
    const streamingToolCalls = cloneToolCalls(inFlightGeneration?.toolCalls);

    streamRef.current?.close();
    if (!isCurrentStreamRequest()) return;

    composerStateRef.current = "sending";
    setComposerState("sending");
    setError(null);
    applyStreamingSnapshot(resolvedSessionId, accumulated, accumulatedThinking, streamingToolCalls);

    const handlers = {
      onText: (delta: string) => {
        if (!isCurrentStreamRequest()) return;
        accumulated += delta;
        applyStreamingSnapshot(resolvedSessionId, accumulated, accumulatedThinking, streamingToolCalls);
      },
      onThinking: (delta: string) => {
        if (!isCurrentStreamRequest()) return;
        accumulatedThinking += delta;
        applyStreamingSnapshot(resolvedSessionId, accumulated, accumulatedThinking, streamingToolCalls);
      },
      onToolStart: ({ toolName, args }: { toolName: string; args?: Record<string, unknown> }) => {
        if (!isCurrentStreamRequest()) return;
        streamingToolCalls.push({ toolName, args, isError: false, status: "running" });
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
        applyStreamingSnapshot(resolvedSessionId, accumulated, accumulatedThinking, streamingToolCalls);
      },
      onDone: (data: { messageId: string; message?: ChatMessage }) => {
        if (!isCurrentStreamRequest()) return;
        composerStateRef.current = "idle";
        setComposerState("idle");
        setStreamingThinking("");
        streamRef.current = null;
        if (data.message) {
          setMessages((current) => {
            const withoutTemporary = current.filter((message) => message.id !== "streaming-assistant");
            return sortMessages([...withoutTemporary, data.message!]);
          });
        } else {
          void refreshMessagesForSession(resolvedSessionId, isCurrentStreamRequest, { mergeOptimistic: Boolean(content) });
        }
      },
      onError: (streamError: string | ChatFailureInfo, meta?: ChatStreamErrorMeta) => {
        if (!isCurrentStreamRequest()) return;
        const message = normalizeChatFailureSummary(streamError, t("taskDetail.plannerChat.sendFailed", "Planner chat failed to respond"));
        setError(message);
        composerStateRef.current = "idle";
        setComposerState("idle");
        setStreamingThinking("");
        streamRef.current = null;
        setMessages((current) => {
          const withoutStreaming = current.filter((candidate) => candidate.id !== "streaming-assistant");
          if (meta?.requestAccepted === false && content) {
            return withoutStreaming.filter((candidate) => !(candidate.role === "user" && candidate.id.startsWith("optimistic-") && candidate.content.trim() === content.trim()));
          }
          return withoutStreaming;
        });
        if (meta?.requestAccepted === false) return;
        void refreshMessagesForSession(resolvedSessionId, isCurrentStreamRequest, { mergeOptimistic: Boolean(content) });
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
          { taskId: task.id },
        );
  }, [applyStreamingSnapshot, projectId, refreshMessagesForSession, refreshTaskAfterSteering, task.id, t]);

  const loadSession = useCallback(async () => {
    const requestId = loadRequestRef.current + 1;
    loadRequestRef.current = requestId;
    setLoading(true);
    setHistoryLoaded(false);
    setError(null);
    try {
      const { session: lookupSession } = await fetchTaskPlannerChatSession(task.id, modelPayload, projectId);
      if (loadRequestRef.current !== requestId) return;
      if (!lookupSession) {
        setSessionId(null);
        setMessages([]);
        setHistoryLoaded(true);
        return;
      }
      setSessionId(lookupSession.id);
      const [{ messages: loadedMessages }, refreshedSessionResult] = await Promise.all([
        fetchChatMessages(lookupSession.id, { order: "asc" }, projectId),
        fetchChatSession(lookupSession.id, projectId).catch(() => ({ session: lookupSession })),
      ]);
      if (loadRequestRef.current !== requestId) return;
      const resolvedSession = refreshedSessionResult.session;
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
      }
    } catch (err) {
      if (loadRequestRef.current !== requestId) return;
      const message = getErrorMessage(err) || t("taskDetail.plannerChat.loadFailed", "Failed to load planner chat");
      setError(message);
      setHistoryLoaded(false);
    } finally {
      if (loadRequestRef.current === requestId) {
        setLoading(false);
      }
    }
  }, [modelPayload, projectId, startPlannerStream, task.id, t]);

  useEffect(() => {
    loadRequestRef.current += 1;
    streamRequestRef.current += 1;
    streamRef.current?.close();
    streamRef.current = null;
    setSessionId(null);
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

  useEffect(() => {
    if (!transcriptRef.current) return;
    if (messages.length === 0) {
      transcriptRef.current.scrollTop = 0;
      return;
    }
    transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
  }, [messages, composerState]);

  const sendMessageContent = useCallback(async (messageContent: string) => {
    const content = messageContent.trim();
    if (!content || composerStateRef.current === "sending") return;
    composerStateRef.current = "sending";

    const streamRequestId = streamRequestRef.current + 1;
    streamRequestRef.current = streamRequestId;
    const isCurrentStreamRequest = () => streamRequestRef.current === streamRequestId;

    setDraft("");
    setComposerState("sending");
    setError(null);

    try {
      const { session } = sessionId
        ? { session: { id: sessionId } }
        : await ensureTaskPlannerChatSession(task.id, modelPayload, projectId);
      if (!isCurrentStreamRequest()) return;
      const resolvedSessionId = session.id;
      setSessionId(resolvedSessionId);
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
      const message = getErrorMessage(err) || t("taskDetail.plannerChat.sendFailed", "Planner chat failed to respond");
      setError(message);
      addToast(message, "error");
      composerStateRef.current = "idle";
      setComposerState("idle");
      setStreamingThinking("");
    }
  }, [addToast, modelPayload, projectId, sessionId, startPlannerStream, task.id, t]);

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
   * FNXC:TaskDetailPlannerChat 2026-07-07-10:15:
   * Editing an earlier Planner Chat message resumes the conversation from that point and forgets
   * everything after it — both the persisted rows (via editChatMessage's server-side truncation)
   * and the pi session context (via ChatManager.rewindSessionForEdit, reused unmodified from
   * FN-7628). Product decision for already-applied task-scoped side effects: discarded turns may
   * have already run fn_task_planner_add_steering (persisted a steering comment) or
   * fn_task_planner_create_refinement (created a real task). Reverting those is destructive and
   * out of scope here, so this task deliberately does NOT attempt to undo them — the steering
   * comment stays on the task and the refinement task stays open. Instead, after a successful
   * edit-and-resend we refresh task detail (so Activity/steering reflects reality) and, only when
   * the discarded range contained a steering/refinement tool result, surface an informational
   * toast so the user is not misled into thinking those changes were reverted.
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

    // Optimistic truncation: drop the edited message and everything after it immediately,
    // matching the server's index-based truncation semantics (not just a timestamp filter).
    setMessages((current) => current.slice(0, targetIndex));

    try {
      await editChatMessage(resolvedSessionId, messageId, trimmed, projectId);
    } catch (err) {
      const message = getErrorMessage(err) || t("taskDetail.plannerChat.editFailed", "Failed to edit planner chat message");
      setError(message);
      addToastRef.current(message, "error");
      // Restore truthful state from the server rather than trusting the optimistic truncation.
      void refreshMessagesForSession(resolvedSessionId, () => true);
      return;
    }

    await sendMessageContent(trimmed);
    await refreshTaskAfterEdit(hadDiscardedSideEffect);
  }, [messages, projectId, refreshMessagesForSession, refreshTaskAfterEdit, sendMessageContent, sessionId, t]);

  const dispatchSlashCommand = useCallback(async (command: ChatCommand, remainder: string) => {
    if (!agentRunning) {
      // Do not silently fall back to a normal chat message: /steer with no
      // running agent is a no-op with feedback, not a plain send.
      addToastRef.current(t("taskDetail.plannerChat.commandNoRunningAgent", "No running agent to steer"), "warning");
      return;
    }

    try {
      await command.run({ taskId: task.id, projectId, remainder });
      setDraft("");
      // Reuse the existing steering-refresh path (same toast + task refresh already
      // used by the tool-call-driven steering flow above) instead of a second,
      // divergent success toast for the same underlying action.
      await refreshTaskAfterSteering();
    } catch (err) {
      const message = getErrorMessage(err) || t("taskDetail.plannerChat.commandSteerFailed", "Failed to send to the running agent");
      addToastRef.current(message, "error");
    }
  }, [agentRunning, projectId, refreshTaskAfterSteering, t, task.id]);

  const handleCommandMenuSelect = useCallback((command: ChatCommand) => {
    if (!agentRunning) {
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

  const sendMessage = useCallback(() => {
    const trimmed = draft.trim();
    const commandMatch = matchChatCommand(trimmed, CHAT_COMMANDS);
    if (commandMatch) {
      setShowCommandMenu(false);
      return dispatchSlashCommand(commandMatch.command, commandMatch.remainder);
    }
    return sendMessageContent(draft);
  }, [draft, dispatchSlashCommand, sendMessageContent]);

  const handleDraftChange = useCallback((event: React.ChangeEvent<HTMLTextAreaElement>) => {
    const nextValue = event.target.value;
    setDraft(nextValue);

    const triggerMatch = getSlashTriggerMatch(nextValue);
    if (triggerMatch) {
      setShowCommandMenu(true);
      setCommandFilter(triggerMatch.filter);
    } else {
      setShowCommandMenu(false);
      setCommandFilter("");
    }
  }, []);

  const stopPlannerStreaming = useCallback(() => {
    streamRequestRef.current += 1;
    streamRef.current?.close();
    streamRef.current = null;
    composerStateRef.current = "idle";
    setComposerState("idle");
    setStreamingThinking("");
    setMessages((current) => current.filter((message) => message.id !== "streaming-assistant"));
  }, []);

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (showCommandMenu && event.key === "ArrowDown") {
      event.preventDefault();
      if (filteredCommands.length > 0) {
        setHighlightedCommandIndex((prev) => (prev + 1) % filteredCommands.length);
      }
      return;
    }

    if (showCommandMenu && event.key === "ArrowUp") {
      event.preventDefault();
      if (filteredCommands.length > 0) {
        setHighlightedCommandIndex((prev) => (prev === 0 ? filteredCommands.length - 1 : prev - 1));
      }
      return;
    }

    if (showCommandMenu && (event.key === "Enter" || event.key === "Tab") && !event.shiftKey && filteredCommands.length > 0) {
      event.preventDefault();
      const commandToSelect = filteredCommands[highlightedCommandIndex] ?? filteredCommands[0];
      if (commandToSelect) {
        handleCommandMenuSelect(commandToSelect);
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
  }, [showCommandMenu, filteredCommands, highlightedCommandIndex, handleCommandMenuSelect, sendMessage]);

  const canSend = draft.trim().length > 0 && composerState !== "sending";
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
    <section className="task-planner-chat" aria-label={t("taskDetail.plannerChat.label", "Planner chat")} data-testid="task-planner-chat-panel">
      {onExpandedChange && (
        <button
          type="button"
          className="btn btn-icon btn-sm task-planner-chat-expand-toggle task-planner-chat-expand-toggle--overlay"
          onClick={() => onExpandedChange(!expanded)}
          aria-label={expanded ? t("taskDetail.plannerChat.collapse", "Collapse planner chat") : t("taskDetail.plannerChat.expand", "Expand planner chat")}
          aria-pressed={expanded}
          aria-expanded={expanded}
          data-testid="task-planner-chat-expand-toggle"
        >
          {expanded ? <Minimize2 aria-hidden="true" /> : <Maximize2 aria-hidden="true" />}
        </button>
      )}
      <div className="task-planner-chat-transcript" ref={transcriptRef} data-testid="task-planner-chat-transcript">
        {error && <div className="task-planner-chat-error" role="alert">{error}</div>}
        {loading ? (
          <div className="task-planner-chat-state" role="status" aria-live="polite">
            <Loader2 className="animate-spin" aria-hidden="true" />
            <span>{t("taskDetail.plannerChat.loading", "Loading planner chat…")}</span>
          </div>
        ) : showEmptyState ? (
          <div className="task-planner-chat-empty" data-testid="task-planner-chat-empty">
            {isUsableModel(planningModel) && (
              <span
                className="task-planner-chat-empty-model"
                data-testid="task-planner-chat-model"
                title={planningModelLabel}
                aria-label={planningModelLabel}
              >
                <ProviderIcon provider={planningModel.provider} size="sm" />
              </span>
            )}
            <div className="task-planner-chat-empty-copy">
              <h5>{t("taskDetail.plannerChat.emptyTitle", "Start a task-aware chat")}</h5>
              <p>{t("taskDetail.plannerChat.emptyBody", "Ask planning questions about this task's current status, recent activity, blockers, next steps, or definition. Starter prompts send as normal chat messages.")}</p>
            </div>
            {starterPrompts.length > 0 && (
              <div className="task-planner-chat-starters" aria-label={t("taskDetail.plannerChat.startersLabel", "Planner chat starter prompts")}>
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
                    agentName={t("taskDetail.plannerChat.assistant", "Planner")}
                    hideAssistantIdentity={false}
                    showAssistantModelTag={Boolean(activeModelTag)}
                    activeModelTag={activeModelTag}
                    activeModelProvider={planningModelProvider ?? null}
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
                  agentName={t("taskDetail.plannerChat.assistant", "Planner")}
                  hideAssistantIdentity={false}
                  showAssistantModelTag={Boolean(activeModelTag)}
                  activeModelTag={activeModelTag}
                  activeModelProvider={planningModelProvider ?? null}
                  activeSessionId={sessionId}
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
                agentName={t("taskDetail.plannerChat.assistant", "Planner")}
                hideAssistantIdentity={false}
                showAssistantModelTag={Boolean(activeModelTag)}
                activeModelTag={activeModelTag}
                activeModelProvider={planningModelProvider ?? null}
              />
            )}
          </>
        )}
      </div>

      {showCommandMenu && (
        <div
          className="chat-skill-menu task-planner-chat-command-menu"
          data-testid="task-planner-chat-command-menu"
          role="listbox"
          aria-label={t("chat.skillSuggestions", "Skill suggestions")}
        >
          {filteredCommands.length === 0 ? (
            <div className="chat-skill-menu-empty">{t("chat.noSkillsFound", "No skills found")}</div>
          ) : (
            filteredCommands.map((command, index) => (
              <button
                key={command.trigger}
                type="button"
                role="option"
                aria-selected={index === highlightedCommandIndex}
                aria-disabled={!agentRunning}
                className={`chat-skill-menu-item chat-command-menu-item${index === highlightedCommandIndex ? " chat-skill-menu-item--highlighted" : ""}${!agentRunning ? " chat-command-menu-item--disabled" : ""}`}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setHighlightedCommandIndex(index)}
                onClick={() => handleCommandMenuSelect(command)}
              >
                <span className="chat-skill-menu-item-name">{command.trigger}</span>
                <span className="chat-skill-menu-item-description">
                  {agentRunning
                    ? command.description
                    : t("chat.commandNoRunningAgentHint", "No running agent to steer")}
                </span>
              </button>
            ))
          )}
        </div>
      )}
      <div className="task-planner-chat-composer">
        <textarea
          className="input task-planner-chat-input"
          aria-label={t("taskDetail.plannerChat.inputLabel", "Message planner chat")}
          placeholder={t("taskDetail.plannerChat.placeholder", "Ask the planner about this task… Type / for commands")}
          value={draft}
          onChange={handleDraftChange}
          onKeyDown={handleKeyDown}
          disabled={composerState === "sending"}
          rows={1}
        />
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
