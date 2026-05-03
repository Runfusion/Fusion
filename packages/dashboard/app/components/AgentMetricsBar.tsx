import { Activity, CheckCircle, ListTodo, Zap } from "lucide-react";
import type { AgentStats } from "../api";

interface AgentMetricsBarProps {
  stats: AgentStats | null;
  className?: string;
}

const METRIC_CARDS = [
  { icon: Activity, label: "Active Agents", valueKey: "activeCount", className: "agent-metric-card--active" },
  { icon: ListTodo, label: "Assigned Tasks", valueKey: "assignedTaskCount", className: "agent-metric-card--tasks" },
  { icon: CheckCircle, label: "Success Rate", valueKey: "successRate", className: "agent-metric-card--success" },
  { icon: Zap, label: "Total Runs", valueKey: "completedRuns", className: "agent-metric-card--runs" },
] as const;

export function AgentMetricsBar({ stats, className = "" }: AgentMetricsBarProps) {
  if (!stats) return null;

  return (
    <div className={`agent-metrics-bar ${className}`.trim()}>
      {METRIC_CARDS.map((card) => {
        const value = card.valueKey === "successRate"
          ? `${Math.round(stats.successRate * 100)}%`
          : stats[card.valueKey];

        return (
          <div key={card.label} className={`agent-metric-card ${card.className}`}>
            <card.icon size={18} />
            <div className="agent-metric-info">
              <span className="agent-metric-value">{value}</span>
              <span className="agent-metric-label">{card.label}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
