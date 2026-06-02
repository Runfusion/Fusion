import { AlertCircle, Loader2, Pause, Play } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ProjectStatus } from "@fusion/core";

export interface ProjectStatusConfig {
  label: string;
  color: string;
  icon: LucideIcon;
}

export const STATUS_CONFIG: Record<ProjectStatus, ProjectStatusConfig> = {
  active: { label: "Active", color: "var(--color-success)", icon: Play },
  paused: { label: "Paused", color: "var(--color-warning)", icon: Pause },
  errored: { label: "Error", color: "var(--color-error)", icon: AlertCircle },
  initializing: { label: "Initializing", color: "var(--color-info)", icon: Loader2 },
};

const FALLBACK_STATUS_CONFIG: ProjectStatusConfig = {
  label: "Unknown",
  color: "var(--color-error)",
  icon: AlertCircle,
};

export function formatStatusLabel(status: string | null | undefined): string {
  if (!status) {
    return FALLBACK_STATUS_CONFIG.label;
  }

  return status
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function getProjectStatusConfig(status: string | null | undefined): ProjectStatusConfig {
  const config = STATUS_CONFIG[status as ProjectStatus];
  if (config) {
    return config;
  }

  return {
    ...FALLBACK_STATUS_CONFIG,
    label: formatStatusLabel(status),
  };
}

export function isInitializingStatus(status: string | null | undefined): boolean {
  return status === "initializing";
}
