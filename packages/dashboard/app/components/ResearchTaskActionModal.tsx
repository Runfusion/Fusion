import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Task, TaskPriority } from "@fusion/core";
import { fetchTasks } from "../api";
import { useMobileScrollLock } from "../hooks/useMobileScrollLock";
import type { ResearchRunDetail } from "../research-types";
import "./ResearchTaskActionModal.css";

type Mode = "create" | "enrich";

interface ResearchTaskActionModalProps {
  open: boolean;
  mode: Mode;
  run: ResearchRunDetail;
  finding: { id: string; heading?: string; content?: string };
  projectId?: string;
  onClose: () => void;
  onConfirm: (payload: { taskId?: string; title?: string; description?: string; priority?: TaskPriority; attachExport: boolean }) => Promise<void>;
}

export function ResearchTaskActionModal({ open, mode, run, finding, projectId, onClose, onConfirm }: ResearchTaskActionModalProps) {
  const { t } = useTranslation("app");
  useMobileScrollLock(open);
  const [attachExport, setAttachExport] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<TaskPriority>("normal");
  const [taskId, setTaskId] = useState("");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loadingTasks, setLoadingTasks] = useState(false);
  const [saving, setSaving] = useState(false);


  const preview = useMemo(() => {
    const firstSentence = (finding.content ?? "").split(/(?<=[.!?])\s+/)[0] ?? "";
    return `${finding.heading || t("research.defaultFindingHeading", "Research finding")} — ${firstSentence}`.trim();
  }, [finding.content, finding.heading, t]);

  /*
  FNXC:ResearchTaskModal 2026-08-01-00:41 (an operator's typed title was wiped when board workflows resolved):
  These two jobs were one effect, and its dependency list carried workflow-derived terminal-column
  metadata for the fetch's sake. That metadata changes whenever board workflows resolve or revalidate,
  and each change re-ran the whole effect, calling `setTitle`/`setDescription`/`setPriority`/`setTaskId`
  over whatever the operator had already typed. Opening the modal and typing before the workflows settled silently reverted the form
  to its defaults.

  Split so the reset depends only on what the reset is derived from, and the fetch keeps the
  dependency it actually needs. Same class as
  `docs/solutions/ui-bugs/skill-autocomplete-highlight-reset-on-swr-revalidation.md`: user input reset
  by an async revalidation the user cannot see.
  */
  useEffect(() => {
    if (!open) return;
    setAttachExport(false);
    setTitle(`Research: ${finding.heading || run.title}`);
    setDescription(preview);
    setPriority("normal");
    setTaskId("");
  }, [open, mode, finding.heading, preview, run.title]);

  useEffect(() => {
    if (!open || mode !== "enrich") return;
    /*
    FNXC:ResearchTaskPicker 2026-08-01-00:30 (#3286 review — "ignore results from superseded task
    requests"): LAST REQUEST WINS, AND THE STALE LIST IS NOT SELECTABLE MEANWHILE.

    A `projectId` change starts a second fetch while the first is in flight. With
    no guard the slower one resolves last and repopulates the picker from the OLD project — and because
    the previous rows stayed listed while loading, an operator could attach a finding to a task from a
    project they had already switched away from. Wrong-row attachment, not a cosmetic flicker.

    Clearing on entry also removes the stale-but-selectable window: the picker is empty while loading
    rather than showing rows the current filters have not vetted.
    */
    let superseded = false;
    setTasks([]);
    setLoadingTasks(true);
    void fetchTasks(50, 0, projectId)
      .then((rows) => {
        if (superseded) return;
        setTasks(rows);
      })
      .finally(() => {
        if (!superseded) setLoadingTasks(false);
      });
    return () => {
      superseded = true;
    };
  }, [open, mode, projectId]);

  /*
  FNXC:ResearchEnrich 2026-08-01-02:35:
  Enriching requires a real task identifier. Whitespace made the action appear available and sent
  a non-actionable identifier downstream, so validate the normalized value and submit that same
  value rather than preserving an input-only representation.
  */
  const normalizedTaskId = taskId.trim();

  if (!open) return null;

  return (
    <div className="modal-overlay open" role="presentation" onClick={onClose}>
      <div className="modal modal-lg research-task-action-modal" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <h3>{mode === "create" ? t("research.createTaskTitle", "Create task from finding") : t("research.enrichTaskTitle", "Enrich existing task")}</h3>
          <button className="modal-close" type="button" aria-label={t("actions.close", "Close")} onClick={onClose}>×</button>
        </div>

        <div className="research-task-action-modal__body">
          <div className="card research-task-action-modal__preview">
            <p><strong>{t("research.runLabel", "Run:")} </strong> {run.id}</p>
            <p><strong>{t("research.findingLabel", "Finding:")} </strong> {finding.id}{finding.heading ? ` — ${finding.heading}` : ""}</p>
            <p>{preview || t("research.noPreview", "No preview available.")}</p>
          </div>

          {mode === "create" ? (
            <>
              <label className="research-task-action-modal__field">{t("research.titleLabel", "Title")}
                <input className="input" value={title} onChange={(event) => setTitle(event.target.value)} />
              </label>
              <label className="research-task-action-modal__field">{t("research.descriptionLabel", "Description")}
                <textarea className="input research-task-action-modal__textarea" value={description} onChange={(event) => setDescription(event.target.value)} />
              </label>
              <label className="research-task-action-modal__field">{t("research.priorityLabel", "Priority")}
                <select className="select" value={priority} onChange={(event) => setPriority(event.target.value as TaskPriority)}>
                  <option value="low">{t("research.priorityLow", "Low")}</option>
                  <option value="normal">{t("research.priorityNormal", "Normal")}</option>
                  <option value="high">{t("research.priorityHigh", "High")}</option>
                  <option value="urgent">{t("research.priorityUrgent", "Urgent")}</option>
                </select>
              </label>
            </>
          ) : (
            <label className="research-task-action-modal__field">{t("research.targetTaskLabel", "Target task")}
              <input
                className="input"
                list="research-task-action-task-list"
                value={taskId}
                placeholder={loadingTasks ? t("research.loadingTasks", "Loading tasks…") : t("research.enterTaskId", "Enter task ID")}
                onChange={(event) => setTaskId(event.target.value)}
              />
              <datalist id="research-task-action-task-list">
                {tasks.map((task) => (
                  <option key={task.id} value={task.id}>{task.title}</option>
                ))}
              </datalist>
            </label>
          )}

          <label className="checkbox-label">
            <input type="checkbox" checked={attachExport} onChange={(event) => setAttachExport(event.target.checked)} />
            <span>{t("research.attachExport", "Attach markdown export artifact")}</span>
          </label>
        </div>

        <div className="modal-actions">
          <button className="btn" type="button" onClick={onClose}>{t("actions.cancel", "Cancel")}</button>
          <button
            className="btn btn-primary"
            type="button"
            disabled={saving || (mode === "enrich" && !normalizedTaskId)}
            onClick={() => {
              setSaving(true);
              void onConfirm({
                taskId: mode === "enrich" ? normalizedTaskId : undefined,
                title: mode === "create" ? title.trim() : undefined,
                description: mode === "create" ? description.trim() : undefined,
                priority: mode === "create" ? priority : undefined,
                attachExport,
              }).finally(() => setSaving(false));
            }}
          >
            {mode === "create" ? t("research.createTaskButton", "Create Task") : t("research.enrichTaskButton", "Enrich Task")}
          </button>
        </div>
      </div>
    </div>
  );
}
