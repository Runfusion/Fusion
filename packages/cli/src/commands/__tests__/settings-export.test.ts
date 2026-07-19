import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createTaskStoreForBackend, exportSettings, generateExportFilename } from "@fusion/core";
import { closeProjectStore, resolveProject } from "../../project-context.js";

function makeConstructibleMock<T extends (...args: any[]) => unknown>(impl?: T) {
  const mock = vi.fn(function () {});
  const originalMockImplementation = mock.mockImplementation.bind(mock);
  const originalMockImplementationOnce = mock.mockImplementationOnce.bind(mock);
  const wrap = (nextImpl: T) => function (this: unknown, ...args: Parameters<T>) {
    return nextImpl(...args);
  };
  mock.mockImplementation = ((nextImpl: T) => originalMockImplementation(wrap(nextImpl))) as typeof mock.mockImplementation;
  mock.mockImplementationOnce = ((nextImpl: T) => originalMockImplementationOnce(wrap(nextImpl))) as typeof mock.mockImplementationOnce;
  if (impl) {
    mock.mockImplementation(impl);
  }
  return mock;
}

const mockStoreInit = vi.fn().mockResolvedValue(undefined);
const mockBackendShutdown = vi.fn().mockResolvedValue(undefined);

vi.mock("node:fs/promises", () => ({
  writeFile: vi.fn(),
}));

vi.mock("@fusion/core", () => ({
  createTaskStoreForBackend: vi.fn(async () => ({ taskStore: { init: mockStoreInit }, shutdown: mockBackendShutdown })),
  TaskStore: makeConstructibleMock(() => ({
    init: mockStoreInit,
  })),
  exportSettings: vi.fn(),
  generateExportFilename: vi.fn(),
}));

vi.mock("../../project-context.js", () => ({
  resolveProject: vi.fn(),
  closeProjectStore: vi.fn(async () => undefined),
}));

import { runSettingsExport } from "../settings-export.js";

describe("runSettingsExport", () => {
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: string | number | null) => {
    if ((code ?? 0) === 0) {
      return undefined as never;
    }
    throw new Error(`process.exit:${code ?? 0}`);
  });

  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(resolveProject).mockResolvedValue({
      projectId: "proj-1",
      projectName: "demo",
      projectPath: "/tmp/demo",
      isRegistered: true,
      store: {} as any,
    });

    vi.mocked(generateExportFilename).mockReturnValue("fusion-settings-2026-04-08-120000.json");
    vi.mocked(exportSettings).mockResolvedValue({
      version: 1,
      exportedAt: "2026-04-08T12:00:00.000Z",
      global: { ntfyEnabled: true, defaultProvider: "anthropic" },
      project: { maxConcurrent: 3, maxWorktrees: 4 },
    } as any);
    vi.mocked(writeFile).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("exports successfully with an auto-generated filename", async () => {
    await runSettingsExport();

    const expectedPath = join(process.cwd(), "fusion-settings-2026-04-08-120000.json");
    expect(generateExportFilename).toHaveBeenCalled();
    expect(writeFile).toHaveBeenCalledWith(expectedPath, expect.any(String));
    expect(logSpy).toHaveBeenCalledWith(`  ✓ Settings exported to ${expectedPath}`);
    expect(logSpy).toHaveBeenCalledWith("    Exported: 2 global setting(s), 2 project setting(s)");
    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(mockBackendShutdown).toHaveBeenCalledTimes(1);
  });

  it("exports successfully with a custom --output path", async () => {
    await runSettingsExport({ output: "./tmp/exported.json" });

    expect(writeFile).toHaveBeenCalledWith(resolve("./tmp/exported.json"), expect.any(String));
  });

  it("exports only global settings with --scope global", async () => {
    vi.mocked(exportSettings).mockResolvedValue({
      version: 1,
      exportedAt: "2026-04-08T12:00:00.000Z",
      global: { ntfyEnabled: true },
    } as any);

    await runSettingsExport({ scope: "global" });

    expect(exportSettings).toHaveBeenCalledWith(expect.any(Object), { scope: "global" });
    expect(logSpy).toHaveBeenCalledWith("    Exported: 1 global setting(s)");
    expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining("project setting"));
  });

  it("exports only project settings with --scope project", async () => {
    vi.mocked(exportSettings).mockResolvedValue({
      version: 1,
      exportedAt: "2026-04-08T12:00:00.000Z",
      project: { maxConcurrent: 6 },
    } as any);

    await runSettingsExport({ scope: "project" });

    expect(exportSettings).toHaveBeenCalledWith(expect.any(Object), { scope: "project" });
    expect(logSpy).toHaveBeenCalledWith("    Exported: 1 project setting(s)");
    expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining("global setting"));
  });

  it("handles export with empty global/project settings", async () => {
    vi.mocked(exportSettings).mockResolvedValue({
      version: 1,
      exportedAt: "2026-04-08T12:00:00.000Z",
      global: {},
      project: {},
    } as any);

    await runSettingsExport();

    expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining("Exported:"));
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("prints an error and exits when exportSettings throws", async () => {
    vi.mocked(exportSettings).mockRejectedValue(new Error("export failed"));

    await expect(runSettingsExport()).rejects.toThrow("process.exit:1");

    expect(errorSpy).toHaveBeenCalledWith("Error: export failed");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("prints an error and exits when writing the file fails", async () => {
    vi.mocked(writeFile).mockRejectedValue(new Error("permission denied"));

    await expect(runSettingsExport()).rejects.toThrow("process.exit:1");

    expect(errorSpy).toHaveBeenCalledWith("Error: permission denied");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("resolves project name and initializes store at the resolved path", async () => {
    await runSettingsExport({ projectName: "alpha" });

    expect(resolveProject).toHaveBeenCalledWith("alpha");
    expect(closeProjectStore).toHaveBeenCalledWith(expect.objectContaining({ projectId: "proj-1" }));
    expect(createTaskStoreForBackend).toHaveBeenCalledWith({ rootDir: "/tmp/demo" });
  });

  it("closes the resolver-owned project before backend startup fails", async () => {
    vi.mocked(createTaskStoreForBackend).mockRejectedValueOnce(new Error("startup failed"));

    await expect(runSettingsExport({ projectName: "alpha" })).rejects.toThrow("startup failed");

    expect(closeProjectStore).toHaveBeenCalledTimes(1);
    expect(vi.mocked(closeProjectStore).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(createTaskStoreForBackend).mock.invocationCallOrder[0]);
  });
});
