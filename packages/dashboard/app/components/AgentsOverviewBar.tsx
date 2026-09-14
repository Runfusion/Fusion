import { ChevronDown, ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { AgentMetricsBar } from "./AgentMetricsBar";
import { ActiveAgentsPanel } from "./ActiveAgentsPanel";
import type { Agent, AgentStats } from "../api";
import "./AgentsOverviewBar.css";

interface AgentsOverviewBarProps {
  stats: AgentStats | null;
  activeAgents: Agent[];
  projectId?: string;
  isOpen: boolean;
  onSelectAgent?: (agentId: string) => void;
  onOpenTaskLogs?: (taskId: string) => void;
}

interface AgentsOverviewToggleProps {
  activeAgents: Agent[];
  isOpen: boolean;
  onToggle: () => void;
}

/*
FNXC:StandardizedViewActions 2026-09-14-02:47:
Overview is a view-level control, so its trigger belongs in the Agents header beside the other view actions, not in a
permanent third block between the header and the collection. FN-379 standardized the header and the rail but left this
bar untouched, so Agents read as three stacked zones. The trigger renders in the header; the expanded content stays a
sibling section under it and remains the constrained touch-scroll owner on phones.
*/
export function AgentsOverviewToggle({ activeAgents, isOpen, onToggle }: AgentsOverviewToggleProps) {
  const { t } = useTranslation("app");
  const activeCount = activeAgents.filter((a) => a.state === "active").length;
  const runningCount = activeAgents.filter((a) => a.state === "running").length;

  return (
    <button
      type="button"
      className="agents-overview-bar__toggle"
      aria-expanded={isOpen}
      data-testid="agents-overview-toggle"
      onClick={onToggle}
    >
      <span className="agents-overview-bar__title-wrap">
        {isOpen ? <ChevronDown size={16} aria-hidden="true" /> : <ChevronRight size={16} aria-hidden="true" />}
        <span className="agents-overview-bar__title">{t("agents.overview", "Overview")}</span>
      </span>
      <span className="agents-overview-bar__meta text-secondary">
        {t("agents.statusCount", "{{activeCount}} active · {{runningCount}} running", { activeCount, runningCount })}
      </span>
    </button>
  );
}

export function AgentsOverviewBar({
  stats,
  activeAgents,
  projectId,
  isOpen,
  onSelectAgent,
  onOpenTaskLogs,
}: AgentsOverviewBarProps) {
  const { t } = useTranslation("app");

  if (!isOpen) return null;

  return (
    <section className="agents-overview-bar" aria-label={t("agents.overviewLabel", "Agents overview")}>
      <div className="agents-overview-bar__content">
        <AgentMetricsBar stats={stats} className="agents-overview-bar__metrics" />
        <ActiveAgentsPanel
          agents={activeAgents}
          projectId={projectId}
          onAgentSelect={onSelectAgent}
          onOpenTaskLogs={onOpenTaskLogs}
          className="agents-overview-bar__active-panel"
        />
      </div>
    </section>
  );
}
