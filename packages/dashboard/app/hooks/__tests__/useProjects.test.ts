import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useProjects } from "../useProjects";
import * as api from "../../api";
import type { ProjectInfoWithSource } from "../../api";

vi.mock("../../api", () => ({
  fetchProjectsAcrossNodes: vi.fn(),
  registerProject: vi.fn(),
  updateProject: vi.fn(),
  unregisterProject: vi.fn(),
  hasNodeMappingsSupport: vi.fn(),
}));

const mockFetchProjectsAcrossNodes = vi.mocked(api.fetchProjectsAcrossNodes);
const mockRegisterProject = vi.mocked(api.registerProject);
const mockUpdateProject = vi.mocked(api.updateProject);
const mockUnregisterProject = vi.mocked(api.unregisterProject);
const mockHasNodeMappingsSupport = vi.mocked(api.hasNodeMappingsSupport);

function makeProject(overrides: Partial<ProjectInfoWithSource> = {}): ProjectInfoWithSource {
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

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("useProjects", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockFetchProjectsAcrossNodes.mockReset();
    mockRegisterProject.mockReset();
    mockUpdateProject.mockReset();
    mockUnregisterProject.mockReset();
    mockHasNodeMappingsSupport.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("normalizes mapping-enabled payloads into project.nodeMappings", async () => {
    mockHasNodeMappingsSupport.mockReturnValue(true);
    mockFetchProjectsAcrossNodes.mockResolvedValueOnce([
      makeProject({
        id: "proj-1",
        nodeMappings: [{ nodeId: "node-a", path: "/mnt/a", available: true }],
      }),
      makeProject({
        id: "proj-2",
        pathMappings: [{ nodeId: "node-b", path: "/mnt/b", available: false }],
      }),
    ]);

    const { result } = renderHook(() => useProjects());

    await act(async () => {
      await flushPromises();
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.projects[0].nodeMappings).toEqual([
      { nodeId: "node-a", path: "/mnt/a", available: true, nodeName: undefined },
    ]);
    expect(result.current.projects[1].nodeMappings).toEqual([
      { nodeId: "node-b", path: "/mnt/b", available: false, nodeName: undefined },
    ]);
  });

  it("synthesizes a legacy fallback mapping from nodeId + path", async () => {
    mockHasNodeMappingsSupport.mockReturnValue(false);
    mockFetchProjectsAcrossNodes.mockResolvedValueOnce([
      makeProject({ id: "proj-legacy", nodeId: "node-legacy", _sourceNodeName: "Legacy Node" }),
    ]);

    const { result } = renderHook(() => useProjects());

    await act(async () => {
      await flushPromises();
    });

    expect(result.current.projects[0].nodeMappings).toEqual([
      {
        nodeId: "node-legacy",
        nodeName: "Legacy Node",
        path: "/workspace/project-one",
        available: true,
      },
    ]);
  });

  it("refreshes projects using the same normalization", async () => {
    mockHasNodeMappingsSupport.mockReturnValue(false);
    mockFetchProjectsAcrossNodes
      .mockResolvedValueOnce([makeProject({ id: "proj-1", nodeId: "node-a" })])
      .mockResolvedValueOnce([makeProject({ id: "proj-2", nodeId: "node-b" })]);

    const { result } = renderHook(() => useProjects());

    await act(async () => {
      await flushPromises();
    });

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.projects[0].id).toBe("proj-2");
    expect(result.current.projects[0].nodeMappings?.[0]?.nodeId).toBe("node-b");
  });
});
