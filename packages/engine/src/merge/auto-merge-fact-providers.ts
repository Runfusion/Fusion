import {
  getWorkflowExtensionRegistry,
  resolveWorkflowIrForTask,
  type AutoMergeFactProviderResult,
  type AutoMergeRoute,
  type TaskDetail,
  type WorkflowIrResolverStore,
} from "@fusion/core";

export interface AutoMergeFactProviderEvaluation {
  route?: AutoMergeRoute;
  facts: Record<string, unknown>;
  reasons: string[];
}

export async function evaluateAutoMergeFactProviders(
  store: WorkflowIrResolverStore,
  task: TaskDetail,
): Promise<AutoMergeFactProviderEvaluation> {
  const workflow = await resolveWorkflowIrForTask(store, task.id);
  const evaluation: AutoMergeFactProviderEvaluation = { facts: {}, reasons: [] };

  for (const definition of getWorkflowExtensionRegistry().list("merge-fact-provider")) {
    const extension = definition.extension;
    if (definition.degraded || extension.kind !== "merge-fact-provider" || !extension.collect) continue;
    let result: AutoMergeFactProviderResult;
    try {
      result = await extension.collect({ task, workflow });
    } catch (error) {
      if (extension.fallback === "degradeToDefault") continue;
      const message = error instanceof Error ? error.message : String(error);
      return {
        route: "blocked",
        facts: evaluation.facts,
        reasons: [...evaluation.reasons, `fact provider '${definition.id}' failed: ${message}`],
      };
    }
    if (result.facts) {
      evaluation.facts[definition.id] = result.facts;
    }
    if (result.reason) {
      evaluation.reasons.push(result.reason);
    }
    if (result.route) {
      evaluation.route = chooseStricterAutoMergeRoute(evaluation.route, result.route);
    }
  }

  return evaluation;
}

function chooseStricterAutoMergeRoute(
  current: AutoMergeRoute | undefined,
  next: AutoMergeRoute,
): AutoMergeRoute {
  const rank: Record<AutoMergeRoute, number> = {
    "auto-enqueue": 0,
    "workflow-subgraph": 1,
    "manual-required": 2,
    blocked: 3,
  };
  if (!current) return next;
  return rank[next] > rank[current] ? next : current;
}
