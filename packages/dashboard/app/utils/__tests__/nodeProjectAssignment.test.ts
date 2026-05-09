import { describe, it, expect } from "vitest";
import {
  getAvailableNodeMappingsForNode,
  getNodeMappingsForProject,
  getProjectCountForNode,
  getProjectsForNode,
  getUnassignedProjectCount,
  isProjectAvailableOnNode,
  resolveNodeDisplayName,
} from "../nodeProjectAssignment";
import type { NodeInfo, ProjectInfoWithSource } from "../../api";

function makeNode(overrides: Partial<NodeInfo> = {}): NodeInfo {
  return {
    id: "node-1",
    name: "Node One",
    type: "local",
    status: "online",
    maxConcurrent: 2,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeProject(overrides: Partial<ProjectInfoWithSource> = {}): ProjectInfoWithSource {
  return {
    id: "proj-1",
    name: "Project One",
    path: "/workspace/project-one",
    status: "active",
    isolationMode: "in-process",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    nodeMappings: [],
    ...overrides,
  };
}

describe("nodeProjectAssignment", () => {
  it("normalizes mapping entries and defaults available=true", () => {
    const project = makeProject({
      nodeMappings: [
        { nodeId: "node-1", path: "/mnt/one", available: true },
        { nodeId: "node-2", path: "/mnt/two", available: false },
        { nodeId: "", path: "/bad", available: true },
      ],
    });

    expect(getNodeMappingsForProject(project)).toEqual([
      { nodeId: "node-1", path: "/mnt/one", available: true, nodeName: undefined },
      { nodeId: "node-2", path: "/mnt/two", available: false, nodeName: undefined },
    ]);
  });

  it("filters available mappings for a given node", () => {
    const project = makeProject({
      nodeMappings: [
        { nodeId: "node-1", path: "/mnt/live", available: true },
        { nodeId: "node-1", path: "/mnt/down", available: false },
      ],
    });
    const node = makeNode({ id: "node-1" });

    expect(getAvailableNodeMappingsForNode(project, node)).toEqual([
      { nodeId: "node-1", path: "/mnt/live", available: true, nodeName: undefined },
    ]);
    expect(isProjectAvailableOnNode(project, node)).toBe(true);
  });

  it("builds project lists and counts from available mappings only", () => {
    const node = makeNode({ id: "node-1" });
    const projects = [
      makeProject({ id: "proj-a", nodeMappings: [{ nodeId: "node-1", path: "/a", available: true }] }),
      makeProject({ id: "proj-b", nodeMappings: [{ nodeId: "node-1", path: "/b", available: false }] }),
      makeProject({ id: "proj-c", nodeMappings: [{ nodeId: "node-2", path: "/c", available: true }] }),
    ];

    expect(getProjectsForNode(projects, node).map((project) => project.id)).toEqual(["proj-a"]);
    expect(getProjectCountForNode(projects, node)).toBe(1);
  });

  it("resolves display names in canonical order", () => {
    const nodes = [makeNode({ id: "node-1", name: "Primary Node" })];
    const project = makeProject({ _sourceNodeName: "Source Node" });

    expect(resolveNodeDisplayName("node-1", { nodeId: "node-1", path: "/a", available: true, nodeName: "Mapping Name" }, nodes, project)).toBe("Primary Node");
    expect(resolveNodeDisplayName("node-2", { nodeId: "node-2", path: "/b", available: true, nodeName: "Mapping Name" }, nodes, project)).toBe("Mapping Name");
    expect(resolveNodeDisplayName("node-3", undefined, nodes, project)).toBe("Source Node");
    expect(resolveNodeDisplayName("node-4", undefined, nodes, makeProject({ _sourceNodeName: undefined }))).toBe("node-4");
  });

  it("counts unassigned projects as projects without mappings", () => {
    expect(getUnassignedProjectCount([
      makeProject({ id: "proj-a", nodeMappings: [] }),
      makeProject({ id: "proj-b", nodeMappings: [{ nodeId: "node-1", path: "/b", available: true }] }),
    ])).toBe(1);
  });
});
