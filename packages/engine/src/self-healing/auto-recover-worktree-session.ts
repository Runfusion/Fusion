/**
 * FNXC:CodeOrganization 2026-08-10-03:45:
 * autoRecoverWorktreeSessionStartFailure peeled from self-healing.ts (U5 / wave19 Slice A).
 *
 * FNXC:MissingWorktreeRecovery 2026-07-10-18:15 / 2026-07-26-08:35:
 * Clear stale worktree/session metadata and requeue on unusable worktree session-start refusal,
 * with a bounded retry budget and careful branch retention for non-canonical names.
 */
import { resolve } from "node:path";
import type { Task, TaskStore } from "@fusion/core";
import { isWorkspaceTask, loadWorkspaceConfig, UNATTRIBUTED_MUTATION_CONTEXT } from "@fusion/core";
import { hasUsableWorktreeShape } from "../worktree/worktree-pool.js";
import {
  classifyMissingWorktreeSessionStartFailure,
  extractMissingWorktreePathFromSessionStartFailure,
  isMissingWorktreeSessionStartFailure,
} from "../healing/restart-recovery-coordinator.js";
import { MAX_WORKTREE_SESSION_RETRIES } from "../healing/self-healing-constants.js";
import type { RunAuditor } from "../util/run-audit.js";
import { hasStepProgress } from "./step-progress.js";

export async function autoRecoverWorktreeSessionStartFailure(
  store: TaskStore,
  task: Task,
  opts: {
    failure: unknown;
    source: "executor-session-start" | "workspace-preparation" | "in-review-sweep" | "merge-active-sweep" | "resume-guard";
    auditor: RunAuditor | null;
    forceClearWorktreeMetadata?: boolean;
    resetRetryBudgetOnStaleMetadataClear?: boolean;
    staleMetadataClearRecoveryRetryCount?: number;
    /**
     * FNXC:MissingWorktreeRecovery 2026-07-26-08:35:
     * Project root. Pass it whenever the caller has one so the liveness probe can also reject a
     * recorded worktree that IS the main checkout (FN-6861 repo-root requeue loop). Optional so
     * narrow test callers and any future caller without a root still type-check.
     */
    rootDir?: string;
  },
): Promise<{ outcome: "requeue-todo" | "escalate-exhausted"; retries: number; classification: "missing" | "incomplete" | "unregistered" | "unknown" }> {
  const classification = classifyMissingWorktreeSessionStartFailure(opts.failure);
  let configuredWorkspace = false;
  if (opts.rootDir) {
    try {
      configuredWorkspace = ((await loadWorkspaceConfig(opts.rootDir))?.repos.length ?? 0) > 0;
    } catch { /* an unreadable config cannot authorize workspace cleanup */ }
  }
  const workspaceTask = configuredWorkspace || isWorkspaceTask(task);
  if (workspaceTask) {
    /*
    FNXC:WorkspaceRootRouting 2026-08-19-12:15:
    Recovery of a workspace task is map-preserving. A root or singular worktree reference can never
    authorize clearing/recreating a declared repository checkout, and it cannot be used to decide
    that implementation progress was lost. Normalize only the stale singular metadata first.
    */
    const normalize = (store as typeof store & {
      normalizeWorkspaceTaskWorktreeMetadata?: (id: string) => Promise<Task>;
    }).normalizeWorkspaceTaskWorktreeMetadata;
    if (typeof normalize === "function") task = await normalize.call(store, task.id);
  }
  /*
  FNXC:MissingWorktreeRecovery 2026-07-10-18:15:
  Upstream #1992 showed merge-active review-fix sessions can exhaust the unusable-worktree retry budget while every retry reuses the same phantom worktree metadata. When a guarded recovery clears that stale worktree/branch/session reference, the next dispatch must get a fresh session-start retry budget instead of inheriting the exhausted context that caused the strand.

  FNXC:MissingWorktreeRecovery 2026-07-10-21:36:
  The merge-active sweep still needs a bounded human-escalation circuit breaker after clearing stale metadata, so it tracks those guarded clears through recoveryRetryCount instead of repeatedly resetting worktreeSessionRetryCount to zero on every recurrence.
  */
  const resetRetryBudget = opts.resetRetryBudgetOnStaleMetadataClear === true;
  const staleMetadataClearRecoveryRetryCount = opts.staleMetadataClearRecoveryRetryCount;
  const currentStaleMetadataClearRecoveryCount = staleMetadataClearRecoveryRetryCount ?? 0;
  const nextStaleMetadataClearRecoveryCount = staleMetadataClearRecoveryRetryCount === undefined
    ? undefined
    : currentStaleMetadataClearRecoveryCount + 1;
  if (nextStaleMetadataClearRecoveryCount !== undefined && nextStaleMetadataClearRecoveryCount > MAX_WORKTREE_SESSION_RETRIES) {
    await store.logEntry(
      task.id,
      `Auto-recovery exhausted (${MAX_WORKTREE_SESSION_RETRIES}/${MAX_WORKTREE_SESSION_RETRIES}) for merge-active unusable-worktree stale-metadata clears — leaving in-review for human inspection`, undefined, UNATTRIBUTED_MUTATION_CONTEXT);
    await opts.auditor?.database({
      type: "task:auto-recover-worktree-session-exhausted",
      target: task.id,
      metadata: {
        retries: currentStaleMetadataClearRecoveryCount,
        maxRetries: MAX_WORKTREE_SESSION_RETRIES,
        source: opts.source,
        counter: "recoveryRetryCount",
      },
    });
    return { outcome: "escalate-exhausted", retries: currentStaleMetadataClearRecoveryCount, classification };
  }
  const nextCount = resetRetryBudget ? 0 : (task.worktreeSessionRetryCount ?? 0) + 1;
  if (!resetRetryBudget && nextCount > MAX_WORKTREE_SESSION_RETRIES) {
    await store.logEntry(
      task.id,
      `Auto-recovery exhausted (${MAX_WORKTREE_SESSION_RETRIES}/${MAX_WORKTREE_SESSION_RETRIES}) for unusable-worktree session-start failure — leaving in-review for human inspection`, undefined, UNATTRIBUTED_MUTATION_CONTEXT);
    await opts.auditor?.database({
      type: "task:auto-recover-worktree-session-exhausted",
      target: task.id,
      metadata: {
        retries: task.worktreeSessionRetryCount ?? 0,
        maxRetries: MAX_WORKTREE_SESSION_RETRIES,
        source: opts.source,
      },
    });
    return { outcome: "escalate-exhausted", retries: task.worktreeSessionRetryCount ?? 0, classification };
  }

  const staleWorktree = task.worktree;
  const missingWorktreePath = extractMissingWorktreePathFromSessionStartFailure(opts.failure);
  /*
  FNXC:MissingWorktreeRecovery 2026-07-26-07:15:
  A failing path that DIFFERS from `task.worktree` does not prove the recorded worktree is live.
  Preserve the recorded worktree only when it is STILL a usable checkout; otherwise clear it so
  the next dispatch builds a fresh one from the branch.

  FNXC:MissingWorktreeRecovery 2026-07-26-08:35:
  WHAT THIS DECISION ACTUALLY CONTROLS: `branch`. The rebound below is a reopen move
  (in-review/in-progress -> todo|triage), and a reopen CLEARS `task.worktree` unless the caller
  passes `preserveWorktree`. Clearing `branch` is only safe for the CANONICAL `fusion/<id>` name.
  */
  const recordedWorktreeStillUsable = workspaceTask
    ? false
    : hasUsableWorktreeShape(staleWorktree, opts.rootDir);
  const hasMismatchedLiveWorktree =
    recordedWorktreeStillUsable
    && typeof missingWorktreePath === "string" && missingWorktreePath.length > 0
    && resolve(staleWorktree as string) !== resolve(missingWorktreePath);
  const noProgress = !hasStepProgress(task);
  const forceClearWorktreeMetadata = opts.forceClearWorktreeMetadata === true;
  const clearWorktreeMetadata = workspaceTask || noProgress || forceClearWorktreeMetadata || !hasMismatchedLiveWorktree;
  const branchIsRederivable =
    typeof task.branch !== "string"
    || task.branch.length === 0
    || task.branch.toLowerCase() === `fusion/${task.id}`.toLowerCase();
  const nextBranch = workspaceTask
    ? null
    : clearWorktreeMetadata && branchIsRederivable ? null : task.branch ?? null;

  await store.updateTask(task.id, {
    status: null,
    error: null,
    worktreeSessionRetryCount: nextCount,
    ...(nextStaleMetadataClearRecoveryCount === undefined ? {} : { recoveryRetryCount: nextStaleMetadataClearRecoveryCount }),
    worktree: clearWorktreeMetadata ? null : staleWorktree,
    /*
     * FNXC:BranchNaming 2026-08-21-09:36:
     * Session recovery often changes only worktree/session metadata. Do not reassert an unchanged
     * branch with engine provenance: that would erase a matching operator override and later make
     * its branch eligible for engine cleanup. A real canonical clear remains an explicit engine write.
     */
    ...((task.branch ?? null) === nextBranch
      ? {}
      : { branch: nextBranch, branchWriteOrigin: "engine" as const }),
    sessionFile: null,
  }, UNATTRIBUTED_MUTATION_CONTEXT);
  await opts.auditor?.database({
    type: "task:auto-recover-worktree-session-metadata",
    target: task.id,
    metadata: {
      source: opts.source,
      classification,
      recordedWorktreeStillUsable,
      clearedWorktreeMetadata: clearWorktreeMetadata,
      clearedBranch: nextBranch === null && (task.branch ?? null) !== null,
      retainedNonCanonicalBranch: clearWorktreeMetadata && !branchIsRederivable,
    },
  });

  const rawFailureExcerpt = typeof task.error === "string"
    ? task.error.slice(0, 200)
    : opts.failure instanceof Error
      ? opts.failure.message.slice(0, 200)
      : String(opts.failure).slice(0, 200);
  const failureExcerpt = isMissingWorktreeSessionStartFailure(rawFailureExcerpt)
    ? "session-start unusable-worktree assertion"
    : rawFailureExcerpt;
  const attemptLabel = resetRetryBudget
    ? `retry budget reset from ${task.worktreeSessionRetryCount ?? 0}/${MAX_WORKTREE_SESSION_RETRIES}`
    : `attempt ${nextCount}/${MAX_WORKTREE_SESSION_RETRIES}`;
  /*
  FNXC:LifecycleContainment 2026-08-28-03:03:
  FN-207 resolves recovery relative to the live source role: review returns to WIP and WIP returns
  to hold. No hold/intake/first-column fallback is allowed when the adjacent target is absent.
  */
  const recoveryColumn = task.column;
  await store.logEntry(
    task.id,
    noProgress
      ? `Auto-recovered (no-progress): session-start refused unusable worktree${staleWorktree ? ` (${staleWorktree})` : ""} — cleared stale session metadata and retained in ${recoveryColumn} (${attemptLabel}, failure: ${failureExcerpt})`
      : hasMismatchedLiveWorktree && !forceClearWorktreeMetadata
        ? `Auto-recovered: stale resume referenced unusable worktree (${missingWorktreePath}) while the recorded task worktree ${staleWorktree} is still a live checkout — cleared stale session metadata and retained in ${recoveryColumn} (${attemptLabel}, failure: ${failureExcerpt})`
        /*
        FNXC:MissingWorktreeRecovery 2026-07-26-08:35:
        Name WHICH path was unusable when the recorded worktree and the session path differ.
        */
        : `Auto-recovered: session start refused unusable worktree${missingWorktreePath ? ` (${missingWorktreePath})` : ""}${
          staleWorktree && (!missingWorktreePath || resolve(staleWorktree) !== resolve(missingWorktreePath))
            ? `; the recorded task worktree ${staleWorktree} is ${recordedWorktreeStillUsable ? "still present" : "gone too"}`
            : ""
        } — cleared stale session metadata${clearWorktreeMetadata && !branchIsRederivable ? ` (kept non-canonical branch ${task.branch})` : ""} and retained in ${recoveryColumn} (${attemptLabel}, failure: ${failureExcerpt})`, undefined, UNATTRIBUTED_MUTATION_CONTEXT);
  // Legacy outcome name retained for callers; lifecycle recovery itself is in-place.
  return { outcome: "requeue-todo", retries: nextCount, classification };
}
