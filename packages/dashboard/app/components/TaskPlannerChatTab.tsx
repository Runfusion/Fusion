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
  const [error, setError] = useState<string | null>(null);
  const streamRef = useRef<{ close: () => void } | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);

  const modelPayload = useMemo(() => {
    return isUsableModel(planningModel)
      ? { modelProvider: planningModel.provider, modelId: planningModel.modelId }
      : {};
  }, [planningModel]);

  const loadSession = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { session } = await ensureTaskPlannerChatSession(task.id, modelPayload, projectId);
      setSessionId(session.id);
      const { messages: loadedMessages } = await fetchChatMessages(session.id, { order: "asc" }, projectId);
      setMessages(sortMessages(loadedMessages));
    } catch (err) {
      const message = getErrorMessage(err) || t("taskDetail.plannerChat.loadFailed", "Failed to load planner chat");
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [modelPayload, projectId, task.id, t]);

  useEffect(() => {
    if (!active) return;
    void loadSession();
  }, [active, loadSession]);

  useEffect(() => {
    return () => {
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

    setDraft("");
    setComposerState("sending");
    setError(null);

    try {
      const { session } = sessionId
        ? { session: { id: sessionId } }
        : await ensureTaskPlannerChatSession(task.id, modelPayload, projectId);
      const resolvedSessionId = session.id;
      setSessionId(resolvedSessionId);
      setMessages((current) => [...current, makeOptimisticUserMessage(resolvedSessionId, content)]);
      let accumulated = "";
      const streamingToolCalls: ToolCallInfo[] = [];

      streamRef.current?.close();
      streamRef.current = streamChatResponse(
        resolvedSessionId,
        content,
        {
          onText: (delta) => {
            accumulated += delta;
            setMessages((current) => {
              const withoutStreaming = current.filter((message) => message.id !== "streaming-assistant");
              return [...withoutStreaming, makeStreamingAssistantMessage(resolvedSessionId, accumulated, streamingToolCalls)];
            });
          },
          onToolStart: ({ toolName, args }) => {
            streamingToolCalls.push({ toolName, args, isError: false, status: "running" });
            setMessages((current) => {
              const withoutStreaming = current.filter((message) => message.id !== "streaming-assistant");
              return [...withoutStreaming, makeStreamingAssistantMessage(resolvedSessionId, accumulated, streamingToolCalls)];
            });
          },
          onToolEnd: ({ toolName, isError, result }) => {
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
            setComposerState("idle");
            streamRef.current = null;
            if (data.message) {
              setMessages((current) => {
                const withoutTemporary = current.filter((message) => message.id !== "streaming-assistant");
                return sortMessages([...withoutTemporary, data.message!]);
              });
            } else {
              void fetchChatMessages(resolvedSessionId, { order: "asc" }, projectId).then(({ messages: refreshed }) => {
                setMessages(sortMessages(refreshed));
              });
            }
          },
          onError: (streamError) => {
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
  const starterPrompts = useMemo(() => [
    t("taskDetail.plannerChat.starterStatus", "What is the current state of this task?"),
    t("taskDetail.plannerChat.starterNext", "What should happen next?"),
    t("taskDetail.plannerChat.starterRisk", "What risks or dependencies should I watch?"),
    t("taskDetail.plannerChat.starterSteer", "Help me turn this into clear steering for the executor."),
  ], [t]);

  /*
  FNXC:TaskDetailPlannerChat 2026-06-30-23:58:
  Planner Chat is a separate task-detail surface from Activity steering. It can answer from task context, offer starter prompts, ask structured follow-up questions, and convert explicit operator intent into steering through the server-side planner-chat tool instead of posting every chat message as steering by default.
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
        ) : messages.length === 0 ? (
          <div className="task-planner-chat-empty" data-testid="task-planner-chat-empty">
            <p>{t("taskDetail.plannerChat.empty", "No planner-chat messages yet.")}</p>
            <div className="task-planner-chat-starters" aria-label={t("taskDetail.plannerChat.startersLabel", "Planner chat starter prompts")}>
              {starterPrompts.map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  className="btn task-planner-chat-starter"
                  onClick={() => void sendMessageContent(prompt)}
                  disabled={composerState === "sending"}
                >
                  {prompt}
                </button>
              ))}
            </div>
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
