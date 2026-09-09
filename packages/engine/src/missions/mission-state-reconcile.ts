import type { MissionFeature, MissionFeatureRepairGroundTruth, MissionTransitionActor, Task, TaskStore, WorkflowSelectionCache } from "@fusion/core";
import { resolveWorkflowIrForTask } from "@fusion/core";
import { createRunAuditor, generateSyntheticRunId } from "../util/run-audit.js";
import { resolveTerminalColumnsFor } from "../executor/lifecycle-columns.js";
import { resolvePlannerLanesForTask } from "../planner-lane-resolution.js";
import { reconcileMissionFeatureState } from "./mission-feature-sync.js";
import { parsePersistedMissionLineage } from "./mission-symbol-admission.js";

export type MissionReconcileSource = "startup" | "self-healing" | "autopilot" | "task-move" | "api" | "tool";
type TerminalCapability = { reconcileFeatureDoneWithTerminalTask(featureId: string, taskId: string): Promise<MissionFeature> };
type RepairCapability = { repairFeatureValidationState(featureId: string, input: Record<string, unknown>): Promise<unknown> };
type MissionApi = {
  getMission?(id: string): Promise<unknown>; listMissions(): Promise<unknown[]>; getMissionWithHierarchy(id: string): Promise<unknown>;
  listAssertionsForFeature?(id: string): Promise<unknown[]>; updateFeatureStatus(id: string, status: string, options: unknown): Promise<unknown>;
  updateFeature?(id: string, updates: Partial<MissionFeature>, options?: unknown): Promise<MissionFeature>;
  linkFeatureToTask?(featureId: string, taskId: string): Promise<MissionFeature>;
};

export function hasTerminalReconcileCapability(missionStore: unknown): missionStore is TerminalCapability {
  return typeof (missionStore as Record<string, unknown> | null | undefined)?.reconcileFeatureDoneWithTerminalTask === "function";
}

export type MissionReconcileExtensionHook = (context: { feature: MissionFeature; task?: Task }) => Promise<void> | void;
/**
 * FNXC:MissionAutoReconcile 2026-08-11-05:20:
 * Dry-run plans are operator-facing mutation previews. Keep task linking and spec-alignment writes distinct from lifecycle status updates so preview mode names the same mutation kind that apply mode performs.
 */
export interface MissionReconcilePassResult {
  missionsScanned: number; featuresScanned: number; statusUpdates: number; badgeRepairs: number;
  badgeRepairsSkipped: number; terminalRepairs: number; terminalSkipped: number; conflicts: number;
  failures: number; skippedReason?: "archived"; planned?: Array<{ featureId: string; action: "status" | "link" | "spec-alignment" | "terminal-done" | "badge-clear" }>;
}
export interface ReconcileMissionStateDeps {
  taskStore: TaskStore; missionStore: object;
  repairFeatureValidationState?: (featureId: string, input: Record<string, unknown>) => Promise<unknown>;
  extensionHook?: MissionReconcileExtensionHook;
}
function actorFor(source: MissionReconcileSource, supplied?: MissionTransitionActor): MissionTransitionActor {
  if (supplied) return supplied;
  if (source === "api" || source === "tool") throw new Error(`Mission reconcile source '${source}' requires an explicit actor`);
  return { type: "system", id: "mission-reconcile", source: `mission-reconcile:${source}` };
}
function titleKey(sliceId: string, title: string): string { return `${sliceId}\0${title.trim().replace(/\s+/g, " ").toLowerCase()}`; }
function lineageKey(missionId: string, sliceId: string, featureId: string): string { return `${missionId}\0${sliceId}\0${featureId}`; }
function hasRepairCapability(store: unknown): store is RepairCapability {
  return typeof (store as Record<string, unknown> | null | undefined)?.repairFeatureValidationState === "function";
}
function liveGroundTruth(feature: MissionFeature, task: Task, laneRole: "wip" | "planner"): MissionFeatureRepairGroundTruth {
  return { featureId: feature.id, taskId: task.id, taskLiveness: "live", taskColumn: task.column, taskUpdatedAt: task.updatedAt, laneRole, resolvedAt: new Date().toISOString() };
}

/*
FNXC:MissionAutoReconcile 2026-08-11-02:39:
This is the single deterministic reconciliation authority. Future git graph, GitHub PR, FR-41
receipt, and FR-51/FN-8845 drift inputs attach through extensionHook rather than adding writers.
The terminal store primitive deliberately owns its terminal-task-reconcile actor and has no actor
parameter; preserve that attribution exception instead of widening its transaction contract.
*/
export async function reconcileMissionState(
  deps: ReconcileMissionStateDeps,
  options: { missionId?: string; source: MissionReconcileSource; actor?: MissionTransitionActor; dryRun?: boolean },
): Promise<MissionReconcilePassResult> {
  const result: MissionReconcilePassResult = { missionsScanned: 0, featuresScanned: 0, statusUpdates: 0, badgeRepairs: 0, badgeRepairsSkipped: 0, terminalRepairs: 0, terminalSkipped: 0, conflicts: 0, failures: 0, ...(options.dryRun ? { planned: [] } : {}) };
  const actor = actorFor(options.source, options.actor);
  const missionApi = deps.missionStore as MissionApi;
  const missions = options.missionId ? [missionApi.getMission ? await missionApi.getMission(options.missionId) : await missionApi.getMissionWithHierarchy(options.missionId)].filter(Boolean) : await missionApi.listMissions();
  const requested = missions[0] as { status?: string } | undefined;
  if (options.missionId && !requested) throw new Error(`Mission ${options.missionId} not found`);
  if (options.missionId && requested?.status === "archived") return { ...result, skippedReason: "archived" };
  const selected = (missions as Array<{ id: string; status: string }>).filter((mission) => mission.status !== "archived");
  const listTasks = (deps.taskStore as unknown as { listTasks?: (options: { slim: boolean; includeArchived: boolean }) => Promise<Task[]> }).listTasks;
  // FNXC:MissionAutoReconcile 2026-08-11-05:20: TaskStore methods use their receiver; optional-capability probing must not detach listTasks from deps.taskStore.
  const liveTasks = listTasks ? await listTasks.call(deps.taskStore, { slim: true, includeArchived: false }) : [];
  const selectedIds = new Set(selected.map((mission) => mission.id));
  type MissionHierarchy = { milestones: Array<{ slices: Array<{ id: string; features: MissionFeature[] }> }> };
  /*
  FNXC:MissionFollowupLifecycle 2026-08-12-00:20:
  Persisted Decision-A lineage is provenance only. Index current hierarchy ownership before
  projecting descendants so a canonically rehomed task cannot keep its former feature open,
  including when both features share a slice or happen to reuse an id elsewhere.
  */
  const selectedHierarchies: Array<{ mission: { id: string; status: string }; hierarchy: MissionHierarchy }> = [];
  const canonicalTaskIds = new Set<string>();
  const knownFeatureLineages = new Set<string>();
  for (const mission of selected) {
    const hierarchy = await missionApi.getMissionWithHierarchy(mission.id) as MissionHierarchy | undefined;
    if (!hierarchy) continue;
    selectedHierarchies.push({ mission, hierarchy });
    for (const slice of hierarchy.milestones.flatMap((milestone) => milestone.slices)) {
      for (const feature of slice.features) {
        knownFeatureLineages.add(lineageKey(mission.id, slice.id, feature.id));
        if (feature.taskId) canonicalTaskIds.add(feature.taskId);
      }
    }
  }
  const byTitle = new Map<string, Task | null>();
  const featuresWithLiveLineageDescendants = new Set<string>();
  /*
  FNXC:MissionReverseLineageCredit 2026-08-17-09:08 (RUFU-109):
  A terminal, non-failed task carrying a feature's reverse `missionLineage` (featureId/sliceId/
  missionId) is an ADDITIONAL satisfying input that credits the feature as meeting its AC,
  independent of the single-valued forward `feature.taskId` link. A feature key lands here only
  when none of its lineage candidates is live, so a live follow-up keeps the feature active.
  */
  const featuresWithDoneLineageDelivery = new Set<string>();
  const lineageCandidates: Array<{ task: Task; key: string }> = [];
  for (const task of liveTasks) {
    if (!task.sliceId || !task.missionId || !selectedIds.has(task.missionId)) continue;
    const lineage = parsePersistedMissionLineage(task);
    if (
      lineage
      && lineage.missionId === task.missionId
      && lineage.sliceId === task.sliceId
      && !canonicalTaskIds.has(task.id)
      && knownFeatureLineages.has(lineageKey(lineage.missionId, lineage.sliceId, lineage.featureId))
    ) {
      lineageCandidates.push({ task, key: lineageKey(lineage.missionId, lineage.sliceId, lineage.featureId) });
    }
    if (task.title) {
      const key = titleKey(task.sliceId, task.title);
      byTitle.set(key, byTitle.has(key) ? null : task);
    }
  }
  const terminalIrCache = new Map<string, Awaited<ReturnType<typeof resolveWorkflowIrForTask>>>();
  const selectionCache: WorkflowSelectionCache = new Map();
  const lineageTaskIds = lineageCandidates.map(({ task }) => task.id);
  if (lineageTaskIds.length > 0) {
    let needsPerTaskFallback = !deps.taskStore.getTaskWorkflowSelectionsAsync;
    try {
      if (deps.taskStore.getTaskWorkflowSelectionsAsync) {
        const selections = await deps.taskStore.getTaskWorkflowSelectionsAsync(lineageTaskIds);
        for (const taskId of lineageTaskIds) selectionCache.set(taskId, selections.get(taskId));
      }
    } catch {
      needsPerTaskFallback = true;
    }
    if (needsPerTaskFallback) {
      await Promise.all(lineageTaskIds.map(async (taskId) => {
        try { selectionCache.set(taskId, await deps.taskStore.getTaskWorkflowSelectionAsync(taskId)); } catch { /* FNXC:MissionFollowupLifecycle 2026-08-12-00:20: Preserve fail-soft default workflow resolution after a selection read failure. */ }
      }));
    }
  }
  const lineageBatchSize = 8;
  /*
  FNXC:MissionReverseLineageCredit 2026-08-17-09:08 (RUFU-109):
  Each lineage candidate records whether it keeps its feature live AND whether it is a satisfied
  done-lineage delivery. The liveness classification reuses the existing `resolveTerminalColumnsFor`
  call unchanged; a live, non-failed workflow Complete candidate additionally credits its feature.
  A feature key is added to
  `featuresWithDoneLineageDelivery` only when none of its candidates is live.
  */
  const lineageDeliverySnapshot = new Map<string, { hasLive: boolean; hasSatisfyingDoneDelivery: boolean; satisfyingTask?: Task }>();
  for (let index = 0; index < lineageCandidates.length; index += lineageBatchSize) {
    const batch = lineageCandidates.slice(index, index + lineageBatchSize);
    const snapshot = await Promise.all(batch.map(async ({ task, key }) => {
      const terminalColumns = await resolveTerminalColumnsFor(deps.taskStore, task.id, terminalIrCache, selectionCache);
      /*
      FNXC:MissionReconcileLiveTasks 2026-08-19-21:44 (RUFU-134 / PR #3491):
      liveTasks comes from listTasks({ includeArchived: false }) with includeDeleted UNSET, so
      soft-deleted rows never reach this loop (VAL-DATA-005: live readers leave tombstoned tasks
      off the board). The deletedAt arms in isLive/isDoneDelivery were therefore dead and are
      deleted; a tombstone's retained-evidence classification belongs to the store's terminal
      evidence query, not this snapshot.
      */
      const isLive = !terminalColumns.includes(task.column);
      const isDoneDelivery = !task.error && task.status !== "failed" && terminalColumns.includes(task.column);
      return { key, isLive, isDoneDelivery, task };
    }));
    for (const candidate of snapshot) {
      if (candidate.isLive) featuresWithLiveLineageDescendants.add(candidate.key);
      const prior = lineageDeliverySnapshot.get(candidate.key);
      lineageDeliverySnapshot.set(candidate.key, {
        hasLive: (prior?.hasLive ?? false) || candidate.isLive,
        hasSatisfyingDoneDelivery: (prior?.hasSatisfyingDoneDelivery ?? false) || candidate.isDoneDelivery,
        satisfyingTask: candidate.isDoneDelivery ? (prior?.satisfyingTask ?? candidate.task) : prior?.satisfyingTask,
      });
    }
  }
  /* FNXC:MissionReverseLineageSpecAlignment 2026-08-19-21:44 (RUFU-134 / PR #3491): first satisfying delivery per key, remembered so the reverse-credit branch can project spec alignment against the real delivery task. */
  const lineageSatisfyingTasks = new Map<string, Task>();
  for (const [key, delivery] of lineageDeliverySnapshot) {
    if (!delivery.hasLive && delivery.hasSatisfyingDoneDelivery) {
      featuresWithDoneLineageDelivery.add(key);
      if (delivery.satisfyingTask) lineageSatisfyingTasks.set(key, delivery.satisfyingTask);
    }
  }
  for (const { mission, hierarchy } of selectedHierarchies) {
    result.missionsScanned++;
    for (const slice of hierarchy.milestones.flatMap((milestone) => milestone.slices)) {
      const featureTitleCounts = new Map<string, number>();
      for (const feature of slice.features) {
        const key = titleKey(slice.id, feature.title);
        featureTitleCounts.set(key, (featureTitleCounts.get(key) ?? 0) + 1);
      }
      for (const originalFeature of slice.features) {
        result.featuresScanned++;
        try {
        let feature = originalFeature;
        const explicitTaskId = feature.taskId;
        /* FNXC:MissionAutoReconcile 2026-08-11-02:39: A generated remediation detached by supersedence is terminal, never a title-link candidate. */
        if (!explicitTaskId && feature.status === "done" && (feature.generatedFromFeatureId || feature.generatedFromRunId)) continue;
        const featureLineageKey = lineageKey(mission.id, slice.id, feature.id);
        const hasDoneLineageDelivery = featuresWithDoneLineageDelivery.has(featureLineageKey);
        const hasLiveLineage = featuresWithLiveLineageDescendants.has(featureLineageKey);
        const task = explicitTaskId ? await deps.taskStore.getTask(explicitTaskId) ?? undefined : byTitle.get(titleKey(slice.id, feature.title)) ?? undefined;
        if (!explicitTaskId && task && missionApi.linkFeatureToTask && featureTitleCounts.get(titleKey(slice.id, feature.title)) === 1) {
          /*
          FNXC:MissionAutoReconcile 2026-08-11-03:27:
          Automatic title repair is safe only when exactly one live task and one feature share the
          normalized title in this slice. Do not attach a moved task to an arbitrary duplicate
          feature; an operator must make ambiguous roadmap ownership explicit.
          */
          if (options.dryRun) result.planned!.push({ featureId: feature.id, action: "link" });
          else feature = await missionApi.linkFeatureToTask(feature.id, task.id);
        }
        /*
        FNXC:MissionReverseLineageCredit 2026-08-17-09:08 (RUFU-109):
        A done reverse-lineage delivery is an ADDITIONAL satisfying input. It must not bypass the
        live-lineage done-withholding (`hasLiveLineage` takes precedence and keeps the feature
        active), and it must leave the single-valued forward-link `feature.taskId` untouched — never
        call `updateFeature` or `linkFeatureToTask` in this branch. Reuses the forward-path badge-clear
        so an already-passed validation is not left needing repair.
        */
        if (hasDoneLineageDelivery && !hasLiveLineage && feature.status !== "done") {
          const reverseNeedsRepair = feature.status === "blocked" || feature.loopState === "blocked" || feature.loopState === "needs_fix";
          const assertions = missionApi.listAssertionsForFeature ? await missionApi.listAssertionsForFeature(feature.id) : [];
          if (options.dryRun) result.planned!.push({ featureId: feature.id, action: "status" });
          else { await missionApi.updateFeatureStatus(feature.id, "done", { actor }); result.statusUpdates++; }
          if (reverseNeedsRepair) {
            const complete = !assertions.length || feature.lastValidatorStatus === "passed";
            if (complete && !task?.error && task?.status !== "failed") {
              const repair = deps.repairFeatureValidationState ?? (hasRepairCapability(deps.missionStore) ? deps.missionStore.repairFeatureValidationState.bind(deps.missionStore) : undefined);
              if (!repair) result.badgeRepairsSkipped++;
              else if (options.dryRun) result.planned!.push({ featureId: feature.id, action: "badge-clear" });
              else {
                try { await repair(feature.id, { action: "clear", actor }); result.badgeRepairs++; }
                catch { result.conflicts++; }
              }
            }
          }
          /*
          FNXC:MissionReverseLineageSpecAlignment 2026-08-19-21:44 (RUFU-134 / PR #3491):
          The reverse-credit branch used to stop at the status credit and skip the spec-alignment
          projection that the live path always applies, so a reverse-lineage-credited feature kept
          a stale specAlignment until some other pass touched its forward link. Project the same
          alignment against the SATISFYING delivery task (the title-matched `task` here may be
          absent or unrelated — the feature has no forward link to it); only decision.alignment
          is consumed, the status decision is ignored (the branch already credited done).
          Fail-soft per the capability guard: no captured delivery task or no write capability
          skips the projection, exactly like the live path.
          */
          const satisfyingTask = lineageSatisfyingTasks.get(featureLineageKey);
          if (satisfyingTask) {
            /* FNXC:MissionReverseLineageSpecAlignment 2026-08-19-21:44 (RUFU-134 / PR #3491): the snapshot loop already resolved this delivery's selection and IR (resolveTerminalColumnsFor), so reusing both caches keeps the projection read-free instead of triggering a second per-task selection read. */
            const plannerColumns = await resolvePlannerLanesForTask(deps.taskStore, satisfyingTask.id, terminalIrCache, selectionCache) ?? [];
            const decision = await reconcileMissionFeatureState(deps.taskStore, satisfyingTask, feature, {
              hasLinkedAssertions: assertions.length > 0,
              hasLiveLineageDescendants: false,
              plannerColumns,
            }, { irCache: terminalIrCache, selectionCache });
            if (feature.specAlignment !== decision.alignment && missionApi.updateFeature) {
              if (options.dryRun) result.planned!.push({ featureId: feature.id, action: "spec-alignment" });
              else await missionApi.updateFeature(feature.id, { specAlignment: decision.alignment }, { actor });
            }
          }
          await deps.extensionHook?.({ feature, task });
          continue;
        }
        if (task) {
          const assertions = missionApi.listAssertionsForFeature ? await missionApi.listAssertionsForFeature(feature.id) : [];
          const plannerColumns = await resolvePlannerLanesForTask(deps.taskStore, task.id, terminalIrCache, selectionCache) ?? [];
          const decision = await reconcileMissionFeatureState(deps.taskStore, task, feature, {
            hasLinkedAssertions: assertions.length > 0,
            hasLiveLineageDescendants: featuresWithLiveLineageDescendants.has(lineageKey(mission.id, slice.id, feature.id)),
            plannerColumns,
          }, { irCache: terminalIrCache, selectionCache });
          const needsRepair = feature.status === "blocked" || feature.loopState === "blocked" || feature.loopState === "needs_fix";
          if (decision.kind === "update" && feature.status !== decision.status) {
            if (options.dryRun) result.planned!.push({ featureId: feature.id, action: "status" });
            else { await missionApi.updateFeatureStatus(feature.id, decision.status, { actor }); result.statusUpdates++; }
          }
          /*
          FNXC:MissionAutoReconcile 2026-08-11-03:10:
          Reconciliation has always projected spec alignment independently of delivery status.
          Preserve that projection even when the lifecycle decision is a no-op, while routing its
          write through the same explicit actor boundary as every automatic reconcile mutation.
          Dry-run previews must also require that write capability so they never promise an unavailable mutation.
          */
          if (feature.specAlignment !== decision.alignment && missionApi.updateFeature) {
            if (options.dryRun) result.planned!.push({ featureId: feature.id, action: "spec-alignment" });
            else await missionApi.updateFeature(feature.id, { specAlignment: decision.alignment }, { actor });
          }
          const wip = task.column !== undefined && !plannerColumns.includes(task.column) && decision.kind === "update" && decision.status === "in-progress";
          const complete = decision.kind === "update" && decision.status === "done" && (!assertions.length || feature.lastValidatorStatus === "passed");
          if (needsRepair && (complete || wip) && !task.error && task.status !== "failed") {
            const repair = deps.repairFeatureValidationState ?? (hasRepairCapability(deps.missionStore) ? deps.missionStore.repairFeatureValidationState.bind(deps.missionStore) : undefined);
            if (!repair) result.badgeRepairsSkipped++;
            else if (options.dryRun) result.planned!.push({ featureId: feature.id, action: "badge-clear" });
            else {
              try {
                await repair(feature.id, { action: "clear", actor, ...(feature.status === "blocked" && wip ? { resolvedStatus: "in-progress", groundTruth: liveGroundTruth(feature, task, "wip") } : {}) });
                result.badgeRepairs++;
              } catch { result.conflicts++; }
            }
          }
          await deps.extensionHook?.({ feature, task });
          continue;
        }
        // Missing or deleted task links never fabricate terminal delivery evidence.
        await deps.extensionHook?.({ feature });
        } catch { result.failures++; }
      }
    }
  }
  if (!options.dryRun && result.featuresScanned > 0 && (result.statusUpdates + result.badgeRepairs + result.terminalRepairs + result.failures > 0)) try {
    const auditor = createRunAuditor(deps.taskStore, { runId: generateSyntheticRunId("mission-reconcile", options.missionId ?? "project"), agentId: "mission-reconcile", phase: "mission-reconcile" });
    await auditor.database({ type: "mission:reconcile-pass", target: options.missionId ?? "project", metadata: { ...(options.missionId ? { missionId: options.missionId } : {}), source: options.source, missionsScanned: result.missionsScanned, featuresScanned: result.featuresScanned, statusUpdates: result.statusUpdates, badgeRepairs: result.badgeRepairs, badgeRepairsSkipped: result.badgeRepairsSkipped, terminalRepairs: result.terminalRepairs, terminalSkipped: result.terminalSkipped, conflicts: result.conflicts, failures: result.failures } });
  } catch { /* audit is observability only */ }
  return result;
}
