// ScheduledTasksModal renders schedule/routine cards using .scheduling-*, .routine-*,
// .schedule-form classes that live in ScriptsModal.css. Both modals share that file.
import "./ScriptsModal.css";
import { useState, useEffect, useCallback, useMemo } from "react";
import { Plus, Zap, Globe, Folder, X } from "lucide-react";
import type { Routine, RoutineCreateInput } from "@fusion/core";
import { getErrorMessage } from "@fusion/core";
import {
  fetchRoutines,
  createRoutine,
  updateRoutine,
  deleteRoutine,
  runRoutine,
} from "../api";
import { RoutineCard } from "./RoutineCard";
import { RoutineEditor } from "./RoutineEditor";
import type { ToastType } from "../hooks/useToast";

/** Polling interval for auto-refreshing the schedule/routine list (30 seconds). */
const POLL_INTERVAL_MS = 30_000;

/** Scheduling scope: global (user-level) or project-scoped. */
export type SchedulingScope = "global" | "project";

interface ScheduledTasksModalProps {
  onClose: () => void;
  addToast: (message: string, type?: ToastType) => void;
  /** Optional project ID for project-scoped scheduling. When provided, scope defaults to "project". */
  projectId?: string;
}

export function ScheduledTasksModal({ onClose, addToast, projectId }: ScheduledTasksModalProps) {
  // Scope state: defaults to "project" when projectId exists, else "global"
  const [activeScope, setActiveScope] = useState<SchedulingScope>(() => projectId ? "project" : "global");

  // Routine state
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [routineView, setRoutineView] = useState<"list" | "create" | "edit">("list");
  const [editingRoutine, setEditingRoutine] = useState<Routine | undefined>();
  const [runningRoutineId, setRunningRoutineId] = useState<string | null>(null);
  const [lastRunOutput, setLastRunOutput] = useState<Record<string, { output: string; error?: string; success: boolean }>>({});

  // Build scope options for API calls
  const scopeOptions = useMemo(() => ({
    scope: activeScope,
    projectId: activeScope === "project" ? projectId : undefined,
  }), [activeScope, projectId]);

  // Load routines
  const loadRoutines = useCallback(async () => {
    try {
      const data = await fetchRoutines(scopeOptions);
      setRoutines(data);
      setLastRunOutput((previous) => {
        const next = { ...previous };
        for (const routine of data) {
          const pendingOutput = next[routine.id];
          if (!pendingOutput || !routine.lastRunResult) continue;
          const reflected = routine.lastRunResult;
          if (
            reflected.success === pendingOutput.success
            && (reflected.output || "") === pendingOutput.output
            && (reflected.error || "") === (pendingOutput.error || "")
          ) {
            delete next[routine.id];
          }
        }
        return next;
      });
    } catch (err) {
      addToast(getErrorMessage(err) || "Failed to load routines", "error");
    }
  }, [addToast, scopeOptions]);

  useEffect(() => {
    void loadRoutines();
  }, [loadRoutines]);

  // Poll for updates while modal is open
  useEffect(() => {
    const interval = setInterval(() => {
      void loadRoutines();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [loadRoutines]);

  // Close on Escape (only when not in a sub-form)
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (routineView !== "list") {
          setRoutineView("list");
          setEditingRoutine(undefined);
        } else {
          onClose();
        }
      }
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose, routineView]);

  const handleOverlayClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) onClose();
    },
    [onClose],
  );

  // ── Routine CRUD handlers ───────────────────────────────────────────────

  const handleCreateRoutine = useCallback(
    async (input: RoutineCreateInput) => {
      try {
        await createRoutine(input, scopeOptions);
        addToast("Routine created", "success");
        setRoutineView("list");
        await loadRoutines();
      } catch (err) {
        addToast(getErrorMessage(err) || "Failed to create routine", "error");
      }
    },
    [addToast, loadRoutines, scopeOptions],
  );

  const handleEditRoutine = useCallback((routine: Routine) => {
    setEditingRoutine(routine);
    setRoutineView("edit");
  }, []);

  const handleUpdateRoutine = useCallback(
    async (input: RoutineCreateInput) => {
      if (!editingRoutine) return;
      try {
        await updateRoutine(editingRoutine.id, input, scopeOptions);
        addToast("Routine updated", "success");
        setRoutineView("list");
        setEditingRoutine(undefined);
        await loadRoutines();
      } catch (err) {
        addToast(getErrorMessage(err) || "Failed to update routine", "error");
      }
    },
    [editingRoutine, addToast, loadRoutines, scopeOptions],
  );

  const handleDeleteRoutine = useCallback(
    async (routine: Routine) => {
      try {
        await deleteRoutine(routine.id, scopeOptions);
        addToast(`Deleted "${routine.name}"`, "success");
        await loadRoutines();
      } catch (err) {
        addToast(getErrorMessage(err) || "Failed to delete routine", "error");
      }
    },
    [addToast, loadRoutines, scopeOptions],
  );

  const handleRunRoutine = useCallback(
    async (routine: Routine) => {
      setRunningRoutineId(routine.id);
      try {
        const { result } = await runRoutine(routine.id, scopeOptions);
        setLastRunOutput((previous) => ({
          ...previous,
          [routine.id]: {
            output: result.output || "",
            error: result.error,
            success: result.success,
          },
        }));
        if (result.success) {
          addToast(`"${routine.name}" completed successfully`, "success");
        } else {
          addToast(`"${routine.name}" failed: ${result.error || "Unknown error"}`, "error");
        }
        await loadRoutines();
      } catch (err) {
        addToast(getErrorMessage(err) || "Failed to run routine", "error");
      } finally {
        setRunningRoutineId(null);
      }
    },
    [addToast, loadRoutines, scopeOptions],
  );

  const handleToggleRoutine = useCallback(
    async (routine: Routine) => {
      try {
        await updateRoutine(routine.id, { enabled: !routine.enabled }, scopeOptions);
        addToast(
          `"${routine.name}" ${routine.enabled ? "disabled" : "enabled"}`,
          "success",
        );
        await loadRoutines();
      } catch (err) {
        addToast(getErrorMessage(err) || "Failed to toggle routine", "error");
      }
    },
    [addToast, loadRoutines, scopeOptions],
  );

  const handleRoutineCancel = useCallback(() => {
    setRoutineView("list");
    setEditingRoutine(undefined);
  }, []);

  useEffect(() => {
    if (routineView !== "list") {
      setLastRunOutput({});
    }
  }, [routineView]);

  // ── Scope switch handler ───────────────────────────────────────────────

  const handleScopeSwitch = useCallback((scope: SchedulingScope) => {
    setActiveScope(scope);
    // Reset to list view when switching scope
    setRoutineView("list");
    setEditingRoutine(undefined);
    setLastRunOutput({});
  }, []);

  // ── Render content ─────────────────────────────────────────────────────

  const renderRoutinesContent = () => {
    if (routineView === "create") {
      return <RoutineEditor onSubmit={handleCreateRoutine} onCancel={handleRoutineCancel} scope={activeScope} projectId={projectId} />;
    }

    if (routineView === "edit" && editingRoutine) {
      return (
        <RoutineEditor
          routine={editingRoutine}
          onSubmit={handleUpdateRoutine}
          onCancel={handleRoutineCancel}
          scope={activeScope}
          projectId={projectId}
        />
      );
    }

    // List view
    if (routines.length === 0) {
      return (
        <div className="routine-empty-state">
          <Zap size={48} strokeWidth={1} />
          <h4>No automations yet</h4>
          <p>Create an automation with a schedule, webhook, API, or manual trigger.</p>
          <button
            className="btn btn-primary btn-sm"
            onClick={() => setRoutineView("create")}
          >
            <Plus size={14} />
            Create your first automation
          </button>
        </div>
      );
    }

    return (
      <div className="routine-list">
        {routines.map((r) => (
          <RoutineCard
            key={r.id}
            routine={r}
            onEdit={handleEditRoutine}
            onDelete={handleDeleteRoutine}
            onRun={handleRunRoutine}
            onToggle={handleToggleRoutine}
            running={runningRoutineId === r.id}
            lastRunOutput={lastRunOutput[r.id] ?? null}
          />
        ))}
      </div>
    );
  };

  const renderContent = () => {
    return renderRoutinesContent();
  };

  // Determine if we're in "list" view for showing the "New" button
  const isShowingList =
    routineView === "list" && routines.length > 0;
  return (
    <div className="modal-overlay open" onClick={handleOverlayClick}>
      <div className="modal modal-lg" role="dialog" aria-modal="true" aria-labelledby="schedules-modal-title">
        <div className="modal-header">
          <div className="detail-title-row">
            <Zap size={20} className="icon-triage" />
            <h3 id="schedules-modal-title">Automations</h3>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            <X size={20} />
          </button>
        </div>

        <div className="scheduling-toolbar" aria-live="polite">
          <div className="scheduling-toolbar-left" role="group" aria-label="Scheduling scope">
            <div className="scheduling-scope-selector">
              <button
                type="button"
                className={`scope-btn${activeScope === "global" ? " active" : ""}`}
                onClick={() => handleScopeSwitch("global")}
                aria-pressed={activeScope === "global"}
                title="Global (user-level) automations"
              >
                <Globe size={14} />
                Global
              </button>
              <button
                type="button"
                className={`scope-btn${activeScope === "project" ? " active" : ""}`}
                onClick={() => handleScopeSwitch("project")}
                aria-pressed={activeScope === "project"}
                title="Project-scoped automations"
              >
                <Folder size={14} />
                Project
              </button>
            </div>
            <span className="scheduling-count">
              <Zap size={14} />
              {routines.length} automation{routines.length === 1 ? "" : "s"}
            </span>
          </div>
          <div className="scheduling-toolbar-right">
            {isShowingList && (
              <button
                className="btn btn-primary btn-sm"
                onClick={() => setRoutineView("create")}
                aria-label="Create new automation"
              >
                <Plus size={14} />
                New Automation
              </button>
            )}
          </div>
        </div>

        <div className="schedule-modal-content" id="scheduled-tasks-content">
          {renderContent()}
        </div>
      </div>
    </div>
  );
}
