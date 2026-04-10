import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import type { PlanningQuestion } from "@fusion/core";
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
import { useSessionLock } from "../hooks/useSessionLock";
import { useAiSessionSync } from "../hooks/useAiSessionSync";
import { getSessionTabId } from "../utils/getSessionTabId";

interface MilestoneSliceInterviewModalProps {
  isOpen: boolean;
  onClose: () => void;
  onApplied: () => void;
  targetType: "milestone" | "slice";
  targetId: string;
  targetTitle: string;
  missionContext?: string;
  projectId?: string;
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
}: MilestoneSliceInterviewModalProps) {
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
  const trackedLockSessionRef = useRef<string | null>(null);
  const [lockSessionId, setLockSessionId] = useState<string | null>(null);
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

  // Select the right API functions based on targetType
  const startInterview = targetType === "milestone" ? startMilestoneInterview : startSliceInterview;
  const respondToInterview =
    targetType === "milestone" ? respondToMilestoneInterview : respondToSliceInterview;
  const connectToStream =
    targetType === "milestone" ? connectMilestoneInterviewStream : connectSliceInterviewStream;
  const applyInterview =
    targetType === "milestone" ? applyMilestoneInterview : applySliceInterview;
  const skipInterview = targetType === "milestone" ? skipMilestoneInterview : skipSliceInterview;
  const targetLabel = targetType === "milestone" ? "Milestone" : "Slice";
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
            owningTabId: sessionTabId,
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
            owningTabId: sessionTabId,
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
            owningTabId: sessionTabId,
            type: interviewType,
            title: targetTitle,
            projectId: projectId ?? null,
          });
        },
        onError: (message) => {
          const errorMessage = message || "Session failed while contacting the AI.";
          setIsReconnecting(false);
          setError(null);
          setView({ type: "error", sessionId, errorMessage });
          setStreamingOutput("");
          currentSessionIdRef.current = sessionId;

          broadcastUpdate({
            sessionId,
            status: "error",
            needsInput: false,
            owningTabId: sessionTabId,
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
    [broadcastCompleted, broadcastUpdate, connectToStream, interviewType, projectId, sessionTabId, targetTitle],
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
      setLockSessionId(sessionId);
      connectToInterviewStream(sessionId);
    } catch (err: any) {
      setIsReconnecting(false);
      setError(err.message || `Failed to start ${targetLabel.toLowerCase()} interview`);
      setView({ type: "initial" });
      currentSessionIdRef.current = null;
      setLockSessionId(null);
    }
  }, [connectToInterviewStream, projectId, startInterview, targetId, targetLabel]);

  const handleUseMissionContext = useCallback(async () => {
    setError(null);
    setIsApplying(true);

    try {
      await skipInterview(targetId, projectId);
      onApplied();
      setView({ type: "applied" });
    } catch (err: any) {
      setError(err.message || `Failed to skip ${targetLabel.toLowerCase()} interview`);
      setIsApplying(false);
    }
  }, [onApplied, projectId, skipInterview, targetId, targetLabel]);

  // Focus textarea when opening
  useEffect(() => {
    if (isOpen && view.type === "initial") {
      textareaRef.current?.focus();
    }
  }, [isOpen, view.type]);

  // Cleanup on close
  useEffect(() => {
    if (!isOpen) {
      setIsReconnecting(false);
      setLockSessionId(null);
    }
  }, [isOpen]);

  // Session locking
  useEffect(() => {
    if (!isOpen || !lockSessionId) return;

    if (trackedLockSessionRef.current !== lockSessionId) {
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

  // Keep heartbeat alive
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

  // Cleanup stream on unmount
  useEffect(() => {
    return () => {
      streamConnectionRef.current?.close();
      streamConnectionRef.current = null;

      if (trackedLockSessionRef.current) {
        broadcastUnlock(trackedLockSessionRef.current, sessionTabId);
        trackedLockSessionRef.current = null;
      }
    };
  }, [broadcastUnlock, sessionTabId]);

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
    setLockSessionId(null);
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
        await respondToInterview(sessionId, responses, projectId, sessionTabId);
      } catch (err: any) {
        setError(err.message || "Failed to submit response");
        setView({ type: "question", sessionId, question: view.question });
      }
    },
    [projectId, respondToInterview, sessionTabId, view],
  );

  const handleApply = useCallback(async () => {
    if (view.type !== "summary") return;

    setError(null);
    setIsApplying(true);

    try {
      await applyInterview(view.sessionId, editedSummary || undefined, projectId);
      onApplied();
      setView({ type: "applied" });
    } catch (err: any) {
      setError(err.message || "Failed to apply interview results");
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

  const activeLockInfo = lockSessionId ? activeTabMap.get(lockSessionId) : null;
  const activeRemoteTab = activeLockInfo && activeLockInfo.tabId !== sessionTabId;
  const activeInAnotherTab = Boolean(activeRemoteTab && !activeLockInfo.stale);

  if (!isOpen) return null;

  return (
    <div
      className="modal-overlay open"
      onClick={(e) => e.target === e.currentTarget && handleCancel()}
      data-testid="milestone-slice-interview-modal"
    >
      <div className="modal modal-lg planning-modal">
        <div className="modal-header">
          <div className="detail-title-row">
            <Sparkles size={20} className="icon-triage" />
            <h3>
              Plan {targetLabel}: {targetTitle}
            </h3>
          </div>
          <div className="modal-header-actions">
            {showSendToBackgroundButton && (
              <button
                className="modal-send-to-background"
                onClick={handleSendToBackground}
                title="Send to background"
                aria-label="Send to background"
              >
                <Minimize2 size={16} />
              </button>
            )}
            <button className="modal-close" onClick={handleCancel} aria-label="Close">
              <X size={20} />
            </button>
          </div>
        </div>

        <div className="planning-modal-body">
          {error && <div className="form-error planning-error">{error}</div>}
          {isReconnecting && <div className="form-hint text-muted">Reconnecting…</div>}
          {activeInAnotherTab && (
            <div className="form-hint text-muted" data-testid="session-active-another-tab-banner">
              Session is active in another tab.
            </div>
          )}

          {view.type === "initial" && (
            <div className="planning-initial">
              <div className="planning-view-scroll">
                <div className="planning-intro">
                  <Sparkles size={32} className="icon-triage-lg" />
                  <h4>Refine {targetLabel} scope with AI</h4>
                  <p className="text-muted">
                    The AI will interview you to refine the {targetType}&apos;s scope, acceptance criteria,
                    and verification methods. Each {targetType} can have its own refined plan or inherit
                    context from the mission level.
                  </p>
                  {missionContext && (
                    <div className="planning-context-info">
                      <span className="planning-context-label">Mission context:</span>
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
                  Start Interview
                </button>
                <button
                  className="btn planning-use-context-btn"
                  onClick={() => void handleUseMissionContext()}
                  disabled={isApplying}
                >
                  {isApplying ? <Loader2 size={16} className="spin" /> : null}
                  Use Mission Context
                </button>
                <button className="btn" onClick={handleCancel}>
                  Cancel
                </button>
              </div>
            </div>
          )}

          {view.type === "loading" && (
            <div className="planning-loading">
              <Loader2 size={40} className="spin icon-todo" />
              <p>{streamingOutput ? "AI is thinking..." : "Preparing next question..."}</p>
              <div className="planning-thinking-container">
                <button
                  className="planning-thinking-toggle"
                  onClick={() => setShowThinking(!showThinking)}
                  type="button"
                >
                  {showThinking ? "Hide thinking" : "Show thinking"}
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
                  <div className="ai-error-icon">⚠️</div>
                  <div className="ai-error-message">{view.errorMessage}</div>
                  <div className="ai-error-actions">
                    <button className="btn" onClick={handleCancel}>
                      Cancel
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
                  <h4>{targetLabel} Updated</h4>
                  <p className="text-muted">
                    The {targetType}&apos;s scope and verification have been {view.type === "applied" ? "applied" : "updated"}.
                  </p>
                </div>
              </div>

              <div className="planning-view-footer">
                <button className="btn btn-primary" onClick={onApplied}>
                  Done
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
  const [response, setResponse] = useState<QuestionResponse>({});
  const [textValue, setTextValue] = useState("");

  const handleSubmit = useCallback(() => {
    if (question.type === "text") {
      onSubmit({ [question.id]: textValue });
    } else if (question.type === "confirm") {
      onSubmit({ [question.id]: response[question.id] === true });
    } else {
      onSubmit(response);
    }
  }, [question, response, textValue, onSubmit]);

  useEffect(() => {
    setResponse({});
    setTextValue("");
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
              {[1, 2, 3, 4, 5, 6].map((step) => (
                <div
                  key={step}
                  className={`planning-progress-step ${step <= progress ? "active" : ""}`}
                />
              ))}
            </div>
            <span className="planning-progress-text">Question {progress} of ~6</span>
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
          </div>
        </div>
      </div>

      <div className="planning-actions">
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
              <span>Refined Scope</span>
            </button>
          </div>

          {expanded && (
            <div className="planning-summary-content">
              {editedSummary.description && (
                <div className="planning-summary-field">
                  <label>Description</label>
                  <textarea
                    rows={3}
                    value={editedSummary.description}
                    onChange={(e) => handleChange("description", e.target.value)}
                  />
                </div>
              )}

              {editedSummary.planningNotes && (
                <div className="planning-summary-field">
                  <label>Planning Notes</label>
                  <textarea
                    rows={3}
                    value={editedSummary.planningNotes}
                    onChange={(e) => handleChange("planningNotes", e.target.value)}
                  />
                </div>
              )}

              {editedSummary.verification && (
                <div className="planning-summary-field">
                  <label>Verification Criteria</label>
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
                    No additional details were generated for this item.
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
          Apply
        </button>
        <button className="btn" onClick={onCancel} disabled={isApplying}>
          Cancel
        </button>
      </div>
    </div>
  );
}
