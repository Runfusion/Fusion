// ScheduledTasksModal renders schedule/routine cards using .scheduling-*, .routine-*,
// .schedule-form classes that live in ScriptsModal.css. Both modals share that file.
import "./ScriptsModal.css";
import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
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
import { useModalResizePersist } from "../hooks/useModalResizePersist";
import { useOverlayDismiss } from "../hooks/useOverlayDismiss";
import { useEmbeddedPresentation, type ModalPresentation } from "../hooks/useEmbeddedPresentation";

/** Polling interval for auto-refreshing the schedule/routine list (30 seconds). */
const POLL_INTERVAL_MS = 30_000;

/** Scheduling scope: global (user-level) or project-scoped. */
export type SchedulingScope = "global" | "project";

/**
 * FNXC:AutomationsEmbedded 2026-06-22-00:00:
 * Automations can render either as a fixed modal overlay ("modal", the default and historical path) or inline
 * as a main-content-area view ("embedded"). The embedded presentation fills the main panel like Command Center:
 * no overlay, no card/shadow/border chrome, a plain `.cc-header`-style title row, and a responsive two-pane
 * body (list + detail) that collapses to a single column below ~900px. The modal path is kept byte-identical;
 * modal-only behaviors (scroll lock via resize-persist, escape-to-close, overlay dismiss) are disabled when embedded.
 */
interface ScheduledTasksModalProps {
  onClose: () => void;
  addToast: (message: string, type?: ToastType) => void;
  /** Optional project ID for project-scoped scheduling. When provided, scope defaults to "project". */
  projectId?: string;
  /** Presentation surface. "modal" (default) renders a fixed overlay; "embedded" renders inline in the main content area. */
  presentation?: ModalPresentation;
}

export function ScheduledTasksModal({ onClose, addToast, projectId, presentation = "modal" }: ScheduledTasksModalProps) {
  const { t } = useTranslation("app");
  const { isEmbedded, resizePersistEnabled, escapeEnabled } = useEmbeddedPresentation(presentation);
  // Scope state: defaults to "project" when projectId exists, else "global"
  const [activeScope, setActiveScope] = useState<SchedulingScope>(() => projectId ? "project" : "global");

  // Routine state
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [routineView, setRoutineView] = useState<"list" | "create" | "edit">("list");
  const [editingRoutine, setEditingRoutine] = useState<Routine | undefined>();
  const [runningRoutineId, setRunningRoutineId] = useState<string | null>(null);
  const [lastRunOutput, setLastRunOutput] = useState<Record<string, { output: string; error?: string; success: boolean }>>({});
  // FNXC:AutomationsEmbedded 2026-06-22-00:00: Two-pane embedded layout tracks the routine selected in the left list to render its detail on the right.
  const [selectedRoutineId, setSelectedRoutineId] = useState<string | null>(null);

  const modalRef = useRef<HTMLDivElement>(null);
  // Resize-persist is a modal-only affordance; the embedded view fills its host and never resizes.
  useModalResizePersist(modalRef, resizePersistEnabled, "fusion:automation-modal-size");

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
      addToast(getErrorMessage(err) || t("schedule.loadRoutinesError", "Failed to load routines"), "error");
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

  // Close on Escape (only when not in a sub-form).
  // FNXC:AutomationsEmbedded 2026-06-22-00:00: Escape-to-close is a modal-only affordance; the embedded view lives in the main content area and must not hijack Escape.
  useEffect(() => {
    if (!escapeEnabled) return;
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
  }, [onClose, routineView, escapeEnabled]);

  const overlayDismissProps = useOverlayDismiss(onClose);

  // ── Routine CRUD handlers ───────────────────────────────────────────────

  const handleCreateRoutine = useCallback(
    async (input: RoutineCreateInput) => {
      try {
        await createRoutine(input, scopeOptions);
        addToast(t("schedule.routineCreated", "Routine created"), "success");
        setRoutineView("list");
        await loadRoutines();
      } catch (err) {
        addToast(getErrorMessage(err) || t("schedule.createError", "Failed to create routine"), "error");
      }
    },
    [addToast, loadRoutines, scopeOptions, t],
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
        addToast(t("schedule.routineUpdated", "Routine updated"), "success");
        setRoutineView("list");
        setEditingRoutine(undefined);
        await loadRoutines();
      } catch (err) {
        addToast(getErrorMessage(err) || t("schedule.updateError", "Failed to update routine"), "error");
      }
    },
    [editingRoutine, addToast, loadRoutines, scopeOptions, t],
  );

  const handleDeleteRoutine = useCallback(
    async (routine: Routine) => {
      try {
        await deleteRoutine(routine.id, scopeOptions);
        addToast(t("schedule.routineDeleted", "Deleted \"{{name}}\"", { name: routine.name }), "success");
        await loadRoutines();
      } catch (err) {
        addToast(getErrorMessage(err) || t("schedule.deleteError", "Failed to delete routine"), "error");
      }
    },
    [addToast, loadRoutines, scopeOptions, t],
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
          addToast(t("schedule.routineSuccess", "\"{{name}}\" completed successfully", { name: routine.name }), "success");
        } else {
          addToast(t("schedule.routineFailed", "\"{{name}}\" failed: {{error}}", { name: routine.name, error: result.error || t("schedule.unknownError", "Unknown error") }), "error");
        }
        await loadRoutines();
      } catch (err) {
        addToast(getErrorMessage(err) || t("schedule.runError", "Failed to run routine"), "error");
      } finally {
        setRunningRoutineId(null);
      }
    },
    [addToast, loadRoutines, scopeOptions, t],
  );

  const handleToggleRoutine = useCallback(
    async (routine: Routine) => {
      try {
        await updateRoutine(routine.id, { enabled: !routine.enabled }, scopeOptions);
        addToast(
          t(`schedule.routine${routine.enabled ? "Disabled" : "Enabled"}`, `"{{name}}" ${routine.enabled ? "disabled" : "enabled"}`, { name: routine.name }),
          "success",
        );
        await loadRoutines();
      } catch (err) {
        addToast(getErrorMessage(err) || t("schedule.toggleError", "Failed to toggle routine"), "error");
      }
    },
    [addToast, loadRoutines, scopeOptions, t],
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

  // FNXC:AutomationsEmbedded 2026-06-22-00:00: Keep the embedded detail-pane selection valid; clear it when the selected routine disappears from the (possibly re-scoped/re-polled) list.
  useEffect(() => {
    if (selectedRoutineId && !routines.some((r) => r.id === selectedRoutineId)) {
      setSelectedRoutineId(null);
    }
  }, [routines, selectedRoutineId]);

  const selectedRoutine = useMemo(
    () => routines.find((r) => r.id === selectedRoutineId) ?? null,
    [routines, selectedRoutineId],
  );

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
          <h4>{t("schedule.noAutomations", "No automations yet")}</h4>
          <p>{t("schedule.emptyStateDescription", "Create an automation with a schedule, webhook, API, or manual trigger.")}</p>
          <button
            className="btn btn-primary btn-sm"
            onClick={() => setRoutineView("create")}
          >
            <Plus size={14} />
            {t("schedule.createFirst", "Create your first automation")}
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

  // Shared scope/count/new-automation toolbar, used by both the modal and embedded presentations.
  const toolbar = (
    <div className="scheduling-toolbar" aria-live="polite">
      <div className="scheduling-toolbar-left" role="group" aria-label={t("schedule.scopeGroup", "Scheduling scope")}>
        <div className="scheduling-scope-selector">
          <button
            type="button"
            className={`scope-btn${activeScope === "global" ? " active" : ""}`}
            onClick={() => handleScopeSwitch("global")}
            aria-pressed={activeScope === "global"}
            title={t("schedule.globalScope", "Global (user-level) automations")}
          >
            <Globe size={14} />
            {t("schedule.global", "Global")}
          </button>
          <button
            type="button"
            className={`scope-btn${activeScope === "project" ? " active" : ""}`}
            onClick={() => handleScopeSwitch("project")}
            aria-pressed={activeScope === "project"}
            title={t("schedule.projectScope", "Project-scoped automations")}
          >
            <Folder size={14} />
            {t("schedule.project", "Project")}
          </button>
        </div>
        <span className="scheduling-count">
          <Zap size={14} />
          {t("schedule.automationCount", "{{count}} automation{{plural}}", { count: routines.length, plural: routines.length === 1 ? "" : "s" })}
        </span>
      </div>
      <div className="scheduling-toolbar-right">
        {isShowingList && (
          <button
            className="btn btn-primary btn-sm"
            onClick={() => setRoutineView("create")}
            aria-label={t("schedule.createNew", "Create new automation")}
          >
            <Plus size={14} />
            {t("schedule.newAutomation", "New Automation")}
          </button>
        )}
      </div>
    </div>
  );

  // ── Embedded (main-content-area) presentation ───────────────────────────
  // FNXC:AutomationsEmbedded 2026-06-22-00:00:
  // Renders inline like Command Center: no overlay/close, a plain .cc-header title row, --space-lg view padding,
  // no card chrome. The body is a responsive two-pane layout: a left list pane and a right detail pane that
  // collapse to a single column below ~900px (see .automations-embedded CSS). In list view the left pane shows a
  // compact selectable rail; selecting a routine renders its full RoutineCard on the right. In create/edit view the
  // editor spans the full width.
  if (isEmbedded) {
    const isListView = routineView === "list";
    return (
      <div className="automations-embedded right-dock-embedded-view">
        <div className="automations-embedded-view">
          <div className="cc-header automations-embedded-header">
            <h3 className="cc-title" id="schedules-modal-title">
              <Zap size={20} className="icon-triage" />
              {t("schedule.title", "Automations")}
            </h3>
          </div>

          {toolbar}

          {isListView && routines.length > 0 ? (
            <div className="automations-two-pane">
              {/* Left pane: compact selectable list of automations */}
              <div className="automations-list-pane" role="listbox" aria-label={t("schedule.title", "Automations")}>
                {routines.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    role="option"
                    aria-selected={selectedRoutineId === r.id}
                    className={`automation-list-row${selectedRoutineId === r.id ? " active" : ""}`}
                    onClick={() => setSelectedRoutineId(r.id)}
                  >
                    <Zap size={14} className="icon-triage" />
                    <span className="automation-list-row-name">{r.name}</span>
                    {!r.enabled && (
                      <span className="automation-list-row-badge">{t("schedule.disabled", "Disabled")}</span>
                    )}
                  </button>
                ))}
              </div>

              {/* Right pane: detail for the selected automation, or an empty prompt */}
              <div className="automations-detail-pane">
                {selectedRoutine ? (
                  <div className="routine-list">
                    <RoutineCard
                      key={selectedRoutine.id}
                      routine={selectedRoutine}
                      onEdit={handleEditRoutine}
                      onDelete={handleDeleteRoutine}
                      onRun={handleRunRoutine}
                      onToggle={handleToggleRoutine}
                      running={runningRoutineId === selectedRoutine.id}
                      lastRunOutput={lastRunOutput[selectedRoutine.id] ?? null}
                    />
                  </div>
                ) : (
                  <div className="routine-empty-state automations-detail-empty">
                    <Zap size={48} strokeWidth={1} />
                    <h4>{t("schedule.selectAutomation", "Select an automation")}</h4>
                    <p>{t("schedule.selectAutomationHint", "Choose an automation from the list to view its details.")}</p>
                  </div>
                )}
              </div>
            </div>
          ) : (
            // Empty state, create, and edit views span the full width (single column).
            <div className="automations-single-pane">
              {renderContent()}
            </div>
          )}
        </div>
      </div>
    );
  }

  // ── Modal (fixed overlay) presentation ──────────────────────────────────
  return (
    <div className="modal-overlay open" {...overlayDismissProps}>
      <div ref={modalRef} className="modal modal-lg automation-modal" role="dialog" aria-modal="true" aria-labelledby="schedules-modal-title">
        <div className="modal-header">
          <div className="detail-title-row">
            <Zap size={20} className="icon-triage" />
            <h3 id="schedules-modal-title">{t("schedule.title", "Automations")}</h3>
          </div>
          <button className="modal-close" onClick={onClose} aria-label={t("common.close", "Close")}>
            <X size={20} />
          </button>
        </div>

        {toolbar}

        <div className="schedule-modal-content" id="scheduled-tasks-content">
          {renderContent()}
        </div>
      </div>
    </div>
  );
}
