import type {
  Roadmap,
  RoadmapCreateInput,
  RoadmapUpdateInput,
  RoadmapMilestone,
  RoadmapMilestoneCreateInput,
  RoadmapMilestoneUpdateInput,
  RoadmapFeature,
  RoadmapFeatureCreateInput,
  RoadmapFeatureUpdateInput,
  RoadmapWithHierarchy,
  RoadmapMissionPlanningHandoff,
  RoadmapFeatureTaskPlanningHandoff,
} from "../roadmap-types.js";

const BASE = "/api/plugins/fusion-plugin-roadmap";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    ...init,
  });
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // ignore
    }
    throw new Error(message);
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

function qp(projectId?: string): string {
  return projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
}

export function fetchRoadmaps(projectId?: string): Promise<Roadmap[]> { return request(`/roadmaps${qp(projectId)}`); }
export function fetchRoadmap(roadmapId: string, projectId?: string): Promise<RoadmapWithHierarchy> { return request(`/roadmaps/${roadmapId}${qp(projectId)}`); }
export function createRoadmap(input: RoadmapCreateInput, projectId?: string): Promise<Roadmap> { return request(`/roadmaps${qp(projectId)}`, { method: "POST", body: JSON.stringify({ ...input, projectId }) }); }
export function updateRoadmap(roadmapId: string, updates: RoadmapUpdateInput, projectId?: string): Promise<Roadmap> { return request(`/roadmaps/${roadmapId}${qp(projectId)}`, { method: "PATCH", body: JSON.stringify({ ...updates, projectId }) }); }
export function deleteRoadmap(roadmapId: string, projectId?: string): Promise<void> { return request(`/roadmaps/${roadmapId}${qp(projectId)}`, { method: "DELETE" }); }

export function createRoadmapMilestone(roadmapId: string, input: RoadmapMilestoneCreateInput, projectId?: string): Promise<RoadmapMilestone> { return request(`/roadmaps/${roadmapId}/milestones${qp(projectId)}`, { method: "POST", body: JSON.stringify({ ...input, projectId }) }); }
export function updateRoadmapMilestone(milestoneId: string, updates: RoadmapMilestoneUpdateInput, projectId?: string): Promise<RoadmapMilestone> { return request(`/roadmaps/milestones/${milestoneId}${qp(projectId)}`, { method: "PATCH", body: JSON.stringify({ ...updates, projectId }) }); }
export function deleteRoadmapMilestone(milestoneId: string, projectId?: string): Promise<void> { return request(`/roadmaps/milestones/${milestoneId}${qp(projectId)}`, { method: "DELETE" }); }
export function reorderRoadmapMilestones(roadmapId: string, orderedMilestoneIds: string[], projectId?: string): Promise<void> { return request(`/roadmaps/${roadmapId}/milestones/reorder${qp(projectId)}`, { method: "POST", body: JSON.stringify({ orderedMilestoneIds, projectId }) }); }

export function createRoadmapFeature(milestoneId: string, input: RoadmapFeatureCreateInput, projectId?: string): Promise<RoadmapFeature> { return request(`/roadmaps/milestones/${milestoneId}/features${qp(projectId)}`, { method: "POST", body: JSON.stringify({ ...input, projectId }) }); }
export function updateRoadmapFeature(featureId: string, updates: RoadmapFeatureUpdateInput, projectId?: string): Promise<RoadmapFeature> { return request(`/roadmaps/features/${featureId}${qp(projectId)}`, { method: "PATCH", body: JSON.stringify({ ...updates, projectId }) }); }
export function deleteRoadmapFeature(featureId: string, projectId?: string): Promise<void> { return request(`/roadmaps/features/${featureId}${qp(projectId)}`, { method: "DELETE" }); }
export function reorderRoadmapFeatures(milestoneId: string, orderedFeatureIds: string[], projectId?: string): Promise<void> { return request(`/roadmaps/milestones/${milestoneId}/features/reorder${qp(projectId)}`, { method: "POST", body: JSON.stringify({ orderedFeatureIds, projectId }) }); }
export function moveRoadmapFeature(featureId: string, targetMilestoneId: string, targetIndex: number, projectId?: string): Promise<void> { return request(`/roadmaps/features/${featureId}/move${qp(projectId)}`, { method: "POST", body: JSON.stringify({ targetMilestoneId, targetIndex, projectId }) }); }

export function generateMilestoneSuggestions(roadmapId: string, goalPrompt: string, count = 5, projectId?: string): Promise<{ suggestions: Array<{ title: string; description?: string }> }> {
  return request(`/roadmaps/${roadmapId}/suggestions/milestones${qp(projectId)}`, { method: "POST", body: JSON.stringify({ goalPrompt, count, projectId }) });
}

export function generateFeatureSuggestions(milestoneId: string, input?: { prompt?: string; count?: number }, projectId?: string): Promise<{ suggestions: Array<{ title: string; description?: string }> }> {
  return request(`/roadmaps/milestones/${milestoneId}/suggestions/features${qp(projectId)}`, { method: "POST", body: JSON.stringify({ ...input, projectId }) });
}

export function fetchRoadmapHandoff(roadmapId: string, projectId?: string): Promise<{ mission: RoadmapMissionPlanningHandoff; features: RoadmapFeatureTaskPlanningHandoff[] }> {
  return request(`/roadmaps/${roadmapId}/handoff${qp(projectId)}`);
}
