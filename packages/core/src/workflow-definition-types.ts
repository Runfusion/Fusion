import type { WorkflowIr } from "./workflow-ir-types.js";

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

/** A named, persisted workflow authored as a WorkflowIr graph plus editor layout. */
export interface WorkflowDefinition {
  /** Unique identifier (e.g., "WF-001"). */
  id: string;
  /** Display name. */
  name: string;
  /** Short description for UI display. */
  description: string;
  /** Discriminates full workflows from reusable fragment templates (KTD-1). */
  kind: WorkflowDefinitionKind;
  /** The validated workflow graph (v1 IR contract). */
  ir: WorkflowIr;
  /** Editor node positions keyed by IR node id. May be empty (auto-layout). */
  layout: Record<string, WorkflowNodeLayout>;
  /** ISO-8601 timestamp of creation. */
  createdAt: string;
  /** ISO-8601 timestamp of last update. */
  updatedAt: string;
}

/** Input for creating a workflow definition. */
export interface WorkflowDefinitionInput {
  name: string;
  description?: string;
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
  ir?: WorkflowIr;
  layout?: Record<string, WorkflowNodeLayout>;
  /**
   * U5 (R20): when an IR update removes a column that still holds cards, the
   * update is blocked with a typed {@link import("./workflow-reconciliation.js").OccupiedColumnsError}
   * unless `rehomeTo` is supplied — an explicit "save and re-home occupants to
   * column X" target. The target must survive in the new IR. Only consulted when
   * the `workflowColumns` flag is ON.
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
