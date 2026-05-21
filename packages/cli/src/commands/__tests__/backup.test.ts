import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const {
  mockListBackups,
  mockListBackupPairs,
  mockRestoreBackup,
  mockCleanupOldBackups,
  mockGetSettings,
  mockRunBackupCommand,
  mockResolveProject,
} = vi.hoisted(() => ({
  mockListBackups: vi.fn(),
  mockListBackupPairs: vi.fn(),
  mockRestoreBackup: vi.fn(),
  mockCleanupOldBackups: vi.fn(),
  mockGetSettings: vi.fn(),
  mockRunBackupCommand: vi.fn(),
  mockResolveProject: vi.fn(),
}));

vi.mock("@fusion/core", () => ({
  BackupManager: vi.fn(),
  TaskStore: vi.fn().mockImplementation(() => ({
    init: vi.fn().mockResolvedValue(undefined),
    getSettings: mockGetSettings,
    fusionDir: "/cwd/.fusion",
  })),
  createBackupManager: vi.fn(() => ({
    listBackups: mockListBackups,
    listBackupPairs: mockListBackupPairs,
    restoreBackup: mockRestoreBackup,
    cleanupOldBackups: mockCleanupOldBackups,
  })),
  runBackupCommand: mockRunBackupCommand,
}));

vi.mock("../../project-context.js", () => ({
  resolveProject: mockResolveProject,
}));

import { TaskStore } from "@fusion/core";
import { runBackupCreate, runBackupList, runBackupRestore, runBackupCleanup } from "../backup.js";

describe("backup commands", () => {
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
    mockGetSettings.mockResolvedValue({ autoBackupDir: ".fusion/backups" });
    mockRunBackupCommand.mockResolvedValue({ success: true, output: "backup created" });
    mockListBackups.mockResolvedValue([]);
    mockListBackupPairs.mockResolvedValue([]);
    mockRestoreBackup.mockResolvedValue(undefined);
    mockCleanupOldBackups.mockResolvedValue(0);
    mockResolveProject.mockResolvedValue({
      projectId: "proj-1",
      projectName: "demo-project",
      projectPath: "/projects/demo",
      isRegistered: true,
      store: { getSettings: mockGetSettings, fusionDir: "/projects/demo/.fusion" },
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("runBackupCreate uses resolved project store with --project", async () => {
    await expect(runBackupCreate("demo-project")).rejects.toThrow("process.exit:0");
    expect(mockResolveProject).toHaveBeenCalledWith("demo-project");
    expect(mockRunBackupCommand).toHaveBeenCalledWith("/projects/demo/.fusion", expect.anything());
  });

  it("runBackupList uses resolved project store with --project", async () => {
    mockListBackupPairs.mockResolvedValue([
      { timestamp: "2026-01-01-000000", project: { filename: "fusion-2026-01-01-000000.db", size: 1024, createdAt: "2026-01-01T00:00:00.000Z" }, central: { filename: "fusion-central-2026-01-01-000000.db", size: 512, createdAt: "2026-01-01T00:00:00.000Z" } },
      { timestamp: "2026-01-01-000001", central: { filename: "fusion-central-2026-01-01-000001.db", size: 256, createdAt: "2026-01-01T00:00:01.000Z" } },
    ]);
    await runBackupList("demo-project");
    expect(mockResolveProject).toHaveBeenCalledWith("demo-project");
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Date"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("2026-01-01 00:00:00"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("fusion-2026-01-01-000000.db"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("└─ fusion-central-2026-01-01-000000.db"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("orphan central backup"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Total: 1.75 KB"));
  });

  it("runBackupRestore uses resolved project store with --project", async () => {
    await runBackupRestore("fusion.db.bak", "demo-project");
    expect(mockResolveProject).toHaveBeenCalledWith("demo-project");
    expect(mockRestoreBackup).toHaveBeenCalledWith("fusion.db.bak", { createPreRestoreBackup: true });
  });

  it("runBackupCleanup uses resolved project store with --project", async () => {
    mockCleanupOldBackups.mockResolvedValue(2);
    await runBackupCleanup("demo-project");
    expect(mockResolveProject).toHaveBeenCalledWith("demo-project");
    expect(logSpy).toHaveBeenCalledWith("Removed 2 old backup(s) and any paired central backup files.");
  });

  it("runBackupList without project uses shared resolution flow", async () => {
    await runBackupList();
    expect(mockResolveProject).toHaveBeenCalledWith(undefined);
    expect(TaskStore).not.toHaveBeenCalled();
  });

  it("runBackupList without project falls back to current cwd task store when resolution fails", async () => {
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue("/local/project");
    mockResolveProject.mockRejectedValueOnce(new Error("No fn project found"));
    await runBackupList();
    expect(mockResolveProject).toHaveBeenCalledWith(undefined);
    expect(TaskStore).toHaveBeenCalledWith("/local/project");
    cwdSpy.mockRestore();
  });

  it("falls back to current cwd task store when project resolution fails for project-targeted commands", async () => {
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue("/fallback/project");
    mockResolveProject.mockRejectedValue(new Error("Project 'missing' not found. Run 'fn project list' to see registered projects."));

    await runBackupList("missing");
    expect(TaskStore).toHaveBeenCalledWith("/fallback/project");
    cwdSpy.mockRestore();
  });
});
