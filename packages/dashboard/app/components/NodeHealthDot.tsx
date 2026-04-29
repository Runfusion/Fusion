import type { NodeStatus } from "@fusion/core";
import "./NodeHealthDot.css";

export interface NodeHealthDotProps {
  status: NodeStatus;
  showLabel?: boolean;
  className?: string;
  compact?: boolean;
}

function toStatusLabel(status: NodeStatus): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

export function NodeHealthDot({ status, showLabel = false, className, compact = false }: NodeHealthDotProps) {
  const label = toStatusLabel(status);

  return (
    <span
      className={`node-health-dot${compact ? " node-health-dot--compact" : ""}${className ? ` ${className}` : ""}`}
      title={label}
      aria-label={`Node status: ${label}`}
    >
      <span className={`status-dot status-dot--${status}`} />
      {showLabel ? <span className="node-health-dot__label">{label}</span> : null}
    </span>
  );
}
