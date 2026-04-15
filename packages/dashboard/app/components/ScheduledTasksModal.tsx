import { useState, useEffect, useCallback } from "react";
import { Plus, Clock, Zap } from "lucide-react";
import type {
  ScheduledTask,
  ScheduledTaskCreateInput,
  Routine,
  RoutineCreateInput,
} from "@fusion/core";
import {
  fetchAutomations,
  createAutomation,
  updateAutomation,
  deleteAutomation,
  runAutomation,
  toggleAutomation,
  fetchRoutines,
  createRoutine,
  updateRoutine,
  deleteRoutine,
  runRoutine,
} from "../api";
import { ScheduleForm } from "./ScheduleForm";
import { ScheduleCard } from "./ScheduleCard";
import { RoutineCard } from "./RoutineCard";
import { RoutineEditor } from "./RoutineEditor";
import type { ToastType } from "../hooks/useToast";

/** Polling interval for auto-refreshing the schedule/routine list (30 seconds). */
const POLL_INTERVAL_MS = 30_000;

interface ScheduledTasksModalProps {
  onClose: () => void;
  addToast: (message: string, type?: ToastType) => void;
}

type ModalView = "list" | "create" | "edit";
type ActiveTab = "schedules" | "routines";

export function ScheduledTasksModal({ onClose, addToast }: ScheduledTasksModalProps) {
  // Tab state
  const [activeTab, setActiveTab] = useState<ActiveTab>("schedules");

  // Schedule state
  const [schedules, setSchedules] = useState<ScheduledTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<ModalView>("list");
  const [editingSchedule, setEditingSchedule] = useState<ScheduledTask | undefined>();
  /** Track which schedule is currently running a manual execution. */
  const [runningId, setRunningId] = useState<string | null>(null);

  // Routine state
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [routineView, setRoutineView] = useState<"list" | "create" | "edit">("list");
  const [editingRoutine, setEditingRoutine] = useState<Routine | undefined>();
  const [runningRoutineId, setRunningRoutineId] = useState<string | null>(null);

  // Load schedules
  const loadSchedules = useCallback(async () => {
    try {
      const data = await fetchAutomations();
      setSchedules(data);
    } catch (err: any) {
      addToast(err.message || "Failed to load schedules", "error");
    } finally {
      setLoading(false);
    }
  }, [addToast]);

  // Load routines
  const loadRoutines = useCallback(async () => {
    try {
      const data = await fetchRoutines();
      setRoutines(data);
    } catch (err: any) {
      addToast(err.message || "Failed to load routines", "error");
    }
  }, [addToast]);

  useEffect(() => {
    loadSchedules();
    loadRoutines();
  }, [loadSchedules, loadRoutines]);

  // Poll for updates while modal is open
  useEffect(() => {
    const interval = setInterval(() => {
      void loadSchedules();
      void loadRoutines();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [loadSchedules, loadRoutines]);

  // Close on Escape (only when not in a sub-form)
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (activeTab === "schedules") {
          if (view !== "list") {
            setView("list");
            setEditingSchedule(undefined);
          } else {
            onClose();
          }
        } else {
          // Routines tab
          if (routineView !== "list") {
            setRoutineView("list");
            setEditingRoutine(undefined);
          } else {
            onClose();
          }
        }
      }
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose, activeTab, view, routineView]);

  const handleOverlayClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) onClose();
    },
    [onClose],
  );

  // ── Schedule CRUD handlers ──────────────────────────────────────────────

  const handleCreate = useCallback(
    async (input: ScheduledTaskCreateInput) => {
      try {
        await createAutomation(input);
        addToast("Schedule created", "success");
        setView("list");
        await loadSchedules();
      } catch (err: any) {
        addToast(err.message || "Failed to create schedule", "error");
      }
    },
    [addToast, loadSchedules],
  );

  const handleEdit = useCallback((schedule: ScheduledTask) => {
    setEditingSchedule(schedule);
    setView("edit");
  }, []);

  const handleUpdate = useCallback(
    async (input: ScheduledTaskCreateInput) => {
      if (!editingSchedule) return;
      try {
        await updateAutomation(editingSchedule.id, input);
        addToast("Schedule updated", "success");
        setView("list");
        setEditingSchedule(undefined);
        await loadSchedules();
      } catch (err: any) {
        addToast(err.message || "Failed to update schedule", "error");
      }
    },
    [editingSchedule, addToast, loadSchedules],
  );

  const handleDelete = useCallback(
    async (schedule: ScheduledTask) => {
      try {
        await deleteAutomation(schedule.id);
        addToast(`Deleted "${schedule.name}"`, "success");
        await loadSchedules();
      } catch (err: any) {
        addToast(err.message || "Failed to delete schedule", "error");
      }
    },
    [addToast, loadSchedules],
  );

  const handleRun = useCallback(
    async (schedule: ScheduledTask) => {
      setRunningId(schedule.id);
      try {
        const { result } = await runAutomation(schedule.id);
        if (result.success) {
          addToast(`"${schedule.name}" completed successfully`, "success");
        } else {
          addToast(`"${schedule.name}" failed: ${result.error || "Unknown error"}`, "error");
        }
        await loadSchedules();
      } catch (err: any) {
        addToast(err.message || "Failed to run schedule", "error");
      } finally {
        setRunningId(null);
      }
    },
    [addToast, loadSchedules],
  );

  const handleToggle = useCallback(
    async (schedule: ScheduledTask) => {
      try {
        await toggleAutomation(schedule.id);
        addToast(
          `"${schedule.name}" ${schedule.enabled ? "disabled" : "enabled"}`,
          "success",
        );
        await loadSchedules();
      } catch (err: any) {
        addToast(err.message || "Failed to toggle schedule", "error");
      }
    },
    [addToast, loadSchedules],
  );

  const handleFormCancel = useCallback(() => {
    setView("list");
    setEditingSchedule(undefined);
  }, []);

  // ── Routine CRUD handlers ───────────────────────────────────────────────

  const handleCreateRoutine = useCallback(
    async (input: RoutineCreateInput) => {
      try {
        await createRoutine(input);
        addToast("Routine created", "success");
        setRoutineView("list");
        await loadRoutines();
      } catch (err: any) {
        addToast(err.message || "Failed to create routine", "error");
      }
    },
    [addToast, loadRoutines],
  );

  const handleEditRoutine = useCallback((routine: Routine) => {
    setEditingRoutine(routine);
    setRoutineView("edit");
  }, []);

  const handleUpdateRoutine = useCallback(
    async (input: RoutineCreateInput) => {
      if (!editingRoutine) return;
      try {
        await updateRoutine(editingRoutine.id, input);
        addToast("Routine updated", "success");
        setRoutineView("list");
        setEditingRoutine(undefined);
        await loadRoutines();
      } catch (err: any) {
        addToast(err.message || "Failed to update routine", "error");
      }
    },
    [editingRoutine, addToast, loadRoutines],
  );

  const handleDeleteRoutine = useCallback(
    async (routine: Routine) => {
      try {
        await deleteRoutine(routine.id);
        addToast(`Deleted "${routine.name}"`, "success");
        await loadRoutines();
      } catch (err: any) {
        addToast(err.message || "Failed to delete routine", "error");
      }
    },
    [addToast, loadRoutines],
  );

  const handleRunRoutine = useCallback(
    async (routine: Routine) => {
      setRunningRoutineId(routine.id);
      try {
        const { result } = await runRoutine(routine.id);
        if (result.success) {
          addToast(`"${routine.name}" completed successfully`, "success");
        } else {
          addToast(`"${routine.name}" failed: ${result.error || "Unknown error"}`, "error");
        }
        await loadRoutines();
      } catch (err: any) {
        addToast(err.message || "Failed to run routine", "error");
      } finally {
        setRunningRoutineId(null);
      }
    },
    [addToast, loadRoutines],
  );

  const handleToggleRoutine = useCallback(
    async (routine: Routine) => {
      try {
        await updateRoutine(routine.id, { enabled: !routine.enabled });
        addToast(
          `"${routine.name}" ${routine.enabled ? "disabled" : "enabled"}`,
          "success",
        );
        await loadRoutines();
      } catch (err: any) {
        addToast(err.message || "Failed to toggle routine", "error");
      }
    },
    [addToast, loadRoutines],
  );

  const handleRoutineCancel = useCallback(() => {
    setRoutineView("list");
    setEditingRoutine(undefined);
  }, []);

  // ── Tab switch handlers ─────────────────────────────────────────────────

  const handleTabSwitch = useCallback((tab: ActiveTab) => {
    setActiveTab(tab);
    setView("list");
    setEditingSchedule(undefined);
    setRoutineView("list");
    setEditingRoutine(undefined);
  }, []);

  // ── Render content ─────────────────────────────────────────────────────

  const renderSchedulesContent = () => {
    if (view === "create") {
      return <ScheduleForm onSubmit={handleCreate} onCancel={handleFormCancel} />;
    }

    if (view === "edit" && editingSchedule) {
      return (
        <ScheduleForm
          schedule={editingSchedule}
          onSubmit={handleUpdate}
          onCancel={handleFormCancel}
        />
      );
    }

    // List view
    if (loading) {
      return <div className="settings-empty-state settings-loading">Loading schedules…</div>;
    }

    if (schedules.length === 0) {
      return (
        <div className="schedule-empty-state">
          <Clock size={48} strokeWidth={1} />
          <h4>No scheduled tasks yet</h4>
          <p>Create a schedule to automate recurring tasks.</p>
          <button
            className="btn btn-primary btn-sm"
            onClick={() => setView("create")}
          >
            <Plus size={14} />
            Create your first schedule
          </button>
        </div>
      );
    }

    return (
      <div className="schedule-list">
        {schedules.map((s) => (
          <ScheduleCard
            key={s.id}
            schedule={s}
            onEdit={handleEdit}
            onDelete={handleDelete}
            onRun={handleRun}
            onToggle={handleToggle}
            running={runningId === s.id}
          />
        ))}
      </div>
    );
  };

  const renderRoutinesContent = () => {
    if (routineView === "create") {
      return <RoutineEditor onSubmit={handleCreateRoutine} onCancel={handleRoutineCancel} />;
    }

    if (routineView === "edit" && editingRoutine) {
      return (
        <RoutineEditor
          routine={editingRoutine}
          onSubmit={handleUpdateRoutine}
          onCancel={handleRoutineCancel}
        />
      );
    }

    // List view
    if (routines.length === 0) {
      return (
        <div className="routine-empty-state">
          <Zap size={48} strokeWidth={1} />
          <h4>No routines yet</h4>
          <p>Create a routine to assign recurring tasks to agents.</p>
          <button
            className="btn btn-primary btn-sm"
            onClick={() => setRoutineView("create")}
          >
            <Plus size={14} />
            Create your first routine
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
          />
        ))}
      </div>
    );
  };

  const renderContent = () => {
    if (activeTab === "schedules") {
      return renderSchedulesContent();
    }
    return renderRoutinesContent();
  };

  // Determine if we're in "list" view for showing the "New" button
  const isShowingList =
    activeTab === "schedules" ? view === "list" && schedules.length > 0 : routineView === "list" && routines.length > 0;

  return (
    <div className="modal-overlay open" onClick={handleOverlayClick}>
      <div className="modal modal-lg" role="dialog" aria-labelledby="schedules-modal-title">
        <div className="modal-header">
          <h3 id="schedules-modal-title">Scheduled Tasks</h3>
          <div className="modal-header-actions">
            {isShowingList && (
              <button
                className="btn btn-primary btn-sm"
                onClick={() => {
                  if (activeTab === "schedules") {
                    setView("create");
                  } else {
                    setRoutineView("create");
                  }
                }}
                aria-label={activeTab === "schedules" ? "Create new schedule" : "Create new routine"}
              >
                <Plus size={14} />
                {activeTab === "schedules" ? "New Schedule" : "New Routine"}
              </button>
            )}
            <button className="modal-close" onClick={onClose} aria-label="Close">
              &times;
            </button>
          </div>
        </div>

        {/* Tab navigation */}
        <div className="detail-tabs" role="tablist">
          <button
            className={`detail-tab${activeTab === "schedules" ? " detail-tab-active" : ""}`}
            role="tab"
            id="tab-schedules"
            aria-selected={activeTab === "schedules"}
            aria-controls="scheduled-tasks-content"
            onClick={() => handleTabSwitch("schedules")}
          >
            <Clock size={14} /> Schedules
          </button>
          <button
            className={`detail-tab${activeTab === "routines" ? " detail-tab-active" : ""}`}
            role="tab"
            id="tab-routines"
            aria-selected={activeTab === "routines"}
            aria-controls="scheduled-tasks-content"
            onClick={() => handleTabSwitch("routines")}
          >
            <Zap size={14} /> Routines
          </button>
        </div>

        <div className="schedule-modal-content" role="tabpanel" id="scheduled-tasks-content">
          {renderContent()}
        </div>
      </div>
    </div>
  );
}
