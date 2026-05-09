import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import {
  MemoryBackupManager,
  createMemoryBackupManager,
  runMemoryBackupCommand,
  syncMemoryBackupRoutine,
  validateMemoryBackupSchedule,
} from "../memory-backup.js";
import { RoutineStore } from "../routine-store.js";
import type { ProjectSettings } from "../types.js";

describe("MemoryBackupManager", () => {
  let tempDir: string;
  let fusionDir: string;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    tempDir = mkdtempSync(join(tmpdir(), "kb-memory-backup-test-"));
    fusionDir = join(tempDir, ".fusion");
    await mkdir(join(tempDir, ".fusion/memory"), { recursive: true });
    await mkdir(join(tempDir, ".fusion/agent-memory/agent-1"), { recursive: true });
    await writeFile(join(tempDir, ".fusion/memory/MEMORY.md"), "project memory");
    await writeFile(join(tempDir, ".fusion/agent-memory/agent-1/MEMORY.md"), "agent memory");
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("creates and lists backups newest-first", async () => {
    const manager = new MemoryBackupManager(fusionDir);
    const b1 = await manager.createBackup();
    vi.setSystemTime(new Date("2026-01-01T00:00:01.000Z"));
    const b2 = await manager.createBackup();

    const backups = await manager.listBackups();
    expect(backups).toHaveLength(2);
    expect(backups[0].filename).toBe(b2.filename);
    expect(backups[1].filename).toBe(b1.filename);
    expect(backups[0].entryCount).toBeGreaterThan(0);
  });

  it("prunes old backups by retention", async () => {
    const manager = new MemoryBackupManager(fusionDir, { retention: 2 });
    for (let i = 0; i < 4; i++) {
      vi.setSystemTime(new Date(`2026-01-01T00:00:0${i}.000Z`));
      await manager.createBackup();
    }
    const deleted = await manager.cleanupOldBackups();
    expect(deleted).toBe(2);
    expect((await manager.listBackups()).length).toBe(2);
  });

  it("supports scope filters", async () => {
    const projectOnly = new MemoryBackupManager(fusionDir, { scope: "project" });
    const p = await projectOnly.createBackup();
    expect(existsSync(join(p.path, "project"))).toBe(true);
    expect(existsSync(join(p.path, "agents"))).toBe(false);

    vi.setSystemTime(new Date("2026-01-01T00:00:01.000Z"));
    const agentsOnly = new MemoryBackupManager(fusionDir, { scope: "agents" });
    const a = await agentsOnly.createBackup();
    expect(existsSync(join(a.path, "project"))).toBe(false);
    expect(existsSync(join(a.path, "agents"))).toBe(true);
  });

  it("restores with overwrite and non-overwrite guards", async () => {
    const manager = new MemoryBackupManager(fusionDir);
    const backup = await manager.createBackup();

    await writeFile(join(tempDir, ".fusion/memory/MEMORY.md"), "changed");
    await expect(manager.restoreBackup(backup.filename)).rejects.toThrow("Restore would overwrite modified memory file");

    await manager.restoreBackup(backup.filename, { overwrite: true });
    expect(readFileSync(join(tempDir, ".fusion/memory/MEMORY.md"), "utf-8")).toBe("project memory");
  });

  it("throws when both sources are missing", async () => {
    await rm(join(tempDir, ".fusion/memory"), { recursive: true, force: true });
    await rm(join(tempDir, ".fusion/agent-memory"), { recursive: true, force: true });
    const manager = new MemoryBackupManager(fusionDir);
    await expect(manager.createBackup()).rejects.toThrow("No memory sources found");
  });

  it("handles filename collisions with counter suffix", async () => {
    const manager = new MemoryBackupManager(fusionDir);
    const b1 = await manager.createBackup();
    const b2 = await manager.createBackup();
    expect(b1.filename).toMatch(/^memory-\d{4}-\d{2}-\d{2}-\d{6}$/);
    expect(b2.filename).toMatch(/^memory-\d{4}-\d{2}-\d{2}-\d{6}-1$/);
  });

  it("cleans up staging dir when create fails", async () => {
    await writeFile(join(tempDir, ".fusion/invalid-memory-backups"), "not-a-directory");
    const manager = new MemoryBackupManager(fusionDir, { backupDir: ".fusion/invalid-memory-backups" });

    await expect(manager.createBackup()).rejects.toThrow();

    expect(existsSync(join(tempDir, ".fusion/invalid-memory-backups/memory-2026-01-01-000000.tmp"))).toBe(false);
  });

  it("validates schedule", () => {
    expect(validateMemoryBackupSchedule("0 3 * * *")).toBe(true);
    expect(validateMemoryBackupSchedule("not a cron")).toBe(false);
  });

  it("runs memory backup command", async () => {
    const result = await runMemoryBackupCommand(fusionDir, {
      memoryBackupSchedule: "0 3 * * *",
      memoryBackupRetention: 14,
      memoryBackupScope: "all",
    } as ProjectSettings);
    expect(result.success).toBe(true);
    expect(result.backupPath).toContain("memory-");
  });

  it("sanitizes canonical backup dir settings", async () => {
    const manager = createMemoryBackupManager(fusionDir, { memoryBackupDir: ".kb/backups/memory" });
    const backup = await manager.createBackup();
    expect(backup.path).toContain(".fusion/backups/memory");
  });
});

describe("syncMemoryBackupRoutine", () => {
  let tempDir: string;
  let routineStore: RoutineStore;

  const baseSettings: ProjectSettings = {
    maxConcurrent: 2,
    maxWorktrees: 4,
    pollIntervalMs: 15000,
    groupOverlappingFiles: false,
    autoMerge: true,
  };

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "kb-memory-routine-test-"));
    routineStore = new RoutineStore(tempDir, { inMemoryDb: true });
    await routineStore.init();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("creates routine when enabled", async () => {
    const routine = await syncMemoryBackupRoutine(routineStore, {
      ...baseSettings,
      memoryBackupEnabled: true,
      memoryBackupSchedule: "0 3 * * *",
    });
    expect(routine?.command).toBe("fn memory-backup --create");
  });

  it("updates existing routine", async () => {
    const created = await syncMemoryBackupRoutine(routineStore, {
      ...baseSettings,
      memoryBackupEnabled: true,
      memoryBackupSchedule: "0 3 * * *",
    });

    const updated = await syncMemoryBackupRoutine(routineStore, {
      ...baseSettings,
      memoryBackupEnabled: true,
      memoryBackupSchedule: "0 4 * * *",
    });

    expect(updated?.id).toBe(created?.id);
    expect(updated?.trigger.type).toBe("cron");
  });

  it("deletes routine when disabled", async () => {
    await syncMemoryBackupRoutine(routineStore, {
      ...baseSettings,
      memoryBackupEnabled: true,
      memoryBackupSchedule: "0 3 * * *",
    });

    const out = await syncMemoryBackupRoutine(routineStore, {
      ...baseSettings,
      memoryBackupEnabled: false,
    });

    expect(out).toBeUndefined();
    expect((await routineStore.listRoutines()).length).toBe(0);
  });

  it("throws for invalid cron", async () => {
    await expect(syncMemoryBackupRoutine(routineStore, {
      ...baseSettings,
      memoryBackupEnabled: true,
      memoryBackupSchedule: "bad cron",
    })).rejects.toThrow("Invalid backup schedule");
  });
});
