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
  streamRoutineRun,
} from "../api";
import type { RoutineRunStreamEvent } from "../api";
import { RoutineCard } from "./RoutineCard";
import { RoutineEditor } from "./RoutineEditor";
import type { ToastType } from "../hooks/useToast";
import { useEmbeddedPresentation, type ModalPresentation } from "../hooks/useEmbeddedPresentation";
import { FloatingWindow } from "./FloatingWindow";

/** Polling interval for auto-refreshing the schedule/routine list (30 seconds). */
const POLL_INTERVAL_MS = 30_000;

/** Scheduling scope: global (user-level) or project-scoped. */
export type SchedulingScope = "global" | "project";

/**
 * FNXC:AutomationsEmbedded 2026-06-22-00:00:
 * Automations can render either as a draggable/resizable floating modal ("modal", the default path) or inline
 * as a main-content-area view ("embedded"). The embedded presentation fills the main panel like Command Center:
 * no overlay, no card/shadow/border chrome, a plain `.cc-header`-style title row, and a responsive two-pane
 * body (list + detail) that collapses to a single column below ~900px. Floating chrome and Escape-to-close are
 * modal-only behaviors; the embedded presentation bypasses FloatingWindow entirely.
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
  const { isEmbedded, escapeEnabled } = useEmbeddedPresentation(presentation);
  // Scope state: defaults to "project" when projectId exists, else "global"
  const [activeScope, setActiveScope] = useState<SchedulingScope>(() => projectId ? "project" : "global");

  // Routine state
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [routineView, setRoutineView] = useState<"list" | "create" | "edit">("list");
  const [editingRoutine, setEditingRoutine] = useState<Routine | undefined>();
  const [runningRoutineId, setRunningRoutineId] = useState<string | null>(null);
  const [lastRunOutput, setLastRunOutput] = useState<Record<string, { output: string; error?: string; success: boolean }>>({});
  const [liveRunOutput, setLiveRunOutput] = useState<Record<string, { output: string; status: "idle" | "running" | "complete" | "error" }>>({});
  const liveRunStreamsRef = useRef<Record<string, { close: () => void }>>({});
  // FNXC:AutomationsEmbedded 2026-06-22-00:00: Two-pane embedded layout tracks the routine selected in the left list to render its detail on the right.
  const [selectedRoutineId, setSelectedRoutineId] = useState<string | null>(null);

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

  useEffect(() => {
    return () => {
      for (const stream of Object.values(liveRunStreamsRef.current)) stream.close();
      liveRunStreamsRef.current = {};
    };
  }, []);

  const appendLiveRunLine = useCallback((routineId: string, line: string, status: "running" | "complete" | "error" = "running") => {
    setLiveRunOutput((previous) => {
      const current = previous[routineId]?.output ?? "";
      return {
        ...previous,
        [routineId]: {
          output: current ? `${current}\n${line}` : line,
          status,
        },
      };
    });
  }, []);

  /*
  FNXC:AutomationLiveOutput 2026-07-07-01:00 (FN-7652):
  The live-output panel's terminal status must be a function of the AUTHORITATIVE run result (the POST
  trigger's `result.success`, mirrored server-side by `AutomationLiveRunRegistry.complete()`), never of
  transient SSE stream mechanics. Two benign-teardown paths used to get misread as "the run failed":
  (a) `streamRoutineRun` is opened WITHOUT a runId (it races the POST so a slow run still streams live),
      so its resilient EventSource can exhaust reconnect attempts and fire `onFatalError("Connection
      lost")` for reasons that have nothing to do with the run's outcome (dev-server hiccup, a normal
      post-terminal `res.end()` racing the client, etc.) — this must never itself paint "Run failed".
  (b) a runId-less stream can (server-permitting) attach to a stale prior run and replay ITS terminal
      event; `routes.ts`'s `getForAutoAttach` bounds that window, but the client still treats the
      awaited POST result as the single source of truth rather than trusting whichever event happened
      to arrive on the SSE channel.
  `reconcileLiveRunResult` is the one place that commits a terminal status/line; it is idempotent (a
  no-op when the panel already reflects the same terminal status) and drops any output the panel
  accumulated after a wrongly-terminal state so no false "Run failed" line can linger once the true
  outcome is known.
  */
  const reconcileLiveRunResult = useCallback((routineId: string, success: boolean, errorMessage?: string) => {
    setLiveRunOutput((previous) => {
      const current = previous[routineId];
      const targetStatus: "complete" | "error" = success ? "complete" : "error";
      if (current?.status === targetStatus) {
        // Already reflects the authoritative outcome (a genuine SSE terminal event already matched it).
        return previous;
      }
      const line = success
        ? t("schedule.liveRunComplete", "Run complete")
        : (errorMessage || t("schedule.liveRunError", "Run failed"));
      // Only carry forward the transcript if the panel is still mid-run; a mismatched prior terminal
      // status (stale-attach or benign-teardown artifact) must not leave its line behind once the real
      // outcome supersedes it.
      const base = current && current.status === "running" ? current.output : "";
      return {
        ...previous,
        [routineId]: {
          output: base ? `${base}\n${line}` : line,
          status: targetStatus,
        },
      };
    });
  }, [t]);

  /*
  FNXC:AutomationLiveOutput 2026-06-26-00:00:
  The modal and embedded Automations view both render RoutineCard, so the run handler owns one SSE stream per routine and passes the accumulated live transcript down instead of duplicating stream logic per presentation.
  */
  const handleLiveRunEvent = useCallback((routineId: string, event: RoutineRunStreamEvent) => {
    if (event.type === "output" && event.text) {
      appendLiveRunLine(routineId, event.text);
      return;
    }
    if (event.type === "tool" && event.name) {
      appendLiveRunLine(routineId, event.status === "completed" ? `Tool ${event.name} finished${event.isError ? " with errors" : ""}` : `Tool ${event.name} started`);
      return;
    }
    if (event.type === "step" && event.stepName) {
      appendLiveRunLine(routineId, event.status === "completed" ? `Step ${Number(event.stepIndex ?? 0) + 1}: ${event.stepName} ${event.success ? "completed" : "failed"}` : `Step ${Number(event.stepIndex ?? 0) + 1}: ${event.stepName} started`);
      return;
    }
    if (event.type === "complete") {
      reconcileLiveRunResult(routineId, true);
      liveRunStreamsRef.current[routineId]?.close();
      delete liveRunStreamsRef.current[routineId];
      return;
    }
    if (event.type === "error") {
      reconcileLiveRunResult(routineId, false, event.message);
      liveRunStreamsRef.current[routineId]?.close();
      delete liveRunStreamsRef.current[routineId];
    }
  }, [appendLiveRunLine, reconcileLiveRunResult]);

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
      setLiveRunOutput((previous) => ({
        ...previous,
        [routine.id]: { output: t("schedule.liveRunStarting", "Starting run…"), status: "running" },
      }));
      liveRunStreamsRef.current[routine.id]?.close();
      liveRunStreamsRef.current[routine.id] = streamRoutineRun(routine.id, {
        onEvent: (event) => handleLiveRunEvent(routine.id, event),
        // FNXC:AutomationLiveOutput 2026-07-07-01:00 (FN-7652): benign SSE teardown (reconnect
        // exhaustion, a normal post-terminal close racing the client) is NOT a run-failure signal —
        // intentionally a no-op here. The awaited `runRoutine` result below is the sole authority that
        // reconciles `liveRunOutput` to the real terminal state; letting this callback paint
        // "Run failed" is exactly the FN-7652 bug (a successful run ending in an error-styled panel).
        onFatalError: () => {},
      }, scopeOptions);
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
        reconcileLiveRunResult(routine.id, result.success, result.error);
        if (result.success) {
          addToast(t("schedule.routineSuccess", "\"{{name}}\" completed successfully", { name: routine.name }), "success");
        } else {
          addToast(t("schedule.routineFailed", "\"{{name}}\" failed: {{error}}", { name: routine.name, error: result.error || t("schedule.unknownError", "Unknown error") }), "error");
        }
        await loadRoutines();
      } catch (err) {
        const message = getErrorMessage(err) || t("schedule.runError", "Failed to run routine");
        // FNXC:AutomationLiveOutput 2026-07-07-01:00 (FN-7652): the POST itself never resolved with a
        // result, so this IS a genuine failure — reconcile the live panel to the real error too, not
        // just the toast, so it doesn't linger stuck on "running".
        reconcileLiveRunResult(routine.id, false, message);
        addToast(message, "error");
      } finally {
        liveRunStreamsRef.current[routine.id]?.close();
        delete liveRunStreamsRef.current[routine.id];
        setRunningRoutineId(null);
      }
    },
    [addToast, handleLiveRunEvent, loadRoutines, reconcileLiveRunResult, scopeOptions, t],
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
      setLiveRunOutput({});
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
            liveRunOutput={liveRunOutput[r.id] ?? null}
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
                      liveRunOutput={liveRunOutput[selectedRoutine.id] ?? null}
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

  // ── Modal (floating window) presentation ────────────────────────────────
  return (
    <FloatingWindow
      windowKey="automation"
      title={t("schedule.title", "Automations")}
      onClose={onClose}
      hideHeader
      dragHandleSelector=".automation-modal__drag-handle"
      className="floating-window--automation"
      defaultSize={{ width: 720, height: 640 }}
      minSize={{ width: 420, height: 360 }}
      /* FNXC:ModalGeometryPersistence 2026-07-15-19:30: Automations is a full-screen sheet at ≤768px; its movable desktop geometry must survive mobile opens. */
      suspendGeometryPersistenceOnMobile
      persistGeometryKey="floating-window:automation"
    >
      {/**
       * FNXC:Automations 2026-06-26-00:00:
       * FN-7036 moves the desktop Automations popup into the shared FloatingWindow shell so it matches Plan Mission and Workflow editor drag, resize, stack, clamp, and geometry-persistence behavior. Mobile remains full-screen through the ScriptsModal.css floating-window contract, while the embedded main-content presentation above bypasses all FloatingWindow chrome.
       */}
      <div className="modal modal-lg automation-modal" role="dialog" aria-modal="true" aria-labelledby="schedules-modal-title">
        <div className="modal-header automation-modal__drag-handle">
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
    </FloatingWindow>
  );
}
