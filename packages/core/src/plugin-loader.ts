/**
 * PluginLoader - Dynamic plugin loading and lifecycle management.
 *
 * Handles:
 * - Dynamic import of plugins from file paths or npm packages
 * - Plugin lifecycle (load, start, stop)
 * - Dependency resolution via topological sort
 * - Hook invocation across all loaded plugins
 * - Error isolation (plugin crashes don't crash the loader)
 */

import { basename, dirname, extname, isAbsolute, resolve } from "node:path";
import { stat } from "node:fs/promises";
import { copyFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { EventEmitter } from "node:events";
import type { TaskStore } from "./store.js";
import type { WorkflowStepTemplate } from "./types.js";
import { PluginStore } from "./plugin-store.js";
import type {
  FusionPlugin,
  PluginContext,
  PluginLogger,
  PluginToolDefinition,
  PluginRouteDefinition,
  PluginUiSlotDefinition,
  PluginUiContributionDefinition,
  PluginDashboardViewDefinition,
  PluginOnSchemaInit,
  PluginRuntimeRegistration,
  CliProviderContribution,
  PluginInstallation,
  PluginSkillContribution,
  PluginWorkflowStepContribution,
  PluginPromptContribution,
  PluginPromptContributions,
  PluginSetupManifest,
  PluginSetupHooks,
  PluginSetupCheckResult,
} from "./plugin-types.js";
import { normalizePluginUiContributionDefinition, validatePluginManifest } from "./plugin-types.js";
import { createLogger } from "./logger.js";
import { getCreateAiSessionFactory } from "./ai-engine-loader.js";
import { scanPluginSecurity } from "./plugin-security-scan.js";

// Minimum Fusion version for plugin compatibility checks (can be expanded later)
const MINIMUM_FUSION_VERSION = "0.1.0";
let moduleImportVersion = 0;

export interface PluginLoaderOptions {
  /** Plugin store for persistence */
  pluginStore: PluginStore;
  /** Task store for plugin context */
  taskStore: TaskStore;
  /** Additional directories to scan for plugins */
  pluginDirs?: string[];
  /** npm prefix for resolving packages */
  npmPrefix?: string;
}

/**
 * Event emitted when a plugin is loaded and started.
 */
export interface PluginLoadedEvent {
  pluginId: string;
  plugin: FusionPlugin;
}

/**
 * Event emitted when a plugin is unloaded (stopped).
 */
export interface PluginUnloadedEvent {
  pluginId: string;
}

/**
 * Event emitted when a plugin is reloaded with a new version.
 */
export interface PluginReloadedEvent {
  pluginId: string;
  plugin: FusionPlugin;
}

/**
 * Event emitted when a plugin encounters an error.
 */
export interface PluginErrorEvent {
  pluginId: string;
  error: Error;
}

export class PluginLoader extends EventEmitter<{
  "plugin:loaded": [PluginLoadedEvent];
  "plugin:unloaded": [PluginUnloadedEvent];
  "plugin:reloaded": [PluginReloadedEvent];
  "plugin:error": [PluginErrorEvent];
  "plugin:stopped": [string]; // Kept for backward compatibility
}> {
  /** Loaded plugin instances keyed by plugin id */
  private plugins: Map<string, FusionPlugin> = new Map();

  /** Cache of dynamically imported modules */
  private loadedModules: Map<string, unknown> = new Map();

  private readonly log = createLogger("plugin-loader");

  constructor(private options: PluginLoaderOptions) {
    super();
  }

  private getProjectRoot(): string {
    return this.options.taskStore.getRootDir();
  }

  // ── Context Creation ───────────────────────────────────────────────

  private async createContext(plugin: FusionPlugin): Promise<PluginContext> {
    return this.createRouteContext(plugin.manifest.id);
  }

  async createRouteContext(
    pluginId: string,
    overrides?: Partial<Pick<PluginContext, "taskStore" | "settings" | "resolveProjectTaskStore">>,
  ): Promise<PluginContext> {
    const createAiSession = await getCreateAiSessionFactory();
    if (process.env.DEBUG?.includes("plugins")) {
      this.log.log(
        createAiSession
          ? `[plugin:${pluginId}] createAiSession available`
          : `[plugin:${pluginId}] createAiSession unavailable`,
      );
    }

    return {
      pluginId,
      taskStore: overrides?.taskStore ?? this.options.taskStore,
      settings: overrides?.settings ?? await this.getPluginSettings(pluginId),
      logger: this.createLogger(pluginId),
      createAiSession,
      resolveProjectTaskStore: overrides?.resolveProjectTaskStore,
      emitEvent: (event: string, data: unknown) => {
        this.emit("plugin:error", { pluginId, error: new Error(`Custom event: ${event}`) });
        this.log.log(`[plugin:${pluginId}] Custom event: ${event}`, data);
      },
    };
  }

  private createLogger(pluginId: string): PluginLogger {
    const pluginLog = createLogger(`plugin:${pluginId}`);
    return {
      info: (message: string, ...args: unknown[]) => pluginLog.log(message, ...args),
      warn: (message: string, ...args: unknown[]) => pluginLog.warn(message, ...args),
      error: (message: string, ...args: unknown[]) => pluginLog.error(message, ...args),
      debug: (message: string, ...args: unknown[]) => {
        if (process.env.DEBUG?.includes("plugins")) {
          pluginLog.log(message, ...args);
        }
      },
    };
  }

  private async getPluginSettings(pluginId: string): Promise<Record<string, unknown>> {
    try {
      const plugin = await this.options.pluginStore.getPlugin(pluginId);
      return plugin.settings;
    } catch {
      return {};
    }
  }

  // ── Plugin Loading ─────────────────────────────────────────────────

  /**
   * Load and start a single plugin.
   */
  async loadPlugin(pluginId: string): Promise<FusionPlugin> {
    // Get plugin installation record
    let installation: PluginInstallation;
    try {
      installation = await this.options.pluginStore.getPlugin(pluginId);
    } catch (err) {
      throw new Error(`Plugin "${pluginId}" not found in store: ${(err as Error).message}`);
    }

    // Skip disabled plugins
    if (!installation.enabled) {
      this.log.log(`Skipping disabled plugin: ${pluginId}`);
      throw Object.assign(new Error(`Plugin "${pluginId}" is disabled`), {
        code: "PLUGIN_DISABLED",
      });
    }

    // Skip already loaded plugins
    if (this.plugins.has(pluginId)) {
      this.log.log(`Plugin already loaded: ${pluginId}`);
      return this.plugins.get(pluginId)!;
    }

    // Resolve plugin path
    const pluginPath = this.resolvePluginPath(installation.path);

    try {
      if (installation.aiScanOnLoad) {
        const scanResult = await scanPluginSecurity({ pluginId, pluginPath });
        await this.options.pluginStore.updatePlugin(pluginId, { lastSecurityScan: scanResult });

        if (["blocked", "error", "unavailable"].includes(scanResult.verdict)) {
          const errorMessage = `Security scan ${scanResult.verdict}: ${scanResult.summary}`;
          await this.options.pluginStore.updatePluginState(pluginId, "error", errorMessage);
          this.emit("plugin:error", { pluginId, error: new Error(errorMessage) });
          throw new Error(errorMessage);
        }
      }

      // Dynamic import the plugin - always bypass cache to get fresh code
      // Our loadedModules cache is cleared on stop, but Node.js ESM cache persists
      const mod = await this.importPluginModule(pluginPath, true);
      const plugin = this.extractPluginFromModule(mod);

      // Validate manifest
      const manifestValidation = validatePluginManifest(plugin.manifest);
      if (!manifestValidation.valid) {
        throw new Error(
          `Invalid plugin manifest: ${manifestValidation.errors.join(", ")}`,
        );
      }

      // Check version compatibility
      if (plugin.manifest.fusionVersion) {
        const compatible = this.checkVersionCompatibility(
          plugin.manifest.fusionVersion,
        );
        if (!compatible) {
          this.log.warn(
            `Plugin ${pluginId} requires Fusion ${plugin.manifest.fusionVersion}, minimum is ${MINIMUM_FUSION_VERSION}`,
          );
        }
      }

      // Resolve dependencies
      await this.resolveDependencies(plugin);

      // Update state to started
      await this.options.pluginStore.updatePluginState(pluginId, "started");

      // Update plugin state locally and store
      plugin.state = "started";
      this.plugins.set(pluginId, plugin);

      // Call onLoad hook
      const ctx = await this.createContext(plugin);
      try {
        await this.safeCallHook(plugin, "onLoad", [ctx]);
      } catch (loadErr) {
        // onLoad failed - clean up and propagate error
        this.plugins.delete(pluginId);
        const errorMsg = loadErr instanceof Error ? loadErr.message : String(loadErr);
        await this.options.pluginStore.updatePluginState(
          pluginId,
          "error",
          `onLoad failed: ${errorMsg}`,
        );
        this.emit("plugin:error", {
          pluginId,
          error: loadErr instanceof Error ? loadErr : new Error(errorMsg),
        });
        throw loadErr;
      }

      this.emit("plugin:loaded", { pluginId, plugin });
      return plugin;
    } catch (err) {
      // Ensure plugin is removed from loaded map on any failure
      // (it may have been added above before the onLoad hook)
      this.plugins.delete(pluginId);

      // Error isolation: set error state but don't crash
      const errorMsg = err instanceof Error ? err.message : String(err);
      await this.options.pluginStore.updatePluginState(
        pluginId,
        "error",
        errorMsg,
      );

      this.emit("plugin:error", {
        pluginId,
        error: err instanceof Error ? err : new Error(errorMsg),
      });

      throw err;
    }
  }

  private resolvePluginPath(path: string): string {
    // If already absolute, use as-is
    if (isAbsolute(path)) {
      return path;
    }

    // Check if it's an npm package (contains / or starts with @)
    if (path.startsWith("@") || path.includes("/")) {
      // For npm packages, we'd use require.resolve in a real implementation
      // For now, assume it's a local path relative to project root
      return resolve(this.getProjectRoot(), path);
    }

    // Default: resolve relative to project root
    return resolve(this.getProjectRoot(), path);
  }

  private async importPluginModule(path: string, bypassCache = false): Promise<unknown> {
    // Check cache first (unless bypassing cache for reload)
    if (!bypassCache && this.loadedModules.has(path)) {
      return this.loadedModules.get(path)!;
    }

    let pathStats;
    try {
      pathStats = await stat(path);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      throw new Error(`Plugin entry does not exist: ${path} (${errorMessage})`);
    }

    if (pathStats.isDirectory()) {
      throw new Error(`Plugin entry must be a file, got directory: ${path}`);
    }

    // Dynamic import - normalize to file URL so query params are honored
    // consistently across Node + Vitest environments.
    const moduleUrl = pathToFileURL(path).href;
    let mod: unknown;

    if (bypassCache) {
      moduleImportVersion += 1;
      const ext = extname(path);
      const baseName = basename(path, ext);
      const reloadedPath = resolve(dirname(path), `.${baseName}.reload-${moduleImportVersion}${ext}`);
      await copyFile(path, reloadedPath);
      mod = await import(pathToFileURL(reloadedPath).href);
    } else {
      mod = await import(moduleUrl);
    }
    this.loadedModules.set(path, mod);
    return mod;
  }

  /**
   * Invalidate the module cache for a plugin path.
   * This ensures a fresh import when the plugin is loaded again.
   */
  private invalidateModuleCache(path: string): void {
    this.loadedModules.delete(path);
    this.log.log(`Module cache invalidated for: ${path}`);
  }

  /**
   * Reload a plugin: stop the old instance, re-import, and start the new one.
   * On failure, roll back to the old instance.
   *
   * @param pluginId - The plugin to reload
   * @param options - Options including timeout for onUnload/onLoad hooks
   */
  async reloadPlugin(
    pluginId: string,
    options?: { timeoutMs?: number },
  ): Promise<FusionPlugin> {
    const timeoutMs = options?.timeoutMs ?? 5000;

    // Get existing plugin
    const oldPlugin = this.plugins.get(pluginId);
    if (!oldPlugin) {
      throw Object.assign(new Error(`Plugin "${pluginId}" is not loaded`), {
        code: "PLUGIN_NOT_LOADED",
      });
    }

    // Get installation record for path
    const installation = await this.options.pluginStore.getPlugin(pluginId);
    const pluginPath = this.resolvePluginPath(installation.path);

    this.log.log(`Reloading plugin: ${pluginId}`);

    // Call onUnload with timeout
    try {
      const ctx = await this.createContext(oldPlugin);
      await this.withTimeout(
        this.safeCallHook(oldPlugin, "onUnload", [ctx]),
        timeoutMs,
        `onUnload timeout for ${pluginId}`,
      );
    } catch (err) {
      this.log.warn(`onUnload for ${pluginId} timed out or failed:`, err);
      // Continue with reload despite onUnload issues
    }

    // Remove old module from cache
    this.invalidateModuleCache(pluginPath);

    // Snapshot old plugin for rollback
    const snapshot = { ...oldPlugin };

    try {
      // Re-import the plugin module
      const mod = await this.importPluginModule(pluginPath, true);
      const newPlugin = this.extractPluginFromModule(mod);

      // Validate manifest
      const manifestValidation = validatePluginManifest(newPlugin.manifest);
      if (!manifestValidation.valid) {
        throw new Error(
          `Invalid plugin manifest: ${manifestValidation.errors.join(", ")}`,
        );
      }

      // Update plugin state
      newPlugin.state = "started";

      // Replace in plugins map
      this.plugins.set(pluginId, newPlugin);

      // Create fresh context and call onLoad
      const ctx = await this.createContext(newPlugin);
      await this.withTimeout(
        this.safeCallHook(newPlugin, "onLoad", [ctx]),
        timeoutMs,
        `onLoad timeout for ${pluginId}`,
      );

      // State is already "started", no need to update store
      // (avoiding started -> started transition which is disallowed)

      this.log.log(`Plugin ${pluginId} reloaded successfully`);

      this.emit("plugin:reloaded", { pluginId, plugin: newPlugin });
      return newPlugin;
    } catch (err) {
      // Rollback: restore old plugin
      this.log.error(`Reload failed for ${pluginId}, rolling back:`, err);

      try {
        // Restore old plugin
        this.plugins.set(pluginId, snapshot);

        // Attempt to reactivate old plugin
        const ctx = await this.createContext(snapshot);
        await this.withTimeout(
          this.safeCallHook(snapshot, "onLoad", [ctx]),
          timeoutMs,
          `Rollback onLoad timeout for ${pluginId}`,
        );

        // Update store state back to started
        await this.options.pluginStore.updatePluginState(pluginId, "started");

        this.log.warn(`Rollback successful for ${pluginId}`);
      } catch (rollbackErr) {
        // Rollback also failed - remove plugin and set error state
        this.log.error(
          `Rollback failed for ${pluginId}, removing plugin:`,
          rollbackErr,
        );

        this.plugins.delete(pluginId);

        const originalError = err instanceof Error ? err.message : String(err);
        const rollbackError = rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
        const combinedError = `Reload failed and rollback failed: ${originalError}; ${rollbackError}`;

        await this.options.pluginStore.updatePluginState(
          pluginId,
          "error",
          combinedError,
        );

        this.emit("plugin:error", {
          pluginId,
          error: new Error(combinedError),
        });

        throw err; // Throw original error
      }

      throw err;
    }
  }

  /**
   * Execute a promise with a timeout.
   */
  private withTimeout<T>(
    promise: Promise<T>,
    ms: number,
    timeoutMessage: string,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(timeoutMessage));
      }, ms);

      promise
        .then((result) => {
          clearTimeout(timer);
          resolve(result);
        })
        .catch((err) => {
          clearTimeout(timer);
          reject(err);
        });
    });
  }

  private extractPluginFromModule(mod: unknown): FusionPlugin {
    if (!mod || typeof mod !== "object") {
      throw new Error("Plugin module must export an object");
    }

    const obj = mod as Record<string, unknown>;

    // Look for default export first, then named export
    const pluginExport = obj.default ?? obj.plugin;

    if (!pluginExport || typeof pluginExport !== "object") {
      throw new Error(
        "Plugin module must export a default 'FusionPlugin' or have a 'plugin' export",
      );
    }

    const plugin = pluginExport as FusionPlugin;

    // Basic validation
    if (!plugin.manifest?.id) {
      throw new Error("Plugin must have a manifest with id");
    }

    return plugin;
  }

  private checkVersionCompatibility(requiredVersion: string): boolean {
    // Simple version comparison for now
    // In a real implementation, use a proper semver library
    const required = this.parseVersion(requiredVersion);
    const minimum = this.parseVersion(MINIMUM_FUSION_VERSION);

    if (required.major > minimum.major) return false;
    if (required.major < minimum.major) return true;
    if (required.minor > minimum.minor) return false;
    if (required.minor < minimum.minor) return true;
    return required.patch <= minimum.patch;
  }

  private parseVersion(version: string): { major: number; minor: number; patch: number } {
    const parts = version.split(".").map(Number);
    return {
      major: parts[0] || 0,
      minor: parts[1] || 0,
      patch: parts[2] || 0,
    };
  }

  private async resolveDependencies(plugin: FusionPlugin): Promise<void> {
    if (!plugin.manifest.dependencies?.length) return;

    for (const depId of plugin.manifest.dependencies) {
      if (!this.plugins.has(depId)) {
        throw new Error(
          `Plugin ${plugin.manifest.id} depends on ${depId}, which is not loaded`,
        );
      }
    }
  }

  // ── Load All ──────────────────────────────────────────────────────

  /**
   * Load all enabled plugins in dependency order.
   */
  async loadAllPlugins(): Promise<{ loaded: number; errors: number }> {
    const enabled = await this.options.pluginStore.listPlugins({ enabled: true });
    const sorted = this.resolveLoadOrder(enabled);

    let loaded = 0;
    let errors = 0;

    for (const installation of sorted) {
      try {
        await this.loadPlugin(installation.id);
        loaded++;
      } catch (err) {
        if ((err as { code?: string }).code !== "PLUGIN_DISABLED") {
          errors++;
          this.log.error(
            `Failed to load plugin ${installation.id}:`,
            err,
          );
        }
      }
    }

    return { loaded, errors };
  }

  /**
   * Topological sort for load order.
   */
  resolveLoadOrder(plugins: PluginInstallation[]): PluginInstallation[] {
    const pluginMap = new Map(plugins.map((p) => [p.id, p]));
    const visited = new Set<string>();
    const result: PluginInstallation[] = [];
    const visiting = new Set<string>();

    const visit = (id: string) => {
      if (visited.has(id)) return;
      if (visiting.has(id)) {
        throw new Error(`Circular dependency detected: ${id}`);
      }

      const plugin = pluginMap.get(id);
      if (!plugin) return; // Skip plugins not in our list

      visiting.add(id);

      // Visit dependencies first
      for (const depId of plugin.dependencies || []) {
        visit(depId);
      }

      visiting.delete(id);
      visited.add(id);
      result.push(plugin);
    };

    for (const plugin of plugins) {
      visit(plugin.id);
    }

    return result;
  }

  // ── Plugin Stopping ────────────────────────────────────────────────

  /**
   * Stop and unload a single plugin.
   */
  async stopPlugin(pluginId: string): Promise<void> {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) {
      this.log.log(`Plugin not loaded: ${pluginId}`);
      return;
    }

    // Get the plugin path for cache invalidation
    const installation = await this.options.pluginStore.getPlugin(pluginId);
    const pluginPath = this.resolvePluginPath(installation.path);

    try {
      // Call onUnload hook
      const ctx = await this.createContext(plugin);
      await this.withTimeout(
        this.safeCallHook(plugin, "onUnload", [ctx]),
        5000,
        `onUnload timeout for ${pluginId}`,
      );
    } catch (err) {
      this.log.error(`Error in onUnload for ${pluginId}:`, err);
    }

    // Update state
    await this.options.pluginStore.updatePluginState(pluginId, "stopped");

    // Remove from loaded plugins
    this.plugins.delete(pluginId);

    // Invalidate module cache for clean re-import
    this.invalidateModuleCache(pluginPath);

    this.emit("plugin:unloaded", { pluginId });
    this.emit("plugin:stopped", pluginId); // Backward compatibility
  }

  /**
   * Stop all loaded plugins in reverse dependency order.
   */
  async stopAllPlugins(): Promise<void> {
    // Get plugins in reverse topological order
    const loadedPlugins = Array.from(this.plugins.values());
    const sorted = this.resolveLoadOrder(
      loadedPlugins.map((p) => ({
        id: p.manifest.id,
        name: p.manifest.name,
        version: p.manifest.version,
        description: p.manifest.description,
        author: p.manifest.author,
        homepage: p.manifest.homepage,
        path: "",
        enabled: true,
        state: p.state,
        settings: {},
        dependencies: p.manifest.dependencies,
        createdAt: "",
        updatedAt: "",
      })),
    );

    // Stop in reverse order
    for (const plugin of sorted.reverse()) {
      try {
        await this.stopPlugin(plugin.id);
      } catch (err) {
        this.log.error(`Error stopping plugin ${plugin.id}:`, err);
      }
    }
  }

  // ── Hook Invocation ────────────────────────────────────────────────

  /**
   * Invoke a hook on all loaded plugins.
   * Errors are isolated - one plugin's failure doesn't affect others.
   */
  async invokeHook(
    hookName: keyof FusionPlugin["hooks"],
    ...args: unknown[]
  ): Promise<void> {
    for (const [pluginId, plugin] of this.plugins) {
      const hook = plugin.hooks[hookName];
      if (!hook) continue;

      try {
        await this.safeCallHook(plugin, hookName, args);
      } catch (err) {
        this.log.error(
          `Error in ${hookName} hook for ${pluginId}:`,
          err,
        );

        // Update plugin state to error
        try {
          await this.options.pluginStore.updatePluginState(
            pluginId,
            "error",
            err instanceof Error ? err.message : String(err),
          );
          plugin.state = "error";
        } catch {
          // Non-fatal
        }

        // Call onError hook if available
        if (hookName !== "onError" && plugin.hooks.onError) {
          try {
            const ctx = await this.createContext(plugin);
            await plugin.hooks.onError(
              err instanceof Error ? err : new Error(String(err)),
              ctx,
            );
          } catch {
            // Non-fatal
          }
        }
      }
    }
  }

  private async safeCallHook(
    plugin: FusionPlugin,
    hookName: keyof FusionPlugin["hooks"],
    args: unknown[],
  ): Promise<void> {
    const hook = plugin.hooks[hookName];
    if (!hook) return;

     
    const fn = hook as (...args: unknown[]) => unknown;
    const result = fn(...args);
    if (result instanceof Promise) {
      await result;
    }
  }

  async checkPluginSetup(pluginId: string): Promise<PluginSetupCheckResult> {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) {
      throw new Error(`Plugin "${pluginId}" is not loaded`);
    }

    if (!plugin.setup) {
      return { status: "installed" };
    }

    const timeout = plugin.setup.manifest.defaultTimeoutMs ?? 30_000;

    try {
      const ctx = await this.createContext(plugin);
      return await this.withTimeout(
        plugin.setup.hooks.checkSetup(ctx),
        timeout,
        `Setup check for "${pluginId}" timed out after ${timeout}ms`,
      );
    } catch (error) {
      return {
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async installPluginSetup(pluginId: string): Promise<void> {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) {
      throw new Error(`Plugin "${pluginId}" is not loaded`);
    }

    if (!plugin.setup?.hooks.install) {
      throw new Error(`Plugin "${pluginId}" has no install hook`);
    }

    const timeout = plugin.setup.manifest.defaultTimeoutMs ?? 120_000;
    const ctx = await this.createContext(plugin);

    try {
      await this.withTimeout(
        plugin.setup.hooks.install(ctx),
        timeout,
        `Install command for "${pluginId}" timed out after ${timeout}ms`,
      );
    } catch (error) {
      if (error instanceof Error && error.message.includes(`timed out after ${timeout}ms`)) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Install hook failed for "${pluginId}": ${message}`);
    }
  }

  async uninstallPluginSetup(pluginId: string): Promise<void> {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) {
      throw new Error(`Plugin "${pluginId}" is not loaded`);
    }

    if (!plugin.setup?.hooks.uninstall) {
      return;
    }

    const timeout = plugin.setup.manifest.defaultTimeoutMs ?? 60_000;
    const ctx = await this.createContext(plugin);

    try {
      await this.withTimeout(
        plugin.setup.hooks.uninstall(ctx),
        timeout,
        `Uninstall command for "${pluginId}" timed out after ${timeout}ms`,
      );
    } catch (error) {
      if (error instanceof Error && error.message.includes(`timed out after ${timeout}ms`)) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Uninstall hook failed for "${pluginId}": ${message}`);
    }
  }

  // ── Accessors ─────────────────────────────────────────────────────

  /**
   * Get all tools from loaded plugins.
   */
  getPluginTools(): PluginToolDefinition[] {
    const tools: PluginToolDefinition[] = [];
    for (const plugin of this.plugins.values()) {
      if (plugin.tools) {
        tools.push(...plugin.tools);
      }
    }
    return tools;
  }

  /**
   * Get all routes from loaded plugins.
   */
  getPluginRoutes(): Array<{ pluginId: string; route: PluginRouteDefinition }> {
    const routes: Array<{ pluginId: string; route: PluginRouteDefinition }> = [];
    for (const [pluginId, plugin] of this.plugins) {
      if (plugin.routes) {
        for (const route of plugin.routes) {
          routes.push({ pluginId, route });
        }
      }
    }
    return routes;
  }

  /**
   * Get all UI slot definitions from loaded plugins.
   */
  getPluginUiSlots(): Array<{ pluginId: string; slot: PluginUiSlotDefinition }> {
    const slots: Array<{ pluginId: string; slot: PluginUiSlotDefinition }> = [];
    for (const [pluginId, plugin] of this.plugins) {
      if (plugin.uiSlots) {
        for (const slot of plugin.uiSlots) {
          slots.push({
            pluginId,
            slot: {
              ...slot,
              surface: slot.surface ?? (typeof slot.slotId === "string" ? slot.slotId as PluginUiSlotDefinition["surface"] : undefined),
            },
          });
        }
      }
    }

    return slots.sort((a, b) => {
      const orderA = a.slot.order ?? Number.MAX_SAFE_INTEGER;
      const orderB = b.slot.order ?? Number.MAX_SAFE_INTEGER;
      if (orderA !== orderB) return orderA - orderB;
      if (a.pluginId !== b.pluginId) return a.pluginId.localeCompare(b.pluginId);
      return String(a.slot.slotId).localeCompare(String(b.slot.slotId));
    });
  }


  /**
   * Get all structured UI contributions from loaded plugins.
   */
  getPluginUiContributions(): Array<{ pluginId: string; contribution: PluginUiContributionDefinition }> {
    const contributions: Array<{ pluginId: string; contribution: PluginUiContributionDefinition }> = [];
    for (const [pluginId, plugin] of this.plugins) {
      if (plugin.uiContributions) {
        for (const contribution of plugin.uiContributions) {
          contributions.push({
            pluginId,
            contribution: normalizePluginUiContributionDefinition(contribution),
          });
        }
      }
    }

    return contributions.sort((a, b) => {
      const orderA = a.contribution.order ?? Number.MAX_SAFE_INTEGER;
      const orderB = b.contribution.order ?? Number.MAX_SAFE_INTEGER;
      if (orderA !== orderB) return orderA - orderB;
      if (a.pluginId !== b.pluginId) return a.pluginId.localeCompare(b.pluginId);
      return a.contribution.contributionId.localeCompare(b.contribution.contributionId);
    });
  }

  /**
   * Get all top-level dashboard view definitions from loaded plugins.
   */
  getPluginDashboardViews(): Array<{ pluginId: string; view: PluginDashboardViewDefinition }> {
    const views: Array<{ pluginId: string; view: PluginDashboardViewDefinition }> = [];
    for (const [pluginId, plugin] of this.plugins) {
      if (plugin.dashboardViews) {
        for (const view of plugin.dashboardViews) {
          views.push({ pluginId, view });
        }
      }
    }
    return views;
  }

  /**
   * Get all schema initialization hooks from loaded plugins.
   */
  getPluginSchemaInitHooks(): Array<{ pluginId: string; hook: PluginOnSchemaInit }> {
    const hooks: Array<{ pluginId: string; hook: PluginOnSchemaInit }> = [];
    for (const [pluginId, plugin] of this.plugins) {
      if (plugin.hooks.onSchemaInit) {
        hooks.push({ pluginId, hook: plugin.hooks.onSchemaInit });
      }
    }
    return hooks;
  }

  /**
   * Get all runtime registrations from loaded plugins.
   * Returns plugin ownership metadata along with the runtime registration.
   */
  getPluginRuntimes(): Array<{ pluginId: string; runtime: PluginRuntimeRegistration }> {
    const runtimes: Array<{ pluginId: string; runtime: PluginRuntimeRegistration }> = [];
    for (const [pluginId, plugin] of this.plugins) {
      if (plugin.runtime) {
        runtimes.push({ pluginId, runtime: plugin.runtime });
      }
    }
    return runtimes;
  }

  /**
   * Get all CLI-backed provider contributions from loaded plugins.
   */
  getCliProviderContributions(): Array<{ pluginId: string; contribution: CliProviderContribution }> {
    const contributions: Array<{ pluginId: string; contribution: CliProviderContribution }> = [];
    for (const [pluginId, plugin] of this.plugins) {
      if (!plugin.cliProviders) continue;
      for (const contribution of plugin.cliProviders) {
        contributions.push({ pluginId, contribution });
      }
    }
    return contributions;
  }

  /**
   * Get all skill contributions from loaded plugins.
   */
  getPluginSkills(): Array<{ pluginId: string; skill: PluginSkillContribution }> {
    const skills: Array<{ pluginId: string; skill: PluginSkillContribution }> = [];
    for (const [pluginId, plugin] of this.plugins) {
      if (plugin.skills) {
        for (const skill of plugin.skills) {
          skills.push({ pluginId, skill });
        }
      }
    }
    return skills;
  }

  /**
   * Get all workflow step contributions from loaded plugins.
   */
  getPluginWorkflowSteps(): Array<{ pluginId: string; step: PluginWorkflowStepContribution }> {
    const steps: Array<{ pluginId: string; step: PluginWorkflowStepContribution }> = [];
    for (const [pluginId, plugin] of this.plugins) {
      if (plugin.workflowSteps) {
        for (const step of plugin.workflowSteps) {
          steps.push({ pluginId, step });
        }
      }
    }
    return steps;
  }

  /**
   * Get all workflow step templates derived from loaded plugin contributions.
   */
  getPluginWorkflowStepTemplates(): Array<{ pluginId: string; template: WorkflowStepTemplate }> {
    return this.getPluginWorkflowSteps().map(({ pluginId, step }) => ({
      pluginId,
      template: {
        id: `plugin:${pluginId}:${step.stepId}`,
        name: step.name,
        description: step.description,
        prompt: step.prompt ?? "",
        toolMode: step.toolMode,
        category: "Plugin",
        icon: "puzzle",
      },
    }));
  }

  /**
   * Get all prompt contributions from loaded plugins.
   */
  getPluginPromptContributions(): Array<{
    pluginId: string;
    contribution: PluginPromptContribution;
    config: PluginPromptContributions;
  }> {
    const contributions: Array<{
      pluginId: string;
      contribution: PluginPromptContribution;
      config: PluginPromptContributions;
    }> = [];
    for (const [pluginId, plugin] of this.plugins) {
      if (plugin.promptContributions) {
        for (const contribution of plugin.promptContributions.contributions) {
          contributions.push({ pluginId, contribution, config: plugin.promptContributions });
        }
      }
    }
    return contributions;
  }

  /**
   * Get all setup metadata and hooks from loaded plugins.
   */
  getPluginSetupInfo(): Array<{ pluginId: string; manifest: PluginSetupManifest; hooks: PluginSetupHooks }> {
    const setups: Array<{ pluginId: string; manifest: PluginSetupManifest; hooks: PluginSetupHooks }> = [];
    for (const [pluginId, plugin] of this.plugins) {
      if (plugin.setup) {
        setups.push({ pluginId, manifest: plugin.setup.manifest, hooks: plugin.setup.hooks });
      }
    }
    return setups;
  }

  /**
   * Get all loaded plugin instances.
   */
  getLoadedPlugins(): FusionPlugin[] {
    return Array.from(this.plugins.values());
  }

  /**
   * Get a loaded plugin by id.
   */
  getPlugin(pluginId: string): FusionPlugin | undefined {
    return this.plugins.get(pluginId);
  }

  /**
   * Check if a plugin is loaded.
   */
  isPluginLoaded(pluginId: string): boolean {
    return this.plugins.has(pluginId);
  }
}
