import { describe, expect, it, vi } from "vitest";
import { fileNodeId, type GraphNode, type RecallRecord } from "@fusion/core";
import { MemoryConsolidationError, MemoryConsolidationService, type MemoryConsolidationPorts } from "../memory/memory-consolidation.js";
import { deriveRecallMaterial } from "../memory/memory-consolidation-material.js";

const rationale = (id: string, ownerPath = "src/a.ts"): GraphNode => ({
  id, kind: "rationale", name: "Memory", owner: "file", ownerPath,
  source: { path: ownerPath, line: 1, column: 1 },
  attributes: { fnxcArea: "Memory", fnxcStamp: "2026-08-11-09:41", fnxcText: `decision ${id}` },
});
const record = (id: string): RecallRecord => ({ id, projectId: "project", kind: "decision", content: id, contentHash: id, source: { origin: "other" }, tags: [], graphNodeIds: [], createdAt: "", updatedAt: "" });
const graph = (changed: boolean, nodes = [rationale("rationale:src/a.ts#Memory@x~0")]) => ({ rationaleNodes: nodes, nodeCount: nodes.length, edgeCount: 0, changed, recoveryReason: null, stats: { parsedFiles: 1, reusedFiles: 0, prunedFiles: 0 } });

function ports(overrides: Partial<MemoryConsolidationPorts> = {}): MemoryConsolidationPorts {
  return {
    refreshGraph: vi.fn(async () => graph(true)),
    appendRecall: vi.fn(async () => ({ status: "created" as const, record: record("rec-1") })),
    mergeRecallGraphNodeIds: vi.fn(async () => ({ status: "unchanged" as const })),
    clock: vi.fn().mockImplementationOnce(() => 1).mockReturnValue(2),
    ...overrides,
  };
}

describe("MemoryConsolidationService", () => {
  it("is silent on an unchanged second tick while still using dedup probes", async () => {
    const p = ports(); const service = new MemoryConsolidationService(p);
    expect((await service.runConsolidationTick({ agentId: "memory", projectId: "project" })).changed).toBe(true);
    vi.mocked(p.refreshGraph).mockResolvedValue(graph(false));
    vi.mocked(p.appendRecall).mockResolvedValue({ status: "duplicate", duplicateOf: record("rec-1"), similarity: 1 });
    const unchanged = await service.runConsolidationTick({ agentId: "memory", projectId: "project" });
    expect(unchanged).toMatchObject({ changed: false, recallCreated: 0, recallDuplicate: 1, crossRefUpdated: 0 });
    expect(p.mergeRecallGraphNodeIds).toHaveBeenLastCalledWith("rec-1", expect.any(Array));
  });

  it("uses normalized graph ids and aggregates duplicate targets into one merge", async () => {
    const nodes = [rationale("rationale:one", "src\\a.ts"), rationale("rationale:two", "src/b.ts")];
    const p = ports({ refreshGraph: vi.fn(async () => graph(false, nodes)), appendRecall: vi.fn(async () => ({ status: "duplicate", duplicateOf: record("rec-1"), similarity: 1 })), mergeRecallGraphNodeIds: vi.fn(async () => ({ status: "updated" as const })) });
    await new MemoryConsolidationService(p).runConsolidationTick({ agentId: "memory", projectId: "project" });
    expect(p.mergeRecallGraphNodeIds).toHaveBeenCalledTimes(1);
    expect(p.mergeRecallGraphNodeIds).toHaveBeenCalledWith("rec-1", ["rationale:one", "rationale:two", fileNodeId("src/a.ts"), fileNodeId("src/b.ts")].sort());
  });

  it("claims synchronous callers and releases after failures", async () => {
    let reject!: (error: Error) => void;
    const pending = new Promise<never>((_, r) => { reject = r; });
    const p = ports({ refreshGraph: vi.fn(() => pending) }); const service = new MemoryConsolidationService(p);
    const first = service.runConsolidationTick({ agentId: "memory", projectId: "project" });
    const second = service.runConsolidationTick({ agentId: "memory", projectId: "project" });
    expect(await second).toMatchObject({ skipped: "in-progress", changed: false });
    reject(new Error("graph unavailable"));
    await expect(first).rejects.toMatchObject({ stage: "graph" } satisfies Partial<MemoryConsolidationError>);
    vi.mocked(p.refreshGraph).mockResolvedValue(graph(false));
    vi.mocked(p.appendRecall).mockResolvedValue({ status: "duplicate", duplicateOf: record("rec-1"), similarity: 1 });
    await expect(service.runConsolidationTick({ agentId: "memory", projectId: "project" })).resolves.toMatchObject({ changed: false });
  });

  it("derives deterministic material and skips blank rationale text", () => {
    const node = rationale("rationale:one"); const blank = { ...rationale("rationale:blank"), attributes: {} };
    expect(deriveRecallMaterial([node, blank], "memory")).toEqual(deriveRecallMaterial([node, blank], "memory"));
    expect(deriveRecallMaterial([node, blank], "memory")).toHaveLength(1);
  });
});
