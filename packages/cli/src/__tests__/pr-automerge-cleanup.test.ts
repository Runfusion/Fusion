import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../project-context.js", () => ({
  resolveProject: vi.fn(),
}));

vi.mock("@fusion/engine", () => ({
  releaseHeldTaskByEvent: vi.fn(),
}));

vi.mock("@fusion/dashboard", () => ({
  GitHubClient: class {},
  generatePrMetadata: vi.fn(),
}));

vi.mock("@fusion/core/gh-cli", () => ({
  classifyGhError: vi.fn(() => ({ message: "err" })),
  getGhErrorMessage: vi.fn(() => "err"),
  getCurrentRepo: vi.fn(() => ({ owner: "owner", repo: "repo" })),
  isGhAuthenticated: vi.fn(() => true),
  isGhAvailable: vi.fn(() => true),
}));

const { resolveProject } = await import("../project-context.js");
const { runPrAutomergeCleanup } = await import("../commands/pr.js");

function mockStore(results: Array<{ taskId: string; column: string; cleared: boolean }>) {
  const reconcileLegacyAutoMergeStamps = vi.fn().mockResolvedValue(results);
  vi.mocked(resolveProject).mockResolvedValue({
    store: { reconcileLegacyAutoMergeStamps } as never,
    projectPath: "/tmp/project",
    projectName: "proj",
  } as never);
  return { reconcileLegacyAutoMergeStamps };
}

describe("fn pr automerge-cleanup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("dry-runs by default and lists store-provided candidates", async () => {
    const store = mockStore([{ taskId: "FN-101", column: "in-review", cleared: false }]);

    await runPrAutomergeCleanup();

    expect(store.reconcileLegacyAutoMergeStamps).toHaveBeenCalledWith();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("candidate"));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("FN-101"));
  });

  it("passes apply only when --apply is requested", async () => {
    const store = mockStore([{ taskId: "FN-101", column: "in-review", cleared: true }]);

    await runPrAutomergeCleanup({ apply: true });

    expect(store.reconcileLegacyAutoMergeStamps).toHaveBeenCalledWith({ apply: true });
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("Cleared 1 legacy auto-merge stamp"));
  });

  it("prints well-formed JSON for non-empty dry-run results", async () => {
    mockStore([{ taskId: "FN-101", column: "in-review", cleared: false }]);

    await runPrAutomergeCleanup({ json: true });

    const payload = JSON.parse(vi.mocked(console.log).mock.calls[0]?.[0] as string) as {
      mode: string;
      count: number;
      candidates: Array<{ taskId: string; column: string; cleared: boolean }>;
    };
    expect(payload).toEqual({
      mode: "dry-run",
      count: 1,
      candidates: [{ taskId: "FN-101", column: "in-review", cleared: false }],
    });
  });

  it("prints well-formed JSON for empty apply results", async () => {
    const store = mockStore([]);

    await runPrAutomergeCleanup({ apply: true, json: true });

    expect(store.reconcileLegacyAutoMergeStamps).toHaveBeenCalledWith({ apply: true });
    const payload = JSON.parse(vi.mocked(console.log).mock.calls[0]?.[0] as string) as {
      mode: string;
      count: number;
      cleared: unknown[];
    };
    expect(payload).toEqual({ mode: "apply", count: 0, cleared: [] });
  });

  it("zero candidates is a successful no-op message", async () => {
    const store = mockStore([]);

    await runPrAutomergeCleanup();

    expect(store.reconcileLegacyAutoMergeStamps).toHaveBeenCalledWith();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("No legacy auto-merge stamps to clean up"));
    expect(console.error).not.toHaveBeenCalled();
  });
});
