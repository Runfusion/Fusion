import type { AgentStore } from "./agent-store.js";
import type { Settings } from "./types.js";
import type { WorkflowIr, WorkflowIrColumn } from "./workflow-ir-types.js";
import {
  isPolicyBroaderThanDefault,
  resolveEffectiveAgentPermissionPolicy,
} from "./agent-permission-policy.js";

/**
 * Typed error raised when a workflow IR binds a column to an agent that fails a
 * write-time check (existence or policy escalation, R11/R13). Carries the
 * offending column id and a `reason` discriminant so each write surface can map
 * it to its own transport (the dashboard route → an HTTP 400; the agent tools →
 * a structured tool error) without re-deriving the message.
 *
 * Shared between the dashboard workflow route and the `fn_workflow_create` /
 * `fn_workflow_update` agent tools so both write paths enforce the SAME gate —
 * an agent must not be able to persist a binding the UI would reject.
 */
export type ColumnAgentBindingReason =
  | "unknown-agent"
  | "policy-escalation"
  /** U2: in simple mode the same agent staffs more than one column of this board. */
  | "agent-multiple-columns"
  /** U2: a mandatory role column (lead/executor/reviewer) was left unstaffed. */
  | "mandatory-column-unstaffed";

export class ColumnAgentBindingError extends Error {
  readonly columnId: string;
  /** May be the empty string for {@link ColumnAgentBindingReason} cases that are
   *  not about a specific agent (e.g. an unstaffed mandatory column). */
  readonly agentId: string;
  readonly reason: ColumnAgentBindingReason;

  constructor(args: {
    message: string;
    columnId: string;
    agentId: string;
    reason: ColumnAgentBindingReason;
  }) {
    super(args.message);
    this.name = "ColumnAgentBindingError";
    this.columnId = args.columnId;
    this.agentId = args.agentId;
    this.reason = args.reason;
  }
}

/**
 * Write-time column-agent validation (U6, R11/R13), shared by every write
 * surface. Inspects an IR's columns BEFORE it is persisted and throws a typed
 * {@link ColumnAgentBindingError} naming the offending column. Never mutates the
 * IR and never touches the store/scheduler.
 *
 * Two checks per bound column:
 *  1. Existence — every `column.agent.agentId` must resolve in the agent
 *     registry; an unknown id throws (`reason: "unknown-agent"`) so the binding
 *     can't be saved and silently fall back at execution time.
 *  2. Policy escalation (R13) — if the bound agent's effective permission policy
 *     is broader (more privileged) than the project default on any action
 *     category, the write requires an explicit `confirmPolicyEscalation` flag,
 *     else it throws (`reason: "policy-escalation"`). Override must never
 *     silently re-key action gates to a more-privileged agent.
 *
 * Config is data: bindings are accepted regardless of feature flags — flags gate
 * execution, not storage. A null/non-object IR or columns array is left to the
 * store's own validator (this only inspects shapes it can read).
 *
 * Board-scoped staffing constraints (U2, R1/R3) — opt-in via the new args, so
 * existing call sites that omit them keep their exact prior behavior:
 *  (a) one-agent-per-column is implicit (a column carries at most one binding).
 *      One agent staffing TWO columns of the same board is rejected ONLY in
 *      `mode: "simple"` (`reason: "agent-multiple-columns"`); `mode: "advanced"`
 *      (the default) permits it. Cross-board sharing is always allowed because
 *      this validator only ever sees one board's IR at a time.
 *  (b) a mandatory role column (its id in `mandatoryRoleColumnIds`) can never be
 *      left unstaffed — an unbound mandatory column is rejected
 *      (`reason: "mandatory-column-unstaffed"`). Pass the ids to enforce; omit to
 *      skip (legacy callers).
 */
export async function validateColumnAgentBindings(args: {
  ir: WorkflowIr | unknown;
  agentStore: AgentStore;
  settings: Pick<Settings, "defaultAgentPermissionPolicy">;
  confirmPolicyEscalation: boolean;
  /** Staffing-constraint mode (U2). `"advanced"` (default) permits one agent on
   *  multiple columns of the board; `"simple"` rejects it. */
  mode?: "simple" | "advanced";
  /** Column ids that must always be staffed (U2). Empty/omitted → no check. */
  mandatoryRoleColumnIds?: readonly string[];
}): Promise<void> {
  const { ir, agentStore, settings, confirmPolicyEscalation } = args;
  const mode = args.mode ?? "advanced";
  const mandatory = args.mandatoryRoleColumnIds ?? [];
  const columns = (ir as { columns?: unknown })?.columns;
  if (!Array.isArray(columns)) return;
  const typedColumns = columns as WorkflowIrColumn[];
  const bound = typedColumns.filter(
    (col) => col && typeof col === "object" && col.agent && typeof col.agent.agentId === "string",
  );

  // (b) Mandatory-role columns must be staffed (R1). Checked even when nothing is
  // bound — an entirely unstaffed mandatory column is the failure we guard.
  if (mandatory.length > 0) {
    for (const columnId of mandatory) {
      const col = typedColumns.find((c) => c && c.id === columnId);
      // A mandatory column that exists in the IR must carry a binding. A mandatory
      // column entirely absent from the IR is a template-shape problem owned by
      // U3 reconciliation, not this binding validator, so we only flag present-
      // but-unstaffed columns here.
      if (col && (!col.agent || typeof col.agent.agentId !== "string")) {
        throw new ColumnAgentBindingError({
          message: `Mandatory role column '${columnId}' must be staffed by an agent`,
          columnId,
          agentId: "",
          reason: "mandatory-column-unstaffed",
        });
      }
    }
  }

  if (bound.length === 0) return;

  // (a) One agent staffing multiple columns of THIS board — rejected in simple
  // mode only. Cross-board sharing is never visible here (one IR per call).
  if (mode === "simple") {
    const seen = new Map<string, string>(); // agentId → first columnId
    for (const col of bound) {
      const agentId = col.agent!.agentId;
      const firstColumn = seen.get(agentId);
      if (firstColumn !== undefined) {
        throw new ColumnAgentBindingError({
          message:
            `Agent '${agentId}' is already staffed on column '${firstColumn}'; in simple mode an ` +
            `agent may staff at most one column per board (column '${col.id}' rejected)`,
          columnId: col.id,
          agentId,
          reason: "agent-multiple-columns",
        });
      }
      seen.set(agentId, col.id);
    }
  }

  const defaultPolicy = resolveEffectiveAgentPermissionPolicy(
    undefined,
    settings.defaultAgentPermissionPolicy,
  );

  for (const col of bound) {
    const agentId = col.agent!.agentId;
    const agent = await agentStore.getAgent(agentId);
    if (!agent) {
      throw new ColumnAgentBindingError({
        message: `Column '${col.id}' binds unknown agent '${agentId}'`,
        columnId: col.id,
        agentId,
        reason: "unknown-agent",
      });
    }
    const agentPolicy = resolveEffectiveAgentPermissionPolicy(
      agent.permissionPolicy,
      settings.defaultAgentPermissionPolicy,
    );
    if (isPolicyBroaderThanDefault(agentPolicy, defaultPolicy) && !confirmPolicyEscalation) {
      throw new ColumnAgentBindingError({
        message:
          `Column '${col.id}' binds agent '${agentId}' whose permission policy is broader than ` +
          `the project default; set confirmPolicyEscalation: true to confirm`,
        columnId: col.id,
        agentId,
        reason: "policy-escalation",
      });
    }
  }
}
