import type { ColumnId } from "@fusion/core";
import { useTranslation } from "react-i18next";
import { useColumnLabel } from "../i18n/labels";

const UNRESOLVED_AGENT_TASK_COLUMN = "unresolved";

interface AgentTaskBadgeProps {
  taskId: string;
  taskColumn?: string;
}

/*
 * FNXC:AgentTaskStateDrift 2026-06-27-16:20:
 * Agent task badges include the linked task column to disambiguate legitimate triage/queued linkage from execution drift.
 *
 * FNXC:AgentTaskStateDrift 2026-06-27-17:08:
 * Unresolved linked tasks need an explicit badge suffix so missing/deleted tasks do not look like a merely un-enriched response.
 */
export function AgentTaskBadge({ taskId, taskColumn }: AgentTaskBadgeProps) {
  const columnLabel = useColumnLabel();
  const { t } = useTranslation("app");

  if (!taskColumn || taskColumn === UNRESOLVED_AGENT_TASK_COLUMN) {
    return <>{taskId} · {t("agents.taskColumnUnresolved", "Unresolved task")}</>;
  }

  return <>{taskId} · {columnLabel(taskColumn as ColumnId)}</>;
}
