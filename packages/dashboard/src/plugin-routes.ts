/**
 * Plugin REST API Routes
 *
 * Provides CRUD endpoints for plugin management and plugin-defined routes.
 *
 * Endpoints:
 * - GET /plugins - List all installed plugins
 * - GET /plugins/:id - Get single plugin
 * - POST /plugins/install - Install a plugin
 * - POST /plugins/:id/enable - Enable a plugin
 * - POST /plugins/:id/disable - Disable a plugin
 * - DELETE /plugins/:id - Uninstall a plugin
 * - GET /plugins/:id/settings - Get plugin settings
 * - PUT /plugins/:id/settings - Update plugin settings
 * - Plugin-defined routes mounted under /plugins/:pluginId/*
 */

import { Router, type Request, type Response } from "express";
import { access, stat, readFile } from "node:fs/promises";
import { join, isAbsolute, dirname, basename } from "node:path";
import { emitPluginCustomSseEvent } from "./sse.js";
import type {
  PluginInstallation,
  PluginLoader,
  PluginStore,
  PluginContext,
  PluginState,
} from "@fusion/core";
import { resolvePluginEntryPath, validatePluginManifest } from "@fusion/core";
import {
  ApiError,
  badRequest,
  catchHandler,
  internalError,
  notFound,
} from "./api-error.js";
import { getOrCreateProjectStore } from "./project-store-resolver.js";


// PluginRunner interface for optional plugin runner
function isPluginRouteResponse(result: unknown): result is import("@fusion/core").PluginRouteResponse {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return false;
  }
  const candidate = result as { status?: unknown };
  return typeof candidate.status === "number";
}

interface PluginRunner {
  reloadPlugin?(pluginId: string): Promise<void>;
  checkPluginSetup?(pluginId: string): Promise<import("@fusion/core").PluginSetupCheckResult>;
  installPluginSetup?(pluginId: string): Promise<{ success: boolean; error?: string }>;
  uninstallPluginSetup?(pluginId: string): Promise<{ success: boolean; error?: string }>;
  getPluginSetupInfo?(): Array<{ pluginId: string; manifest: import("@fusion/core").PluginSetupManifest; hooks: import("@fusion/core").PluginSetupHooks }>;
  getPluginRoutes(): Array<{ pluginId: string; route: import("@fusion/core").PluginRouteDefinition }>;
}

export interface RegistryManifestEntry {
  id: string;
  name: string;
  description: string;
  version: string;
  author: string;
  category: "runtime" | "integration";
  npmPackage?: string;
  path?: string;
  homepage?: string;
  tags?: string[];
}

export interface RegistryPluginEntry extends RegistryManifestEntry {
  installed: boolean;
  state?: PluginState;
  installedVersion?: string;
  canInstall: boolean;
}

interface RegistryManifestShape {
  plugins?: unknown;
}

const registryManifestUrl = new URL("./registry-manifest.json", import.meta.url);
let cachedRegistryManifest: RegistryManifestShape | null = null;

export async function loadRegistryManifest(): Promise<RegistryManifestShape> {
  if (cachedRegistryManifest) {
    return cachedRegistryManifest;
  }

  try {
    const raw = await readFile(registryManifestUrl, "utf-8");
    cachedRegistryManifest = JSON.parse(raw) as RegistryManifestShape;
    return cachedRegistryManifest;
  } catch (error) {
    // FNXC:PluginRegistry 2026-07-01-07:45:
    // Desktop local mode imports the dashboard server under Node 22+, where static
    // JSON imports require attributes that TypeScript did not emit. Read the
    // registry manifest as data at request time and degrade to an empty registry
    // when the packaged manifest is missing or malformed so startup never fails at
    // module load with ERR_IMPORT_ATTRIBUTE_MISSING.
    console.warn("[dashboard/plugins] Registry manifest unavailable; serving an empty plugin registry", error);
    cachedRegistryManifest = {};
    return cachedRegistryManifest;
  }
}

function normalizeRegistryManifestEntries(manifest: RegistryManifestShape): RegistryManifestEntry[] {
  if (!manifest || !Array.isArray(manifest.plugins)) {
    return [];
  }

  return manifest.plugins.filter((entry): entry is RegistryManifestEntry => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return false;
    }
    const candidate = entry as Partial<RegistryManifestEntry>;
    return typeof candidate.id === "string"
      && typeof candidate.name === "string"
      && typeof candidate.description === "string"
      && typeof candidate.version === "string"
      && typeof candidate.author === "string"
      && (candidate.category === "runtime" || candidate.category === "integration");
  });
}

function registryEntryMatchesSearch(entry: RegistryManifestEntry, query: string): boolean {
  if (!query) {
    return true;
  }

  const haystack = [
    entry.name,
    entry.description,
    entry.author,
    ...(entry.tags ?? []),
  ].join(" ").toLowerCase();
  return haystack.includes(query);
}

async function annotateRegistryEntry(
  entry: RegistryManifestEntry,
  store: Pick<PluginStore, "getPlugin">,
): Promise<RegistryPluginEntry> {
  let installedPlugin: PluginInstallation | null = null;
  try {
    installedPlugin = await store.getPlugin(entry.id);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      const message = err instanceof Error ? err.message : "";
      if (!message.toLowerCase().includes("not found")) {
        throw err;
      }
    }
  }

  return {
    ...entry,
    installed: Boolean(installedPlugin),
    state: installedPlugin?.state,
    installedVersion: installedPlugin?.version,
    canInstall: typeof entry.path === "string" && entry.path.trim().length > 0,
  };
}

export async function buildRegistryPluginEntries(
  manifest: RegistryManifestShape,
  store: Pick<PluginStore, "getPlugin">,
  filters: { q?: string; category?: string } = {},
): Promise<RegistryPluginEntry[]> {
  const query = filters.q?.trim().toLowerCase() ?? "";
  const category = filters.category?.trim().toLowerCase() ?? "";
  const entries = normalizeRegistryManifestEntries(manifest)
    .filter((entry) => !category || entry.category === category)
    .filter((entry) => registryEntryMatchesSearch(entry, query));

  return Promise.all(entries.map((entry) => annotateRegistryEntry(entry, store)));
}

// ── Install-Source Resolution Helpers ──────────────────────────────────
// Exported for reuse in routes.ts and for direct testing.

/**
 * Validate plugin installation source.
 * Must have either `path` (local directory) or `package` (npm package name).
 * Enforces absolute path requirement and rejects path traversal.
 */
export function validateInstallSource(body: unknown): { path?: string; package?: string } {
  if (!body || typeof body !== "object") {
    throw badRequest("Request body is required");
  }

  const b = body as Record<string, unknown>;

  if (b.path !== undefined && typeof b.path === "string") {
    const p = b.path;
    if (!p.trim()) {
      throw badRequest("Path must not be empty");
    }
    if (!isAbsolute(p)) {
      throw badRequest("Plugin path must be absolute");
    }
    // Reject path traversal sequences
    if (p.includes("..")) {
      throw badRequest("Plugin path must not contain path traversal (..)");
    }
    return { path: p };
  }

  if (b.package !== undefined && typeof b.package === "string") {
    return { package: b.package };
  }

  throw badRequest("Request body must have either 'path' or 'package' field");
}

/**
 * Well-known directory names that indicate a build output folder.
 * When the user selects one of these, we look for manifest.json
 * in the parent directory before giving up.
 */
export const DIST_DIR_NAMES = new Set(["dist", "build", "out", "output", "lib"]);

/**
 * Resolve an install path to the directory that contains `manifest.json`.
 *
 * Resolution order:
 * 1. `<path>/manifest.json`                  — user selected package root
 * 2. `<parent>/manifest.json`                — user selected a dist/build folder
 *    (only when `basename(path)` is a well-known build output name)
 *
 * Returns `{ manifestDir, manifest }` where `manifestDir` is the canonical
 * path the plugin-loader should use (the directory containing manifest.json).
 */
export async function resolvePluginManifest(
  sourcePath: string,
): Promise<{ manifestDir: string; manifest: import("@fusion/core").PluginManifest }> {
  // Validate the path exists and is a directory
  try {
    await access(sourcePath);
  } catch {
    throw notFound(`Path does not exist: ${sourcePath}`);
  }
  let sourceStat;
  try {
    sourceStat = await stat(sourcePath);
  } catch {
    throw badRequest(`Cannot access path: ${sourcePath}`);
  }
  if (!sourceStat.isDirectory()) {
    throw badRequest(`Path is not a directory: ${sourcePath}`);
  }

  // 1. Try manifest.json directly in the provided path
  const directManifestPath = join(sourcePath, "manifest.json");
  try {
    await access(directManifestPath);
    const manifest = await readAndValidateManifest(directManifestPath);
    return { manifestDir: sourcePath, manifest };
  } catch (err) {
    // Re-throw ApiErrors (badRequest) from validation; only catch true ENOENT
    if (err instanceof ApiError) throw err;
    // Not found at direct path
  }

  // 2. If the selected dir is a well-known dist folder, check the parent
  const dirName = basename(sourcePath).toLowerCase();
  if (DIST_DIR_NAMES.has(dirName)) {
    const parentDir = dirname(sourcePath);
    const parentManifestPath = join(parentDir, "manifest.json");
    try {
      await access(parentManifestPath);
      const manifest = await readAndValidateManifest(parentManifestPath);
      // Return the parent (package root) as the canonical install dir
      return { manifestDir: parentDir, manifest };
    } catch (err) {
      // Re-throw ApiErrors (badRequest) from validation; only catch true ENOENT
      if (err instanceof ApiError) throw err;
      // Not found at parent path
    }
  }

  // Neither location has a manifest
  throw notFound(
    `Plugin manifest not found. Looked for manifest.json in: ${sourcePath}` +
    (DIST_DIR_NAMES.has(dirName) ? ` and ${dirname(sourcePath)}` : ""),
  );
}

/**
 * Read and validate a manifest.json file.
 */
async function readAndValidateManifest(
  manifestPath: string,
): Promise<import("@fusion/core").PluginManifest> {
  let content: string;
  try {
    content = await readFile(manifestPath, "utf-8");
  } catch (err) {
    throw badRequest(`Cannot read manifest at ${manifestPath}: ${(err as Error).message}`);
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(content);
  } catch {
    throw badRequest(`Invalid JSON in manifest at: ${manifestPath}`);
  }

  const validation = validatePluginManifest(manifest);
  if (!validation.valid) {
    throw badRequest(`Invalid plugin manifest: ${validation.errors.join(", ")}`);
  }

  return manifest as import("@fusion/core").PluginManifest;
}

// ── Router Factory ────────────────────────────────────────────────────

/**
 * Create the plugin management router.
 *
 * @param pluginStore - Plugin store for persistence
 * @param pluginLoader - Plugin loader for lifecycle management
 * @param pluginRunner - Optional plugin runner for plugin-defined routes
 */
export function createPluginRouter(
  pluginStore: PluginStore,
  pluginLoader: PluginLoader,
  pluginRunner?: PluginRunner,
  defaultTaskStore?: import("@fusion/core").TaskStore,
): Router {
  const router = Router();

  // ── Management Routes ───────────────────────────────────────────

  /**
   * GET /plugins
   * List all installed plugins.
   */
  router.get("/", catchHandler(async (_req: Request, res: Response) => {
    const plugins = await pluginStore.listPlugins();
    res.json(plugins);
  }));

  /**
   * GET /plugins/registry
   * List curated registry plugin metadata with installed-state annotations.
   */
  router.get("/registry", catchHandler(async (req: Request, res: Response) => {
    const q = typeof req.query.q === "string" ? req.query.q : undefined;
    const category = typeof req.query.category === "string" ? req.query.category : undefined;
    // FNXC:BranchGroupProjectScoping 2026-07-14-06:15: return the trimmed id, not the raw padded string.
    const projectId = typeof req.query.projectId === "string"
      ? (req.query.projectId.trim() || undefined)
      : undefined;
    const scopedStore = projectId ? await getOrCreateProjectStore(projectId) : null;
    const store = scopedStore?.getPluginStore?.() ?? pluginStore;
    const registryManifest = await loadRegistryManifest();
    const plugins = await buildRegistryPluginEntries(registryManifest, store, { q, category });
    res.json({ plugins });
  }));

  /**
   * GET /plugins/:id
   * Get a single plugin by ID.
   */
  router.get("/:id", catchHandler(async (req: Request, res: Response) => {
    const id = req.params.id as string;
    try {
      const plugin = await pluginStore.getPlugin(id);
      res.json(plugin);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw notFound(`Plugin "${id}" not found`);
      }
      throw internalError(err instanceof Error ? err.message : "Unknown error");
    }
  }));

  /**
   * POST /plugins/install
   * Install a plugin from a local path or npm package.
   * Supports package root and dist-folder selections via resolvePluginManifest.
   */
  router.post("/install", catchHandler(async (req: Request, res: Response) => {
    const source = validateInstallSource(req.body);

    // Resolve manifest — supports package root and dist-folder selections
    let manifest: import("@fusion/core").PluginManifest;
    let installPath: string;

    if (source.path) {
      const resolved = await resolvePluginManifest(source.path);
      manifest = resolved.manifest;
      // Register the loadable entry FILE, not the package directory — Node
      // ESM cannot import directories, so the loader rejects directory paths.
      const entryPath = resolvePluginEntryPath(resolved.manifestDir);
      if (!entryPath) {
        throw badRequest(
          `Plugin at ${resolved.manifestDir} has no loadable entry file `
          + "(expected bundled.js, dist/index.js, or src/index.ts)",
        );
      }
      installPath = entryPath;
    } else if (source.package) {
      // npm packages not yet supported
      throw badRequest("Installing plugins from npm packages is not yet implemented");
    } else {
      throw badRequest("Invalid source");
    }

    // Register the plugin
    try {
      const plugin = await pluginStore.registerPlugin({
        manifest,
        path: installPath,
      });

      // If the plugin is enabled, try to load it
      if (plugin.enabled) {
        try {
          await pluginLoader.loadPlugin(plugin.id);
        } catch (loadErr) {
          // Log but don't fail - the plugin is registered, just not loaded
          console.error(`[plugin-routes] Failed to load plugin ${plugin.id}:`, loadErr);
        }
      }

      res.status(201).json(plugin);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err instanceof Error && err.message.includes("already registered")) {
        throw badRequest(err.message);
      }
      throw internalError(err instanceof Error ? err.message : "Failed to register plugin");
    }
  }));

  /**
   * POST /plugins/:id/enable
   * Enable a plugin and start it.
   */
  router.post("/:id/enable", catchHandler(async (req: Request, res: Response) => {
    const id = req.params.id as string;

    // Enable in store
    let plugin = await pluginStore.enablePlugin(id);

    // Heal legacy registrations that stored the package directory instead of
    // a loadable entry file (Node ESM cannot import directories). Mirrors the
    // heal in routes.ts's enable handler and the CLI's startup heal.
    try {
      if ((await stat(plugin.path)).isDirectory()) {
        const entryPath = resolvePluginEntryPath(plugin.path);
        if (entryPath) {
          plugin = await pluginStore.updatePlugin(id, { path: entryPath });
        }
      }
    } catch {
      // Path missing or unreadable — let loadPlugin surface the real error.
    }

    // Start the plugin
    try {
      await pluginLoader.loadPlugin(id);
    } catch (loadErr) {
      // Update state to error
      await pluginStore.updatePluginState(
        id,
        "error",
        loadErr instanceof Error ? loadErr.message : String(loadErr),
      );
      // Re-fetch to get updated state
      plugin = await pluginStore.getPlugin(id);
    }

    res.json(plugin);
  }));

  /**
   * POST /plugins/:id/disable
   * Disable a plugin and stop it.
   */
  router.post("/:id/disable", catchHandler(async (req: Request, res: Response) => {
    const id = req.params.id as string;

    // Stop the plugin
    try {
      await pluginLoader.stopPlugin(id);
    } catch {
      // Ignore errors from stopping - plugin might not be loaded
    }

    // Disable in store
    const plugin = await pluginStore.disablePlugin(id);
    res.json(plugin);
  }));

  /**
   * POST /plugins/:id/reload
   * Reload a running plugin with updated code.
   */
  router.post("/:id/reload", catchHandler(async (req: Request, res: Response) => {
    const id = req.params.id as string;

    // Validate plugin exists
    let plugin;
    try {
      plugin = await pluginStore.getPlugin(id);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw notFound(`Plugin "${id}" not found`);
      }
      throw internalError(err instanceof Error ? err.message : "Unknown error");
    }

    // Validate plugin is started (must be loaded to reload)
    if (plugin.state !== "started") {
      throw badRequest("Plugin is not currently loaded. Use enable instead.");
    }

    // Check if pluginRunner is available and has reloadPlugin method
    if (!pluginRunner || !pluginRunner.reloadPlugin) {
      throw internalError("Plugin runner not available");
    }

    // Reload the plugin
    try {
      await pluginRunner.reloadPlugin(id);
    } catch (reloadErr) {
      throw internalError(`Reload failed: ${reloadErr instanceof Error ? reloadErr.message : String(reloadErr)}`);
    }

    // Return updated plugin
    const updatedPlugin = await pluginStore.getPlugin(id);
    res.json(updatedPlugin);
  }));

  /**
   * GET /plugins/:id/setup-status
   * Check plugin setup status.
   */
  router.get("/:id/setup-status", catchHandler(async (req: Request, res: Response) => {
    const id = req.params.id as string;

    let plugin: import("@fusion/core").PluginInstallation;
    try {
      plugin = await pluginStore.getPlugin(id);
    } catch (err: unknown) {
      if (
        (err as NodeJS.ErrnoException).code === "ENOENT"
        || (err instanceof Error && err.message.includes("not found"))
      ) {
        throw notFound(`Plugin "${id}" not found`);
      }
      throw internalError(err instanceof Error ? err.message : "Unknown error");
    }

    if (!pluginRunner?.checkPluginSetup || !pluginRunner.getPluginSetupInfo) {
      throw internalError("Plugin runner not available");
    }

    const setupInfo = pluginRunner.getPluginSetupInfo();
    const hasSetup = setupInfo.some((entry) => entry.pluginId === id);

    if (!hasSetup) {
      res.json({ hasSetup: false });
      return;
    }

    if (plugin.state !== "started") {
      res.json({
        hasSetup: true,
        setupCheckDeferred: true,
        deferredReason: "plugin-not-started",
        pluginState: plugin.state,
      });
      return;
    }

    const status = await pluginRunner.checkPluginSetup(id);
    res.json({ hasSetup: true, ...status });
  }));

  /**
   * POST /plugins/:id/setup/install
   * Trigger plugin setup install hook.
   */
  router.post("/:id/setup/install", catchHandler(async (req: Request, res: Response) => {
    const id = req.params.id as string;

    let plugin: import("@fusion/core").PluginInstallation;
    try {
      plugin = await pluginStore.getPlugin(id);
    } catch (err: unknown) {
      if (
        (err as NodeJS.ErrnoException).code === "ENOENT"
        || (err instanceof Error && err.message.includes("not found"))
      ) {
        throw notFound(`Plugin "${id}" not found`);
      }
      throw internalError(err instanceof Error ? err.message : "Unknown error");
    }

    if (!plugin.enabled) {
      throw badRequest("Plugin must be enabled before setup install");
    }

    if (!pluginRunner?.installPluginSetup || !pluginRunner.getPluginSetupInfo) {
      throw internalError("Plugin runner not available");
    }

    const setupInfo = pluginRunner.getPluginSetupInfo();
    const setup = setupInfo.find((entry) => entry.pluginId === id);
    if (!setup?.hooks.install) {
      throw badRequest("Plugin has no install hook");
    }

    const result = await pluginRunner.installPluginSetup(id);
    res.json(result ?? { success: true });
  }));

  /**
   * DELETE /plugins/:id
   * Uninstall a plugin.
   */
  router.delete("/:id", catchHandler(async (req: Request, res: Response) => {
    const id = req.params.id as string;

    // Stop the plugin (ignore errors)
    try {
      await pluginLoader.stopPlugin(id);
    } catch {
      // Ignore - plugin might not be loaded
    }

    // Unregister the plugin
    await pluginStore.unregisterPlugin(id);

    res.status(204).send();
  }));

  /**
   * GET /plugins/:id/settings
   * Get plugin settings.
   */
  router.get("/:id/settings", catchHandler(async (req: Request, res: Response) => {
    const id = req.params.id as string;
    try {
      const plugin = await pluginStore.getPlugin(id);
      res.json(plugin.settings);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw notFound(`Plugin "${id}" not found`);
      }
      throw internalError(err instanceof Error ? err.message : "Unknown error");
    }
  }));

  /**
   * PUT /plugins/:id/settings
   * Update plugin settings.
   */
  router.put("/:id/settings", catchHandler(async (req: Request, res: Response) => {
    const id = req.params.id as string;

    if (!req.body || typeof req.body !== "object") {
      throw badRequest("Request body must be an object with 'settings' field");
    }

    const body = req.body as Record<string, unknown>;
    const settings = body.settings as Record<string, unknown> | undefined;

    if (!settings || typeof settings !== "object") {
      throw badRequest("Request body must have a 'settings' object");
    }

    try {
      const plugin = await pluginStore.updatePluginSettings(id, settings);
      res.json(plugin.settings);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw notFound(`Plugin "${id}" not found`);
      }
      if (err instanceof Error && err.message.includes("validation failed")) {
        throw badRequest(err.message);
      }
      throw internalError(err instanceof Error ? err.message : "Failed to update settings");
    }
  }));

  // ── Plugin-Defined Routes ──────────────────────────────────────

  // Mount plugin-defined routes
  if (pluginRunner) {
    const pluginRoutes = pluginRunner.getPluginRoutes();

    for (const { pluginId, route } of pluginRoutes) {
      const fullPath = `/${pluginId}${route.path.startsWith("/") ? route.path : `/${route.path}`}`;

      const handler = catchHandler(async (req: Request, res: Response) => {
        // Get the plugin context
        const plugin = pluginLoader.getPlugin(pluginId);
        if (!plugin) {
          throw notFound(`Plugin "${pluginId}" not loaded`);
        }

        // FNXC:BranchGroupProjectScoping 2026-07-14-06:15: return the trimmed id, not the raw padded string.
        const queryProjectId = typeof req.query.projectId === "string" ? req.query.projectId.trim() : "";
        const bodyProjectId =
          req.body && typeof req.body === "object" && typeof (req.body as { projectId?: unknown }).projectId === "string"
            ? (req.body as { projectId: string }).projectId.trim()
            : "";
        const projectId = queryProjectId || bodyProjectId || undefined;
        const scopedStore = projectId ? await getOrCreateProjectStore(projectId) : null;
        const taskStore = scopedStore ?? defaultTaskStore ?? ({} as import("@fusion/core").TaskStore);

        let settings: Record<string, unknown> = {};
        const scopedPluginStore = scopedStore?.getPluginStore?.();
        if (scopedPluginStore) {
          try {
            const scopedPlugin = await scopedPluginStore.getPlugin(pluginId);
            settings = scopedPlugin.settings;
          } catch {
            // Fall back to default store plugin settings when project-scoped plugin record is unavailable.
          }
        }
        if (!scopedPluginStore || Object.keys(settings).length === 0) {
          try {
            const pluginRecord = await pluginStore.getPlugin(pluginId);
            settings = pluginRecord.settings;
          } catch {
            // Keep empty settings when plugin store record isn't available.
          }
        }

        const ctx: PluginContext = await pluginLoader.createRouteContext(pluginId, {
          taskStore,
          settings,
          resolveProjectTaskStore: getOrCreateProjectStore,
          // Real publish-to-/api/events seam: forward custom plugin events to
          // connected SSE clients, scoped to the request's project so a
          // project stream only sees its own events.
          emitEvent: (event: string, data: unknown) => {
            emitPluginCustomSseEvent(pluginId, event, data, projectId);
          },
        });

        // Call the route handler with Express Request cast to unknown
        const result = await route.handler(req as unknown, ctx);

        if (isPluginRouteResponse(result)) {
          if (result.headers) {
            for (const [name, value] of Object.entries(result.headers)) {
              res.setHeader(name, value);
            }
          }
          if (result.contentType) {
            res.setHeader("Content-Type", result.contentType);
          }
          if (result.status === 204) {
            res.status(204).send();
            return;
          }
          if (result.body === undefined) {
            res.status(result.status).send();
            return;
          }
          if (
            result.contentType
            || typeof result.body === "string"
            || Buffer.isBuffer(result.body)
          ) {
            res.status(result.status).send(result.body);
            return;
          }
          res.status(result.status).json(result.body);
          return;
        }

        res.status(200).json(result);
      });

      switch (route.method) {
        case "GET":
          router.get(fullPath, handler);
          break;
        case "POST":
          router.post(fullPath, handler);
          break;
        case "PUT":
          router.put(fullPath, handler);
          break;
        case "PATCH":
          router.patch(fullPath, handler);
          break;
        case "DELETE":
          router.delete(fullPath, handler);
          break;
      }
    }
  }

  return router;
}
