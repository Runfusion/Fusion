import { ArrowDown, ArrowUp, Flag, TriangleAlert, type LucideIcon } from "lucide-react";
import type { TaskPriority } from "@fusion/core";

export interface PriorityIndicator {
  icon: LucideIcon;
  label: string;
  colorVar: string;
}

/*
FNXC:QuickAddPriorityIndicator 2026-07-10-12:00:
Quick-add and New Task priority affordances must share one glyph language: ArrowUp means high, ArrowDown means low, Flag means normal, and TriangleAlert means urgent. Keep this helper as the single source so icon-only priority buttons do not drift across composer surfaces.

FNXC:PriorityColorCoding 2026-07-11-00:00:
Priority affordances in quick add, the New Task inline row, and task cards must be color-coded by urgency from this single source: low=info, normal=muted, high=warning, urgent=error. Use semantic dashboard tokens only so composer glyphs and card badges cannot drift.
*/
const PRIORITY_INDICATORS: Record<TaskPriority, PriorityIndicator> = {
  low: { icon: ArrowDown, label: "Low", colorVar: "var(--color-info)" },
  normal: { icon: Flag, label: "Normal", colorVar: "var(--text-muted)" },
  high: { icon: ArrowUp, label: "High", colorVar: "var(--color-warning)" },
  urgent: { icon: TriangleAlert, label: "Urgent", colorVar: "var(--color-error)" },
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

export function getPriorityColorVar(priority: TaskPriority): string {
  return priorityIndicator(priority).colorVar;
}
