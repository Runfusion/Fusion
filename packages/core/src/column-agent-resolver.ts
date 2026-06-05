/**
 * Column-agent effective resolution (column-agent plan KTD-2).
 *
 * One shared resolver in `@fusion/core` consumed by every reader (the three engine
 * resolution sites and the dashboard write-validation route) so engine and route
 * can never drift — the route/engine predicate-drift learning
 * (`docs/solutions/integration-issues/branch-group-single-pr-synthetic-id-dead-wiring.md`).
 *
 * Two pure functions:
 *   - `resolveColumnAgentBinding(ir, nodeId)` — declared-column lookup with foreach
 *     template inheritance — answers "which column binding (if any) governs this
 *     node's work?".
 *   - `resolveEffectiveAgent(...)` — defer/override precedence as EXPLICIT named
 *     branches (never a `??` effective-value collapse), per the per-task
 *     auto-merge-override learning
 *     (`docs/solutions/logic-errors/per-task-auto-merge-override-ignored-by-trigger-gates.md`).
 *     Returns a discriminated result so callers and audit logs can state *why* an
 *     agent was chosen.
 *
 * This module must stay DI-clean: `@fusion/core` never imports from `@fusion/engine`.
 */

import type { WorkflowColumnAgent, WorkflowForeachConfig, WorkflowIr } from "./workflow-ir-types.js";

// ── Foreach instance node-id ownership (column-agent plan KTD-2) ──────────────
// The instance-id FORMAT (`<foreachId>#<stepIndex>:<templateNodeId>`) now has
// exactly one owner here in core. The engine re-points its import (was
// `workflow-graph-foreach.ts`). The format itself is unchanged.

/** Materialize a deterministic foreach instance node id (step-inversion KTD-3).
 *  Pure, no IR mutation. Format: `<foreachId>#<stepIndex>:<templateNodeId>`. */
export function instanceNodeId(
  foreachNodeId: string,
  stepIndex: number,
  templateNodeId: string,
): string {
  return `${foreachNodeId}#${stepIndex}:${templateNodeId}`;
}

/** Parsed components of a foreach instance node id. */
export interface ParsedInstanceNodeId {
  foreachNodeId: string;
  stepIndex: number;
  templateNodeId: string;
}

/** Parse a foreach instance node id back into its components, or `undefined` when
 *  `nodeId` is not in instance form. Defensive against `templateNodeId` itself
 *  containing `:` — split on the FIRST `#`, then the FIRST `:` of the remainder,
 *  and keep everything after that as the template node id. The `templateNodeId` is
 *  not sanitized against `:`, so a greedy/last-delimiter split would corrupt it.
 *
 *  NOTE: a `foreachNodeId` that itself contains `#` is ambiguous under any single
 *  split. Callers that hold the IR should use {@link parseInstanceNodeIdCandidates}
 *  and validate each candidate's `foreachNodeId` against the graph (as
 *  `resolveColumnAgentBinding` does) instead of trusting one split position. */
export function parseInstanceNodeId(nodeId: string): ParsedInstanceNodeId | undefined {
  const hashIndex = nodeId.indexOf("#");
  if (hashIndex < 0) return undefined;
  return parseInstanceNodeIdAt(nodeId, hashIndex);
}

/** Parse treating the `#` at `hashIndex` as the instance-id delimiter. */
function parseInstanceNodeIdAt(nodeId: string, hashIndex: number): ParsedInstanceNodeId | undefined {
  const foreachNodeId = nodeId.slice(0, hashIndex);
  const remainder = nodeId.slice(hashIndex + 1);
  const colonIndex = remainder.indexOf(":");
  if (colonIndex < 0) return undefined;
  const stepIndexRaw = remainder.slice(0, colonIndex);
  const templateNodeId = remainder.slice(colonIndex + 1);
  if (foreachNodeId === "" || templateNodeId === "") return undefined;
  // stepIndex must be a non-negative integer; reject anything else as non-instance.
  if (!/^\d+$/.test(stepIndexRaw)) return undefined;
  const stepIndex = Number(stepIndexRaw);
  return { foreachNodeId, stepIndex, templateNodeId };
}

/** Every plausible parse of `nodeId` as an instance id — one candidate per `#`
 *  whose suffix matches the `<digits>:` shape. The id format is ambiguous when
 *  node ids themselves contain `#` (e.g. foreach `f#a`, instance `f#a#0:t` — both
 *  the first and second `#` look like delimiters), so callers with access to the
 *  graph validate each candidate's `foreachNodeId` against real foreach nodes
 *  rather than committing to a single split position. Ordered left-to-right. */
export function parseInstanceNodeIdCandidates(nodeId: string): ParsedInstanceNodeId[] {
  const candidates: ParsedInstanceNodeId[] = [];
  for (let i = nodeId.indexOf("#"); i >= 0; i = nodeId.indexOf("#", i + 1)) {
    const parsed = parseInstanceNodeIdAt(nodeId, i);
    if (parsed) candidates.push(parsed);
  }
  return candidates;
}

// ── Binding lookup ───────────────────────────────────────────────────────────

/** Index a graph's top-level nodes by id (handles v1 + v2 shapes). */
function topLevelNodesById(ir: WorkflowIr): Map<string, WorkflowIr["nodes"][number]> {
  return new Map(ir.nodes.map((n) => [n.id, n]));
}

/** Resolve the agent binding (if any) that governs the work of `nodeId`.
 *
 *  A column WITHOUT an `agent` field yields `undefined` — that, not "column
 *  undeclared," is the operative guarantee, since v1→v2 upgrade synthesizes a
 *  column for every node (column-agent plan KTD-2).
 *
 *  Foreach instance ids (`<foreachId>#<i>:<templateNodeId>`) resolve against the
 *  ENCLOSING foreach node's column, but a template node that declares its OWN
 *  `column` wins over inheritance (R4). */
export function resolveColumnAgentBinding(
  ir: WorkflowIr,
  nodeId: string,
): WorkflowColumnAgent | undefined {
  // v1 graphs have no columns and therefore no bindings. (Callers normally parse
  // to v2 first, but stay defensive.)
  if (ir.version !== "v2") return undefined;

  const columnsById = new Map(ir.columns.map((c) => [c.id, c]));
  const bindingForColumn = (columnId: string | undefined): WorkflowColumnAgent | undefined => {
    if (columnId === undefined) return undefined;
    return columnsById.get(columnId)?.agent;
  };

  const nodesById = topLevelNodesById(ir);

  // Direct (top-level) node.
  const direct = nodesById.get(nodeId);
  if (direct) {
    return bindingForColumn(direct.column);
  }

  // Foreach instance node: resolve against the enclosing foreach, honoring a
  // template node's own declared column. The instance-id format is ambiguous when
  // node ids contain `#`, so try every plausible split and accept the first whose
  // foreachNodeId names a REAL foreach node in this graph — a single fixed split
  // (first-# or last-#) silently bypasses bindings for ids on the other side of
  // the ambiguity (PR #1432 review).
  for (const parsed of parseInstanceNodeIdCandidates(nodeId)) {
    const foreachNode = nodesById.get(parsed.foreachNodeId);
    if (!foreachNode || foreachNode.kind !== "foreach") continue;

    const cfg = foreachNode.config as Partial<WorkflowForeachConfig> | undefined;
    const templateNodes = cfg?.template?.nodes ?? [];
    const templateNode = templateNodes.find((n) => n.id === parsed.templateNodeId);
    // Disambiguation guard (PR #1432 review): a bogus prefix candidate can name a
    // real foreach while its templateNodeId doesn't exist under it — skip it so a
    // later exact parse isn't masked. A template with no nodes still inherits.
    if (templateNodes.length > 0 && !templateNode) continue;

    // Template node's own column wins; otherwise inherit the foreach node's column.
    if (templateNode?.column !== undefined) {
      return bindingForColumn(templateNode.column);
    }
    return bindingForColumn(foreachNode.column);
  }
  return undefined;
}

// ── Effective-agent precedence (defer / override) ────────────────────────────

/** Inputs to the effective-agent decision. `ownAgentId` is the work's own agent
 *  identity (node `cfg.agentId` or `task.assignedAgentId`); `ownModelProvider` /
 *  `ownModelId` are the work's own model pair (node cfg or task model fields). */
export interface EffectiveAgentInput {
  /** The binding governing this node, from `resolveColumnAgentBinding`. */
  binding: WorkflowColumnAgent | undefined;
  /** The work's own agent identity, if any. */
  ownAgentId?: string;
  /** The work's own model provider, if any. */
  ownModelProvider?: string;
  /** The work's own model id, if any. */
  ownModelId?: string;
}

/** Discriminated result of effective-agent resolution: callers and audit logs can
 *  state *why* an agent was (or was not) chosen (column-agent plan KTD-2). */
export type EffectiveAgentResult =
  | { source: "column-agent"; agentId: string }
  | { source: "own-settings" }
  | { source: "none" };

/** Does the work carry "own settings" that suppress a `defer` column agent
 *  (column-agent plan KTD-5)? All-or-nothing: an own agent identity OR a COMPLETE
 *  modelProvider+modelId pair counts. A lone provider with no modelId and no
 *  agentId does NOT count — matching `resolveExecutorSessionModel`'s both-present
 *  rule (`packages/engine/src/agent-session-helpers.ts:147-150`). */
function hasOwnSettings(input: EffectiveAgentInput): boolean {
  const hasOwnAgent = typeof input.ownAgentId === "string" && input.ownAgentId !== "";
  const hasCompletePair =
    typeof input.ownModelProvider === "string" &&
    input.ownModelProvider !== "" &&
    typeof input.ownModelId === "string" &&
    input.ownModelId !== "";
  return hasOwnAgent || hasCompletePair;
}

/** Decide the effective agent for a node's work using the two EXPLICIT named rules
 *  (column-agent plan KTD-2/KTD-5):
 *  - No binding → `own-settings` if the work has any, else `none`.
 *  - `override` → the column agent ALWAYS (identity + model + persona).
 *  - `defer` → the column agent ONLY when the work has no own settings; otherwise
 *    own settings win.
 *  No `??` collapse: each branch is named so audit can explain the choice. */
export function resolveEffectiveAgent(input: EffectiveAgentInput): EffectiveAgentResult {
  const { binding } = input;

  if (!binding) {
    return hasOwnSettings(input) ? { source: "own-settings" } : { source: "none" };
  }

  if (binding.mode === "override") {
    return { source: "column-agent", agentId: binding.agentId };
  }

  // mode === "defer": column agent only when the work carries no own settings.
  if (hasOwnSettings(input)) {
    return { source: "own-settings" };
  }
  return { source: "column-agent", agentId: binding.agentId };
}
