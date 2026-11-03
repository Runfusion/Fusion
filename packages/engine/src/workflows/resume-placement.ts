/*
FNXC:ResumePlacement 2026-11-01-17:33 (RUFU-300):
WHERE AN AUTOMATIC RE-ENTRY PLACES A RUN — one evidence-aware rule for every authority.

Before this module, resume placement came from one of two answers, neither of which looked at the
card's own gate evidence:
  - the durable continuation's node id (`execute-workflow-graph.ts`: `continuation?.nodeId`), and
  - the column entry contract (`resolveColumnResumeNode(ir, task.column)` in
    `workflow-graph-executor.ts`), which is deliberately column-only.
So a card whose `plan-review` row was already `passed` could re-run the planning prologue (the column
contract answers `start` for a `todo` card), and the seam-park shape (pin `parse`/`in-progress` while
`column: "todo"`) re-placed at `parse` every pass, churning `updatedAt` for hours with zero new
agent-log lines and zero recorded reason.

The rules encoded here:
  - A released gate is NEVER replayed. A gate node is released when its LATEST `workflowStepResults`
    row satisfies core's `isPlanReviewSatisfied` (the one satisfaction predicate — Plan Review), or is
    `passed`, or is an operator waiver (`skipped` + `bypassedBy`). A `remediationArchivedAt` collateral
    archive, `pending`, `failed`, an absent row, and a `supersededAt` row release NOTHING.
  - Placement is the first main-path node STRICTLY after the furthest released gate, over the same
    forward-only traversal (no `rework` edges, no non-`success` conditions) `resolveColumnResumeNode`
    documents. For the shipped `builtin:coding` IR that answer is `parse`, because
    `planReviewOptionalGroupNode("todo")` sits between `plan` and `parse` and the IR wires
    `plan-review -> parse` on success. That is the REQUIRED placement for that shape — the invariant
    is "no replay of the released gate", never "never `parse`".
  - Forward-only. Never at or behind a released gate, never at a foreach TEMPLATE node id (only
    top-level `ir.nodes` are legal resume points), and never forward without evidence: with no
    released gate and no pin this resolver answers exactly what the column contract answered.
  - This resolver MOVES NOTHING. Graph-owned column moves belong to `workflow-column-boundary.ts`;
    the `hold -> wip` crossing belongs to `execution/hold-release.ts` alone (KTD-2, pinned by
    `workflow-graph-column-moves.test.ts`, `builtin-workflows-lifecycle.test.ts`,
    `benchmark-six-column-workflow.test.ts`, `scheduler-trait-dispatch.test.ts`).
  - Pin/column disagreement is CLASSIFIED, never silent, and never a false alarm: a pin naming the wip
    lane while the card still sits in the hold lane is the seam's own evidence (the pin is written at
    node entry, before the KTD-2 refusal), so it reports `pin-at-release-seam`, not incoherence.
*/
import {
  findWorkflowColumn,
  isHoldToWipBoundary,
  isPlanReviewSatisfied,
  isReviewGateNode,
  resolveColumnFlags,
  type Task,
  type WorkflowIr,
  type WorkflowIrNode,
  type WorkflowStepResult,
} from "@fusion/core";

import { resolveColumnResumeNode } from "./workflow-graph-executor.js";

/** What justified the chosen placement. Fixed vocabulary — safe for run-audit metadata. */
export type ResumePlacementSource =
  /** The durable continuation named this node and it is still a top-level graph node. */
  | "continuation"
  /** The column entry contract's answer (unchanged pre-RUFU-300 behaviour). */
  | "column"
  /** Gate evidence on the card placed the run strictly after a released gate. */
  | "after-released-gate"
  /** The ledger already carries progress, so the ledger-rewriting `parse-steps` node was traded for
   *  the `foreach` that consumes it. See `ledgerConsumerInsteadOfRewrite`. */
  | "ledger-progress"
  /** Nothing else resolved: the caller keeps its `start`-node fallback. */
  | "start";

/**
 * Fixed vocabulary for a pin/column disagreement.
 *
 * `pin-at-release-seam` is NOT a finding: it is the designed signature of a card parked at the
 * scheduler's release seam, which the KTD-2 refusal produces on purpose. Only the other two are
 * incoherence, and the announcement distinguishes them so a legal park never alarms.
 */
export type ResumePlacementMismatchKind =
  | "pin-at-release-seam"
  | "pin-ahead-of-column"
  | "pin-behind-column";

export interface ResumePlacementMismatch {
  kind: ResumePlacementMismatchKind;
  /** `task.column` at re-entry. */
  columnId: string;
  /** `task.workflowIrPinColumnId` — the column the pin believes the run is in. */
  pinColumnId?: string;
  /** `task.workflowIrPinNodeId` — the node the pin believes the run is at. */
  pinNodeId?: string;
}

export interface ResumePlacement {
  /** The node to enter, or undefined when the caller must keep its own fallback. */
  nodeId?: string;
  source: ResumePlacementSource;
  /** Gate node ids whose latest row releases them — never re-dispatched from this placement. */
  releasedNodeIds: string[];
  mismatch?: ResumePlacementMismatch;
}

export interface ResumePlacementInput {
  ir: WorkflowIr;
  task: Task;
  /** The durable continuation's node id, when one exists. */
  continuationNodeId?: string;
  /** Injected clock for determinism; unused today, declared so a staleness rule cannot sneak in. */
  now?: () => number;
}

/** A gate node is a review gate (`optional-group` / `step-review`) or the Plan Review group node. */
const PLAN_REVIEW_NODE_ID = "plan-review";

function isGateNode(node: WorkflowIrNode): boolean {
  return isReviewGateNode(node) || node.id === PLAN_REVIEW_NODE_ID;
}

/** Newest row wins: duplicates are normal (retries, remediation), and the FIRST row is stale evidence. */
function latestRowFor(results: WorkflowStepResult[] | undefined, stepId: string): WorkflowStepResult | undefined {
  let best: WorkflowStepResult | undefined;
  let bestAt = -1;
  for (const row of results ?? []) {
    if (row.workflowStepId !== stepId) continue;
    const stamp = Date.parse(row.completedAt ?? row.startedAt ?? "") || 0;
    // `>=` keeps the LAST duplicate when timestamps tie or are unparseable.
    if (stamp >= bestAt) {
      best = row;
      bestAt = stamp;
    }
  }
  return best;
}

/**
 * Is this gate released? Three shapes only: the one Plan Review satisfaction predicate, a plain
 * `passed` row, or an audited operator waiver. A collateral archive (`remediationArchivedAt` with no
 * `bypassedBy`) is an archive, not a waiver, and releases nothing.
 */
export function isGateReleased(row: WorkflowStepResult | undefined): boolean {
  if (!row) return false;
  if (row.supersededAt != null) return false;
  if (isPlanReviewSatisfied(row)) return true;
  if (row.status === "passed") return true;
  return row.status === "skipped" && typeof row.bypassedBy === "string" && row.bypassedBy.trim().length > 0;
}

/**
 * Forward-only BFS order over the main path, exactly the traversal rule
 * `resolveColumnResumeNode` documents: `rework` back-edges and non-`success` conditions are excluded,
 * so a remediation node that merely sits in a lane is never counted as progress.
 */
function forwardOrder(ir: WorkflowIr): { index: Map<string, number>; nodes: WorkflowIrNode[] } {
  const nodeById = new Map(ir.nodes.map((node) => [node.id, node]));
  const startNode = ir.nodes.find((node) => node.kind === "start");
  const index = new Map<string, number>();
  const nodes: WorkflowIrNode[] = [];
  if (!startNode) return { index, nodes };

  const queue: string[] = [startNode.id];
  const seen = new Set<string>([startNode.id]);
  while (queue.length > 0) {
    const id = queue.shift()!;
    const node = nodeById.get(id);
    if (!node) continue;
    index.set(id, nodes.length);
    nodes.push(node);
    for (const edge of ir.edges) {
      if (edge.from !== id || edge.kind === "rework") continue;
      if (edge.condition && edge.condition !== "success") continue;
      if (seen.has(edge.to)) continue;
      seen.add(edge.to);
      queue.push(edge.to);
    }
  }
  return { index, nodes };
}

/** The first main-path node strictly after `fromId` that is not itself released. */
function firstUnreleasedSuccessor(ir: WorkflowIr, fromId: string, released: Set<string>): WorkflowIrNode | undefined {
  const nodeById = new Map(ir.nodes.map((node) => [node.id, node]));
  const queue: string[] = [fromId];
  const seen = new Set<string>([fromId]);
  while (queue.length > 0) {
    const id = queue.shift()!;
    for (const edge of ir.edges) {
      if (edge.from !== id || edge.kind === "rework") continue;
      if (edge.condition && edge.condition !== "success") continue;
      if (seen.has(edge.to)) continue;
      seen.add(edge.to);
      const node = nodeById.get(edge.to);
      if (!node) continue;
      // A released gate further down must not be re-entered either — keep walking past it.
      if (released.has(node.id)) {
        queue.push(node.id);
        continue;
      }
      return node;
    }
  }
  return undefined;
}

/*
FNXC:ResumePlacement 2026-11-01-17:33 (RUFU-300):
Classifies the pin/column pair from column TRAITS rather than column ids, the same rule
`isHoldToWipBoundary` and the column-restart planner use, so a renamed or custom board classifies the
same way the release seam does. Undecidable shapes — no pinned column, or a column the IR no longer
declares — stay unclassified on purpose: a pin that no longer resolves is the KTD-3 drift guard's
subject, and inventing an incoherence verdict from an unreadable pair is how a false alarm is born.
*/
function classifyMismatch(task: Task, ir: WorkflowIr): ResumePlacementMismatch | undefined {
  const columnId = task.column;
  const pinColumnId = task.workflowIrPinColumnId;
  const pinNodeId = task.workflowIrPinNodeId;
  const mismatch = (kind: ResumePlacementMismatchKind): ResumePlacementMismatch => ({
    kind,
    columnId,
    ...(pinColumnId ? { pinColumnId } : {}),
    ...(pinNodeId ? { pinNodeId } : {}),
  });
  if (!columnId || !pinColumnId || pinColumnId === columnId) return undefined;

  const cardColumn = findWorkflowColumn(ir, columnId);
  const pinnedColumn = findWorkflowColumn(ir, pinColumnId);
  if (!cardColumn || !pinnedColumn) return undefined;

  const cardFlags = resolveColumnFlags(cardColumn);
  const pinFlags = resolveColumnFlags(pinnedColumn);
  // The designed seam: the pin names the execution lane a hold→wip release is about to cross into.
  if (isHoldToWipBoundary(cardFlags, pinFlags)) return mismatch("pin-at-release-seam");

  const laneOrder = (ir as unknown as { columns?: Array<{ id: string }> }).columns?.map((column) => column.id) ?? [];
  const cardIndex = laneOrder.indexOf(columnId);
  const pinIndex = laneOrder.indexOf(pinColumnId);
  if (cardIndex < 0 || pinIndex < 0) return undefined;
  return mismatch(pinIndex > cardIndex ? "pin-ahead-of-column" : "pin-behind-column");
}

export function resolveResumePlacement(input: ResumePlacementInput): ResumePlacement {
  const { ir, task, continuationNodeId } = input;
  if (ir.version !== "v2") {
    return { source: "start", releasedNodeIds: [] };
  }

  const order = forwardOrder(ir);
  const gateNodes = ir.nodes.filter((node) => isGateNode(node) && order.index.has(node.id));
  const releasedNodeIds: string[] = [];
  for (const node of gateNodes) {
    if (isGateReleased(latestRowFor(task.workflowStepResults, node.id))) releasedNodeIds.push(node.id);
  }
  const released = new Set(releasedNodeIds);
  const mismatch = classifyMismatch(task, ir);

  // The furthest released gate along the main path is the one the run must land behind.
  let furthest: string | undefined;
  let furthestIndex = -1;
  for (const id of releasedNodeIds) {
    const at = order.index.get(id) ?? -1;
    if (at > furthestIndex) {
      furthest = id;
      furthestIndex = at;
    }
  }

  const candidates: Array<{ nodeId: string; source: ResumePlacementSource }> = [];
  // A continuation naming a foreach TEMPLATE node is not a legal resume point; drop it here and let
  // the caller keep its own debug log for that case.
  if (continuationNodeId && order.index.has(continuationNodeId)) {
    candidates.push({ nodeId: continuationNodeId, source: "continuation" });
  }
  const columnNode = resolveColumnResumeNode(ir, task.column);
  if (columnNode) candidates.push({ nodeId: columnNode.id, source: "column" });
  if (furthest) {
    const after = firstUnreleasedSuccessor(ir, furthest, released);
    if (after) candidates.push({ nodeId: after.id, source: "after-released-gate" });
  }

  // Never place at or behind the released gate itself.
  const legal = candidates.filter((candidate) => (order.index.get(candidate.nodeId) ?? -1) > furthestIndex);
  const precedence: Record<ResumePlacementSource, number> = {
    continuation: 4,
    "after-released-gate": 3,
    // Never competes in this loop — the ledger refinement runs AFTER selection — but ranked next to
    // `column` so a future author who does add it to `candidates` gets the sane ordering.
    "ledger-progress": 2,
    column: 1,
    start: 0,
  };
  let chosen = legal[0];
  for (const candidate of legal) {
    const candidateIndex = order.index.get(candidate.nodeId) ?? -1;
    const chosenIndex = chosen ? (order.index.get(chosen.nodeId) ?? -1) : -1;
    if (
      !chosen
      || candidateIndex > chosenIndex
      || (candidateIndex === chosenIndex && precedence[candidate.source] > precedence[chosen.source])
    ) {
      chosen = candidate;
    }
  }

  if (!chosen) {
    return { source: "start", releasedNodeIds, ...(mismatch ? { mismatch } : {}) };
  }

  /*
   * FNXC:ResumePlacement 2026-11-01-19:40 (RUFU-300):
   * A placement that lands a card back on a LEDGER-REWRITING node while its own ledger carries durable
   * progress destroys that progress. Measured before this guard: a card seeded
   * `done,done,done,pending…` with `currentStep: 3`, re-entered at `parse` alone, ended `pending` × 9
   * with `currentStep` STILL 3 — the parse runner rebuilds every step as `{ name, status: "pending" }`
   * and the production write seam patches `steps` wholesale, leaving a ledger/cursor disagreement no
   * operator can read off the card. A `parse-steps` placement is therefore legal only for a card with
   * nothing to lose, which is exactly RUFU-292's shape (parsed, never executed). With progress, hand
   * the run to the node that CONSUMES the ledger: the `foreach` a parse node's success edge points at
   * expands from the ledger itself and resumes at the first unfinished iteration (measured:
   * `steps#3:step-execute`, the three completed steps intact). Only resolver-inferred candidates are
   * refined here — an explicit caller `startNodeId` is a caller-owned replay, and a continuation-owned
   * work item is a node that genuinely holds a checkout.
   */
  if (chosen.source !== "continuation") {
    const consumer = ledgerConsumerInsteadOfRewrite(ir, ir.nodes.find((node) => node.id === chosen.nodeId), task);
    if (consumer) {
      return { nodeId: consumer.id, source: "ledger-progress", releasedNodeIds, ...(mismatch ? { mismatch } : {}) };
    }
  }
  return { nodeId: chosen.nodeId, source: chosen.source, releasedNodeIds, ...(mismatch ? { mismatch } : {}) };
}

/*
FNXC:ResumePlacement 2026-11-01-19:40 (RUFU-300):
`true` when the ledger is past the point of being re-creatable from the artifact: any non-`pending`
status, or a cursor that has moved. Both signals count — a moved cursor over an all-`pending` ledger is
already an inconsistent card, and the conservative reading protects the progress the cursor claims.
*/
function hasLedgerProgress(task: Task): boolean {
  if ((task.currentStep ?? 0) > 0) return true;
  return (task.steps ?? []).some((step) => step.status !== "pending");
}

/**
 * The node to enter instead of a ledger-rewriting `parse-steps` node, or `undefined` when the graph
 * offers no ledger-consuming alternative — a workflow without a `foreach` keeps its parse placement,
 * because inventing a node the card's own IR never declared is a worse failure than the one guarded.
 */
function ledgerConsumerInsteadOfRewrite(
  ir: WorkflowIr,
  node: WorkflowIrNode | undefined,
  task: Task,
): WorkflowIrNode | undefined {
  if (!node || node.kind !== "parse-steps" || !hasLedgerProgress(task)) return undefined;
  const edge = ir.edges.find(
    (candidate) => candidate.from === node.id
      && candidate.kind !== "rework"
      && (!candidate.condition || candidate.condition === "success"),
  );
  if (!edge) return undefined;
  const target = ir.nodes.find((candidate) => candidate.id === edge.to);
  return target?.kind === "foreach" ? target : undefined;
}

/* ── The bounded announcement ───────────────────────────────────────────────── */

/** The flat descriptor callers map onto `emitBoundedRunAudit`. Ids and fixed enums only. */
export interface ResumePlacementMismatchEvent {
  mutationType: "task:resume-placement-mismatch";
  taskId: string;
  column: string;
  workflowIrPinColumnId?: string;
  workflowIrPinNodeId?: string;
  placedNodeId?: string;
  placementSource: ResumePlacementSource;
  mismatchKind: ResumePlacementMismatchKind;
  /** `awaiting-scheduler-release` marks the LEGAL seam park; `announced` marks real incoherence. */
  outcome: "awaiting-scheduler-release" | "announced";
}

export interface ResumePlacementSinks {
  logEntry?: (taskId: string, message: string) => void | Promise<void>;
  emitAudit?: (event: ResumePlacementMismatchEvent) => void | Promise<void>;
}

/*
FNXC:ResumePlacement 2026-11-01-17:33 (RUFU-300):
One row per (card, mismatch signature), not one per pass. Without this bound the seam-park shape that
motivated RUFU-300 would announce on every scheduler poll forever and the signal would die the same
way `task:workflow-run-suspended` did at 185 rows an hour; with a changed signature the episode is
over and a NEW wedge must be able to announce, so the key carries the whole disagreement identity.
*/
const announcedEpisodes = new Map<string, string>();

/** Test seam: forget every recorded episode (module state is process-local by design). */
export function resetResumePlacementEpisodeForTesting(): void {
  announcedEpisodes.clear();
}

/** The signature of the CURRENT disagreement, or null when the card is coherent. */
export function resumePlacementMismatchSignature(placement: ResumePlacement): string | null {
  const mismatch = placement.mismatch;
  if (!mismatch) return null;
  return [
    mismatch.kind,
    mismatch.pinNodeId ?? "none",
    mismatch.pinColumnId ?? "none",
    mismatch.columnId,
  ].join("|");
}

/**
 * Announce a placement disagreement at most once per episode. Never throws and never changes the
 * placement: a hostile, rejecting, or absent sink is absorbed exactly like `emitBoundedRunAudit`
 * absorbs one (AGENTS.md FN-9175) — telemetry must not become a lifecycle dependency.
 *
 * @returns whether the COHERENCE notice was newly written. The self-healing coherence sweep reports a
 * count of cards it actually announced, and a value it computed from its own candidate list would
 * claim announcements that the episode bound suppressed — a count that lies is worse than no count.
 */
export async function announceResumePlacement(
  sinks: ResumePlacementSinks | undefined,
  args: {
    taskId: string;
    task: Task;
    ir?: WorkflowIr;
    placement: ResumePlacement;
  },
): Promise<{ mismatchAnnounced: boolean }> {
  const signature = resumePlacementMismatchSignature(args.placement);
  const mismatchAnnounced = signature && args.placement.mismatch
    ? await announceMismatch(sinks, args.taskId, args.placement, signature)
    : (announcedEpisodes.delete(args.taskId), false);
  /*
   * The skip fact is ORTHOGONAL to the coherence fact: a card parked at the release seam (the legal
   * `pin-at-release-seam` shape) still had a released gate skipped, and a coherent card placed behind a
   * released gate skipped one too. Both shapes need the same History line, so both get it.
   */
  await announceReleasedGateSkip(sinks, args.taskId, args.placement);
  return { mismatchAnnounced };
}

/** The bounded coherence notice. Split out so the orthogonal skip notice stays readable. */
async function announceMismatch(
  sinks: ResumePlacementSinks | undefined,
  taskId: string,
  placement: ResumePlacement,
  signature: string,
): Promise<boolean> {
  const mismatch = placement.mismatch!;
  /*
   * FNXC:ResumePlacement 2026-11-01-19:05 (RUFU-300):
   * With NO sink wired there is nothing to announce, and burning the episode anyway would be worse
   * than silent: the first sink-less pass would mark the episode and every later pass that DOES have
   * a sink would be swallowed by its own predecessor's marker. Only a pass that can actually emit
   * consumes the episode.
   */
  if (!sinks?.logEntry && !sinks?.emitAudit) return false;
  if (announcedEpisodes.get(taskId) === signature) return false;
  // Marked BEFORE the emits: a sink that explodes must not turn a bounded notice into a per-pass flood.
  announcedEpisodes.set(taskId, signature);

  const outcome = mismatch.kind === "pin-at-release-seam" ? "awaiting-scheduler-release" : "announced";
  const message
    = `[workflow-graph] ${taskId}: resume placed at '${placement.nodeId ?? "unknown"}'`
    + ` (source: ${placement.source}) while its IR pin says node '${mismatch.pinNodeId ?? "none"}'`
    + ` in column '${mismatch.pinColumnId ?? "none"}' and the card is in '${mismatch.columnId}'`
    + ` — ${mismatch.kind === "pin-at-release-seam"
      ? "legal release-seam park, waiting for the scheduler (the only hold→wip mover)"
      : `pin/column incoherence: ${mismatch.kind}`}`;

  try {
    await sinks?.logEntry?.(taskId, message);
  } catch {
    /* a dead log sink must not change the placement */
  }
  try {
    await sinks?.emitAudit?.({
      mutationType: "task:resume-placement-mismatch",
      taskId,
      column: mismatch.columnId,
      ...(mismatch.pinColumnId ? { workflowIrPinColumnId: mismatch.pinColumnId } : {}),
      ...(mismatch.pinNodeId ? { workflowIrPinNodeId: mismatch.pinNodeId } : {}),
      ...(placement.nodeId ? { placedNodeId: placement.nodeId } : {}),
      placementSource: placement.source,
      mismatchKind: mismatch.kind,
      outcome,
    });
  } catch {
    /* a dead audit sink must not change the placement */
  }
  return true;
}

/*
FNXC:ResumePlacement 2026-11-01-21:25 (RUFU-300):
The OTHER half of the announcement, and the one a passing run needs: when placement puts the run
BEHIND a released gate, that gate is never entered, so the graph's own per-node pre-merge gate — which
used to log `[pre-merge] Workflow step already satisfied: <name>` because the node was entered and then
short-circuited — has nothing to report. "Why didn't Plan Review run?" would become unanswerable from
the card, which is the observability RUFU-300 must not trade away for correctness. So the skip is
recorded where it now happens.

Task log only, deliberately: a released gate is skipped on nearly every resume of a planned card, so an
audit row per skip is the 185-rows-an-hour flood shape AGENTS.md warns about, while the card's own
History line is exactly where an operator looks for a skipped gate. Bounded per (gate set, placement)
signature — a card that resumes into the same placement again says it once.
*/
export async function announceReleasedGateSkip(
  sinks: ResumePlacementSinks | undefined,
  taskId: string,
  placement: ResumePlacement,
): Promise<void> {
  const skipped = placement.releasedNodeIds;
  if (skipped.length === 0) return;
  if (placement.source !== "after-released-gate" && placement.source !== "ledger-progress") return;
  if (!sinks?.logEntry) return;
  const key = `${taskId}#released-gate-skip`;
  const signature = [skipped.join(","), placement.nodeId ?? "none", placement.source].join("|");
  if (announcedEpisodes.get(key) === signature) return;
  announcedEpisodes.set(key, signature);
  try {
    await sinks.logEntry(
      taskId,
      `[workflow-graph] ${taskId}: resume skipped released gate(s): ${skipped.join(", ")}`
      + ` (placed at '${placement.nodeId ?? "unknown"}', source: ${placement.source})`
      + " — their durable evidence already authorizes them; a re-entry never re-runs a passed or operator-waived gate",
    );
  } catch {
    /* a dead log sink must not change the placement */
  }
}

/*
FNXC:ResumePlacement 2026-11-01-22:40 (RUFU-300):
A pin is a CLAIM that a run legitimately reached `pinnedNodeId` while its gates were authorised. This
predicate tests that claim against the card's own durable gate evidence, so an authority that reads the
pin (self-healing's advanced-triage re-home above all) asks the same question the graph asks.

ABSENCE IS NOT CONTRADICTION, deliberately. A gate row can be archived, cleared by another gate's
remediation, or simply predate the pin, and a card legitimately sitting behind a gate can lose the row
without losing its right to be there — refusing on absence would strand exactly the cards the recovery
sweep exists to rescue, which is a worse failure than the one it prevents. So only POSITIVE evidence
against the pin refuses it: the gate precedes the pinned node in forward order, its latest row exists,
and that row does not authorise (failed / REVISE / superseded / still pending). A pin ahead of the
first gate, or a pin whose preceding gates all authorise, is unchallenged and returns undefined.

An unjudgable pair also returns undefined: a v1 IR, a pinned node the current IR no longer declares, or
a node unreachable in forward order (a rework target, a lane the main path never enters) carries no
readable position, and inventing a contradiction from an unreadable pair is how a false alarm is born.
*/
export function pinContradictedByGateEvidence(input: {
  ir: WorkflowIr;
  task: Task;
  pinnedNodeId: string;
}): string | undefined {
  const { ir, task, pinnedNodeId } = input;
  if (ir.version !== "v2") return undefined;
  const order = forwardOrder(ir);
  const pinnedIndex = order.index.get(pinnedNodeId);
  if (pinnedIndex === undefined) return undefined;
  for (const node of order.nodes) {
    if (node.id === pinnedNodeId) break;
    if (!isGateNode(node)) continue;
    const row = latestRowFor(task.workflowStepResults, node.id);
    if (row && !isGateReleased(row)) return node.id;
  }
  return undefined;
}
