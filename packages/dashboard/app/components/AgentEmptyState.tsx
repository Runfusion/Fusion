import { Bot } from "lucide-react";

interface AgentEmptyStateProps {
  title?: string;
  description?: string;
  ctaLabel?: string;
  onCtaClick?: () => void;
}

export function AgentEmptyState({
  title = "No agents found",
  description = "Create an agent to get started",
  ctaLabel = "Create Agent",
  onCtaClick,
}: AgentEmptyStateProps) {
  return (
    <div className="agent-empty">
      <Bot size={48} opacity={0.3} className="agent-empty-state__icon" />
      <p className="agent-empty-state__title">{title}</p>
      <p className="agent-empty-state__description text-secondary">{description}</p>
      {onCtaClick ? (
        <button type="button" className="btn btn-task-create btn-sm" onClick={onCtaClick}>
          {ctaLabel}
        </button>
      ) : null}
    </div>
  );
}
