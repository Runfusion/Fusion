import type { NodeInfo, ProjectInfoWithSource, ProjectNodeAvailability } from "../api";

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function getNodeMappingsForProject(project: ProjectInfoWithSource): ProjectNodeAvailability[] {
  const mappings = project.nodeMappings ?? [];
  return mappings
    .filter((mapping) => isNonEmptyString(mapping.nodeId) && isNonEmptyString(mapping.path))
    .map((mapping) => ({
      nodeId: mapping.nodeId,
      nodeName: mapping.nodeName,
      path: mapping.path,
      available: mapping.available !== false,
    }));
}

export function getAvailableNodeMappingsForNode(
  project: ProjectInfoWithSource,
  node: NodeInfo,
): ProjectNodeAvailability[] {
  return getNodeMappingsForProject(project).filter(
    (mapping) => mapping.nodeId === node.id && mapping.available,
  );
}

export function isProjectAvailableOnNode(project: ProjectInfoWithSource, node: NodeInfo): boolean {
  return getAvailableNodeMappingsForNode(project, node).length > 0;
}

export function getProjectsForNode(projects: ProjectInfoWithSource[], node: NodeInfo): ProjectInfoWithSource[] {
  return projects.filter((project) => isProjectAvailableOnNode(project, node));
}

export function getProjectCountForNode(projects: ProjectInfoWithSource[], node: NodeInfo): number {
  return getProjectsForNode(projects, node).length;
}

export function resolveNodeDisplayName(
  nodeId: string,
  mapping: ProjectNodeAvailability | undefined,
  nodes: NodeInfo[],
  project: ProjectInfoWithSource,
): string {
  const nodeMatch = nodes.find((node) => node.id === nodeId);
  if (nodeMatch?.name) return nodeMatch.name;
  if (mapping?.nodeName) return mapping.nodeName;
  if (project._sourceNodeName) return project._sourceNodeName;
  return nodeId;
}

export function getUnassignedProjectCount(projects: ProjectInfoWithSource[]): number {
  return projects.filter((project) => getNodeMappingsForProject(project).length === 0).length;
}
