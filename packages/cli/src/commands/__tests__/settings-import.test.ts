import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { createTaskStoreForBackend, importSettings, readExportFile, validateImportData } from "@fusion/core";
import { resolveProject } from "../../project-context.js";

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
const mockStoreClose = vi.fn().mockResolvedValue(undefined);

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
}));

// FN-7740: `runSettingsImport` now imports `retryOnLock` (which imports
// `isSqliteLockError` from @fusion/core) and closes its store via
// `asLocalProjectContext`/`closeProjectStore`. Per project memory, a fully
// mocked `@fusion/core` module must stub `isSqliteLockError` once any
// command under test transitively imports `lock-retry.js`, and the mocked
// `TaskStore` needs a `close()` so the close-before-exit path is exercised.
vi.mock("@fusion/core", () => ({
  // FNXC:PostgresCutover 2026-07-10: PG startup factory consulted before legacy TaskStore; null keeps the legacy mock path.
  createTaskStoreForBackend: vi.fn(async () => ({
    taskStore: { init: mockStoreInit, close: mockStoreClose },
    shutdown: vi.fn(async () => mockStoreClose()),
  })),
  TaskStore: makeConstructibleMock(() => ({
    init: mockStoreInit,
    close: mockStoreClose,
  })),
  importSettings: vi.fn(),
  readExportFile: vi.fn(),
  validateImportData: vi.fn(),
  isSqliteLockError: vi.fn(() => false),
}));

// FN-7740: `runSettingsImport` now resolves the name→path via
// `resolveProjectPathOnly` (path-only) instead of using `resolveProject`'s
// `.store` directly, and wraps its own uncached store via
// `asLocalProjectContext`/`closeProjectStore` before every `process.exit()`.
// Stub all four so existing assertions on `resolveProject` call args keep
// working (see project memory on this test-mock pitfall).
vi.mock("../../project-context.js", () => ({
  resolveProject: vi.fn(),
  resolveProjectPathOnly: vi.fn(async (projectName?: string) => {
    const { resolveProject: resolveProjectMock } = await import("../../project-context.js");
    const context = await (resolveProjectMock as ReturnType<typeof vi.fn>)(projectName);
    return context.projectPath;
  }),
  asLocalProjectContext: vi.fn((store: unknown) => ({
    projectId: "cwd",
    projectPath: "cwd",
    projectName: "cwd",
    isRegistered: false,
    store,
  })),
  closeProjectStore: vi.fn(async (context: { store: { close?: () => Promise<void> } }) => {
    try {
      await context.store.close?.();
    } catch {
      // best-effort
    }
  }),
}));

import { runSettingsImport } from "../settings-import.js";

describe("runSettingsImport", () => {
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

    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readExportFile).mockResolvedValue({
      version: 1,
      exportedAt: "2026-04-08T00:00:00.000Z",
      global: { ntfyEnabled: true, defaultProvider: "anthropic" },
      project: { maxConcurrent: 3, autoResolveConflicts: true, maxWorktrees: 4 },
    } as any);
    vi.mocked(validateImportData).mockReturnValue([]);
    vi.mocked(importSettings).mockResolvedValue({
      success: true,
      globalCount: 2,
      projectCount: 3,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("exits when import file does not exist", async () => {
    vi.mocked(existsSync).mockReturnValue(false);

    await expect(runSettingsImport("./missing.json", { yes: true })).rejects.toThrow("process.exit:1");

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("File not found"));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("exits when reading the import file fails", async () => {
    vi.mocked(readExportFile).mockRejectedValue(new Error("read denied"));

    await expect(runSettingsImport("./settings.json", { yes: true })).rejects.toThrow("process.exit:1");

    expect(errorSpy).toHaveBeenCalledWith("Error: Failed to read import file: read denied");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("prints validation errors and exits", async () => {
    vi.mocked(validateImportData).mockReturnValue(["bad version", "missing global"]);

    await expect(runSettingsImport("./settings.json", { yes: true })).rejects.toThrow("process.exit:1");

    expect(errorSpy).toHaveBeenCalledWith("Error: Invalid import file:");
    expect(errorSpy).toHaveBeenCalledWith("  - bad version");
    expect(errorSpy).toHaveBeenCalledWith("  - missing global");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("fails when selected scope has no settings to import", async () => {
    vi.mocked(readExportFile).mockResolvedValue({
      version: 1,
      exportedAt: "2026-04-08T00:00:00.000Z",
      global: {},
      project: {},
    } as any);

    await expect(runSettingsImport("./settings.json", { yes: true })).rejects.toThrow("process.exit:1");

    expect(errorSpy).toHaveBeenCalledWith("Error: No settings to import in the specified scope");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("requires --yes confirmation before importing", async () => {
    await expect(runSettingsImport("./settings.json")).rejects.toThrow("process.exit:1");

    expect(logSpy).toHaveBeenCalledWith("  Use --yes to confirm this import operation");
    expect(importSettings).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("imports successfully with --yes", async () => {
    await runSettingsImport("./settings.json", { yes: true });

    expect(importSettings).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      { scope: "both", merge: true },
    );
    expect(logSpy).toHaveBeenCalledWith("  ✓ Settings imported successfully");
    expect(logSpy).toHaveBeenCalledWith("    Imported 2 global setting(s)");
    expect(logSpy).toHaveBeenCalledWith("    Imported 3 project setting(s)");
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("imports only global settings when --scope global is used", async () => {
    vi.mocked(importSettings).mockResolvedValue({
      success: true,
      globalCount: 2,
      projectCount: 0,
    });

    await runSettingsImport("./settings.json", { scope: "global", yes: true });

    expect(importSettings).toHaveBeenCalledWith(expect.any(Object), expect.any(Object), {
      scope: "global",
      merge: true,
    });
    expect(logSpy).toHaveBeenCalledWith("    Imported 2 global setting(s)");
    expect(logSpy).not.toHaveBeenCalledWith("    Imported 3 project setting(s)");
  });

  it("imports only project settings when --scope project is used", async () => {
    vi.mocked(importSettings).mockResolvedValue({
      success: true,
      globalCount: 0,
      projectCount: 3,
    });

    await runSettingsImport("./settings.json", { scope: "project", yes: true });

    expect(importSettings).toHaveBeenCalledWith(expect.any(Object), expect.any(Object), {
      scope: "project",
      merge: true,
    });
    expect(logSpy).toHaveBeenCalledWith("    Imported 3 project setting(s)");
    expect(logSpy).not.toHaveBeenCalledWith("    Imported 2 global setting(s)");
  });

  it("prints core import failure and exits", async () => {
    vi.mocked(importSettings).mockResolvedValue({
      success: false,
      globalCount: 0,
      projectCount: 0,
      error: "DB error",
    });

    await expect(runSettingsImport("./settings.json", { yes: true })).rejects.toThrow("process.exit:1");

    expect(errorSpy).toHaveBeenCalledWith("Error: Import failed: DB error");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("shows replace mode when merge is false", async () => {
    await expect(runSettingsImport("./settings.json", { merge: false })).rejects.toThrow("process.exit:1");

    expect(logSpy).toHaveBeenCalledWith("  Mode: replace");
    expect(importSettings).not.toHaveBeenCalled();
  });

  it("resolves project name and initializes store at resolved path", async () => {
    await runSettingsImport("./settings.json", { projectName: "alpha", yes: true });

    expect(resolveProject).toHaveBeenCalledWith("alpha");
    expect(createTaskStoreForBackend).toHaveBeenCalledWith({ rootDir: "/tmp/demo" });
    expect(mockStoreInit).not.toHaveBeenCalled();
  });
});
