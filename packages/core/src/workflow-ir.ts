import type {
  WorkflowIr,
  WorkflowIrColumn,
  WorkflowIrEdge,
  WorkflowIrNode,
  WorkflowIrNodeKind,
  WorkflowIrV1,
  WorkflowIrV2,
  WorkflowHoldRelease,
} from "./workflow-ir-types.js";

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
 *  one worktree/session per task and exclusive merge are physical constraints. */
const SEAM_FORBIDDEN_IN_BRANCH: ReadonlySet<string> = new Set(["execute", "merge"]);

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
  }
}

function validateV2(ir: WorkflowIrV2): void {
  validateColumns(ir);

  const columnIds = new Set(ir.columns.map((c) => c.id));
  const nodesById = new Map(ir.nodes.map((n) => [n.id, n]));

  for (const node of ir.nodes) {
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

  const outgoing = buildOutgoing(ir.edges);
  validateParallelism(ir.nodes, outgoing, nodesById);
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
  }

  // Every node must sit in its default seam-derived column. A node placed
  // elsewhere is a v2 feature (custom placement) and must stay v2.
  for (const node of ir.nodes) {
    if (node.column !== defaultColumnForNode(node)) return ir;
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
