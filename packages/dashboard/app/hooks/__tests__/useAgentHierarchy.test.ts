import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useAgentHierarchy } from "../useAgentHierarchy";
import type { Agent, AgentCapability, AgentState } from "../../api";

// Mock localStorage
const localStorageStore: Record<string, string> = {};
const localStorageMock = {
  getItem: vi.fn((key: string) => localStorageStore[key] ?? null),
  setItem: vi.fn((key: string, value: string) => {
    localStorageStore[key] = value;
  }),
  removeItem: vi.fn((key: string) => {
    delete localStorageStore[key];
  }),
  clear: vi.fn(() => {
    Object.keys(localStorageStore).forEach((k) => delete localStorageStore[k]);
  }),
};
vi.stubGlobal("localStorage", localStorageMock);

function createMockAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent-001",
    name: "Test Agent",
    role: "executor" as AgentCapability,
    state: "idle" as AgentState,
    metadata: {},
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

beforeEach(() => {
  localStorageMock.getItem.mockImplementation((key: string) => localStorageStore[key] ?? null);
  localStorageMock.setItem.mockImplementation((key: string, value: string) => {
    localStorageStore[key] = value;
  });
  localStorageMock.clear.mockImplementation(() => {
    Object.keys(localStorageStore).forEach((k) => delete localStorageStore[k]);
  });
});

afterEach(() => {
  localStorageMock.clear();
});

describe("useAgentHierarchy", () => {
  it("builds tree from flat agents array", () => {
    const parent = createMockAgent({ id: "parent-1", name: "Parent" });
    const child = createMockAgent({ id: "child-1", name: "Child", reportsTo: "parent-1" });

    const { result } = renderHook(() => useAgentHierarchy([parent, child]));

    expect(result.current.rootNodes).toHaveLength(1);
    expect(result.current.rootNodes[0].agent.id).toBe("parent-1");
    expect(result.current.rootNodes[0].depth).toBe(0);
  });

  it("handles empty agents array", () => {
    const { result } = renderHook(() => useAgentHierarchy([]));

    expect(result.current.rootNodes).toHaveLength(0);
    expect(result.current.isLoading).toBe(false);
  });

  it("handles agents with no parent-child relationships (all root nodes)", () => {
    const agent1 = createMockAgent({ id: "agent-1" });
    const agent2 = createMockAgent({ id: "agent-2" });
    const agent3 = createMockAgent({ id: "agent-3" });

    const { result } = renderHook(() => useAgentHierarchy([agent1, agent2, agent3]));

    expect(result.current.rootNodes).toHaveLength(3);
    expect(result.current.rootNodes.map((n) => n.agent.id)).toEqual(["agent-1", "agent-2", "agent-3"]);
  });

  it("handles deeply nested hierarchies (parent -> child -> grandchild)", () => {
    const parent = createMockAgent({ id: "parent", name: "Parent" });
    const child = createMockAgent({ id: "child", name: "Child", reportsTo: "parent" });
    const grandchild = createMockAgent({ id: "grandchild", name: "Grandchild", reportsTo: "child" });

    // Pre-expand parent and child so grandchild shows up
    localStorageMock.getItem.mockImplementation((key: string) => {
      if (key === "kb-agent-tree-expanded") return JSON.stringify(["parent", "child"]);
      return localStorageStore[key] ?? null;
    });

    const { result } = renderHook(() => useAgentHierarchy([parent, child, grandchild]));

    expect(result.current.rootNodes).toHaveLength(1);
    const rootNode = result.current.rootNodes[0];
    expect(rootNode.agent.id).toBe("parent");
    expect(rootNode.depth).toBe(0);
    expect(rootNode.children).toHaveLength(1);
    expect(rootNode.children[0].agent.id).toBe("child");
    expect(rootNode.children[0].depth).toBe(1);
    expect(rootNode.children[0].children).toHaveLength(1);
    expect(rootNode.children[0].children[0].agent.id).toBe("grandchild");
    expect(rootNode.children[0].children[0].depth).toBe(2);
  });

  it("toggles expand state for a node", () => {
    const parent = createMockAgent({ id: "parent-1", name: "Parent" });
    const child = createMockAgent({ id: "child-1", name: "Child", reportsTo: "parent-1" });

    const { result } = renderHook(() => useAgentHierarchy([parent, child]));

    // Initially not expanded
    expect(result.current.isExpanded("parent-1")).toBe(false);

    // Expand
    act(() => {
      result.current.toggleExpand("parent-1");
    });

    expect(result.current.isExpanded("parent-1")).toBe(true);

    // Collapse
    act(() => {
      result.current.toggleExpand("parent-1");
    });

    expect(result.current.isExpanded("parent-1")).toBe(false);
  });

  it("persists expand state to localStorage", () => {
    const parent = createMockAgent({ id: "parent-1", name: "Parent" });

    const { result } = renderHook(() => useAgentHierarchy([parent]));

    act(() => {
      result.current.toggleExpand("parent-1");
    });

    expect(localStorageMock.setItem).toHaveBeenCalledWith(
      "kb-agent-tree-expanded",
      JSON.stringify(["parent-1"]),
    );
  });

  it("restores expand state from localStorage on mount", () => {
    localStorageMock.getItem.mockImplementation((key: string) => {
      if (key === "kb-agent-tree-expanded") return JSON.stringify(["parent-1"]);
      return localStorageStore[key] ?? null;
    });

    const parent = createMockAgent({ id: "parent-1", name: "Parent" });

    const { result } = renderHook(() => useAgentHierarchy([parent]));

    expect(result.current.isExpanded("parent-1")).toBe(true);
  });

  it("isExpanded returns correct state", () => {
    const agent1 = createMockAgent({ id: "agent-1" });
    const agent2 = createMockAgent({ id: "agent-2" });

    const { result } = renderHook(() => useAgentHierarchy([agent1, agent2]));

    expect(result.current.isExpanded("agent-1")).toBe(false);
    expect(result.current.isExpanded("agent-2")).toBe(false);

    act(() => {
      result.current.toggleExpand("agent-1");
    });

    expect(result.current.isExpanded("agent-1")).toBe(true);
    expect(result.current.isExpanded("agent-2")).toBe(false);
  });

  it("getChildren returns direct children for an agent", () => {
    const parent = createMockAgent({ id: "parent-1", name: "Parent" });
    const child1 = createMockAgent({ id: "child-1", name: "Child 1", reportsTo: "parent-1" });
    const child2 = createMockAgent({ id: "child-2", name: "Child 2", reportsTo: "parent-1" });
    const unrelated = createMockAgent({ id: "unrelated", name: "Unrelated" });

    const { result } = renderHook(() => useAgentHierarchy([parent, child1, child2, unrelated]));

    const children = result.current.getChildren("parent-1");
    expect(children).toHaveLength(2);
    expect(children.map((c) => c.id)).toEqual(["child-1", "child-2"]);
  });

  it("handles agents with reportsTo pointing to non-existent parent", () => {
    const orphan = createMockAgent({ id: "orphan-1", name: "Orphan", reportsTo: "missing-parent" });
    const normal = createMockAgent({ id: "normal-1", name: "Normal" });

    const { result } = renderHook(() => useAgentHierarchy([orphan, normal]));

    // Orphan should be treated as a root node since parent doesn't exist
    expect(result.current.rootNodes).toHaveLength(2);
    expect(result.current.rootNodes.map((n) => n.agent.id)).toContain("orphan-1");
    expect(result.current.rootNodes.map((n) => n.agent.id)).toContain("normal-1");
  });
});
