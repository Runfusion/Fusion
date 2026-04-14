import { Activity, CheckCircle, ListTodo, Zap } from "lucide-react";
import type { AgentStats } from "../api";

interface AgentMetricsBarProps {
  stats: AgentStats | null;
}

export function AgentMetricsBar({ stats }: AgentMetricsBarProps) {
  if (!stats) return null;

  const cards = [
    { icon: Activity, label: "Active Agents", value: stats.activeCount, color: "var(--state-active-text)" },
    { icon: ListTodo, label: "Assigned Tasks", value: stats.assignedTaskCount, color: "var(--in-progress)" },
    { icon: CheckCircle, label: "Success Rate", value: `${Math.round(stats.successRate * 100)}%`, color: "var(--color-success, #3fb950)" },
    { icon: Zap, label: "Total Runs", value: stats.completedRuns, color: "var(--in-progress)" },
  ];

  return (
    <div className="agent-metrics-bar">
      {cards.map(card => (
        <div key={card.label} className="agent-metric-card">
          <card.icon size={18} style={{ color: card.color }} />
          <div className="agent-metric-info">
            <span className="agent-metric-value">{card.value}</span>
            <span className="agent-metric-label">{card.label}</span>
          </div>
        </div>
      ))}
    </div>
  );
}
