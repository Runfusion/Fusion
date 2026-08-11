import type { MissionFeature, MissionFeatureRepairGroundTruth, MissionTransitionActor, Task, TaskStore } from "@fusion/core";
import { TerminalTaskReconciliationError, resolveLifecycleColumns, resolveWorkflowIrForTask } from "@fusion/core";
import { createRunAuditor, generateSyntheticRunId } from "../util/run-audit.js";
import { resolvePlannerLanesForTask } from "../planner-lane-resolution.js";
import { reconcileMissionFeatureState } from "./mission-feature-sync.js";

export type MissionReconcileSource = "startup" | "self-healing" | "autopilot" | "task-move" | "api" | "tool";
type TerminalCapability = { reconcileFeatureDoneWithTerminalTask(featureId: string, taskId: string): Promise<MissionFeature> };
type RepairCapability = { repairFeatureValidationState(featureId: string, input: Record<string, unknown>): Promise<unknown> };
type MissionApi = {
  getMission?(id: string): Promise<unknown>; listMissions(): Promise<unknown[]>; getMissionWithHierarchy(id: string): Promise<unknown>;
  listAssertionsForFeature?(id: string): Promise<unknown[]>; updateFeatureStatus(id: string, status: string, options: unknown): Promise<unknown>;
  updateFeature?(id: string, updates: Partial<MissionFeature>, options?: unknown): Promise<MissionFeature>;
  linkFeatureToTask?(featureId: string, taskId: string): Promise<MissionFeature>;
};

/*
FNXC:MissionAutoReconcile 2026-08-11-02:39:
The dashboard mission-store Proxy has only a get trap over an empty target, so `in` and hasOwn
report optional methods as absent. A property-read typeof probe works for that Proxy and concrete
stores, preventing terminal archived delivery repair from being silently disabled.
*/
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
function hasRepairCapability(store: unknown): store is RepairCapability {
  return typeof (store as Record<string, unknown> | null | undefined)?.repairFeatureValidationState === "function";
}
/*
FNXC:MissionAutoReconcile 2026-08-11-04:57 DELIBERATE-LITERAL:
The physical archived lane remains a compatibility terminal signal before workflow resolution; custom workflows are checked against their resolved archived lane immediately afterward.
*/
async function isArchivedTask(taskStore: TaskStore, task: Task): Promise<boolean> {
  if (task.deletedAt || task.column === "archived") return true;
  const ir = await resolveWorkflowIrForTask(taskStore, task.id).catch(() => undefined);
  return ir ? resolveLifecycleColumns(ir)?.archived === task.column : false;
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
  const byTitle = new Map<string, Task | null>();
  for (const task of liveTasks) {
    if (!task.sliceId || !task.title || !task.missionId || !selectedIds.has(task.missionId)) continue;
    const key = titleKey(task.sliceId, task.title);
    byTitle.set(key, byTitle.has(key) ? null : task);
  }
  for (const mission of selected) {
    const hierarchy = await missionApi.getMissionWithHierarchy(mission.id) as { milestones: Array<{ slices: Array<{ id: string; features: MissionFeature[] }> }> } | undefined;
    if (!hierarchy) continue;
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
        const terminalCandidate = Boolean(explicitTaskId && task && await isArchivedTask(deps.taskStore, task));
        if (!terminalCandidate && task) {
          const assertions = missionApi.listAssertionsForFeature ? await missionApi.listAssertionsForFeature(feature.id) : [];
          const plannerColumns = await resolvePlannerLanesForTask(deps.taskStore, task.id) ?? [];
          const decision = await reconcileMissionFeatureState(deps.taskStore, task, feature, { hasLinkedAssertions: assertions.length > 0, plannerColumns });
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
        // Only explicit links may establish terminal evidence; title matching never fabricates completion.
        if (explicitTaskId && !(feature.status === "done" && feature.taskId === explicitTaskId)) {
          const terminal = hasTerminalReconcileCapability(deps.missionStore) ? deps.missionStore.reconcileFeatureDoneWithTerminalTask.bind(deps.missionStore) : undefined;
          if (!terminal) result.terminalSkipped++;
          else if (options.dryRun) result.planned!.push({ featureId: feature.id, action: "terminal-done" });
          else try { await terminal(feature.id, explicitTaskId); result.terminalRepairs++; }
          catch (error) {
            if (error instanceof TerminalTaskReconciliationError) {
              if (error.code === "FEATURE_TASK_CONFLICT" || error.code === "TASK_FEATURE_CONFLICT") result.conflicts++; else result.terminalSkipped++;
            } else result.failures++;
          }
        }
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
