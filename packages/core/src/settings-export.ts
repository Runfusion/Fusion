/**
 * Settings export and import functionality.
 *
 * This module provides utilities for exporting and importing kb settings,
 * supporting both global (~/.pi/fusion/settings.json) and project-level (.fusion/config.json)
 * settings for backup, migration, and sharing.
 */

import { writeFile, readFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Settings, GlobalSettings, ProjectSettings } from "./types.js";
import { TaskStore } from "./store.js";
import { GlobalSettingsStore } from "./global-settings.js";

/**
 * Structure for exported settings JSON.
 * Contains metadata about the export and the actual settings data.
 */
export interface SettingsExportData {
  /** Export format version for future compatibility */
  version: 1;
  /** Timestamp when the export was created */
  exportedAt: string;
  /** Source identifier (e.g., hostname, project path) */
  source?: string;
  /** Global settings (user-level, ~/.pi/fusion/settings.json) */
  global?: GlobalSettings;
  /** Project settings (project-level, .fusion/config.json) */
  project?: Partial<ProjectSettings>;
}

/**
 * Options for exportSettings function.
 */
export interface ExportSettingsOptions {
  /** Which settings to export: 'global', 'project', or 'both' (default) */
  scope?: "global" | "project" | "both";
  /** Source identifier to include in export metadata */
  source?: string;
}

/**
 * Options for importSettings function.
 */
export interface ImportSettingsOptions {
  /** Which settings to import: 'global', 'project', or 'both' (default) */
  scope?: "global" | "project" | "both";
  /** Whether to merge with existing settings (true, default) or replace them (false) */
  merge?: boolean;
}

/**
 * Result of an import operation.
 */
export interface ImportResult {
  /** Whether the import was successful */
  success: boolean;
  /** Number of global settings imported */
  globalCount: number;
  /** Number of project settings imported */
  projectCount: number;
  /** Error message if import failed */
  error?: string;
}

/**
 * Validate that data conforms to the SettingsExportData structure.
 * Returns validation errors as an array of strings, or empty array if valid.
 */
export function validateImportData(data: unknown): string[] {
  const errors: string[] = [];

  if (data === null || typeof data !== "object") {
    errors.push("Import data must be a valid JSON object");
    return errors;
  }

  const obj = data as Record<string, unknown>;

  // Check version
  if (obj.version !== 1) {
    errors.push(`Unsupported export version: ${obj.version}. Expected: 1`);
  }

  // Check exportedAt
  if (typeof obj.exportedAt !== "string") {
    errors.push("Missing or invalid 'exportedAt' field");
  }

  // Validate global settings if present
  if (obj.global !== undefined) {
    if (typeof obj.global !== "object" || obj.global === null) {
      errors.push("'global' field must be an object if provided");
    }
  }

  // Validate project settings if present
  if (obj.project !== undefined) {
    if (typeof obj.project !== "object" || obj.project === null) {
      errors.push("'project' field must be an object if provided");
    }
  }

  // At least one of global or project must be present
  if (obj.global === undefined && obj.project === undefined) {
    errors.push("Export data must contain at least one of 'global' or 'project' settings");
  }

  return errors;
}

/**
 * Generate a timestamped filename for settings export.
 * Format: fusion-settings-YYYY-MM-DD-HHmmss.json
 */
export function generateExportFilename(date: Date = new Date()): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hours = String(date.getUTCHours()).padStart(2, "0");
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  const seconds = String(date.getUTCSeconds()).padStart(2, "0");
  return `fusion-settings-${year}-${month}-${day}-${hours}${minutes}${seconds}.json`;
}

/**
 * Export settings from the current project.
 *
 * Reads both global and project settings and returns them in an exportable structure.
 *
 * @param store - The TaskStore instance for accessing project settings
 * @param options - Export options including scope selection
 * @returns The export data structure
 */
export async function exportSettings(
  store: TaskStore,
  options: ExportSettingsOptions = {}
): Promise<SettingsExportData> {
  const { scope = "both", source } = options;

  const result: SettingsExportData = {
    version: 1,
    exportedAt: new Date().toISOString(),
    source,
  };

  // Get global settings if requested
  if (scope === "global" || scope === "both") {
    const globalStore = store.getGlobalSettingsStore();
    result.global = await globalStore.getSettings();
  }

  // Get project settings if requested
  if (scope === "project" || scope === "both") {
    const scopes = await store.getSettingsByScope();
    result.project = scopes.project;
  }

  return result;
}

/**
 * Import settings into the current project.
 *
 * Validates the import data and applies it to global and/or project settings.
 *
 * @param store - The TaskStore instance for writing settings
 * @param data - The settings data to import
 * @param options - Import options including scope and merge mode
 * @returns Import result with counts of imported settings
 */
export async function importSettings(
  store: TaskStore,
  data: SettingsExportData,
  options: ImportSettingsOptions = {}
): Promise<ImportResult> {
  const { scope = "both", merge = true } = options;

  // Validate the import data
  const validationErrors = validateImportData(data);
  if (validationErrors.length > 0) {
    return {
      success: false,
      globalCount: 0,
      projectCount: 0,
      error: validationErrors.join("; "),
    };
  }

  let globalCount = 0;
  let projectCount = 0;

  try {
    // Import global settings if present and requested
    if ((scope === "global" || scope === "both") && data.global) {
      const globalSettings = data.global as GlobalSettings;

      if (merge) {
        // Merge mode: only import defined fields, keeping existing values for undefined ones
        const definedEntries = Object.entries(globalSettings).filter(
          ([, value]) => value !== undefined
        );
        if (definedEntries.length > 0) {
          const patch = Object.fromEntries(definedEntries) as Partial<GlobalSettings>;
          await store.updateGlobalSettings(patch);
          globalCount = definedEntries.length;
        }
      } else {
        // Replace mode: get current settings, then update with imported values
        // For global settings, we still preserve values not in the import data
        // because a full "clear" of settings isn't practical
        const patch = data.global as Partial<GlobalSettings>;
        await store.updateGlobalSettings(patch);
        globalCount = Object.entries(globalSettings).filter(
          ([, value]) => value !== undefined
        ).length;
      }
    }

    // Import project settings if present and requested
    if ((scope === "project" || scope === "both") && data.project) {
      const projectSettings = data.project as Partial<ProjectSettings>;

      if (merge) {
        // Merge mode: only import defined fields
        const definedEntries = Object.entries(projectSettings).filter(
          ([, value]) => value !== undefined
        );
        if (definedEntries.length > 0) {
          const patch = Object.fromEntries(definedEntries) as Partial<Settings>;
          await store.updateSettings(patch);
          projectCount = definedEntries.length;
        }
      } else {
        // Replace mode: We need to explicitly handle this by updating all project settings
        // The store's updateSettings merges, so we need to be explicit about clearing
        const patch = projectSettings as Partial<Settings>;
        await store.updateSettings(patch);
        projectCount = Object.entries(projectSettings).filter(
          ([, value]) => value !== undefined
        ).length;
      }
    }

    return {
      success: true,
      globalCount,
      projectCount,
    };
  } catch (err) {
    return {
      success: false,
      globalCount,
      projectCount,
      error: (err as Error).message,
    };
  }
}

/**
 * Read and parse settings export data from a JSON file.
 *
 * @param filePath - Path to the JSON file
 * @returns Parsed export data
 * @throws Error if file cannot be read or parsed
 */
export async function readExportFile(filePath: string): Promise<SettingsExportData> {
  const content = await readFile(filePath, "utf-8");
  try {
    const parsed = JSON.parse(content) as SettingsExportData;
    return parsed;
  } catch (err) {
    throw new Error(`Failed to parse JSON: ${(err as Error).message}`);
  }
}

/**
 * Write settings export data to a JSON file atomically.
 *
 * @param filePath - Target file path
 * @param data - Export data to write
 */
export async function writeExportFile(filePath: string, data: SettingsExportData): Promise<void> {
  const tmpPath = filePath + ".tmp";
  await writeFile(tmpPath, JSON.stringify(data, null, 2));
  await rename(tmpPath, filePath);
}
