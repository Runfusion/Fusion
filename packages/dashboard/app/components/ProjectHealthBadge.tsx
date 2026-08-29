import { useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import type { ProjectStatus } from "@fusion/core";
import type { ProjectHealth } from "../api";
import { getProjectStatusConfig, isInitializingStatus } from "../utils/projectStatusConfig";

export interface ProjectHealthBadgeProps {
  status: ProjectStatus;
  health?: ProjectHealth | null;
  size?: "sm" | "md" | "lg";
  showTooltip?: boolean;
}

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
  const { t } = useTranslation("app");
  const [isHovered, setIsHovered] = useState(false);
  const config = getProjectStatusConfig(status);
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

  const isInitializing = isInitializingStatus(status);

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
            <strong>{t("health.metricsTitle", "Health Metrics")}</strong>
          </div>
          <div className="project-health-tooltip__content">
            <div className="project-health-tooltip__metric">
              <span className="project-health-tooltip__label">{t("health.activeTasks", "Active Tasks:")}:</span>
              <span className="project-health-tooltip__value">{health.activeTaskCount}</span>
            </div>
            <div className="project-health-tooltip__metric">
              <span className="project-health-tooltip__label">{t("health.inFlightAgents", "In-Flight Agents:")}:</span>
              <span className="project-health-tooltip__value">{health.inFlightAgentCount}</span>
            </div>
            <div className="project-health-tooltip__metric">
              <span className="project-health-tooltip__label">{t("health.completed", "Completed:")}:</span>
              <span className="project-health-tooltip__value">{health.totalTasksCompleted}</span>
            </div>
            <div className="project-health-tooltip__metric">
              <span className="project-health-tooltip__label">{t("health.failed", "Failed:")}:</span>
              <span className="project-health-tooltip__value">{health.totalTasksFailed}</span>
            </div>
            {health.lastErrorMessage && (
              <div className="project-health-tooltip__error">
                <span className="project-health-tooltip__label">{t("health.lastError", "Last Error:")}:</span>
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
