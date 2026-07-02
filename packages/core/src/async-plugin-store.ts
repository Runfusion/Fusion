/**
 * Async Drizzle PluginStore helpers (U6 satellite-fusiondir-stores).
 *
 * FNXC:PluginStore 2026-06-24-13:00:
 * Async equivalents of the sync SQLite PluginStore call sites in
 * plugin-store.ts. PluginStore is a fusion-dir-owned satellite store with a
 * dual-scope persistence model: global install metadata lives in the central
 * database (`central.plugin_installs`) while per-project enablement/runtime
 * state lives in the central database (`central.project_plugin_states`). The
 * sync store opens both a local `Database(rootDir/.fusion)` (now only for the
 * legacy migration marker) and a `CentralDatabase`. Under the shared PostgreSQL
 * backend both scopes are served by the same connection set, so these helpers
 * take a single `AsyncDataLayer` and address the central-schema tables via
 * `schema.central.*`.
 *
 * VAL-DATA-016 (plugin store contract stability) is the load-bearing
 * constraint for this store: the `fusion-plugin-roadmap` plugin consumes the
 * store layer and must keep working. The async helpers program against the
 * stable `AsyncDataLayer` interface so the backend swap is invisible to the
 * plugin contract.
 *
 * SQLite → PostgreSQL notes (VAL-SCHEMA-004):
 *   - The `settings`, `settingsSchema`, `dependencies`, and `lastSecurityScan`
 *     columns are `jsonb` in PostgreSQL, so Drizzle returns them already-parsed
 *     as JS values. On write, pass the JS value directly. The sync store used
 *     `toJson()`/`fromJson()` against TEXT columns; the helpers pass objects.
 *     Note: `lastSecurityScan` is a `text` column in the PostgreSQL central
 *     schema (stores serialized JSON), so it must be `JSON.stringify()`'d on
 *     write and `JSON.parse()`'d on read to match the sync behavior.
 *   - The boolean `enabled` and `aiScanOnLoad` columns are kept as integer
 *     (0/1), so `row.enabled === 1` checks still work.
 *   - The `INSERT ... ON CONFLICT(id) DO UPDATE` upsert maps directly to
 *     Drizzle `insert().onConflictDoUpdate()`.
 *   - The composite-key upsert on `project_plugin_states`
 *     (projectPath, pluginId) maps to `onConflictDoUpdate({ target: [projectPath, pluginId] })`.
 *
 * Transition context (see library/satellite-store-migration-pattern.md):
 *   `getDatabase()` still returns the sync `Database` until the coordinated
 *   flip. The sync PluginStore keeps its sync path (the gate depends on it).
 *   These helpers are the async target the PostgreSQL integration tests
 *   consume.
 */
import { and, asc, eq } from "drizzle-orm";
import * as schema from "./postgres/schema/index.js";
import type { AsyncDataLayer, DbTransaction } from "./postgres/data-layer.js";
import type {
  PluginInstallation,
  PluginManifest,
  PluginSecurityScanResult,
  PluginSettingSchema,
  PluginState,
} from "./plugin-types.js";

/** A query-capable handle: either the top-level db or a transaction handle. */
type QueryHandle = AsyncDataLayer["db"] | DbTransaction;

/** Row shape for central.plugin_installs. */
interface PluginInstallRow {
  id: string;
  name: string;
  version: string;
  description: string | null;
  author: string | null;
  homepage: string | null;
  path: string;
  settings: unknown;
  settingsSchema: unknown;
  dependencies: unknown;
  aiScanOnLoad: number;
  lastSecurityScan: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Row shape for central.project_plugin_states. */
interface ProjectPluginStateRow {
  projectPath: string;
  pluginId: string;
  enabled: number;
  state: string;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

const installColumns = {
  id: schema.central.pluginInstalls.id,
  name: schema.central.pluginInstalls.name,
  version: schema.central.pluginInstalls.version,
  description: schema.central.pluginInstalls.description,
  author: schema.central.pluginInstalls.author,
  homepage: schema.central.pluginInstalls.homepage,
  path: schema.central.pluginInstalls.path,
  settings: schema.central.pluginInstalls.settings,
  settingsSchema: schema.central.pluginInstalls.settingsSchema,
  dependencies: schema.central.pluginInstalls.dependencies,
  aiScanOnLoad: schema.central.pluginInstalls.aiScanOnLoad,
  lastSecurityScan: schema.central.pluginInstalls.lastSecurityScan,
  createdAt: schema.central.pluginInstalls.createdAt,
  updatedAt: schema.central.pluginInstalls.updatedAt,
};

function parseJsonText<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function rowToPlugin(
  install: PluginInstallRow,
  state?: ProjectPluginStateRow,
): PluginInstallation {
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
    settings: (install.settings as Record<string, unknown> | null) ?? {},
    settingsSchema: install.settingsSchema as Record<string, PluginSettingSchema> | undefined,
    error: state?.error || undefined,
    dependencies: (install.dependencies as string[] | null) ?? [],
    aiScanOnLoad: install.aiScanOnLoad === 1,
    // lastSecurityScan is a text column storing serialized JSON.
    lastSecurityScan: parseJsonText<PluginSecurityScanResult | undefined>(
      install.lastSecurityScan,
      undefined,
    ),
    createdAt: install.createdAt,
    updatedAt: state?.updatedAt ?? install.updatedAt,
  };
}

/**
 * FNXC:PluginStore 2026-06-24-13:05:
 * Read the per-project plugin state row, or undefined if none.
 */
export async function getProjectState(
  handle: QueryHandle,
  projectPath: string,
  pluginId: string,
): Promise<ProjectPluginStateRow | undefined> {
  const rows = await handle
    .select({
      projectPath: schema.central.projectPluginStates.projectPath,
      pluginId: schema.central.projectPluginStates.pluginId,
      enabled: schema.central.projectPluginStates.enabled,
      state: schema.central.projectPluginStates.state,
      error: schema.central.projectPluginStates.error,
      createdAt: schema.central.projectPluginStates.createdAt,
      updatedAt: schema.central.projectPluginStates.updatedAt,
    })
    .from(schema.central.projectPluginStates)
    .where(
      and(
        eq(schema.central.projectPluginStates.projectPath, projectPath),
        eq(schema.central.projectPluginStates.pluginId, pluginId),
      ),
    );
  return rows[0] as ProjectPluginStateRow | undefined;
}

/**
 * FNXC:PluginStore 2026-06-24-13:10:
 * Upsert the per-project plugin state row (composite key: projectPath + pluginId).
 * Returns the persisted row.
 */
export async function upsertProjectState(
  handle: QueryHandle,
  input: {
    projectPath: string;
    pluginId: string;
    enabled?: boolean;
    state?: PluginState;
    error?: string | null;
  },
): Promise<ProjectPluginStateRow> {
  const existing = await getProjectState(handle, input.projectPath, input.pluginId);
  const now = new Date().toISOString();
  const row: ProjectPluginStateRow = {
    projectPath: input.projectPath,
    pluginId: input.pluginId,
    enabled:
      input.enabled === undefined ? (existing?.enabled ?? 0) : input.enabled ? 1 : 0,
    state: input.state ?? existing?.state ?? "installed",
    error: input.error === undefined ? (existing?.error ?? null) : input.error,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  await handle
    .insert(schema.central.projectPluginStates)
    .values({
      projectPath: row.projectPath,
      pluginId: row.pluginId,
      enabled: row.enabled,
      state: row.state,
      error: row.error,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    })
    .onConflictDoUpdate({
      target: [
        schema.central.projectPluginStates.projectPath,
        schema.central.projectPluginStates.pluginId,
      ],
      set: {
        enabled: row.enabled,
        state: row.state,
        error: row.error,
        updatedAt: row.updatedAt,
      },
    });

  return row;
}

/**
 * FNXC:PluginStore 2026-06-24-13:15:
 * Register a plugin install row + per-project state in one transaction so the
 * install and its default enabled-state commit atomically. Throws EEXISTS if
 * a plugin with the same id is already registered.
 */
export async function registerPlugin(
  layer: AsyncDataLayer,
  input: {
    manifest: PluginManifest;
    path: string;
    settings?: Record<string, unknown>;
    aiScanOnLoad?: boolean;
    projectPath: string;
  },
): Promise<PluginInstallation> {
  const now = new Date().toISOString();

  // Check for existing install first (outside the transaction for a clear error).
  const existing = await layer.db
    .select({ id: schema.central.pluginInstalls.id })
    .from(schema.central.pluginInstalls)
    .where(eq(schema.central.pluginInstalls.id, input.manifest.id));
  if (existing.length > 0) {
    throw Object.assign(new Error(`Plugin "${input.manifest.id}" is already registered`), {
      code: "EEXISTS",
    });
  }

  // Compute merged default settings from the manifest schema.
  const defaultSettings: Record<string, unknown> = {};
  if (input.manifest.settingsSchema) {
    for (const [key, settingSchema] of Object.entries(input.manifest.settingsSchema)) {
      if (settingSchema.defaultValue !== undefined) {
        defaultSettings[key] = settingSchema.defaultValue;
      }
    }
  }
  const mergedSettings = { ...defaultSettings, ...(input.settings ?? {}) };

  return layer.transactionImmediate(async (tx) => {
    await tx.insert(schema.central.pluginInstalls).values({
      id: input.manifest.id,
      name: input.manifest.name,
      version: input.manifest.version,
      description: input.manifest.description ?? null,
      author: input.manifest.author ?? null,
      homepage: input.manifest.homepage ?? null,
      path: input.path.trim(),
      settings: mergedSettings,
      settingsSchema: input.manifest.settingsSchema ?? null,
      dependencies: input.manifest.dependencies ?? [],
      aiScanOnLoad: input.aiScanOnLoad ? 1 : 0,
      lastSecurityScan: null,
      createdAt: now,
      updatedAt: now,
    });

    await upsertProjectState(tx, {
      projectPath: input.projectPath,
      pluginId: input.manifest.id,
      enabled: true,
      state: "installed",
      error: null,
    });

    const plugin = await getPlugin(tx, input.manifest.id, input.projectPath);
    return plugin;
  });
}

/**
 * FNXC:PluginStore 2026-06-24-13:20:
 * Unregister (delete) a plugin install row. The per-project states cascade
 * via the foreign-key ON DELETE CASCADE rule. Returns the deleted plugin.
 */
export async function unregisterPlugin(
  handle: QueryHandle,
  id: string,
  projectPath: string,
): Promise<PluginInstallation> {
  const plugin = await getPlugin(handle, id, projectPath);
  await handle
    .delete(schema.central.pluginInstalls)
    .where(eq(schema.central.pluginInstalls.id, id));
  return plugin;
}

/**
 * Get a single plugin by id (install + per-project state). Throws ENOENT if
 * the install row does not exist.
 */
export async function getPlugin(
  handle: QueryHandle,
  id: string,
  projectPath: string,
): Promise<PluginInstallation> {
  const rows = await handle
    .select(installColumns)
    .from(schema.central.pluginInstalls)
    .where(eq(schema.central.pluginInstalls.id, id));
  const install = rows[0] as PluginInstallRow | undefined;
  if (!install) {
    throw Object.assign(new Error(`Plugin "${id}" not found`), { code: "ENOENT" });
  }
  const state = await getProjectState(handle, projectPath, id);
  return rowToPlugin(install, state);
}

/**
 * List all plugins (installs + per-project state), optionally filtered.
 */
export async function listPlugins(
  handle: QueryHandle,
  projectPath: string,
  filter?: { enabled?: boolean; state?: PluginState },
): Promise<PluginInstallation[]> {
  const installs = (await handle
    .select(installColumns)
    .from(schema.central.pluginInstalls)
    .orderBy(asc(schema.central.pluginInstalls.createdAt), asc(schema.central.pluginInstalls.id))) as PluginInstallRow[];

  const results = await Promise.all(
    installs.map(async (install) => {
      const state = await getProjectState(handle, projectPath, install.id);
      return rowToPlugin(install, state);
    }),
  );

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

/**
 * FNXC:PluginStore 2026-06-24-13:25:
 * Enable a plugin for the current project (sets per-project enabled = 1).
 */
export async function enablePlugin(
  handle: QueryHandle,
  id: string,
  projectPath: string,
): Promise<PluginInstallation> {
  await getPlugin(handle, id, projectPath);
  await upsertProjectState(handle, { projectPath, pluginId: id, enabled: true });
  return getPlugin(handle, id, projectPath);
}

/**
 * Disable a plugin for the current project (sets per-project enabled = 0).
 */
export async function disablePlugin(
  handle: QueryHandle,
  id: string,
  projectPath: string,
): Promise<PluginInstallation> {
  await getPlugin(handle, id, projectPath);
  await upsertProjectState(handle, { projectPath, pluginId: id, enabled: false });
  return getPlugin(handle, id, projectPath);
}

/**
 * FNXC:PluginStore 2026-06-24-13:30:
 * Update a plugin's per-project runtime state (installed/started/stopped/error).
 * Same-state transitions are idempotent. The caller validates transitions.
 */
export async function updatePluginState(
  handle: QueryHandle,
  id: string,
  projectPath: string,
  state: PluginState,
  error?: string | null,
): Promise<PluginInstallation> {
  await getPlugin(handle, id, projectPath);
  await upsertProjectState(handle, { projectPath, pluginId: id, state, error: error ?? null });
  return getPlugin(handle, id, projectPath);
}

/**
 * FNXC:PluginStore 2026-06-24-13:35:
 * Update a plugin's global settings (merged onto existing). The caller
 * validates settings against the schema.
 */
export async function updatePluginSettings(
  handle: QueryHandle,
  id: string,
  mergedSettings: Record<string, unknown>,
): Promise<void> {
  const now = new Date().toISOString();
  await handle
    .update(schema.central.pluginInstalls)
    .set({ settings: mergedSettings, updatedAt: now })
    .where(eq(schema.central.pluginInstalls.id, id));
}

/**
 * FNXC:PluginStore 2026-06-24-13:40:
 * Update arbitrary plugin install fields (name, version, path, dependencies,
 * aiScanOnLoad, lastSecurityScan). Only provided fields are written.
 */
export async function updatePluginInstall(
  handle: QueryHandle,
  id: string,
  updates: {
    name?: string;
    version?: string;
    description?: string | null;
    author?: string | null;
    homepage?: string | null;
    path?: string;
    dependencies?: string[];
    aiScanOnLoad?: boolean;
    lastSecurityScan?: PluginSecurityScanResult;
  },
): Promise<void> {
  const now = new Date().toISOString();
  const sets: Record<string, unknown> = { updatedAt: now };
  if (updates.name !== undefined) sets.name = updates.name;
  if (updates.version !== undefined) sets.version = updates.version;
  if (updates.description !== undefined) sets.description = updates.description;
  if (updates.author !== undefined) sets.author = updates.author;
  if (updates.homepage !== undefined) sets.homepage = updates.homepage;
  if (updates.path !== undefined) sets.path = updates.path;
  if (updates.dependencies !== undefined) sets.dependencies = updates.dependencies;
  if (updates.aiScanOnLoad !== undefined) sets.aiScanOnLoad = updates.aiScanOnLoad ? 1 : 0;
  // lastSecurityScan is a text column storing serialized JSON.
  if (updates.lastSecurityScan !== undefined) {
    sets.lastSecurityScan = JSON.stringify(updates.lastSecurityScan);
  }
  await handle
    .update(schema.central.pluginInstalls)
    .set(sets as never)
    .where(eq(schema.central.pluginInstalls.id, id));
}
