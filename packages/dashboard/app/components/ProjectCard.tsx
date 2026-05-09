import { memo, useCallback, useState } from "react";
import { Play, Pause, AlertCircle, Loader2, Trash2, Folder, ArrowRight } from "lucide-react";
import "./ProjectCard.css";
import type { RegisteredProject, ProjectHealth, ProjectStatus } from "@fusion/core";
import type { ProjectNodeAvailability } from "../api";

export interface ProjectCardProps {
  project: RegisteredProject;
  health: ProjectHealth | null;
  onSelect: (project: RegisteredProject) => void;
  onPause: (project: RegisteredProject) => void;
  onResume: (project: RegisteredProject) => void;
  onRemove: (project: RegisteredProject) => void;
  availabilityMappings?: Array<ProjectNodeAvailability & { displayName: string }>;
  isLoading?: boolean;
}

const STATUS_CONFIG: Record<ProjectStatus, { label: string; color: string; icon: typeof Play }> = {
  active: { label: "Active", color: "var(--color-success)", icon: Play },
  paused: { label: "Paused", color: "var(--color-warning)", icon: Pause },
  errored: { label: "Error", color: "var(--color-error)", icon: AlertCircle },
  initializing: { label: "Initializing", color: "var(--color-warning)", icon: Loader2 },
};

function formatRelativeTime(timestamp: string | undefined): string {
  if (!timestamp) return "Never";
  
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

function truncatePath(path: string, maxLength: number = 40): string {
  if (path.length <= maxLength) return path;
  const start = path.slice(0, Math.floor(maxLength / 2) - 2);
  const end = path.slice(-Math.floor(maxLength / 2) + 2);
  return `${start}...${end}`;
}

function areProjectCardPropsEqual(previous: ProjectCardProps, next: ProjectCardProps): boolean {
  if (previous.project.id !== next.project.id) return false;
  if (previous.project.status !== next.project.status) return false;
  if (previous.project.name !== next.project.name) return false;
  if (previous.project.path !== next.project.path) return false;
  if (previous.project.lastActivityAt !== next.project.lastActivityAt) return false;
  if (previous.isLoading !== next.isLoading) return false;
  
  // Compare health
  const prevHealth = previous.health;
  const nextHealth = next.health;
  if (!prevHealth && !nextHealth) return true;
  if (!prevHealth || !nextHealth) return false;
  
  if (
    prevHealth.activeTaskCount !== nextHealth.activeTaskCount ||
    prevHealth.inFlightAgentCount !== nextHealth.inFlightAgentCount ||
    prevHealth.totalTasksCompleted !== nextHealth.totalTasksCompleted ||
    prevHealth.totalTasksFailed !== nextHealth.totalTasksFailed ||
    prevHealth.status !== nextHealth.status
  ) {
    return false;
  }

  const prevMappings = previous.availabilityMappings ?? [];
  const nextMappings = next.availabilityMappings ?? [];
  if (prevMappings.length !== nextMappings.length) return false;

  return prevMappings.every((mapping, index) => {
    const nextMapping = nextMappings[index];
    return Boolean(nextMapping)
      && mapping.nodeId === nextMapping.nodeId
      && mapping.path === nextMapping.path
      && mapping.displayName === nextMapping.displayName
      && mapping.available === nextMapping.available;
  });
}

function ProjectCardInner({
  project,
  health,
  onSelect,
  onPause,
  onResume,
  onRemove,
  availabilityMappings = [],
  isLoading = false,
}: ProjectCardProps) {
  const [removeArmed, setRemoveArmed] = useState(false);
  const statusConfig = STATUS_CONFIG[project.status];
  const StatusIcon = statusConfig.icon;

  const handleSelect = useCallback(() => {
    onSelect(project);
  }, [onSelect, project]);

  const handlePause = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onPause(project);
  }, [onPause, project]);

  const handleResume = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onResume(project);
  }, [onResume, project]);

  const handleRemove = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (!removeArmed) {
      setRemoveArmed(true);
      return;
    }

    onRemove(project);
    setRemoveArmed(false);
  }, [removeArmed, onRemove, project]);

  const isPaused = project.status === "paused";
  const isErrored = project.status === "errored";
  const isInitializing = project.status === "initializing";

  return (
    <div
      className={`project-card ${isLoading ? "project-card-loading" : ""} ${isErrored ? "project-card-errored" : ""}`}
      onClick={handleSelect}
      data-project-id={project.id}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          handleSelect();
        }
      }}
    >
      <div className="project-card-header">
        <div className="project-card-icon">
          <Folder size={20} />
        </div>
        <div className="project-card-title-section">
          <h3 className="project-card-name" title={project.name}>
            {project.name}
          </h3>
          {availabilityMappings.length > 0 && (
            <div className="project-card-availability" aria-label="Project node availability">
              {availabilityMappings.slice(0, 3).map((mapping) => (
                <div key={`${mapping.nodeId}-${mapping.path}`} className="project-card-availability__row" title={`${mapping.displayName} → ${mapping.path}`}>
                  <span className="project-card-availability__node">{mapping.displayName}</span>
                  <span className="project-card-availability__arrow">→</span>
                  <code className="project-card-availability__path">{truncatePath(mapping.path, 28)}</code>
                </div>
              ))}
              {availabilityMappings.length > 3 && (
                <span className="project-card-availability__more">+{availabilityMappings.length - 3} more</span>
              )}
            </div>
          )}
          <span className="project-card-path" title={project.path}>
            {truncatePath(project.path)}
          </span>
        </div>
        <div
          className="project-card-status-badge"
          style={{ color: statusConfig.color, borderColor: statusConfig.color }}
        >
          <StatusIcon size={12} className={isInitializing ? "animate-spin" : ""} />
          <span>{statusConfig.label}</span>
        </div>
      </div>

      <div className="project-card-health">
        {health && (
          <>
            <div className="project-card-metric">
              <span className="project-card-metric-value">{health.activeTaskCount}</span>
              <span className="project-card-metric-label">Active Tasks</span>
            </div>
            <div className="project-card-metric">
              <span className="project-card-metric-value">{health.inFlightAgentCount}</span>
              <span className="project-card-metric-label">Agents</span>
            </div>
            <div className="project-card-metric">
              <span className="project-card-metric-value">{health.totalTasksCompleted}</span>
              <span className="project-card-metric-label">Completed</span>
            </div>
          </>
        )}
        {!health && (
          <div className="project-card-metric project-card-metric-empty">
            <span className="project-card-metric-label">No health data available</span>
          </div>
        )}
      </div>

      <div className="project-card-footer">
        <div className="project-card-activity">
          <span className="project-card-activity-label">Last activity:</span>
          <span className="project-card-activity-time">
            {formatRelativeTime(project.lastActivityAt || health?.lastActivityAt)}
          </span>
        </div>

        <div className="project-card-actions">
          {isPaused ? (
            <button
              className="project-card-action project-card-action-resume"
              onClick={handleResume}
              disabled={isLoading}
              title="Resume project"
              aria-label="Resume project"
            >
              <Play size={14} />
              <span>Resume</span>
            </button>
          ) : (
            <button
              className="project-card-action project-card-action-pause"
              onClick={handlePause}
              disabled={isLoading || isInitializing}
              title={isInitializing ? "Cannot pause while initializing" : "Pause project"}
              aria-label="Pause project"
            >
              <Pause size={14} />
              <span>Pause</span>
            </button>
          )}
          
          <button
            className="project-card-action project-card-action-open"
            onClick={handleSelect}
            disabled={isLoading}
            title="Open project"
            aria-label="Open project"
          >
            <ArrowRight size={14} />
            <span>Open</span>
          </button>

          <button
            className={`project-card-action project-card-action-remove ${removeArmed ? "is-armed" : ""}`}
            onClick={handleRemove}
            disabled={isLoading}
            title={removeArmed ? "Confirm remove" : "Remove project"}
            aria-label={removeArmed ? "Confirm remove project" : "Remove project"}
          >
            <Trash2 size={14} />
            <span>{removeArmed ? "Confirm" : ""}</span>
          </button>
        </div>
      </div>
    </div>
  );
}

export const ProjectCard = memo(ProjectCardInner, areProjectCardPropsEqual);
