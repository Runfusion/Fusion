import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import type { Task, PlanningQuestion, PlanningSummary } from "@fusion/core";
import {
  startPlanningStreaming,
  respondToPlanning,
  createTaskFromPlanning,
  connectPlanningStream,
  fetchAiSession,
  startPlanningBreakdown,
  createTasksFromPlanning,
  fetchModels,
  type PlanningSession,
  type SubtaskItem,
  type ModelInfo,
} from "../api";
import {
  savePlanningDescription,
  getPlanningDescription,
  clearPlanningDescription,
} from "../hooks/modalPersistence";
import { Lightbulb, X, Loader2, CheckCircle, ArrowLeft, ArrowRight, Sparkles, ListTree, GripVertical, ArrowUp, ArrowDown, Plus, Trash2 } from "lucide-react";
import { CustomModelDropdown } from "./CustomModelDropdown";

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
  | { type: "breakdown"; sessionId: string; subtasks: SubtaskItem[]; dirty: boolean }
  | { type: "loading" }
  | { type: "creating" };

const EXAMPLE_PLANS = [
  "Build a user authentication system with login and signup",
  "Add dark mode support to the dashboard",
  "Create an API endpoint for exporting tasks as CSV",
  "Refactor the task card component for better performance",
];

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
  const [editedSummary, setEditedSummary] = useState<PlanningSummary | null>(null);
  // Use ref instead of state for hasAutoStarted to handle React StrictMode double-render.
  // In StrictMode, components render twice but state persists across renders,
  // which would skip auto-start on the second (committed) render. Refs are
  // re-initialized on each render, ensuring the auto-start effect runs correctly.
  const hasAutoStartedRef = useRef(false);
  const [streamingOutput, setStreamingOutput] = useState<string>("");
  const [showThinking, setShowThinking] = useState(true);
  const [isReconnecting, setIsReconnecting] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const streamConnectionRef = useRef<{ close: () => void; isConnected: () => boolean } | null>(null);
  const currentSessionIdRef = useRef<string | null>(null);
  const [planningModelProvider, setPlanningModelProvider] = useState<string | undefined>(undefined);
  const [planningModelId, setPlanningModelId] = useState<string | undefined>(undefined);
  const [loadedModels, setLoadedModels] = useState<ModelInfo[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [favoriteProviders, setFavoriteProviders] = useState<string[]>([]);
  const [favoriteModels, setFavoriteModels] = useState<string[]>([]);

  const planningSelectionValue = getModelSelectionValue(planningModelProvider, planningModelId);

  const getModelBadgeLabel = useCallback(
    (provider?: string, modelId?: string) => {
      if (!provider || !modelId) return "Using default";
      const matched = loadedModels.find((model) => model.provider === provider && model.id === modelId);
      return matched ? `${matched.provider}/${matched.id}` : `${provider}/${modelId}`;
    },
    [loadedModels],
  );

  const loadModels = useCallback(async () => {
    setModelsLoading(true);
    setModelsError(null);

    try {
      const response = await fetchModels();
      setLoadedModels(response.models);
      setFavoriteProviders(response.favoriteProviders);
      setFavoriteModels(response.favoriteModels);
    } catch (err: any) {
      setModelsError(err?.message || "Failed to load models");
    } finally {
      setModelsLoading(false);
    }
  }, []);

  const handleToggleFavoriteProvider = useCallback((provider: string) => {
    setFavoriteProviders((prev) =>
      prev.includes(provider) ? prev.filter((item) => item !== provider) : [...prev, provider],
    );
  }, []);

  const handleToggleFavoriteModel = useCallback((modelId: string) => {
    setFavoriteModels((prev) =>
      prev.includes(modelId) ? prev.filter((item) => item !== modelId) : [...prev, modelId],
    );
  }, []);

  const handleStartPlanning = useCallback(async (planOverride?: string) => {
    const plan = planOverride ?? initialPlan;
    if (!plan.trim()) return;

    setError(null);
    setStreamingOutput("");
    setIsReconnecting(false);
    setView({ type: "loading" });

    try {
      // Use streaming mode for real-time AI thinking display
      const modelOverride =
        planningModelProvider && planningModelId
          ? { planningModelProvider, planningModelId }
          : undefined;

      const { sessionId } = await startPlanningStreaming(plan.trim(), projectId, modelOverride);
      currentSessionIdRef.current = sessionId;

      // Connect to SSE stream
      const connection = connectPlanningStream(sessionId, projectId, {
        onThinking: (data) => {
          setStreamingOutput((prev) => prev + data);
        },
        onQuestion: (question) => {
          setIsReconnecting(false);
          clearPlanningDescription();
          setView({
            type: "question",
            session: { sessionId, currentQuestion: question, summary: null },
          });
          setStreamingOutput("");
        },
        onSummary: (summary) => {
          setIsReconnecting(false);
          clearPlanningDescription();
          setView({
            type: "summary",
            session: { sessionId, currentQuestion: null, summary },
            summary,
          });
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
      setResponseHistory([]);
    } catch (err: any) {
      setIsReconnecting(false);
      setError(err.message || "Failed to start planning session");
      setView({ type: "initial" });
      currentSessionIdRef.current = null;
    }
  }, [initialPlan, planningModelId, planningModelProvider, projectId]);

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
    } else if (isOpen && !initialPlanProp && !hasAutoStartedRef.current && view.type === "initial") {
      // Check localStorage for persisted description when no prop provided
      const persisted = getPlanningDescription();
      if (persisted) {
        setInitialPlan(persisted);
      }
    }
  }, [isOpen, initialPlanProp, view.type, handleStartPlanning]);

  // Resume a persisted background session
  useEffect(() => {
    if (!isOpen || !resumeSessionId || view.type !== "initial") return;
    let cancelled = false;
    (async () => {
      try {
        const session = await fetchAiSession(resumeSessionId);
        if (cancelled || !session) return;

        currentSessionIdRef.current = resumeSessionId;

        if (session.status === "awaiting_input" && session.currentQuestion) {
          clearPlanningDescription();
          const question = JSON.parse(session.currentQuestion);
          setView({ type: "question", session: { sessionId: resumeSessionId, currentQuestion: question, summary: null } });
          if (session.thinkingOutput) setStreamingOutput(session.thinkingOutput);
        } else if (session.status === "complete" && session.result) {
          clearPlanningDescription();
          const summary = JSON.parse(session.result);
          setView({ type: "summary", session: { sessionId: resumeSessionId, currentQuestion: null, summary }, summary });
          setEditedSummary(summary);
        } else if (session.status === "generating") {
          setView({ type: "loading" });
          if (session.thinkingOutput) setStreamingOutput(session.thinkingOutput);
          // Connect to live SSE stream to pick up new events
          const connection = connectPlanningStream(resumeSessionId, projectId, {
            onThinking: (data) => setStreamingOutput((prev) => prev + data),
            onQuestion: (question) => {
              setIsReconnecting(false);
              clearPlanningDescription();
              setView({ type: "question", session: { sessionId: resumeSessionId, currentQuestion: question, summary: null } });
              setStreamingOutput("");
            },
            onSummary: (summary) => {
              setIsReconnecting(false);
              clearPlanningDescription();
              setView({ type: "summary", session: { sessionId: resumeSessionId, currentQuestion: null, summary }, summary });
              setEditedSummary(summary);
              setStreamingOutput("");
            },
            onError: (message) => {
              setIsReconnecting(false);
              setError(message);
              setView({ type: "initial" });
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
          setError(session.error || "Session failed");
          setView({ type: "initial" });
        }
      } catch {
        setError("Failed to resume session");
      }
    })();
    return () => { cancelled = true; };
  }, [isOpen, resumeSessionId, view.type, projectId]);

  // Reset hasAutoStarted when modal closes
  useEffect(() => {
    if (!isOpen) {
      hasAutoStartedRef.current = false;
      setIsReconnecting(false);
    }
  }, [isOpen]);

  // Cleanup stream connection on unmount
  useEffect(() => {
    return () => {
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

  const handleCancel = useCallback(() => {
    // Save to localStorage BEFORE any cleanup (preserve for re-entry)
    if (initialPlan) {
      savePlanningDescription(initialPlan);
    }

    // Always close the stream connection
    streamConnectionRef.current?.close();
    streamConnectionRef.current = null;

    setInitialPlan("");
    setView({ type: "initial" });
    setError(null);
    setResponseHistory([]);
    setEditedSummary(null);
    setStreamingOutput("");
    setIsReconnecting(false);
    setPlanningModelProvider(undefined);
    setPlanningModelId(undefined);
    currentSessionIdRef.current = null;
    onClose();
  }, [initialPlan, onClose]);

  // Handle escape key to close
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        handleCancel();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, handleCancel]);

  const handleSubmitResponse = useCallback(
    async (responses: QuestionResponse) => {
      if (view.type !== "question") return;

      const { session } = view;
      const sessionId = session.sessionId;
      setError(null);

      // Keep the existing SSE connection alive - do NOT close it!
      // The connection established in handleStartPlanning will continue
      // to receive events (thinking, question, summary) throughout the session.
      // This prevents the race condition where events are missed because
      // the frontend disconnects and reconnects after the API call.

      setView({ type: "loading" });
      setStreamingOutput(""); // Clear old thinking output when entering loading state

      try {
        // Submit response - AI will broadcast events via the already-connected stream
        await respondToPlanning(sessionId, responses, projectId);
        setResponseHistory((prev) => [...prev, responses]);
        // Events (question/summary) will arrive via the existing SSE stream
      } catch (err: any) {
        setError(err.message || "Failed to submit response");
        setView({ type: "question", session });
      }
    },
    [view]
  );

  const handleCreateTask = useCallback(async () => {
    if (view.type !== "summary") return;

    setError(null);
    setView({ type: "loading" });

    try {
      const task = await createTaskFromPlanning(view.session.sessionId, projectId);
      onTaskCreated(task);
      handleCancel();
    } catch (err: any) {
      setError(err.message || "Failed to create task");
      setView({ type: "summary", session: view.session, summary: view.summary });
    }
  }, [view, onTaskCreated, handleCancel]);

  const handleStartBreakdown = useCallback(async () => {
    if (view.type !== "summary") return;

    setError(null);
    setView({ type: "loading" });

    try {
      const result = await startPlanningBreakdown(view.session.sessionId, projectId);
      setView({
        type: "breakdown",
        sessionId: result.sessionId,
        subtasks: result.subtasks,
        dirty: false,
      });
    } catch (err: any) {
      setError(err.message || "Failed to start breakdown");
      setView({ type: "summary", session: view.session, summary: view.summary });
    }
  }, [view, projectId]);

  const handleCreateTasksFromBreakdown = useCallback(async () => {
    if (view.type !== "breakdown") return;

    setError(null);
    setView({ type: "creating" });

    try {
      const result = await createTasksFromPlanning(view.sessionId, view.subtasks, projectId);
      onTasksCreated(result.tasks);
      // Reset and close
      setInitialPlan("");
      setView({ type: "initial" });
      setError(null);
      setResponseHistory([]);
      setEditedSummary(null);
      setStreamingOutput("");
      setPlanningModelProvider(undefined);
      setPlanningModelId(undefined);
      currentSessionIdRef.current = null;
      onClose();
    } catch (err: any) {
      setError(err.message || "Failed to create tasks");
      setView({ type: "breakdown", sessionId: view.sessionId, subtasks: view.subtasks, dirty: view.dirty });
    }
  }, [view, onTasksCreated, onClose, projectId]);

  const handleBack = useCallback(() => {
    if (view.type === "question" && responseHistory.length > 0) {
      // Remove last response and go back
      const previousResponses = responseHistory.slice(0, -1);
      setResponseHistory(previousResponses);
      // Note: We don't actually have a way to go back in the backend,
      // so we just reset to the question from the initial session
      setView({ type: "question", session: view.session });
    }
  }, [view, responseHistory]);

  const getProgress = () => {
    if (view.type === "question") {
      return Math.min(responseHistory.length + 1, 3);
    }
    return 3;
  };

  if (!isOpen) return null;

  return (
    <div className="modal-overlay open" onClick={(e) => e.target === e.currentTarget && handleCancel()}>
      <div className="modal modal-lg planning-modal">
        <div className="modal-header">
          <div className="detail-title-row">
            <Lightbulb size={20} style={{ color: "var(--triage)" }} />
            <h3>Planning Mode</h3>
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
                  <h4>Transform your idea into a detailed task</h4>
                  <p className="text-muted">
                    Describe what you want to build in plain language. The AI will ask clarifying
                    questions and help you structure a well-defined task.
                  </p>
                </div>

                <div className="form-group">
                  <label htmlFor="initial-plan">What do you want to build?</label>
                  <textarea
                    ref={textareaRef}
                    id="initial-plan"
                    rows={4}
                    className="planning-textarea"
                    placeholder="e.g., Build a user authentication system with login, signup, and password reset..."
                    value={initialPlan}
                    onChange={(e) => setInitialPlan(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey && initialPlan.trim()) {
                        e.preventDefault();
                        handleStartPlanning();
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
              </div>

              <div className="planning-view-footer">
                <div
                  className="model-select-row"
                  style={{
                    marginRight: "auto",
                    minWidth: "min(100%, 320px)",
                    maxWidth: "420px",
                    textAlign: "left",
                  }}
                >
                  <label htmlFor="planning-modal-model" className="model-select-label">
                    Planning Model
                    {modelsLoading && (
                      <span className="text-muted" style={{ marginLeft: "8px", fontSize: "12px" }}>
                        Loading models…
                      </span>
                    )}
                  </label>
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
                    <div className="form-hint" style={{ marginTop: "6px", fontSize: "12px", color: "var(--color-error)" }}>
                      {modelsError}{" "}
                      <button
                        type="button"
                        onClick={() => {
                          void loadModels();
                        }}
                        style={{
                          fontSize: "12px",
                          background: "none",
                          border: "none",
                          color: "inherit",
                          textDecoration: "underline",
                          cursor: "pointer",
                          padding: 0,
                        }}
                      >
                        Retry
                      </button>
                    </div>
                  )}
                  <div className="model-selector-current" style={{ marginTop: "8px" }}>
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

                <button
                  className="btn btn-primary planning-start-btn"
                  onClick={() => handleStartPlanning()}
                  disabled={!initialPlan.trim()}
                >
                  <Lightbulb size={16} style={{ marginRight: "8px" }} />
                  Start Planning
                </button>
              </div>
            </div>
          )}

          {view.type === "loading" && (
            <div className="planning-loading">
              <Loader2 size={40} className="spin" style={{ color: "var(--todo)" }} />
              <p>{streamingOutput ? "AI is thinking..." : "Generating next question..."}</p>
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

          {view.type === "creating" && (
            <div className="planning-loading">
              <Loader2 size={40} className="spin" style={{ color: "var(--todo)" }} />
              <p>Creating tasks...</p>
            </div>
          )}

          {view.type === "question" && view.session.currentQuestion && (
            <div className="planning-question">
              <QuestionForm
                question={view.session.currentQuestion}
                progress={getProgress()}
                onSubmit={handleSubmitResponse}
                onBack={responseHistory.length > 0 ? handleBack : undefined}
              />
            </div>
          )}

          {view.type === "summary" && editedSummary && (
            <SummaryView
              summary={editedSummary}
              onSummaryChange={setEditedSummary}
              tasks={tasks}
              onCreateTask={handleCreateTask}
              onBreakIntoTasks={handleStartBreakdown}
              onRefine={() => {
                // Reset to question mode for more refinement
                setView({ type: "question", session: view.session });
              }}
              isLoading={false}
            />
          )}

          {view.type === "breakdown" && (
            <BreakdownView
              subtasks={view.subtasks}
              dirty={view.dirty}
              isLoading={false}
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
      </div>
    </div>
  );
}

interface QuestionFormProps {
  question: PlanningQuestion;
  progress: number;
  onSubmit: (responses: QuestionResponse) => void;
  onBack?: () => void;
}

function QuestionForm({ question, progress, onSubmit, onBack }: QuestionFormProps) {
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

  // Reset state when question changes
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
        {onBack && (
          <button className="btn" onClick={onBack}>
            <ArrowLeft size={16} style={{ marginRight: "4px" }} />
            Back
          </button>
        )}
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

interface SummaryViewProps {
  summary: PlanningSummary;
  onSummaryChange: (summary: PlanningSummary) => void;
  tasks: Task[];
  onCreateTask: () => void;
  onBreakIntoTasks: () => void;
  onRefine: () => void;
  isLoading: boolean;
}

function SummaryView({
  summary,
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
        <div className="planning-summary-header">
          <CheckCircle size={24} style={{ color: "var(--color-success)" }} />
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
              className={`planning-textarea ${isExpanded ? "expanded" : ""}`}
              rows={isExpanded ? 10 : 4}
              value={summary.description}
              onChange={(e) => onSummaryChange({ ...summary, description: e.target.value })}
            />
          </div>

          <div className="form-group">
            <label>Suggested Size</label>
            <select
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
          <ArrowLeft size={16} style={{ marginRight: "4px" }} />
          Refine Further
        </button>
        <div className="planning-summary-actions-right">
          <button
            className="btn"
            onClick={onBreakIntoTasks}
            disabled={isLoading}
            title="Break the plan into multiple tasks with dependencies"
          >
            {isLoading ? (
              <>
                <Loader2 size={16} className="spin" style={{ marginRight: "8px" }} />
                Breaking down...
              </>
            ) : (
              <>
                <ListTree size={16} style={{ marginRight: "8px" }} />
                Break into Tasks
              </>
            )}
          </button>
          <button
            className="btn btn-primary"
            onClick={onCreateTask}
            disabled={isLoading}
          >
            {isLoading ? (
              <>
                <Loader2 size={16} className="spin" style={{ marginRight: "8px" }} />
                Creating...
              </>
            ) : (
              <>
                <CheckCircle size={16} style={{ marginRight: "8px" }} />
                Create Task
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
    dependsOn: [],
  };
}

interface BreakdownViewProps {
  subtasks: SubtaskItem[];
  dirty: boolean;
  isLoading: boolean;
  onUpdateSubtasks: (subtasks: SubtaskItem[]) => void;
  onCreateTasks: () => void;
  onBack: () => void;
}

function BreakdownView({
  subtasks,
  dirty: _dirty,
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
          <ListTree size={24} style={{ color: "var(--triage)" }} />
          <h4>Break into Tasks</h4>
          <p className="text-muted">
            Review and edit the subtasks generated from your plan. Adjust titles,
            descriptions, sizes, and dependencies before creating.
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
                  className="detail-title-row subtask-item-header"
                  style={{ justifyContent: "space-between" }}
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

                <div className="form-group">
                  <label>Size</label>
                  <select
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
            <Plus size={16} style={{ marginRight: 6 }} /> Add subtask
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
          <ArrowLeft size={16} style={{ marginRight: "4px" }} />
          Back to Summary
        </button>
        <button
          className="btn btn-primary"
          onClick={onCreateTasks}
          disabled={isLoading || isInvalid}
        >
          {isLoading ? (
            <>
              <Loader2 size={16} className="spin" style={{ marginRight: 8 }} />
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
