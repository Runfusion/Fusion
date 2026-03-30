import { useState, useCallback, useEffect, useRef } from "react";
import type { Task, PlanningQuestion, PlanningSummary } from "@kb/core";
import {
  startPlanning,
  respondToPlanning,
  cancelPlanning,
  createTaskFromPlanning,
  type PlanningSession,
} from "../api";
import { Lightbulb, X, Loader2, CheckCircle, ArrowLeft, ArrowRight, Sparkles } from "lucide-react";

interface PlanningModeModalProps {
  isOpen: boolean;
  onClose: () => void;
  onTaskCreated: (task: Task) => void;
  tasks: Task[];
  initialPlan?: string;
}

interface QuestionResponse {
  [key: string]: unknown;
}

type ViewState =
  | { type: "initial" }
  | { type: "question"; session: PlanningSession }
  | { type: "summary"; session: PlanningSession; summary: PlanningSummary }
  | { type: "loading" };

const EXAMPLE_PLANS = [
  "Build a user authentication system with login and signup",
  "Add dark mode support to the dashboard",
  "Create an API endpoint for exporting tasks as CSV",
  "Refactor the task card component for better performance",
];

export function PlanningModeModal({ isOpen, onClose, onTaskCreated, tasks, initialPlan: initialPlanProp }: PlanningModeModalProps) {
  const [initialPlan, setInitialPlan] = useState("");
  const [view, setView] = useState<ViewState>({ type: "initial" });
  const [error, setError] = useState<string | null>(null);
  const [responseHistory, setResponseHistory] = useState<QuestionResponse[]>([]);
  const [editedSummary, setEditedSummary] = useState<PlanningSummary | null>(null);
  const [hasAutoStarted, setHasAutoStarted] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Focus textarea when opening
  useEffect(() => {
    if (isOpen && view.type === "initial") {
      textareaRef.current?.focus();
    }
  }, [isOpen, view.type]);

  // Auto-start planning when initialPlan prop is provided
  useEffect(() => {
    if (isOpen && initialPlanProp && !hasAutoStarted && view.type === "initial") {
      setInitialPlan(initialPlanProp);
      setHasAutoStarted(true);
      // Use a small timeout to allow state update to propagate before starting
      const timer = setTimeout(() => {
        handleStartPlanningWithPlan(initialPlanProp);
      }, 0);
      return () => clearTimeout(timer);
    }
  }, [isOpen, initialPlanProp, hasAutoStarted, view.type]);

  // Reset hasAutoStarted when modal closes
  useEffect(() => {
    if (!isOpen) {
      setHasAutoStarted(false);
    }
  }, [isOpen]);

  // Handle browser unload during active session
  useEffect(() => {
    if (!isOpen) return;

    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (view.type === "question" || view.type === "summary") {
        e.preventDefault();
        e.returnValue = "";
      }
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [isOpen, view]);

  // Handle escape key to close
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (view.type === "question" || view.type === "summary") {
          if (confirm("Are you sure you want to close? Your planning progress will be lost.")) {
            handleCancel();
          }
        } else {
          handleCancel();
        }
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, view]);

  const handleStartPlanning = useCallback(async () => {
    if (!initialPlan.trim()) return;

    setError(null);
    setView({ type: "loading" });

    try {
      const session = await startPlanning(initialPlan.trim());
      if (session.currentQuestion) {
        setView({ type: "question", session });
      } else if (session.summary) {
        setView({ type: "summary", session, summary: session.summary });
        setEditedSummary(session.summary);
      }
      setResponseHistory([]);
    } catch (err: any) {
      setError(err.message || "Failed to start planning session");
      setView({ type: "initial" });
    }
  }, [initialPlan]);

  // Helper for auto-start with a specific plan (from prop)
  const handleStartPlanningWithPlan = useCallback(async (plan: string) => {
    if (!plan.trim()) return;

    setError(null);
    setView({ type: "loading" });

    try {
      const session = await startPlanning(plan.trim());
      if (session.currentQuestion) {
        setView({ type: "question", session });
      } else if (session.summary) {
        setView({ type: "summary", session, summary: session.summary });
        setEditedSummary(session.summary);
      }
      setResponseHistory([]);
    } catch (err: any) {
      setError(err.message || "Failed to start planning session");
      setView({ type: "initial" });
    }
  }, []);

  const handleSubmitResponse = useCallback(
    async (responses: QuestionResponse) => {
      if (view.type !== "question") return;

      const { session } = view;
      setError(null);
      setView({ type: "loading" });

      try {
        const updatedSession = await respondToPlanning(session.sessionId, responses);
        setResponseHistory((prev) => [...prev, responses]);

        if (updatedSession.summary) {
          setView({ type: "summary", session: updatedSession, summary: updatedSession.summary });
          setEditedSummary(updatedSession.summary);
        } else if (updatedSession.currentQuestion) {
          setView({ type: "question", session: updatedSession });
        }
      } catch (err: any) {
        setError(err.message || "Failed to submit response");
        setView({ type: "question", session });
      }
    },
    [view]
  );

  const handleCancel = useCallback(async () => {
    if (view.type === "question" || view.type === "summary") {
      try {
        await cancelPlanning(view.session.sessionId);
      } catch {
        // Ignore errors on cancel
      }
    }
    setInitialPlan("");
    setView({ type: "initial" });
    setError(null);
    setResponseHistory([]);
    setEditedSummary(null);
    onClose();
  }, [view, onClose]);

  const handleCreateTask = useCallback(async () => {
    if (view.type !== "summary") return;

    setError(null);
    setView({ type: "loading" });

    try {
      const task = await createTaskFromPlanning(view.session.sessionId);
      onTaskCreated(task);
      handleCancel();
    } catch (err: any) {
      setError(err.message || "Failed to create task");
      setView({ type: "summary", session: view.session, summary: view.summary });
    }
  }, [view, onTaskCreated, handleCancel]);

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
                    onChange={(e) => setInitialPlan(e.target.value.slice(0, 500))}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey && initialPlan.trim()) {
                        e.preventDefault();
                        handleStartPlanning();
                      }
                    }}
                    maxLength={500}
                  />
                  <div className="planning-char-count">
                    {initialPlan.length}/500 characters
                  </div>
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
                <button
                  className="btn btn-primary planning-start-btn"
                  onClick={handleStartPlanning}
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
              <p>Thinking...</p>
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
              onRefine={() => {
                // Reset to question mode for more refinement
                setView({ type: "question", session: view.session });
              }}
              isLoading={false}
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
  onRefine: () => void;
  isLoading: boolean;
}

function SummaryView({
  summary,
  onSummaryChange,
  tasks,
  onCreateTask,
  onRefine,
  isLoading,
}: SummaryViewProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [selectedDependencies, setSelectedDependencies] = useState<string[]>(
    summary.suggestedDependencies
  );

  const handleSizeChange = (size: "S" | "M" | "L") => {
    onSummaryChange({ ...summary, suggestedSize: size });
  };

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
            <div className="planning-size-selector">
              {(["S", "M", "L"] as const).map((size) => (
                <button
                  key={size}
                  type="button"
                  className={`planning-size-btn ${summary.suggestedSize === size ? "selected" : ""}`}
                  onClick={() => handleSizeChange(size)}
                >
                  {size}
                  <span className="planning-size-label">
                    {size === "S" ? "Small" : size === "M" ? "Medium" : "Large"}
                  </span>
                </button>
              ))}
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
          <ArrowLeft size={16} style={{ marginRight: "4px" }} />
          Refine Further
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
  );
}
