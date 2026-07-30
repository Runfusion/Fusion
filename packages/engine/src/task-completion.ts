import { getTaskCompletionBlocker, type Task, type TaskStore } from "@fusion/core";
import { resolveDependencySatisfactionColumns } from "./scheduler.js";

/*
FNXC:WorkflowResolvedColumns 2026-07-31-01:45 (#2780 review — greptile, "dependency lifecycle context stays unset"):

THE INJECTION POINT EXISTED AND NOTHING IN PRODUCTION FILLED IT.

`getTaskCompletionBlocker` gained an optional `satisfactionColumnsByTaskId` so dependency
satisfaction could be judged from each dependency's OWN workflow. This wrapper is the production
path, and it omitted the option — so every real call fell through to the documented legacy default
(`done`/`in-review`/`archived`). On a renamed board a finished dependency read as unresolved and the
depending task could never complete. The conversion was inert everywhere it actually ran.

An optional parameter that only tests supply is the half-converted-pair shape in its quietest form:
the guard reads as converted, its covering test passes because it injects the value by hand, and
production keeps the literal. Filling it here is what makes the option real.

WHY THE DEPENDENCIES ARE FETCHED FIRST. `resolveDependencySatisfactionColumns` resolves per
dependency, because a dependency can run a different workflow from the task depending on it — that
difference is the whole reason the map is keyed by task id. Resolution shares one IR cache, so this
costs one workflow read per distinct workflow, not per dependency.

Failure is non-fatal by design: if the dependencies cannot be read the map is simply absent and the
gate falls back to the legacy default, rather than blocking completion on a resolution problem. That
matches the conservative contract `getTaskCompletionBlocker` documents for itself.
*/
export async function getTaskCompletionBlockerForStore(
  store: Pick<TaskStore, "getTask">,
  task: Task,
): Promise<string | undefined> {
  const resolveTask = async (dependencyId: string) => {
    try {
      return await store.getTask(dependencyId);
    } catch {
      return null;
    }
  };

  /*
  Both edges count: `dependencies` and the single `blockedBy` marker are judged by the same helper in
  `task-merge.ts`, so both must appear in the map or the blockedBy branch silently keeps the literal.
  */
  const dependencyIds = [...(task.dependencies ?? [])];
  const blockedBy = task.blockedBy?.trim();
  if (blockedBy && !dependencyIds.includes(blockedBy)) dependencyIds.push(blockedBy);

  /*
  The store parameter is deliberately narrow (`Pick<TaskStore, "getTask">`) — several callers pass a
  partial store that genuinely cannot resolve workflows. Feature-detect rather than widen the
  signature: a caller without the selection readers keeps the legacy default, which is the same
  behaviour it had before, instead of every such call site being forced to change.
  */
  const canResolveWorkflows =
    typeof (store as { getWorkflowDefinition?: unknown }).getWorkflowDefinition === "function";

  let satisfactionColumnsByTaskId: Awaited<ReturnType<typeof resolveDependencySatisfactionColumns>> | undefined;
  if (dependencyIds.length > 0 && canResolveWorkflows) {
    try {
      const dependencies = (await Promise.all(dependencyIds.map(resolveTask))).filter(
        (dep): dep is NonNullable<typeof dep> => dep != null,
      ) as unknown as Task[];
      if (dependencies.length > 0) {
        satisfactionColumnsByTaskId = await resolveDependencySatisfactionColumns(
          store as unknown as Parameters<typeof resolveDependencySatisfactionColumns>[0],
          dependencies,
        );
      }
    } catch {
      /* leave unset — the gate falls back to the documented legacy default */
    }
  }

  return getTaskCompletionBlocker(task, {
    // FN-4091: return full task state from the store so completion gating can
    // ignore stale blockedBy markers when the blocker is missing or terminal.
    resolveTask,
    ...(satisfactionColumnsByTaskId ? { satisfactionColumnsByTaskId } : {}),
  });
}
