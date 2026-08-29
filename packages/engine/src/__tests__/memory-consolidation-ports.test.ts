import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ build: vi.fn(), append: vi.fn(), merge: vi.fn(), resolve: vi.fn(), addInferred: vi.fn(), semantics: vi.fn() }));
vi.mock("@fusion/core", async () => {
  const actual = await vi.importActual<typeof import("@fusion/core")>("@fusion/core");
  return { ...actual, buildKnowledgeGraph: mocks.build, appendRecall: mocks.append, mergeRecallGraphNodeIds: mocks.merge, resolveKnowledgeGraphDir: mocks.resolve, addInferredEdges: mocks.addInferred };
});
vi.mock("../memory/memory-semantics.js", () => ({ runMemorySemanticsPass: mocks.semantics }));
import { resolveMemoryConsolidationPorts } from "../memory/memory-consolidation-adapters.js";

const store = (over: Record<string, unknown> = {}) => ({ getAsyncLayer: () => ({ projectId: "project" }), getSettings: vi.fn(async () => ({})), ...over });

describe("resolveMemoryConsolidationPorts", () => {
  beforeEach(() => { mocks.resolve.mockReset().mockReturnValue("/repo/.fusion-knowledge/graph"); mocks.build.mockReset(); mocks.append.mockReset(); mocks.merge.mockReset(); mocks.addInferred.mockReset(); mocks.semantics.mockReset(); });
  it.each([
    ["no root", { taskStore: store(), rootDir: "", agentId: "memory" }, "no-root-dir"],
    ["no layer", { taskStore: {}, rootDir: "/repo", agentId: "memory" }, "no-data-layer"],
    ["null layer", { taskStore: store({ getAsyncLayer: () => null }), rootDir: "/repo", agentId: "memory" }, "no-data-layer"],
    ["no project", { taskStore: store({ getAsyncLayer: () => ({}) }), rootDir: "/repo", agentId: "memory" }, "no-project-id"],
  ] as const)("reports %s as an unavailable environment", async (_name, deps, reason) => {
    await expect(resolveMemoryConsolidationPorts(deps)).resolves.toEqual({ status: "unavailable", reason });
  });
  it("uses the supplied settings and forwards graph recovery reason", async () => {
    const taskStore = store();
    const resolved = await resolveMemoryConsolidationPorts({ taskStore, rootDir: "/repo", agentId: "memory", settings: { knowledgeGraphDir: ".graph" } as never });
    expect(resolved.status).toBe("ready"); if (resolved.status !== "ready") return;
    expect(taskStore.getSettings).not.toHaveBeenCalled();
    mocks.build.mockResolvedValue({ graph: { nodes: [], edges: [] }, changed: false, stats: { parsedFiles: 0, reusedFiles: 1, prunedFiles: 0, recoveryReason: "inconsistent-artifact" } });
    await expect(resolved.ports.refreshGraph()).resolves.toMatchObject({ recoveryReason: "inconsistent-artifact", nodeCount: 0 });
  });
  it("forwards distinct inferred-edge dedupe and unresolved counts to consolidation", async () => {
    const resolved = await resolveMemoryConsolidationPorts({ taskStore: store(), rootDir: "/repo", agentId: "memory" });
    expect(resolved.status).toBe("ready"); if (resolved.status !== "ready") return;
    mocks.build.mockResolvedValue({ graph: { nodes: [], edges: [] }, changed: true, stats: { parsedFiles: 0, reusedFiles: 0, prunedFiles: 0, recoveryReason: null } });
    await resolved.ports.refreshGraph();
    mocks.addInferred.mockResolvedValue({ added: 1, deduped: 2, droppedUnresolved: 3 });
    mocks.semantics.mockImplementation(async (input: { write(proposals: unknown[]): Promise<unknown> }) => input.write([]));
    await expect(resolved.ports.runSemantics?.(true)).resolves.toEqual({ written: 1, deduped: 2, droppedUnresolved: 3 });
  });

  it("rejects graph paths under .fusion", async () => {
    mocks.resolve.mockReturnValue("/repo/.fusion/graph");
    await expect(resolveMemoryConsolidationPorts({ taskStore: store(), rootDir: "/repo", agentId: "memory" })).resolves.toEqual({ status: "unavailable", reason: "knowledge-graph-dir-unresolved" });
  });
});
