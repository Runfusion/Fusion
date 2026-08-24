/*
FNXC:MergeAuthority 2026-08-23-18:05 (FN-9191 + FN-9193 wedges):
ONE MERGE AUTHORITY. The workflow graph decides when a card merges: `code-review -> review ->
merge-gate -> ... -> merge-attempt`, and `merge-attempt` calls `requestInterpreterMerge`. The
engine's in-review auto-merge sweep is a SECOND caller that pushes ids into the same queue on its
own initiative, judging from column + status + steps + retry budget with no idea where the card sits
in its graph. Both recent wedges are that second authority firing early:

  FN-9191 — sweep merged ~2s after `fn_task_done`, before Code Review had ever started.
  FN-9193 — sweep merged while Code Review was RE-running; the gate then requested revision, reset
            the steps, and the in-flight merge landed the pre-remediation branch on main anyway. The
            card was left `mergeConfirmed` WITH incomplete steps — a state nothing can finalize, so
            it sat failed for five hours re-reading its own contradiction.

This classifier demotes the sweep to a RECOVERY servicer: it may only re-drive a merge the graph
already authorized, or finalize one that already landed. It never initiates. A card that has not
reached its merge region is left to its graph, whatever its column says.

Deliberately fails OPEN in three places, because a sweep that refuses everything strands cards with
no other driver: an unresolvable workflow (legacy/pre-graph rows), a continuation naming a node the
current IR no longer has (drifted IR), and a quiescent card whose gates are all satisfied.
*/

/** Where a card's active continuations sit relative to its workflow's merge region. */
export type MergeRegionPosition = "merge-region" | "outside-merge-region" | "unknown";

export interface MergeSweepAdmissionInput {
  /*
  FNXC:MergeAuthority 2026-08-23-20:05 (review finding #5):
  CAN WE TRUST THIS GRAPH'S NODE IDS FOR THIS CARD? `resolveWorkflowIrForTask` never returns null —
  it degrades to `builtin:coding` — so the original `hasWorkflowIr: !!ir` was always true and the
  legacy fail-open it guarded was dead code. Deleting that branch rather than reviving it is
  deliberate: a card with no stored selection runs on the PROJECT DEFAULT workflow, so the resolved
  graph is still its real graph and its positions are meaningful. Reviving the fail-open for that
  case would admit every such card unconditionally — the exact hole this change closes.

  Only one case is genuinely untrustworthy: a selection that NAMES a workflow the store could not
  resolve (missing or malformed). There the returned graph belongs to a different workflow, so every
  node id classifies `"unknown"` and would ride the drifted-node fail-open straight to admit.
    - `"cards-own"`           — resolved from the card's own selection.
    - `"effective-default"`   — no selection stored; the default workflow IS this card's workflow.
    - `"unresolved-selection"`— a named selection that did not resolve; positions are unusable.
  */
  irTrust: "cards-own" | "effective-default" | "unresolved-selection";
  /** One entry per ACTIVE `kind:"task"` continuation, classified against the task's own IR. */
  continuationPositions: readonly MergeRegionPosition[];
  /*
  FNXC:MergeAuthority 2026-08-23-20:05 (review finding #4):
  UNREADABLE IS NOT EMPTY. A failed continuation read used to collapse to `[]`, which reads as
  "nothing is scheduled" — the precondition for both remaining admit paths. A transient database
  error could therefore admit a card whose graph was mid-execution. False here refuses initiation
  outright; only an already-landed merge (finalization) outranks it.
  */
  continuationsReadable: boolean;
  /** `mergeDetails.mergeConfirmed` — the branch already landed; only finalization remains. */
  mergeConfirmed: boolean;
  /** Any live session surface for this task: executor, workflow-step, AI merge, workspace repo lease. */
  hasLiveSession: boolean;
  /*
  FNXC:MergeAuthority 2026-08-23-20:05 (review finding #3):
  Durable proof the graph started a merge for this card and was interrupted: an active/crash-left
  merging status, or a live merge-request record. A consumed `mergeRetries` counter is deliberately
  NOT proof — it survives a conflict bounce back to in-progress and a full re-implementation, so a
  card that has since moved backward still carried it and was re-authorized by residue alone.
  */
  interruptedMergeAttempt: boolean;
  /** Milliseconds since the task last changed. Guards the quiescent-stall fallback. */
  quiescentMs: number;
  /** False when the IR-aware merge door would refuse this card (unrun/pending/failed pre-merge gates). */
  gatesSatisfied: boolean;
  /** Override for tests; production uses `DEFAULT_MERGE_SWEEP_QUIESCENCE_MS`. */
  quiescenceFloorMs?: number;
}

export type MergeSweepAdmissionReason =
  | "merge-confirmed-finalization"
  | "continuations-unreadable"
  | "unresolved-workflow-ir"
  | "at-merge-region-node"
  | "drifted-continuation-node"
  | "interrupted-merge-attempt"
  | "quiescent-stall-recovery"
  | "live-session"
  | "not-at-merge-region-node"
  | "gates-unsatisfied"
  | "too-recent";

export interface MergeSweepAdmission {
  admit: boolean;
  reason: MergeSweepAdmissionReason;
}

/*
FNXC:MergeAuthority 2026-08-23-18:05:
Two minutes. The quiescent-stall fallback is the ONLY path by which the sweep may still start a
merge the graph did not ask for, so its floor has to sit well above the gap between two graph nodes
or it re-opens FN-9193. Measured on that task: `fn_task_done` -> Code Review start was 30s and 36s
on its two passes. Two minutes clears both by 3x while keeping recovery inside a few 15s sweeps.
It is a floor, not the whole guard — the fallback also requires no live session AND satisfied gates.
*/
export const DEFAULT_MERGE_SWEEP_QUIESCENCE_MS = 2 * 60_000;

/**
 * Decide whether the in-review auto-merge sweep may enqueue this card.
 *
 * Pure and total: every input combination returns a reason, so the caller can log exactly why a card
 * was held back. Order matters — see the inline notes.
 */
export function classifyMergeSweepAdmission(input: MergeSweepAdmissionInput): MergeSweepAdmission {
  /*
  Liveness first, above even a confirmed merge. The sweep has no deadline: if anything is actively
  holding the card — an executor remediating, a review step running, an AI merge in flight, a
  workspace sub-repo land — the right move is to let it finish and pick the card up next sweep.
  FN-9193 died in exactly this window, with a Completion-summary session live.
  */
  if (input.hasLiveSession) return { admit: false, reason: "live-session" };

  /*
  A landed branch outranks graph position: the merge ALREADY happened, so this is finalization, not
  initiation. This is the one admission that repairs FN-9193's aftermath rather than preventing it,
  and the only one that outranks an unreadable continuation read — refusing to finalize a merge that
  is already on the target branch leaves the card in the unfinalizable state this change exists to
  end.
  */
  if (input.mergeConfirmed) return { admit: true, reason: "merge-confirmed-finalization" };

  /*
  FNXC:MergeAuthority 2026-08-23-20:05 (review finding #6):
  UNIVERSAL GATE FENCE. Every remaining admission is an INITIATION, and no initiation may proceed
  while an enabled pre-merge gate is unrun, pending, or failed — regardless of graph position. This
  was previously fenced only on the quiescent path, which left the deferral loop open: a card
  admitted for another reason reached the merge door, the door correctly refused with
  `PreMergeStepsNotRunError`, the deferral wrote no status and burned no retry, and the next sweep
  admitted it again — every 15s, indefinitely. Fencing here is what makes the deferral's "this
  cannot spin" claim true.
  */
  if (!input.gatesSatisfied) return { admit: false, reason: "gates-unsatisfied" };

  // Unreadable continuations: we cannot prove where the graph is, so we do not initiate. (#4)
  if (!input.continuationsReadable) return { admit: false, reason: "continuations-unreadable" };

  /*
  A named-but-unresolved selection means the resolved graph is NOT this card's workflow, so its node
  ids cannot classify these continuations (#5). Fall through to the fenced quiescent path, which
  needs no graph knowledge; refusing outright would strand every card whose workflow failed to load.
  */
  if (input.irTrust === "unresolved-selection") {
    return quiescentStallDecision(input, "unresolved-workflow-ir");
  }

  if (input.continuationPositions.length > 0) {
    if (input.continuationPositions.includes("merge-region")) {
      return { admit: true, reason: "at-merge-region-node" };
    }
    // Drifted IR: a continuation names a node this workflow no longer has. Fail open.
    if (input.continuationPositions.includes("unknown")) {
      return { admit: true, reason: "drifted-continuation-node" };
    }
    // The graph is holding this card somewhere that is not a merge node. Not ours to merge.
    return { admit: false, reason: "not-at-merge-region-node" };
  }

  /*
  An interrupted merge is graph-authorized work: the graph reached its merge node, the attempt was
  cut short (engine restart, pause, transient failure), and the durable residue proves it. Reachable
  only with NO active continuation, so a card that has since moved back out of the merge region — a
  revision request, a bounce to in-progress — is judged by where it is NOW, not by the stale residue
  of the attempt that preceded it. That ordering is what keeps FN-9193's second pass refused.
  */
  if (input.interruptedMergeAttempt) {
    return { admit: true, reason: "interrupted-merge-attempt" };
  }

  return quiescentStallDecision(input, "quiescent-stall-recovery");
}

/*
Quiescent-stall fallback. No continuation at all means nothing is scheduled to drive this card;
before this change the sweep rescued those, and dropping the rescue outright would trade a
premature-merge bug for a stalled-card bug. Kept, but fenced by all three conditions: nothing live
and gates satisfied (both checked by the caller above), plus a quiescence floor far longer than any
normal inter-node gap.
*/
function quiescentStallDecision(
  input: MergeSweepAdmissionInput,
  reason: "quiescent-stall-recovery" | "unresolved-workflow-ir",
): MergeSweepAdmission {
  const floorMs = input.quiescenceFloorMs ?? DEFAULT_MERGE_SWEEP_QUIESCENCE_MS;
  if (!(input.quiescentMs >= floorMs)) return { admit: false, reason: "too-recent" };
  return { admit: true, reason };
}
