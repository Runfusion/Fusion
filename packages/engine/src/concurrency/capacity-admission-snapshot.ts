import type { Task, TaskStore, WorkflowIrResolverStore, WorkflowSelectionCache } from "@fusion/core";
import {
  persistedTopLevelAgentTaskIdsFromStore,
  type CapacityEmptinessProof,
  type CapacityEnrichmentCaches,
} from "./concurrency.js";

/*
FNXC:CapacityAdmissionSnapshot 2026-10-25-20:41 (RUFU-627 Step 3):
Every admission evaluation that needed the running-agent holder set read the board once and then
called `persistedTopLevelAgentTaskIdsFromStore(store, tasks, undefined, …)`. Passing `undefined`
caches made `enrichedTopLevelAgentTasksFromStore` allocate a fresh IR cache per call AND resolve each
row's workflow identity through `getTaskWorkflowSelectionAsync` one card at a time, so a 2 417-row
board paid up to one selection SELECT per card per evaluation — four times per engine loop across
`triage.ts`, `project-engine.ts`, and `in-process-runtime.ts`. This is the engine-side half of
RUFU-698: the scheduler already shares one pass-scoped cache pair between its two capacity
dimensions (scheduler.ts `capacityCaches`); these lanes did not even share inside one evaluation.

The pass object below is the reuse seam: ONE hydrated row set, ONE prefilled selection cache, ONE IR
cache, and a selection-served store view so nested resolvers cannot re-query what the pass already
read. It stays pass-scoped and is never a memo — a workflow-selection write invalidates lane state,
so the next evaluation must observe it (RUFU-073). Callers construct it per evaluation; there is
deliberately no module-level cache to outlive one.
*/

/** The two capacity dimensions derived from one board read inside one evaluation. */
export interface CapacityAdmissionFacts {
  /** Task ids the agent-capability predicate currently counts as running. */
  agentTaskIds: string[];
}

export interface CapacityAdmissionPass {
  /** The pass-owned cache pair; share it with any other derivation over the same rows. */
  readonly caches: CapacityEnrichmentCaches;
  /** Selection-served view of `store`, so nested resolvers reuse `caches.selectionCache`. */
  readonly store: WorkflowIrResolverStore;
  /** Derive the agent-holder set from rows the caller already hydrated — never re-read the board here. */
  runningAgentTaskIds(tasks: Task[], emptinessProof?: CapacityEmptinessProof): Promise<CapacityAdmissionFacts>;
}

/*
FNXC:CapacityAdmissionSnapshot 2026-10-25-20:41 (RUFU-627 Step 3):
Prefill ladder mirrors scheduler.ts deliberately, including its two failure modes: a store without the
batch reader falls back to per-task reads, and a BATCH TRANSPORT FAILURE must not default the whole
evaluation to `builtin:coding` — it retries per task instead, because defaulting would merge distinct
capacity pools before the caller could retry the row. Ids the batch genuinely has no selection for stay
absent from the cache (not `undefined`-seeded), so the store view falls through to the live read.
*/
async function prefillSelectionCache(store: TaskStore, taskIds: string[]): Promise<WorkflowSelectionCache> {
  const selectionCache: WorkflowSelectionCache = new Map();
  const readPerTask = async () => {
    await Promise.all(taskIds.map(async (taskId) => {
      try {
        const selection = await store.getTaskWorkflowSelectionAsync(taskId);
        if (selection !== undefined) selectionCache.set(taskId, selection);
      } catch { /* no selection: the IR resolver's documented default applies */ }
    }));
  };
  if (!store.getTaskWorkflowSelectionsAsync) {
    await readPerTask();
    return selectionCache;
  }
  try {
    const selections = await store.getTaskWorkflowSelectionsAsync(taskIds);
    for (const taskId of taskIds) {
      const selection = selections.get(taskId);
      if (selection !== undefined) selectionCache.set(taskId, selection);
    }
  } catch {
    await readPerTask();
  }
  return selectionCache;
}

/**
 * Open one capacity-admission evaluation over rows the caller has already hydrated.
 *
 * Call this once per evaluation, pass the resulting `caches` / `store` to every capacity derivation
 * that runs over those rows, and drop the object afterwards: its lifetime IS the evaluation.
 */
export async function openCapacityAdmissionPass(
  store: TaskStore,
  tasks: readonly Task[],
): Promise<CapacityAdmissionPass> {
  const selectionCache = await prefillSelectionCache(store, [...new Set(tasks.map((task) => task.id))]);
  const caches: CapacityEnrichmentCaches = { irCache: new Map(), selectionCache };
  /*
  FNXC:CapacityModel 2026-09-01-14:49 (mechanism copied from scheduler.ts `selectionCachedStore`):
  Without this view, a resolver reached through the enrichment path would add one selection query per
  card after the batch — which is exactly issue #3364's three-connection-pool saturation.
  */
  const cachedStore = new Proxy(store as WorkflowIrResolverStore, {
    get: (target, property, receiver) => {
      if (property === "getTaskWorkflowSelectionAsync") {
        return async (taskId: string) => selectionCache.has(taskId)
          ? selectionCache.get(taskId)
          : await target.getTaskWorkflowSelectionAsync?.(taskId);
      }
      if (property === "getTaskWorkflowSelection") {
        return (taskId: string) => selectionCache.has(taskId)
          ? selectionCache.get(taskId)
          : target.getTaskWorkflowSelection?.(taskId);
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  return {
    caches,
    store: cachedStore,
    runningAgentTaskIds: async (rows, emptinessProof) => ({
      agentTaskIds: await persistedTopLevelAgentTaskIdsFromStore(
        cachedStore,
        rows,
        caches,
        emptinessProof,
      ),
    }),
  };
}
