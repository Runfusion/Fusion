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

  useEffect(() => {
    if (!open) return;
    setAttachExport(false);
    setTitle(`Research: ${finding.heading || run.title}`);
    setDescription(preview);
    setPriority("normal");
    setTaskId("");

    if (mode === "enrich") {
      setLoadingTasks(true);
      void fetchTasks(50, 0, projectId)
        /*
        FNXC:WorkflowResolvedColumns 2026-07-30-20:10 (batch-dashboard-app — SIZED, NOT CONVERTED):
        STILL A LITERAL, and threading the board's flags map here would be the WRONG fix.

        The guard is real: on a renamed board `archived` matches nothing, so filed-away tasks stay in
        this picker and an operator can attach research findings to work they deliberately archived.

        But this modal fetches its OWN page (`fetchTasks(50, 0, projectId)`), which is not the board's
        task set. The obvious move — thread `columnFlagsByTaskId` down from MainContent through
        ResearchView — resolves only rows that happen to be board-resident, and the rows THIS filter
        cares about are archived ones, which are exactly the rows a board-built map does not contain.
        It would look converted, drop the guard count, and leave the case it exists for unresolved.

        The honest fix is for this modal to resolve lanes for the page it fetched — either a
        `fetchTasks` variant that returns resolved flags, or a per-task resolution over the 50 rows.
        That is a data-fetch change, not a prop-threading one, so it is sized here rather than faked.

        FNXC:WorkflowResolvedColumns 2026-07-31-23:50 (CORRECTING THE SHAPE — it is not a data-fetch
        change, and the objection above applies to a map this guard does not need):
        Everything above is about a per-TASK map (`columnFlagsByTaskId`), and it is right that one
        cannot help here: it is built from board-resident rows, and the rows this filter cares about
        are archived ones, which are exactly what a board map omits.

        But this guard does not ask a per-task question. "Is `task.column` an archive lane" is a
        question about a COLUMN, and the answer lives in the workflow definition — a lane exists there
        whether or not any board row currently sits in it. The board already derives exactly that map:
        `ListView.tsx:756` builds `columnFlagsById` (ColumnId -> flags) from its workflow columns, and
        `useExecutorStats` takes the same shape. Archived rows being absent from the board is
        irrelevant to a column-keyed answer.

        So the cost is prop threading, not a fetch: MainContent -> ResearchView -> this modal, plus
        sourcing the column map where MainContent renders ResearchView (it does not hold one today).
        Three layers for one guard is a real cost and a fair thing to decline — but it is a different
        decision from "needs new data", which is what the note above would have the next reader
        believe, and the two have very different prices.

        Left counted and unconverted. I am recording the corrected shape rather than threading it,
        because a three-component prop chain wants to be someone's deliberate change rather than a
        drive-by on the last census entry in this file.
        */
        .then((rows) => setTasks(rows.filter((task) => task.column !== "archived")))
        .finally(() => setLoadingTasks(false));
    }
  }, [open, mode, projectId, finding.heading, preview, run.title]);

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
            disabled={saving || (mode === "enrich" && !taskId)}
            onClick={() => {
              setSaving(true);
              void onConfirm({
                taskId: mode === "enrich" ? taskId : undefined,
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
