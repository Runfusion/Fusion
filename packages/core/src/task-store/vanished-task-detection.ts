/*
FNXC:VanishedTaskDetection 2026-09-24-00:12:
RUFU-225 proved that a task can be alive on disk and dead on every board read at the same time, and
that the board stays silent about it. Its mirror at `.fusion/tasks/RUFU-225/task.json` still carried
an APPROVE_WITH_NOTES code-review verdict, an `in-review` column and an `updatedAt` of
2026-09-17T14:08Z, while `fusion/rufu-225` held 3 commits that exist on no other ref. Nothing
surfaced it: `detectTaskIdIntegrityAnomalies` is row-only (active/archived duplicates, collisions,
sequence gaps) and reported `status: "ok"` throughout, a board query cannot return a row that is not
there, and FN-6783's orphan re-import needs BOTH a fully absent row and a 7-day age window the
mirror never reached. The operator found the card by hand.

This module is the inverse read: the disk directory is the authority for what work EXISTED, and the
row plus the branch are consulted to explain what happened to it. The classifier is pure — the
caller supplies the disk mirror, the row-presence branch (`TaskStore.resolveTaskIdPresence`) and the
branch probe (`git rev-list --count <branch> --not <base>`) — so the taxonomy is unit-testable
without a database or a checkout, and the engine sweep stays thin glue.
*/

import type { TaskIdPresence } from "./task-id-integrity.js";
import type { WorkflowStepResult } from "../types.js";
import { requiresAuthoredReviewVerdict } from "../merge/pre-merge-approval.js";

/** The persisted step-result fields the classifier needs to judge "was a gate already approved". */
export type VanishedTaskGateRow = Pick<
  WorkflowStepResult,
  "workflowStepId" | "status" | "reviewKind" | "verdictRequired" | "remediationArchivedAt"
>;

/*
FNXC:VanishedTaskDetection 2026-09-24-00:40:
The row evidence is the store's own `TaskIdPresence` shape, not a parallel interface. A copied shape
is a drift invitation: the day the presence authority gains a column, a copy silently stops carrying
it and the classifier keeps reasoning with stale facts while every test still passes.
*/
export type VanishedTaskRowPresence = TaskIdPresence;

/** One directory's observed evidence. The caller owns every I/O; this module owns the verdict. */
export interface VanishedTaskDirInput {
  /** Task id taken from the directory name. */
  taskId: string;
  /** Disk-mirror mtime in epoch milliseconds — used only by the caller's age bound. */
  mirrorMtimeMs: number;
  /** Row evidence, or `null` when the id resolves in no table at all. */
  row: VanishedTaskRowPresence | null;
  /**
   * Commits on the task branch that are on no other ref, from
   * `git rev-list --count <branch> --not <base>`. `null` means the probe could not run; an
   * un-probeable branch is reported as `state-unresolved` instead of being classified as lost.
   */
  unmergedCommitCount: number | null;
  /** Fields copied verbatim from the `task.json` mirror; `null` when the mirror is unreadable. */
  mirror: {
    column?: string | null;
    status?: string | null;
    workflowStepResults?: VanishedTaskGateRow[] | null;
    summary?: string | null;
    stalled?: boolean | null;
  } | null;
}

/** Why this directory counts as vanished work. Fixed enum — it is persisted in run-audit. */
export type VanishedTaskDirReason =
  /** No row anywhere; the branch still carries commits. Real unmerged work at risk. */
  | "row-missing-branch-unmerged"
  /** No row anywhere and the branch is gone too — recovery is the disk mirror only. */
  | "row-missing-branch-missing"
  /** Tombstoned row: off every board read, id reserved, work never removed. */
  | "row-tombstoned-branch-unmerged"
  /** Tombstoned row whose branch is already gone — only the mirror survives. */
  | "row-tombstoned-branch-missing"
  /**
   * FNXC:VanishedWorkTombstoneTaxonomy 2026-10-15-21:50 (RUFU-690): Tombstoned row whose branch could
   * not be resolved. Named separately from `state-unresolved` because a tombstone is itself an
   * explanation — the delete that produced it is audited — while `state-unresolved` means the card is
   * unknown to every table and nothing accounts for its disappearance. Both keep the unknown visible;
   * only the second one alarms an operator.
   */
  | "row-tombstoned-branch-unprobed"
  /** No row anywhere and the branch could not be probed; reported so the unknown stays visible. */
  | "state-unresolved";

/** Salvage guidance, derived so the operator never re-derives the ref or the command. */
export interface VanishedTaskSalvage {
  /** Canonical branch ref derived from the id — the ref a purge path would drop. */
  branchRef: string;
  /** Ref to salvage FROM. Always the canonical branch ref, so a lost branch is named, not hidden. */
  salvageTarget: string;
  /** Command that lists exactly the commits at risk. */
  salvageCommand: string;
  /** Plain-language next step, gated on whether an approved gate had already passed. */
  hint: string;
}

/** One classified finding: the taxonomy verdict plus everything needed to act on it. */
export interface VanishedTaskFinding {
  taskId: string;
  reason: VanishedTaskDirReason;
  branchRef: string;
  /** `null` when the probe could not run; the finding then carries `state-unresolved`. */
  unmergedCommitCount: number | null;
  /** True when a required review gate held an authored, passing, un-archived verdict. */
  gateApproved: boolean;
  /** Mirror `column` at the time of the last write, for the notice line. */
  mirrorColumn: string | null;
  salvage: VanishedTaskSalvage;
}

/** Derive the canonical task branch from its id — the same rule the merge and cleanup lanes use. */
export function taskBranchRefFor(taskId: string): string {
  return `fusion/${taskId.toLowerCase()}`;
}

/*
FNXC:VanishedTaskDetection 2026-09-24-00:12:
"An authored verdict already exists" is a stronger claim than "the step passed": it survives the
session that produced it, and it is exactly the evidence that turns a vanished directory into work
worth salvaging urgently rather than a housekeeping note. `requiresAuthoredReviewVerdict` is the
shared authority for that predicate — reusing it keeps this detector from drifting from the merge
gate it is describing (it also refuses an authored approval sitting on a step that never required
one). `remediationArchivedAt` is FN-295's veto: a row archived by a later remediation had its
verdict superseded, so it cannot claim salvage priority.
*/
function hasApprovedReviewGate(results: VanishedTaskGateRow[] | null | undefined): boolean {
  if (!Array.isArray(results)) return false;
  return results.some((row) => {
    if (!row || typeof row !== "object") return false;
    if (row.remediationArchivedAt) return false;
    const stepId = typeof row.workflowStepId === "string" ? row.workflowStepId : "";
    return requiresAuthoredReviewVerdict(stepId, row) && row.status === "passed";
  });
}

/*
FNXC:VanishedTaskDetection 2026-09-24-00:12:
The hint exists because "row missing, branch unmerged" still leaves the operator to work out whether
this is salvage worth chasing. An approved gate plus unmerged commits means the review already
happened and only delivery was lost, so the hint says salvage-or-resurrect rather than re-plan; a
lost branch moves recovery to the disk mirror and names the remaining clock (the reflog).
*/
function buildSalvageHint(input: {
  reason: VanishedTaskDirReason;
  gateApproved: boolean;
  unmergedCommitCount: number | null;
  mirrorColumn: string | null;
}): string {
  const column = input.mirrorColumn ?? "its last known column";
  const count = input.unmergedCommitCount;
  const commitWord = count === 1 ? "commit" : "commits";

  switch (input.reason) {
    case "row-missing-branch-unmerged":
      return input.gateApproved
        ? `A review gate had already APPROVED and the card sat in ${column}; ${count} unmerged ${commitWord} exist on no other ref. Salvage the commits below or resurrect the id with deleteTask(id, { allowResurrection: true }) before re-running merge — do not re-plan the work from scratch.`
        : `${count} unmerged ${commitWord} exist on no other ref and no approving verdict was recorded. Salvage the commits below, then re-create the card if the work is still wanted.`;
    case "row-missing-branch-missing":
      return "The branch is gone as well as the row. Recover from the disk mirror at .fusion/tasks/<ID>/task.json and any surviving worktree before the reflog expires.";
    case "row-tombstoned-branch-unmerged":
      return `The row is a soft-delete tombstone, so its id stays reserved and no board read can resolve it, while ${count} unmerged ${commitWord} remain on the branch.${input.gateApproved ? " An approved gate had already passed." : ""} Resurrect the id with deleteTask(id, { allowResurrection: true }) or salvage the commits below before any purge path hard-deletes the tombstone.`;
    case "row-tombstoned-branch-missing":
      return "The row is a soft-delete tombstone and its branch is already gone. Only the disk mirror survives; restore it from .fusion/tasks/<ID>/task.json if the work was not intentionally abandoned.";
    case "row-tombstoned-branch-unprobed":
      return "The row is a soft-delete tombstone, so a recorded delete accounts for it, but its branch could not be resolved, so unmerged work cannot be ruled out. Check the disk mirror at .fusion/tasks/<ID>/task.json (and the reflog) before any purge path hard-deletes the tombstone.";
    case "state-unresolved":
    default:
      return "Branch state could not be probed, so unmerged work cannot be ruled out. Run the command below by hand before any cleanup touches this id.";
  }
}

/**
 * Classify one task directory against row + branch evidence.
 *
 * Returns `null` when there is nothing to report: the row is live (the card is simply on a lane the
 * current query did not show), or the id belongs to the archive — normal archived history whose
 * branch and mirror survive by design.
 */
export function classifyVanishedTaskDir(input: VanishedTaskDirInput): VanishedTaskFinding | null {
  const row = input.row;
  if (row?.liveRowExists) return null;
  if (row?.inArchive) return null;

  const branchRef = taskBranchRefFor(input.taskId);
  const gateApproved = hasApprovedReviewGate(input.mirror?.workflowStepResults);
  const mirrorColumn = input.mirror?.column ?? null;
  const unmerged = input.unmergedCommitCount;
  const branchHasWork = typeof unmerged === "number" && unmerged > 0;

  /*
  FNXC:VanishedWorkTombstoneTaxonomy 2026-10-15-21:50 (RUFU-690):
  The un-probeable test used to come first, which made an un-probeable branch shadow everything the
  row evidence already knew: a soft-deleted card whose `fusion/<id>` branch had been cleaned up
  reported `state-unresolved` — the same label a card unknown to every table gets — even though
  `row.tombstoned` was true and the taxonomy already had tombstone-specific reasons. Measured in
  production: 891 `state-unresolved` rows over 229 cards in three hours, of which 211 exist in
  `project.tasks` as a soft-delete tombstone, against 11 cards that genuinely still hold unmerged
  commits and 18 that have no row at all. Soft deletion stamps the `archived` sentinel together with
  `deletedAt` by design (FNXC:TaskArchiveRemoval 2026-09-04-18:25), so that shape is simply "deleted",
  and it is the shape this sweep sees most. Ordering the ladder by what is known — tombstone first,
  then branch state — keeps the unknown visible for the rows nobody accounts for and stops borrowing the
  most alarming label for the ones everybody does.
  */
  let reason: VanishedTaskDirReason;
  if (row?.tombstoned) {
    reason = unmerged === null
      ? "row-tombstoned-branch-unprobed"
      : branchHasWork
        ? "row-tombstoned-branch-unmerged"
        : "row-tombstoned-branch-missing";
  } else if (unmerged === null) {
    reason = "state-unresolved";
  } else {
    reason = branchHasWork ? "row-missing-branch-unmerged" : "row-missing-branch-missing";
  }

  return {
    taskId: input.taskId,
    reason,
    branchRef,
    unmergedCommitCount: unmerged,
    gateApproved,
    mirrorColumn,
    salvage: {
      branchRef,
      salvageTarget: branchRef,
      salvageCommand: `git log main..${branchRef} --oneline`,
      hint: buildSalvageHint({ reason, gateApproved, unmergedCommitCount: unmerged, mirrorColumn }),
    },
  };
}

/*
FNXC:VanishedWorkNoticeGating 2026-10-15-21:50 (RUFU-690):
Which findings justify waking an operator. The sweep is report-only by design, but its notice is the
surface the operator actually reads, and it was firing ~700 times a day (15,101 system messages since
2026-09-24, latest measured 2026-10-15T19:02Z) for cards that a recorded delete already accounts for:
`row-tombstoned-branch-missing` and `row-tombstoned-branch-unprobed` describe a soft-deleted card whose
branch is gone or unresolvable, so there is nothing on a branch to lose and the disappearance is not
silent — the delete is audited, the id stays reserved, and `deleteTask(id, { allowResurrection: true })`
undoes it. Alarm is kept for exactly two situations: unmerged commits are PROVEN to exist on the task
branch, or no row exists anywhere, which is the RUFU-225 shape this event was written for. The run-audit
row is emitted for every finding either way, so the suppressed classes remain queryable and countable —
the gate changes who is paged, never what is recorded.
*/
export function vanishedFindingRequiresOperatorNotice(reason: VanishedTaskDirReason): boolean {
  return reason !== "row-tombstoned-branch-missing" && reason !== "row-tombstoned-branch-unprobed";
}

/** Operator-facing notice title for a finding (mailbox subject line). */export function buildVanishedTaskNoticeTitle(finding: VanishedTaskFinding): string {
  const work = finding.unmergedCommitCount === null
    ? "branch state unknown"
    : `${finding.unmergedCommitCount} unmerged ${finding.unmergedCommitCount === 1 ? "commit" : "commits"}`;
  return `Vanished task ${finding.taskId}: off every board read with ${work}`;
}

/** Build the operator-facing mailbox body for a finding. */
export function buildVanishedTaskNotice(finding: VanishedTaskFinding): string {
  const branchState = finding.unmergedCommitCount === null
    ? "unprobed"
    : `${finding.unmergedCommitCount} commit(s) not on main`;
  return [
    `**${finding.taskId}** exists on disk but resolves on no board read.`,
    "",
    `- Reason: \`${finding.reason}\``,
    `- Branch: \`${finding.branchRef}\` (${branchState})`,
    `- Approved gate already recorded: ${finding.gateApproved ? "yes" : "no"}`,
    `- Last known column on disk: ${finding.mirrorColumn ?? "unknown"}`,
    "",
    "A board query cannot return a row that is not there, so this notice is the only signal that this card ever existed.",
    "",
    "Salvage:",
    "```",
    finding.salvage.salvageCommand,
    "```",
    "",
    finding.salvage.hint,
  ].join("\n");
}
