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
import { existsSync, statSync } from "node:fs";
import { join, isAbsolute, dirname, basename } from "node:path";
import type {
  PluginLoader,
  PluginStore,
  PluginContext,
} from "@fusion/core";
import { validatePluginManifest } from "@fusion/core";
import {
  ApiError,
  badRequest,
  catchHandler,
  internalError,
  notFound,
} from "./api-error.js";

// PluginRunner interface for optional plugin runner
interface PluginRunner {
  reloadPlugin?(pluginId: string): Promise<void>;
  getPluginRoutes(): Array<{ pluginId: string; route: import("@fusion/core").PluginRouteDefinition }>;
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
  if (!existsSync(sourcePath)) {
    throw notFound(`Path does not exist: ${sourcePath}`);
  }
  let stat;
  try {
    stat = statSync(sourcePath);
  } catch {
    throw badRequest(`Cannot access path: ${sourcePath}`);
  }
  if (!stat.isDirectory()) {
    throw badRequest(`Path is not a directory: ${sourcePath}`);
  }

  const { readFile } = await import("node:fs/promises");

  // 1. Try manifest.json directly in the provided path
  const directManifestPath = join(sourcePath, "manifest.json");
  if (existsSync(directManifestPath)) {
    const manifest = await readAndValidateManifest(readFile, directManifestPath);
    return { manifestDir: sourcePath, manifest };
  }

  // 2. If the selected dir is a well-known dist folder, check the parent
  const dirName = basename(sourcePath).toLowerCase();
  if (DIST_DIR_NAMES.has(dirName)) {
    const parentDir = dirname(sourcePath);
    const parentManifestPath = join(parentDir, "manifest.json");
    if (existsSync(parentManifestPath)) {
      const manifest = await readAndValidateManifest(readFile, parentManifestPath);
      // Return the parent (package root) as the canonical install dir
      return { manifestDir: parentDir, manifest };
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
  readFile: (path: string, encoding: BufferEncoding) => Promise<string>,
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
): Router {
  const router = Router();

  // ── Error Handler ───────────────────────────────────────────────

  router.use(catchHandler);

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
      installPath = resolved.manifestDir;
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

        // Create a minimal context for the handler
        const ctx: PluginContext = {
          pluginId,
          taskStore: {} as import("@fusion/core").TaskStore, // TaskStore is provided by the plugin loader
          settings: {},
          logger: {
            info: (...args: unknown[]) => console.log(`[plugin:${pluginId}]`, ...args),
            warn: (...args: unknown[]) => console.warn(`[plugin:${pluginId}]`, ...args),
            error: (...args: unknown[]) => console.error(`[plugin:${pluginId}]`, ...args),
            debug: (...args: unknown[]) => {
              if (process.env.DEBUG?.includes("plugins")) {
                console.log(`[plugin:${pluginId}]`, ...args);
              }
            },
          },
          emitEvent: () => {},
        };

        // Call the route handler with Express Request cast to unknown
        const result = await route.handler(req as unknown, ctx);
        res.json(result);
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
        case "DELETE":
          router.delete(fullPath, handler);
          break;
      }
    }
  }

  return router;
}
