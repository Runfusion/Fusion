import { createRoadmapStoreForTaskStore } from "@fusion-plugin-examples/roadmap";
import type {
  NativeStructurePreviewPayload,
  NativeStructurePreviewResult,
  NativeStructureRef,
  TaskStore,
} from "@fusion/core";

const KIND_LABELS: Record<NativeStructureRef["kind"], string> = {
  mission: "Mission",
  milestone: "Milestone",
  "research-finding": "Research finding",
  "eval-result": "Evaluation result",
  goal: "Goal",
  "roadmap-item": "Roadmap item",
};
const MAX_EXCERPT_LENGTH = 180;

function unavailable(ref: NativeStructureRef, reason: "missing" | "soft-deleted"): NativeStructurePreviewResult {
  return { available: false, kind: ref.kind, id: ref.id, reason };
}

function preview(
  ref: NativeStructureRef,
  title: string,
  excerpt: string,
  openTarget: NativeStructurePreviewPayload["openTarget"],
): NativeStructurePreviewPayload {
  return { available: true, kind: ref.kind, kindLabel: KIND_LABELS[ref.kind], title, excerpt, openTarget };
}

function text(value: string | null | undefined, fallback: string): string {
  const normalized = value?.replace(/\s+/g, " ").trim();
  const resolved = normalized || fallback;
  return resolved.length <= MAX_EXCERPT_LENGTH
    ? resolved
    : `${resolved.slice(0, MAX_EXCERPT_LENGTH - 1).trimEnd()}…`;
}

/**
 * FNXC:NativeStructureEmbed 2026-07-16-12:00:
 * This is a read-only projection over the task-scoped stores; it never duplicates structure
 * persistence. Existing archived/dismissed lifecycle status supplies `soft-deleted` because no
 * target has a tombstone column. Missing and unavailable structures are returned, never thrown;
 * eval results and roadmap items have no archive lifecycle and can only be missing.
 *
 * FNXC:NativeStructureEmbed 2026-07-19-12:45:
 * Roadmap-item is a project-scoped, read-only projection through the plugin's supported
 * createRoadmapStoreForTaskStore seam. Adapter/layer failures degrade to missing; do not
 * duplicate roadmap persistence or reach into plugin store internals.
 */
export async function resolveNativeStructurePreview(
  store: TaskStore,
  ref: NativeStructureRef,
): Promise<NativeStructurePreviewResult> {
  switch (ref.kind) {
    case "mission": {
      const mission = await store.getMissionStore().getMission(ref.id);
      if (!mission) return unavailable(ref, "missing");
      if (mission.status === "archived") return unavailable(ref, "soft-deleted");
      return preview(ref, mission.title, text(mission.description, `Status: ${mission.status}`), { view: "missions", id: mission.id });
    }
    case "milestone": {
      const missionStore = store.getMissionStore();
      const milestone = await missionStore.getMilestone(ref.id);
      if (!milestone) return unavailable(ref, "missing");
      const mission = await missionStore.getMission(milestone.missionId);
      if (!mission) return unavailable(ref, "missing");
      if (mission.status === "archived") return unavailable(ref, "soft-deleted");
      return preview(ref, milestone.title, text(milestone.description, `Status: ${milestone.status}`), {
        view: "missions",
        id: milestone.id,
        missionId: mission.id,
      });
    }
    case "research-finding": {
      const insight = await store.getInsightStore().getInsight(ref.id);
      if (!insight) return unavailable(ref, "missing");
      if (insight.status === "dismissed" || insight.status === "archived") return unavailable(ref, "soft-deleted");
      return preview(ref, insight.title, text(insight.content, `Status: ${insight.status}`), { view: "insights", id: insight.id });
    }
    case "eval-result": {
      const result = await store.getEvalStore().getTaskResult(ref.id);
      if (!result) return unavailable(ref, "missing");
      const score = result.overallScore === undefined ? "Score unavailable" : `Score: ${result.overallScore}${result.maxScore === undefined ? "" : `/${result.maxScore}`}`;
      return preview(ref, result.taskSnapshot.title || result.taskId, text(result.summary ?? result.rationale, score), { view: "evals", id: result.id });
    }
    case "goal": {
      const goal = await store.getGoalStore().getGoal(ref.id);
      if (!goal) return unavailable(ref, "missing");
      if (goal.status === "archived") return unavailable(ref, "soft-deleted");
      return preview(ref, goal.title, text(goal.description, `Status: ${goal.status}`), { view: "goals", id: goal.id });
    }
    case "roadmap-item": {
      try {
        const roadmapStore = createRoadmapStoreForTaskStore(store);
        const feature = await roadmapStore.getFeature(ref.id);
        if (!feature) return unavailable(ref, "missing");
        const milestone = await roadmapStore.getMilestone(feature.milestoneId);
        return preview(ref, feature.title, text(feature.description, ""), {
          view: "roadmaps",
          id: feature.id,
          milestoneId: feature.milestoneId,
          ...(milestone ? { roadmapId: milestone.roadmapId } : {}),
        });
      } catch {
        return unavailable(ref, "missing");
      }
    }
  }
}
