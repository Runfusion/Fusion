import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Hoist mocks so they are evaluated before module imports
const { mockGetDatabase, mockVacuum, mockResolveProject } = vi.hoisted(() => ({
  mockGetDatabase: vi.fn(),
  mockVacuum: vi.fn(),
  mockResolveProject: vi.fn(),
}));

vi.mock("@fusion/core", () => ({
  TaskStore: vi.fn().mockImplementation(() => ({
    init: vi.fn(),
    getDatabase: mockGetDatabase,
  })),
}));

vi.mock("../../project-context.js", () => ({
  resolveProject: mockResolveProject,
}));

import { runDbVacuum } from "../db.ts";

describe("runDbVacuum", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: string | number | null) => {
      throw new Error(`process.exit:${code ?? 0}`);
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("resolves project store and calls vacuum", async () => {
    mockResolveProject.mockResolvedValue({
      projectId: "proj-1",
      projectName: "demo-project",
      projectPath: "/projects/demo",
      isRegistered: true,
      store: { getDatabase: mockGetDatabase },
    });
    mockGetDatabase.mockReturnValue({
      vacuum: mockVacuum.mockReturnValue({
        beforeSize: 10_485_760,
        afterSize: 7_340_416,
        durationMs: 123,
      }),
      getPath: () => "/projects/demo/.fusion/fusion.db",
    });

    await expect(runDbVacuum("demo-project")).rejects.toThrow("process.exit:0");
    expect(mockResolveProject).toHaveBeenCalledWith("demo-project");
    expect(mockVacuum).toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("VACUUM"));
  });

  it("exits 1 on vacuum error", async () => {
    mockResolveProject.mockResolvedValue({
      projectId: "proj-1",
      projectName: "demo-project",
      projectPath: "/projects/demo",
      isRegistered: true,
      store: { getDatabase: mockGetDatabase },
    });
    mockGetDatabase.mockReturnValue({
      vacuum: mockVacuum.mockRejectedValue(new Error("database locked")),
      getPath: () => "/projects/demo/.fusion/fusion.db",
    });

    await expect(runDbVacuum("demo-project")).rejects.toThrow("process.exit:1");
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("database locked"));
  });

  it("falls back to cwd TaskStore when resolveProject fails", async () => {
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue("/fallback/project");
    mockResolveProject.mockRejectedValue(new Error("no project"));

    const mockStore = { init: vi.fn(), getDatabase: mockGetDatabase };
    mockGetDatabase.mockReturnValue({
      vacuum: mockVacuum.mockReturnValue({ beforeSize: 0, afterSize: 0, durationMs: 0 }),
      getPath: () => "/fallback/project/.fusion/fusion.db",
    });

    await expect(runDbVacuum("missing")).rejects.toThrow("process.exit:0");
    expect(mockResolveProject).toHaveBeenCalledWith("missing");
    cwdSpy.mockRestore();
  });

  it("skips vacuum on in-memory database (returns zero sizes)", async () => {
    mockResolveProject.mockResolvedValue({
      projectId: "proj-1",
      projectName: "mem-project",
      projectPath: "/mem",
      isRegistered: true,
      store: { getDatabase: mockGetDatabase },
    });
    mockGetDatabase.mockReturnValue({
      vacuum: mockVacuum.mockReturnValue({ beforeSize: 0, afterSize: 0, durationMs: 0 }),
      getPath: () => ":memory:",
    });

    await expect(runDbVacuum("mem-project")).rejects.toThrow("process.exit:0");
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("in-memory"));
  });
});
