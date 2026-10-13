import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { TaskDetail, WorkflowStepResult } from "@fusion/core";
import { TaskHistoryTab } from "./TaskHistoryTab";
import { AiDisclosure } from "./AiDisclosure";
import { buildTaskHistory } from "../utils/taskHistory";

interface TaskSummaryTabProps {
  task: TaskDetail;
  results: WorkflowStepResult[];
  loading?: boolean;
}

function hasGeneratedHistoryOutput(task: TaskDetail, results: WorkflowStepResult[]): boolean {
  return buildTaskHistory(task, results).some((stage) =>
    stage.entries.some((entry) => Boolean(entry.body?.trim())),
  );
}

/*
FNXC:TaskDetailSummaryTab 2026-08-29-05:45:
Summary starts with chronological agent reports. The repeated completed-steps list was removed
because detailed step reports already render immediately below; Summary now also owns the trailing
MergeDetails panel while Stats remains the single home for spend.
*/
export function TaskSummaryTab({ task, results, loading = false }: TaskSummaryTabProps) {
  const { t } = useTranslation("app");
  const showGeneratedOutputDisclosure = useMemo(
    () => hasGeneratedHistoryOutput(task, results),
    [task, results],
  );

  return (
    <div className="task-summary-tab" data-testid="task-summary-tab">
      <section className="task-summary-section task-summary-section--agent-work">
        <h3>{t("taskDetail.summaryTab.agentWorkHeading", "Work done by agents")}</h3>
        {/*
        FNXC:AITransparency 2026-09-04-04:44:
        The prior-attempts list used to host this disclosure, then Summary moved that history into
        TaskHistoryTab. Label generated-output only when a report body or prior-attempt output is
        actually rendered. Empty stages, status-only attempts, and timestamp shells are not AI output.
        */}
        {showGeneratedOutputDisclosure ? <AiDisclosure kind="generated-output" compact testId="task-summary-ai-disclosure" /> : null}
        <TaskHistoryTab task={task} results={results} loading={loading} />
      </section>
    </div>
  );
}
