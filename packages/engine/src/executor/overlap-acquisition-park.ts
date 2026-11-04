import type { Task, TaskStore } from "@fusion/core";
import { isWorkspaceTask } from "@fusion/core";
import { activeSessionRegistry } from "../agents/active-session-registry.js";
import { resolveExternalExecutionCheckoutRoute } from "../execution/external-execution-checkout.js";
import { executorLog } from "../logger.js";
import { emitBoundedRunAudit } from "../util/emit-bounded-run-audit.js";
import type { OverlapRefusalArtifacts, OverlapResumeSynchronizationError } from "../executor/overlap-resume-gate.js";
import { RemovalReason, removeWorktree, WorktreeContentPreservationError } from "../worktree/worktree-backend.js";

/*
FNXC:OverlapAcquisitionPark 2026-11-04-01:35 (RUFU-373):
The withheld-work record for a file-scope overlap refusal at acquisition time.

SANE-436 (2026-09-27T16:4xZ, project saneca) and ROZV-197 (7 856 / 7 855 todo<->in-progress bounces,
6 939 occurrences of `Delivered file evidence is not yet available for overlap synchronization` across
23 578 activity rows) were invisible in telemetry: the refusal produced no event, and the composed
exhaustion message named no predecessor. One bounded event per (task, episodes, reason) episode now
names the missing artifact. It is emitted through `emitBoundedRunAudit` — an absent, throwing, rejecting
or hanging sink cannot change the refusal, so telemetry never becomes a lifecycle dependency — and stays
outside the curated delivery-pipeline catalogue (documented as prose in docs/run-audit.md), which
`run-audit-catalogue.test.ts` locks table-for-table.

Metadata is ids/counts/fixed enums ONLY: `reason` and `missingEvidence` are the gate's closed vocabularies,
`registrationRelease` is this module's. The refusal sentence, delivered paths, and diffs never enter the row.
*/
export type OverlapRegistrationRelease =
  | "removed"
  | "absent"
  | "preserved"
  | "refused-active"
  | "refused-external-checkout"
  | "refused-workspace-task"
  | "no-registration"
  | "failed";

/** Deduped per (task, reason, episode set) so a repeated wait is countable, not a per-heartbeat flood. */
const announcedEpisodes = new Set<string>();

/** Test seam: the dedup set is process-local, like every other `-no-action` dedup in the engine. */
export function __resetOverlapAcquisitionParkDedup(): void {
  announcedEpisodes.clear();
}

function episodeKey(taskId: string, reason: string, artifacts: OverlapRefusalArtifacts): string {
  return `${taskId}|${reason}|${[...artifacts.episodeIds].sort().join(",")}`;
}

/*
FNXC:OverlapAcquisitionPark 2026-11-04-01:35 (RUFU-373):
The registration a refused acquisition leaves behind is the re-arm half of the wedge. SANE-436 kept its
worktree pointer through the failure, and `reconcile-dependency-blocking-lease` (RUFU-200) rebounds the
HOLDER for a dormant lease — so the waiter's own dead checkout could block the very predecessor it waits on.
The release reuses the proof-gated defensive path (registry guard + `git status --porcelain` + allowlist +
`WorktreeContentPreservationError`), so it can never destroy task-authored content: a checkout that is not
provably empty keeps both the checkout AND its pointers, which is what makes a release safe to attempt
before execution has ever started.
*/
export async function releaseRefusedAcquisitionRegistration(input: {
  store: TaskStore;
  rootDir: string;
  task: Task;
}): Promise<OverlapRegistrationRelease> {
  const { store, rootDir, task } = input;
  if (!task.worktree) return "no-registration";
  // A workspace lane's registration spans per-repo members; only the workspace lane owns that teardown.
  if (isWorkspaceTask(task)) return "refused-workspace-task";
  /*
   * An operator-configured external checkout is never an engine-owned acquisition to roll back. The
   * refusal can be misread when the operator set `enabled:false` while a stale pointer still names their
   * path — the `configured` flag alone is the proof of intent, matching every other release site's guard.
   */
  if ((await resolveExternalExecutionCheckoutRoute(task)).configured) return "refused-external-checkout";
  // Fail closed while anything still holds the path: a live session outranks a refusal that predates it.
  if (activeSessionRegistry.isPathActive(task.worktree)) return "refused-active";

  const settings = await store.getSettings();
  try {
    const outcome = await removeWorktree({
      rootDir,
      worktreePath: task.worktree,
      settings,
      taskId: task.id,
      reason: RemovalReason.AcquisitionRefused,
    });
    // The backend signals preservation by THROWING, so a returned outcome is never a preservation.
    if (outcome.classification === "not-registered-after-prune") {
      // Nothing left to remove but the pointers still named it: clearing them is the whole repair.
      await store.updateTask(task.id, { worktree: null, branch: null, baseCommitSha: null });
      return "absent";
    }
    await store.updateTask(task.id, { worktree: null, branch: null, baseCommitSha: null });
    return "removed";
  } catch (error) {
    // A preservation refusal keeps the pointers: clearing them over a preserved checkout is how orphans are made.
    if (error instanceof WorktreeContentPreservationError) return "preserved";
    executorLog.warn(`${task.id}: could not release the worktree refused by overlap synchronization: ${error instanceof Error ? error.message : String(error)}`);
    return "failed";
  }
}

/**
 * Records one bounded withheld-work episode and releases the leaked registration.
 * Returns the fixed outcomes so the caller's heartbeat run result carries them too.
 */
export async function recordOverlapAcquisitionPark(input: {
  store: TaskStore;
  rootDir: string;
  task: Task;
  agentId: string;
  error: OverlapResumeSynchronizationError;
  nodeId?: string;
}): Promise<{ registrationRelease: OverlapRegistrationRelease; announced: boolean }> {
  const { store, task, agentId, error } = input;
  const artifacts = error.artifacts;
  const registrationRelease = await releaseRegistrationGuarded(input);
  const key = episodeKey(task.id, error.reason, artifacts);
  const announced = !announcedEpisodes.has(key);
  if (announced) {
    announcedEpisodes.add(key);
    await emitBoundedRunAudit(store, {
      taskId: task.id,
      agentId,
      runId: `overlap-acquisition-park:${task.id}:${key}`,
      domain: "database",
      mutationType: "task:overlap-acquisition-parked",
      target: task.id,
      metadata: {
        taskId: task.id,
        ...(input.nodeId ? { nodeId: input.nodeId } : {}),
        reason: error.reason,
        missingEvidence: artifacts.missingEvidence,
        episodeIds: artifacts.episodeIds.slice(0, 20),
        blockerTaskIds: artifacts.blockerTaskIds.slice(0, 20),
        repositories: artifacts.repositories.slice(0, 20),
        episodeCount: artifacts.episodeIds.length,
        // The whole point of the event: a deterministic wait consumed none of the broken-checkout budget.
        strikeBudgetConsumed: 0,
        registrationRelease,
      },
    });
    const blockers = artifacts.blockerTaskIds.length > 0 ? artifacts.blockerTaskIds.join(", ") : "unknown";
    // The action line is what the card face shows, so it names the predecessor rather than the mechanism.
    // A store double that returns nothing must not turn the notice into a second failure path, hence Promise.resolve.
    await Promise.resolve(store.logEntry(
      task.id,
      `Waiting on ${blockers} for file-scope delivery — execution withheld, no retry strike consumed`,
      `Missing artifact: ${artifacts.missingEvidence}; repositories: ${artifacts.repositories.join(", ") || "unknown"}; episodes: ${artifacts.episodeIds.join(", ") || "unknown"}; registration release: ${registrationRelease}`,
    )).catch(() => undefined);
  }
  return { registrationRelease, announced };
}

/** Never let a release failure or a missing pointer turn a refusal into a second failure path. */
async function releaseRegistrationGuarded(input: { store: TaskStore; rootDir: string; task: Task }): Promise<OverlapRegistrationRelease> {
  try {
    return await releaseRefusedAcquisitionRegistration(input);
  } catch (error) {
    executorLog.warn(`${input.task.id}: overlap registration release raised: ${error instanceof Error ? error.message : String(error)}`);
    return "failed";
  }
}
