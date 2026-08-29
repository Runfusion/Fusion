export type PlanningLivenessProbe = (taskId: string) => boolean;
const probes = new Set<PlanningLivenessProbe>();
/*
FNXC:TaskReset 2026-08-22-04:32:
Planning probes are process-wide and multi-project safe. Any true or throwing probe refuses removal: ambiguity must preserve a possibly live planner; no probe means no in-process planner exists.
*/
export const planningLivenessRegistry = {
  registerPlanningLivenessProbe(probe: PlanningLivenessProbe): () => void {
    probes.add(probe);
    return () => probes.delete(probe);
  },
  isPlanningLive(taskId: string): boolean {
    for (const probe of probes) { try { if (probe(taskId)) return true; } catch { return true; } }
    return false;
  },
  hasRegisteredProbe(): boolean { return probes.size > 0; },
};
export const registerPlanningLivenessProbe = planningLivenessRegistry.registerPlanningLivenessProbe.bind(planningLivenessRegistry);
export const isPlanningLive = planningLivenessRegistry.isPlanningLive.bind(planningLivenessRegistry);
