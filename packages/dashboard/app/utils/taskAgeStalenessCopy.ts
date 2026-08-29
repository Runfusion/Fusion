import type { Task, TaskAgeStalenessSignal } from "@fusion/core";

export interface TaskAgeStalenessCopy {
  badgeLabel: string;
  badgeTone: "warning" | "critical";
  headline: string;
  description: string;
}

function formatAge(ageMs: number): string {
  const totalMinutes = Math.max(1, Math.floor(ageMs / 60_000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0 && days === 0) parts.push(`${minutes}m`);
  return parts.join(" ");
}

export function getTaskAgeStalenessCopy(signal: TaskAgeStalenessSignal | undefined | null): TaskAgeStalenessCopy | null {
  if (!signal) return null;
  const ageLabel = formatAge(signal.ageMs);
  const pausedNote = signal.paused ? " while paused" : "";
  const tone = signal.level === "critical" ? "critical" : "warning";
  return {
    badgeLabel: tone === "critical" ? "Stale (critical)" : "Stale",
    badgeTone: tone,
    headline: `${signal.column} task stale for ${ageLabel}`,
    description: `Task has been stale for ${ageLabel}${pausedNote}. Thresholds: warning ${formatAge(signal.warningThresholdMs)}, critical ${formatAge(signal.criticalThresholdMs)}.`,
  };
}

export function shouldShowTaskAgeStalenessBadge(task: Pick<Task, "ageStaleness">): boolean {
  return task.ageStaleness != null;
}
