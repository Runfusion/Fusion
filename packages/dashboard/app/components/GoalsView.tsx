import { useEffect, useMemo, useRef, useState } from "react";
import type { Goal } from "@fusion/core";
import { Plus, Sparkles } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { draftGoalDescription, getRefineErrorMessage } from "../api";
import "./GoalsView.css";

export interface GoalsViewProps {
  initialGoals?: Goal[];
  anchorGoalId?: string;
}

const MAX_ACTIVE_GOALS = 5;
const WARNING_THRESHOLD = 3;

const CAP_ERROR_MESSAGE = "Cannot activate more than 5 goals. Resolve an active goal before activating another.";
const GOAL_DESCRIPTION_TOGGLE_LENGTH = 280;

function isCapError(payload: unknown): boolean {
  return Boolean(payload && typeof payload === "object" && "code" in payload && (payload as { code?: unknown }).code === "ACTIVE_GOAL_LIMIT_EXCEEDED");
}

export function GoalsView({ initialGoals, anchorGoalId }: GoalsViewProps) {
  const [goals, setGoals] = useState<Goal[]>(() => initialGoals ?? []);
  const [highlightedGoalId, setHighlightedGoalId] = useState<string | null>(null);
  const anchorTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [loading, setLoading] = useState<boolean>(initialGoals === undefined);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const [isAddFormOpen, setIsAddFormOpen] = useState(false);
  const [addTitle, setAddTitle] = useState("");
  const [addDescription, setAddDescription] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [isDraftingDescription, setIsDraftingDescription] = useState(false);

  const [editGoalId, setEditGoalId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editError, setEditError] = useState<string | null>(null);
  const [isSavingEdit, setIsSavingEdit] = useState(false);
  const [expandedGoalDescriptions, setExpandedGoalDescriptions] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    if (initialGoals !== undefined) {
      return;
    }

    let active = true;
    const loadGoals = async () => {
      try {
        setLoading(true);
        setErrorMessage(null);
        const response = await fetch("/api/goals");
        if (!response.ok) {
          throw new Error(`Failed to load goals (${response.status})`);
        }

        const payload = (await response.json()) as { goals?: Goal[] };
        if (!active) {
          return;
        }
        setGoals(Array.isArray(payload.goals) ? payload.goals : []);
      } catch {
        if (!active) {
          return;
        }
        setErrorMessage("Unable to load goals right now. Please try again.");
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    };

    void loadGoals();

    return () => {
      active = false;
    };
  }, [initialGoals]);

  const activeCount = useMemo(() => goals.filter((goal) => goal.status === "active").length, [goals]);
  const showWarning = activeCount >= WARNING_THRESHOLD && activeCount <= MAX_ACTIVE_GOALS;

  useEffect(() => {
    if (!anchorGoalId) {
      setHighlightedGoalId(null);
      return;
    }

    const target = document.getElementById(`goal-card-${anchorGoalId}`);
    if (!target) {
      return;
    }

    setHighlightedGoalId(anchorGoalId);
    if (typeof target.scrollIntoView === "function") {
      target.scrollIntoView({ behavior: "smooth", block: "center" });
    }

    if (anchorTimeoutRef.current) {
      clearTimeout(anchorTimeoutRef.current);
    }
    anchorTimeoutRef.current = setTimeout(() => {
      setHighlightedGoalId((current) => (current === anchorGoalId ? null : current));
      anchorTimeoutRef.current = null;
    }, 1600);

    return () => {
      if (anchorTimeoutRef.current) {
        clearTimeout(anchorTimeoutRef.current);
        anchorTimeoutRef.current = null;
      }
    };
  }, [anchorGoalId, goals]);

  function openAddForm() {
    setErrorMessage(null);
    setAddError(null);
    setIsAddFormOpen(true);
  }

  function openEdit(goal: Goal) {
    setEditGoalId(goal.id);
    setEditTitle(goal.title);
    setEditDescription(goal.description ?? "");
    setEditError(null);
  }

  function cancelEdit() {
    setEditGoalId(null);
    setEditTitle("");
    setEditDescription("");
    setEditError(null);
  }

  function closeAddForm() {
    setIsAddFormOpen(false);
    setAddTitle("");
    setAddDescription("");
    setAddError(null);
    setIsDraftingDescription(false);
  }

  async function draftAddGoalDescription() {
    const title = addTitle.trim();
    if (!title) {
      setAddError("Title is required.");
      return;
    }

    try {
      setIsDraftingDescription(true);
      setAddError(null);
      const description = await draftGoalDescription(title);
      setAddDescription(description);
    } catch (error) {
      setAddError(getRefineErrorMessage(error));
    } finally {
      setIsDraftingDescription(false);
    }
  }

  async function submitAddGoal() {
    const title = addTitle.trim();
    if (!title) {
      setAddError("Title is required.");
      return;
    }

    try {
      setIsCreating(true);
      setAddError(null);
      setErrorMessage(null);
      const response = await fetch("/api/goals", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          title,
          description: addDescription,
        }),
      });

      if (response.ok) {
        const createdGoal = (await response.json()) as Goal;
        setGoals((current) => [...current, createdGoal]);
        closeAddForm();
        return;
      }

      let payload: unknown = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }

      if (response.status === 409 && isCapError(payload)) {
        setErrorMessage(CAP_ERROR_MESSAGE);
        return;
      }

      setAddError("Unable to create goal right now. Please try again.");
    } catch {
      setAddError("Unable to create goal right now. Please try again.");
    } finally {
      setIsCreating(false);
    }
  }

  async function saveEditGoal() {
    if (!editGoalId) {
      return;
    }

    const title = editTitle.trim();
    if (!title) {
      setEditError("Title is required.");
      return;
    }

    try {
      setIsSavingEdit(true);
      setEditError(null);
      const response = await fetch(`/api/goals/${editGoalId}`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ title, description: editDescription }),
      });

      if (!response.ok) {
        throw new Error(`Failed to update goal (${response.status})`);
      }

      const updatedGoal = (await response.json()) as Goal;
      setGoals((current) => current.map((goal) => (goal.id === updatedGoal.id ? updatedGoal : goal)));
      cancelEdit();
    } catch {
      setEditError("Unable to save goal right now. Please try again.");
    } finally {
      setIsSavingEdit(false);
    }
  }

  function isDescriptionToggleVisible(description: string): boolean {
    return description.length > GOAL_DESCRIPTION_TOGGLE_LENGTH || description.includes("\n");
  }

  function toggleGoalDescription(goalId: string) {
    setExpandedGoalDescriptions((current) => {
      const next = new Set(current);
      if (next.has(goalId)) {
        next.delete(goalId);
      } else {
        next.add(goalId);
      }
      return next;
    });
  }

  async function updateGoalArchiveStatus(goal: Goal) {
    const endpoint = goal.status === "active" ? `/api/goals/${goal.id}/archive` : `/api/goals/${goal.id}/unarchive`;

    try {
      setErrorMessage(null);
      const response = await fetch(endpoint, {
        method: "POST",
      });

      if (response.ok) {
        const updatedGoal = (await response.json()) as Goal;
        setGoals((current) => current.map((entry) => (entry.id === updatedGoal.id ? updatedGoal : entry)));
        return;
      }

      let payload: unknown = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }

      if (response.status === 409 && isCapError(payload)) {
        setErrorMessage(CAP_ERROR_MESSAGE);
        return;
      }

      setErrorMessage("Unable to update goal status right now. Please try again.");
    } catch {
      setErrorMessage("Unable to update goal status right now. Please try again.");
    }
  }

  return (
    <section className="goals-view" data-testid="goals-view">
      <header className="goals-header">
        <div>
          <h2 className="goals-title">Goals</h2>
          <p className="goals-count" data-testid="goals-active-count">
            {activeCount} active goals
          </p>
        </div>
        <button type="button" className="btn btn-primary goals-add-button" onClick={openAddForm} data-testid="goals-add-button">
          <Plus aria-hidden="true" />
          Add Goal
        </button>
      </header>

      {isAddFormOpen ? (
        <div className="card goals-form" data-testid="goals-form">
          <label className="goals-form-label" htmlFor="goals-form-title">
            Title
          </label>
          <input
            id="goals-form-title"
            className="input"
            type="text"
            value={addTitle}
            maxLength={200}
            onChange={(event) => setAddTitle(event.target.value)}
            data-testid="goals-form-title"
          />
          <div className="goals-form-label-row">
            <label className="goals-form-label" htmlFor="goals-form-description">
              Description
            </label>
            <button
              type="button"
              className="btn goals-form-draft-button"
              onClick={() => void draftAddGoalDescription()}
              disabled={!addTitle.trim() || isDraftingDescription}
              data-testid="goals-form-draft-ai"
            >
              <Sparkles aria-hidden="true" />
              {isDraftingDescription ? "Drafting…" : "Draft with AI"}
            </button>
          </div>
          <textarea
            id="goals-form-description"
            className="input"
            value={addDescription}
            maxLength={5000}
            onChange={(event) => setAddDescription(event.target.value)}
            data-testid="goals-form-description"
          />
          {addError ? (
            <p className="form-error goals-error" role="alert">
              {addError}
            </p>
          ) : null}
          <div className="goals-form-actions">
            <button type="button" className="btn btn-primary" onClick={() => void submitAddGoal()} disabled={isCreating || isDraftingDescription} data-testid="goals-form-submit">
              Save
            </button>
            <button type="button" className="btn" onClick={closeAddForm} disabled={isCreating || isDraftingDescription} data-testid="goals-form-cancel">
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {showWarning ? (
        <p className="goals-warning" role="status">
          Approaching the 5-active goal cap. Keep active goals focused.
        </p>
      ) : null}

      {errorMessage ? (
        <p className="form-error goals-error" role="alert" data-testid="goals-error">
          {errorMessage}
        </p>
      ) : null}

      {loading ? (
        <p className="goals-loading" role="status" data-testid="goals-loading">
          Loading goals…
        </p>
      ) : null}

      {!loading && goals.length === 0 ? (
        <div className="goals-empty card" data-testid="goals-empty-state">
          No goals yet. Add one to begin tracking strategic outcomes.
        </div>
      ) : null}

      {!loading && goals.length > 0 ? (
        <div className="goals-list" data-testid="goals-list">
          {goals.map((goal) => (
            <article
              key={goal.id}
              id={`goal-card-${goal.id}`}
              className={`card goals-card ${goal.status === "archived" ? "goals-card-archived" : ""} ${highlightedGoalId === goal.id ? "goals-card--anchored" : ""}`.trim()}
              data-testid={`goal-card-${goal.id}`}
            >
              {editGoalId === goal.id ? (
                <div className="goals-card-main goals-card-edit">
                  <label className="goals-form-label" htmlFor={`goal-edit-title-${goal.id}`}>
                    Title
                  </label>
                  <input
                    id={`goal-edit-title-${goal.id}`}
                    className="input"
                    type="text"
                    value={editTitle}
                    maxLength={200}
                    onChange={(event) => setEditTitle(event.target.value)}
                    data-testid={`goal-edit-title-${goal.id}`}
                  />
                  <label className="goals-form-label" htmlFor={`goal-edit-description-${goal.id}`}>
                    Description
                  </label>
                  <textarea
                    id={`goal-edit-description-${goal.id}`}
                    className="input"
                    value={editDescription}
                    maxLength={5000}
                    onChange={(event) => setEditDescription(event.target.value)}
                    data-testid={`goal-edit-description-${goal.id}`}
                  />
                  {editError ? (
                    <p className="form-error goals-error" role="alert">
                      {editError}
                    </p>
                  ) : null}
                  <div className="goals-card-actions">
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={() => void saveEditGoal()}
                      disabled={isSavingEdit}
                      data-testid={`goal-edit-save-${goal.id}`}
                    >
                      Save
                    </button>
                    <button type="button" className="btn" onClick={cancelEdit} disabled={isSavingEdit} data-testid={`goal-edit-cancel-${goal.id}`}>
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="goals-card-main">
                    <h3 className="goals-card-title">{goal.title}</h3>
                    {goal.description ? (
                      (() => {
                        const showToggle = isDescriptionToggleVisible(goal.description);
                        const isExpanded = expandedGoalDescriptions.has(goal.id);

                        return (
                          <>
                            <div className={`markdown-body goals-card-description ${showToggle && !isExpanded ? "goals-card-description-collapsed" : ""}`.trim()}>
                              <ReactMarkdown remarkPlugins={[remarkGfm]}>{goal.description}</ReactMarkdown>
                            </div>
                            {showToggle ? (
                              <button
                                type="button"
                                className="btn goals-card-description-toggle"
                                aria-expanded={isExpanded}
                                data-testid={`goal-description-toggle-${goal.id}`}
                                onClick={() => toggleGoalDescription(goal.id)}
                              >
                                {isExpanded ? "Show less" : "Show more"}
                              </button>
                            ) : null}
                          </>
                        );
                      })()
                    ) : null}
                    <p className="goals-card-status">Status: {goal.status}</p>
                  </div>
                  <div className="goals-card-actions">
                    <button type="button" className="btn" onClick={() => openEdit(goal)} data-testid={`goal-edit-${goal.id}`}>
                      Edit
                    </button>
                    {goal.status === "active" ? (
                      <button
                        type="button"
                        className="btn goals-activate-button"
                        onClick={() => void updateGoalArchiveStatus(goal)}
                        data-testid={`goal-archive-${goal.id}`}
                      >
                        Archive
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn goals-activate-button"
                        onClick={() => void updateGoalArchiveStatus(goal)}
                        data-testid={`goal-unarchive-${goal.id}`}
                      >
                        Unarchive
                      </button>
                    )}
                  </div>
                </>
              )}
            </article>
          ))}
        </div>
      ) : null}
    </section>
  );
}
