import { beforeEach, describe, expect, it, vi } from "vitest";

const build = vi.hoisted(() => vi.fn().mockResolvedValue({
  graph: { nodes: [], edges: [] },
  changed: false,
  stats: {
    parsedFiles: 1,
    reusedFiles: 0,
    prunedFiles: 0,
    addedFiles: 1,
    deletedFiles: 0,
    synthesizedImportEdges: 2,
    derivedModuleCount: 0,
    recoveryReason: null,
  },
}));
const close = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const settings = vi.hoisted(() => vi.fn().mockResolvedValue({ knowledgeGraphDir: ".graph" }));
const resolveProject = vi.hoisted(() => vi.fn().mockResolvedValue({
  projectPath: "/project",
  store: { getSettings: settings },
}));

class TestLockRetryExhaustedError extends Error {}

vi.mock("@fusion/core", () => ({
  buildKnowledgeGraph: build,
  resolveKnowledgeGraphDir: (root: string, dir?: string) =>
    `${root}/${dir ?? ".fusion-knowledge/graph"}`,
}));
vi.mock("../project-context.js", () => ({
  resolveProject,
  closeProjectStore: close,
  createLocalStore: vi.fn(),
  asLocalProjectContext: vi.fn(),
}));
vi.mock("../lock-retry.js", () => ({
  retryOnLock: (run: () => unknown) => run(),
  LockRetryExhaustedError: TestLockRetryExhaustedError,
}));

const { runKnowledgeGraphBuild } = await import("../commands/knowledge-graph.js");

describe("knowledge graph CLI command", () => {
  beforeEach(() => {
    build.mockReset().mockResolvedValue({
      graph: { nodes: [], edges: [] },
      changed: false,
      stats: {
        parsedFiles: 1,
        reusedFiles: 0,
        prunedFiles: 0,
        addedFiles: 1,
        deletedFiles: 0,
        synthesizedImportEdges: 2,
        derivedModuleCount: 0,
        recoveryReason: null,
      },
    });
    close.mockClear();
    settings.mockReset().mockResolvedValue({ knowledgeGraphDir: ".graph" });
    resolveProject.mockClear();
  });

  it("uses an explicit directory over settings and emits complete JSON", async () => {
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await runKnowledgeGraphBuild({ dir: ".custom", json: true });

    expect(build).toHaveBeenCalledWith(expect.objectContaining({ graphDir: "/project/.custom" }));
    expect(close).toHaveBeenCalledTimes(1);
    expect(JSON.parse(output.mock.calls[0]![0] as string)).toMatchObject({
      recoveryReason: null,
      synthesizedImportEdges: 2,
      changed: false,
    });
    output.mockRestore();
  });

  it("uses the setting before the default directory", async () => {
    await runKnowledgeGraphBuild();
    expect(build).toHaveBeenCalledWith(expect.objectContaining({ graphDir: "/project/.graph" }));
  });

  it("reports all operator-facing build counters in human output", async () => {
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    build.mockResolvedValueOnce({
      graph: { nodes: [{}, {}], edges: [{}] },
      changed: true,
      stats: { parsedFiles: 2, reusedFiles: 3, prunedFiles: 4, addedFiles: 2, deletedFiles: 4, synthesizedImportEdges: 5, derivedModuleCount: 6, recoveryReason: "forced" },
    });

    await runKnowledgeGraphBuild();

    expect(output).toHaveBeenCalledWith(expect.stringContaining("pruned 4"));
    expect(output).toHaveBeenCalledWith(expect.stringContaining("synthesized imports 5"));
    expect(output).toHaveBeenCalledWith(expect.stringContaining("derived modules 6"));
    expect(output).toHaveBeenCalledWith(expect.stringContaining("recovery=forced"));
    output.mockRestore();
  });

  it("closes the store when the settings retry is exhausted", async () => {
    settings.mockRejectedValueOnce(new TestLockRetryExhaustedError("locked"));

    await expect(runKnowledgeGraphBuild()).rejects.toThrow("locked");
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("closes the store when building fails", async () => {
    build.mockRejectedValueOnce(new Error("failed"));

    await expect(runKnowledgeGraphBuild()).rejects.toThrow("failed");
    expect(close).toHaveBeenCalledTimes(1);
  });
});
