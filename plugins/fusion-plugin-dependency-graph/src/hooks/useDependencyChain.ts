import { useCallback, useMemo } from "react";
import type { Task } from "@fusion/core";

export function useDependencyChain(tasks: Task[]) {
  const { upstreamMap, downstreamMap } = useMemo(() => {
    const upstream = new Map<string, Set<string>>();
    const downstream = new Map<string, Set<string>>();

    for (const task of tasks) {
      upstream.set(task.id, new Set(task.dependencies ?? []));
      if (!downstream.has(task.id)) downstream.set(task.id, new Set());
    }

    for (const task of tasks) {
      for (const dependencyId of task.dependencies ?? []) {
        if (!downstream.has(dependencyId)) downstream.set(dependencyId, new Set());
        downstream.get(dependencyId)?.add(task.id);
      }
    }

    return { upstreamMap: upstream, downstreamMap: downstream };
  }, [tasks]);

  const getChain = useCallback(
    (taskId: string): Set<string> => {
      if (!upstreamMap.has(taskId) && !downstreamMap.has(taskId)) {
        return new Set();
      }

      const chain = new Set<string>([taskId]);

      const visit = (origin: string, adjacency: Map<string, Set<string>>) => {
        const queue = [origin];
        const visited = new Set<string>([origin]);

        while (queue.length > 0) {
          const current = queue.shift();
          if (!current) continue;
          const neighbors = adjacency.get(current);
          if (!neighbors) continue;

          for (const neighbor of neighbors) {
            if (visited.has(neighbor)) continue;
            visited.add(neighbor);
            chain.add(neighbor);
            queue.push(neighbor);
          }
        }
      };

      visit(taskId, upstreamMap);
      visit(taskId, downstreamMap);

      return chain;
    },
    [downstreamMap, upstreamMap],
  );

  return { getChain };
}
