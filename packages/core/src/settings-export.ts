/**
 * Settings export and import functionality.
 *
 * This module provides utilities for exporting and importing fn settings,
 * supporting both global (~/.fusion/settings.json) and project-level (.fusion/config.json)
 * settings for backup, migration, and sharing.
 *
 * ── Export format versions ────────────────────────────────────────────────────
 *   - v1: `{ version: 1, global?, project? }` — the legacy shape. Project settings
 *     could carry the (now-moved) workflow/step/model-lane keys flat under
 *     `project`. Still importable: any moved key found in a v1 `project` section is
 *     UPGRADED into workflow setting VALUES (KTD-8) using the same write-target
 *     rule as the U4 migration, instead of dead-writing it back into project
 *     settings (the store guard would strip it anyway).
 *   - v2: adds a `workflowSettings` section carrying the per-project value table
 *     (`workflowId → { key: value }`). Moved keys never appear under `project` in a
 *     v2 export. Import round-trips the section via `updateWorkflowSettingValues`,
 *     dropping-and-logging invalid values without aborting.
 */

import { writeFile, readFile, rename } from "node:fs/promises";
import type { Settings, GlobalSettings, ProjectSettings } from "./types.js";
import { TaskStore } from "./store.js";
import {
  MOVED_SETTINGS_KEYS,
  stripMovedSettingsKeys,
} from "./moved-settings.js";
import { createLogger } from "./logger.js";

const log = createLogger("settings-export");

/** Current export format version emitted by {@link exportSettings}. */
export const SETTINGS_EXPORT_VERSION = 2;

/**
 * Per-project workflow setting VALUE table carried by a v2 export:
 * `workflowId → { settingKey: value }`.
 */
export type WorkflowSettingsExportSection = Record<string, Record<string, unknown>>;

/**
 * Structure for exported settings JSON.
 * Contains metadata about the export and the actual settings data.
 */
export interface SettingsExportData {
  /** Export format version. 2 is current; 1 remains importable. */
  version: 1 | 2;
  /** Timestamp when the export was created */
  exportedAt: string;
  /** Source identifier (e.g., hostname, project path) */
  source?: string;
  /** Global settings (user-level, ~/.fusion/settings.json) */
  global?: GlobalSettings;
  /** Project settings (project-level, .fusion/config.json) */
  project?: Partial<ProjectSettings>;
  /**
   * Workflow setting VALUES for the exporting project (v2+). Keyed
   * `workflowId → { settingKey: value }`. Absent in v1 payloads.
   */
  workflowSettings?: WorkflowSettingsExportSection;
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
  /** Number of workflow setting VALUES imported (across all workflows). */
  workflowSettingsCount: number;
  /** Error message if import failed */
  error?: string;
}

/**
 * Validate that data conforms to the SettingsExportData structure.
 * Returns validation errors as an array of strings, or empty array if valid.
 * Both v1 and v2 are accepted.
 */
export function validateImportData(data: unknown): string[] {
  const errors: string[] = [];

  if (data === null || typeof data !== "object") {
    errors.push("Import data must be a valid JSON object");
    return errors;
  }

  const obj = data as Record<string, unknown>;

  // Check version (v1 and v2 are both supported)
  if (obj.version !== 1 && obj.version !== 2) {
    errors.push(`Unsupported export version: ${obj.version}. Expected: 1 or 2`);
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

  // Validate workflowSettings section if present (v2)
  if (obj.workflowSettings !== undefined) {
    if (
      typeof obj.workflowSettings !== "object"
      || obj.workflowSettings === null
      || Array.isArray(obj.workflowSettings)
    ) {
      errors.push("'workflowSettings' field must be an object if provided");
    } else {
      for (const [workflowId, values] of Object.entries(obj.workflowSettings as Record<string, unknown>)) {
        if (typeof values !== "object" || values === null || Array.isArray(values)) {
          errors.push(`'workflowSettings.${workflowId}' must be an object of setting values`);
        }
      }
    }
  }

  // At least one of global, project, or workflowSettings must be present
  if (obj.global === undefined && obj.project === undefined && obj.workflowSettings === undefined) {
    errors.push("Export data must contain at least one of 'global', 'project', or 'workflowSettings' settings");
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
 * Reads both global and project settings and returns them in an exportable
 * structure. When project scope is requested, the per-project workflow setting
 * value table is carried under `workflowSettings` (v2).
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
    version: SETTINGS_EXPORT_VERSION,
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

    // Carry the per-project workflow setting value table (v2). Defensively strip
    // any moved key that somehow lingered in the project section (post-migration
    // it never should) so the two regimes can never both claim the same key.
    if (result.project) {
      result.project = stripMovedSettingsKeys(
        result.project as Record<string, unknown>,
      ) as Partial<ProjectSettings>;
    }

    const workflowSettings = store.listWorkflowSettingValuesForProject();
    // Only attach non-empty rows; an empty table omits the section entirely.
    const nonEmpty: WorkflowSettingsExportSection = {};
    for (const [workflowId, values] of Object.entries(workflowSettings)) {
      if (values && Object.keys(values).length > 0) {
        nonEmpty[workflowId] = values;
      }
    }
    if (Object.keys(nonEmpty).length > 0) {
      result.workflowSettings = nonEmpty;
    }
  }

  return result;
}

/**
 * Apply the `workflowSettings` value section (v2) into the store.
 *
 * Each `(workflowId, values)` pair is written via `store.updateWorkflowSettingValues`.
 * Invalid values are dropped-and-logged per-key (the write never aborts the whole
 * import): we pre-validate by attempting the write and, on rejection, retry with
 * the offending keys removed. Returns the number of values successfully applied.
 *
 * Merge semantics:
 *   - merge=true  → per-key merge into the existing row (store's default upsert).
 *   - merge=false → replace the exported workflow's row: delete keys present in the
 *     current row but absent from the import, then write the import values.
 */
async function applyWorkflowSettingsSection(
  store: TaskStore,
  section: WorkflowSettingsExportSection,
  merge: boolean,
): Promise<number> {
  const projectId = store.getWorkflowSettingsProjectId();
  let applied = 0;

  for (const [workflowId, rawValues] of Object.entries(section)) {
    if (!rawValues || typeof rawValues !== "object" || Array.isArray(rawValues)) continue;
    const patch: Record<string, unknown> = { ...(rawValues as Record<string, unknown>) };

    if (!merge) {
      // Replace mode: null out keys present in the current row but absent here so
      // the row ends up matching the imported workflow exactly.
      const current = await store.getWorkflowSettingValuesAsync(workflowId, projectId);
      for (const key of Object.keys(current)) {
        if (!(key in patch)) {
          patch[key] = null; // null-as-delete
        }
      }
    }

    // Attempt the write; on a validation rejection, drop the offending keys and
    // retry so one bad value never blocks the rest. Never abort the import.
    // Retry at most until the patch is empty.
    while (Object.keys(patch).length > 0) {
      try {
        await store.updateWorkflowSettingValues(workflowId, projectId, patch);
        // Count only the non-null (set) keys as applied values.
        applied += Object.values(patch).filter((v) => v !== null).length;
        break;
      } catch (err) {
        const rejectedIds = extractRejectedSettingIds(err);
        if (rejectedIds.length === 0) {
          // Unknown error (not a value-rejection) — log and skip this workflow.
          log.warn("[settings-import] skipped workflow setting values", {
            workflowId,
            error: err instanceof Error ? err.message : String(err),
          });
          break;
        }
        for (const id of rejectedIds) {
          delete patch[id];
          log.warn("[settings-import] dropped invalid workflow setting value", {
            workflowId,
            settingId: id,
          });
        }
      }
    }
  }

  return applied;
}

/**
 * Extract rejected setting ids from a {@link WorkflowSettingRejectionError}-shaped
 * error without importing the class (avoids a hard dependency cycle). Returns an
 * empty array for errors that don't carry per-key rejections.
 */
function extractRejectedSettingIds(err: unknown): string[] {
  if (!err || typeof err !== "object") return [];
  const rejections = (err as { rejections?: unknown }).rejections;
  if (!Array.isArray(rejections)) return [];
  const ids: string[] = [];
  for (const r of rejections) {
    if (r && typeof r === "object" && typeof (r as { settingId?: unknown }).settingId === "string") {
      ids.push((r as { settingId: string }).settingId);
    }
  }
  return ids;
}

/**
 * Upgrade moved keys found in a v1 payload's `project` section into workflow
 * setting VALUES (KTD-8). The moved keys are written to every target workflow
 * (in-use selection workflows ∪ resolved default, unset → `builtin:coding`),
 * mirroring the U4 migration. Invalid values are dropped-and-logged. Returns the
 * total count of values applied across all target workflows.
 */
async function upgradeMovedKeysFromV1Project(
  store: TaskStore,
  projectSection: Record<string, unknown>,
): Promise<number> {
  const movedSnapshot: Record<string, unknown> = {};
  for (const key of MOVED_SETTINGS_KEYS) {
    if (
      Object.prototype.hasOwnProperty.call(projectSection, key)
      && projectSection[key] !== undefined
    ) {
      movedSnapshot[key] = projectSection[key];
    }
  }
  if (Object.keys(movedSnapshot).length === 0) return 0;

  const targets = await store.computeMovedSettingsTargetWorkflowIds();
  const section: WorkflowSettingsExportSection = {};
  for (const workflowId of targets) {
    section[workflowId] = { ...movedSnapshot };
  }
  // Always merge moved-key upgrades into existing rows (never replace) — they are
  // an overlay onto whatever the workflow already has.
  return applyWorkflowSettingsSection(store, section, true);
}

/**
 * Import settings into the current project.
 *
 * Validates the import data and applies it to global, project, and (v2) workflow
 * setting values. v1 payloads whose `project` section carries moved keys upgrade
 * those keys into workflow setting values instead of dead-writing them.
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
      workflowSettingsCount: 0,
      error: validationErrors.join("; "),
    };
  }

  let globalCount = 0;
  let projectCount = 0;
  let workflowSettingsCount = 0;

  try {
    // Import global settings if present and requested.
    // (The store guard strips any moved key arriving here, so global is safe.)
    if ((scope === "global" || scope === "both") && data.global) {
      const globalSettings = data.global as GlobalSettings;

      if (merge) {
        const definedEntries = Object.entries(globalSettings).filter(
          ([, value]) => value !== undefined
        );
        if (definedEntries.length > 0) {
          const patch = Object.fromEntries(definedEntries) as Partial<GlobalSettings>;
          await store.updateGlobalSettings(patch);
          globalCount = definedEntries.length;
        }
      } else {
        const patch = data.global as Partial<GlobalSettings>;
        await store.updateGlobalSettings(patch);
        globalCount = Object.entries(globalSettings).filter(
          ([, value]) => value !== undefined
        ).length;
      }
    }

    // Import project settings if present and requested.
    if ((scope === "project" || scope === "both") && data.project) {
      const projectSection = data.project as Record<string, unknown>;

      // KTD-8: a v1 payload may carry moved keys flat under `project`. Upgrade
      // them into workflow setting values (the project write would strip them
      // anyway). v2 payloads carry no moved keys here, so this is a no-op for v2.
      workflowSettingsCount += await upgradeMovedKeysFromV1Project(store, projectSection);

      // Non-moved project keys import as before. Strip moved keys defensively so
      // the count reflects only what actually lands in project settings.
      const projectSettings = stripMovedSettingsKeys(projectSection) as Partial<ProjectSettings>;

      if (merge) {
        const definedEntries = Object.entries(projectSettings).filter(
          ([, value]) => value !== undefined
        );
        if (definedEntries.length > 0) {
          const patch = Object.fromEntries(definedEntries) as Partial<Settings>;
          await store.updateSettings(patch);
          projectCount = definedEntries.length;
        }
      } else {
        const patch = projectSettings as Partial<Settings>;
        await store.updateSettings(patch);
        projectCount = Object.entries(projectSettings).filter(
          ([, value]) => value !== undefined
        ).length;
      }
    }

    // Import workflow setting values (v2). Only meaningful when project scope is
    // in play (these values are project-scoped). Round-trips through the store's
    // validated write path; invalid values drop-and-log without aborting.
    if ((scope === "project" || scope === "both") && data.workflowSettings) {
      workflowSettingsCount += await applyWorkflowSettingsSection(
        store,
        data.workflowSettings,
        merge,
      );
    }

    return {
      success: true,
      globalCount,
      projectCount,
      workflowSettingsCount,
    };
  } catch (err) {
    return {
      success: false,
      globalCount,
      projectCount,
      workflowSettingsCount,
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
