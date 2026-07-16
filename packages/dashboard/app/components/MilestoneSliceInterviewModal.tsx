import { useState, useCallback, useEffect, useRef, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import type { PlanningQuestion } from "@fusion/core";
import { getErrorMessage } from "@fusion/core";
import {
  startMilestoneInterview,
  startSliceInterview,
  respondToMilestoneInterview,
  respondToSliceInterview,
  connectMilestoneInterviewStream,
  connectSliceInterviewStream,
  applyMilestoneInterview,
  applySliceInterview,
  skipMilestoneInterview,
  skipSliceInterview,
  fetchAiSession,
  parseConversationHistory,
  type TargetInterviewSummary,
} from "../api";
import {
  X,
  Loader2,
  CheckCircle,
  ArrowRight,
  Sparkles,
  ChevronRight,
  ChevronDown,
  Minimize2,
} from "lucide-react";
import { ConversationHistory } from "./ConversationHistory";
import { useAiSessionSync } from "../hooks/useAiSessionSync";
import { useMobileKeyboard } from "../hooks/useMobileKeyboard";
import { useMobileScrollLock } from "../hooks/useMobileScrollLock";
import { useViewportMode } from "../hooks/useViewportMode";

const WARNING_ICON = "⚠️";
const MILESTONE_SLICE_OTHER_RESPONSE_KEY = "_other";
const MILESTONE_SLICE_OTHER_OPTION_ID = "__other__";

interface MilestoneSliceInterviewModalProps {
  isOpen: boolean;
  onClose: () => void;
  onApplied: () => void;
  targetType: "milestone" | "slice";
  targetId: string;
  targetTitle: string;
  missionContext?: string;
  projectId?: string;
  /** Resume a session from background (fetches session and restores state) */
  resumeSessionId?: string;
}

interface QuestionResponse {
  [key: string]: unknown;
}

interface ConversationHistoryEntry {
  question?: PlanningQuestion;
  response?: Record<string, unknown>;
  thinkingOutput?: string;
}

type ViewState =
  | { type: "initial" }
  | { type: "loading" }
  | { type: "question"; sessionId: string; question: PlanningQuestion }
  | { type: "summary"; sessionId: string; summary: TargetInterviewSummary }
  | { type: "applied" }
  | { type: "error"; sessionId: string; errorMessage: string };

export function MilestoneSliceInterviewModal({
  isOpen,
  onClose,
  onApplied,
  targetType,
  targetId,
  targetTitle,
  missionContext,
  projectId,
  resumeSessionId,
}: MilestoneSliceInterviewModalProps) {
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
  const [error, setError] = useState<string | null>(null);
  const [responseHistory, setResponseHistory] = useState<QuestionResponse[]>([]);
  const [conversationHistory, setConversationHistory] = useState<ConversationHistoryEntry[]>([]);
  const [editedSummary, setEditedSummary] = useState<TargetInterviewSummary | null>(null);
  const [streamingOutput, setStreamingOutput] = useState("");
  const [showThinking, setShowThinking] = useState(true);
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [isApplying, setIsApplying] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const streamConnectionRef = useRef<{ close: () => void; isConnected: () => boolean } | null>(null);
  const currentSessionIdRef = useRef<string | null>(null);
  /*
  FNXC:PlanningMultiTab 2026-07-14-00:00:
  No tab lock: the persisted session row is the shared source of truth, so every tab may read
  and interact with this interview. The lock state, ownership broadcasts, heartbeat, and the
  "active in another tab" banner were removed; only session-status sync remains.
  */
  const { broadcastUpdate, broadcastCompleted } = useAiSessionSync();

  // Select the right API functions based on targetType
  const startInterview = targetType === "milestone" ? startMilestoneInterview : startSliceInterview;
  const respondToInterview =
    targetType === "milestone" ? respondToMilestoneInterview : respondToSliceInterview;
  const connectToStream =
    targetType === "milestone" ? connectMilestoneInterviewStream : connectSliceInterviewStream;
  const applyInterview =
    targetType === "milestone" ? applyMilestoneInterview : applySliceInterview;
  const skipInterview = targetType === "milestone" ? skipMilestoneInterview : skipSliceInterview;
  const targetLabel = targetType === "milestone"
    ? t("interview.targetLabel.milestone", "Milestone")
    : t("interview.targetLabel.slice", "Slice");
  const interviewType = targetType === "milestone" ? "milestone_interview" : "slice_interview";

  const connectToInterviewStream = useCallback(
    (sessionId: string) => {
      streamConnectionRef.current?.close();
      const connection = connectToStream(sessionId, projectId, {
        onThinking: (data) => {
          setStreamingOutput((prev) => prev + data);
          broadcastUpdate({
            sessionId,
            status: "generating",
            needsInput: false,
            type: interviewType,
            title: targetTitle,
            projectId: projectId ?? null,
          });
        },
        onQuestion: (question) => {
          setIsReconnecting(false);
          clearSummary();
          setView({ type: "question", sessionId, question });
          setStreamingOutput("");

          broadcastUpdate({
            sessionId,
            status: "awaiting_input",
            needsInput: true,
            type: interviewType,
            title: targetTitle,
            projectId: projectId ?? null,
          });
        },
        onSummary: (summary) => {
          setIsReconnecting(false);
          clearSummary();
          setView({ type: "summary", sessionId, summary });
          setEditedSummary(summary);
          setStreamingOutput("");

          broadcastUpdate({
            sessionId,
            status: "complete",
            needsInput: false,
            type: interviewType,
            title: targetTitle,
            projectId: projectId ?? null,
          });
        },
        onError: (message) => {
          const errorMessage = message || t("interview.error.sessionFailed", "Session failed while contacting the AI.");
          setIsReconnecting(false);
          setError(null);
          setView({ type: "error", sessionId, errorMessage });
          setStreamingOutput("");
          currentSessionIdRef.current = sessionId;

          broadcastUpdate({
            sessionId,
            status: "error",
            needsInput: false,
            type: interviewType,
            title: targetTitle,
            projectId: projectId ?? null,
          });
          broadcastCompleted({ sessionId, status: "error" });
        },
        onComplete: () => {
          setIsReconnecting(false);
          currentSessionIdRef.current = null;
          broadcastCompleted({ sessionId, status: "complete" });
        },
        onConnectionStateChange: (state) => {
          setIsReconnecting(state === "reconnecting");
        },
      });

      streamConnectionRef.current = connection;
    },
    [broadcastCompleted, broadcastUpdate, connectToStream, interviewType, projectId, targetTitle],
  );

  const clearSummary = () => {
    setEditedSummary(null);
    setResponseHistory([]);
    setConversationHistory([]);
    setStreamingOutput("");
  };

  const handleStartInterview = useCallback(async () => {
    setError(null);
    clearSummary();
    setIsReconnecting(false);
    setView({ type: "loading" });

    try {
      const { sessionId } = await startInterview(targetId, projectId);
      currentSessionIdRef.current = sessionId;
      connectToInterviewStream(sessionId);
    } catch (err) {
      setIsReconnecting(false);
      setError(getErrorMessage(err) || t("interview.error.failedToStart", "Failed to start {{targetLabel}} interview", { targetLabel: targetLabel.toLowerCase() }));
      setView({ type: "initial" });
      currentSessionIdRef.current = null;
    }
  }, [connectToInterviewStream, projectId, startInterview, targetId, targetLabel]);

  const handleUseMissionContext = useCallback(async () => {
    setError(null);
    setIsApplying(true);

    try {
      await skipInterview(targetId, projectId);
      onApplied();
      setView({ type: "applied" });
    } catch (err) {
      setError(getErrorMessage(err) || t("interview.error.failedToSkip", "Failed to skip {{targetLabel}} interview", { targetLabel: targetLabel.toLowerCase() }));
      setIsApplying(false);
    }
  }, [onApplied, projectId, skipInterview, targetId, targetLabel]);

  // Focus textarea when opening
  useEffect(() => {
    if (isOpen && view.type === "initial") {
      textareaRef.current?.focus();
    }
  }, [isOpen, view.type]);

  // Reconnect to a persisted session when resumeSessionId is provided
  useEffect(() => {
    if (!isOpen || !resumeSessionId || view.type !== "initial") return;

    let cancelled = false;

    fetchAiSession(resumeSessionId).then((session) => {
      if (cancelled || !session) return;

      const parsedHistory = parseConversationHistory(session.conversationHistory);
      setConversationHistory(parsedHistory);
      setResponseHistory(
        parsedHistory
          .map((entry) => entry.response)
          .filter((response): response is QuestionResponse =>
            Boolean(response && typeof response === "object" && !Array.isArray(response)),
          ),
      );

      if (session.status === "awaiting_input" && session.currentQuestion) {
        try {
          const question = JSON.parse(session.currentQuestion) as PlanningQuestion;
          currentSessionIdRef.current = session.id;
          setView({ type: "question", sessionId: session.id, question });
        } catch {
          setError(t("interview.error.failedToRestoreQuestion", "Failed to restore session question."));
        }
      } else if (session.status === "complete" && session.result) {
        try {
          const summary = JSON.parse(session.result) as TargetInterviewSummary;
          currentSessionIdRef.current = session.id;
          setEditedSummary(summary);
          setView({ type: "summary", sessionId: session.id, summary });
        } catch {
          setError(t("interview.error.failedToRestoreResult", "Failed to restore session result."));
        }
      } else if (session.status === "generating") {
        currentSessionIdRef.current = session.id;
        if (session.thinkingOutput) {
          setStreamingOutput(session.thinkingOutput);
        }
        setView({ type: "loading" });
        connectToInterviewStream(session.id);
      } else if (session.status === "error") {
        currentSessionIdRef.current = session.id;
        setError(null);
        setView({
          type: "error",
          sessionId: session.id,
          errorMessage: session.error ?? t("interview.error.sessionEncounteredError", "The session encountered an error."),
        });
      }
    }).catch(() => {
      if (!cancelled) setError(t("interview.error.failedToResume", "Failed to resume session."));
    });

    return () => {
      cancelled = true;
    };
  }, [connectToInterviewStream, isOpen, resumeSessionId, view.type]);

  // Cleanup on close
  useEffect(() => {
    if (!isOpen) {
      setIsReconnecting(false);
    }
  }, [isOpen]);

  // Cleanup stream on unmount
  useEffect(() => {
    return () => {
      streamConnectionRef.current?.close();
      streamConnectionRef.current = null;
    };
  }, []);

  const handleSendToBackground = useCallback(() => {
    streamConnectionRef.current?.close();
    streamConnectionRef.current = null;
    onClose();
  }, [onClose]);

  const handleCancel = useCallback(async () => {
    streamConnectionRef.current?.close();
    streamConnectionRef.current = null;
    clearSummary();
    setView({ type: "initial" });
    setError(null);
    currentSessionIdRef.current = null;
    onClose();
  }, [onClose]);

  const handleSubmitResponse = useCallback(
    async (responses: QuestionResponse) => {
      if (view.type !== "question") return;

      const { sessionId } = view;
      setError(null);
      setResponseHistory((prev) => [...prev, responses]);
      setConversationHistory((prev) => [
        ...prev,
        {
          question: view.question,
          response: responses,
        },
      ]);
      setView({ type: "loading" });
      setStreamingOutput("");

      try {
        connectToInterviewStream(sessionId);
        await respondToInterview(sessionId, responses, projectId);
      } catch (err) {
        streamConnectionRef.current?.close();
        streamConnectionRef.current = null;
        setError(getErrorMessage(err) || t("interview.error.failedToSubmit", "Failed to submit response"));
        setView({ type: "question", sessionId, question: view.question });
      }
    },
    [connectToInterviewStream, projectId, respondToInterview, view],
  );

  const handleApply = useCallback(async () => {
    if (view.type !== "summary") return;

    setError(null);
    setIsApplying(true);

    try {
      await applyInterview(view.sessionId, editedSummary || undefined, projectId);
      onApplied();
      setView({ type: "applied" });
    } catch (err) {
      setError(getErrorMessage(err) || t("interview.error.failedToApply", "Failed to apply interview results"));
      setIsApplying(false);
    }
  }, [applyInterview, editedSummary, onApplied, projectId, view]);

  const getProgress = () => {
    if (view.type === "question") {
      return Math.min(responseHistory.length + 1, 6);
    }
    return 6;
  };

  const showSendToBackgroundButton =
    view.type === "loading" ||
    view.type === "question" ||
    view.type === "summary" ||
    view.type === "error";

  if (!isOpen) return null;

  return (
    <div
      className="modal-overlay open"
      onClick={(e) => e.target === e.currentTarget && handleCancel()}
      role="dialog"
      aria-modal="true"
      data-testid="milestone-slice-interview-modal"
    >
      <div className="modal modal-lg planning-modal" style={keyboardStyle}>
        <div className="modal-header">
          <div className="detail-title-row">
            <Sparkles size={20} className="icon-triage" />
            <h3>
              {t("missions.planTargetTitle", "Plan {{targetLabel}}: {{targetTitle}}", { targetLabel, targetTitle })}
            </h3>
          </div>
          <div className="modal-header-actions">
            {showSendToBackgroundButton && (
              <button
                className="modal-send-to-background"
                onClick={handleSendToBackground}
                title={t("interview.sendToBackground", "Send to background")}
                aria-label={t("interview.sendToBackground", "Send to background")}
              >
                <Minimize2 size={16} />
              </button>
            )}
            <button className="modal-close" onClick={handleCancel} aria-label={t("actions.close", "Close")}>
              <X size={20} />
            </button>
          </div>
        </div>

        <div className="planning-modal-body">
          {error && <div className="form-error planning-error">{error}</div>}
          {/*
          FNXC:MilestoneSliceInterview 2026-07-15-00:00:
          Awaiting-input questions render persisted database state, so transient idle SSE reconnects must not imply that the question is being regenerated. Reserve this hint for the active loading view, mirroring the FN-8002 Planning Mode invariant.
          */}
          {isReconnecting && view.type === "loading" && <div className="form-hint text-muted">{t("interview.reconnecting", "Reconnecting…")}</div>}

          {view.type === "initial" && (
            <div className="planning-initial">
              <div className="planning-view-scroll">
                <div className="planning-intro">
                  <Sparkles size={32} className="icon-triage-lg" />
                  <h4>{t("interview.refineScope", `Refine ${targetLabel} scope with AI`)}</h4>
                  <p className="text-muted">
                    {t("interview.interviewDescription", `The AI will interview you to refine the ${targetType}'s scope, acceptance criteria, and verification methods. Each ${targetType} can have its own refined plan or inherit context from the mission level.`)}
                  </p>
                  {missionContext && (
                    <div className="planning-context-info">
                      <span className="planning-context-label">{t("interview.missionContext", "Mission context:")}</span>
                      <span className="planning-context-text">{missionContext}</span>
                    </div>
                  )}
                </div>
              </div>

              <div className="planning-view-footer">
                <button
                  className="btn btn-primary planning-start-btn"
                  onClick={() => void handleStartInterview()}
                >
                  <Sparkles size={16} className="icon-mr-8" />
                  {t("interview.startInterview", "Start Interview")}
                </button>
                <button
                  className="btn planning-use-context-btn"
                  onClick={() => void handleUseMissionContext()}
                  disabled={isApplying}
                >
                  {isApplying ? <Loader2 size={16} className="spin" /> : null}
                  {t("interview.useMissionContext", "Use Mission Context")}
                </button>
                <button className="btn" onClick={handleCancel}>
                  {t("actions.cancel", "Cancel")}
                </button>
              </div>
            </div>
          )}

          {view.type === "loading" && (
            <div className="planning-loading">
              <Loader2 size={40} className="spin icon-todo" />
              <p>{streamingOutput ? t("interview.aiThinking", "AI is thinking...") : t("interview.preparingQuestion", "Preparing next question...")}</p>
              <div className="planning-thinking-container">
                <button
                  className="planning-thinking-toggle"
                  onClick={() => setShowThinking(!showThinking)}
                  type="button"
                >
                  {showThinking ? t("interview.hideThinking", "Hide thinking") : t("interview.showThinking", "Show thinking")}
                </button>
                {showThinking && streamingOutput && (
                  <div className="planning-thinking-output">
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

                <div className="ai-error-panel" role="alert">
                  <div className="ai-error-icon">{WARNING_ICON}</div>
                  <div className="ai-error-message">{view.errorMessage}</div>
                  <div className="ai-error-actions">
                    <button className="btn" onClick={handleCancel}>
                      {t("actions.cancel", "Cancel")}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {view.type === "question" && (
            <InterviewQuestionForm
              question={view.question}
              progress={getProgress()}
              historyEntries={conversationHistory}
              onSubmit={handleSubmitResponse}
            />
          )}

          {view.type === "summary" && editedSummary && (
            <SummaryReview
              summary={editedSummary}
              historyEntries={conversationHistory}
              onSummaryChange={setEditedSummary}
              onApply={handleApply}
              onCancel={handleCancel}
              isApplying={isApplying}
            />
          )}

          {view.type === "applied" && (
            <div className="planning-summary planning-applied">
              <div className="planning-view-scroll">
                <div className="planning-applied-content">
                  <CheckCircle size={48} className="icon-success" />
                  <h4>{t("interview.updated", `${targetLabel} Updated`)}</h4>
                  <p className="text-muted">
                    {t("interview.appliedMessage", `The ${targetType}'s scope and verification have been applied.`)}
                  </p>
                </div>
              </div>

              <div className="planning-view-footer">
                <button className="btn btn-primary" onClick={onApplied}>
                  {t("actions.done", "Done")}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Question Form Component ────────────────────────────────────────────────

interface InterviewQuestionFormProps {
  question: PlanningQuestion;
  progress: number;
  historyEntries: ConversationHistoryEntry[];
  onSubmit: (responses: QuestionResponse) => void;
}

function InterviewQuestionForm({ question, progress, historyEntries, onSubmit }: InterviewQuestionFormProps) {
  const { t } = useTranslation("app");
  const questionOptions = question.options ?? [];
  const [response, setResponse] = useState<QuestionResponse>({});
  const [textValue, setTextValue] = useState("");
  const [commentValue, setCommentValue] = useState("");
  const [otherValue, setOtherValue] = useState("");
  const [isOtherSelected, setIsOtherSelected] = useState(false);

  const handleSubmit = useCallback(() => {
    let nextResponse: QuestionResponse;

    if (question.type === "text") {
      nextResponse = { [question.id]: textValue };
    } else if (question.type === "confirm") {
      nextResponse = { [question.id]: response[question.id] === true };
    } else if (question.type === "single_select") {
      const trimmedOther = otherValue.trim();
      /*
      FNXC:PlanningInterview 2026-06-26-00:00:
      GitHub #1794 requires milestone and slice interviews to let users decline every AI-provided single-select option and submit their own answer through `_other`.
      */
      nextResponse = isOtherSelected && trimmedOther.length > 0
        ? { [MILESTONE_SLICE_OTHER_RESPONSE_KEY]: trimmedOther }
        : response;
    } else if (question.type === "multi_select") {
      const trimmedOther = otherValue.trim();
      /*
      FNXC:PlanningInterview 2026-06-26-00:00:
      Milestone and slice multi-select questions must support Other-only answers and Other-plus-option answers without forcing users into suggested choices they reject.
      */
      nextResponse = isOtherSelected && trimmedOther.length > 0
        ? { ...response, [MILESTONE_SLICE_OTHER_RESPONSE_KEY]: trimmedOther }
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
        Continue is valid for milestone/slice single-select questions when the user writes a non-empty Other answer, even with no provided option selected.
        */
        return response[question.id] !== undefined || (isOtherSelected && otherValue.trim().length > 0);
      case "multi_select":
        /*
        FNXC:PlanningInterview 2026-06-26-00:00:
        Continue is valid for milestone/slice multi-select questions when Other has non-whitespace text, including the Other-only case.
        */
        return (Array.isArray(response[question.id] as unknown) && (response[question.id] as unknown[]).length > 0) || (isOtherSelected && otherValue.trim().length > 0);
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
              {[1, 2, 3, 4, 5, 6].map((step) => (
                <div
                  key={step}
                  className={`planning-progress-step ${step <= progress ? "active" : ""}`}
                />
              ))}
            </div>
            <span className="planning-progress-text">{t("interview.progressText", `Question ${progress} of ~6`)}</span>
          </div>

          <div className="planning-question-content">
            <h4 className="planning-question-text">{question.question}</h4>
            {question.description && (
              <p className="planning-question-desc">{question.description}</p>
            )}

            <div className="planning-options">
              {question.type === "text" && (
                <textarea
                  className="planning-textarea"
                  rows={4}
                  placeholder={t("interview.typeAnswerHere", "Type your answer here...")}
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
                  {/* FNXC:PlanningInterview 2026-06-26-00:00: The synthetic Other radio keeps milestone/slice interviews redirectable when every provided answer is wrong for the user's intent. */}
                  <label className="planning-option planning-option--radio" data-testid="planning-option-other">
                    <input
                      type="radio"
                      name={question.id}
                      value={MILESTONE_SLICE_OTHER_OPTION_ID}
                      checked={isOtherSelected}
                      onChange={() => {
                        setIsOtherSelected(true);
                        setResponse({});
                      }}
                    />
                    <div className="planning-option-content">
                      <span className="planning-option-label">{t("interview.otherOptionLabel", "Other (write your own)")}</span>
                    </div>
                  </label>
                  {isOtherSelected && (
                    <div className="planning-other-answer">
                      <textarea
                        className="planning-textarea"
                        data-testid="planning-other-input"
                        rows={2}
                        placeholder={t("interview.otherOptionPlaceholder", "Write your own answer...")}
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
                  {/* FNXC:PlanningInterview 2026-06-26-00:00: The synthetic Other checkbox lets milestone/slice users submit their own answer by itself or alongside provided options. */}
                  <label className="planning-option planning-option--checkbox" data-testid="planning-option-other">
                    <input
                      type="checkbox"
                      value={MILESTONE_SLICE_OTHER_OPTION_ID}
                      checked={isOtherSelected}
                      onChange={(e) => {
                        setIsOtherSelected(e.target.checked);
                        if (!e.target.checked) {
                          setOtherValue("");
                        }
                      }}
                    />
                    <div className="planning-option-content">
                      <span className="planning-option-label">{t("interview.otherOptionLabel", "Other (write your own)")}</span>
                    </div>
                  </label>
                  {isOtherSelected && (
                    <div className="planning-other-answer">
                      <textarea
                        className="planning-textarea"
                        data-testid="planning-other-input"
                        rows={2}
                        placeholder={t("interview.otherOptionPlaceholder", "Write your own answer...")}
                        value={otherValue}
                        onChange={(e) => setOtherValue(e.target.value)}
                      />
                    </div>
                  )}
                </div>
              )}

              {question.type === "confirm" && (
                <div className="planning-confirm-group">
                  <button
                    className={`planning-confirm-btn ${response[question.id] === true ? "selected" : ""}`}
                    onClick={() => setResponse({ [question.id]: true })}
                  >
                    <CheckCircle size={18} />
                    {t("interview.yes", "Yes")}
                  </button>
                  <button
                    className={`planning-confirm-btn ${response[question.id] === false ? "selected" : ""}`}
                    onClick={() => setResponse({ [question.id]: false })}
                  >
                    <X size={18} />
                    {t("interview.no", "No")}
                  </button>
                </div>
              )}
            </div>

            {question.type !== "text" && (
              <div className="planning-comment-section">
                <label className="planning-comment-label" htmlFor={`planning-comment-${question.id}`}>
                  {t("interview.additionalComments", "Additional comments (optional)")}
                </label>
                <textarea
                  id={`planning-comment-${question.id}`}
                  className="planning-textarea"
                  rows={2}
                  placeholder={t("interview.addContextDirection", "Add any extra context or direction...")}
                  value={commentValue}
                  onChange={(e) => setCommentValue(e.target.value)}
                />
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="planning-actions">
        <button
          className="btn btn-primary planning-actions-primary"
          onClick={handleSubmit}
          disabled={!isValid()}
        >
          {t("actions.continue", "Continue")}
          <ArrowRight size={16} className="icon-ml-4" />
        </button>
      </div>
    </div>
  );
}

// ── Summary Review Component ────────────────────────────────────────────────

interface SummaryReviewProps {
  summary: TargetInterviewSummary;
  historyEntries: ConversationHistoryEntry[];
  onSummaryChange: (summary: TargetInterviewSummary) => void;
  onApply: () => void;
  onCancel: () => void;
  isApplying: boolean;
}

function SummaryReview({
  summary,
  historyEntries,
  onSummaryChange,
  onApply,
  onCancel,
  isApplying,
}: SummaryReviewProps) {
  const { t } = useTranslation("app");
  const [editedSummary, setEditedSummary] = useState<TargetInterviewSummary>(summary);
  const [expanded, setExpanded] = useState(true);

  const handleChange = (field: keyof TargetInterviewSummary, value: string) => {
    const updated = { ...editedSummary, [field]: value };
    setEditedSummary(updated);
    onSummaryChange(updated);
  };

  return (
    <div className="planning-summary">
      <div className="planning-view-scroll planning-summary-scroll">
        {historyEntries.length > 0 && (
          <>
            <ConversationHistory entries={historyEntries} />
            <div className="conversation-separator" />
          </>
        )}

        <div className="planning-summary-panel">
          <div className="planning-summary-header">
            <button
              className="planning-summary-toggle"
              onClick={() => setExpanded(!expanded)}
              aria-expanded={expanded}
            >
              {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
              <span>{t("interview.refinedScope", "Refined Scope")}</span>
            </button>
          </div>

          {expanded && (
            <div className="planning-summary-content">
              {editedSummary.description && (
                <div className="planning-summary-field">
                  <label>{t("interview.description", "Description")}</label>
                  <textarea
                    rows={3}
                    value={editedSummary.description}
                    onChange={(e) => handleChange("description", e.target.value)}
                  />
                </div>
              )}

              {editedSummary.planningNotes && (
                <div className="planning-summary-field">
                  <label>{t("interview.planningNotes", "Planning Notes")}</label>
                  <textarea
                    rows={3}
                    value={editedSummary.planningNotes}
                    onChange={(e) => handleChange("planningNotes", e.target.value)}
                  />
                </div>
              )}

              {editedSummary.verification && (
                <div className="planning-summary-field">
                  <label>{t("interview.verificationCriteria", "Verification Criteria")}</label>
                  <textarea
                    rows={2}
                    value={editedSummary.verification}
                    onChange={(e) => handleChange("verification", e.target.value)}
                  />
                </div>
              )}

              {!editedSummary.description &&
                !editedSummary.planningNotes &&
                !editedSummary.verification && (
                  <p className="text-muted planning-summary-empty">
                    {t("interview.noAdditionalDetails", "No additional details were generated for this item.")}
                  </p>
                )}
            </div>
          )}
        </div>
      </div>

      <div className="planning-view-footer">
        <button
          className="btn btn-primary planning-actions-primary"
          onClick={onApply}
          disabled={isApplying}
        >
          {isApplying ? <Loader2 size={16} className="spin" /> : null}
          {t("actions.apply", "Apply")}
        </button>
        <button className="btn" onClick={onCancel} disabled={isApplying}>
          {t("actions.cancel", "Cancel")}
        </button>
      </div>
    </div>
  );
}
