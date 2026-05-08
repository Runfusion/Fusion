/**
 * SQLite-backed PluginStore for managing plugin installations.
 *
 * Global install metadata is persisted in central DB, while per-project
 * enablement/runtime state is persisted per project path.
 */

import { EventEmitter } from "node:events";
import { join, resolve } from "node:path";
import { Database, fromJson, toJson } from "./db.js";
import { CentralDatabase } from "./central-db.js";
import type {
  PluginInstallation,
  PluginManifest,
  PluginSecurityScanResult,
  PluginSettingSchema,
  PluginState,
} from "./plugin-types.js";
import { validatePluginManifest } from "./plugin-types.js";
import { assertProjectRootDir } from "./project-root-guard.js";

export interface PluginStoreEvents {
  "plugin:registered": [plugin: PluginInstallation];
  "plugin:unregistered": [plugin: PluginInstallation];
  "plugin:enabled": [plugin: PluginInstallation];
  "plugin:disabled": [plugin: PluginInstallation];
  "plugin:updated": [plugin: PluginInstallation];
  "plugin:stateChanged": [plugin: PluginInstallation, oldState: PluginState, newState: PluginState];
}

export interface PluginRegistrationInput {
  manifest: PluginManifest;
  path: string;
  settings?: Record<string, unknown>;
  aiScanOnLoad?: boolean;
}

export interface PluginUpdateInput {
  name?: string;
  version?: string;
  description?: string;
  author?: string;
  homepage?: string;
  path?: string;
  dependencies?: string[];
  aiScanOnLoad?: boolean;
  lastSecurityScan?: PluginSecurityScanResult;
}

interface LegacyPluginRow {
  id: string;
  name: string;
  version: string;
  description: string | null;
  author: string | null;
  homepage: string | null;
  path: string;
  enabled: number;
  state: string;
  settings: string | null;
  settingsSchema: string | null;
  error: string | null;
  dependencies: string | null;
  aiScanOnLoad?: number;
  lastSecurityScan?: string | null;
  createdAt: string;
  updatedAt: string;
}

interface InstallRow {
  id: string;
  name: string;
  version: string;
  description: string | null;
  author: string | null;
  homepage: string | null;
  path: string;
  settings: string | null;
  settingsSchema: string | null;
  dependencies: string | null;
  aiScanOnLoad: number;
  lastSecurityScan: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ProjectStateRow {
  projectPath: string;
  pluginId: string;
  enabled: number;
  state: string;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export class PluginStore extends EventEmitter<PluginStoreEvents> {
  private _localDb: Database | null = null;
  private _centralDb: CentralDatabase | null = null;
  private readonly inMemoryDb: boolean;
  private readonly normalizedProjectPath: string;
  private readonly centralGlobalDir?: string;

  constructor(
    private rootDir: string,
    options?: { inMemoryDb?: boolean; centralGlobalDir?: string },
  ) {
    super();
    assertProjectRootDir(rootDir, "PluginStore");
    this.inMemoryDb = options?.inMemoryDb === true;
    this.normalizedProjectPath = resolve(rootDir);
    this.centralGlobalDir = options?.centralGlobalDir;
  }

  private get localDb(): Database {
    if (!this._localDb) {
      const fusionDir = join(this.rootDir, ".fusion");
      this._localDb = new Database(fusionDir, { inMemory: this.inMemoryDb });
      this._localDb.init();
    }
    return this._localDb;
  }

  private get centralDb(): CentralDatabase {
    if (!this._centralDb) {
      this._centralDb = new CentralDatabase(this.centralGlobalDir);
      this._centralDb.init();
    }
    return this._centralDb;
  }

  async init(): Promise<void> {
    const _ = this.localDb;
    const __ = this.centralDb;
    this.migrateLegacyProjectRows();
  }

  private validateIdFormat(id: string): boolean {
    return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(id);
  }

  private validateSettingsAgainstSchema(
    settings: Record<string, unknown>,
    schema?: Record<string, PluginSettingSchema>,
  ): string[] {
    if (!schema) return [];

    const errors: string[] = [];
    for (const [key, settingSchema] of Object.entries(schema)) {
      const value = settings[key];
      if (settingSchema.required && !(key in settings)) {
        errors.push(`Setting "${key}" is required`);
        continue;
      }
      if (!(key in settings)) continue;

      const expectedType = settingSchema.type;
      if (expectedType === "string" && typeof value !== "string") {
        errors.push(`Setting "${key}" must be a string`);
      } else if (expectedType === "password" && typeof value !== "string") {
        errors.push(`Setting "${key}" must be a string`);
      } else if (expectedType === "number" && typeof value !== "number") {
        errors.push(`Setting "${key}" must be a number`);
      } else if (expectedType === "boolean" && typeof value !== "boolean") {
        errors.push(`Setting "${key}" must be a boolean`);
      } else if (expectedType === "enum") {
        if (typeof value !== "string" || !settingSchema.enumValues?.includes(value)) {
          errors.push(`Setting "${key}" must be one of: ${settingSchema.enumValues?.join(", ")}`);
        }
      } else if (expectedType === "array") {
        if (!Array.isArray(value)) {
          errors.push(`Setting "${key}" must be an array`);
        } else {
          const itemType = settingSchema.itemType;
          for (const item of value) {
            if (itemType === "string" && typeof item !== "string") {
              errors.push(`Setting "${key}" must be an array of string`);
              break;
            } else if (itemType === "number" && typeof item !== "number") {
              errors.push(`Setting "${key}" must be an array of number`);
              break;
            }
          }
        }
      }
    }

    return errors;
  }

  private rowToPlugin(install: InstallRow, state?: ProjectStateRow): PluginInstallation {
    return {
      id: install.id,
      name: install.name,
      version: install.version,
      description: install.description || undefined,
      author: install.author || undefined,
      homepage: install.homepage || undefined,
      path: install.path,
      enabled: state?.enabled === 1,
      state: (state?.state ?? "installed") as PluginState,
      settings: fromJson<Record<string, unknown>>(install.settings) || {},
      settingsSchema: fromJson<Record<string, PluginSettingSchema>>(install.settingsSchema),
      error: state?.error || undefined,
      dependencies: fromJson<string[]>(install.dependencies) || [],
      aiScanOnLoad: install.aiScanOnLoad === 1,
      lastSecurityScan: fromJson<PluginSecurityScanResult>(install.lastSecurityScan ?? null) ?? undefined,
      createdAt: install.createdAt,
      updatedAt: state?.updatedAt ?? install.updatedAt,
    };
  }

  private getProjectState(pluginId: string): ProjectStateRow | undefined {
    return this.centralDb
      .prepare("SELECT * FROM project_plugin_states WHERE projectPath = ? AND pluginId = ?")
      .get(this.normalizedProjectPath, pluginId) as ProjectStateRow | undefined;
  }

  private upsertProjectState(
    pluginId: string,
    updates: { enabled?: boolean; state?: PluginState; error?: string | null },
  ): ProjectStateRow {
    const existing = this.getProjectState(pluginId);
    const now = new Date().toISOString();

    const row: ProjectStateRow = {
      projectPath: this.normalizedProjectPath,
      pluginId,
      enabled: updates.enabled === undefined ? (existing?.enabled ?? 0) : updates.enabled ? 1 : 0,
      state: updates.state ?? existing?.state ?? "installed",
      error: updates.error === undefined ? (existing?.error ?? null) : updates.error,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    this.centralDb
      .prepare(`
      INSERT INTO project_plugin_states (projectPath, pluginId, enabled, state, error, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(projectPath, pluginId) DO UPDATE SET
        enabled = excluded.enabled,
        state = excluded.state,
        error = excluded.error,
        updatedAt = excluded.updatedAt
    `)
      .run(
        row.projectPath,
        row.pluginId,
        row.enabled,
        row.state,
        row.error,
        row.createdAt,
        row.updatedAt,
      );

    return row;
  }

  private migrateLegacyProjectRows(): void {
    const marker = this.localDb
      .prepare("SELECT value FROM __meta WHERE key = 'pluginCentralMigrationV1'")
      .get() as { value: string } | undefined;
    if (marker?.value === "done") return;

    const hasPluginsTable = this.localDb
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'plugins'")
      .get() as { name?: string } | undefined;
    if (!hasPluginsTable?.name) {
      this.localDb
        .prepare("INSERT INTO __meta (key, value) VALUES ('pluginCentralMigrationV1', 'done') ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run();
      return;
    }

    const rows = this.localDb
      .prepare("SELECT * FROM plugins ORDER BY updatedAt ASC")
      .all() as LegacyPluginRow[];

    this.centralDb.transaction(() => {
      for (const row of rows) {
        const existingInstall = this.centralDb
          .prepare("SELECT * FROM plugin_installs WHERE id = ?")
          .get(row.id) as InstallRow | undefined;

        const takeLegacy = !existingInstall || new Date(row.updatedAt).getTime() >= new Date(existingInstall.updatedAt).getTime();
        if (takeLegacy) {
          this.centralDb
            .prepare(`
            INSERT INTO plugin_installs (
              id, name, version, description, author, homepage, path,
              settings, settingsSchema, dependencies, aiScanOnLoad, lastSecurityScan, createdAt, updatedAt
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              name = excluded.name,
              version = excluded.version,
              description = excluded.description,
              author = excluded.author,
              homepage = excluded.homepage,
              path = excluded.path,
              settings = excluded.settings,
              settingsSchema = excluded.settingsSchema,
              dependencies = excluded.dependencies,
              aiScanOnLoad = excluded.aiScanOnLoad,
              lastSecurityScan = excluded.lastSecurityScan,
              updatedAt = excluded.updatedAt
          `)
            .run(
              row.id,
              row.name,
              row.version,
              row.description,
              row.author,
              row.homepage,
              row.path,
              row.settings ?? "{}",
              row.settingsSchema,
              row.dependencies ?? "[]",
              row.aiScanOnLoad === 1 ? 1 : 0,
              row.lastSecurityScan ?? null,
              existingInstall?.createdAt ?? row.createdAt,
              row.updatedAt,
            );
        }

        this.centralDb
          .prepare(`
            INSERT INTO project_plugin_states (projectPath, pluginId, enabled, state, error, createdAt, updatedAt)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(projectPath, pluginId) DO UPDATE SET
              enabled = excluded.enabled,
              state = excluded.state,
              error = excluded.error,
              updatedAt = excluded.updatedAt
          `)
          .run(
            this.normalizedProjectPath,
            row.id,
            row.enabled === 1 ? 1 : 0,
            row.state,
            row.error,
            row.createdAt,
            row.updatedAt,
          );
      }

      this.localDb
        .prepare("INSERT INTO __meta (key, value) VALUES ('pluginCentralMigrationV1', 'done') ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run();
    });
  }

  async registerPlugin(input: PluginRegistrationInput): Promise<PluginInstallation> {
    const { manifest, path, settings = {}, aiScanOnLoad = false } = input;

    const manifestValidation = validatePluginManifest(manifest);
    if (!manifestValidation.valid) {
      throw new Error(`Invalid plugin manifest: ${manifestValidation.errors.join(", ")}`);
    }

    if (!path?.trim()) {
      throw new Error("Plugin path is required and cannot be empty");
    }

    if (!this.validateIdFormat(manifest.id)) {
      throw new Error(
        "Plugin id must be a valid slug (lowercase, alphanumeric, hyphens only, cannot start or end with hyphen)",
      );
    }

    const existing = this.centralDb
      .prepare("SELECT id FROM plugin_installs WHERE id = ?")
      .get(manifest.id);
    if (existing) {
      throw Object.assign(new Error(`Plugin "${manifest.id}" is already registered`), {
        code: "EEXISTS",
      });
    }

    const defaultSettings: Record<string, unknown> = {};
    if (manifest.settingsSchema) {
      for (const [key, schema] of Object.entries(manifest.settingsSchema)) {
        if (schema.defaultValue !== undefined) {
          defaultSettings[key] = schema.defaultValue;
        }
      }
    }
    const mergedSettings = { ...defaultSettings, ...settings };

    const now = new Date().toISOString();

    this.centralDb
      .prepare(`
      INSERT INTO plugin_installs (
        id, name, version, description, author, homepage, path,
        settings, settingsSchema, dependencies, aiScanOnLoad, lastSecurityScan, createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        manifest.id,
        manifest.name,
        manifest.version,
        manifest.description ?? null,
        manifest.author ?? null,
        manifest.homepage ?? null,
        path.trim(),
        toJson(mergedSettings),
        manifest.settingsSchema ? toJson(manifest.settingsSchema) : null,
        toJson(manifest.dependencies || []),
        aiScanOnLoad ? 1 : 0,
        null,
        now,
        now,
      );

    this.upsertProjectState(manifest.id, { enabled: true, state: "installed", error: null });
    this.centralDb.bumpLastModified();

    const plugin = await this.getPlugin(manifest.id);
    this.emit("plugin:registered", plugin);
    return plugin;
  }

  async unregisterPlugin(id: string): Promise<PluginInstallation> {
    const plugin = await this.getPlugin(id);
    this.centralDb.prepare("DELETE FROM plugin_installs WHERE id = ?").run(id);
    this.centralDb.bumpLastModified();
    this.emit("plugin:unregistered", plugin);
    return plugin;
  }

  async getPlugin(id: string): Promise<PluginInstallation> {
    const install = this.centralDb
      .prepare("SELECT * FROM plugin_installs WHERE id = ?")
      .get(id) as InstallRow | undefined;
    if (!install) {
      throw Object.assign(new Error(`Plugin "${id}" not found`), { code: "ENOENT" });
    }
    return this.rowToPlugin(install, this.getProjectState(id));
  }

  async listPlugins(filter?: { enabled?: boolean; state?: PluginState }): Promise<PluginInstallation[]> {
    const installs = this.centralDb
      .prepare("SELECT * FROM plugin_installs ORDER BY createdAt ASC")
      .all() as InstallRow[];

    const results = installs.map((install) => this.rowToPlugin(install, this.getProjectState(install.id)));

    return results.filter((plugin) => {
      if (filter?.enabled !== undefined && plugin.enabled !== filter.enabled) {
        return false;
      }
      if (filter?.state && plugin.state !== filter.state) {
        return false;
      }
      return true;
    });
  }

  async enablePlugin(id: string): Promise<PluginInstallation> {
    await this.getPlugin(id);
    this.upsertProjectState(id, { enabled: true });
    this.centralDb.bumpLastModified();

    const updated = await this.getPlugin(id);
    this.emit("plugin:enabled", updated);
    this.emit("plugin:updated", updated);
    return updated;
  }

  async disablePlugin(id: string): Promise<PluginInstallation> {
    await this.getPlugin(id);
    this.upsertProjectState(id, { enabled: false });
    this.centralDb.bumpLastModified();

    const updated = await this.getPlugin(id);
    this.emit("plugin:disabled", updated);
    this.emit("plugin:updated", updated);
    return updated;
  }

  async updatePluginState(id: string, state: PluginState, error?: string): Promise<PluginInstallation> {
    const plugin = await this.getPlugin(id);
    const oldState = plugin.state;

    const validStates: PluginState[] = ["installed", "started", "stopped", "error"];
    if (!validStates.includes(state)) {
      throw new Error(`Invalid state: ${state}`);
    }

    if (state !== "error") {
      const validTransitions: Record<PluginState, PluginState[]> = {
        installed: ["started", "stopped", "error"],
        started: ["stopped", "error"],
        stopped: ["started", "error"],
        error: ["installed", "started", "stopped"],
      };
      if (!validTransitions[oldState]?.includes(state)) {
        throw new Error(`Invalid state transition from "${oldState}" to "${state}"`);
      }
    }

    this.upsertProjectState(id, { state, error: error ?? null });
    this.centralDb.bumpLastModified();

    const updated = await this.getPlugin(id);
    this.emit("plugin:stateChanged", updated, oldState, state);
    this.emit("plugin:updated", updated);
    return updated;
  }

  async updatePluginSettings(id: string, settings: Record<string, unknown>): Promise<PluginInstallation> {
    const plugin = await this.getPlugin(id);

    const validationErrors = this.validateSettingsAgainstSchema(settings, plugin.settingsSchema);
    if (validationErrors.length > 0) {
      throw new Error(`Settings validation failed: ${validationErrors.join(", ")}`);
    }

    const mergedSettings = { ...plugin.settings, ...settings };

    this.centralDb
      .prepare("UPDATE plugin_installs SET settings = ?, updatedAt = ? WHERE id = ?")
      .run(toJson(mergedSettings), new Date().toISOString(), id);
    this.centralDb.bumpLastModified();

    const updated = await this.getPlugin(id);
    this.emit("plugin:updated", updated);
    return updated;
  }

  async updatePlugin(id: string, updates: PluginUpdateInput): Promise<PluginInstallation> {
    await this.getPlugin(id);
    const now = new Date().toISOString();

    const setClauses: string[] = ["updatedAt = ?"];
    const params: (string | null | number)[] = [now];

    if (updates.name !== undefined) {
      setClauses.push("name = ?");
      params.push(updates.name);
    }
    if (updates.version !== undefined) {
      setClauses.push("version = ?");
      params.push(updates.version);
    }
    if (updates.description !== undefined) {
      setClauses.push("description = ?");
      params.push(updates.description ?? null);
    }
    if (updates.author !== undefined) {
      setClauses.push("author = ?");
      params.push(updates.author ?? null);
    }
    if (updates.homepage !== undefined) {
      setClauses.push("homepage = ?");
      params.push(updates.homepage ?? null);
    }
    if (updates.path !== undefined) {
      setClauses.push("path = ?");
      params.push(updates.path);
    }
    if (updates.dependencies !== undefined) {
      setClauses.push("dependencies = ?");
      params.push(toJson(updates.dependencies));
    }
    if (updates.aiScanOnLoad !== undefined) {
      setClauses.push("aiScanOnLoad = ?");
      params.push(updates.aiScanOnLoad ? 1 : 0);
    }
    if (updates.lastSecurityScan !== undefined) {
      setClauses.push("lastSecurityScan = ?");
      params.push(toJson(updates.lastSecurityScan));
    }

    params.push(id);
    this.centralDb.prepare(`UPDATE plugin_installs SET ${setClauses.join(", ")} WHERE id = ?`).run(...params);
    this.centralDb.bumpLastModified();

    const updated = await this.getPlugin(id);
    this.emit("plugin:updated", updated);
    return updated;
  }
}
