import { useState, useCallback, useEffect, useRef } from "react";
import type { PlanningQuestion } from "@fusion/core";
import {
  startMissionInterview,
  respondToMissionInterview,
  cancelMissionInterview,
  createMissionFromInterview,
  connectMissionInterviewStream,
  fetchAiSession,
  type MissionPlanSummary,
  type MissionPlanMilestone,
  type MissionPlanSlice,
  type MissionPlanFeature,
  type MissionWithHierarchy,
} from "../api";
import {
  saveMissionGoal,
  getMissionGoal,
  clearMissionGoal,
} from "../hooks/modalPersistence";
import {
  Target,
  X,
  Loader2,
  CheckCircle,
  ArrowLeft,
  ArrowRight,
  Sparkles,
  ChevronRight,
  ChevronDown,
  Layers,
  Package,
  Box,
  Plus,
  Trash2,
} from "lucide-react";

interface MissionInterviewModalProps {
  isOpen: boolean;
  onClose: () => void;
  onMissionCreated: (mission: MissionWithHierarchy) => void;
  projectId?: string;
  initialGoal?: string;
  resumeSessionId?: string;
}

interface QuestionResponse {
  [key: string]: unknown;
}

type ViewState =
  | { type: "initial" }
  | { type: "loading" }
  | { type: "question"; sessionId: string; question: PlanningQuestion }
  | { type: "summary"; sessionId: string; summary: MissionPlanSummary };

const EXAMPLE_MISSIONS = [
  "Build a real-time collaborative document editor",
  "Create a customer onboarding flow with email verification",
  "Add a reporting dashboard with charts and CSV export",
  "Implement a plugin system with marketplace",
];

export function MissionInterviewModal({
  isOpen,
  onClose,
  onMissionCreated,
  projectId,
  initialGoal: initialGoalProp,
  resumeSessionId,
}: MissionInterviewModalProps) {
  const [missionGoal, setMissionGoal] = useState("");
  const [view, setView] = useState<ViewState>({ type: "initial" });
  const [error, setError] = useState<string | null>(null);
  const [responseHistory, setResponseHistory] = useState<QuestionResponse[]>([]);
  const [editedSummary, setEditedSummary] = useState<MissionPlanSummary | null>(null);
  const [hasProgress, setHasProgress] = useState(false);
  const hasAutoStartedRef = useRef(false);
  const [streamingOutput, setStreamingOutput] = useState("");
  const [showThinking, setShowThinking] = useState(true);
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const streamConnectionRef = useRef<{ close: () => void; isConnected: () => boolean } | null>(null);
  const currentSessionIdRef = useRef<string | null>(null);

  const handleStartInterview = useCallback(
    async (goalOverride?: string) => {
      const goal = goalOverride ?? missionGoal;
      if (!goal.trim()) return;

      setError(null);
      setStreamingOutput("");
      setIsReconnecting(false);
      setView({ type: "loading" });

      try {
        const { sessionId } = await startMissionInterview(goal.trim(), projectId);
        currentSessionIdRef.current = sessionId;
        clearMissionGoal();

        const connection = connectMissionInterviewStream(sessionId, projectId, {
          onThinking: (data) => {
            setStreamingOutput((prev) => prev + data);
          },
          onQuestion: (question) => {
            setIsReconnecting(false);
            clearMissionGoal();
            setView({ type: "question", sessionId, question });
            setStreamingOutput("");
            setHasProgress(true);
          },
          onSummary: (summary) => {
            setIsReconnecting(false);
            clearMissionGoal();
            setView({ type: "summary", sessionId, summary });
            setEditedSummary(summary);
            setStreamingOutput("");
            setHasProgress(true);
          },
          onError: (message) => {
            setIsReconnecting(false);
            setError(message);
            setView({ type: "initial" });
            setStreamingOutput("");
            currentSessionIdRef.current = null;
          },
          onComplete: () => {
            setIsReconnecting(false);
            currentSessionIdRef.current = null;
          },
          onConnectionStateChange: (state) => {
            setIsReconnecting(state === "reconnecting");
          },
        });

        streamConnectionRef.current = connection;
        setResponseHistory([]);
      } catch (err: any) {
        setIsReconnecting(false);
        setError(err.message || "Failed to start interview session");
        setView({ type: "initial" });
        currentSessionIdRef.current = null;
      }
    },
    [missionGoal, projectId]
  );

  // Focus textarea when opening
  useEffect(() => {
    if (isOpen && view.type === "initial") {
      textareaRef.current?.focus();
    }
  }, [isOpen, view.type]);

  // Auto-start when initialGoal prop is provided
  useEffect(() => {
    if (isOpen && initialGoalProp && !hasAutoStartedRef.current && view.type === "initial") {
      setMissionGoal(initialGoalProp);
      const timer = setTimeout(() => {
        hasAutoStartedRef.current = true;
        handleStartInterview(initialGoalProp);
      }, 0);
      return () => clearTimeout(timer);
    } else if (isOpen && !initialGoalProp && !hasAutoStartedRef.current && view.type === "initial") {
      // Check localStorage for persisted goal when no prop provided
      const persisted = getMissionGoal();
      if (persisted) {
        setMissionGoal(persisted);
      }
    }
  }, [isOpen, initialGoalProp, view.type, handleStartInterview]);

  useEffect(() => {
    if (!isOpen) {
      hasAutoStartedRef.current = false;
      setIsReconnecting(false);
    }
  }, [isOpen]);

  // Reconnect to a persisted session when resumeSessionId is provided
  useEffect(() => {
    if (!isOpen || !resumeSessionId || view.type !== "initial") return;

    let cancelled = false;

    fetchAiSession(resumeSessionId).then((session) => {
      if (cancelled || !session) return;

      if (session.status === "awaiting_input" && session.currentQuestion) {
        try {
          clearMissionGoal();
          const question = JSON.parse(session.currentQuestion) as import("@fusion/core").PlanningQuestion;
          currentSessionIdRef.current = session.id;
          setHasProgress(true);
          setView({ type: "question", sessionId: session.id, question });
        } catch {
          setError("Failed to restore session question.");
        }
      } else if (session.status === "complete" && session.result) {
        try {
          clearMissionGoal();
          const summary = JSON.parse(session.result) as MissionPlanSummary;
          currentSessionIdRef.current = session.id;
          setHasProgress(true);
          setEditedSummary(summary);
          setView({ type: "summary", sessionId: session.id, summary });
        } catch {
          setError("Failed to restore session result.");
        }
      } else if (session.status === "generating") {
        currentSessionIdRef.current = session.id;
        setHasProgress(true);
        if (session.thinkingOutput) {
          setStreamingOutput(session.thinkingOutput);
        }
        setView({ type: "loading" });

        const connection = connectMissionInterviewStream(session.id, projectId, {
          onThinking: (data) => {
            setStreamingOutput((prev) => prev + data);
          },
          onQuestion: (question) => {
            setIsReconnecting(false);
            clearMissionGoal();
            setView({ type: "question", sessionId: session.id, question });
            setStreamingOutput("");
          },
          onSummary: (summary) => {
            setIsReconnecting(false);
            clearMissionGoal();
            setView({ type: "summary", sessionId: session.id, summary });
            setEditedSummary(summary);
            setStreamingOutput("");
          },
          onError: (message) => {
            setIsReconnecting(false);
            setError(message);
            setView({ type: "initial" });
            setStreamingOutput("");
            currentSessionIdRef.current = null;
          },
          onComplete: () => {
            setIsReconnecting(false);
            currentSessionIdRef.current = null;
          },
          onConnectionStateChange: (state) => {
            setIsReconnecting(state === "reconnecting");
          },
        });

        streamConnectionRef.current = connection;
      } else if (session.status === "error") {
        setError(session.error ?? "The session encountered an error.");
      }
    }).catch(() => {
      if (!cancelled) setError("Failed to resume session.");
    });

    return () => {
      cancelled = true;
    };
  }, [isOpen, resumeSessionId, view.type, projectId]);

  // Cleanup stream on unmount
  useEffect(() => {
    return () => {
      streamConnectionRef.current?.close();
      streamConnectionRef.current = null;
    };
  }, []);

  // Unload protection
  useEffect(() => {
    if (!isOpen) return;

    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (view.type === "question" || view.type === "summary") {
        e.preventDefault();
        e.returnValue = "";
      }
      streamConnectionRef.current?.close();
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [isOpen, view]);

  const handleCancel = useCallback(async () => {
    // Save to localStorage BEFORE any cleanup
    if (missionGoal) {
      saveMissionGoal(missionGoal);
    }

    if (hasProgress) {
      if (!confirm("Are you sure you want to close? Your interview progress will be lost.")) {
        return;
      }
    }

    streamConnectionRef.current?.close();
    streamConnectionRef.current = null;

    if (view.type === "question" || view.type === "summary") {
      try {
        await cancelMissionInterview(view.sessionId, projectId);
      } catch {
        // Ignore errors on cancel
      }
    }

    setMissionGoal("");
    setView({ type: "initial" });
    setError(null);
    setResponseHistory([]);
    setEditedSummary(null);
    setStreamingOutput("");
    setIsReconnecting(false);
    setHasProgress(false);
    setIsCreating(false);
    currentSessionIdRef.current = null;
    onClose();
  }, [missionGoal, hasProgress, view, onClose, projectId]);

  // Escape key handler
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (hasProgress) {
          if (confirm("Are you sure you want to close? Your interview progress will be lost.")) {
            handleCancel();
          }
        } else {
          handleCancel();
        }
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, hasProgress, handleCancel]);

  const handleSubmitResponse = useCallback(
    async (responses: QuestionResponse) => {
      if (view.type !== "question") return;

      const { sessionId } = view;
      setError(null);
      setView({ type: "loading" });
      setStreamingOutput("");

      try {
        await respondToMissionInterview(sessionId, responses, projectId);
        setResponseHistory((prev) => [...prev, responses]);
        setHasProgress(true);
      } catch (err: any) {
        setError(err.message || "Failed to submit response");
        setView({ type: "question", sessionId, question: view.question });
      }
    },
    [view, projectId]
  );

  const handleApprovePlan = useCallback(async () => {
    if (view.type !== "summary") return;

    setError(null);
    setIsCreating(true);

    try {
      const mission = await createMissionFromInterview(view.sessionId, editedSummary || undefined, projectId);
      onMissionCreated(mission);
      clearMissionGoal();
      // Reset state without confirmation
      streamConnectionRef.current?.close();
      streamConnectionRef.current = null;
      setMissionGoal("");
      setView({ type: "initial" });
      setError(null);
      setResponseHistory([]);
      setEditedSummary(null);
      setStreamingOutput("");
      setIsReconnecting(false);
      setHasProgress(false);
      setIsCreating(false);
      currentSessionIdRef.current = null;
      onClose();
    } catch (err: any) {
      setError(err.message || "Failed to create mission");
      setIsCreating(false);
    }
  }, [view, editedSummary, onMissionCreated, onClose, projectId]);

  const getProgress = () => {
    if (view.type === "question") {
      return Math.min(responseHistory.length + 1, 6);
    }
    return 6;
  };

  if (!isOpen) return null;

  return (
    <div className="modal-overlay open" onClick={(e) => e.target === e.currentTarget && handleCancel()}>
      <div className="modal modal-lg planning-modal">
        <div className="modal-header">
          <div className="detail-title-row">
            <Target size={20} style={{ color: "var(--triage)" }} />
            <h3>Plan Mission with AI</h3>
          </div>
          <button className="modal-close" onClick={handleCancel} aria-label="Close">
            <X size={20} />
          </button>
        </div>

        <div className="planning-modal-body">
          {error && <div className="form-error planning-error">{error}</div>}
          {isReconnecting && <div className="form-hint text-muted">Reconnecting…</div>}

          {view.type === "initial" && (
            <div className="planning-initial">
              <div className="planning-view-scroll">
                <div className="planning-intro">
                  <Sparkles size={32} style={{ color: "var(--triage)", marginBottom: "12px" }} />
                  <h4>Transform your vision into a structured mission</h4>
                  <p className="text-muted">
                    Describe what you want to build. The AI will interview you to understand scope,
                    constraints, and requirements, then produce a structured plan with milestones,
                    slices, and features.
                  </p>
                </div>

                <div className="form-group">
                  <label htmlFor="mission-goal">What do you want to build?</label>
                  <textarea
                    ref={textareaRef}
                    id="mission-goal"
                    rows={4}
                    className="planning-textarea"
                    placeholder="e.g., Build a real-time collaborative document editor with presence, comments, and version history..."
                    value={missionGoal}
                    onChange={(e) => setMissionGoal(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey && missionGoal.trim()) {
                        e.preventDefault();
                        handleStartInterview();
                      }
                    }}
                  />
                </div>

                <div className="planning-examples">
                  <span className="planning-examples-label">Try an example:</span>
                  <div className="planning-example-chips">
                    {EXAMPLE_MISSIONS.map((mission, i) => (
                      <button
                        key={i}
                        className="planning-example-chip"
                        onClick={() => setMissionGoal(mission)}
                      >
                        {mission.length > 45 ? mission.slice(0, 45) + "..." : mission}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div className="planning-view-footer">
                <button
                  className="btn btn-primary planning-start-btn"
                  onClick={() => handleStartInterview()}
                  disabled={!missionGoal.trim()}
                >
                  <Target size={16} style={{ marginRight: "8px" }} />
                  Start Interview
                </button>
              </div>
            </div>
          )}

          {view.type === "loading" && (
            <div className="planning-loading">
              <Loader2 size={40} className="spin" style={{ color: "var(--todo)" }} />
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

          {view.type === "question" && (
            <InterviewQuestionForm
              question={view.question}
              progress={getProgress()}
              onSubmit={handleSubmitResponse}
            />
          )}

          {view.type === "summary" && editedSummary && (
            <MissionPlanReview
              summary={editedSummary}
              onSummaryChange={setEditedSummary}
              onApprove={handleApprovePlan}
              onStartOver={() => {
                setView({ type: "initial" });
                setHasProgress(false);
                setEditedSummary(null);
                setResponseHistory([]);
                streamConnectionRef.current?.close();
                streamConnectionRef.current = null;
              }}
              isCreating={isCreating}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ── Question Form (reused from PlanningModeModal pattern) ────────────────

interface InterviewQuestionFormProps {
  question: PlanningQuestion;
  progress: number;
  onSubmit: (responses: QuestionResponse) => void;
}

function InterviewQuestionForm({ question, progress, onSubmit }: InterviewQuestionFormProps) {
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
          <ArrowRight size={16} style={{ marginLeft: "4px" }} />
        </button>
      </div>
    </div>
  );
}

// ── Mission Plan Review (hierarchical summary view) ──────────────────────

interface MissionPlanReviewProps {
  summary: MissionPlanSummary;
  onSummaryChange: (summary: MissionPlanSummary) => void;
  onApprove: () => void;
  onStartOver: () => void;
  isCreating: boolean;
}

function MissionPlanReview({
  summary,
  onSummaryChange,
  onApprove,
  onStartOver,
  isCreating,
}: MissionPlanReviewProps) {
  const [expandedMilestones, setExpandedMilestones] = useState<Set<number>>(
    () => new Set(summary.milestones.map((_, i) => i))
  );
  const [expandedSlices, setExpandedSlices] = useState<Set<string>>(
    () => {
      const set = new Set<string>();
      summary.milestones.forEach((ms, mi) => {
        ms.slices.forEach((_, si) => set.add(`${mi}-${si}`));
      });
      return set;
    }
  );

  const toggleMilestone = (index: number) => {
    setExpandedMilestones((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const toggleSlice = (key: string) => {
    setExpandedSlices((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const updateMilestone = (index: number, updates: Partial<MissionPlanMilestone>) => {
    const milestones = [...summary.milestones];
    milestones[index] = { ...milestones[index], ...updates };
    onSummaryChange({ ...summary, milestones });
  };

  const updateSlice = (mi: number, si: number, updates: Partial<MissionPlanSlice>) => {
    const milestones = [...summary.milestones];
    const slices = [...milestones[mi].slices];
    slices[si] = { ...slices[si], ...updates };
    milestones[mi] = { ...milestones[mi], slices };
    onSummaryChange({ ...summary, milestones });
  };

  const updateFeature = (mi: number, si: number, fi: number, updates: Partial<MissionPlanFeature>) => {
    const milestones = [...summary.milestones];
    const slices = [...milestones[mi].slices];
    const features = [...slices[si].features];
    features[fi] = { ...features[fi], ...updates };
    slices[si] = { ...slices[si], features };
    milestones[mi] = { ...milestones[mi], slices };
    onSummaryChange({ ...summary, milestones });
  };

  const removeMilestone = (index: number) => {
    const milestones = summary.milestones.filter((_, i) => i !== index);
    onSummaryChange({ ...summary, milestones });
  };

  const removeSlice = (mi: number, si: number) => {
    const milestones = [...summary.milestones];
    milestones[mi] = {
      ...milestones[mi],
      slices: milestones[mi].slices.filter((_, i) => i !== si),
    };
    onSummaryChange({ ...summary, milestones });
  };

  const removeFeature = (mi: number, si: number, fi: number) => {
    const milestones = [...summary.milestones];
    const slices = [...milestones[mi].slices];
    slices[si] = {
      ...slices[si],
      features: slices[si].features.filter((_, i) => i !== fi),
    };
    milestones[mi] = { ...milestones[mi], slices };
    onSummaryChange({ ...summary, milestones });
  };

  const addFeature = (mi: number, si: number) => {
    const milestones = [...summary.milestones];
    const slices = [...milestones[mi].slices];
    slices[si] = {
      ...slices[si],
      features: [...slices[si].features, { title: "New feature", description: "" }],
    };
    milestones[mi] = { ...milestones[mi], slices };
    onSummaryChange({ ...summary, milestones });
  };

  const totalFeatures = summary.milestones.reduce(
    (acc, ms) => acc + ms.slices.reduce((a, sl) => a + sl.features.length, 0),
    0
  );

  return (
    <div className="planning-summary">
      <div className="planning-view-scroll planning-summary-scroll">
        <div className="planning-summary-header">
          <CheckCircle size={24} style={{ color: "var(--color-success)" }} />
          <h4>Mission Plan Ready</h4>
          <p className="text-muted">
            {summary.milestones.length} milestones, {totalFeatures} features. Review and edit before approving.
          </p>
        </div>

        <div className="planning-summary-form">
          {/* Mission title & description */}
          <div className="form-group">
            <label>Mission Title</label>
            <input
              type="text"
              className="form-input"
              value={summary.missionTitle || ""}
              onChange={(e) => onSummaryChange({ ...summary, missionTitle: e.target.value })}
            />
          </div>
          <div className="form-group">
            <label>Mission Description</label>
            <textarea
              className="planning-textarea"
              rows={3}
              value={summary.missionDescription || ""}
              onChange={(e) => onSummaryChange({ ...summary, missionDescription: e.target.value })}
            />
          </div>

          {/* Milestones hierarchy */}
          <div className="form-group">
            <label>Roadmap</label>
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              {summary.milestones.map((milestone, mi) => (
                <div
                  key={mi}
                  style={{
                    border: "1px solid var(--border-primary)",
                    borderRadius: "8px",
                    overflow: "hidden",
                  }}
                >
                  {/* Milestone header */}
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "8px",
                      padding: "10px 12px",
                      background: "var(--bg-secondary)",
                      cursor: "pointer",
                    }}
                    onClick={() => toggleMilestone(mi)}
                  >
                    {expandedMilestones.has(mi) ? (
                      <ChevronDown size={16} style={{ color: "var(--text-secondary)", flexShrink: 0 }} />
                    ) : (
                      <ChevronRight size={16} style={{ color: "var(--text-secondary)", flexShrink: 0 }} />
                    )}
                    <Layers size={16} style={{ color: "var(--icon-milestone)", flexShrink: 0 }} />
                    <input
                      type="text"
                      className="form-input"
                      style={{ flex: 1, padding: "4px 8px", fontSize: "13px", fontWeight: 600 }}
                      value={milestone.title}
                      onChange={(e) => updateMilestone(mi, { title: e.target.value })}
                      onClick={(e) => e.stopPropagation()}
                    />
                    {summary.milestones.length > 1 && (
                      <button
                        className="btn-icon"
                        style={{ flexShrink: 0 }}
                        onClick={(e) => {
                          e.stopPropagation();
                          removeMilestone(mi);
                        }}
                        title="Remove milestone"
                      >
                        <Trash2 size={14} style={{ color: "var(--text-secondary)" }} />
                      </button>
                    )}
                  </div>

                  {expandedMilestones.has(mi) && (
                    <div style={{ padding: "0 12px 12px 36px" }}>
                      <textarea
                        className="planning-textarea"
                        rows={2}
                        placeholder="Milestone description..."
                        style={{ marginTop: "8px", fontSize: "12px" }}
                        value={milestone.description || ""}
                        onChange={(e) => updateMilestone(mi, { description: e.target.value })}
                      />
                      <div style={{ marginTop: "6px" }}>
                        <label style={{ fontSize: "11px", color: "var(--text-secondary)", fontWeight: 500 }}>
                          Verification Criteria
                        </label>
                        <textarea
                          className="planning-textarea"
                          rows={2}
                          placeholder="How to confirm this milestone is complete..."
                          style={{ fontSize: "12px", marginTop: "2px" }}
                          value={milestone.verification || ""}
                          onChange={(e) => updateMilestone(mi, { verification: e.target.value })}
                        />
                      </div>

                      {/* Slices */}
                      {milestone.slices.map((slice, si) => {
                        const sliceKey = `${mi}-${si}`;
                        return (
                          <div
                            key={si}
                            style={{
                              marginTop: "8px",
                              border: "1px solid var(--border-primary)",
                              borderRadius: "6px",
                              overflow: "hidden",
                            }}
                          >
                            <div
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: "6px",
                                padding: "8px 10px",
                                background: "var(--bg-tertiary)",
                                cursor: "pointer",
                              }}
                              onClick={() => toggleSlice(sliceKey)}
                            >
                              {expandedSlices.has(sliceKey) ? (
                                <ChevronDown size={14} style={{ color: "var(--text-secondary)", flexShrink: 0 }} />
                              ) : (
                                <ChevronRight size={14} style={{ color: "var(--text-secondary)", flexShrink: 0 }} />
                              )}
                              <Package size={14} style={{ color: "var(--icon-slice)", flexShrink: 0 }} />
                              <input
                                type="text"
                                className="form-input"
                                style={{ flex: 1, padding: "3px 6px", fontSize: "12px", fontWeight: 500 }}
                                value={slice.title}
                                onChange={(e) => updateSlice(mi, si, { title: e.target.value })}
                                onClick={(e) => e.stopPropagation()}
                              />
                              {milestone.slices.length > 1 && (
                                <button
                                  className="btn-icon"
                                  style={{ flexShrink: 0 }}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    removeSlice(mi, si);
                                  }}
                                  title="Remove slice"
                                >
                                  <Trash2 size={12} style={{ color: "var(--text-secondary)" }} />
                                </button>
                              )}
                            </div>

                            {expandedSlices.has(sliceKey) && (
                              <div style={{ padding: "8px 10px 10px 30px" }}>
                                {/* Slice verification */}
                                <div style={{ marginBottom: "8px" }}>
                                  <label style={{ fontSize: "11px", color: "var(--text-secondary)", fontWeight: 500 }}>
                                    Slice Verification
                                  </label>
                                  <textarea
                                    className="planning-textarea"
                                    rows={1}
                                    placeholder="How to confirm this slice is done..."
                                    style={{ fontSize: "11px", marginTop: "2px" }}
                                    value={slice.verification || ""}
                                    onChange={(e) => updateSlice(mi, si, { verification: e.target.value })}
                                  />
                                </div>
                                {/* Features */}
                                {slice.features.map((feature, fi) => (
                                  <div
                                    key={fi}
                                    style={{
                                      display: "flex",
                                      alignItems: "flex-start",
                                      gap: "6px",
                                      padding: "6px 0",
                                      borderBottom:
                                        fi < slice.features.length - 1
                                          ? "1px solid var(--border-primary)"
                                          : "none",
                                    }}
                                  >
                                    <Box size={12} style={{ color: "var(--icon-feature)", marginTop: "4px", flexShrink: 0 }} />
                                    <div style={{ flex: 1, minWidth: 0 }}>
                                      <input
                                        type="text"
                                        className="form-input"
                                        style={{ width: "100%", padding: "2px 6px", fontSize: "12px" }}
                                        value={feature.title}
                                        onChange={(e) =>
                                          updateFeature(mi, si, fi, { title: e.target.value })
                                        }
                                      />
                                      {feature.description && (
                                        <p
                                          style={{
                                            fontSize: "11px",
                                            color: "var(--text-secondary)",
                                            margin: "2px 0 0 6px",
                                          }}
                                        >
                                          {feature.description}
                                        </p>
                                      )}
                                      {feature.acceptanceCriteria && (
                                        <p
                                          style={{
                                            fontSize: "11px",
                                            color: "var(--text-secondary)",
                                            margin: "2px 0 0 6px",
                                            fontStyle: "italic",
                                          }}
                                        >
                                          AC: {feature.acceptanceCriteria}
                                        </p>
                                      )}
                                    </div>
                                    <button
                                      className="btn-icon"
                                      style={{ flexShrink: 0 }}
                                      onClick={() => removeFeature(mi, si, fi)}
                                      title="Remove feature"
                                    >
                                      <Trash2 size={12} style={{ color: "var(--text-secondary)" }} />
                                    </button>
                                  </div>
                                ))}

                                <button
                                  className="btn"
                                  style={{
                                    fontSize: "11px",
                                    padding: "4px 8px",
                                    marginTop: "6px",
                                    gap: "4px",
                                    display: "flex",
                                    alignItems: "center",
                                  }}
                                  onClick={() => addFeature(mi, si)}
                                >
                                  <Plus size={12} />
                                  Add Feature
                                </button>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="planning-actions planning-summary-actions">
        <button className="btn" onClick={onStartOver} disabled={isCreating}>
          <ArrowLeft size={16} style={{ marginRight: "4px" }} />
          Start Over
        </button>
        <button
          className="btn btn-primary"
          onClick={onApprove}
          disabled={isCreating || summary.milestones.length === 0}
        >
          {isCreating ? (
            <>
              <Loader2 size={16} className="spin" style={{ marginRight: "8px" }} />
              Creating Mission...
            </>
          ) : (
            <>
              <CheckCircle size={16} style={{ marginRight: "8px" }} />
              Approve Plan
            </>
          )}
        </button>
      </div>
    </div>
  );
}
