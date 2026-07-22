import type { WorkflowIr } from "./workflow-ir-types.js";
import type { WorkflowLifecycleWarning } from "./workflow-lifecycle-validation.js";

/** Editor layout position for a single workflow IR node. Persisted separately
 *  from the IR because the v1 IR contract deliberately excludes node geometry. */
export interface WorkflowNodeLayout {
  x: number;
  y: number;
}

/** Discriminates a full, selectable workflow from a reusable single-node
 *  "fragment" template (workflow-editor-consolidation U1, KTD-1). Fragments are
 *  excluded from task workflow pickers, default-workflow selection, and the
 *  compile/selection paths; both kinds are stored as parseable full IRs. */
export type WorkflowDefinitionKind = "workflow" | "fragment";

export const MAX_WORKFLOW_ICON_LENGTH = 16;

/**
 * Normalize optional custom workflow icon metadata for persistence and API output.
 *
 * FNXC:WorkflowIcons 2026-06-30-12:00:
 * Workflow icons are operator-authored compact plain text, not markup or remote media.
 * Reject HTML/SVG/script/URL-shaped values at every write boundary so dashboard renderers can treat the icon as text-only identity metadata.
 */
export function normalizeWorkflowIcon(icon: unknown): string | undefined {
  if (icon === undefined || icon === null) return undefined;
  if (typeof icon !== "string") {
    throw new Error("Workflow icon must be a string");
  }
  const normalized = icon.trim();
  if (!normalized) return undefined;
  if (normalized.length > MAX_WORKFLOW_ICON_LENGTH) {
    throw new Error(`Workflow icon must be ${MAX_WORKFLOW_ICON_LENGTH} characters or fewer`);
  }
  if (/[<>]/.test(normalized) || /javascript:/i.test(normalized) || /^https?:\/\//i.test(normalized) || /^data:/i.test(normalized)) {
    throw new Error("Workflow icon must be plain text, not HTML, SVG, script, or a URL");
  }
  return normalized;
}

/** A named, persisted workflow authored as a WorkflowIr graph plus editor layout. */
export interface WorkflowDefinition {
  /** Unique identifier (e.g., "WF-001"). */
  id: string;
  /** Display name. */
  name: string;
  /** Short description for UI display. */
  description: string;
  /** Optional compact plain-text icon for custom workflow identity. */
  icon?: string;
  /** Discriminates full workflows from reusable fragment templates (KTD-1). */
  kind: WorkflowDefinitionKind;
  /** The validated workflow graph (v1 IR contract). */
  ir: WorkflowIr;
  /** Editor node positions keyed by IR node id. May be empty (auto-layout). */
  layout: Record<string, WorkflowNodeLayout>;
  /** Non-blocking lifecycle guidance for custom workflow authors. */
  lifecycleWarnings?: WorkflowLifecycleWarning[];
  /** ISO-8601 timestamp of creation. */
  createdAt: string;
  /** ISO-8601 timestamp of last update. */
  updatedAt: string;
}

/*
FNXC:WorkflowPersistence 2026-07-14-13:35:
SQLite and PostgreSQL workflow readers must share one storage-row contract so migration-parity fields such as the custom icon cannot disappear at a mapper boundary.
*/
export interface StoredWorkflowRow {
  id: string;
  name: string;
  description: string;
  icon: string | null;
  ir: string;
  layout: string;
  kind: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Input for creating a workflow definition. */
export interface WorkflowDefinitionInput {
  name: string;
  description?: string;
  /** Optional compact plain-text icon for custom workflow identity. */
  icon?: string;
  /** Workflow graph; validated via parseWorkflowIr on write. */
  ir: WorkflowIr;
  layout?: Record<string, WorkflowNodeLayout>;
  /** Discriminates full workflows from reusable fragment templates (KTD-1).
   *  Defaults to "workflow" when omitted. */
  kind?: WorkflowDefinitionKind;
}

/** Partial update for an existing workflow definition. */
export interface WorkflowDefinitionUpdate {
  name?: string;
  description?: string;
  /** Optional compact plain-text icon for custom workflow identity; blank clears it. */
  icon?: string | null;
  ir?: WorkflowIr;
  layout?: Record<string, WorkflowNodeLayout>;
  /**
   * U5 (R20): when an IR update removes a column that still holds cards, the
   * update is blocked with a typed {@link import("./workflow-reconciliation.js").OccupiedColumnsError}
   * unless `rehomeTo` is supplied — an explicit "save and re-home occupants to
   * column X" target. The target must survive in the new IR. Consulted by the
   * default workflow-column runtime.
   */
  rehomeTo?: string;
  /**
   * Column-agent policy escalation (column-agent plan R13): set true to confirm
   * binding a column agent whose permission policy is broader than the project
   * default. Without it, the write surfaces (dashboard routes, fn_workflow_*
   * tools) reject such bindings with a typed policy-escalation error.
   */
  confirmPolicyEscalation?: boolean;
  /**
   * U11/KTD-13: when an IR update changes a custom field's type incompatibly for
   * tasks that already hold a value under that field, the update is blocked with
   * a typed {@link import("./workflow-reconciliation.js").IncompatibleFieldChangeError}
   * unless `coerce` is supplied. `"drop"` discards the now-incompatible stored
   * values; `"keep-orphaned"` retains them as orphans (rendered under the
   * orphaned-fields disclosure). Removing a field outright always orphans (never
   * blocks). Mirrors the `rehomeTo` conflict-resolution posture for columns.
   */
  coerce?: "drop" | "keep-orphaned";
}
