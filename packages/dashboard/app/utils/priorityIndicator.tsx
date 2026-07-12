import { ArrowDown, ArrowUp, Flag, TriangleAlert, type LucideIcon } from "lucide-react";
import type { TaskPriority } from "@fusion/core";

export interface PriorityIndicator {
  icon: LucideIcon;
  label: string;
}

/*
FNXC:QuickAddPriorityIndicator 2026-07-10-12:00:
Quick-add and New Task priority affordances must share one glyph language: ArrowUp means high, ArrowDown means low, Flag means normal, and TriangleAlert means urgent. Keep this helper as the single source so icon-only priority buttons do not drift across composer surfaces.
*/
const PRIORITY_INDICATORS: Record<TaskPriority, PriorityIndicator> = {
  low: { icon: ArrowDown, label: "Low" },
  normal: { icon: Flag, label: "Normal" },
  high: { icon: ArrowUp, label: "High" },
  urgent: { icon: TriangleAlert, label: "Urgent" },
};

export function priorityIndicator(priority: TaskPriority): PriorityIndicator {
  return PRIORITY_INDICATORS[priority];
}

export function getPriorityIcon(priority: TaskPriority): LucideIcon {
  return priorityIndicator(priority).icon;
}

export function getPriorityLabel(priority: TaskPriority): string {
  return priorityIndicator(priority).label;
}
