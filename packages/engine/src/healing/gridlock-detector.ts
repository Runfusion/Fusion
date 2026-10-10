/*
FNXC:CapacityModel 2026-07-29-15:00 (capacity-simplification audit — KEEP, with evidence):
ASKED AND ANSWERED: does gridlock detection still have a job once capacity is two
numbers and the competing limiters are gone?

YES. "Gridlock" here has nothing to do with limiters arbitrating against each other.
`GridlockEvent.reasons` is typed `"dependency" | "overlap"` — it detects DEPENDENCY
deadlock and FILE-SCOPE OVERLAP deadlock, using `pathsOverlap` /
`filterPathsByIgnoreList` from the scheduler. Neither is affected by removing the
cross-project cap, the spawn budgets, or the worktree gate: two tasks can still
block each other on a dependency cycle or a shared file scope no matter how many
agents the operator allows.

Measured, not assumed: no CODE in this file references maxConcurrent, maxWorktrees, the shared
semaphore, or any slot/capacity accounting — the only occurrences of those words are in this note.
It is live and wired (project-engine.ts -> notifier.notifyGridlock).

Recorded here because the natural reading of the NAME is "limiters deadlocking", and
deleting a live detector on that reading would remove real coverage silently. If a
future cleanup revisits this, the question to ask is whether dependency and overlap
deadlock are still possible — not whether capacity is simpler.
*/
import type { AgentStore, MissionStore, Task, TaskStore, WorkflowIr } from "@fusion/core";
import { compareTasksByQueueOrder, fileScopeLeaseBlocksCandidate, normalizeOverlapScopeForTask, resolveTaskLifecycleColumns, resolveWorkflowIrForTask, columnsWithFlag, taskHoldsUnmergedCheckout } from "@fusion/core";
import { createLogger } from "../logger.js";
import { classifyFileScopeLease, filterPathsByIgnoreList, isCoordinationOnlyTask, pathsOverlap, resolveDependencySatisfactionColumns } from "../scheduler.js";
import { proveDormantCheckoutEmptiness } from "../worktree/checkout-emptiness.js";

const gridlockLog = createLogger("gridlock-detector");

export type GridlockReason = "dependency" | "overlap" | "ownership";

export interface GridlockOwnershipBlocker {
  rootTaskId: string;
  agentId?: string;
  reason: "missing-agent" | "unavailable-agent" | "manual-control";
}

export interface GridlockEvent {
  blockedTaskCount: number;
  reasons: Record<string, GridlockReason>;
  blockedTaskIds: string[];
  blockingTaskIds: string[];
  /** Maps each blocked dependent to the root ownership condition that holds it. */
  ownershipBlockers: Record<string, GridlockOwnershipBlocker>;
}

export interface GridlockDetectorOptions {
  pollIntervalMs?: number;
  missionStore?: MissionStore;
  agentStore?: AgentStore;
  onGridlock?: (event: GridlockEvent) => void;
  onGridlockCleared?: () => void;
}

export class GridlockDetector {
  private interval: ReturnType<typeof setInterval> | null = null;
  private readonly pollIntervalMs: number;
  private readonly missionStore?: MissionStore;
  private readonly agentStore?: AgentStore;
  private readonly onGridlock?: (event: GridlockEvent) => void;
  private readonly onGridlockCleared?: () => void;
  private lastGridlockKey: string | null = null;

  constructor(
    private readonly store: TaskStore,
    options: GridlockDetectorOptions = {},
  ) {
    this.pollIntervalMs = options.pollIntervalMs ?? 30_000;
    this.missionStore = options.missionStore;
    this.agentStore = options.agentStore;
    this.onGridlock = options.onGridlock;
    this.onGridlockCleared = options.onGridlockCleared;
  }

  start(): void {
    if (this.interval) return;
    this.interval = setInterval(() => {
      this.detectGridlock().catch((error) => {
        gridlockLog.error("Failed gridlock detection cycle:", error);
      });
    }, this.pollIntervalMs);
    gridlockLog.log(`Started (poll interval: ${this.pollIntervalMs}ms)`);
  }

  stop(): void {
    if (!this.interval) return;
    clearInterval(this.interval);
    this.interval = null;
    gridlockLog.log("Stopped");
  }

  async detectGridlock(): Promise<GridlockEvent | null> {
    /*
    FNXC:ListTasksDeriveOptOut 2026-09-08-23:08 (RUFU-201 — gridlock sweep):
    The 5 s sweep reads persisted fields only: directly in `detectGridlock`/`isMissionBlocked` it reads
    id, column, paused, nextRecoveryAt and sliceId; through `classifyFileScopeLease` it reads column,
    deletedAt, worktree, workspaceWorktrees and dependencies; through `normalizeOverlapScopeForTask`
    workspaceWorktrees; through `isCoordinationOnlyTask` noCommitsExpected and sourceMetadata; through
    the priority/age tie-break priority, createdAt and id. None is a derived badge — grepping this file
    for the derived fields returns nothing. Settings stay correct because this site calls
    `store.getSettings()` itself; `derive: false` only skips the derivation block's internal fast read.
    */
    const [tasks, settings] = await Promise.all([
      /* FNXC:TaskLogProjections 2026-10-10-20:15 (RUFU-615): the field audit above already proves no consumer reads `log`, and `derive: false` means nothing here needs the projections either — so this takes the column off the SELECT. Measured on a distribution-matched 2 417-row board: `{derive:false}` 372 ms median vs `{derive:false, excludeLog:true}` 206 ms. */
      this.store.listTasks({ slim: true, includeArchived: false, derive: false, excludeLog: true }),
      this.store.getSettings(),
    ]);

    const now = Date.now();
    /*
    FNXC:UnownedHoldColumnGates 2026-07-29-13:20 (U7 / R3):
    "Schedulable" is the HOLD role, not the id `todo`. Keyed on the literal, a
    renamed workflow produced an EMPTY schedulable set, and the detector returns
    early on empty — so it reported "no gridlock" on precisely the boards where
    every card was stuck. A detector that goes quiet on the boards it cannot parse
    is worse than one that is absent, because its silence reads as health.

    One IR cache for the pass, so N cards on M workflows cost M resolutions (the
    shape `runHoldReleaseSweep` and triage discovery both use). A card whose
    workflow will not resolve is NOT schedulable — this decides whether to raise an
    alarm, and inventing candidates would raise false ones.
    */
    const irCache = new Map<string, WorkflowIr>();
    /*
    FNXC:GridlockLifecycleResolution 2026-09-08-23:08 (RUFU-201):
    One lifecycle resolution per card per pass, keyed by id and read by BOTH classification loops.
    Resolving twice was not merely redundant: each uncached call re-issued a live workflow-selection
    read per card and re-ran the non-memoized column resolution, so a pass of N cards cost 2N of them.
    Building the map eagerly costs exactly what the schedulable loop cost before, because that loop ran
    first and resolved every card anyway before the empty-set early return. Storing the full struct
    keeps the previous truthiness contract: a struct with all-undefined roles was truthy then and is
    truthy now, so consumers still pass explicit `false` role answers rather than legacy literals, and
    id-keyed lookups are iteration-order independent. A side effect in the safe direction: the two
    loops used to resolve independently, so a selection write landing between them could give one card
    role answers from two different workflows.
    */
    const lifecycleByTask = new Map<string, Awaited<ReturnType<typeof resolveTaskLifecycleColumns>>>();
    for (const task of tasks) {
      lifecycleByTask.set(task.id, await resolveTaskLifecycleColumns(this.store, task.id, irCache));
    }
    const schedulable = tasks.filter((task) => {
      const hold = lifecycleByTask.get(task.id)?.hold;
      if (hold === undefined || task.column !== hold || task.paused) return false;
      if (task.nextRecoveryAt && new Date(task.nextRecoveryAt).getTime() > now) return false;
      if (this.isMissionBlocked(task)) return false;
      return true;
    });

    if (schedulable.length === 0) {
      this.clearGridlockState();
      return null;
    }

    /*
    FNXC:OverlapScheduling 2026-08-29-06:04:
    Gridlock reporting must use the same active/dormant lease classification as admission. A preserved
    worktree outside WIP or review remains a dormant holder, and priority → age → id picks the one
    holder that genuinely blocks a waiting card instead of reporting its files as free.

/*
    FNXC:OverlapScheduling 2026-09-01-14:49:
    Checkout-free planning cards are not overlap holders and cannot manufacture a planning gridlock;
    a retained checkout remains the durable evidence for a genuine dormant-holder cycle.
    */
    const handoffAcceptedByTaskId = new Map<string, boolean>();
    if (settings.mergeRequestContractShadowEnabled === true) {
      for (const task of tasks) {
        const roles = lifecycleByTask.get(task.id);
        if (roles?.review === task.column) {
          handoffAcceptedByTaskId.set(task.id, (await this.store.getCompletionHandoffAcceptedMarker(task.id)) !== null);
        }
      }
    }
    /*
    FNXC:OverlapScheduling 2026-09-08-21:35 (RUFU-200):
    The detector must reach the SAME lease verdict as admission for the same holder, otherwise it reports
    a gridlock the scheduler has already resolved (or stays silent about one it cannot resolve). It
    therefore consumes the same downgrade-only checkout-emptiness proof over the same shared prover.
    Candidates are limited to holders whose lane could actually change; an unresolved-roles task is
    proven rather than filtered on legacy column literals, which this file must not restate.
    */
    const dormantProofCandidates = tasks.filter((task) => {
      if (task.deletedAt || !taskHoldsUnmergedCheckout(task)) return false;
      const roles = lifecycleByTask.get(task.id);
      if (!roles) return true;
      return roles.wip !== task.column && roles.review !== task.column && roles.complete !== task.column;
    });
    const checkoutEmptinessByTaskId = await proveDormantCheckoutEmptiness({
      rootDir: () => this.store.getRootDir(),
      settings,
      candidates: dormantProofCandidates,
    });

    const schedulingDependencyOptions = {
      satisfactionColumnsByTaskId: await resolveDependencySatisfactionColumns(this.store, tasks, irCache),
    };
    const classifications = new Map(
      tasks.map((task) => {
        const roles = lifecycleByTask.get(task.id);
        return [task.id, classifyFileScopeLease(task, tasks, roles
          ? {
            schedulingDependencyOptions,
            mergeRequestContractShadowEnabled: settings.mergeRequestContractShadowEnabled,
            handoffAccepted: handoffAcceptedByTaskId.get(task.id) ?? false,
            checkoutEmptiness: checkoutEmptinessByTaskId.get(task.id),
            isWipColumn: roles.wip === task.column,
            isReviewColumn: roles.review === task.column,
            isTerminalColumn: roles.complete === task.column,
          }
          : {
            schedulingDependencyOptions,
            mergeRequestContractShadowEnabled: settings.mergeRequestContractShadowEnabled,
            handoffAccepted: handoffAcceptedByTaskId.get(task.id) ?? false,
            checkoutEmptiness: checkoutEmptinessByTaskId.get(task.id),
          })] as const;
      }),
    );
    const leaseHolders = tasks.filter((task) => classifications.get(task.id)?.kind !== "none");

    const overlapIgnorePaths = settings.overlapIgnorePaths ?? [];
    const filterOptions = { ignoreHiddenOverlapPaths: settings.ignoreHiddenOverlapPaths };
    const activeLeaseHolders = leaseHolders
      .filter((task) => classifications.get(task.id)?.kind === "active")
      .sort((a, b) => a.id.localeCompare(b.id));
    const dormantLeaseHolders = leaseHolders
      .filter((task) => classifications.get(task.id)?.kind === "dormant")
      .sort(compareTasksByQueueOrder);
    const leaseScopes = new Map<string, string[]>();
    if (settings.groupOverlappingFiles) {
      for (const holder of leaseHolders) {
        const scope = normalizeOverlapScopeForTask(
          holder,
          filterPathsByIgnoreList(await this.store.parseFileScopeFromPrompt(holder.id), overlapIgnorePaths, filterOptions),
        );
        if (scope.length > 0 && !isCoordinationOnlyTask(holder, scope)) {
          leaseScopes.set(holder.id, scope);
        }
      }
    }

    const reasons: Record<string, GridlockReason> = {};
    const blockingTaskIds = new Set<string>();
    const ownershipBlockers: Record<string, GridlockOwnershipBlocker> = {};

    /*
    FNXC:WorkflowResolvedColumns 2026-07-30-10:55 (batch-engine tail):
    "Is this dependency satisfied?" resolved per DEPENDENCY, not per dependent: a blocker's OWN workflow
    decides when it stops blocking, and the two tasks need not share one.

    On a renamed board every one of these three comparisons was true for a finished blocker, so NO
    dependency ever counted as met — the detector then reports dependency gridlock for tasks that are
    not actually blocked, and `notifyGridlock` pages the operator about it.

    REVIEW COUNTS AS SATISFIED, deliberately, and via the SAME five flags the executor dependency gate
    uses — `review` is not a trait: the role is carried by mergeOrchestration/mergeBlocker/humanReview.
    Two gates answering "is this dependency satisfied?" differently is a split brain. A dependent may
    start once its blocker reaches review. Collapsing this to complete-only is the flattening that
    deadlocks a board, so the three roles stay a union rather than becoming `resolveLifecycleColumns`'s
    first-per-role.

    Unioned with the legacy review/completion pair because `resolveWorkflowIrForTask` returns the built-in IR for a missing
    or corrupt workflow rather than throwing; without the union a degraded board resolves a satisfied set
    that excludes its own terminal lanes and every dependency reads as unmet.
    */
    const satisfiedColumnsByTaskId = new Map<string, ReadonlySet<string>>();
    for (const task of tasks) {
      const columns = new Set<string>(["done", "in-review"]);
      try {
        const ir = await resolveWorkflowIrForTask(this.store, task.id, irCache);
        if (ir) {
          for (const flag of ["complete", "mergeOrchestration", "mergeBlocker", "humanReview"] as const) {
            for (const id of columnsWithFlag(ir, flag)) columns.add(id);
          }
        }
      } catch { /* degraded: legacy pair only */ }
      satisfiedColumnsByTaskId.set(task.id, columns);
    }

    for (const task of schedulable) {
      const unmetDeps = task.dependencies.filter((depId) => {
        const dep = tasks.find((candidate) => candidate.id === depId);
        return dep !== undefined && satisfiedColumnsByTaskId.get(dep.id)?.has(dep.column) !== true;
      });

      if (unmetDeps.length > 0) {
        const ownershipBlocker = await this.findOwnershipBlocker(unmetDeps, tasks);
        reasons[task.id] = ownershipBlocker ? "ownership" : "dependency";
        if (ownershipBlocker) {
          ownershipBlockers[task.id] = ownershipBlocker;
          blockingTaskIds.add(ownershipBlocker.rootTaskId);
        } else {
          for (const depId of unmetDeps) blockingTaskIds.add(depId);
        }
        continue;
      }

      if (!settings.groupOverlappingFiles) continue;

      const taskScope = normalizeOverlapScopeForTask(
        task,
        filterPathsByIgnoreList(await this.store.parseFileScopeFromPrompt(task.id), overlapIgnorePaths, filterOptions),
      );
      if (taskScope.length === 0 || isCoordinationOnlyTask(task, taskScope)) continue;

      const findBlockingHolder = (holders: readonly Task[]): Task | undefined => holders.find((holder) => {
        const classification = classifications.get(holder.id);
        const holderScope = leaseScopes.get(holder.id);
        return classification !== undefined
          && holderScope !== undefined
          && fileScopeLeaseBlocksCandidate(holder, task, classification)
          && pathsOverlap(taskScope, holderScope);
      });
      const holder = findBlockingHolder(activeLeaseHolders) ?? findBlockingHolder(dormantLeaseHolders);
      if (holder) {
        reasons[task.id] = "overlap";
        blockingTaskIds.add(holder.id);
      }
    }

    const blockedTaskIds = Object.keys(reasons).sort();
    if (blockedTaskIds.length !== schedulable.length) {
      this.clearGridlockState();
      return null;
    }

    const gridlockKey = JSON.stringify({ blockedTaskIds, reasons, ownershipBlockers });
    const event: GridlockEvent = {
      blockedTaskCount: blockedTaskIds.length,
      reasons,
      blockedTaskIds,
      blockingTaskIds: Array.from(blockingTaskIds).sort(),
      ownershipBlockers,
    };

    if (this.lastGridlockKey !== gridlockKey) {
      this.lastGridlockKey = gridlockKey;
      gridlockLog.warn(`Gridlock detected: blocked=${event.blockedTaskIds.join(",")}; blocking=${event.blockingTaskIds.join(",")}`);
      this.onGridlock?.(event);
    }

    return event;
  }

  /*
  FNXC:DurableAgentHandoff 2026-10-04-16:42:
  A downstream task blocked through one or more dependency edges by a protected
  or unavailable durable root is not a dependency cycle. Walk the unmet chain
  with a cycle fence and name that root ownership fence, so operators can repair
  the owner without reordering work.
  */
  private async findOwnershipBlocker(
    dependencyIds: readonly string[],
    tasks: readonly Task[],
  ): Promise<GridlockOwnershipBlocker | undefined> {
    const tasksById = new Map(tasks.map((task) => [task.id, task]));
    const pending = [...dependencyIds];
    const visited = new Set<string>();

    while (pending.length > 0) {
      const rootTaskId = pending.shift()!;
      if (visited.has(rootTaskId)) continue;
      visited.add(rootTaskId);

      const root = tasksById.get(rootTaskId);
      const agentId = root?.assignedAgentId;
      if (root && agentId) {
        if (root.userPaused || (root.paused === true && root.pausedByAgentId !== agentId)) {
          return { rootTaskId, agentId, reason: "manual-control" };
        }
        if (this.agentStore) {
          const owner = await this.agentStore.getAgent(agentId);
          if (!owner) return { rootTaskId, agentId, reason: "missing-agent" };
          if (owner.state === "paused" || owner.state === "error") {
            return { rootTaskId, agentId, reason: "unavailable-agent" };
          }
        }
      }

      if (root) pending.push(...root.dependencies);
    }
    return undefined;
  }

  private clearGridlockState(): void {
    if (this.lastGridlockKey !== null) {
      this.lastGridlockKey = null;
      this.onGridlockCleared?.();
    }
  }

  private isMissionBlocked(task: Task): boolean {
    if (!this.missionStore || !task.sliceId) return false;
    try {
      const slice = this.missionStore.getSlice(task.sliceId);
      if (!slice) return false;
      const milestone = this.missionStore.getMilestone(slice.milestoneId);
      if (!milestone) return false;
      const mission = this.missionStore.getMission(milestone.missionId);
      return mission?.status === "blocked";
    } catch (error) {
      gridlockLog.warn(`Mission lookup failed for ${task.id}:`, error);
      return false;
    }
  }
}
