import type { ChatMessage, ResolvedModelSelection, Task, TaskDetail } from "@fusion/core";
import { getErrorMessage } from "@fusion/core";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Loader2, Send } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ToastType } from "../hooks/useToast";
import type { ToolCallInfo } from "../hooks/chatTypes";
import { ensureTaskPlannerChatSession, fetchChatMessages, streamChatResponse } from "../api";
import { parseQuestionToolCall } from "../utils/parseQuestionToolCall";
import { markdownComponents } from "./AgentLogViewer";
import { ChatQuestionResponse } from "./ChatQuestionResponse";
import "./TaskPlannerChatTab.css";

interface TaskPlannerChatTabProps {
  task: Task | TaskDetail;
  projectId?: string;
  active: boolean;
  planningModel: ResolvedModelSelection;
  addToast: (msg: string, type?: ToastType) => void;
}

type ComposerState = "idle" | "sending";

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

function makeStreamingAssistantMessage(sessionId: string, content: string, toolCalls: ToolCallInfo[] = []): ChatMessage {
  return {
    id: "streaming-assistant",
    sessionId,
    role: "assistant",
    content,
    thinkingOutput: null,
    metadata: { streaming: true, ...(toolCalls.length > 0 ? { toolCalls } : {}) },
    createdAt: new Date().toISOString(),
  };
}

function extractToolCalls(message: ChatMessage): ToolCallInfo[] {
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

export function TaskPlannerChatTab({ task, projectId, active, planningModel, addToast }: TaskPlannerChatTabProps) {
  const { t } = useTranslation("app");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [composerState, setComposerState] = useState<ComposerState>("idle");
  const [loading, setLoading] = useState(false);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const streamRef = useRef<{ close: () => void } | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const loadRequestRef = useRef(0);
  const streamRequestRef = useRef(0);

  const planningModelProvider = isUsableModel(planningModel) ? planningModel.provider : undefined;
  const planningModelId = isUsableModel(planningModel) ? planningModel.modelId : undefined;
  const modelPayload = useMemo(() => {
    return planningModelProvider && planningModelId
      ? { modelProvider: planningModelProvider, modelId: planningModelId }
      : {};
  }, [planningModelId, planningModelProvider]);
  const plannerChatScopeKey = `${task.id}\u0000${projectId ?? ""}\u0000${planningModelProvider ?? ""}\u0000${planningModelId ?? ""}`;

  const loadSession = useCallback(async () => {
    const requestId = loadRequestRef.current + 1;
    loadRequestRef.current = requestId;
    setLoading(true);
    setHistoryLoaded(false);
    setError(null);
    try {
      const { session } = await ensureTaskPlannerChatSession(task.id, modelPayload, projectId);
      if (loadRequestRef.current !== requestId) return;
      setSessionId(session.id);
      const { messages: loadedMessages } = await fetchChatMessages(session.id, { order: "asc" }, projectId);
      if (loadRequestRef.current !== requestId) return;
      setMessages(sortMessages(loadedMessages));
      setHistoryLoaded(true);
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
  }, [modelPayload, projectId, task.id, t]);

  useEffect(() => {
    loadRequestRef.current += 1;
    streamRequestRef.current += 1;
    streamRef.current?.close();
    streamRef.current = null;
    setSessionId(null);
    setMessages([]);
    setDraft("");
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
    transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
  }, [messages, composerState]);

  const sendMessageContent = useCallback(async (messageContent: string) => {
    const content = messageContent.trim();
    if (!content || composerState === "sending") return;

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
      let accumulated = "";
      const streamingToolCalls: ToolCallInfo[] = [];

      streamRef.current?.close();
      if (!isCurrentStreamRequest()) return;
      streamRef.current = streamChatResponse(
        resolvedSessionId,
        content,
        {
          onText: (delta) => {
            if (!isCurrentStreamRequest()) return;
            accumulated += delta;
            setMessages((current) => {
              const withoutStreaming = current.filter((message) => message.id !== "streaming-assistant");
              return [...withoutStreaming, makeStreamingAssistantMessage(resolvedSessionId, accumulated, streamingToolCalls)];
            });
          },
          onToolStart: ({ toolName, args }) => {
            if (!isCurrentStreamRequest()) return;
            streamingToolCalls.push({ toolName, args, isError: false, status: "running" });
            setMessages((current) => {
              const withoutStreaming = current.filter((message) => message.id !== "streaming-assistant");
              return [...withoutStreaming, makeStreamingAssistantMessage(resolvedSessionId, accumulated, streamingToolCalls)];
            });
          },
          onToolEnd: ({ toolName, isError, result }) => {
            if (!isCurrentStreamRequest()) return;
            const running = [...streamingToolCalls].reverse().find((toolCall) => toolCall.toolName === toolName && toolCall.status === "running");
            if (running) {
              running.status = "completed";
              running.isError = isError;
              running.result = result;
            } else {
              streamingToolCalls.push({ toolName, isError, result, status: "completed" });
            }
            setMessages((current) => {
              const withoutStreaming = current.filter((message) => message.id !== "streaming-assistant");
              return [...withoutStreaming, makeStreamingAssistantMessage(resolvedSessionId, accumulated, streamingToolCalls)];
            });
          },
          onDone: (data) => {
            if (!isCurrentStreamRequest()) return;
            setComposerState("idle");
            streamRef.current = null;
            if (data.message) {
              setMessages((current) => {
                const withoutTemporary = current.filter((message) => message.id !== "streaming-assistant");
                return sortMessages([...withoutTemporary, data.message!]);
              });
            } else {
              void fetchChatMessages(resolvedSessionId, { order: "asc" }, projectId)
                .then(({ messages: refreshed }) => {
                  if (!isCurrentStreamRequest()) return;
                  setMessages(sortMessages(refreshed));
                })
                .catch((refreshError) => {
                  if (!isCurrentStreamRequest()) return;
                  const message = getErrorMessage(refreshError) || t("taskDetail.plannerChat.loadFailed", "Failed to load planner chat");
                  setError(message);
                  addToast(message, "error");
                });
            }
          },
          onError: (streamError) => {
            if (!isCurrentStreamRequest()) return;
            const message = typeof streamError === "string" ? streamError : streamError.summary;
            setError(message || t("taskDetail.plannerChat.sendFailed", "Planner chat failed to respond"));
            setComposerState("idle");
            streamRef.current = null;
          },
        },
        undefined,
        projectId,
      );
    } catch (err) {
      if (!isCurrentStreamRequest()) return;
      const message = getErrorMessage(err) || t("taskDetail.plannerChat.sendFailed", "Planner chat failed to respond");
      setError(message);
      addToast(message, "error");
      setComposerState("idle");
    }
  }, [addToast, composerState, modelPayload, projectId, sessionId, task.id, t]);

  const sendMessage = useCallback(() => sendMessageContent(draft), [draft, sendMessageContent]);

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    void sendMessage();
  }, [sendMessage]);

  const canSend = draft.trim().length > 0 && composerState !== "sending";
  const showEmptyState = historyLoaded && !loading && !error && messages.length === 0;
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

  /*
  FNXC:TaskDetailPlannerChat 2026-06-30-23:58:
  Planner Chat is a separate task-detail surface from Activity steering. It can answer from task context, offer starter prompts, ask structured follow-up questions, and convert explicit operator intent into steering through the server-side planner-chat tool instead of posting every chat message as steering by default.

  FNXC:TaskDetailPlannerChat 2026-06-30-23:59:
  The empty Chat tab starts with guided task-state prompts that submit ordinary user messages through the same planner-chat stream as the composer. Context enrichment, steering conversion, and structured question rendering remain owned by later planner-chat subtasks, so starter prompts are only message text plus accessible affordances here.

  FNXC:TaskDetailPlannerChat 2026-06-30-23:59:
  Session loads are scoped to the current task/project/model and stale responses are ignored so a delayed previous task load cannot attach starter-prompt sends to the wrong planner-chat session.

  FNXC:TaskDetailPlannerChat 2026-06-30-23:59:
  Stream callbacks are guarded by a per-send token because closing an EventSource/stream is not enough to prevent queued text, tool, done, error, or fallback refresh callbacks from mutating the newly selected task's Chat tab.
  */
  return (
    <section className="task-planner-chat" aria-label={t("taskDetail.plannerChat.label", "Planner chat")} data-testid="task-planner-chat-panel">
      <div className="task-planner-chat-header">
        <div>
          <h4>{t("taskDetail.plannerChat.heading", "Planner Chat")}</h4>
          <p>{t("taskDetail.plannerChat.description", "Ask planning questions about this task, clarify next steps, or request steering for the executor.")}</p>
        </div>
        {isUsableModel(planningModel) && (
          <span className="task-planner-chat-model" data-testid="task-planner-chat-model">
            {planningModel.provider}/{planningModel.modelId}
          </span>
        )}
      </div>

      {error && <div className="task-planner-chat-error" role="alert">{error}</div>}

      <div className="task-planner-chat-transcript" ref={transcriptRef} data-testid="task-planner-chat-transcript">
        {loading ? (
          <div className="task-planner-chat-state" role="status" aria-live="polite">
            <Loader2 className="animate-spin" aria-hidden="true" />
            <span>{t("taskDetail.plannerChat.loading", "Loading planner chat…")}</span>
          </div>
        ) : showEmptyState ? (
          <div className="task-planner-chat-empty" data-testid="task-planner-chat-empty">
            <div className="task-planner-chat-empty-copy">
              <h5>{t("taskDetail.plannerChat.emptyTitle", "Start a task-aware chat")}</h5>
              <p>{t("taskDetail.plannerChat.emptyBody", "Ask the planner about current status, recent activity, next actions, or the task definition. Starter prompts send as normal chat messages.")}</p>
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
          messages.map((message) => {
            const toolCalls = extractToolCalls(message);
            return (
              <article key={message.id} className={`task-planner-chat-message task-planner-chat-message--${message.role}`} data-testid={`task-planner-chat-message-${message.role}`}>
                <div className="task-planner-chat-message-role">
                  {message.role === "user" ? t("taskDetail.plannerChat.user", "You") : t("taskDetail.plannerChat.assistant", "Planner")}
                </div>
                {message.content && (
                  <div className="task-planner-chat-message-content markdown-body">
                    <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{message.content}</ReactMarkdown>
                  </div>
                )}
                {toolCalls.map((toolCall, index) => {
                  const parsedQuestion = parseQuestionToolCall(toolCall);
                  if (!parsedQuestion) return null;
                  const answered = message.id !== "streaming-assistant" && message !== messages[messages.length - 1];
                  return (
                    <ChatQuestionResponse
                      key={`${toolCall.toolName}-${index}`}
                      parsed={parsedQuestion}
                      answered={answered}
                      disabled={composerState === "sending" || answered}
                      compact
                      onSubmit={(answerText) => void sendMessageContent(answerText)}
                    />
                  );
                })}
              </article>
            );
          })
        )}
      </div>

      <div className="task-planner-chat-composer">
        <textarea
          className="input task-planner-chat-input"
          aria-label={t("taskDetail.plannerChat.inputLabel", "Message planner chat")}
          placeholder={t("taskDetail.plannerChat.placeholder", "Ask the planner about this task…")}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={handleKeyDown}
          disabled={composerState === "sending"}
        />
        <button type="button" className="btn btn-primary task-planner-chat-send" onClick={() => void sendMessage()} disabled={!canSend}>
          {composerState === "sending" ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Send aria-hidden="true" />}
          <span>{composerState === "sending" ? t("taskDetail.plannerChat.sending", "Sending") : t("taskDetail.plannerChat.send", "Send")}</span>
        </button>
      </div>
    </section>
  );
}
