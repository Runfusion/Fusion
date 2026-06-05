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
export class ColumnAgentBindingError extends Error {
  readonly columnId: string;
  readonly agentId: string;
  readonly reason: "unknown-agent" | "policy-escalation";

  constructor(args: {
    message: string;
    columnId: string;
    agentId: string;
    reason: "unknown-agent" | "policy-escalation";
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
 */
export async function validateColumnAgentBindings(args: {
  ir: WorkflowIr | unknown;
  agentStore: AgentStore;
  settings: Pick<Settings, "defaultAgentPermissionPolicy">;
  confirmPolicyEscalation: boolean;
}): Promise<void> {
  const { ir, agentStore, settings, confirmPolicyEscalation } = args;
  const columns = (ir as { columns?: unknown })?.columns;
  if (!Array.isArray(columns)) return;
  const bound = (columns as WorkflowIrColumn[]).filter(
    (col) => col && typeof col === "object" && col.agent && typeof col.agent.agentId === "string",
  );
  if (bound.length === 0) return;

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
