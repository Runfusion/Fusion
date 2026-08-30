import { useTranslation } from "react-i18next";
import type { TaskDetail, WorkflowStepResult } from "@fusion/core";
import { TaskHistoryTab } from "./TaskHistoryTab";

interface TaskSummaryTabProps {
  task: TaskDetail;
  results: WorkflowStepResult[];
  loading?: boolean;
}

/*
FNXC:TaskDetailSummaryTab 2026-08-29-05:45:
Summary starts with chronological agent reports. The repeated completed-steps list was removed
because detailed step reports already render immediately below; Summary now also owns the trailing
MergeDetails panel while Stats remains the single home for spend.
*/
export function TaskSummaryTab({ task, results, loading = false }: TaskSummaryTabProps) {
  const { t } = useTranslation("app");

  return (
    <div className="task-summary-tab" data-testid="task-summary-tab">
      <section className="task-summary-section task-summary-section--agent-work">
        <h3>{t("taskDetail.summaryTab.agentWorkHeading", "Work done by agents")}</h3>
        <TaskHistoryTab task={task} results={results} loading={loading} />
      </section>
    </div>
  );
}
