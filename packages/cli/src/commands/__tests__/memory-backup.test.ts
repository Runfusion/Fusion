import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const {
  mockListBackups,
  mockRestoreBackup,
  mockGetSettings,
  mockRunMemoryBackupCommand,
  mockResolveProject,
} = vi.hoisted(() => ({
  mockListBackups: vi.fn(),
  mockRestoreBackup: vi.fn(),
  mockGetSettings: vi.fn(),
  mockRunMemoryBackupCommand: vi.fn(),
  mockResolveProject: vi.fn(),
}));

vi.mock("@fusion/core", () => ({
  TaskStore: vi.fn().mockImplementation(() => ({
    init: vi.fn().mockResolvedValue(undefined),
    getSettings: mockGetSettings,
    fusionDir: "/cwd/.fusion",
  })),
  createMemoryBackupManager: vi.fn(() => ({
    listBackups: mockListBackups,
    restoreBackup: mockRestoreBackup,
  })),
  runMemoryBackupCommand: mockRunMemoryBackupCommand,
}));

vi.mock("../../project-context.js", () => ({
  resolveProject: mockResolveProject,
}));

import { runMemoryBackupCreate, runMemoryBackupList, runMemoryBackupRestore } from "../memory-backup.js";

describe("memory-backup commands", () => {
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

    mockGetSettings.mockResolvedValue({ memoryBackupSchedule: "0 3 * * *" });
    mockRunMemoryBackupCommand.mockResolvedValue({ success: true, output: "memory backup created" });
    mockListBackups.mockResolvedValue([]);
    mockRestoreBackup.mockResolvedValue(undefined);
    mockResolveProject.mockResolvedValue({
      store: { getSettings: mockGetSettings, fusionDir: "/projects/demo/.fusion" },
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("create path succeeds", async () => {
    await expect(runMemoryBackupCreate({ projectName: "demo", scope: "agents" })).rejects.toThrow("process.exit:0");
    expect(mockRunMemoryBackupCommand).toHaveBeenCalledWith(
      "/projects/demo/.fusion",
      expect.objectContaining({ memoryBackupScope: "agents" }),
    );
  });

  it("list path renders entries", async () => {
    mockListBackups.mockResolvedValue([
      { filename: "memory-2026-01-01-000000", createdAt: new Date().toISOString(), size: 100, scope: "all", entryCount: 3 },
    ]);
    await runMemoryBackupList("demo");
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Found 1 memory backup"));
  });

  it("restore path calls manager", async () => {
    await runMemoryBackupRestore("memory-2026-01-01-000000", "demo");
    expect(mockRestoreBackup).toHaveBeenCalledWith("memory-2026-01-01-000000", { overwrite: true });
  });

  it("create path fails on invalid schedule", async () => {
    mockRunMemoryBackupCommand.mockResolvedValue({ success: false, output: "Invalid memory backup schedule: bad" });
    await expect(runMemoryBackupCreate({ projectName: "demo" })).rejects.toThrow("process.exit:1");
    expect(errorSpy).toHaveBeenCalledWith("Invalid memory backup schedule: bad");
  });
});
