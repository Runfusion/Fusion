import type {
  WorkflowIr,
  WorkflowIrColumn,
  WorkflowIrEdge,
  WorkflowIrNode,
  WorkflowIrNodeKind,
  WorkflowIrV1,
  WorkflowIrV2,
  WorkflowHoldRelease,
  WorkflowForeachConfig,
  WorkflowLoopConfig,
  WorkflowOptionalGroupConfig,
  WorkflowFieldDefinition,
  WorkflowFieldType,
  WorkflowSettingDefinition,
  WorkflowSettingType,
} from "./workflow-ir-types.js";
import { getWorkflowExtensionRegistry } from "./workflow-extension-registry.js";
import type { WorkflowExtensionConfigField } from "./workflow-extension-types.js";
import { THINKING_LEVELS } from "./types.js";
import { resolveColumnFlags } from "./trait-registry.js";
// Side-effect import: registers the built-in traits so `resolveColumnFlags`
// resolves the built-in `merge-blocker`/`intake` flags during save-time
// validation (U2). Custom/plugin traits that set the same flags resolve too.
import "./builtin-traits.js";

export class WorkflowIrError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowIrError";
  }
}

const HOLD_RELEASE_KINDS: ReadonlySet<WorkflowHoldRelease> = new Set([
  "manual",
  "timer",
  "capacity",
  "dependency",
  "external-event",
]);

/** Seam config values that may not appear inside a parallel branch (KTD-11):
 *  one worktree/session per task and exclusive merge are physical constraints.
 *  Step-inversion (KTD-4) extends this posture: `step-execute` seam prompt nodes
 *  may never appear in a split branch either. */
const SEAM_FORBIDDEN_IN_BRANCH: ReadonlySet<string> = new Set([
  "execute",
  "merge",
  "step-execute",
]);

/** Step-inversion field-type whitelist (KTD-13). */
const WORKFLOW_FIELD_TYPES: ReadonlySet<WorkflowFieldType> = new Set([
  "string",
  "text",
  "number",
  "boolean",
  "enum",
  "multi-enum",
  "date",
  "url",
]);

const FIELD_RENDER_PLACEMENTS: ReadonlySet<string> = new Set([
  "card",
  "detail",
  "detail-section",
]);

const FIELD_RENDER_WIDGETS: ReadonlySet<string> = new Set([
  "select",
  "radio",
  "chips",
  "input",
  "textarea",
  "toggle",
]);

const THINKING_LEVEL_SET: ReadonlySet<string> = new Set(THINKING_LEVELS);

/** Workflow-settings (U1) value-type whitelist (mirrors WORKFLOW_FIELD_TYPES). */
export const WORKFLOW_SETTING_TYPES: ReadonlySet<WorkflowSettingType> = new Set([
  "string",
  "text",
  "number",
  "boolean",
  "enum",
  "multi-enum",
]);

/** Workflow-settings render-widget whitelist (mirrors FIELD_RENDER_WIDGETS;
 *  no placement — settings have no card/detail placement). */
export const SETTING_RENDER_WIDGETS: ReadonlySet<string> = new Set([
  "select",
  "radio",
  "chips",
  "input",
  "textarea",
  "toggle",
]);

/** Hard cap on a foreach `maxReworkCycles` (KTD-5: default 3, clamp >10 to 10,
 *  reject <1). */
const MAX_REWORK_CYCLES_CAP = 10;

/** Parallel concurrency bounds (KTD-3): range 1..8. */
const MAX_FOREACH_CONCURRENCY = 8;
const MAX_LOOP_ITERATIONS_CAP = 50;
const MAX_LOOP_TIMEOUT_MS = 3_600_000;
const WORKFLOW_EXTENSION_KEY_PATTERN = /^plugin:[a-z0-9]([a-z0-9-]*[a-z0-9])?:[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const MAX_LOOP_REGEX_PATTERN_LENGTH = 256;
const LOOP_REGEX_NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*[*+](?:[^()\\]|\\.)*\)\s*(?:[*+]|\{\d+,?\d*\})/;
const LOOP_REGEX_BACKREFERENCE = /\\[1-9]/;

/** The implicit step-source artifact allowed when no artifacts are declared. */
const IMPLICIT_DEFAULT_ARTIFACT = "PROMPT.md";

/** True when a prompt node carries the `step-execute` seam (KTD-2/KTD-4). */
function isStepExecuteNode(node: WorkflowIrNode): boolean {
  return node.kind === "prompt" && node.config?.seam === "step-execute";
}

function assertSafeLoopRegexPattern(nodeId: string, pattern: string): void {
  if (pattern.length > MAX_LOOP_REGEX_PATTERN_LENGTH) {
    throw new WorkflowIrError(
      `loop node '${nodeId}' exitWhen.pattern must be ${MAX_LOOP_REGEX_PATTERN_LENGTH} characters or fewer`,
    );
  }
  if (LOOP_REGEX_BACKREFERENCE.test(pattern) || LOOP_REGEX_NESTED_QUANTIFIER.test(pattern)) {
    throw new WorkflowIrError(
      `loop node '${nodeId}' exitWhen.pattern uses a potentially unsafe regex construct`,
    );
  }
}

/** Default-workflow column ids in legacy enum order (KTD-1). */
export const DEFAULT_WORKFLOW_COLUMN_IDS = [
  "triage",
  "todo",
  "in-progress",
  "in-review",
  "done",
  "archived",
] as const;

/** Place a v1 node into a synthesized default-workflow column by its seam. */
function defaultColumnForNode(node: WorkflowIrNode): string {
  const seam = node.config?.seam;
  if (seam === "execute") return "in-progress";
  if (seam === "review") return "in-review";
  if (seam === "merge") return "in-review";
  return "todo";
}

/** The synthesized default-workflow columns used when upgrading a v1 graph. The
 *  trait set here is intentionally minimal (placement only); the full default
 *  workflow with traits is BUILTIN_CODING_WORKFLOW_IR. */
function synthesizeDefaultColumns(): WorkflowIrColumn[] {
  return DEFAULT_WORKFLOW_COLUMN_IDS.map((id) => ({ id, name: id, traits: [] }));
}

/** Upgrade a v1 graph to v2 by synthesizing default columns and placing nodes
 *  by their seam (execute→in-progress, review/merge→in-review, others→todo). */
function upgradeV1ToV2(ir: WorkflowIrV1): WorkflowIrV2 {
  return {
    version: "v2",
    name: ir.name,
    columns: synthesizeDefaultColumns(),
    nodes: ir.nodes.map((node) =>
      node.column ? node : { ...node, column: defaultColumnForNode(node) },
    ),
    edges: ir.edges,
  };
}

function buildOutgoing(edges: WorkflowIrEdge[]): Map<string, WorkflowIrEdge[]> {
  const outgoing = new Map<string, WorkflowIrEdge[]>();
  for (const edge of edges) {
    const list = outgoing.get(edge.from);
    if (list) list.push(edge);
    else outgoing.set(edge.from, [edge]);
  }
  return outgoing;
}

function seamOf(node: WorkflowIrNode): string | undefined {
  const seam = node.config?.seam;
  return typeof seam === "string" ? seam : undefined;
}

/**
 * Validate `split`/`join` parallelism (KTD-11):
 *  - every split has a reachable matching join (recursively for nested splits);
 *  - execute/merge seam nodes inside a branch reject (seam-in-branch);
 *  - join `quorum(n)` with n exceeding the split's branch count rejects.
 */
function validateParallelism(
  nodes: WorkflowIrNode[],
  outgoing: Map<string, WorkflowIrEdge[]>,
  nodesById: Map<string, WorkflowIrNode>,
): void {
  const splits = nodes.filter((n) => n.kind === "split");

  for (const split of splits) {
    const branchEdges = outgoing.get(split.id) ?? [];
    if (branchEdges.length < 2) {
      throw new WorkflowIrError(`split '${split.id}' must fan out into at least two branches`);
    }

    // Walk each branch forward until the matching join is reached. Track join
    // hit-counts and ensure every branch reaches the SAME join (nested splits
    // resolve to their own join first, so balanced nesting still terminates).
    const joinsReached = new Set<string>();
    for (const edge of branchEdges) {
      const join = walkBranchToJoin(edge.to, split.id, outgoing, nodesById);
      if (!join) {
        throw new WorkflowIrError(`split '${split.id}' has a branch with no reachable matching join`);
      }
      joinsReached.add(join);
    }
    if (joinsReached.size !== 1) {
      throw new WorkflowIrError(`split '${split.id}' branches converge on more than one join`);
    }
    const joinId = [...joinsReached][0];
    const join = nodesById.get(joinId)!;

    const mode = join.config?.mode;
    if (mode && typeof mode === "object" && "quorum" in mode) {
      const n = (mode as { quorum: unknown }).quorum;
      if (typeof n !== "number" || !Number.isInteger(n) || n < 1) {
        throw new WorkflowIrError(`join '${join.id}' quorum must be a positive integer`);
      }
      if (n > branchEdges.length) {
        throw new WorkflowIrError(
          `join '${join.id}' quorum(${n}) exceeds the split's ${branchEdges.length} branches`,
        );
      }
    }
  }
}

/** Walk a single branch from `startNodeId` until a `join` node is reached.
 *  Rejects execute/merge seam nodes encountered inside the branch. Handles one
 *  level of nesting by recursing through inner splits to their inner join. */
function walkBranchToJoin(
  startNodeId: string,
  ownerSplitId: string,
  outgoing: Map<string, WorkflowIrEdge[]>,
  nodesById: Map<string, WorkflowIrNode>,
): string | undefined {
  const visited = new Set<string>();
  let cursor: string | undefined = startNodeId;
  while (cursor && !visited.has(cursor)) {
    visited.add(cursor);
    const node = nodesById.get(cursor);
    if (!node) return undefined;

    if (node.kind === "join") return node.id;

    if (node.kind === "split") {
      // Nested split: resolve to its inner join, then continue from there.
      const inner = (outgoing.get(node.id) ?? [])
        .map((e) => walkBranchToJoin(e.to, node.id, outgoing, nodesById))
        .find(Boolean);
      if (!inner) return undefined;
      cursor = innerJoinNext(inner, outgoing);
      continue;
    }

    const seam = seamOf(node);
    if (seam && SEAM_FORBIDDEN_IN_BRANCH.has(seam)) {
      throw new WorkflowIrError(
        `seam '${seam}' node '${node.id}' is forbidden inside a parallel branch of split '${ownerSplitId}'`,
      );
    }

    const next = (outgoing.get(cursor) ?? []).find((e) => e.condition !== "failure");
    cursor = next?.to;
  }
  return undefined;
}

/** The node following a join along its (non-failure) outgoing edge. */
function innerJoinNext(joinId: string, outgoing: Map<string, WorkflowIrEdge[]>): string | undefined {
  return (outgoing.get(joinId) ?? []).find((e) => e.condition !== "failure")?.to;
}

// ---------------------------------------------------------------------------
// Step-inversion validation (FN step-inversion, U1)
// ---------------------------------------------------------------------------

/** True for a `rework`-kind edge (KTD-5). */
function isReworkEdge(edge: WorkflowIrEdge): boolean {
  return edge.kind === "rework";
}

/** Collect the set of node ids reachable from `start` following non-rework edges
 *  (rework edges are intra-template back-edges; the top-level reachability /
 *  dominance analysis ignores them). */
function reachableFrom(
  start: string,
  outgoing: Map<string, WorkflowIrEdge[]>,
): Set<string> {
  const seen = new Set<string>();
  const queue = [start];
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const edge of outgoing.get(id) ?? []) {
      if (isReworkEdge(edge)) continue;
      if (!seen.has(edge.to)) queue.push(edge.to);
    }
  }
  return seen;
}

const INTERPRETER_ENTRY_NODE_KINDS: ReadonlySet<WorkflowIrNodeKind> = new Set([
  "merge-gate",
  "merge-attempt",
  "manual-merge-hold",
  "retry-backoff",
  "recovery-router",
  "branch-group-member-integration",
  "branch-group-promotion",
  "pr-create",
  "pr-respond",
  "pr-merge",
]);

/*
FNXC:WorkflowValidation 2026-07-18-22:10:
U2 — a `merge-blocker` column blocks entry to complete-bound columns until a
merge-class node has completed. If a workflow declares merge-blocker but the
graph contains no reachable merge-class node, the gate can NEVER clear and the
card is stranded forever. Save-time validation rejects that shape. Mirrors the
engine's MERGE_REGION_KINDS plus the PR merge node (a PR-based workflow clears
its merge-blocker via `pr-merge`).
*/
const MERGE_CLASS_NODE_KINDS: ReadonlySet<WorkflowIrNodeKind> = new Set([
  "merge-gate",
  "merge-attempt",
  "manual-merge-hold",
  "retry-backoff",
  "recovery-router",
  "branch-group-member-integration",
  "branch-group-promotion",
  "pr-merge",
]);

/** Collect the set of node ids reachable from `startId` over the given outgoing
 *  edge map (top-level graph reachability). */
function collectReachableNodeIds(
  startId: string,
  outgoing: Map<string, WorkflowIrEdge[]>,
): Set<string> {
  const reachable = new Set<string>([startId]);
  const stack = [startId];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const edge of outgoing.get(current) ?? []) {
      if (!reachable.has(edge.to)) {
        reachable.add(edge.to);
        stack.push(edge.to);
      }
    }
  }
  return reachable;
}

/**
 * U2 save-time hard error: a workflow declaring a `merge-blocker` column MUST
 * contain a merge-class node reachable from `start`. Without one the merge gate
 * never clears. Fails open (no rejection) when no column resolves the
 * merge-blocker flag — a merge-less docs-only workflow is unaffected.
 */
function validateMergeBlockerReachability(
  ir: WorkflowIrV2,
  outgoing: Map<string, WorkflowIrEdge[]>,
): void {
  const blockerColumn = ir.columns.find((c) => resolveColumnFlags(c).mergeBlocker === true);
  if (!blockerColumn) return;

  const startNode = ir.nodes.find((n) => n.kind === "start");
  // A start-less graph is rejected elsewhere; treat all nodes as candidates here
  // so this check never masks that more fundamental error.
  const reachable = startNode
    ? collectReachableNodeIds(startNode.id, outgoing)
    : new Set(ir.nodes.map((n) => n.id));

  // A merge-class node is a merge-region node KIND, or the legacy/linear merge
  // seam expressed as a prompt node with `config.seam === "merge"` (linear
  // built-ins and custom seam workflows use the latter).
  const isMergeClassNode = (n: WorkflowIrNode): boolean =>
    MERGE_CLASS_NODE_KINDS.has(n.kind) || n.config?.seam === "merge";
  const hasReachableMerge = ir.nodes.some((n) => isMergeClassNode(n) && reachable.has(n.id));
  if (!hasReachableMerge) {
    throw new WorkflowIrError(
      `Workflow column '${blockerColumn.id}' declares the merge-blocker trait but the graph has ` +
        `no reachable merge-class node (merge-gate/merge-attempt/manual-merge-hold/retry-backoff/` +
        `recovery-router/branch-group-*/pr-merge). The merge-blocker gate can never clear without one.`,
    );
  }
}

/**
 * Resolve a workflow's creation column — where new cards land (U2/R11). The
 * intake-flagged column if present; otherwise the first column is the documented
 * default. Returns undefined for a v1-style / empty-columns IR (no column model).
 */
export function resolveCreationColumn(ir: WorkflowIr): WorkflowIrColumn | undefined {
  const columns = ir.version === "v2" ? ir.columns : undefined;
  if (!columns || columns.length === 0) return undefined;
  const intake = columns.find((c) => resolveColumnFlags(c).intake === true);
  return intake ?? columns[0];
}

function validateRequiredTopLevelReachability(
  nodes: WorkflowIrNode[],
  outgoing: Map<string, WorkflowIrEdge[]>,
): void {
  /*
  FNXC:WorkflowValidation 2026-06-27-07:40:
  FN-7113 requires required top-level workflow nodes to be reachable from start at parse time, including interpreter-deferred branch graphs. Engine-owned recovery entry primitives stay exempt because they can be re-entered by persisted runtime state rather than by the author-facing start path.
  */
  const startNode = nodes.find((node) => node.kind === "start");
  if (!startNode) return;
  const reachable = reachableFrom(startNode.id, outgoing);
  for (const node of nodes) {
    if (reachable.has(node.id) || INTERPRETER_ENTRY_NODE_KINDS.has(node.kind)) continue;
    throw new WorkflowIrError(`Workflow node '${node.id}' is not reachable from the start node`);
  }
}

/**
 * Validate a foreach `template` subgraph recursively (KTD-3):
 *  - non-empty;
 *  - exactly one entry (no incoming template edges) and one exit (no outgoing);
 *  - NO nested foreach;
 *  - `step-execute` seam nodes are legal here but never inside a split branch
 *    (SEAM_FORBIDDEN_IN_BRANCH already enforces this via validateParallelism);
 *  - rework edges legal only when both endpoints are inside this template;
 *  - step-review verdict routing rules (KTD-4).
 */
function validateForeach(
  node: WorkflowIrNode,
  topLevelNodeIds: Set<string>,
  columnIds: Set<string>,
): void {
  const cfg = node.config as Partial<WorkflowForeachConfig> | undefined;
  if (!cfg || cfg.source !== "task-steps") {
    throw new WorkflowIrError(
      `foreach node '${node.id}' must declare source 'task-steps'`,
    );
  }
  const template = cfg.template;
  if (
    !template ||
    !Array.isArray(template.nodes) ||
    !Array.isArray(template.edges)
  ) {
    throw new WorkflowIrError(
      `foreach node '${node.id}' must declare a template with nodes and edges arrays`,
    );
  }
  if (template.nodes.length === 0) {
    throw new WorkflowIrError(`foreach node '${node.id}' template must be non-empty`);
  }

  // mode / isolation / concurrency (KTD-3).
  const mode = cfg.mode ?? "sequential";
  if (mode !== "sequential" && mode !== "parallel") {
    throw new WorkflowIrError(
      `foreach node '${node.id}' mode must be 'sequential' or 'parallel'`,
    );
  }
  const isolation = cfg.isolation ?? (mode === "parallel" ? "worktree" : "shared");
  if (isolation !== "shared" && isolation !== "worktree") {
    throw new WorkflowIrError(
      `foreach node '${node.id}' isolation must be 'shared' or 'worktree'`,
    );
  }
  if (mode === "parallel" && isolation === "shared") {
    throw new WorkflowIrError(
      `foreach node '${node.id}' cannot combine mode 'parallel' with isolation 'shared' (concurrent writes in one worktree are unguardable races)`,
    );
  }
  if (cfg.concurrency !== undefined) {
    if (mode !== "parallel") {
      throw new WorkflowIrError(
        `foreach node '${node.id}' concurrency is only valid in 'parallel' mode`,
      );
    }
    const c = cfg.concurrency;
    if (typeof c !== "number" || !Number.isInteger(c) || c < 1 || c > MAX_FOREACH_CONCURRENCY) {
      throw new WorkflowIrError(
        `foreach node '${node.id}' concurrency must be an integer in 1..${MAX_FOREACH_CONCURRENCY}`,
      );
    }
  }
  if (cfg.maxReworkCycles !== undefined) {
    const m = cfg.maxReworkCycles;
    if (typeof m !== "number" || !Number.isInteger(m) || m < 1) {
      throw new WorkflowIrError(
        `foreach node '${node.id}' maxReworkCycles must be an integer >= 1`,
      );
    }
    // >10 is clamped at parse time (clampForeachConfig); validation only rejects <1.
  }

  const templateNodes = template.nodes;
  const templateIds = new Set(templateNodes.map((n) => n.id));
  if (templateIds.size !== templateNodes.length) {
    throw new WorkflowIrError(
      `foreach node '${node.id}' template has duplicate node ids`,
    );
  }

  // No nested template groups. Also: a template node's declared `column` must resolve to a
  // top-level column id (column-agent plan KTD-1) — otherwise a dangling reference
  // is a silent no-binding no-op at runtime instead of a typed authoring error.
  for (const inner of templateNodes) {
    if (inner.kind === "foreach" || inner.kind === "loop") {
      throw new WorkflowIrError(
        `foreach node '${node.id}' template may not contain nested loop/foreach ('${inner.id}')`,
      );
    }
    if (inner.column !== undefined && !columnIds.has(inner.column)) {
      throw new WorkflowIrError(
        `Workflow node '${inner.id}' references undefined column '${inner.column}'`,
      );
    }
  }

  // Edge endpoints must reference template nodes; rework edges must stay intra-template.
  for (const edge of template.edges) {
    const fromInside = templateIds.has(edge.from);
    const toInside = templateIds.has(edge.to);
    if (!fromInside || !toInside) {
      if (isReworkEdge(edge)) {
        throw new WorkflowIrError(
          `rework edge '${edge.from}' -> '${edge.to}' in foreach '${node.id}' must have both endpoints inside the same template`,
        );
      }
      throw new WorkflowIrError(
        `foreach node '${node.id}' template edge '${edge.from}' -> '${edge.to}' references a node outside the template`,
      );
    }
  }

  // Single entry / single exit (ignoring rework back-edges, which intentionally
  // create incoming edges to earlier template nodes).
  const incoming = new Map<string, number>();
  const outgoingCount = new Map<string, number>();
  for (const edge of template.edges) {
    if (isReworkEdge(edge)) continue;
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
    outgoingCount.set(edge.from, (outgoingCount.get(edge.from) ?? 0) + 1);
  }
  const entries = templateNodes.filter((n) => (incoming.get(n.id) ?? 0) === 0);
  const exits = templateNodes.filter((n) => (outgoingCount.get(n.id) ?? 0) === 0);
  if (entries.length !== 1) {
    throw new WorkflowIrError(
      `foreach node '${node.id}' template must have exactly one entry node (found ${entries.length})`,
    );
  }
  if (exits.length !== 1) {
    throw new WorkflowIrError(
      `foreach node '${node.id}' template must have exactly one exit node (found ${exits.length})`,
    );
  }

  // Recurse: validate the template as its own region for parallelism + verdict
  // routing. step-execute nodes legal here (they are not validated as forbidden
  // at top level — that check lives in validateStepExecutePlacement).
  const templateById = new Map(templateNodes.map((n) => [n.id, n]));
  const templateOutgoing = buildOutgoing(template.edges);
  validateParallelism(templateNodes, templateOutgoing, templateById);
  validateStepReviewRouting(templateNodes, templateOutgoing, templateById, true);

  // Defensive: top-level node ids and template node ids should not collide
  // (instance identity is `<foreachId>#<i>:<templateNodeId>`, but a raw collision
  // is still confusing).
  for (const id of templateIds) {
    if (topLevelNodeIds.has(id)) {
      throw new WorkflowIrError(
        `foreach node '${node.id}' template node id '${id}' collides with a top-level node id`,
      );
    }
  }
}

function validateLoop(
  node: WorkflowIrNode,
  topLevelNodeIds: Set<string>,
  columnIds: Set<string>,
): void {
  const cfg = node.config as Partial<WorkflowLoopConfig> | undefined;
  const template = cfg?.template;
  if (
    !cfg ||
    !template ||
    !Array.isArray(template.nodes) ||
    !Array.isArray(template.edges)
  ) {
    throw new WorkflowIrError(
      `loop node '${node.id}' must declare a template with nodes and edges arrays`,
    );
  }
  if (template.nodes.length === 0) {
    throw new WorkflowIrError(`loop node '${node.id}' template must be non-empty`);
  }
  if (cfg.maxIterations !== undefined) {
    const m = cfg.maxIterations;
    if (typeof m !== "number" || !Number.isInteger(m) || m < 1) {
      throw new WorkflowIrError(`loop node '${node.id}' maxIterations must be an integer >= 1`);
    }
  }
  if (cfg.timeoutMs !== undefined) {
    const t = cfg.timeoutMs;
    if (typeof t !== "number" || !Number.isInteger(t) || t < 1 || t > MAX_LOOP_TIMEOUT_MS) {
      throw new WorkflowIrError(
        `loop node '${node.id}' timeoutMs must be an integer in 1..${MAX_LOOP_TIMEOUT_MS}`,
      );
    }
  }

  const exitWhen = cfg.exitWhen as WorkflowLoopConfig["exitWhen"] | undefined;
  if (!exitWhen || typeof exitWhen !== "object") {
    throw new WorkflowIrError(`loop node '${node.id}' must declare exitWhen`);
  }
  if (exitWhen.type === "output-contains") {
    if (typeof exitWhen.value !== "string" || exitWhen.value.length === 0) {
      throw new WorkflowIrError(`loop node '${node.id}' exitWhen.value must be a non-empty string`);
    }
  } else if (exitWhen.type === "output-matches") {
    if (typeof exitWhen.pattern !== "string" || exitWhen.pattern.length === 0) {
      throw new WorkflowIrError(`loop node '${node.id}' exitWhen.pattern must be a non-empty string`);
    }
    if (exitWhen.flags !== undefined && typeof exitWhen.flags !== "string") {
      throw new WorkflowIrError(`loop node '${node.id}' exitWhen.flags must be a string when present`);
    }
    try {
      new RegExp(exitWhen.pattern, exitWhen.flags);
    } catch (err) {
      throw new WorkflowIrError(
        `loop node '${node.id}' exitWhen.pattern is invalid: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    assertSafeLoopRegexPattern(node.id, exitWhen.pattern);
  } else {
    throw new WorkflowIrError(`loop node '${node.id}' exitWhen.type must be output-contains or output-matches`);
  }

  const templateNodes = template.nodes;
  const templateIds = new Set(templateNodes.map((n) => n.id));
  if (templateIds.size !== templateNodes.length) {
    throw new WorkflowIrError(`loop node '${node.id}' template has duplicate node ids`);
  }
  if (exitWhen.nodeId !== undefined && !templateIds.has(exitWhen.nodeId)) {
    throw new WorkflowIrError(
      `loop node '${node.id}' exitWhen.nodeId '${exitWhen.nodeId}' is not in the template`,
    );
  }
  for (const inner of templateNodes) {
    if (inner.kind === "loop" || inner.kind === "foreach") {
      throw new WorkflowIrError(
        `loop node '${node.id}' template may not contain nested loop/foreach ('${inner.id}')`,
      );
    }
    if (isStepExecuteNode(inner)) {
      throw new WorkflowIrError(
        `step-execute seam node '${inner.id}' is only legal inside a foreach template`,
      );
    }
    if (inner.column !== undefined && !columnIds.has(inner.column)) {
      throw new WorkflowIrError(
        `Workflow node '${inner.id}' references undefined column '${inner.column}'`,
      );
    }
  }
  for (const edge of template.edges) {
    const fromInside = templateIds.has(edge.from);
    const toInside = templateIds.has(edge.to);
    if (!fromInside || !toInside) {
      throw new WorkflowIrError(
        `loop node '${node.id}' template edge '${edge.from}' -> '${edge.to}' references a node outside the template`,
      );
    }
    if (isReworkEdge(edge)) {
      throw new WorkflowIrError(`loop node '${node.id}' template may not contain rework edges`);
    }
  }

  const incoming = new Map<string, number>();
  const outgoingCount = new Map<string, number>();
  for (const edge of template.edges) {
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
    outgoingCount.set(edge.from, (outgoingCount.get(edge.from) ?? 0) + 1);
  }
  const entries = templateNodes.filter((n) => (incoming.get(n.id) ?? 0) === 0);
  const exits = templateNodes.filter((n) => (outgoingCount.get(n.id) ?? 0) === 0);
  if (entries.length !== 1) {
    throw new WorkflowIrError(
      `loop node '${node.id}' template must have exactly one entry node (found ${entries.length})`,
    );
  }
  if (exits.length !== 1) {
    throw new WorkflowIrError(
      `loop node '${node.id}' template must have exactly one exit node (found ${exits.length})`,
    );
  }

  const templateById = new Map(templateNodes.map((n) => [n.id, n]));
  const templateOutgoing = buildOutgoing(template.edges);
  validateNoIllegalCycles(templateNodes, templateOutgoing);
  validateParallelism(templateNodes, templateOutgoing, templateById);
  validateStepReviewRouting(templateNodes, templateOutgoing, templateById, false);

  for (const id of templateIds) {
    if (topLevelNodeIds.has(id)) {
      throw new WorkflowIrError(
        `loop node '${node.id}' template node id '${id}' collides with a top-level node id`,
      );
    }
  }
}

/*
FNXC:WorkflowOptionalGroup 2026-06-21-11:00:
Validate an `optional-group` container template, mirroring `validateLoop` minus the loop's exit/iteration config.
The template runs once when enabled, so rework edges (and any cycles) are forbidden inside, single entry/exit is required, and nested foreach/loop groups are rejected — keeping the single-pass guarantee unambiguous.
`defaultOn` must be boolean when present; `name` must be a string when present.
*/
function validateOptionalGroup(
  node: WorkflowIrNode,
  topLevelNodeIds: Set<string>,
  columnIds: Set<string>,
): void {
  const cfg = node.config as Partial<WorkflowOptionalGroupConfig> | undefined;
  const template = cfg?.template;
  if (
    !cfg ||
    !template ||
    !Array.isArray(template.nodes) ||
    !Array.isArray(template.edges)
  ) {
    throw new WorkflowIrError(
      `optional-group node '${node.id}' must declare a template with nodes and edges arrays`,
    );
  }
  if (template.nodes.length === 0) {
    throw new WorkflowIrError(`optional-group node '${node.id}' template must be non-empty`);
  }
  if (cfg.defaultOn !== undefined && typeof cfg.defaultOn !== "boolean") {
    throw new WorkflowIrError(`optional-group node '${node.id}' defaultOn must be a boolean`);
  }
  if (cfg.name !== undefined && typeof cfg.name !== "string") {
    throw new WorkflowIrError(`optional-group node '${node.id}' name must be a string`);
  }
  // FNXC:WorkflowPostMerge 2026-06-26-09:00: `phase` is optional and defaults to
  // "pre-merge"; only "pre-merge" | "post-merge" are valid when present.
  if (cfg.phase !== undefined && cfg.phase !== "pre-merge" && cfg.phase !== "post-merge") {
    throw new WorkflowIrError(`optional-group node '${node.id}' phase must be 'pre-merge' or 'post-merge'`);
  }
  /*
   * FNXC:WorkflowOptionalStepRevisionBudget 2026-06-27-12:22:
   * Parse-time validation accepts only an explicit non-negative integer budget or `"unbounded"`; absent remains byte-inert and resolves through the gate-specific runtime fallback at execution time.
   *
   * FNXC:WorkflowRevisionBudget 2026-06-30-20:36:
   * The Plan Review/Code Review workflow setting values are validated separately from IR authoring. Invalid runtime values are ignored by the shared budget resolver, while invalid authored node budgets remain a parse error so custom workflow definitions cannot persist ambiguous caps.
   */
  if (cfg.maxRevisions !== undefined) {
    const maxRevisions = cfg.maxRevisions;
    if (
      maxRevisions !== "unbounded" &&
      (typeof maxRevisions !== "number" || !Number.isInteger(maxRevisions) || maxRevisions < 0)
    ) {
      throw new WorkflowIrError(
        `optional-group node '${node.id}' maxRevisions must be a non-negative integer or "unbounded"`,
      );
    }
  }

  const templateNodes = template.nodes;
  const templateIds = new Set(templateNodes.map((n) => n.id));
  if (templateIds.size !== templateNodes.length) {
    throw new WorkflowIrError(`optional-group node '${node.id}' template has duplicate node ids`);
  }
  for (const inner of templateNodes) {
    if (inner.kind === "loop" || inner.kind === "foreach" || inner.kind === "optional-group") {
      throw new WorkflowIrError(
        `optional-group node '${node.id}' template may not contain nested loop/foreach/optional-group ('${inner.id}')`,
      );
    }
    if (isStepExecuteNode(inner)) {
      throw new WorkflowIrError(
        `step-execute seam node '${inner.id}' is only legal inside a foreach template`,
      );
    }
    if (inner.column !== undefined && !columnIds.has(inner.column)) {
      throw new WorkflowIrError(
        `Workflow node '${inner.id}' references undefined column '${inner.column}'`,
      );
    }
  }
  for (const edge of template.edges) {
    const fromInside = templateIds.has(edge.from);
    const toInside = templateIds.has(edge.to);
    if (!fromInside || !toInside) {
      throw new WorkflowIrError(
        `optional-group node '${node.id}' template edge '${edge.from}' -> '${edge.to}' references a node outside the template`,
      );
    }
    if (isReworkEdge(edge)) {
      throw new WorkflowIrError(`optional-group node '${node.id}' template may not contain rework edges`);
    }
    // FNXC:WorkflowOptionalGroup 2026-06-22-09:00: the single-pass walk
    // (runOptionalGroup) surfaces a template-node failure as the GROUP's outcome
    // and bails before evaluating that node's edges — so a `failure`-condition
    // edge inside the template would silently never execute. Reject it as a typed
    // authoring error; failure routing belongs on the group's OUTER edges.
    // (Code review: Greptile P2.)
    if (edge.condition === "failure") {
      throw new WorkflowIrError(
        `optional-group node '${node.id}' template may not contain failure-condition edges — ` +
          `a template-node failure surfaces as the group's outcome and routes the group's outer failure edge`,
      );
    }
  }

  const incoming = new Map<string, number>();
  const outgoingCount = new Map<string, number>();
  for (const edge of template.edges) {
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
    outgoingCount.set(edge.from, (outgoingCount.get(edge.from) ?? 0) + 1);
  }
  const entries = templateNodes.filter((n) => (incoming.get(n.id) ?? 0) === 0);
  const exits = templateNodes.filter((n) => (outgoingCount.get(n.id) ?? 0) === 0);
  if (entries.length !== 1) {
    throw new WorkflowIrError(
      `optional-group node '${node.id}' template must have exactly one entry node (found ${entries.length})`,
    );
  }
  if (exits.length !== 1) {
    throw new WorkflowIrError(
      `optional-group node '${node.id}' template must have exactly one exit node (found ${exits.length})`,
    );
  }

  const templateById = new Map(templateNodes.map((n) => [n.id, n]));
  const templateOutgoing = buildOutgoing(template.edges);
  validateNoIllegalCycles(templateNodes, templateOutgoing);
  validateParallelism(templateNodes, templateOutgoing, templateById);
  validateStepReviewRouting(templateNodes, templateOutgoing, templateById, false);

  for (const id of templateIds) {
    if (topLevelNodeIds.has(id)) {
      throw new WorkflowIrError(
        `optional-group node '${node.id}' template node id '${id}' collides with a top-level node id`,
      );
    }
  }
}

/** step-execute seam nodes are legal ONLY inside a foreach template (KTD-4):
 *  reject any at the top level. (Inside-split-branch rejection is handled by
 *  SEAM_FORBIDDEN_IN_BRANCH within validateParallelism.) */
function validateStepExecutePlacement(topLevelNodes: WorkflowIrNode[]): void {
  for (const node of topLevelNodes) {
    if (isStepExecuteNode(node)) {
      throw new WorkflowIrError(
        `step-execute seam node '${node.id}' is only legal inside a foreach template`,
      );
    }
  }
}

/**
 * step-review verdict routing (KTD-4). For each step-review node:
 *  - it must have outgoing edges covering `outcome:approve` and `outcome:revise`;
 *  - `outcome:rethink` optional (defaults to the revise target with reset semantics);
 *  - `outcome:unavailable` optional;
 *  - a step-review node inside a split branch is advisory-only: it must NOT carry
 *    rework or `outcome:approve` routing.
 */
function validateStepReviewRouting(
  nodes: WorkflowIrNode[],
  outgoing: Map<string, WorkflowIrEdge[]>,
  nodesById: Map<string, WorkflowIrNode>,
  insideForeachTemplate: boolean,
): void {
  // Determine which nodes sit inside a split branch (advisory-only zone).
  const inBranch = nodesInSplitBranches(nodes, outgoing, nodesById);

  for (const node of nodes) {
    if (node.kind !== "step-review") continue;
    if (node.config?.type !== "plan" && node.config?.type !== "code") {
      throw new WorkflowIrError(
        `step-review node '${node.id}' must declare type 'plan' or 'code'`,
      );
    }
    if (node.config.model !== undefined && typeof node.config.model !== "string") {
      throw new WorkflowIrError(
        `step-review node '${node.id}' model must be a string when present`,
      );
    }

    const edges = outgoing.get(node.id) ?? [];
    const conditions = new Set(edges.map((e) => e.condition));
    const hasRework = edges.some(isReworkEdge);

    if (inBranch.has(node.id)) {
      // Advisory-only inside a split branch: no rework, no approve routing.
      if (hasRework) {
        throw new WorkflowIrError(
          `step-review node '${node.id}' inside a split branch is advisory-only and may not have rework edges`,
        );
      }
      if (conditions.has("outcome:approve")) {
        throw new WorkflowIrError(
          `step-review node '${node.id}' inside a split branch is advisory-only and may not carry outcome:approve routing`,
        );
      }
      continue;
    }

    // Main-path step-review: must route approve and revise.
    if (!conditions.has("outcome:approve")) {
      throw new WorkflowIrError(
        `step-review node '${node.id}' must route outcome:approve`,
      );
    }
    if (!conditions.has("outcome:revise")) {
      throw new WorkflowIrError(
        `step-review node '${node.id}' must route outcome:revise`,
      );
    }
    void insideForeachTemplate;
  }
}

function validateThinkingLevelConfig(nodes: WorkflowIrNode[]): void {
  for (const node of nodes) {
    const value = node.config?.thinkingLevel;
    /*
     * FNXC:Settings-ThinkingLevel 2026-07-10-00:00:
     * Per-node thinking overrides are workflow model-binding config, so IR validation rejects unknown reasoning levels before editor-authored or imported graphs reach execution.
     */
    if (value !== undefined && (typeof value !== "string" || !THINKING_LEVEL_SET.has(value))) {
      throw new WorkflowIrError(
        `Workflow node '${node.id}' thinkingLevel must be one of ${THINKING_LEVELS.join(", ")} when present`,
      );
    }
    const templateNodes = (node.config as { template?: { nodes?: unknown } } | undefined)?.template?.nodes;
    if (Array.isArray(templateNodes)) validateThinkingLevelConfig(templateNodes as WorkflowIrNode[]);
  }
}

/** Compute the set of node ids that lie strictly inside some split..join branch
 *  region. Walks each split's branches forward to the join. Lightweight; used
 *  for the step-review advisory-only rule. */
function nodesInSplitBranches(
  nodes: WorkflowIrNode[],
  outgoing: Map<string, WorkflowIrEdge[]>,
  nodesById: Map<string, WorkflowIrNode>,
): Set<string> {
  const inBranch = new Set<string>();
  const splits = nodes.filter((n) => n.kind === "split");
  for (const split of splits) {
    for (const edge of outgoing.get(split.id) ?? []) {
      let cursor: string | undefined = edge.to;
      const visited = new Set<string>();
      while (cursor && !visited.has(cursor)) {
        const id: string = cursor;
        visited.add(id);
        const n = nodesById.get(id);
        if (!n || n.kind === "join") break;
        inBranch.add(id);
        const next: WorkflowIrEdge | undefined = (outgoing.get(id) ?? []).find(
          (e) => !isReworkEdge(e) && e.condition !== "failure",
        );
        cursor = next?.to;
      }
    }
  }
  return inBranch;
}

/**
 * Cycle detection across the top-level graph that EXEMPTS rework edges (KTD-5).
 * Any non-rework cycle is rejected; rework edges (intra-template back-edges) are
 * skipped. Run over the top-level graph; template internals are validated
 * separately.
 */
function validateNoIllegalCycles(
  nodes: WorkflowIrNode[],
  outgoing: Map<string, WorkflowIrEdge[]>,
): void {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const n of nodes) color.set(n.id, WHITE);

  const visit = (id: string): void => {
    color.set(id, GRAY);
    for (const edge of outgoing.get(id) ?? []) {
      if (isReworkEdge(edge)) continue;
      const c = color.get(edge.to);
      if (c === GRAY) {
        throw new WorkflowIrError(
          `Workflow IR has an illegal cycle (edge '${edge.from}' -> '${edge.to}'); only rework edges may form cycles`,
        );
      }
      if (c === WHITE) visit(edge.to);
    }
    color.set(id, BLACK);
  };

  for (const n of nodes) {
    if (color.get(n.id) === WHITE) visit(n.id);
  }
}

/**
 * Dominance check (KTD-3): every `foreach(source:"task-steps")` must be dominated
 * by a `parse-steps` node — a parse-steps node lies on EVERY path from start to
 * the foreach. Implemented via the classic "removal disconnects start from
 * target" definition, which is correct for DAGs: for each parse-steps node,
 * check whether the foreach is still reachable from start with that node removed.
 * The foreach is dominated iff some parse-steps node's removal disconnects it.
 */
function validateForeachDominance(
  nodes: WorkflowIrNode[],
  edges: WorkflowIrEdge[],
  outgoing: Map<string, WorkflowIrEdge[]>,
): void {
  const startNode = nodes.find((n) => n.kind === "start");
  if (!startNode) return; // parse-time guarantees exactly one start.
  const foreaches = nodes.filter(
    (n) => n.kind === "foreach" && (n.config as { source?: unknown } | undefined)?.source === "task-steps",
  );
  if (foreaches.length === 0) return;
  const parseStepsNodes = nodes.filter((n) => n.kind === "parse-steps");

  for (const fe of foreaches) {
    // Reachable from start at all?
    if (!reachableFrom(startNode.id, outgoing).has(fe.id)) {
      throw new WorkflowIrError(
        `foreach node '${fe.id}' is not reachable from the start node`,
      );
    }
    const dominated = parseStepsNodes.some((ps) => {
      if (ps.id === fe.id) return false;
      // Build outgoing with ps removed (as both source and target).
      const trimmed = buildOutgoing(
        edges.filter((e) => e.from !== ps.id && e.to !== ps.id),
      );
      return !reachableFrom(startNode.id, trimmed).has(fe.id);
    });
    if (!dominated) {
      throw new WorkflowIrError(
        `foreach node '${fe.id}' (source:'task-steps') must be dominated by a parse-steps node on every path from start`,
      );
    }
  }
}

/** Validate `parse-steps` node config (KTD-12). */
function validateParseStepsNodes(ir: WorkflowIrV2): void {
  const declaredArtifacts = new Set((ir.artifacts ?? []).map((a) => a.key));
  const hasDeclaredArtifacts = (ir.artifacts ?? []).length > 0;

  for (const node of ir.nodes) {
    if (node.kind !== "parse-steps") continue;
    const cfg = node.config as { artifact?: unknown; parser?: unknown } | undefined;
    const artifact = cfg?.artifact;
    const parser = cfg?.parser;
    if (typeof parser !== "string" || parser.trim() === "") {
      throw new WorkflowIrError(
        `parse-steps node '${node.id}' must declare a non-empty parser`,
      );
    }
    if (typeof artifact !== "string" || artifact.trim() === "") {
      throw new WorkflowIrError(
        `parse-steps node '${node.id}' must declare a non-empty artifact`,
      );
    }
    if (hasDeclaredArtifacts) {
      if (!declaredArtifacts.has(artifact)) {
        throw new WorkflowIrError(
          `parse-steps node '${node.id}' references undeclared artifact '${artifact}'`,
        );
      }
    } else if (artifact !== IMPLICIT_DEFAULT_ARTIFACT) {
      throw new WorkflowIrError(
        `parse-steps node '${node.id}' references artifact '${artifact}', but only '${IMPLICIT_DEFAULT_ARTIFACT}' is allowed when no artifacts are declared`,
      );
    }
  }
}

/** Validate `code` node config (KTD-15). TS is NOT compiled in core (esbuild
 *  check is engine/editor side). */
function validateCodeNodes(nodes: WorkflowIrNode[]): void {
  const MAX_SOURCE = 65536;
  for (const node of nodes) {
    if (node.kind !== "code") continue;
    const cfg = node.config as { source?: unknown; timeoutMs?: unknown } | undefined;
    const source = cfg?.source;
    if (typeof source !== "string" || source.length === 0) {
      throw new WorkflowIrError(`code node '${node.id}' must declare a non-empty source`);
    }
    if (source.length > MAX_SOURCE) {
      throw new WorkflowIrError(
        `code node '${node.id}' source exceeds ${MAX_SOURCE} characters`,
      );
    }
    if (cfg?.timeoutMs !== undefined) {
      const t = cfg.timeoutMs;
      if (typeof t !== "number" || !Number.isInteger(t) || t < 1000 || t > 300000) {
        throw new WorkflowIrError(
          `code node '${node.id}' timeoutMs must be an integer in 1000..300000`,
        );
      }
    }
  }
}

/** Validate workflow-authored notification node config. */
function validateNotifyNodes(nodes: WorkflowIrNode[]): void {
  for (const node of nodes) {
    if (node.kind !== "notify") continue;
    const cfg = node.config as { event?: unknown; message?: unknown; title?: unknown } | undefined;
    const event = cfg?.event;
    if (typeof event !== "string" || event.trim() === "") {
      throw new WorkflowIrError(`notify node '${node.id}' must declare a non-empty event`);
    }
    if (cfg?.message !== undefined && typeof cfg.message !== "string") {
      throw new WorkflowIrError(`notify node '${node.id}' message must be a string`);
    }
    if (cfg?.title !== undefined && typeof cfg.title !== "string") {
      throw new WorkflowIrError(`notify node '${node.id}' title must be a string`);
    }
  }
}

/*
FNXC:WorkflowAskUserExitGate 2026-07-05-00:00:
FN-7579 adds two brainstorming/chat reach-out node kinds. `ask-user` reuses the
existing await-input park/resume plumbing (runAwaitInputNode) rather than a new
runner: it must carry a non-empty `config.question` (falling back to
`config.prompt`) OR omit both, in which case the engine's existing default
question string is used — validation only rejects a present-but-empty/non-string
value so authors cannot ship a blank prompt. `exit-gate` terminates the walk
early toward the terminal `end` node: it must have at least one outgoing edge
that (transitively, ignoring rework edges) reaches `end`, so an exit-gate can
never strand the graph. It is NOT itself an `end` node (the one-start/one-end
invariant is unaffected) — it only routes to one.
*/
function validateAskUserAndExitGateNodes(
  nodes: WorkflowIrNode[],
  outgoing: Map<string, WorkflowIrEdge[]>,
): void {
  const endNode = nodes.find((n) => n.kind === "end");

  for (const node of nodes) {
    if (node.kind === "ask-user") {
      const cfg = node.config as { question?: unknown; prompt?: unknown } | undefined;
      if (cfg?.question !== undefined && (typeof cfg.question !== "string" || cfg.question.trim() === "")) {
        throw new WorkflowIrError(
          `ask-user node '${node.id}' question must be a non-empty string when present`,
        );
      }
      if (cfg?.prompt !== undefined && (typeof cfg.prompt !== "string" || cfg.prompt.trim() === "")) {
        throw new WorkflowIrError(
          `ask-user node '${node.id}' prompt must be a non-empty string when present`,
        );
      }
    }

    if (node.kind === "exit-gate") {
      if (!endNode) continue; // exactly-one-end invariant already failed elsewhere.
      const reachable = reachableFrom(node.id, outgoing);
      if (!reachable.has(endNode.id)) {
        throw new WorkflowIrError(
          `exit-gate node '${node.id}' must have a path to the terminal 'end' node`,
        );
      }
    }
  }
}

/** Validate `fields` declarations (KTD-13). */
function validateFields(fields: WorkflowFieldDefinition[] | undefined): void {
  if (fields === undefined) return;
  if (!Array.isArray(fields)) {
    throw new WorkflowIrError("Workflow IR fields must be an array");
  }
  const seen = new Set<string>();
  for (const field of fields) {
    if (!field || typeof field.id !== "string" || field.id === "") {
      throw new WorkflowIrError("Workflow field must have a non-empty id");
    }
    if (seen.has(field.id)) {
      throw new WorkflowIrError(`Workflow IR has duplicate field id '${field.id}'`);
    }
    seen.add(field.id);
    if (typeof field.name !== "string" || field.name === "") {
      throw new WorkflowIrError(`Workflow field '${field.id}' must have a non-empty name`);
    }
    if (!WORKFLOW_FIELD_TYPES.has(field.type)) {
      throw new WorkflowIrError(
        `Workflow field '${field.id}' has unknown type '${String(field.type)}'`,
      );
    }
    const isEnum = field.type === "enum" || field.type === "multi-enum";
    if (isEnum) {
      if (!Array.isArray(field.options) || field.options.length === 0) {
        throw new WorkflowIrError(
          `Workflow field '${field.id}' of type '${field.type}' must declare non-empty options`,
        );
      }
      const optSeen = new Set<string>();
      for (const opt of field.options) {
        if (!opt || typeof opt.value !== "string" || opt.value === "") {
          throw new WorkflowIrError(
            `Workflow field '${field.id}' option must have a non-empty value`,
          );
        }
        if (typeof opt.label !== "string" || opt.label === "") {
          throw new WorkflowIrError(
            `Workflow field '${field.id}' option '${opt.value}' must have a non-empty label`,
          );
        }
        if (optSeen.has(opt.value)) {
          throw new WorkflowIrError(
            `Workflow field '${field.id}' has duplicate option value '${opt.value}'`,
          );
        }
        optSeen.add(opt.value);
      }
    } else if (field.options !== undefined) {
      throw new WorkflowIrError(
        `Workflow field '${field.id}' of type '${field.type}' must not declare options`,
      );
    }
    if (field.render !== undefined) {
      const r = field.render;
      if (r.placement !== undefined && !FIELD_RENDER_PLACEMENTS.has(r.placement)) {
        throw new WorkflowIrError(
          `Workflow field '${field.id}' render.placement '${String(r.placement)}' is not allowed`,
        );
      }
      if (r.widget !== undefined && !FIELD_RENDER_WIDGETS.has(r.widget)) {
        throw new WorkflowIrError(
          `Workflow field '${field.id}' render.widget '${String(r.widget)}' is not allowed`,
        );
      }
    }
  }
}

/** Validate number-only setting constraints before values/defaults consume them. */
function validateSettingNumericConstraints(setting: WorkflowSettingDefinition): void {
  if (setting.minimum !== undefined) {
    if (setting.type !== "number") {
      throw new WorkflowIrError(`Workflow setting '${setting.id}' minimum is only allowed for number settings`);
    }
    if (typeof setting.minimum !== "number" || !Number.isFinite(setting.minimum)) {
      throw new WorkflowIrError(`Workflow setting '${setting.id}' minimum must be a finite number`);
    }
  }
  if (setting.integer !== undefined) {
    if (setting.type !== "number") {
      throw new WorkflowIrError(`Workflow setting '${setting.id}' integer is only allowed for number settings`);
    }
    if (typeof setting.integer !== "boolean") {
      throw new WorkflowIrError(`Workflow setting '${setting.id}' integer must be a boolean`);
    }
  }
}

/** Validate that a setting's `default` conforms to its own type/options (U1).
 *  Unlike `validateFields`, settings validate defaults because the engine's
 *  effective-settings resolver (U3) consumes the default directly — a malformed
 *  default would feed garbage into execution. */
function validateSettingDefault(setting: WorkflowSettingDefinition): void {
  const value = setting.default;
  if (value === undefined) return;
  const id = setting.id;
  switch (setting.type) {
    case "string":
    case "text":
      if (typeof value !== "string") {
        throw new WorkflowIrError(
          `Workflow setting '${id}' default must be a string for type '${setting.type}'`,
        );
      }
      break;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new WorkflowIrError(
          `Workflow setting '${id}' default must be a finite number`,
        );
      }
      if (setting.integer === true && !Number.isInteger(value)) {
        throw new WorkflowIrError(`Workflow setting '${id}' default must be an integer`);
      }
      if (setting.minimum !== undefined && value < setting.minimum) {
        throw new WorkflowIrError(`Workflow setting '${id}' default must be at least ${setting.minimum}`);
      }
      break;
    case "boolean":
      if (typeof value !== "boolean") {
        throw new WorkflowIrError(`Workflow setting '${id}' default must be a boolean`);
      }
      break;
    case "enum": {
      const allowed = new Set((setting.options ?? []).map((o) => o.value));
      if (typeof value !== "string" || !allowed.has(value)) {
        throw new WorkflowIrError(
          `Workflow setting '${id}' default '${String(value)}' is not one of its enum options`,
        );
      }
      break;
    }
    case "multi-enum": {
      const allowed = new Set((setting.options ?? []).map((o) => o.value));
      if (!Array.isArray(value)) {
        throw new WorkflowIrError(
          `Workflow setting '${id}' default must be an array for type 'multi-enum'`,
        );
      }
      for (const entry of value) {
        if (typeof entry !== "string" || !allowed.has(entry)) {
          throw new WorkflowIrError(
            `Workflow setting '${id}' default '${String(entry)}' is not one of its enum options`,
          );
        }
      }
      break;
    }
  }
}

/** Validate `settings` declarations (U1, R1). Mirrors `validateFields`: non-empty
 *  unique ids, type whitelist, options iff enum-kind, unique option values, render
 *  widget whitelist — plus default validation (settings need it; see
 *  `validateSettingDefault`). */
function validateSettings(settings: WorkflowSettingDefinition[] | undefined): void {
  if (settings === undefined) return;
  if (!Array.isArray(settings)) {
    throw new WorkflowIrError("Workflow IR settings must be an array");
  }
  const seen = new Set<string>();
  for (const setting of settings) {
    if (!setting || typeof setting.id !== "string" || setting.id === "") {
      throw new WorkflowIrError("Workflow setting must have a non-empty id");
    }
    if (seen.has(setting.id)) {
      throw new WorkflowIrError(`Workflow IR has duplicate setting id '${setting.id}'`);
    }
    seen.add(setting.id);
    if (typeof setting.name !== "string" || setting.name === "") {
      throw new WorkflowIrError(
        `Workflow setting '${setting.id}' must have a non-empty name`,
      );
    }
    if (!WORKFLOW_SETTING_TYPES.has(setting.type)) {
      throw new WorkflowIrError(
        `Workflow setting '${setting.id}' has unknown type '${String(setting.type)}'`,
      );
    }
    const isEnum = setting.type === "enum" || setting.type === "multi-enum";
    if (isEnum) {
      if (!Array.isArray(setting.options) || setting.options.length === 0) {
        throw new WorkflowIrError(
          `Workflow setting '${setting.id}' of type '${setting.type}' must declare non-empty options`,
        );
      }
      const optSeen = new Set<string>();
      for (const opt of setting.options) {
        if (!opt || typeof opt.value !== "string" || opt.value === "") {
          throw new WorkflowIrError(
            `Workflow setting '${setting.id}' option must have a non-empty value`,
          );
        }
        if (typeof opt.label !== "string" || opt.label === "") {
          throw new WorkflowIrError(
            `Workflow setting '${setting.id}' option '${opt.value}' must have a non-empty label`,
          );
        }
        if (optSeen.has(opt.value)) {
          throw new WorkflowIrError(
            `Workflow setting '${setting.id}' has duplicate option value '${opt.value}'`,
          );
        }
        optSeen.add(opt.value);
      }
    } else if (setting.options !== undefined) {
      throw new WorkflowIrError(
        `Workflow setting '${setting.id}' of type '${setting.type}' must not declare options`,
      );
    }
    if (setting.description !== undefined && typeof setting.description !== "string") {
      throw new WorkflowIrError(
        `Workflow setting '${setting.id}' description must be a string`,
      );
    }
    if (setting.render !== undefined) {
      const r = setting.render;
      if (r.widget !== undefined && !SETTING_RENDER_WIDGETS.has(r.widget)) {
        throw new WorkflowIrError(
          `Workflow setting '${setting.id}' render.widget '${String(r.widget)}' is not allowed`,
        );
      }
    }
    validateSettingNumericConstraints(setting);
    validateSettingDefault(setting);
  }
}

function validateColumns(ir: WorkflowIrV2): void {
  if (!Array.isArray(ir.columns)) {
    throw new WorkflowIrError("Workflow IR v2 columns must be an array");
  }
  const seen = new Set<string>();
  for (const column of ir.columns) {
    if (!column || typeof column.id !== "string" || !column.id) {
      throw new WorkflowIrError("Workflow IR column must have a non-empty id");
    }
    if (seen.has(column.id)) {
      throw new WorkflowIrError(`Workflow IR has duplicate column id '${column.id}'`);
    }
    seen.add(column.id);
    if (!Array.isArray(column.traits)) {
      throw new WorkflowIrError(`Workflow IR column '${column.id}' traits must be an array`);
    }
    validateExtensionMetadata(`Workflow IR column '${column.id}'`, column.extensions);
    validateColumnAgent(column);
  }
}

function validateExtensionMetadata(owner: string, extensions: unknown): void {
  if (extensions === undefined) return;
  if (!extensions || typeof extensions !== "object" || Array.isArray(extensions)) {
    throw new WorkflowIrError(`${owner} extensions must be an object`);
  }
  for (const [key, value] of Object.entries(extensions as Record<string, unknown>)) {
    if (!WORKFLOW_EXTENSION_KEY_PATTERN.test(key)) {
      throw new WorkflowIrError(
        `${owner} extension key '${key}' must be plugin-namespaced as plugin:<pluginId>:<extensionId>`,
      );
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new WorkflowIrError(`${owner} extension '${key}' metadata must be an object`);
    }
    validateRegisteredExtensionMetadata(owner, key, value as Record<string, unknown>);
  }
}

function validateRegisteredExtensionMetadata(
  owner: string,
  key: string,
  value: Record<string, unknown>,
): void {
  const definition = getWorkflowExtensionRegistry().get(key);
  /*
  FNXC:WorkflowValidation 2026-06-27-00:00:
  FN-7113 requires plugin-referencing workflow graphs to validate against the same central gate as built-in/custom graphs. Reject unknown workflow extension keys by name so authoring surfaces cannot persist a graph whose plugin node/column contract is missing at save or launch time.
  */
  if (!definition) {
    throw new WorkflowIrError(`${owner} extension key '${key}' is not registered`);
  }
  const fields = definition.extension.configSchema?.fields;
  if (!fields || fields.length === 0) return;
  for (const field of fields) {
    if (field.required && !(field.key in value)) {
      throw new WorkflowIrError(`${owner} extension '${key}' missing required field '${field.key}'`);
    }
    if (field.key in value) {
      validateExtensionFieldValue(owner, key, field, value[field.key]);
    }
  }
}

function validateExtensionFieldValue(
  owner: string,
  key: string,
  field: WorkflowExtensionConfigField,
  value: unknown,
): void {
  if (value === undefined) return;
  const fail = (): never => {
    throw new WorkflowIrError(
      `${owner} extension '${key}' field '${field.key}' must be ${field.type}`,
    );
  };
  if (field.type === "array") {
    if (!Array.isArray(value)) fail();
    return;
  }
  if (field.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail();
    return;
  }
  if (field.type === "enum") {
    if (typeof value !== "string") {
      throw new WorkflowIrError(
        `${owner} extension '${key}' field '${field.key}' must be ${field.type}`,
      );
    }
    const enumValue: string = value;
    if (!field.enumValues || field.enumValues.length === 0) {
      throw new WorkflowIrError(
        `${owner} extension '${key}' field '${field.key}' is enum but has no enumValues defined`,
      );
    }
    if (!field.enumValues.includes(enumValue)) {
      throw new WorkflowIrError(
        `${owner} extension '${key}' field '${field.key}' must be one of: ${field.enumValues.join(", ")}`,
      );
    }
    return;
  }
  if (typeof value !== field.type) fail();
}

/** Validate a column's optional permanent-agent binding (column-agent plan KTD-1).
 *  Mirrors the `validateFields` early-return shape: absent → no-op; present →
 *  `agentId` must be a non-empty string and `mode` exactly `defer`/`override`.
 *  Agent existence is NOT checked here (no agent store at the IR layer). */
function validateColumnAgent(column: WorkflowIrColumn): void {
  const agent = column.agent;
  if (agent === undefined) return;
  if (!agent || typeof agent !== "object") {
    throw new WorkflowIrError(`Workflow IR column '${column.id}' agent must be an object`);
  }
  if (typeof agent.agentId !== "string" || agent.agentId === "") {
    throw new WorkflowIrError(
      `Workflow IR column '${column.id}' agent must have a non-empty agentId`,
    );
  }
  if (agent.mode !== "defer" && agent.mode !== "override") {
    throw new WorkflowIrError(
      `Workflow IR column '${column.id}' agent mode must be 'defer' or 'override' (got '${String(agent.mode)}')`,
    );
  }
}

function validateV2(ir: WorkflowIrV2): void {
  validateColumns(ir);

  // FNXC:WorkflowValidation 2026-07-21-12:20:
  // Capacity holds must have somewhere the scheduler can actually release
  // them. Failing authoring here avoids durable continuations that can never
  // become runnable.
  for (const [index, column] of ir.columns.entries()) {
    const hold = column.traits.find((trait) => trait.trait === "hold");
    if (hold?.config?.release !== "capacity") continue;
    const hasDownstreamCapacity = ir.columns
      .slice(index + 1)
      .some((candidate) => resolveColumnFlags(candidate).countsTowardWip === true);
    if (!hasDownstreamCapacity) {
      throw new WorkflowIrError(
        `Workflow IR capacity hold column '${column.id}' requires a downstream wip column`,
      );
    }
  }

  const columnIds = new Set(ir.columns.map((c) => c.id));
  const nodeIds = new Set<string>();
  for (const node of ir.nodes) {
    /*
    FNXC:WorkflowValidation 2026-06-27-00:00:
    FN-7113 requires top-level duplicate node ids to fail before persistence or launch. Keep this check before nodesById is built so Map de-duplication cannot silently mask a malformed author/plugin workflow graph.
    */
    if (nodeIds.has(node.id)) {
      throw new WorkflowIrError(`Workflow IR has duplicate node id '${node.id}'`);
    }
    nodeIds.add(node.id);
  }
  const nodesById = new Map(ir.nodes.map((n) => [n.id, n]));

  for (const node of ir.nodes) {
    validateExtensionMetadata(`Workflow node '${node.id}'`, node.extensions);
    if (node.column !== undefined && !columnIds.has(node.column)) {
      throw new WorkflowIrError(
        `Workflow node '${node.id}' references undefined column '${node.column}'`,
      );
    }
    if (node.kind === "hold") {
      const release = node.config?.release;
      if (!HOLD_RELEASE_KINDS.has(release as WorkflowHoldRelease)) {
        throw new WorkflowIrError(
          `hold node '${node.id}' has unknown release kind '${String(release)}'`,
        );
      }
    }
  }

  /*
  FNXC:WorkflowValidation 2026-06-17-13:17:
  Top-level workflow edges must reference declared top-level nodes. Fail closed on dangling endpoints so imported, AI-designed, and editor-authored IR cannot persist an edge to a non-existent node (FN-6583 / FN-6580 readiness gap).
  */
  for (const edge of ir.edges) {
    if (!nodesById.has(edge.from)) {
      throw new WorkflowIrError(
        `Workflow edge '${edge.from}' -> '${edge.to}' references undefined node '${edge.from}'`,
      );
    }
    if (!nodesById.has(edge.to)) {
      throw new WorkflowIrError(
        `Workflow edge '${edge.from}' -> '${edge.to}' references undefined node '${edge.to}'`,
      );
    }
  }

  const outgoing = buildOutgoing(ir.edges);
  validateParallelism(ir.nodes, outgoing, nodesById);

  // U2: a merge-blocker column requires a reachable merge-class node, or its gate
  // can never clear. Runs after edge validity + outgoing map are established.
  validateMergeBlockerReachability(ir, outgoing);

  // Step-inversion (U1) — additive validation. Order matters: validate node
  // configs first, then structural rules.
  const topLevelIds = new Set(ir.nodes.map((n) => n.id));
  validateStepExecutePlacement(ir.nodes);
  validateThinkingLevelConfig(ir.nodes);
  for (const node of ir.nodes) {
    if (node.kind === "foreach") validateForeach(node, topLevelIds, columnIds);
    if (node.kind === "loop") validateLoop(node, topLevelIds, columnIds);
    if (node.kind === "optional-group") validateOptionalGroup(node, topLevelIds, columnIds);
  }
  validateStepReviewRouting(ir.nodes, outgoing, nodesById, false);
  validateParseStepsNodes(ir);
  validateCodeNodes(ir.nodes);
  validateNotifyNodes(ir.nodes);
  validateAskUserAndExitGateNodes(ir.nodes, outgoing);
  validateFields(ir.fields);
  validateSettings(ir.settings);
  // FNXC:WorkflowOptionalGroup 2026-06-21-18:00:
  // The legacy `optionalSteps` declaration field is retired (optional steps are
  // now graph-native `optional-group` nodes). A legacy persisted `optionalSteps`
  // key on an old v2 row is TOLERATED — no longer validated/required — so old
  // rows still parse as v2.

  // Rework edges are legal intra-template (foreach, KTD-5) and — since U6
  // generalized the bounded-rework mechanism to the top-level walk — for a
  // designated top-level rework region (the PR review loop: await-review →
  // pr-respond → rework back to await-review). A top-level rework edge is legal
  // ONLY when its target (the loop head) explicitly opts in via
  // `config.reworkRegion === true`; the executor seeds the bound from that head's
  // `config.maxReworkCycles` (shared default + clamp). This keeps every other
  // top-level back-edge rejected (validateNoIllegalCycles below still throws for
  // non-rework cycles), so the relaxation is narrow and opt-in.
  for (const edge of ir.edges) {
    if (!isReworkEdge(edge)) continue;
    const head = nodesById.get(edge.to);
    if (head?.config?.reworkRegion === true) continue;
    throw new WorkflowIrError(
      `rework edge '${edge.from}' -> '${edge.to}' is only legal inside a foreach template ` +
        `or into a top-level rework region head (config.reworkRegion: true)`,
    );
  }

  validateNoIllegalCycles(ir.nodes, outgoing);
  validateRequiredTopLevelReachability(ir.nodes, outgoing);
  validateForeachDominance(ir.nodes, ir.edges, outgoing);
}

/** Clamp bounded workflow-node configs down to their caps, in place, mirroring
 *  the maxRetries clamp posture. Reject-of-<1 happens in validation. */
function clampForeachConfigs(ir: WorkflowIrV2): void {
  for (const node of ir.nodes) {
    if (node.kind === "loop") {
      const cfg = node.config as Partial<WorkflowLoopConfig> | undefined;
      if (
        cfg &&
        typeof cfg.maxIterations === "number" &&
        cfg.maxIterations > MAX_LOOP_ITERATIONS_CAP
      ) {
        cfg.maxIterations = MAX_LOOP_ITERATIONS_CAP;
      }
      continue;
    }
    if (node.kind !== "foreach") continue;
    const cfg = node.config as Partial<WorkflowForeachConfig> | undefined;
    if (
      cfg &&
      typeof cfg.maxReworkCycles === "number" &&
      cfg.maxReworkCycles > MAX_REWORK_CYCLES_CAP
    ) {
      cfg.maxReworkCycles = MAX_REWORK_CYCLES_CAP;
    }
  }
}

export function parseWorkflowIr(input: string | WorkflowIr): WorkflowIr {
  const value: unknown = typeof input === "string" ? JSON.parse(input) : input;
  if (!value || typeof value !== "object") {
    throw new WorkflowIrError("Workflow IR must be an object");
  }
  const ir = value as WorkflowIr;
  if (ir.version !== "v1" && ir.version !== "v2") {
    throw new WorkflowIrError("Workflow IR version must be v1 or v2");
  }
  if (!Array.isArray(ir.nodes) || !Array.isArray(ir.edges)) {
    throw new WorkflowIrError("Workflow IR nodes/edges must be arrays");
  }
  const startCount = ir.nodes.filter((n) => n.kind === "start").length;
  const endCount = ir.nodes.filter((n) => n.kind === "end").length;
  if (startCount !== 1 || endCount !== 1) {
    throw new WorkflowIrError("Workflow IR must contain exactly one start and one end node");
  }

  if (ir.version === "v1") {
    // Read-path upgrade: v1 graphs become v2 with synthesized default columns
    // and seam-based node placement. v1 fixtures keep parsing (FN-5769 contract).
    return upgradeV1ToV2(ir);
  }

  clampForeachConfigs(ir);
  validateV2(ir);
  return ir;
}

/** v1 node kinds (FN-5769). A pure-v1 graph uses only these; the v2-only kinds
 *  (hold/split/join) force v2 persistence. */
const V1_NODE_KINDS: ReadonlySet<WorkflowIrNodeKind> = new Set([
  "start",
  "prompt",
  "script",
  "gate",
  "end",
]);

/**
 * Rollback compat (FN issue #1405): if `ir` is a v2 graph that is byte-for-byte
 * equivalent to an upgraded-v1 graph — only v1 node kinds, no hold/split/join,
 * and exactly the synthesized default columns at their seam-derived placement —
 * downgrade it back to the v1 shape so pre-v2 binaries (which hard-reject
 * version !== 'v1') can still load the row. Returns the original `ir` unchanged
 * when any v2-only feature is present (custom columns, non-default placement,
 * v2-only node kinds), since those genuinely require v2.
 */
export function downgradeIrToV1IfPure(ir: WorkflowIr): WorkflowIr {
  if (ir.version !== "v2") return ir;

  // Any v2-only node kind means the graph cannot be represented in v1.
  for (const node of ir.nodes) {
    if (!V1_NODE_KINDS.has(node.kind)) return ir;
  }

  // Step-inversion declarations (artifacts/fields), workflow settings (U1), and
  // any legacy persisted optional-step declarations are v2-only features.
  // FNXC:WorkflowOptionalGroup 2026-06-21-18:00 (updated 2026-06-22-09:00):
  // `optionalSteps` is no longer a typed IR field (retired declaration model), but
  // a legacy v2 row may still carry the key. Read it via an untyped cast so such a
  // row is still treated as v2 (kept on v2, never silently downgraded). The mere
  // PRESENCE of the key — including an empty `[]` — is the v2 signal: an author
  // who wrote the key intended v2, and downgrading an `optionalSteps: []` row to
  // v1 would still mutate its persisted shape. (Code review: CodeRabbit.)
  const legacyOptionalSteps = (ir as { optionalSteps?: unknown }).optionalSteps;
  if (
    (ir.artifacts && ir.artifacts.length > 0) ||
    (ir.fields && ir.fields.length > 0) ||
    (ir.settings && ir.settings.length > 0) ||
    legacyOptionalSteps !== undefined
  ) {
    return ir;
  }

  // Columns must be exactly the synthesized default set, same ids, same order,
  // with the minimal (placement-only) empty trait set. Any custom column, rename,
  // reorder, or applied trait forces v2.
  if (ir.columns.length !== DEFAULT_WORKFLOW_COLUMN_IDS.length) return ir;
  for (let i = 0; i < ir.columns.length; i++) {
    const col = ir.columns[i];
    const expectedId = DEFAULT_WORKFLOW_COLUMN_IDS[i];
    if (col.id !== expectedId || col.name !== expectedId || col.traits.length !== 0) {
      return ir;
    }
    // A permanent-agent binding is a v2-only feature (column-agent plan, R9): a
    // graph that staffs a column can never round-trip through a pre-v2 binary.
    if (col.agent !== undefined) return ir;
    if (col.extensions !== undefined && Object.keys(col.extensions).length > 0) return ir;
  }

  // Every node must sit in its default seam-derived column. A node placed
  // elsewhere is a v2 feature (custom placement) and must stay v2.
  for (const node of ir.nodes) {
    if (node.column !== defaultColumnForNode(node)) return ir;
    if (node.extensions !== undefined && Object.keys(node.extensions).length > 0) return ir;
  }

  // Pure v1: emit the v1 shape, dropping the synthesized `column` fields so the
  // result round-trips through a pre-v2 binary. (Re-reading it on a v2 binary
  // re-upgrades it to the identical v2 graph via upgradeV1ToV2.)
  return {
    version: "v1",
    name: ir.name,
    nodes: ir.nodes.map(({ column: _column, ...rest }) => rest),
    edges: ir.edges,
  };
}

export function serializeWorkflowIr(ir: WorkflowIr): string {
  return JSON.stringify(ir, null, 2);
}

/**
 * Strip the trust-escalating `cliSkipApproval`/`autoApprove` flags from every
 * node config in an IR, recursing into template-group `config.template.nodes`.
 * Mutates the passed IR in place and returns it alongside a `stripped` flag
 * indicating whether anything was removed.
 *
 * These flags bypass the CLI first-run approval gate (see executor.ts). They are
 * legitimate only for workflows authored through the trusted dashboard editor /
 * executor lane; on prompt-injectable surfaces (chat/planning authoring tools,
 * import, AI design) they must be removed at the write boundary.
 */
export function stripApprovalBypassFlags(ir: WorkflowIr): { ir: WorkflowIr; stripped: boolean } {
  const nodes = (ir as { nodes?: WorkflowIrNode[] }).nodes;
  if (!Array.isArray(nodes)) return { ir, stripped: false };
  let stripped = false;
  const stripNode = (node: WorkflowIrNode): void => {
    // Untrusted input may contain non-object entries (null, strings, numbers)
    // in `nodes` / `template.nodes`; skip them rather than dereferencing.
    if (!node || typeof node !== "object") return;
    const cfg = node.config as Record<string, unknown> | undefined;
    if (cfg && typeof cfg === "object") {
      if ("cliSkipApproval" in cfg) {
        delete cfg.cliSkipApproval;
        stripped = true;
      }
      if ("autoApprove" in cfg) {
        delete cfg.autoApprove;
        stripped = true;
      }
      const template = (cfg as { template?: { nodes?: unknown } }).template;
      if (template && Array.isArray(template.nodes)) {
        for (const inner of template.nodes as WorkflowIrNode[]) stripNode(inner);
      }
    }
  };
  for (const node of nodes) stripNode(node);
  return { ir, stripped };
}
