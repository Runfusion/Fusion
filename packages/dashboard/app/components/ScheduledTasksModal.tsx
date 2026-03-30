import { useState, useEffect, useCallback } from "react";
import { Plus, Clock } from "lucide-react";
import type { ScheduledTask, ScheduledTaskCreateInput } from "@kb/core";
import {
  fetchAutomations,
  createAutomation,
  updateAutomation,
  deleteAutomation,
  runAutomation,
  toggleAutomation,
} from "../api";
import { ScheduleForm } from "./ScheduleForm";
import { ScheduleCard } from "./ScheduleCard";
import type { ToastType } from "../hooks/useToast";

/** Polling interval for auto-refreshing the schedule list (30 seconds). */
const POLL_INTERVAL_MS = 30_000;

interface ScheduledTasksModalProps {
  onClose: () => void;
  addToast: (message: string, type?: ToastType) => void;
}

type ModalView = "list" | "create" | "edit";

export function ScheduledTasksModal({ onClose, addToast }: ScheduledTasksModalProps) {
  const [schedules, setSchedules] = useState<ScheduledTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<ModalView>("list");
  const [editingSchedule, setEditingSchedule] = useState<ScheduledTask | undefined>();
  /** Track which schedule is currently running a manual execution. */
  const [runningId, setRunningId] = useState<string | null>(null);

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

  useEffect(() => {
    loadSchedules();
  }, [loadSchedules]);

  // Poll for updates while modal is open
  useEffect(() => {
    const interval = setInterval(loadSchedules, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [loadSchedules]);

  // Close on Escape (only when not in a sub-form)
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (view !== "list") {
          setView("list");
          setEditingSchedule(undefined);
        } else {
          onClose();
        }
      }
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose, view]);

  const handleOverlayClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) onClose();
    },
    [onClose],
  );

  // CRUD handlers
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

  const renderContent = () => {
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

  return (
    <div className="modal-overlay open" onClick={handleOverlayClick}>
      <div className="modal modal-lg" role="dialog" aria-labelledby="schedules-modal-title">
        <div className="modal-header">
          <h3 id="schedules-modal-title">Scheduled Tasks</h3>
          <div className="modal-header-actions">
            {view === "list" && schedules.length > 0 && (
              <button
                className="btn btn-primary btn-sm"
                onClick={() => setView("create")}
                aria-label="Create new schedule"
              >
                <Plus size={14} />
                New Schedule
              </button>
            )}
            <button className="modal-close" onClick={onClose} aria-label="Close">
              &times;
            </button>
          </div>
        </div>

        <div className="schedule-modal-content">
          {renderContent()}
        </div>
      </div>
    </div>
  );
}
