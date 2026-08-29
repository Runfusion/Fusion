import "./WorkflowSelector.css";
import { useCallback, useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Workflow as WorkflowIcon } from "lucide-react";
import type { WorkflowDefinition } from "@fusion/core";
import { getErrorMessage } from "@fusion/core";
import { fetchWorkflow, fetchWorkflows, fetchProjectDefaultWorkflow, setProjectDefaultWorkflow } from "../api";
import type { ToastType } from "../hooks/useToast";
import { useConfirm } from "../hooks/useConfirm";

/*
FNXC:i18n-Localize 2026-06-20-00:00:
FN-6770 localizes this workflow surface through t() and authored en catalog keys so hardcoded user-facing copy does not need a lint.ignore deferral.
*/

interface WorkflowSelectorProps {
  /** Currently selected workflow id, or null for none. */
  value: string | null;
  /** Apply a selection. Receives the chosen workflow id, or null to clear. */
  onChange: (workflowId: string | null) => void | Promise<void>;
  projectId?: string;
  addToast?: (message: string, type?: ToastType) => void;
  disabled?: boolean;
  label?: string;
  /** Optional affordance to open the graph editor. */
  onManage?: () => void;
  /**
   * U9: when the task whose workflow is being switched has an active session,
   * switching aborts that session and re-homes the card into the new workflow's
   * entry column. Pass `true` to require an abort-warning confirmation before
   * applying (parallels Column.tsx's preserve-progress confirm).
   */
  hasActiveSession?: boolean;
}

export function WorkflowSelector({
  value,
  onChange,
  projectId,
  addToast,
  disabled,
  label = "Workflow",
  onManage,
  hasActiveSession,
}: WorkflowSelectorProps) {
  const { t } = useTranslation("app");
  const selectId = useId();
  const { confirm } = useConfirm();
  const [workflows, setWorkflows] = useState<WorkflowDefinition[]>([]);
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setWorkflows([]);
    setLoading(true);
    fetchWorkflows(projectId)
      .then(async (data) => {
        if (value && !data.some((workflow) => workflow.id === value)) {
          try {
            const current = await fetchWorkflow(value, projectId);
            data = [...data, current];
          } catch {
            // The selected workflow may have been deleted; leave the filtered list as-is.
          }
        }
        if (!cancelled) setWorkflows(data);
      })
      .catch((err) => {
        if (!cancelled) setWorkflows([]);
        addToast?.(getErrorMessage(err) || t("workflowSelector.loadFailed", "Failed to load workflows"), "error");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, addToast, value]);

  const handleChange = useCallback(
    async (next: string) => {
      const workflowId = next === "" ? null : next;
      if (hasActiveSession) {
        const confirmed = await confirm({
          title: t("workflowSelector.switchActiveTitle", "Switch workflow?"),
          message: t(
            "workflowSelector.switchActiveMessage",
            "This task has an active session. Switching workflows aborts it and re-homes the card into the new workflow's entry column. Continue?",
          ),
          confirmLabel: t("workflowSelector.switchConfirm", "Switch and abort"),
          cancelLabel: t("workflowSelector.switchCancel", "Cancel"),
          danger: true,
        });
        if (!confirmed) return;
      }
      setApplying(true);
      try {
        await onChange(workflowId);
      } catch (err) {
        addToast?.(getErrorMessage(err) || t("workflowSelector.applyFailed", "Failed to apply workflow"), "error");
      } finally {
        setApplying(false);
      }
    },
    [onChange, addToast, hasActiveSession, confirm, t],
  );

  return (
    <div className="workflow-selector" data-testid="workflow-selector">
      <div className="workflow-selector-label">
        <div className="workflow-selector-label-text">
          <label htmlFor={selectId} className="workflow-selector-title">
            <WorkflowIcon size={14} aria-hidden /> {label}
          </label>
        </div>
        <select
          id={selectId}
          value={value ?? ""}
          disabled={disabled || loading || applying}
          onChange={(e) => void handleChange(e.target.value)}
        >
          <option value="">{t("workflowSelector.none", "None")}</option>
          {workflows.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>
      </div>
      {onManage && (
        <button type="button" className="workflow-selector-manage" onClick={onManage}>
          {t("workflowSelector.manage", "Manage…")}
        </button>
      )}
    </div>
  );
}

interface ProjectDefaultWorkflowFieldProps {
  projectId?: string;
  addToast?: (message: string, type?: ToastType) => void;
  onManage?: () => void;
}

/** Self-contained project-default workflow picker for the settings modal. */
export function ProjectDefaultWorkflowField({ projectId, addToast, onManage }: ProjectDefaultWorkflowFieldProps) {
  const { t } = useTranslation("app");
  const [value, setValue] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setValue(null);
    fetchProjectDefaultWorkflow(projectId)
      .then((res) => {
        if (!cancelled) setValue(res.workflowId);
      })
      .catch(() => {
        if (!cancelled) setValue(null);
        /* default is optional; ignore load failures */
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const handleChange = useCallback(
    async (workflowId: string | null) => {
      const res = await setProjectDefaultWorkflow(workflowId, projectId);
      setValue(res.workflowId);
      addToast?.(workflowId ? t("workflowSelector.defaultSet", "Default workflow set") : t("workflowSelector.defaultCleared", "Default workflow cleared"), "success");
    },
    [projectId, addToast, t],
  );

  return (
    <WorkflowSelector
      value={value}
      onChange={handleChange}
      projectId={projectId}
      addToast={addToast}
      label={t("workflowSelector.defaultWorkflowLabel", "Default workflow for new tasks")}
      onManage={onManage}
    />
  );
}
