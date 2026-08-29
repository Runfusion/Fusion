import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadArtifacts, neighbors, resolveKnowledgeGraphDir, type KnowledgeGraph } from "@fusion/core";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  prompt: vi.fn(),
  mcp: vi.fn(async () => ({ servers: [] })),
}));
vi.mock("../pi.js", () => ({ createFnAgent: mocks.create, promptWithFallback: mocks.prompt }));
vi.mock("../mcp/mcp-resolution.js", () => ({ resolveMcpServersForStore: mocks.mcp }));

import { parseMemorySemanticsResponse, runMemorySemanticsPass } from "../memory/memory-semantics.js";
import { resolveMemoryConsolidationPorts } from "../memory/memory-consolidation-adapters.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

const graph: KnowledgeGraph = {
  schemaVersion: 2,
  nodes: [
    { id: "doc:docs/a.md#one~0", kind: "doc-concept", name: "one", owner: "file", ownerPath: "docs/a.md", source: { path: "docs/a.md", line: 1, column: 1 }, attributes: {} },
    { id: "doc:docs/a.md#two~1", kind: "doc-concept", name: "two", owner: "file", ownerPath: "docs/a.md", source: { path: "docs/a.md", line: 2, column: 1 }, attributes: {} },
  ],
  edges: [],
};

const taskStore = { getSettings: vi.fn(async () => ({ defaultProvider: "mock", defaultModelId: "scripted" })) } as never;

beforeEach(() => {
  mocks.create.mockReset();
  mocks.prompt.mockReset();
  mocks.mcp.mockClear();
});

describe("memory semantics pass", () => {
  it("accepts only semantic relationship families and drops a model provenance claim", () => {
    const result = parseMemorySemanticsResponse(JSON.stringify({ proposals: [
      { kind: "relates-to", from: "doc:a", to: "doc:b", provenance: "extracted" },
      { kind: "contains", from: "doc:a", to: "doc:b" },
    ] }));
    expect(result.proposals).toEqual([{ kind: "relates-to", from: "doc:a", to: "doc:b" }]);
  });

  it("drives the readonly mock lane and forwards provenance-free proposals only to the inferred writer", async () => {
    let onText: ((text: string) => void) | undefined;
    const session = { state: {}, dispose: vi.fn() };
    mocks.create.mockImplementation(async (options) => { onText = options.onText; return { session }; });
    mocks.prompt.mockImplementation(async () => {
      onText?.(JSON.stringify({ proposals: [{ kind: "relates-to", from: "doc:docs/a.md#one~0", to: "doc:docs/a.md#two~1", provenance: "extracted" }] }));
    });
    const write = vi.fn(async (proposals) => ({ written: proposals.length, deduped: 0, droppedUnresolved: 0 }));

    await expect(runMemorySemanticsPass({ graph, graphChanged: true, taskStore, agentId: "memory", rootDir: "/repo", write })).resolves.toMatchObject({ written: 1, deduped: 0, droppedUnresolved: 0 });
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ tools: "readonly", defaultProvider: "mock", defaultModelId: "scripted" }));
    expect(write).toHaveBeenCalledWith([{ kind: "relates-to", from: "doc:docs/a.md#one~0", to: "doc:docs/a.md#two~1" }]);
    expect(session.dispose).toHaveBeenCalledOnce();
  });

  it("persists mocked model output through the production consolidation adapter as inferred graph evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "memory-semantics-"));
    roots.push(root);
    await writeFile(join(root, "AGENTS.md"), "# One\n\n# Two\n");
    const layer = { projectId: "P-SEMANTICS" };
    const productionStore = {
      getAsyncLayer: () => layer,
      getSettings: async () => ({ defaultProvider: "mock", defaultModelId: "scripted" }),
    } as never;
    const resolved = await resolveMemoryConsolidationPorts({ taskStore: productionStore, rootDir: root, agentId: "memory" });
    expect(resolved.status).toBe("ready");
    if (resolved.status !== "ready") return;

    await resolved.ports.refreshGraph();
    const before = await loadArtifacts(resolveKnowledgeGraphDir(root));
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    const [from, to] = before.graph.nodes.filter(node => node.kind === "doc-concept").map(node => node.id);
    expect(from).toBeTruthy();
    expect(to).toBeTruthy();

    let onText: ((text: string) => void) | undefined;
    mocks.create.mockImplementation(async (options) => { onText = options.onText; return { session: { state: {}, dispose: vi.fn() } }; });
    mocks.prompt.mockImplementation(async () => {
      onText?.(JSON.stringify({ proposals: [{ kind: "relates-to", from, to, provenance: "extracted" }] }));
    });

    await expect(resolved.ports.runSemantics(true)).resolves.toMatchObject({ written: 1 });
    const loaded = await loadArtifacts(resolveKnowledgeGraphDir(root));
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(neighbors(loaded.graph, from!)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        node: expect.objectContaining({ id: to }),
        edges: expect.arrayContaining([expect.objectContaining({ provenance: "inferred" })]),
      }),
    ]));
  });

  it("does not contact a model or write during an unchanged repeat tick", async () => {
    const write = vi.fn();
    await expect(runMemorySemanticsPass({ graph, graphChanged: false, taskStore, agentId: "memory", rootDir: "/repo", write })).resolves.toEqual({ proposals: [], skipped: "unchanged" });
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.prompt).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("treats malformed model output as a counted, non-throwing skip", async () => {
    let onText: ((text: string) => void) | undefined;
    mocks.create.mockImplementation(async (options) => { onText = options.onText; return { session: { state: {}, dispose: vi.fn() } }; });
    mocks.prompt.mockImplementation(async () => { onText?.("not json"); });
    await expect(runMemorySemanticsPass({ graph, graphChanged: true, taskStore, agentId: "memory", rootDir: "/repo", write: vi.fn() })).resolves.toMatchObject({ skipped: "malformed-response" });
  });
});
