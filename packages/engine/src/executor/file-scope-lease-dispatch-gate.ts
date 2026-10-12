/*
FNXC:OverlapScheduling 2026-08-29-06:12:
Execution can enter outside the scheduler, so this outer gate repeats the file-scope lifetime check
before graph routing. It holds only a task that has not acquired a checkout yet; singular and workspace
per-repository checkouts both prove a scheduler-admitted resume. The hold is in-place and preserves dependency
state so it never moves a card backward merely for overlap serialization.

FNXC:OverlapScheduling 2026-09-01-14:49:
A checkout-less planning peer is not a holder and cannot block this dispatch. A hold-lane peer with a
retained execution checkout remains a dormant holder, preserving unmerged work across replan bounces.
*/
import {
  compareTasksByQueueOrder,
  fileScopeLeaseBlocksCandidate,
  normalizeOverlapScopeForTask,
  taskHoldsUnmergedCheckout,
  isReviewColumnRole,
  isTerminalColumnRole,
  isWipColumnRole,
  resolveColumnFlags,
  resolveWorkflowIrForTask,
  type Task,
  type TaskStore,
  type WorkflowIr,
  type WorkflowIrV2,
} from "@fusion/core";
import {
  classifyFileScopeLease,
  filterPathsByIgnoreList,
  isCoordinationOnlyTask,
  pathsOverlap,
  resolveDependencySatisfactionColumns,
} from "../scheduler.js";
import { proveDormantCheckoutEmptiness } from "../worktree/checkout-emptiness.js";
import type { EngineRunContext } from "../util/run-audit.js";

export type FileScopeLeaseDispatchGateDeps = {
  store: TaskStore;
  getRunContextFor: (taskId: string) => EngineRunContext | undefined;
};

type ResolvedLeaseRoles = {
  isWipColumn: boolean;
  isReviewColumn: boolean;
  isTerminalColumn: boolean;
};

async function resolveLeaseRoles(
  store: TaskStore,
  task: Task,
  cache: Map<string, WorkflowIr>,
): Promise<ResolvedLeaseRoles> {
  try {
    const ir = await resolveWorkflowIrForTask(store, task.id, cache);
    const column = (ir as WorkflowIrV2).columns?.find((candidate) => candidate.id === task.column);
    const flags = column ? resolveColumnFlags(column) : undefined;
    return {
      isWipColumn: isWipColumnRole(flags, task.column),
      isReviewColumn: isReviewColumnRole(flags, task.column),
      isTerminalColumn: isTerminalColumnRole(flags, task.column),
    };
  } catch {
    /*
    FNXC:OverlapScheduling 2026-08-30-00:20:
    The IR could not be resolved, so there are no trait flags to key on. Call the SAME role helpers
    with `undefined` flags rather than restating the legacy column ids: each helper's documented
    no-flags branch already is that literal, so this is byte-for-byte the previous behaviour while
    keeping the lifecycle-column census at zero raw guards. Restating them here made the ratchet
    rise and turned the Lint gate red on every open PR.
    */
    return {
      isWipColumn: isWipColumnRole(undefined, task.column),
      isReviewColumn: isReviewColumnRole(undefined, task.column),
      isTerminalColumn: isTerminalColumnRole(undefined, task.column),
    };
  }
}

export async function blockOuterDispatchWhenFileScopeLeaseHeld(
  deps: FileScopeLeaseDispatchGateDeps,
  task: Task,
): Promise<boolean> {
  if (task.mergeDetails?.mergeConfirmed === true) return false;
  const settings = await deps.store.getSettings();
  /*
  FNXC:OverlapScheduling 2026-09-08-21:20 (RUFU-200):
  This is the CANDIDATE side of the check and it deliberately stays unproven. If the card about to
  dispatch still has its own retained checkout, that checkout is about to be its working tree: a dirty
  one genuinely occupies its files, and this gate's job is only to avoid starting a second editor over
  them. RUFU-200's downgrade applies to a HOLDER's claim over someone else's files, never to a card's
  own live checkout, so `taskHoldsUnmergedCheckout(task)` keeps its original unproven meaning here.
  */
  if (settings.groupOverlappingFiles !== true || taskHoldsUnmergedCheckout(task)) return false;

  // FNXC:ListTasksExcludeLog 2026-10-12-15:35 (RUFU-615 tranche 3): reads column/paths/role only; `slim`
  // alone still hydrates every card's full log, which is the board-scan retention driver. See
  // dependency-dispatch-gate.ts for the measured rationale.
  const tasks = await deps.store.listTasks({ includeArchived: false, slim: true, excludeLog: true });
  const liveTask = tasks.find((candidate) => candidate.id === task.id) ?? task;
  const overlapIgnorePaths = settings.overlapIgnorePaths ?? [];
  const candidateScope = normalizeOverlapScopeForTask(liveTask, filterPathsByIgnoreList(
    await deps.store.parseFileScopeFromPrompt(liveTask.id),
    overlapIgnorePaths,
    { ignoreHiddenOverlapPaths: settings.ignoreHiddenOverlapPaths },
  ));
  if (candidateScope.length === 0 || isCoordinationOnlyTask(liveTask, candidateScope)) return false;

  const mergeShadowEnabled = settings.mergeRequestContractShadowEnabled === true;
  const markerAcceptedByTaskId = new Map<string, boolean>();
  if (mergeShadowEnabled) {
    for (const dependencyId of new Set(tasks.flatMap((candidate) => candidate.dependencies ?? []))) {
      markerAcceptedByTaskId.set(
        dependencyId,
        (await deps.store.getCompletionHandoffAcceptedMarker(dependencyId)) !== null,
      );
    }
  }
  const irCache = new Map<string, WorkflowIr>();
  const schedulingDependencyOptions = {
    markerAcceptedByTaskId,
    satisfactionColumnsByTaskId: await resolveDependencySatisfactionColumns(deps.store, tasks, irCache),
  };
  const holders: Array<{ task: Task; kind: "active" | "dormant"; scope: string[]; waivedForTaskIds: readonly string[] }> = [];

  /*
  FNXC:OverlapScheduling 2026-09-08-21:20 (RUFU-200):
  Roles resolve before the lease question is asked, because the emptiness proof is only worth computing
  for the holders whose classification could actually change: a non-WIP, non-review, non-terminal holder
  with a retained checkout. Proving a live WIP or review holder would spend git on a verdict its lane
  never reads (see `classifyFileScopeLease`), so this pass splits into resolve-roles, prove, classify.
  */
  const roleResolvedHolders: Array<{ holder: Task; roles: ResolvedLeaseRoles; handoffAccepted: boolean }> = [];
  for (const holder of tasks) {
    if (holder.id === liveTask.id || holder.deletedAt) continue;
    const roles = await resolveLeaseRoles(deps.store, holder, irCache);
    const handoffAccepted = mergeShadowEnabled && roles.isReviewColumn
      ? (await deps.store.getCompletionHandoffAcceptedMarker(holder.id)) !== null
      : false;
    roleResolvedHolders.push({ holder, roles, handoffAccepted });
  }

  const dormantProofCandidates = roleResolvedHolders
    .filter((entry) =>
      !entry.roles.isWipColumn
      && !entry.roles.isReviewColumn
      && !entry.roles.isTerminalColumn
      && taskHoldsUnmergedCheckout(entry.holder))
    .map((entry) => entry.holder);
  const checkoutEmptinessByTaskId = await proveDormantCheckoutEmptiness({
    rootDir: () => deps.store.getRootDir(),
    settings,
    candidates: dormantProofCandidates,
  });

  for (const { holder, roles, handoffAccepted } of roleResolvedHolders) {
    const classification = classifyFileScopeLease(holder, tasks, {
      mergeRequestContractShadowEnabled: mergeShadowEnabled,
      handoffAccepted,
      schedulingDependencyOptions,
      /* FNXC:OverlapScheduling 2026-09-08-21:20 (RUFU-200): downgrade-only holder proof. Absent (the
         prover could not run, or the holder was not a dormant candidate) keeps the lease. */
      checkoutEmptiness: checkoutEmptinessByTaskId.get(holder.id),
      /* FNXC:LaneWiring 2026-08-30-00:20: forwarded by name — a spread reads as unwired to the
         lane-wiring census (it reads call sites, not types) and reddens the Lint gate. */
      isWipColumn: roles.isWipColumn,
      isReviewColumn: roles.isReviewColumn,
      isTerminalColumn: roles.isTerminalColumn,
    });
    if (classification.kind === "none") continue;
    const holderScope = normalizeOverlapScopeForTask(holder, filterPathsByIgnoreList(
      await deps.store.parseFileScopeFromPrompt(holder.id),
      overlapIgnorePaths,
      { ignoreHiddenOverlapPaths: settings.ignoreHiddenOverlapPaths },
    ));
    if (holderScope.length === 0 || isCoordinationOnlyTask(holder, holderScope)) continue;
    holders.push({
      task: holder,
      kind: classification.kind,
      scope: holderScope,
      waivedForTaskIds: classification.waivedForTaskIds,
    });
  }

  const activeHolder = holders
    .filter((holder) => holder.kind === "active")
    .sort((left, right) => left.task.id.localeCompare(right.task.id))
    .find((holder) =>
      fileScopeLeaseBlocksCandidate(holder.task, liveTask, {
        kind: holder.kind,
        waivedForTaskIds: holder.waivedForTaskIds,
      }) && pathsOverlap(candidateScope, holder.scope),
    );
  const dormantHolder = activeHolder ? undefined : holders
    .filter((holder) => holder.kind === "dormant")
    .sort((left, right) => compareTasksByQueueOrder(left.task, right.task))
    .find((holder) =>
      fileScopeLeaseBlocksCandidate(holder.task, liveTask, {
        kind: holder.kind,
        waivedForTaskIds: holder.waivedForTaskIds,
      }) && pathsOverlap(candidateScope, holder.scope),
    );
  const blocker = activeHolder ?? dormantHolder;
  if (!blocker) return false;

  await deps.store.transitionQueuedEpisode(liveTask.id, {
    signature: `file-scope:${blocker.task.id}`,
    blockedBy: liveTask.blockedBy ?? null,
    overlapBlockedBy: blocker.task.id,
    action: `queued — waiting for ${blocker.kind} file-scope lease ${blocker.task.id} (column=${blocker.task.column}, lease=${blocker.kind})`,
    outcome: "Executor pre-dispatch file-scope lease gate blocked workflow execution.",
    runContext: deps.getRunContextFor(liveTask.id),
  });
  return true;
}
