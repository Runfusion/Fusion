/**
 * FNXC:CodeOrganization 2026-08-03-10:40:
 * handleLoopDetected peeled from TaskExecutor (U4).
 * Compact-and-resume once per execute lifecycle; else fall through to kill/requeue.
 * Dashboard `onLoopDetected` callback: active-session check, one-attempt ceiling,
 * compactSessionContext, then recovery-pending. Returns true when the executor
 * accepted recovery ownership (detector skips kill).
 */
import type { TaskStore } from "@fusion/core";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { compactSessionContext, type CompactionOutcome } from "../pi.js";
import { executorLog } from "../logger.js";
import { emitBoundedRunAudit } from "../util/emit-bounded-run-audit.js";
import { generateSyntheticRunId } from "../util/run-audit.js";

/** Upper bound for in-process loop recovery before falling through to kill/requeue. */
export const LOOP_COMPACTION_TIMEOUT_MS = 60_000;

export type LoopRecoveryState = { attempts: number; pending: boolean };

export type StuckTaskEventLike = {
  taskId: string;
  activitySinceProgress?: number;
};

export type HandleLoopDetectedDeps = {
  store: TaskStore;
  activeSessions: Map<string, { session: AgentSession }>;
  loopRecoveryState: Map<string, LoopRecoveryState>;
  markLoopObserved?: (taskId: string) => void;
};

export async function handleLoopDetected(
  deps: HandleLoopDetectedDeps,
  event: StuckTaskEventLike,
): Promise<boolean> {
  const { taskId } = event;
  const activeEntry = deps.activeSessions.get(taskId);

  // No active session — can't compact, let detector kill/requeue
  if (!activeEntry) {
    executorLog.log(`${taskId} loop detected but no active session — falling back to kill/requeue`);
    return false;
  }

  // Check attempt ceiling (max 1 compact-and-resume per execute() lifecycle).
  // After this fallback, StuckTaskDetector disposes the stalled session and resumes the same task in place.
  const state = deps.loopRecoveryState.get(taskId);
  if (state && state.attempts >= 1) {
    executorLog.log(`${taskId} loop detected but compact ceiling reached — falling back to kill/requeue`);
    return false;
  }

  // Attempt compaction
  const attempt = (state?.attempts ?? 0) + 1;
  executorLog.log(`${taskId} loop detected (attempt ${attempt}) — attempting compact-and-resume`);
  await deps.store.logEntry(taskId, `Loop detected (${event.activitySinceProgress} events since last progress) — attempting compact-and-resume (attempt ${attempt})`);

  let compactionTimedOut = false;
  let compactionTimer: ReturnType<typeof setTimeout> | undefined;
  const abortActiveSession = () => {
    const sessionWithAbort = activeEntry.session as unknown as { abort?: () => Promise<void> };
    if (typeof sessionWithAbort.abort === "function") {
      void sessionWithAbort.abort().catch((err: unknown) => {
        executorLog.warn(`${taskId} loop compaction abort after timeout failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
  };
  let compactOutcome: CompactionOutcome;
  try {
    compactOutcome = await Promise.race([
      compactSessionContext(activeEntry.session),
      new Promise<CompactionOutcome>((resolve) => {
        compactionTimer = setTimeout(() => {
          compactionTimedOut = true;
          abortActiveSession();
          /*
          FNXC:ChatContextGuardEscalation 2026-09-04-10:57:
          RUFU-182: the timeout arm resolves a synthetic `error` outcome (nothing proven appended) so
          this caller branches on `reason` like every other consumer. Loop recovery never retries in
          place regardless — the kill/requeue fallback below is unchanged.
          */
          resolve({
            reason: "error",
            branchMutated: false,
            engineMessage: `Context compaction timed out after ${LOOP_COMPACTION_TIMEOUT_MS / 1000}s`,
          });
        }, LOOP_COMPACTION_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (compactionTimer) clearTimeout(compactionTimer);
  }
  /*
  FNXC:CompactionNoProgress 2026-09-04-16:35:
  RUFU-187 — a `no-progress` outcome means pi DID mutate the branch (a CompactionEntry is now in the
  tree) while the before/after comparison proves nothing was freed, so this lane's compact-and-resume
  recovery is refused. The honest wording is a requirement, not decoration: the previous shape let a
  non-reducing pass read as progress, which burned a detection cycle and re-attempted a recovery that
  cannot help (pi's second `compact()` can only answer "Already compacted" — the RUFU-124 lineage).
  Storing `attempts` WITHOUT `pending` is what makes the next detection fast-fail at the ceiling check
  above instead of touching pi again. Telemetry stays ids/counts/outcomes-only per the run-audit
  contract; the operator-facing sentence lives on the card, never in the audit row.
  */
  if (compactOutcome.reason === "no-progress") {
    const sentence =
      `Context compaction reduced nothing (attempt ${attempt}, ` +
      `before=${compactOutcome.tokensBefore} after=${compactOutcome.estimatedTokensAfter} tokens) — ` +
      `compact-and-resume recovery not accepted`;
    executorLog.log(`${taskId} ${sentence} — falling back to kill/requeue`);
    await deps.store.logEntry(taskId, `${sentence} — falling back to kill/requeue`);
    deps.loopRecoveryState.set(taskId, { attempts: attempt, pending: false });
    await emitBoundedRunAudit(deps.store, {
      taskId,
      agentId: "executor",
      runId: generateSyntheticRunId("compaction-no-progress", taskId),
      domain: "database",
      mutationType: "task:compaction-no-progress",
      target: taskId,
      metadata: {
        source: "loop-recovery",
        tokensBefore: compactOutcome.tokensBefore,
        tokensAfter: compactOutcome.estimatedTokensAfter,
        basis: compactOutcome.basis,
      },
    });
    return false;
  }

  if (compactOutcome.reason !== "compacted") {
    const reason = compactionTimedOut
      ? `Context compaction timed out after ${LOOP_COMPACTION_TIMEOUT_MS / 1000}s`
      : `Context compaction ${compactOutcome.reason === "error" ? "failed" : `refused (${compactOutcome.reason})`}${
          compactOutcome.engineMessage ? `: ${compactOutcome.engineMessage}` : ""
        }`;
    executorLog.log(`${taskId} ${reason.toLowerCase()} — falling back to kill/requeue`);
    await deps.store.logEntry(taskId, `${reason} — falling back to kill/requeue`);
    return false;
  }

  if (deps.activeSessions.get(taskId)?.session !== activeEntry.session) {
    executorLog.log(`${taskId} compaction completed after session changed — falling back to kill/requeue`);
    await deps.store.logEntry(taskId, "Context compaction completed after session changed — falling back to kill/requeue");
    return false;
  }

  // `tokensBefore` is the pre-compaction context size, not the freed amount — a 100k→80k
  // compaction must not log "freed 100k" (2026-09-16 review).
  executorLog.log(`${taskId} compaction succeeded (context was ${compactOutcome.tokensBefore} tokens before compaction) — setting recovery-pending`);
  await deps.store.logEntry(taskId, `Context compacted successfully — will resume with fresh context`);

  // FN-5168: once loop recovery has fired in this execute() lifecycle,
  // ignored fn_task_update rebuffs can be promoted to no-progress churn.
  deps.markLoopObserved?.(taskId);

  // Mark recovery-pending so the execution flow can consume it
  deps.loopRecoveryState.set(taskId, { attempts: attempt, pending: true });

  // Steer the session with a resume prompt to break the loop
  try {
    await activeEntry.session.steer(
      "⚠️ Loop detected: you were repeating actions without making progress. " +
      "The conversation has been compacted. Review the current state carefully, " +
      "check what's already been done (git log, file contents), and take a different " +
      "approach. Do NOT repeat the same actions. Advance to the next step if the " +
      "current work is complete.",
    );
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    executorLog.error(`${taskId} failed to steer after compaction: ${errorMessage}`);
    // Recovery-pending is still set — the execution flow will handle it
  }

  return true;
}
