import { describe, it, expect } from "vitest";
import {
  isProjectRoutedToNode,
  getProjectsForNode,
  getProjectCountForNode,
  getUnassignedProjectCount,
} from "../nodeProjectAssignment";
import type { NodeInfo, ProjectInfo } from "../../api";

function makeNode(overrides: Partial<NodeInfo> = {}): NodeInfo {
  return {
    id: "node-1",
    name: "Test Node",
    type: "local",
    status: "online",
    maxConcurrent: 2,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeProject(overrides: Partial<ProjectInfo> = {}): ProjectInfo {
  return {
    id: "proj-1",
    name: "Project One",
    path: "/workspace/project-one",
    status: "active",
    isolationMode: "in-process",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("nodeProjectAssignment", () => {
  describe("isProjectRoutedToNode", () => {
    describe("local node", () => {
      const localNode = makeNode({ id: "local-1", type: "local" });

      it("returns true for projects explicitly assigned to this local node", () => {
        const project = makeProject({ id: "proj-1", nodeId: "local-1" });
        expect(isProjectRoutedToNode(project, localNode)).toBe(true);
      });

      it("returns true for unassigned projects (nodeId undefined)", () => {
        const project = makeProject({ id: "proj-1", nodeId: undefined });
        expect(isProjectRoutedToNode(project, localNode)).toBe(true);
      });

      it("returns true for unassigned projects (nodeId null)", () => {
        const project = makeProject({ id: "proj-1", nodeId: null as unknown as string });
        expect(isProjectRoutedToNode(project, localNode)).toBe(true);
      });

      it("returns false for projects assigned to other nodes", () => {
        const project = makeProject({ id: "proj-1", nodeId: "other-node" });
        expect(isProjectRoutedToNode(project, localNode)).toBe(false);
      });

      it("returns false for projects assigned to remote nodes", () => {
        const project = makeProject({ id: "proj-1", nodeId: "remote-1" });
        expect(isProjectRoutedToNode(project, localNode)).toBe(false);
      });
    });

    describe("remote node", () => {
      const remoteNode = makeNode({ id: "remote-1", type: "remote" });

      it("returns true for projects explicitly assigned to this remote node", () => {
        const project = makeProject({ id: "proj-1", nodeId: "remote-1" });
        expect(isProjectRoutedToNode(project, remoteNode)).toBe(true);
      });

      it("returns false for unassigned projects (nodeId undefined)", () => {
        const project = makeProject({ id: "proj-1", nodeId: undefined });
        expect(isProjectRoutedToNode(project, remoteNode)).toBe(false);
      });

      it("returns false for unassigned projects (nodeId null)", () => {
        const project = makeProject({ id: "proj-1", nodeId: null as unknown as string });
        expect(isProjectRoutedToNode(project, remoteNode)).toBe(false);
      });

      it("returns false for projects assigned to local nodes", () => {
        const project = makeProject({ id: "proj-1", nodeId: "local-1" });
        expect(isProjectRoutedToNode(project, remoteNode)).toBe(false);
      });

      it("returns false for projects assigned to other remote nodes", () => {
        const project = makeProject({ id: "proj-1", nodeId: "other-remote" });
        expect(isProjectRoutedToNode(project, remoteNode)).toBe(false);
      });
    });
  });

  describe("getProjectsForNode", () => {
    it("returns all projects routed to a local node (including unassigned)", () => {
      const localNode = makeNode({ id: "local-1", type: "local" });
      const projects: ProjectInfo[] = [
        makeProject({ id: "proj-1", nodeId: "local-1" }), // assigned to this local node
        makeProject({ id: "proj-2", nodeId: undefined }), // unassigned
        makeProject({ id: "proj-3", nodeId: "other-local" }), // assigned to different local node
        makeProject({ id: "proj-4", nodeId: "remote-1" }), // assigned to remote
      ];

      const result = getProjectsForNode(projects, localNode);
      expect(result.map((p) => p.id)).toEqual(["proj-1", "proj-2"]);
    });

    it("returns only explicitly assigned projects for a remote node", () => {
      const remoteNode = makeNode({ id: "remote-1", type: "remote" });
      const projects: ProjectInfo[] = [
        makeProject({ id: "proj-1", nodeId: "remote-1" }), // assigned to this remote node
        makeProject({ id: "proj-2", nodeId: undefined }), // unassigned
        makeProject({ id: "proj-3", nodeId: "local-1" }), // assigned to local
        makeProject({ id: "proj-4", nodeId: "other-remote" }), // assigned to other remote
      ];

      const result = getProjectsForNode(projects, remoteNode);
      expect(result.map((p) => p.id)).toEqual(["proj-1"]);
    });
  });

  describe("getProjectCountForNode", () => {
    it("returns correct count for local node (includes unassigned)", () => {
      const localNode = makeNode({ id: "local-1", type: "local" });
      const projects: ProjectInfo[] = [
        makeProject({ id: "proj-1", nodeId: "local-1" }),
        makeProject({ id: "proj-2", nodeId: undefined }),
        makeProject({ id: "proj-3", nodeId: undefined }),
      ];

      expect(getProjectCountForNode(projects, localNode)).toBe(3);
    });

    it("returns correct count for remote node (explicit only)", () => {
      const remoteNode = makeNode({ id: "remote-1", type: "remote" });
      const projects: ProjectInfo[] = [
        makeProject({ id: "proj-1", nodeId: "remote-1" }),
        makeProject({ id: "proj-2", nodeId: "remote-1" }),
        makeProject({ id: "proj-3", nodeId: undefined }),
      ];

      expect(getProjectCountForNode(projects, remoteNode)).toBe(2);
    });

    it("returns 0 when no projects are routed to the node", () => {
      const remoteNode = makeNode({ id: "remote-1", type: "remote" });
      const projects: ProjectInfo[] = [
        makeProject({ id: "proj-1", nodeId: "local-1" }),
        makeProject({ id: "proj-2", nodeId: undefined }),
      ];

      expect(getProjectCountForNode(projects, remoteNode)).toBe(0);
    });
  });

  describe("getUnassignedProjectCount", () => {
    it("counts projects without nodeId", () => {
      const projects: ProjectInfo[] = [
        makeProject({ id: "proj-1", nodeId: undefined }),
        makeProject({ id: "proj-2", nodeId: null as unknown as string }),
        makeProject({ id: "proj-3", nodeId: "local-1" }),
      ];

      expect(getUnassignedProjectCount(projects)).toBe(2);
    });

    it("returns 0 when all projects are assigned", () => {
      const projects: ProjectInfo[] = [
        makeProject({ id: "proj-1", nodeId: "local-1" }),
        makeProject({ id: "proj-2", nodeId: "remote-1" }),
      ];

      expect(getUnassignedProjectCount(projects)).toBe(0);
    });

    it("returns 0 for empty array", () => {
      expect(getUnassignedProjectCount([])).toBe(0);
    });
  });
});
