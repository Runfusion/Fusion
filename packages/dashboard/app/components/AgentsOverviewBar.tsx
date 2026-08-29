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
  onToggle: () => void;
  onSelectAgent?: (agentId: string) => void;
  onOpenTaskLogs?: (taskId: string) => void;
}

export function AgentsOverviewBar({
  stats,
  activeAgents,
  projectId,
  isOpen,
  onToggle,
  onSelectAgent,
  onOpenTaskLogs,
}: AgentsOverviewBarProps) {
  const { t } = useTranslation("app");
  const activeCount = activeAgents.filter((a) => a.state === "active").length;
  const runningCount = activeAgents.filter((a) => a.state === "running").length;

  return (
    <section className="agents-overview-bar" aria-label={t("agents.overviewLabel", "Agents overview")}>
      <button
        type="button"
        className="agents-overview-bar__toggle"
        aria-expanded={isOpen}
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
      {isOpen ? (
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
      ) : null}
    </section>
  );
}
