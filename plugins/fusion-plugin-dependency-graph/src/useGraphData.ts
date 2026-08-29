import { useMemo } from "react";
import type { Task } from "@fusion/core";
import type { GraphData, GraphNode } from "./types.js";

export function useGraphData(tasks: Task[]): GraphData {
  return useMemo(() => {
    const nodes: GraphNode[] = tasks.map((task) => ({ task }));
    const taskIds = new Set(tasks.map((task) => task.id));
    const edges = tasks.flatMap((task) =>
      (task.dependencies ?? [])
        .filter((dependencyId) => taskIds.has(dependencyId))
        .map((dependencyId) => ({ source: task.id, target: dependencyId })),
    );

    return { nodes, edges };
  }, [tasks]);
}
