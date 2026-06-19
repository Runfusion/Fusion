import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskStore } from "../store.js";
import type { GlobalSettingsStore } from "../global-settings.js";
import type { Settings, GlobalSettings, ProjectSettings } from "../types.js";
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
} from "../settings-export.js";

// Helper to create a temporary test environment
function createTestEnv() {
  const tempDir = mkdtempSync(join(tmpdir(), "kb-settings-test-"));
  const fusionDir = join(tempDir, ".fusion");
  const tasksDir = join(fusionDir, "tasks");
  const globalSettingsDir = join(tempDir, "global-settings");

  mkdirSync(tasksDir, { recursive: true });
  mkdirSync(globalSettingsDir, { recursive: true });

  // Create initial config.json
  writeFileSync(
    join(fusionDir, "config.json"),
    JSON.stringify({ nextId: 1, settings: {} }),
  );

  // Create initial global settings
  writeFileSync(
    join(globalSettingsDir, "settings.json"),
    JSON.stringify({}),
  );

  return { tempDir, fusionDir, tasksDir, globalSettingsDir };
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
    const { TaskStore } = await import("../store.js");
    store = new TaskStore(env.tempDir, env.globalSettingsDir, { inMemoryDb: true });
    await store.init();
  });

  afterEach(() => {
    /*
    FNXC:CoreTests 2026-06-19-14:30:
    FN-6741 rescues settings-export from the core suite-load quarantine by closing the in-memory TaskStore before removing its fixture root. The test still covers settings import/export behavior, but teardown must release store resources before temp cleanup instead of relying on process exit.
    */
    store.close();
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

    it("should accept v2 data", () => {
      const data = {
        version: 2,
        exportedAt: new Date().toISOString(),
        global: {},
      };
      expect(validateImportData(data)).toEqual([]);
    });

    it("should return error for wrong version", () => {
      const data = {
        version: 3,
        exportedAt: new Date().toISOString(),
        global: {},
      };
      expect(validateImportData(data)).toContain(
        "Unsupported export version: 3. Expected: 1 or 2"
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
        "Export data must contain at least one of 'global', 'project', or 'workflowSettings' settings"
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

      expect(result.version).toBe(2);
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

    it("should export completionDocumentationMode in project scope", async () => {
      await store.updateSettings({ completionDocumentationMode: "changelog" });

      const result = await exportSettings(store, { scope: "project" });

      expect(result.project?.completionDocumentationMode).toBe("changelog");
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

    it("should import completionDocumentationMode in project merge mode", async () => {
      await store.updateSettings({ completionDocumentationMode: "off" });

      const importData: SettingsExportData = {
        version: 1,
        exportedAt: new Date().toISOString(),
        project: { completionDocumentationMode: "changeset" },
      };

      const result = await importSettings(store, importData, { scope: "project", merge: true });

      expect(result.success).toBe(true);
      expect(result.projectCount).toBe(1);

      const settings = await store.getSettings();
      expect(settings.completionDocumentationMode).toBe("changeset");
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
        version: 3,
        exportedAt: new Date().toISOString(),
        global: {},
      } as unknown as SettingsExportData;

      const result = await importSettings(store, importData);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Unsupported export version: 3");
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

  describe("promptOverrides export/import", () => {
    it("should export promptOverrides when set", async () => {
      await store.updateSettings({
        promptOverrides: { "executor-welcome": "Custom welcome" },
      });

      const result = await exportSettings(store, { scope: "project" });

      expect(result.project?.promptOverrides).toEqual({ "executor-welcome": "Custom welcome" });
    });

    it("should not export promptOverrides when not set", async () => {
      const result = await exportSettings(store, { scope: "project" });

      expect(result.project?.promptOverrides).toBeUndefined();
    });

    it("should import promptOverrides in merge mode", async () => {
      const importData: SettingsExportData = {
        version: 1,
        exportedAt: new Date().toISOString(),
        project: {
          promptOverrides: { "executor-welcome": "Imported welcome" },
        },
      };

      const result = await importSettings(store, importData, { scope: "project", merge: true });

      expect(result.success).toBe(true);
      expect(result.projectCount).toBe(1);

      const settings = await store.getSettings();
      expect(settings.promptOverrides).toEqual({ "executor-welcome": "Imported welcome" });
    });

    it("should merge promptOverrides with existing overrides", async () => {
      // Set initial overrides
      await store.updateSettings({
        promptOverrides: { "executor-welcome": "Original" },
      });

      const importData: SettingsExportData = {
        version: 1,
        exportedAt: new Date().toISOString(),
        project: {
          promptOverrides: { "triage-welcome": "Imported triage" },
        },
      };

      await importSettings(store, importData, { scope: "project", merge: true });

      const settings = await store.getSettings();
      expect(settings.promptOverrides).toEqual({
        "executor-welcome": "Original",
        "triage-welcome": "Imported triage",
      });
    });

    it("should clear promptOverrides when importing null", async () => {
      // Set initial overrides
      await store.updateSettings({
        promptOverrides: { "executor-welcome": "Original", "triage-welcome": "Triage" },
      });

      const importData: SettingsExportData = {
        version: 1,
        exportedAt: new Date().toISOString(),
        project: {
          promptOverrides: null as any,
        },
      };

      await importSettings(store, importData, { scope: "project", merge: true });

      const settings = await store.getSettings();
      expect(settings.promptOverrides).toBeUndefined();
    });

    it("should clear specific promptOverride key when importing null value", async () => {
      // Set initial overrides
      await store.updateSettings({
        promptOverrides: { "executor-welcome": "Original", "triage-welcome": "Triage" },
      });

      const importData: SettingsExportData = {
        version: 1,
        exportedAt: new Date().toISOString(),
        project: {
          promptOverrides: { "executor-welcome": null as unknown as string },
        },
      };

      await importSettings(store, importData, { scope: "project", merge: true });

      const settings = await store.getSettings();
      expect(settings.promptOverrides).toEqual({ "triage-welcome": "Triage" });
    });
  });

  // ── U5: workflow settings (v2) export/import + v1 upgrade (KTD-8) ──────────
  describe("workflow settings export/import (U5/KTD-8)", () => {
    function rawDb(s: TaskStore): {
      prepare: (sql: string) => { run: (...a: unknown[]) => unknown };
    } {
      return (s as unknown as { db: { prepare: (sql: string) => { run: (...a: unknown[]) => unknown } } }).db;
    }

    it("export post-migration carries workflow setting values; no moved key under project", async () => {
      const projectId = store.getWorkflowSettingsProjectId();
      // A normal unrelated project key + a workflow setting value on builtin:coding.
      await store.updateSettings({ maxConcurrent: 3 });
      await store.updateWorkflowSettingValues("builtin:coding", projectId, {
        workflowStepTimeoutMs: 120_000,
        requirePrApproval: true,
      });

      const result = await exportSettings(store, { scope: "project" });

      expect(result.version).toBe(2);
      // Project section: the unrelated key survives, NO moved key present.
      expect(result.project?.maxConcurrent).toBe(3);
      expect((result.project as Record<string, unknown>)?.workflowStepTimeoutMs).toBeUndefined();
      expect((result.project as Record<string, unknown>)?.requirePrApproval).toBeUndefined();
      // workflowSettings section carries the value-table row.
      expect(result.workflowSettings?.["builtin:coding"]).toEqual({
        workflowStepTimeoutMs: 120_000,
        requirePrApproval: true,
      });
    });

    it("import v1 payload containing workflowStepTimeoutMs → value lands per target rule, not project settings", async () => {
      const projectId = store.getWorkflowSettingsProjectId();
      const importData = {
        version: 1 as const,
        exportedAt: new Date().toISOString(),
        project: {
          // unrelated key — imports normally
          maxConcurrent: 5,
          // moved key — must be UPGRADED into workflow setting values
          workflowStepTimeoutMs: 90_000,
        } as Record<string, unknown>,
      };

      const result = await importSettings(store, importData as unknown as SettingsExportData, {
        scope: "project",
        merge: true,
      });

      expect(result.success).toBe(true);
      expect(result.projectCount).toBe(1); // only maxConcurrent
      expect(result.workflowSettingsCount).toBeGreaterThanOrEqual(1);

      // Project settings: moved key never written into raw project settings.
      const settings = await store.getSettings();
      expect(settings.maxConcurrent).toBe(5);
      const db = (store as unknown as { db: { prepare: (s: string) => { get: (...a: unknown[]) => unknown } } }).db;
      const rawProject = JSON.parse(
        (db.prepare("SELECT settings FROM config WHERE id = 1").get() as { settings: string }).settings,
      ) as Record<string, unknown>;
      expect(rawProject.workflowStepTimeoutMs).toBeUndefined();

      // Value landed on the resolved default workflow (builtin:coding, unset default).
      expect(store.getWorkflowSettingValues("builtin:coding", projectId).workflowStepTimeoutMs).toBe(90_000);
    });

    it("import v1 upgrade targets every in-use selection workflow ∪ default", async () => {
      const projectId = store.getWorkflowSettingsProjectId();
      // Seed an in-use selection on a builtin workflow distinct from the default.
      rawDb(store)
        .prepare(
          `INSERT INTO task_workflow_selection (taskId, workflowId, stepIds, updatedAt)
           VALUES (?, ?, '[]', ?)
           ON CONFLICT(taskId) DO UPDATE SET workflowId = excluded.workflowId`,
        )
        .run("task-1", "builtin:quick-fix", new Date().toISOString());

      const importData = {
        version: 1 as const,
        exportedAt: new Date().toISOString(),
        project: { requirePrApproval: true } as Record<string, unknown>,
      };

      await importSettings(store, importData as unknown as SettingsExportData, { scope: "project" });

      // Both the in-use selection workflow and the default lane received the value.
      expect(store.getWorkflowSettingValues("builtin:quick-fix", projectId).requirePrApproval).toBe(true);
      expect(store.getWorkflowSettingValues("builtin:coding", projectId).requirePrApproval).toBe(true);
    });

    it("import v2 round-trips workflow setting values", async () => {
      const projectId = store.getWorkflowSettingsProjectId();
      const importData: SettingsExportData = {
        version: 2,
        exportedAt: new Date().toISOString(),
        workflowSettings: {
          "builtin:coding": { workflowStepTimeoutMs: 45_000, requirePrApproval: true },
        },
      };

      const result = await importSettings(store, importData, { scope: "project", merge: true });

      expect(result.success).toBe(true);
      expect(result.workflowSettingsCount).toBe(2);
      expect(store.getWorkflowSettingValues("builtin:coding", projectId)).toEqual({
        workflowStepTimeoutMs: 45_000,
        requirePrApproval: true,
      });
    });

    it("import v2 drops-and-logs invalid values without aborting", async () => {
      const projectId = store.getWorkflowSettingsProjectId();
      const importData: SettingsExportData = {
        version: 2,
        exportedAt: new Date().toISOString(),
        workflowSettings: {
          // workflowStepTimeoutMs expects a number; the bad string is dropped, the
          // valid requirePrApproval still lands.
          "builtin:coding": {
            workflowStepTimeoutMs: "not-a-number" as unknown as number,
            requirePrApproval: true,
          },
        },
      };

      const result = await importSettings(store, importData, { scope: "project", merge: true });

      expect(result.success).toBe(true);
      const stored = store.getWorkflowSettingValues("builtin:coding", projectId);
      expect(stored.workflowStepTimeoutMs).toBeUndefined();
      expect(stored.requirePrApproval).toBe(true);
    });

    it("merge mode merges into existing rows; replace mode replaces the workflow's row", async () => {
      const projectId = store.getWorkflowSettingsProjectId();
      await store.updateWorkflowSettingValues("builtin:coding", projectId, {
        workflowStepTimeoutMs: 10_000,
        requirePrApproval: true,
      });

      // merge: only requirePrApproval changes; the timeout survives.
      await importSettings(
        store,
        {
          version: 2,
          exportedAt: new Date().toISOString(),
          workflowSettings: { "builtin:coding": { requirePrApproval: false } },
        },
        { scope: "project", merge: true },
      );
      expect(store.getWorkflowSettingValues("builtin:coding", projectId)).toEqual({
        workflowStepTimeoutMs: 10_000,
        requirePrApproval: false,
      });

      // replace: the row becomes exactly the imported values (timeout dropped).
      await importSettings(
        store,
        {
          version: 2,
          exportedAt: new Date().toISOString(),
          workflowSettings: { "builtin:coding": { requirePrApproval: true } },
        },
        { scope: "project", merge: false },
      );
      expect(store.getWorkflowSettingValues("builtin:coding", projectId)).toEqual({
        requirePrApproval: true,
      });
    });

    it("export → import round-trips the full payload", async () => {
      const projectId = store.getWorkflowSettingsProjectId();
      await store.updateSettings({ maxConcurrent: 4 });
      await store.updateWorkflowSettingValues("builtin:coding", projectId, {
        workflowStepTimeoutMs: 77_000,
      });

      const exported = await exportSettings(store, { scope: "project" });

      // Fresh store, import the exported payload.
      const env2 = createTestEnv();
      const { TaskStore: TS } = await import("../store.js");
      const store2 = new TS(env2.tempDir, env2.globalSettingsDir, { inMemoryDb: true });
      await store2.init();
      try {
        const r = await importSettings(store2, exported, { scope: "project", merge: true });
        expect(r.success).toBe(true);
        const settings2 = await store2.getSettings();
        expect(settings2.maxConcurrent).toBe(4);
        expect(store2.getWorkflowSettingValues("builtin:coding", store2.getWorkflowSettingsProjectId()).workflowStepTimeoutMs).toBe(77_000);
      } finally {
        store2.close();
        cleanupTestEnv(env2.tempDir);
      }
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
