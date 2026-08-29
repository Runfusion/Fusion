import type { ProjectSettings, Task } from "@fusion/core";

export type EffectiveNodeSource = "task-override" | "project-default" | "local";

export interface EffectiveNode {
  nodeId: string | undefined;
  source: EffectiveNodeSource;
}

function isSetNodeId(nodeId: string | null | undefined): nodeId is string {
  return typeof nodeId === "string" && nodeId.trim().length > 0;
}

export function resolveEffectiveNode(
  task: Pick<Task, "nodeId">,
  settings: Pick<ProjectSettings, "defaultNodeId">,
): EffectiveNode {
  if (isSetNodeId(task.nodeId)) {
    return { nodeId: task.nodeId, source: "task-override" };
  }

  if (isSetNodeId(settings.defaultNodeId)) {
    return { nodeId: settings.defaultNodeId, source: "project-default" };
  }

  return { nodeId: undefined, source: "local" };
}
