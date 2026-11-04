/*
FNXC:PostMergeEvidenceContract 2026-10-08-04:14 (RUFU-319):
`getRequiredPostMergeEvidenceDecision` was origin's gate for this block (`outcome !== "finalizable"`), and the
`origin-sync 2026-10-05` merge (9ecab8cae6) kept the import while taking the fork's rewrite of the body, which
answers the same three questions through the contract-aware seam: the blocker sentence from
`getRequiredPostMergeEvidenceBlocker`, the deferral fact from the structured
`getPostMergeEvidenceGateStatuses(...).state === "missing"` instead of origin's `outcome === "resumable"`, and
the revisit schedule because `resumeMissingPostMergeGate` tests `isPostMergeGateRecoveryDue` INTERNALLY
(post-merge-gate-reseed.ts, FNXC:PostMergeRecovery 2026-10-05-09:31) — so origin's pre-check here was redundant,
not missing. The import was therefore dead code that failed `pnpm lint`; every origin guarantee it carried is
still asserted by `confirmed-merge-must-finalize.test.ts` (`deferredPostMergeEvidence`, and
`resumedPostMergeEvidence` firing on the first poll only). Do not read this deletion as removing the hold.
*/
import {
  getPostMergeFinalizeBlocker,
  getRequiredPostMergeEvidenceBlocker,
  planConfirmedMergeChecklistReconciliation,
  resolveWorkflowIrForTask,
  resolveCompleteColumn,
  resolveMergeOrchestrationColumn,
  columnHasFlag,
  clearMergeConfirmedTransientStatus,
  type MergeResult,
  type Task,
  type TaskStore,
  getPostMergeEvidenceGateStatuses,
 } from "@fusion/core";
import {
  isTerminalPostMergeReseedRefusal,
  type PostMergeGateReseedReason,
} from "./post-merge-gate-reseed.js";
import { resolvePostMergeEvidenceContract } from "./post-merge-evidence-contract.js";
/*
FNXC:PostMergeProducerSurface 2026-11-02-18:16 (RUFU-450):
The observation is resolved once per finalize pass beside the contract and handed to every gate read, so the
blocker, the deferral fact, the fenced re-read, and the re-seed seam all answer from one measurement. The
episode seam beside it is what turns this lane's unsatisfiable refusal into a bounded record instead of a
restatement at the poll rate.
*/
import { resolvePostMergeProducerSurface } from "./post-merge-producer-surface.js";
import {
  POST_MERGE_EVIDENCE_REFUSAL_METADATA_KEY,
  POST_MERGE_EVIDENCE_REFUSAL_REFRESH_FLOOR_MS,
  decidePostMergeEvidenceRefusal,
  isPostMergeProducerUnreachable,
  readPostMergeEvidenceRefusalEpisode,
  type PostMergeEvidenceRefusalEpisode,
} from "@fusion/core";
import { deliverMailboxMessageOnce } from "../notification/mailbox-delivery.js";
import { emitBoundedRunAudit } from "../util/emit-bounded-run-audit.js";
import { createRunAuditor, generateSyntheticRunId, type DatabaseMutationType, type RunAuditor } from "../util/run-audit.js";
import { cleanupLandedTaskWorktree } from "./post-landing-worktree-cleanup.js";
import { DASHBOARD_USER_ID, type MessageStore } from "@fusion/core";
import type { MergeWriteFence } from "./merge-write-fence.js";
/*
FNXC:ZeroCommitDeliveryProof 2026-09-26-09:40 (RUFU-274):
This module is the shared finalize primitive every merge lane ends in, so it is the last place a
`mergeConfirmed` / no-op claim can be tested against git before a card becomes `done`. `hasDurableMergeProof`
below proves that a CLAIM is durable; it cannot prove the claim is TRUE — RUFU-262's card reached done with
a confirmed no-op claim while its deliverable sat uncommitted in the worktree. The landing-proof door is
therefore asked separately, and before any cleanup, because a cleanup would destroy the evidence it reads.
*/
import { enforceZeroCommitLandingProof } from "./zero-commit-finalization-guard.js";
import { resumeMissingPostMergeGate } from "./post-merge-gate-reseed.js";
import { isBoundedFinalizationRefusal, shouldRecordFinalizationRefusal } from "./finalization-refusal-notice.js";

/*
FNXC:WorkflowMergeFinalization 2026-07-19-07:20 (U7 / R2/R3/KTD-1):
Finalization moves a confirmed-merged card to the workflow's COMPLETE-trait column
(not the literal "done"), and treats the merge-orchestration column (not literal
"in-review") as the normal pre-complete review column. builtin:coding resolves to
`done` / `in-review` so the default pipeline is byte-identical; a custom workflow
(the benchmark) lands in its own `Done` / `Merging` columns. Resolution failure
falls back to the legacy literals so a bad IR never strands a proven-merged task.
*/
async function resolveFinalizationColumns(
  store: TaskStore,
  taskId: string,
): Promise<{ completeColumn: string; mergeColumn: string; isCompleteColumn: (columnId: string) => boolean }> {
  try {
    const ir = await resolveWorkflowIrForTask(store, taskId);
    return {
      completeColumn: resolveCompleteColumn(ir) ?? "done",
      mergeColumn: resolveMergeOrchestrationColumn(ir) ?? "in-review",
      isCompleteColumn: (columnId: string) => columnHasFlag(ir, columnId, "complete"),
    };
  } catch {
    /*
    FNXC:WorkflowResolvedColumns 2026-07-31-23:51 (DELIBERATE-LITERAL — the FAIL-SOFT arm of an
    already-converted resolver): the resolved path is the `try` above. This block runs only when the
    workflow IR cannot be read at all, and its whole job is to answer with the built-in vocabulary so
    finalization keeps working rather than throwing. Resolving here is impossible by construction —
    the resolver is what just failed — so this is not pending conversion work and is marked instead of
    being left to re-offer itself as available on every census.
    */
    return {
      completeColumn: "done",
      mergeColumn: "in-review",
      /* DELIBERATE-LITERAL — the degraded fallback arm; the live arm above calls `columnHasFlag`.
         Reached only when IR resolution throws, where the legacy id is the only answer left. */
      isCompleteColumn: (columnId: string) => columnId === "done",
    };
  }
}

/*
FNXC:WorkflowMergeFinalization 2026-07-19-09:40 (R2/R7b):
The transition-race classifier must match the workflow's resolved COMPLETE column,
not the literal "done". moveTask targets the resolved completeColumn, so a race
error for a custom complete column (e.g. the benchmark's "shipped") says
"→ 'shipped'"; hardcoding "→ 'done'" skipped the already-done recovery branch and
rethrew, stranding a proven-merged task. Default stays "done" for builtin:coding
and legacy fallbacks.
*/
export function isInvalidDoneTransitionError(error: unknown, targetColumn = "done"): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("Invalid transition:") && message.includes(`→ '${targetColumn}'`);
}

export interface AutoMergeFinalizationResult {
  outcome: "done" | "already-done" | "blocked" | "missing";
  task: Task | null;
  previousColumn: string | null;
  reason?: string;
  /** True only for the graph-owned post-merge gate that must run before retrying finalization. */
  deferredPostMergeEvidence?: boolean;
  /*
  FNXC:MergePublishBeforeFinalize 2026-10-10-00:20 (RUFU-346):
  Names WHY the pass is blocked. `outcome: "blocked"` also covers a blocking task status, a column the
  lane may not write, and a failed landing-proof door, and those blockers do NOT mean the landed work is
  ready for the remote. The publish-before-blocked-finalization owner therefore needs the cause, not just
  the refusal: this flag is set only by the required-post-merge-evidence blocker, which is the one blocker
  that coexists with a durable landing. `deferredPostMergeEvidence` stays the resumability axis (can the
  graph still produce the gate?), so the two booleans answer different questions and are not redundant.
  */
  /** True when the block was raised by required post-merge evidence, i.e. the landing itself is durable. */
  postMergeEvidenceBlocked?: boolean;
  /** True when this invocation installed the missing graph-owned post-merge continuation. */
  resumedPostMergeEvidence?: boolean;
}

export interface FinalizeProvenAutoMergeTaskOptions {
  store: TaskStore;
  taskId: string;
  result?: MergeResult;
  rootDir?: string;
  audit?: RunAuditor;
  auditAgentId?: string;
  auditPhase?: string;
  source: "direct-ai-merge" | "merge-confirmed-fast-path" | "self-healing" | "workflow-graph-merge-finalize";
  log?: (message: string) => void | Promise<void>;
  fence?: MergeWriteFence;
  /*
  FNXC:UnrunPostMergeGateRecovery 2026-09-28-07:34 (RUFU-370):
  Optional by design. The mailbox lives on `MessageStore`, which `TaskStore` does not expose, so a finalizer
  only hands off through the mailbox where the caller already holds one (self-healing, project-engine).
  Every other caller still gets the durable audit row, and `deliverMailboxMessageOnce` reports
  `unavailable` rather than failing finalization when no store is wired.
  */
  messageStore?: Pick<MessageStore, "sendMessageOnce"> | null;
}

export type WorkflowDoneMergeProofVerdict =
  | { ok: true }
  | { ok: false; reason: string; metadata?: Record<string, unknown> };

function mergeProofLandedFiles(task: Task, result?: MergeResult): string[] {
  const files = result?.landedFiles ?? task.mergeDetails?.landedFiles ?? [];
  return Array.from(new Set(files.map((file) => file.trim()).filter(Boolean)));
}

function hasIncompleteWorkflowSteps(task: Task): boolean {
  return (task.steps ?? []).some((step) => step.status !== "done" && step.status !== "skipped");
}

export async function validateWorkflowDoneMergeProof(
  task: Task,
  options: {
    result?: MergeResult;
    checkWorkflowSteps?: boolean;
    /*
    FNXC:WorkflowResolvedColumns 2026-07-31-23:20:
    The RESOLVED complete test, supplied by the caller. Omitted → the `done` literal, i.e. today's
    behaviour, which is the same default-to-legacy contract the lane-parameter vocabulary uses
    elsewhere. `resolveFinalizationColumns` in this file already builds exactly this predicate for
    its own guard; the two callers below now hand it down instead of re-asking with an id.
    */
    isCompleteColumn?: (columnId: string) => boolean;
  } = {},
): Promise<WorkflowDoneMergeProofVerdict> {
  const hasProof = hasDurableMergeProof(task, options.result);
  /*
  FNXC:WorkflowResolvedColumns 2026-07-31-23:25 (the deferral is now paid — see the note above):
  This literal selects which REASON STRING is reported, not which branch runs. Both arms return
  `{ ok: false }`, so on a renamed board a card sitting in the complete lane was refused with the
  generic `missing-merge-confirmation` instead of the specific `done-without-merge-confirmation`.

  The earlier note recorded this as "REAL but DIAGNOSTIC-ONLY" and declined it on the grounds that
  widening a signature to improve an error string is a poor trade. That undersold the consequence:
  this reason is not a log line. It is asserted as run-audit metadata alongside `previousColumn`
  (`merger-merge-lifecycle.test.ts`), so the audit trail — the record an operator reads to find out
  why a merge was refused — carried the wrong classification for every renamed board.

  The trade is also cheaper than it looked. This function is ALREADY async and ALREADY takes an
  options bag, and `resolveFinalizationColumns` two functions up ALREADY builds this exact predicate
  for its own guard. Nothing new is resolved; the answer that existed is handed down instead of
  being re-asked with an id — which is the half-conversion shape this program keeps finding, here
  within one file.
  */
  /* DELIBERATE-LITERAL: the fallback arm of the conversion described directly above — reached only
     when a caller passes no resolved predicate. The resolved path is `options.isCompleteColumn`. */
  const isCompleteLane = options.isCompleteColumn ? options.isCompleteColumn(task.column) : task.column === "done";
  if (!hasProof) return { ok: false, reason: isCompleteLane ? "done-without-merge-confirmation" : "missing-merge-confirmation" };
  if (options.checkWorkflowSteps !== false && hasIncompleteWorkflowSteps(task)) {
    return { ok: false, reason: "incomplete-workflow-steps" };
  }

  const noOp = options.result?.noOp === true || task.mergeDetails?.noOpMerge === true;
  const landedFiles = mergeProofLandedFiles(task, options.result);
  if (noOp && landedFiles.length > 0) {
    return { ok: false, reason: "noop-merge-with-landed-files", metadata: { landedFiles: landedFiles.length } };
  }
  /*
   * FNXC:AutoMergeFinalization 2026-07-01-10:22:
   * Finalization cares whether the task patch landed on the integration branch, not whether the task branch history is clean after squash merges. Historical task branches can retain patch-equivalent foreign commits whose SHAs are not ancestors of main; once durable merge proof exists, branch residue must not strand the task in review.
   */

  return { ok: true };
}

function buildMismatchMetadata(task: Task, reason: string): Record<string, unknown> {
  return {
    taskId: task.id,
    previousColumn: task.column,
    targetColumn: "done",
    commitSha: task.mergeDetails?.commitSha ?? null,
    status: task.status ?? null,
    blockedBy: task.blockedBy ?? null,
    overlapBlockedBy: task.overlapBlockedBy ?? null,
    reason,
  };
}

/**
 * FNXC:UnrunPostMergeGateRecovery 2026-09-28-07:34 (RUFU-370):
 * One operator-visible notice per (task, gate, refusal) per cooldown window. The key carries a time
 * bucket so repeats of the same refusal collapse to one mailbox row while a genuinely new refusal (or a
 * refusal still unaddressed after the window) announces again — the same discipline as RUFU-283's
 * `system:vanished-work:*` notice, chosen because this class has no wedge row to hang dedupe off. The
 * write goes through `deliverMailboxMessageOnce`, so a missing, throwing, or stalled mailbox store cannot
 * delay or change finalization: it returns `unavailable` and the deferral stands on its own.
 */
const POST_MERGE_GATE_NOTICE_COOLDOWN_MS = 6 * 60 * 60 * 1000;

/**
 * The blocker sentence plus the machine-readable terminal marker. The suffix is what lets the merge-retry
 * router and an operator tell "deferred, try again" from "this seam can never produce the evidence" —
 * RUFU-370's whole point is that the two used to be one indistinguishable warn line.
 */
export function unreachablePostMergeGateReason(
  evidenceBlocker: string,
  refusal: PostMergeGateReseedReason,
): string {
  return `${evidenceBlocker} [post-merge gate unreachable: ${refusal}]`;
}

export function unreachablePostMergeGateNoticeKey(
  taskId: string,
  gateId: string | undefined,
  refusal: PostMergeGateReseedReason,
  now: number,
): string {
  const bucket = Math.floor(now / POST_MERGE_GATE_NOTICE_COOLDOWN_MS);
  return `system:unrun-post-merge-gate:${taskId}:${gateId ?? "unknown"}:${refusal}:${bucket}`;
}

export async function notifyUnreachablePostMergeGate(args: {
  store: TaskStore;
  messageStore?: Pick<MessageStore, "sendMessageOnce"> | null;
  taskId: string;
  gateId?: string;
  refusal: PostMergeGateReseedReason;
  evidenceBlocker: string;
  /** Injectable clock so the cooldown bucket is testable without waiting for a window to roll. */
  now?: number;
  /** Bound on the optional mailbox write; forwarded to `deliverMailboxMessageOnce`. */
  timeoutMs?: number;
}): Promise<"delivered" | "unavailable"> {
  const now = args.now ?? Date.now();
  const sentence = `Auto-merge cannot finish ${args.taskId}: ${args.evidenceBlocker}, and the post-merge gate `
    + `cannot be re-seeded (${args.refusal}). The landed work is preserved — this card needs a human decision, `
    + `either an operator bypass of the gate or a workflow whose post-merge node can run.`;
  const notice = await deliverMailboxMessageOnce(
    args.messageStore ?? undefined,
    {
      fromId: "system",
      fromType: "system",
      toId: DASHBOARD_USER_ID,
      toType: "user",
      type: "system",
      content: sentence,
      metadata: {
        kind: "unreachable-post-merge-gate",
        taskId: args.taskId,
        workflowStepId: args.gateId ?? null,
        refusal: args.refusal,
      },
    },
    unreachablePostMergeGateNoticeKey(args.taskId, args.gateId, args.refusal, now),
    args.timeoutMs,
  );
  // Best-effort telemetry must never become a finalization dependency (FN-9175).
  await emitBoundedRunAudit(args.store, {
    taskId: args.taskId,
    agentId: "merger",
    runId: generateSyntheticRunId("auto-merge-finalize", args.taskId),
    domain: "database",
    mutationType: "task:auto-merge-finalize-post-merge-gate-unreachable" as DatabaseMutationType,
    target: args.taskId,
    metadata: {
      taskId: args.taskId,
      workflowStepId: args.gateId ?? null,
      refusal: args.refusal,
      notice,
    },
  });
  return notice;
}

/*
FNXC:PostMergeEvidenceRefusalEpisode 2026-11-02-18:16 (RUFU-450):
The card's own History is the third surface of a bounded refusal — episode, audit row, History line — and it
goes through the durable once-seam keyed by the refusal SIGNATURE, the shape RUFU-382 settled for the planning
mirror: one changed condition announces once, an unchanged wait re-announces at most once per window. A store
without `logEntryOnce` keeps the shipped `logEntry` fallback inside the same path, and every failure is
swallowed: an unwriteable History line must never become a finalization dependency.

The sentence names the gate, the evidence state, the disposition this pass applied, and what the mailbox
actually did. An arm that sends no message says so rather than implying a hand-off — a History line claiming
a notice nobody sent is the same defect as a refusal nobody was told about.
*/
type PostMergeEvidenceNoticeOutcome = "not-sent" | "delivered" | "unavailable";

async function announcePostMergeEvidenceRefusal(
  store: TaskStore,
  taskId: string,
  episode: PostMergeEvidenceRefusalEpisode,
  evidenceBlocker: string,
  notification: PostMergeEvidenceNoticeOutcome,
): Promise<void> {
  const stateWord = episode.state === "not-approved" ? "was not approved" : "has not reported";
  const action = `Post-merge evidence refused for ${taskId}: gate '${episode.gateId ?? "?"}' ${stateWord}; `
    + `re-seed ${episode.reseedReason ? `refused (${episode.reseedReason})` : "was accepted"}; `
    + `operator notification ${describePostMergeEvidenceNotice(notification)}. ${evidenceBlocker}`;
  await logPostMergeEvidenceOnce(store, taskId, action, `post-merge-evidence-refusal:${episode.signature}`);
}

/** What the mailbox actually did, in words a card reader can act on. */
function describePostMergeEvidenceNotice(notification: PostMergeEvidenceNoticeOutcome): string {
  if (notification === "delivered") return "was delivered to the operator mailbox";
  if (notification === "unavailable") return "could not be delivered (no mailbox store wired)";
  return "was not sent (this refusal is still retryable)";
}

/** `logEntryOnce` with the shipped `logEntry` fallback; failures degrade to a missing line, never a throw. */
/*
FNXC:PostMergeEvidenceRefusalEpisode 2026-11-02-18:16 (RUFU-450):
The fallback exists for a store without the once-seam, and such a store cannot dedupe — so the fallback keeps
its own process-local bound, the same shape `recordFinalizationAudit` already uses in this file. It is bounded
because it is a fallback, not instead of the durable episode: across a restart the durable episode resumes the
bound, which is precisely what the in-process gate alone could not do.
*/
const historyFallbackBound = new Map<string, number>();

async function logPostMergeEvidenceOnce(
  store: TaskStore,
  taskId: string,
  action: string,
  dedupeKey: string,
): Promise<void> {
  const seam = store as unknown as {
    logEntryOnce?: (id: string, input: { action: string; outcome?: string; dedupeKey: string; windowMs: number }) => Promise<boolean>;
    logEntry?: (id: string, action: string, outcome?: string) => Promise<unknown>;
  };
  try {
    if (typeof seam.logEntryOnce === "function") {
      await seam.logEntryOnce(taskId, {
        action,
        dedupeKey,
        windowMs: POST_MERGE_EVIDENCE_REFUSAL_REFRESH_FLOOR_MS,
      });
      return;
    }
    const lastAt = historyFallbackBound.get(dedupeKey) ?? 0;
    if (Date.now() - lastAt < POST_MERGE_EVIDENCE_REFUSAL_REFRESH_FLOOR_MS) return;
    historyFallbackBound.set(dedupeKey, Date.now());
    await seam.logEntry?.(taskId, action);
  } catch {
    // Degraded History only — the durable episode and its audit row are already committed.
  }
}

async function recordFinalizationAudit(args: {
  store: TaskStore;
  audit?: RunAuditor;
  task: Task;
  type: DatabaseMutationType;
  reason: string;
  auditAgentId?: string;
  auditPhase?: string;
}): Promise<void> {
  /*
  FNXC:FinalizationRefusalBounded 2026-10-07-09:10 (RUFU-431):
  A refusal is a state, not an event. The auto-merge sweep re-attempts a blocked finalization every
  pass, so without this gate the SAME (task, refusal) was re-recorded forever — measured 5,356 rows
  for 7 cards in one day, and 61 rows from one card in 30 minutes. Terminal outcomes (`…-reconciled`,
  successful finalization) are not in the bounded set and always write their row.

  FNXC:FinalizationRefusalBounded 2026-10-07-09:20 (RUFU-431):
  The refusal's IDENTITY is the discriminating metadata the row itself carries — which lane the card
  was refused in, its status, its blockers, and why. Keying on the reason sentence alone collapsed two
  genuinely different refusals of one card (refused in the default `done` lane vs refused in a board's
  renamed complete lane, identical sentence) into one row, caught by
  `merge-proof-reason-renamed-complete-lane.test.ts`. A card that moved lanes, changed status, or
  gained a blocker is refusing for a NEW reason and must be recorded again — bounding a restatement
  may never mask a state change.
  */
  if (isBoundedFinalizationRefusal(args.type)
    && !shouldRecordFinalizationRefusal(
      args.task.id,
      args.type,
      JSON.stringify(buildMismatchMetadata(args.task, args.reason)),
    )) {
    return;
  }
  try {
    const auditor = args.audit ?? createRunAuditor(args.store, {
      runId: generateSyntheticRunId("auto-merge-finalize", args.task.id),
      agentId: args.auditAgentId ?? "merger",
      taskId: args.task.id,
      taskLineageId: args.task.lineageId,
      phase: args.auditPhase ?? "auto-merge-finalize",
    });
    await auditor.database({
      type: args.type,
      target: args.task.id,
      metadata: buildMismatchMetadata(args.task, args.reason),
    });
  } catch {
    // Best effort: audit persistence must never strand a proven landed task.
  }
}

function buildFinalizationMergeDetails(task: Task, result?: MergeResult): NonNullable<Task["mergeDetails"]> {
  const mergedAt = task.mergeDetails?.mergedAt ?? new Date().toISOString();
  /*
   * FNXC:WorkflowMerge 2026-06-29-09:04:
   * Workflow graph merge finalization must never promote loose `merged:true` or `noOp:true` results into durable merge proof. A task can reach `done` only when the merger records `mergeConfirmed:true`; otherwise replay/recovery must block so the branch is merged instead of bypassed.
   */
  const mergeConfirmed =
    result?.mergeConfirmed === true || task.mergeDetails?.mergeConfirmed === true;
  return {
    ...(task.mergeDetails ?? {}),
    ...(result?.commitSha ? { commitSha: result.commitSha } : {}),
    ...(result?.rebaseBaseSha ? { rebaseBaseSha: result.rebaseBaseSha } : {}),
    ...(result?.landedFiles ? { landedFiles: result.landedFiles } : {}),
    ...(typeof result?.filesChanged === "number" ? { filesChanged: result.filesChanged } : {}),
    ...(typeof result?.insertions === "number" ? { insertions: result.insertions } : {}),
    ...(typeof result?.deletions === "number" ? { deletions: result.deletions } : {}),
    ...(result?.mergeCommitMessage ? { mergeCommitMessage: result.mergeCommitMessage } : {}),
    mergedAt,
    mergeConfirmed,
    ...(result?.noOp && mergeConfirmed ? { noOpMerge: true, noOpReason: result.reason } : {}),
  };
}

function hasDurableMergeProof(task: Task, result?: MergeResult): boolean {
  return task.mergeDetails?.mergeConfirmed === true || result?.mergeConfirmed === true;
}

/**
 * FNXC:AutoMergeLifecycle 2026-06-22-19:28:
 * Proven auto-merge completion must refresh the authoritative row before moving to done because the merge CAS and queue retry paths can leave a landed task in todo with stale queued/overlap state. Use TaskStore recovery rehome for those column mismatches so completion remains idempotent without direct database surgery.
 */
export async function finalizeProvenAutoMergeTask({
  store,
  taskId,
  result,
  rootDir,
  audit,
  auditAgentId,
  auditPhase,
  source,
  log,
  fence,
  messageStore,
}: FinalizeProvenAutoMergeTaskOptions): Promise<AutoMergeFinalizationResult> {
  const initialTask = await store.getTask(taskId).catch(() => null);
  if (!initialTask) {
    return { outcome: "missing", task: null, previousColumn: null, reason: "task-not-found" };
  }
  let latest: Task = initialTask;

  // U7: resolve the workflow's complete/merge columns once (byte-identical to
  // done/in-review for builtin:coding).
  const { completeColumn, mergeColumn, isCompleteColumn } = await resolveFinalizationColumns(store, taskId);

  /*
  FNXC:PostMergeRecovery 2026-09-30-04:56:
  A successful integration write is irreversible and its proof must become durable before an enabled
  post-merge gate can defer the terminal move. Previously the evidence check returned first, leaving
  merge confirmation only in the caller's in-memory MergeResult; a restart then saw no worktree and
  no proof, so self-healing could only surface and eventually pause the card as a deadlock. Persist
  only the merge evidence here—never completion or approval—so graph traversal can still produce the
  required gate result and restart recovery can distinguish landed work from an unmerged branch.
  */
  if (result?.mergeConfirmed === true && latest.mergeDetails?.mergeConfirmed !== true) {
    const persistProof = () => store.updateTaskAtomic(taskId, (current) => ({
      mergeDetails: buildFinalizationMergeDetails(current, result),
    }));
    const persisted = fence
      ? await fence.write("finalization", persistProof)
      : await persistProof();
    if (persisted) latest = persisted;
  }

  /*
  FNXC:PostMergeEvidenceContract 2026-09-30-22:29 (RUFU-430):
  Which evidence reporter this PROJECT has is a precondition to asking for a GitHub Actions delivery record
  at all. It is resolved once per finalize pass (cached per project root in the resolver, so no shellout
  enters the retry loop) and handed to every read of the gate below, so the blocker, the deferral fact, and
  the fenced re-read answer the same question. An unresolvable contract keeps today's demand unchanged.
  */
  const evidenceContract = await resolvePostMergeEvidenceContract(store, { auditHost: store });
  /*
  FNXC:PostMergeProducerSurface 2026-11-02-18:16 (RUFU-450):
  Resolved ONCE per pass, beside the contract, and handed to every read below — the same discipline RUFU-430
  states for the contract, for the same reason: a blocker, a deferral fact, and a fenced re-read that each
  ask their own question can disagree. An unresolvable observation keeps today's demand unchanged.
  */
  const producerSurface = await resolvePostMergeProducerSurface(store, latest);

  const evidenceBlocker = await getRequiredPostMergeEvidenceBlocker(store, latest, evidenceContract, producerSurface);
  if (evidenceBlocker) {
    /*
    FNXC:PostMergeEvidence 2026-09-30-09:57:
    Whether the active graph traversal can still produce the required post-merge gate result is a STRUCTURED
    fact (`state === "missing"`), not a property of the blocker sentence. The flag used to be derived by
    matching "has not reported" in prose, so any wording change upstream silently converted a claimable
    deferral into a fatal block at `merger-ai`'s `!deferredPostMergeEvidence` throw. FN-9422 makes the merge
    proof durable before the deferral, so every absent-gate deferral below is a deferral with proof, and a
    pending / non-approval stays fatal.
    */
    const postMergeIr = await resolveWorkflowIrForTask(store, latest.id).catch(() => null);
    /*
    FNXC:PostMergeProducerSurface 2026-11-02-18:16 (RUFU-450):
    The statuses are read ONCE and kept, rather than collapsed to a boolean at the call site: Half 1 needs
    the same `gateId`/`state` the deferral fact needs, and a second derivation of the same question is what
    this module's own history keeps calling a defect.
    */
    const postMergeGateStatuses = postMergeIr
      ? getPostMergeEvidenceGateStatuses(latest, postMergeIr, evidenceContract, producerSurface)
      : null;
    const deferredPostMergeEvidence = postMergeGateStatuses
      ? postMergeGateStatuses.some((status) => status.state === "missing") || undefined
      : evidenceBlocker.includes("has not reported") || undefined;
    /*
    FNXC:PostMergeRecovery 2026-10-01-09:01 (upstream FN-9442 adopted; RUFU-306 / RUFU-370 kept on top):
    Upstream hands an absent gate back to the graph through the idle continuation fence, and the fence write
    is the part our seam lacked: a resume that races the finalize fence is the race FN-9442 was written
    against. Two things are layered onto their call rather than kept as a second implementation. The prose
    trigger is replaced by the structured flag above, so a PENDING or non-approved result never seeds a
    second run over a result that already exists. And the refusal is classified: a refusal that can never
    produce evidence goes to the operator once instead of deferring forever (SANE-452 and STAS-288 were
    re-announced seconds apart indefinitely), while every other refusal keeps the transient-defer shape.
    Seeding is not a verdict — the blocker still stands and this path never completes a card itself.
    */
    // RUFU-319: hand the lane's fence to the seam. The seam defaults to a fresh, never-orphaned fence, so
    // the outer `fence.write` below only checks ownership on ENTRY — an abort that lands DURING the resume
    // (between the work-item read and the continuation insert) would otherwise still schedule a reviewer
    // run on a card this merge body no longer owns.
    const resume = () => resumeMissingPostMergeGate(store, latest, {
      source: "auto-merge",
      contract: evidenceContract,
      fence,
      producerSurface,
    });
    const reseed = (fence ? await fence.write("finalization", resume) : await resume())
      // A fenced write that was suppressed means this lane no longer owns the card: nothing was seeded.
      ?? { outcome: "not-seeded" as const, reason: "finalize-blocked" as const };
    // Hoisted above both refusal arms: the terminal arm names the owed gate in its History line and the
    // pending-evidence arm keys its episode by the same gate/state pair, so one read answers both.
    const owedGate = postMergeGateStatuses?.find((status) => status.state !== "not-applicable");
    if (reseed.outcome !== "seeded" && isTerminalPostMergeReseedRefusal(reseed.reason)) {
      const notice = await notifyUnreachablePostMergeGate({
        store,
        messageStore,
        taskId,
        gateId: reseed.workflowStepId,
        refusal: reseed.reason,
        evidenceBlocker,
      });
      await log?.(`Auto-merge finalization deferred for ${taskId}: ${evidenceBlocker}`
        + ` [post-merge gate reseed: ${reseed.reason}; operator handoff: ${notice}]`);
      /*
      FNXC:PostMergeEvidenceRefusalEpisode 2026-11-02-18:16 (RUFU-450, Step 5):
      This arm already tells the operator, but it told them on the mailbox while the CARD kept only a merged
      engine-log sentence. The card's own History now names this card by its own id — never a summary that
      lets one card's name stand for four separate observations — states the git/producer observation that
      produced the exemption decision, and repeats the notification outcome the mailbox actually returned.
      */
      await logPostMergeEvidenceOnce(
        store,
        taskId,
        `Post-merge evidence needs a human decision for ${taskId}: gate '${reseed.workflowStepId ?? owedGate?.gateId ?? "?"}'`
        + ` has not reported and cannot be re-seeded (${reseed.reason}); delivery surface read as `
        + `${producerSurface?.surface ?? "unreadable"}, landing `
        + `${producerSurface?.mergeConfirmed ? "confirmed" : "unconfirmed"}, producer `
        + `${producerSurface?.producerCanRun === false ? "cannot run" : producerSurface?.producerCanRun === true ? "can still run" : "not measured"}; `
        + `operator notification ${describePostMergeEvidenceNotice(notice)}. ${evidenceBlocker}`,
        `post-merge-evidence-refusal:${reseed.workflowStepId ?? "gate"}:terminal:${reseed.reason}:${notice}`,
      );
      return {
        outcome: "blocked",
        task: latest,
        previousColumn: latest.column,
        reason: unreachablePostMergeGateReason(evidenceBlocker, reseed.reason),
        deferredPostMergeEvidence,
        postMergeEvidenceBlocked: true,
      };
    }
    /*
    FNXC:PostMergeEvidenceRefusalEpisode 2026-11-02-18:16 (RUFU-450, Half 1):
    THIS is the arm VLLM-081 churned: a refusal the lane cannot satisfy, restated at the poll rate (5 audit
    rows inside the single minute 19:44), with the shipped in-process gate holding nothing across a restart.
    The refusal is now a durable episode keyed by which gate, which state, and which re-seed refusal, so an
    unchanged refusal records at most once per the shipped 15-minute floor while any real change — the gate
    finally reporting, a different refusal — records immediately. A failed episode write degrades to today's
    in-process-bounded record rather than silencing the refusal.
    */
    const refusalObservation = owedGate
      ? {
        gateId: owedGate.gateId,
        state: owedGate.state,
        reseedReason: reseed.outcome === "seeded" ? null : reseed.reason,
      }
      : undefined;
    const episodeDecision = refusalObservation
      ? decidePostMergeEvidenceRefusal(
        readPostMergeEvidenceRefusalEpisode(latest.sourceMetadata?.[POST_MERGE_EVIDENCE_REFUSAL_METADATA_KEY]),
        refusalObservation,
      )
      : undefined;
    /*
    A suppressed fenced write (`finalize-blocked`) means this merge body no longer owns the card, so this pass
    records an episode or a History line for a card it cannot describe — the audit row stays, bounded as today,
    because a withheld finalization is still worth counting. Ownership is the fence's fact, never a guess.
    */
    const recordsOwnership = reseed.reason !== "finalize-blocked";
    const recordedEpisode = recordsOwnership ? episodeDecision?.episode : undefined;
    if (!episodeDecision || episodeDecision.write) {
      if (recordedEpisode) {
        await store.updateTask(taskId, {
          sourceMetadataPatch: { [POST_MERGE_EVIDENCE_REFUSAL_METADATA_KEY]: recordedEpisode },
        }).catch(() => undefined);
      }
      await recordFinalizationAudit({
        store,
        audit,
        task: latest,
        type: "task:auto-merge-finalize-column-mismatch-no-action",
        reason: evidenceBlocker,
        auditAgentId,
        auditPhase,
      });
      if (recordedEpisode) {
        await announcePostMergeEvidenceRefusal(store, taskId, recordedEpisode, evidenceBlocker, "not-sent");
      }
    }
    await log?.(`Auto-merge finalization deferred for ${taskId}: ${evidenceBlocker}`
      + ` [post-merge gate reseed: ${reseed.outcome === "seeded" ? `seeded '${reseed.workflowStepId}'` : reseed.reason}]`);
    return {
      outcome: "blocked",
      task: latest,
      previousColumn: latest.column,
      reason: evidenceBlocker,
      deferredPostMergeEvidence,
      postMergeEvidenceBlocked: true,
      /*
      FNXC:PostMergeRecovery 2026-10-02-20:31 (upstream FN-9442 field kept on our seam):
      `resumedPostMergeEvidence` is upstream's signal that THIS pass claimed the missing post-merge gate, so
      the confirmed-merge recovery in `project-engine.ts` / `self-healing.ts` can tell a pass that advanced
      the card from a pass that only re-stated the blocker. Our seam answers in the reseed vocabulary it owns
      (`PostMergeGateReseedResult.outcome` is `seeded | not-seeded`), so `seeded` is the exact translation of
      upstream's `resumed`: a new idle continuation was installed. It must not be true when the reseed
      returned `not-seeded` for `active-continuation`, because `confirmed-merge-must-finalize.test.ts` asserts
      the flag fires on the FIRST poll only - repeated finalization polls must not look like progress.
      */
      resumedPostMergeEvidence: reseed.outcome === "seeded" || undefined,
    };
  }

  /*
  FNXC:PostMergeProducerSurface 2026-11-02-18:16 (RUFU-450, Step 5):
  An exemption that completes a card silently is an exemption nobody can audit after the fact. When the
  producer-surface observation is what released the card, the card's own History says which gate it released,
  on which git verdict, and that no notification was needed — naming THIS card by its own id, never a
  roll-up under one card's name for four separate observations. The IR read is gated on the observation being
  CONCLUSIVE, so the common path pays nothing for a sentence it will never write.
  */
  if (isPostMergeProducerUnreachable(producerSurface)) {
    const exemptIr = await resolveWorkflowIrForTask(store, latest.id).catch(() => null);
    const exempted = exemptIr
      ? getPostMergeEvidenceGateStatuses(latest, exemptIr, evidenceContract, producerSurface)
        .find((status) => status.state === "not-applicable" && status.notApplicableReason === "producer-unreachable")
      : undefined;
    if (exempted) {
      await logPostMergeEvidenceOnce(
        store,
        taskId,
        `Post-merge evidence was not required for ${taskId}: gate '${exempted.gateId}' has no report because the `
        + `delivery surface can no longer produce one (git surface ${producerSurface?.surface}, landing confirmed, `
        + `no producer left to dispatch); no operator notification was needed.`,
        `post-merge-evidence-refusal:${exempted.gateId}:producer-unreachable:${producerSurface?.surface}`,
      );
    }
  }

  const validationMergeDetails = buildFinalizationMergeDetails(latest, result);
  const cleanupLandedWorktree = async (task: Task, mergeDetails: NonNullable<Task["mergeDetails"]>): Promise<void> => {
    if (!rootDir) return;
    await cleanupLandedTaskWorktree({
      store,
      taskId,
      worktreePath: task.worktree,
      rootDir,
      landedSha: mergeDetails.commitSha ?? result?.commitSha,
      // RUFU-274 Step 5: the row is passed so cleanup can see a durable delivery-unproven hold.
      task,
      source,
      audit,
      log: async (message) => {
        if (fence) {
          await fence.write("log", () => store.logEntry(taskId, message).catch(() => undefined));
        } else {
          await store.logEntry(taskId, message).catch(() => undefined);
        }
        await log?.(message);
      },
      fence,
    });
  };
  /*
   * FNXC:WorkflowMerge 2026-06-29-10:35:
   * Workflow-owned completion requires current merge proof, not just a stale `mergeConfirmed` flag. A task cannot reach or remain accepted as `done` when workflow steps are still pending or a no-op claims landed files. Branch-only residue is ignored because squash landing validates the task patch, not branch-history cleanliness.
   */
  if (isCompleteColumn(latest.column)) {
    const proofVerdict = await validateWorkflowDoneMergeProof({ ...latest, mergeDetails: validationMergeDetails } as Task, { result, isCompleteColumn });
    if (!proofVerdict.ok) {
      await recordFinalizationAudit({
        store,
        audit,
        task: latest,
        type: "task:auto-merge-finalize-column-mismatch-no-action",
        reason: proofVerdict.reason,
        auditAgentId,
        auditPhase,
      });
      await log?.(`Auto-merge finalization blocked for ${taskId}: ${proofVerdict.reason}`);
      return { outcome: "blocked", task: latest, previousColumn: latest.column, reason: proofVerdict.reason };
    }
    /*
    FNXC:WorkflowMergeFinalization 2026-08-29-01:06:
    This is convergence, not the ordering gate: a task that reached complete before FN-251 still
    receives proof-gated cleanup when the finalizer sees its durable landing again. No root directory
    means there is no trustworthy cleanup boundary, so preserve the historical no-op finalization.
    */
    await cleanupLandedWorktree(latest, validationMergeDetails);
    const converged = await store.getTask(taskId).catch(() => latest);
    if (result) result.task = converged;
    return { outcome: "already-done", task: converged, previousColumn: latest.column };
  }

  const mergeDetails = validationMergeDetails;
  const hasProof = hasDurableMergeProof({ ...latest, mergeDetails } as Task, result);
  if (!hasProof) {
    const reason = "missing-merge-confirmation";
    await recordFinalizationAudit({
      store,
      audit,
      task: latest,
      type: "task:auto-merge-finalize-column-mismatch-no-action",
      reason,
      auditAgentId,
      auditPhase,
    });
    return { outcome: "blocked", task: latest, previousColumn: latest.column, reason };
  }

  /*
  FNXC:ZeroCommitDeliveryProof 2026-09-26-09:45 (RUFU-274):
  The delivery-proof door on the shared finalize primitive. It runs only when both facts needed to probe are
  on the row: a repository root, and the integration branch the landing claims to have reached. Without
  either there is nothing to corroborate against, and inventing a ref (or trusting a `mergeConfirmed` flag
  to substitute for a probe) is the failure mode this door exists to remove — so the historical behaviour
  stands for those cards. A `held` refusal has already written its durable hold, row sentence, and bounded
  audit row inside the guard; here the only job is to stop — before cleanup and before the complete-column
  move — and to report a deferral, the same non-burning `blocked` class `missing-merge-confirmation` uses.
  A `retry` is the opposite case: the probe could not see the content, which is not evidence that work is at
  risk, so finalizing proceeds on today's rules rather than wedging a card over an unreadable checkout. The
  guard's own deferred row records that abstention, and this lane adds no audit event of its own: the
  refusal's forensic record and its fixed reason codes belong to the one writer.
  */
  const landingProofBranch = mergeDetails.mergeTargetBranch;
  if (rootDir && landingProofBranch) {
    const landingProof = await enforceZeroCommitLandingProof({
      store,
      task: latest,
      repoDir: rootDir,
      integrationBranch: landingProofBranch,
      source: "finalize-proven-auto-merge",
      fence,
    });
    if (landingProof.disposition === "held") {
      const reason = landingProof.refusal;
      await log?.(`Auto-merge finalization refused for ${taskId}: ${reason}`);
      return { outcome: "blocked", task: latest, previousColumn: latest.column, reason };
    }
    if (landingProof.disposition === "retry") {
      await log?.(`Auto-merge finalization proceeding without a zero-commit delivery probe for ${taskId}: ${landingProof.reason}`);
    }
  }

  /*
  FNXC:ConfirmedMergeFinalization 2026-08-23-07:25:
  FN-180 forbids re-running the pre-merge checklist after durable merge proof.
  A concurrent review bounce can leave that checklist stale, so reconcile it
  before moving to complete; only an independent status may still defer.
  */
  const postMergeBlocker = getPostMergeFinalizeBlocker({
    status: clearMergeConfirmedTransientStatus(latest.status),
    error: undefined,
  });
  if (postMergeBlocker) {
    await recordFinalizationAudit({
      store,
      audit,
      task: latest,
      type: "task:auto-merge-finalize-column-mismatch-no-action",
      reason: postMergeBlocker,
      auditAgentId,
      auditPhase,
    });
    return { outcome: "blocked", task: latest, previousColumn: latest.column, reason: postMergeBlocker };
  }
  const proofVerdict = await validateWorkflowDoneMergeProof({ ...latest, mergeDetails } as Task, {
    result,
    checkWorkflowSteps: false,
    isCompleteColumn,
  });
  if (!proofVerdict.ok) {
    await recordFinalizationAudit({
      store,
      audit,
      task: latest,
      type: "task:auto-merge-finalize-column-mismatch-no-action",
      reason: proofVerdict.reason,
      auditAgentId,
      auditPhase,
    });
    await log?.(`Auto-merge finalization blocked for ${taskId}: ${proofVerdict.reason}`);
    return { outcome: "blocked", task: latest, previousColumn: latest.column, reason: proofVerdict.reason };
  }

  const shouldRecoveryRehome = latest.column !== mergeColumn;
  if (shouldRecoveryRehome) {
    await log?.(
      `Auto-merge finalization repairing ${taskId}: authoritative row is ${latest.column}; clearing stale lifecycle blockers and moving to ${completeColumn}`,
    );
  }

  /*
  FNXC:WorkflowMergeFinalization 2026-08-29-01:06:
  For a proven single-repository landing, resolve cleanup before the complete-column move. Preserved
  deliverable, unverifiable, and active-session outcomes are logged but never reclassify a durable
  landing as a merge failure, because blocking this transition would permanently wedge the card.
  */
  await cleanupLandedWorktree(latest, mergeDetails);

  try {
    fence?.assertOwned("finalization");
    /*
    FNXC:AutoMergeMoveAttribution 2026-08-29-07:37:
    Proven merge finalization advances review to the complete lane. Use a dedicated neutral
    provenance instead of workflow-graph, workflow-remediation, or plan-approval: those literals
    carry in-review-entry and reopen semantics. The value is also forwarded to plugin move policies.
    */
    /*
    FNXC:PostMergeEvidenceFence 2026-09-23-08:10:
    Post-merge approval is mutable graph state, so the optimistic evidence read above cannot
    authorize a later terminal move. Re-read it under moveTaskIf's task-row fence: a superseded
    result refuses this move instead of allowing a done card without durable evidence.
    */
    let finalizationBlocker: string | undefined;
    const move = await store.moveTaskIf(taskId, completeColumn, async (live) => {
      const liveMergeDetails = buildFinalizationMergeDetails(live, result);
      if (!hasDurableMergeProof({ ...live, mergeDetails: liveMergeDetails } as Task, result)) {
        finalizationBlocker = "missing-merge-confirmation";
        return false;
      }
      finalizationBlocker = await getRequiredPostMergeEvidenceBlocker(store, live, evidenceContract, producerSurface);
      if (finalizationBlocker) return false;
      finalizationBlocker = getPostMergeFinalizeBlocker({
        status: clearMergeConfirmedTransientStatus(live.status),
        error: undefined,
      });
      if (finalizationBlocker) return false;
      const liveProofVerdict = await validateWorkflowDoneMergeProof({ ...live, mergeDetails: liveMergeDetails } as Task, {
        result,
        checkWorkflowSteps: false,
        isCompleteColumn,
      });
      if (!liveProofVerdict.ok) {
        finalizationBlocker = liveProofVerdict.reason;
        return false;
      }
      return true;
    }, shouldRecoveryRehome
      ? { moveSource: "engine", workflowMoveSource: "auto-merge-finalization", recoveryRehome: true, preserveProgress: true }
      : { moveSource: "engine", workflowMoveSource: "auto-merge-finalization", preserveProgress: true });
    if (!move.moved) {
      const currentBlocker = finalizationBlocker
        ?? await getRequiredPostMergeEvidenceBlocker(store, move.task, evidenceContract, producerSurface)
        ?? "finalization-fence-refused";
      await recordFinalizationAudit({
        store,
        audit,
        task: move.task,
        type: "task:auto-merge-finalize-column-mismatch-no-action",
        reason: currentBlocker,
        auditAgentId,
        auditPhase,
      });
      return { outcome: "blocked", task: move.task, previousColumn: latest.column, reason: currentBlocker };
    }
    const finalized = await store.updateTaskAtomic(taskId, (current) => {
      const reconciliation = planConfirmedMergeChecklistReconciliation(current);
      return {
        paused: false,
        status: null,
        error: null,
        blockedBy: null,
        overlapBlockedBy: null,
        mergeRetries: 0,
        mergeDetails: buildFinalizationMergeDetails(current, result),
        steps: current.steps.map((step, index) =>
          reconciliation.skippedStepIndexes.includes(index) ? { ...step, status: "skipped" as const } : step,
        ),
        workflowStepResults: (current.workflowStepResults ?? []).map((entry) =>
          reconciliation.reconciledWorkflowStepIds.includes(entry.workflowStepId)
            ? { ...entry, status: "skipped" as const }
            : entry,
        ),
      } as Pick<Task, "steps" | "workflowStepResults">;
    });
    if (result) result.task = finalized;
    if (shouldRecoveryRehome) {
      await recordFinalizationAudit({
        store,
        audit,
        task: latest,
        type: "task:auto-merge-finalize-column-mismatch-reconciled",
        reason: `${source}:recovery-rehome`,
        auditAgentId,
        auditPhase,
      });
      fence?.assertOwned("finalization");
      await store.logEntry(
        taskId,
        `Auto-merge finalization repaired column mismatch: ${latest.column} → ${completeColumn} after proven merge; cleared stale status/blockers`,
      ).catch(() => undefined);
    }
    const finalTask = finalized;
    return { outcome: shouldRecoveryRehome ? "done" : "done", task: finalTask, previousColumn: latest.column };
  } catch (error) {
    if (isInvalidDoneTransitionError(error, completeColumn)) {
      const refreshed = await store.getTask(taskId).catch(() => null);
      if (refreshed && isCompleteColumn(refreshed.column)) {
        if (result) result.task = refreshed;
        return { outcome: "already-done", task: refreshed, previousColumn: latest.column };
      }
      if (refreshed) {
        await recordFinalizationAudit({
          store,
          audit,
          task: refreshed,
          type: "task:auto-merge-finalize-column-mismatch-no-action",
          reason: `invalid-done-transition:${refreshed.column}`,
          auditAgentId,
          auditPhase,
        });
      }
    }
    throw error;
  }
}
