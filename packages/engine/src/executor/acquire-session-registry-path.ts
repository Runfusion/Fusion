/**
 * FNXC:CodeOrganization 2026-08-03-17:30:
 * acquireSessionRegistryPath peeled from TaskExecutor (U4).
 *
 * FNXC:SessionContention 2026-07-25-21:30 (contention prevention at the registration seam):
 * Every executor session registration goes through acquireActiveSessionPath instead of the raw
 * registerPath, so a LEAKED entry owned by a task with no live session surface in this process is
 * RECLAIMED rather than throwing at the newcomer. That closes the second contention class (a dead
 * holder can never release, so waiting on it is waiting forever). A genuinely live holder still throws
 * the typed error — that case is real serialization, and callers classify it as a retryable contention
 * hold (SESSION_CONTENTION_HOLD_VALUE), never as a provider/model failure.
 * The probe reports LIVE on any uncertainty: an unknown holder with a fresh entry is treated as live by
 * the staleness floor, so the reclaim only ever fires on proven-dead, aged entries.
 */
import type { TaskStore } from "@fusion/core";
import {
  ActiveSessionPathHeldByForeignTaskError,
  acquireActiveSessionPath,
  activeSessionRegistry,
  executingTaskLock,
  type ActiveSessionKind,
} from "../agents/active-session-registry.js";
import { executorLog } from "../logger.js";
import { generateSyntheticRunId } from "../util/run-audit.js";

export type AcquireSessionRegistryPathDeps = {
  store: TaskStore;
  hasLiveTaskSessionSurface: (taskId: string) => boolean;
};

export function acquireSessionRegistryPath(
  deps: AcquireSessionRegistryPathDeps,
  taskId: string,
  registryPath: string,
  kind: ActiveSessionKind,
  ownerKey: string,
): void {
  const outcome = acquireActiveSessionPath(activeSessionRegistry, registryPath, { taskId, kind, ownerKey }, {
    holderLiveProbe: (holderTaskId) => deps.hasLiveTaskSessionSurface(holderTaskId) || executingTaskLock.has(holderTaskId),
  });
  if (outcome.action === "contended") {
    throw new ActiveSessionPathHeldByForeignTaskError(registryPath, outcome.holderTaskId, taskId);
  }
  if (outcome.action === "reclaimed-stale-foreign") {
    executorLog.warn(
      `${taskId}: reclaimed a stale active-session entry on ${registryPath} from dead task ${outcome.holderTaskId} (idle ${outcome.ageMs}ms)`,
    );
    void deps.store.recordRunAuditEvent?.({
      taskId,
      agentId: "executor",
      runId: generateSyntheticRunId("session-path-reclaim", taskId),
      domain: "database",
      mutationType: "session:reclaim-stale-foreign-path",
      target: taskId,
      metadata: { taskId, holderTaskId: outcome.holderTaskId, kind, ageMs: outcome.ageMs },
    })?.catch?.(() => undefined);
  }
}
