import { useTranslation } from "react-i18next";
import type { TaskDetail, WorkflowStepResult } from "@fusion/core";
import { TaskHistoryTab } from "./TaskHistoryTab";
import { AiDisclosure } from "./AiDisclosure";

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
        {/*
        FNXC:AiTransparency 2026-08-30-00:20:
        The generated-output disclosure was attached to this tab's prior-attempts list, which the
        2026-08-29 Summary consolidation removed. Everything the section still renders is agent
        output, so the disclosure moves to the section itself rather than being dropped with its
        old host — the tab must not present AI-generated reports without the disclosure.
        */}
        <AiDisclosure kind="generated-output" compact />
        <TaskHistoryTab task={task} results={results} loading={loading} />
      </section>
    </div>
  );
}
