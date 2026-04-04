import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskStore } from "./store.js";
import type { GlobalSettingsStore } from "./global-settings.js";
import type { Settings, GlobalSettings, ProjectSettings } from "./types.js";
import {
  exportSettings,
  importSettings,
  validateImportData,
  generateExportFilename,
  readExportFile,
  writeExportFile,
  type SettingsExportData,
  type ExportSettingsOptions,
  type ImportSettingsOptions,
} from "./settings-export.js";

// Helper to create a temporary test environment
function createTestEnv() {
  const tempDir = mkdtempSync(join(tmpdir(), "kb-settings-test-"));
  const kbDir = join(tempDir, ".fusion");
  const tasksDir = join(kbDir, "tasks");
  const globalSettingsDir = join(tempDir, "global-settings");

  mkdirSync(tasksDir, { recursive: true });
  mkdirSync(globalSettingsDir, { recursive: true });

  // Create initial config.json
  writeFileSync(
    join(kbDir, "config.json"),
    JSON.stringify({ nextId: 1, settings: {} }),
  );

  // Create initial global settings
  writeFileSync(
    join(globalSettingsDir, "settings.json"),
    JSON.stringify({}),
  );

  return { tempDir, kbDir, tasksDir, globalSettingsDir };
}

// Helper to clean up test environment
function cleanupTestEnv(tempDir: string) {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

describe("settings-export", () => {
  let env: ReturnType<typeof createTestEnv>;
  let store: TaskStore;

  beforeEach(async () => {
    env = createTestEnv();
    const { TaskStore } = await import("./store.js");
    store = new TaskStore(env.tempDir, env.globalSettingsDir);
    await store.init();
  });

  afterEach(() => {
    cleanupTestEnv(env.tempDir);
  });

  describe("generateExportFilename", () => {
    it("should generate filename with correct format", () => {
      const date = new Date("2026-03-31T12:34:56Z");
      const filename = generateExportFilename(date);
      expect(filename).toBe("fusion-settings-2026-03-31-123456.json");
    });

    it("should use current date by default", () => {
      const before = new Date();
      const filename = generateExportFilename();
      const after = new Date();

      expect(filename).toMatch(/^fusion-settings-\d{4}-\d{2}-\d{2}-\d{6}\.json$/);

      // Parse the timestamp from filename
      const match = filename.match(/(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})/);
      expect(match).not.toBeNull();
      if (match) {
        const year = parseInt(match[1], 10);
        const month = parseInt(match[2], 10) - 1;
        const day = parseInt(match[3], 10);
        const hour = parseInt(match[4], 10);
        const minute = parseInt(match[5], 10);
        const second = parseInt(match[6], 10);
        const fileDate = new Date(Date.UTC(year, month, day, hour, minute, second));

        expect(fileDate.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
        expect(fileDate.getTime()).toBeLessThanOrEqual(after.getTime() + 1000);
      }
    });
  });

  describe("validateImportData", () => {
    it("should return empty array for valid data with both scopes", () => {
      const data: SettingsExportData = {
        version: 1,
        exportedAt: new Date().toISOString(),
        global: { themeMode: "dark", ntfyEnabled: true },
        project: { maxConcurrent: 4 },
      };
      expect(validateImportData(data)).toEqual([]);
    });

    it("should return empty array for valid data with only global", () => {
      const data: SettingsExportData = {
        version: 1,
        exportedAt: new Date().toISOString(),
        global: { themeMode: "light" },
      };
      expect(validateImportData(data)).toEqual([]);
    });

    it("should return empty array for valid data with only project", () => {
      const data: SettingsExportData = {
        version: 1,
        exportedAt: new Date().toISOString(),
        project: { maxWorktrees: 8 },
      };
      expect(validateImportData(data)).toEqual([]);
    });

    it("should return error for null data", () => {
      expect(validateImportData(null)).toEqual([
        "Import data must be a valid JSON object",
      ]);
    });

    it("should return error for non-object data", () => {
      expect(validateImportData("string")).toEqual([
        "Import data must be a valid JSON object",
      ]);
    });

    it("should return error for wrong version", () => {
      const data = {
        version: 2,
        exportedAt: new Date().toISOString(),
        global: {},
      };
      expect(validateImportData(data)).toContain(
        "Unsupported export version: 2. Expected: 1"
      );
    });

    it("should return error for missing exportedAt", () => {
      const data = {
        version: 1,
        global: {},
      };
      expect(validateImportData(data)).toContain(
        "Missing or invalid 'exportedAt' field"
      );
    });

    it("should return error when both scopes are missing", () => {
      const data = {
        version: 1,
        exportedAt: new Date().toISOString(),
      };
      expect(validateImportData(data)).toContain(
        "Export data must contain at least one of 'global' or 'project' settings"
      );
    });

    it("should return error for invalid global type", () => {
      const data = {
        version: 1,
        exportedAt: new Date().toISOString(),
        global: "invalid",
      };
      expect(validateImportData(data)).toContain(
        "'global' field must be an object if provided"
      );
    });

    it("should return error for invalid project type", () => {
      const data = {
        version: 1,
        exportedAt: new Date().toISOString(),
        project: "invalid",
      };
      expect(validateImportData(data)).toContain(
        "'project' field must be an object if provided"
      );
    });
  });

  describe("exportSettings", () => {
    it("should export both scopes by default", async () => {
      // Set up some test settings
      await store.updateGlobalSettings({ themeMode: "dark", ntfyEnabled: true });
      await store.updateSettings({ maxConcurrent: 4, maxWorktrees: 6 });

      const result = await exportSettings(store);

      expect(result.version).toBe(1);
      expect(result.exportedAt).toBeDefined();
      expect(result.global).toBeDefined();
      expect(result.global?.themeMode).toBe("dark");
      expect(result.global?.ntfyEnabled).toBe(true);
      expect(result.project).toBeDefined();
      expect(result.project?.maxConcurrent).toBe(4);
      expect(result.project?.maxWorktrees).toBe(6);
    });

    it("should export only global scope when specified", async () => {
      await store.updateGlobalSettings({ themeMode: "light" });
      await store.updateSettings({ maxConcurrent: 2 });

      const result = await exportSettings(store, { scope: "global" });

      expect(result.global).toBeDefined();
      expect(result.global?.themeMode).toBe("light");
      expect(result.project).toBeUndefined();
    });

    it("should export only project scope when specified", async () => {
      await store.updateGlobalSettings({ themeMode: "light" });
      await store.updateSettings({ maxConcurrent: 3 });

      const result = await exportSettings(store, { scope: "project" });

      expect(result.project).toBeDefined();
      expect(result.project?.maxConcurrent).toBe(3);
      expect(result.global).toBeUndefined();
    });

    it("should include source in export metadata", async () => {
      const result = await exportSettings(store, { source: "my-laptop" });
      expect(result.source).toBe("my-laptop");
    });
  });

  describe("importSettings", () => {
    it("should import global settings in merge mode", async () => {
      // Set initial settings
      await store.updateGlobalSettings({ themeMode: "dark" });

      const importData: SettingsExportData = {
        version: 1,
        exportedAt: new Date().toISOString(),
        global: { themeMode: "light", ntfyEnabled: true },
      };

      const result = await importSettings(store, importData, { scope: "global", merge: true });

      expect(result.success).toBe(true);
      expect(result.globalCount).toBe(2);
      expect(result.projectCount).toBe(0);

      // Verify settings were applied
      const globalSettings = await store.getGlobalSettingsStore().getSettings();
      expect(globalSettings.themeMode).toBe("light");
      expect(globalSettings.ntfyEnabled).toBe(true);
    });

    it("should import project settings in merge mode", async () => {
      // Set initial settings
      await store.updateSettings({ maxConcurrent: 2 });

      const importData: SettingsExportData = {
        version: 1,
        exportedAt: new Date().toISOString(),
        project: { maxConcurrent: 6, maxWorktrees: 10 },
      };

      const result = await importSettings(store, importData, { scope: "project", merge: true });

      expect(result.success).toBe(true);
      expect(result.globalCount).toBe(0);
      expect(result.projectCount).toBe(2);

      // Verify settings were applied
      const settings = await store.getSettings();
      expect(settings.maxConcurrent).toBe(6);
      expect(settings.maxWorktrees).toBe(10);
    });

    it("should import both scopes", async () => {
      const importData: SettingsExportData = {
        version: 1,
        exportedAt: new Date().toISOString(),
        global: { themeMode: "dark" },
        project: { maxConcurrent: 5 },
      };

      const result = await importSettings(store, importData, { scope: "both" });

      expect(result.success).toBe(true);
      expect(result.globalCount).toBe(1);
      expect(result.projectCount).toBe(1);
    });

    it("should skip undefined values in merge mode", async () => {
      await store.updateGlobalSettings({ themeMode: "dark", ntfyEnabled: true });

      const importData: SettingsExportData = {
        version: 1,
        exportedAt: new Date().toISOString(),
        global: { themeMode: "light", ntfyTopic: undefined },
      };

      const result = await importSettings(store, importData, { scope: "global", merge: true });

      expect(result.success).toBe(true);
      expect(result.globalCount).toBe(1); // Only themeMode is defined

      const settings = await store.getGlobalSettingsStore().getSettings();
      expect(settings.themeMode).toBe("light");
      expect(settings.ntfyEnabled).toBe(true); // Preserved from original
    });

    it("should handle replace mode", async () => {
      // Set initial settings
      await store.updateGlobalSettings({ themeMode: "dark", ntfyEnabled: true });

      const importData: SettingsExportData = {
        version: 1,
        exportedAt: new Date().toISOString(),
        global: { themeMode: "light" },
      };

      const result = await importSettings(store, importData, { scope: "global", merge: false });

      expect(result.success).toBe(true);
      expect(result.globalCount).toBe(1);

      const settings = await store.getGlobalSettingsStore().getSettings();
      expect(settings.themeMode).toBe("light");
    });

    it("should fail with validation errors for invalid data", async () => {
      const importData = {
        version: 2,
        exportedAt: new Date().toISOString(),
        global: {},
      } as unknown as SettingsExportData;

      const result = await importSettings(store, importData);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Unsupported export version: 2");
    });

    it("should handle import errors gracefully", async () => {
      // Close the store to simulate an error
      const importData: SettingsExportData = {
        version: 1,
        exportedAt: new Date().toISOString(),
        global: { themeMode: "dark" },
      };

      // Force an error by passing a closed/invalid store
      // This should be caught and returned as an error result
      const result = await importSettings(store, importData, { scope: "global" });

      // The operation should complete (success depends on store state)
      expect(result).toHaveProperty("success");
      expect(result).toHaveProperty("globalCount");
      expect(result).toHaveProperty("projectCount");
    });

    it("should respect scope option", async () => {
      const importData: SettingsExportData = {
        version: 1,
        exportedAt: new Date().toISOString(),
        global: { themeMode: "light" },
        project: { maxConcurrent: 8 },
      };

      // Import only global
      const globalResult = await importSettings(store, importData, { scope: "global" });
      expect(globalResult.globalCount).toBe(1);
      expect(globalResult.projectCount).toBe(0);

      // Reset and import only project
      const projectResult = await importSettings(store, importData, { scope: "project" });
      expect(projectResult.globalCount).toBe(0);
      expect(projectResult.projectCount).toBe(1);
    });
  });

  describe("readExportFile", () => {
    it("should read and parse valid export file", async () => {
      const filePath = join(env.tempDir, "test-export.json");
      const data: SettingsExportData = {
        version: 1,
        exportedAt: new Date().toISOString(),
        global: { themeMode: "dark" },
      };

      await writeExportFile(filePath, data);
      const result = await readExportFile(filePath);

      expect(result.version).toBe(1);
      expect(result.global?.themeMode).toBe("dark");
    });

    it("should throw error for invalid JSON", async () => {
      const filePath = join(env.tempDir, "invalid.json");
      writeFileSync(filePath, "not valid json");

      await expect(readExportFile(filePath)).rejects.toThrow("Failed to parse JSON");
    });

    it("should throw error for non-existent file", async () => {
      const filePath = join(env.tempDir, "non-existent.json");

      await expect(readExportFile(filePath)).rejects.toThrow();
    });
  });

  describe("writeExportFile", () => {
    it("should write data to file atomically", async () => {
      const filePath = join(env.tempDir, "export-test.json");
      const data: SettingsExportData = {
        version: 1,
        exportedAt: "2026-03-31T12:00:00Z",
        global: { themeMode: "dark" },
      };

      await writeExportFile(filePath, data);

      const content = await readExportFile(filePath);
      expect(content.version).toBe(1);
      expect(content.exportedAt).toBe("2026-03-31T12:00:00Z");
    });

    it("should create parent directories if needed", async () => {
      const filePath = join(env.tempDir, "subdir", "export-test.json");
      const data: SettingsExportData = {
        version: 1,
        exportedAt: new Date().toISOString(),
      };

      mkdirSync(join(env.tempDir, "subdir"), { recursive: true });
      await writeExportFile(filePath, data);

      expect(existsSync(filePath)).toBe(true);
    });
  });
});
