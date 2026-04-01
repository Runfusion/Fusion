import { useState, useCallback } from "react";
import { Play, Pause, AlertCircle, Loader2 } from "lucide-react";
import type { ProjectStatus } from "@fusion/core";
import type { ProjectHealth } from "../api";

export interface ProjectHealthBadgeProps {
  status: ProjectStatus;
  health?: ProjectHealth | null;
  size?: "sm" | "md" | "lg";
  showTooltip?: boolean;
}

const STATUS_CONFIG: Record<ProjectStatus, { label: string; color: string; icon: typeof Play }> = {
  active: { label: "Active", color: "var(--success)", icon: Play },
  paused: { label: "Paused", color: "var(--warning)", icon: Pause },
  errored: { label: "Error", color: "var(--error)", icon: AlertCircle },
  initializing: { label: "Initializing", color: "var(--info)", icon: Loader2 },
};

/**
 * ProjectHealthBadge - Color-coded badge showing project health status
 * 
 * Displays a status indicator with icon and label. Optionally shows a tooltip
 * with detailed health metrics on hover.
 */
export function ProjectHealthBadge({
  status,
  health,
  size = "md",
  showTooltip = true,
}: ProjectHealthBadgeProps) {
  const [isHovered, setIsHovered] = useState(false);
  const config = STATUS_CONFIG[status];
  const StatusIcon = config.icon;

  const handleMouseEnter = useCallback(() => {
    if (showTooltip && health) {
      setIsHovered(true);
    }
  }, [showTooltip, health]);

  const handleMouseLeave = useCallback(() => {
    setIsHovered(false);
  }, []);

  const sizeClasses = {
    sm: "project-health-badge--sm",
    md: "project-health-badge--md",
    lg: "project-health-badge--lg",
  };

  const isInitializing = status === "initializing";

  return (
    <div
      className={`project-health-badge ${sizeClasses[size]}`}
      style={{
        color: config.color,
        borderColor: config.color,
      }}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      data-status={status}
    >
      <StatusIcon
        size={size === "sm" ? 10 : size === "md" ? 12 : 14}
        className={isInitializing ? "animate-spin" : ""}
      />
      <span className="project-health-badge__label">{config.label}</span>

      {/* Tooltip with health metrics */}
      {isHovered && health && (
        <div className="project-health-badge__tooltip">
          <div className="project-health-tooltip__header">
            <strong>Health Metrics</strong>
          </div>
          <div className="project-health-tooltip__content">
            <div className="project-health-tooltip__metric">
              <span className="project-health-tooltip__label">Active Tasks:</span>
              <span className="project-health-tooltip__value">{health.activeTaskCount}</span>
            </div>
            <div className="project-health-tooltip__metric">
              <span className="project-health-tooltip__label">In-Flight Agents:</span>
              <span className="project-health-tooltip__value">{health.inFlightAgentCount}</span>
            </div>
            <div className="project-health-tooltip__metric">
              <span className="project-health-tooltip__label">Completed:</span>
              <span className="project-health-tooltip__value">{health.totalTasksCompleted}</span>
            </div>
            <div className="project-health-tooltip__metric">
              <span className="project-health-tooltip__label">Failed:</span>
              <span className="project-health-tooltip__value">{health.totalTasksFailed}</span>
            </div>
            {health.lastErrorMessage && (
              <div className="project-health-tooltip__error">
                <span className="project-health-tooltip__label">Last Error:</span>
                <span className="project-health-tooltip__error-text">
                  {health.lastErrorMessage}
                </span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
