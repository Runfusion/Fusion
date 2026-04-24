/**
 * SQLite-backed PluginStore for managing plugin installations.
 *
 * Provides CRUD operations for plugins with event emission for state changes.
 */

import { EventEmitter } from "node:events";
import { join } from "node:path";
import { Database, toJson, fromJson } from "./db.js";
import type {
  PluginInstallation,
  PluginManifest,
  PluginSettingSchema,
  PluginState,
} from "./plugin-types.js";
import { validatePluginManifest } from "./plugin-types.js";

export interface PluginStoreEvents {
  "plugin:registered": [plugin: PluginInstallation];
  "plugin:unregistered": [plugin: PluginInstallation];
  "plugin:enabled": [plugin: PluginInstallation];
  "plugin:disabled": [plugin: PluginInstallation];
  "plugin:updated": [plugin: PluginInstallation];
  "plugin:stateChanged": [plugin: PluginInstallation, oldState: PluginState, newState: PluginState];
}

/** Input for registering a new plugin */
export interface PluginRegistrationInput {
  manifest: PluginManifest;
  path: string;
  settings?: Record<string, unknown>;
}

/** Partial update input for a plugin */
export interface PluginUpdateInput {
  name?: string;
  version?: string;
  description?: string;
  author?: string;
  homepage?: string;
  path?: string;
  dependencies?: string[];
}

export class PluginStore extends EventEmitter<PluginStoreEvents> {
  /** SQLite database instance */
  private _db: Database | null = null;

  constructor(private rootDir: string) {
    super();
  }

  /**
   * Get the SQLite database, initializing it on first access.
   */
  private get db(): Database {
    if (!this._db) {
      const fusionDir = join(this.rootDir, ".fusion");
      this._db = new Database(fusionDir);
      this._db.init();
    }
    return this._db;
  }

  /** Initialize the store. */
  async init(): Promise<void> {
    // Ensure DB is initialized (triggers table creation)
    const _ = this.db;
  }

  // ── Row Conversion ─────────────────────────────────────────────────

  private rowToPlugin(row: any): PluginInstallation {
    return {
      id: row.id,
      name: row.name,
      version: row.version,
      description: row.description || undefined,
      author: row.author || undefined,
      homepage: row.homepage || undefined,
      path: row.path,
      enabled: row.enabled === 1,
      state: row.state as PluginState,
      settings: fromJson<Record<string, unknown>>(row.settings) || {},
      settingsSchema: fromJson<Record<string, PluginSettingSchema>>(row.settingsSchema),
      error: row.error || undefined,
      dependencies: fromJson<string[]>(row.dependencies) || [],
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  // ── Validation Helpers ───────────────────────────────────────────────

  private validateIdFormat(id: string): boolean {
    // Valid slug: lowercase alphanumeric, hyphens, cannot start/end with hyphen
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

      // Check required
      if (settingSchema.required && !(key in settings)) {
        errors.push(`Setting "${key}" is required`);
        continue;
      }

      // Skip validation if not provided and not required
      if (!(key in settings)) continue;

      // Check type
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
          errors.push(
            `Setting "${key}" must be one of: ${settingSchema.enumValues?.join(", ")}`,
          );
        }
      } else if (expectedType === "array") {
        if (!Array.isArray(value)) {
          errors.push(`Setting "${key}" must be an array`);
        } else {
          // Validate item types
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

  // ── CRUD Operations ────────────────────────────────────────────────

  /**
   * Register a new plugin.
   */
  async registerPlugin(input: PluginRegistrationInput): Promise<PluginInstallation> {
    const { manifest, path, settings = {} } = input;

    // Validate manifest
    const manifestValidation = validatePluginManifest(manifest);
    if (!manifestValidation.valid) {
      throw new Error(`Invalid plugin manifest: ${manifestValidation.errors.join(", ")}`);
    }

    // Validate required fields
    if (!path?.trim()) {
      throw new Error("Plugin path is required and cannot be empty");
    }

    // Validate id format
    if (!this.validateIdFormat(manifest.id)) {
      throw new Error(
        "Plugin id must be a valid slug (lowercase, alphanumeric, hyphens only, cannot start or end with hyphen)",
      );
    }

    // Check for duplicate
    const existing = this.db
      .prepare("SELECT id FROM plugins WHERE id = ?")
      .get(manifest.id);
    if (existing) {
      throw Object.assign(new Error(`Plugin "${manifest.id}" is already registered`), {
        code: "EEXISTS",
      });
    }

    // Compute defaults from settingsSchema and merge with provided settings
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
    const plugin: PluginInstallation = {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      author: manifest.author,
      homepage: manifest.homepage,
      path: path.trim(),
      enabled: true,
      state: "installed",
      settings: mergedSettings,
      settingsSchema: manifest.settingsSchema,
      dependencies: manifest.dependencies || [],
      createdAt: now,
      updatedAt: now,
    };

    // Insert into database
    this.db.prepare(`
      INSERT INTO plugins (
        id, name, version, description, author, homepage, path,
        enabled, state, settings, settingsSchema, dependencies, createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      plugin.id,
      plugin.name,
      plugin.version,
      plugin.description ?? null,
      plugin.author ?? null,
      plugin.homepage ?? null,
      plugin.path,
      plugin.enabled ? 1 : 0,
      plugin.state,
      toJson(plugin.settings),
      plugin.settingsSchema ? toJson(plugin.settingsSchema) : null,
      toJson(plugin.dependencies),
      plugin.createdAt,
      plugin.updatedAt,
    );

    this.db.bumpLastModified();
    this.emit("plugin:registered", plugin);
    return plugin;
  }

  /**
   * Unregister (delete) a plugin.
   */
  async unregisterPlugin(id: string): Promise<PluginInstallation> {
    const plugin = await this.getPlugin(id);

    this.db.prepare("DELETE FROM plugins WHERE id = ?").run(id);
    this.db.bumpLastModified();
    this.emit("plugin:unregistered", plugin);
    return plugin;
  }

  /**
   * Get a plugin by id.
   */
  async getPlugin(id: string): Promise<PluginInstallation> {
    const row = this.db.prepare("SELECT * FROM plugins WHERE id = ?").get(id) as any;
    if (!row) {
      throw Object.assign(new Error(`Plugin "${id}" not found`), { code: "ENOENT" });
    }
    return this.rowToPlugin(row);
  }

  /**
   * List all plugins, optionally filtered.
   */
  async listPlugins(
    filter?: { enabled?: boolean; state?: PluginState },
  ): Promise<PluginInstallation[]> {
    let sql = "SELECT * FROM plugins";
    const conditions: string[] = [];
    const params: any[] = [];

    if (filter?.enabled !== undefined) {
      conditions.push("enabled = ?");
      params.push(filter.enabled ? 1 : 0);
    }
    if (filter?.state) {
      conditions.push("state = ?");
      params.push(filter.state);
    }

    if (conditions.length > 0) {
      sql += " WHERE " + conditions.join(" AND ");
    }
    sql += " ORDER BY createdAt ASC";

    const rows = this.db.prepare(sql).all(...params) as any[];
    return rows.map((row) => this.rowToPlugin(row));
  }

  /**
   * Enable a plugin.
   */
  async enablePlugin(id: string): Promise<PluginInstallation> {
    const plugin = await this.getPlugin(id);

    this.db.prepare("UPDATE plugins SET enabled = 1, updatedAt = ? WHERE id = ?").run(
      new Date().toISOString(),
      id,
    );
    this.db.bumpLastModified();

    const updated = { ...plugin, enabled: true };
    this.emit("plugin:enabled", updated);
    this.emit("plugin:updated", updated);
    return updated;
  }

  /**
   * Disable a plugin.
   */
  async disablePlugin(id: string): Promise<PluginInstallation> {
    const plugin = await this.getPlugin(id);

    this.db.prepare("UPDATE plugins SET enabled = 0, updatedAt = ? WHERE id = ?").run(
      new Date().toISOString(),
      id,
    );
    this.db.bumpLastModified();

    const updated = { ...plugin, enabled: false };
    this.emit("plugin:disabled", updated);
    this.emit("plugin:updated", updated);
    return updated;
  }

  /**
   * Update plugin state.
   */
  async updatePluginState(
    id: string,
    state: PluginState,
    error?: string,
  ): Promise<PluginInstallation> {
    const plugin = await this.getPlugin(id);
    const oldState = plugin.state;

    // Validate state transitions
    const validStates: PluginState[] = ["installed", "started", "stopped", "error"];
    if (!validStates.includes(state)) {
      throw new Error(`Invalid state: ${state}`);
    }

    // Validate transitions (any state can go to error)
    if (state !== "error") {
      const validTransitions: Record<PluginState, PluginState[]> = {
        installed: ["started", "stopped", "error"],
        started: ["stopped", "error"],
        stopped: ["started", "error"],
        error: ["installed", "started", "stopped"],
      };
      if (!validTransitions[oldState]?.includes(state)) {
        throw new Error(
          `Invalid state transition from "${oldState}" to "${state}"`,
        );
      }
    }

    this.db.prepare("UPDATE plugins SET state = ?, error = ?, updatedAt = ? WHERE id = ?").run(
      state,
      error ?? null,
      new Date().toISOString(),
      id,
    );
    this.db.bumpLastModified();

    const updated = { ...plugin, state, error };
    this.emit("plugin:stateChanged", updated, oldState, state);
    this.emit("plugin:updated", updated);
    return updated;
  }

  /**
   * Update plugin settings.
   */
  async updatePluginSettings(
    id: string,
    settings: Record<string, unknown>,
  ): Promise<PluginInstallation> {
    const plugin = await this.getPlugin(id);

    // Validate settings against schema
    const validationErrors = this.validateSettingsAgainstSchema(
      settings,
      plugin.settingsSchema,
    );
    if (validationErrors.length > 0) {
      throw new Error(`Settings validation failed: ${validationErrors.join(", ")}`);
    }

    // Merge settings
    const mergedSettings = { ...plugin.settings, ...settings };

    this.db.prepare("UPDATE plugins SET settings = ?, updatedAt = ? WHERE id = ?").run(
      toJson(mergedSettings),
      new Date().toISOString(),
      id,
    );
    this.db.bumpLastModified();

    const updated = { ...plugin, settings: mergedSettings };
    this.emit("plugin:updated", updated);
    return updated;
  }

  /**
   * Generic update for plugin metadata.
   */
  async updatePlugin(
    id: string,
    updates: PluginUpdateInput,
  ): Promise<PluginInstallation> {
    await this.getPlugin(id);
    const now = new Date().toISOString();

    const setClauses: string[] = ["updatedAt = ?"];
    const params: any[] = [now];

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

    params.push(id);
    this.db.prepare(`UPDATE plugins SET ${setClauses.join(", ")} WHERE id = ?`).run(...params);
    this.db.bumpLastModified();

    const updated = await this.getPlugin(id);
    this.emit("plugin:updated", updated);
    return updated;
  }
}
