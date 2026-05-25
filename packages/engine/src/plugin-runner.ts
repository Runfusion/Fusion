/**
 * PluginRunner - Bridge between PluginLoader and Fusion Engine
 *
 * Orchestrates plugin loading into the engine, invokes hooks at lifecycle points,
 * and provides plugin tools to agent sessions.
 */

import type { TaskStore, Task, WorkflowStepTemplate } from "@fusion/core";
import type {
  PluginLoader,
  PluginStore,
} from "@fusion/core";
import type {
  FusionPlugin,
  PluginToolDefinition,
  PluginRouteDefinition,
  PluginUiSlotDefinition,
  PluginUiContributionDefinition,
  PluginRuntimeRegistration,
  CliProviderContribution,
  PluginContext,
  PluginSkillContribution,
  PluginWorkflowStepContribution,
  PluginPromptContribution,
  PluginPromptContributions,
  PluginPromptSurface,
  PluginSetupManifest,
  PluginSetupHooks,
  PluginSetupCheckResult,
  ExecutorRuntimeTaskContext,
} from "@fusion/core";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@mariozechner/pi-ai";
import { isAbsolute } from "node:path";
import { createLogger, executorLog } from "./logger.js";

// Type for the task store's event data
interface TaskMovedEvent {
  task: Task;
  from: string;
  to: string;
}

export interface PluginRunnerOptions {
  pluginLoader: PluginLoader;
  pluginStore: PluginStore;
  taskStore: TaskStore;
  rootDir: string;
  hookTimeoutMs?: number;
}

/**
 * Cached converted tools - rebuilt when plugin state changes
 */
interface CachedTools {
  tools: ToolDefinition[];
  version: number;
}

/**
 * Cached routes - rebuilt when plugin state changes
 */
interface CachedRoutes {
  routes: Array<{ pluginId: string; route: PluginRouteDefinition }>;
  version: number;
}

/**
 * Cached UI slots - rebuilt when plugin state changes
 */
interface CachedUiSlots {
  slots: Array<{ pluginId: string; slot: PluginUiSlotDefinition }>;
  version: number;
}

interface CachedUiContributions {
  contributions: Array<{ pluginId: string; contribution: PluginUiContributionDefinition }>;
  version: number;
}

/**
 * Cached runtimes - rebuilt when plugin state changes
 */
interface CachedRuntimes {
  runtimes: Array<{ pluginId: string; runtime: PluginRuntimeRegistration }>;
  version: number;
}

interface CachedCliProviderContributions {
  contributions: Array<{ pluginId: string; contribution: CliProviderContribution }>;
  version: number;
}

interface CachedSkills {
  skills: Array<{ pluginId: string; skill: PluginSkillContribution }>;
  version: number;
}

interface CachedWorkflowSteps {
  steps: Array<{ pluginId: string; step: PluginWorkflowStepContribution }>;
  version: number;
}

interface CachedWorkflowStepTemplates {
  templates: Array<{ pluginId: string; template: WorkflowStepTemplate }>;
  version: number;
}

interface CachedPromptContributions {
  contributions: Array<{
    pluginId: string;
    contribution: PluginPromptContribution;
    config: PluginPromptContributions;
  }>;
  version: number;
}

interface CachedSetupInfo {
  setups: Array<{ pluginId: string; manifest: PluginSetupManifest; hooks: PluginSetupHooks }>;
  version: number;
}

const DEFAULT_HOOK_TIMEOUT_MS = 5000;

export class PluginRunner {
  private readonly log = createLogger("plugin-runner");
  private cachedTools: CachedTools | null = null;
  private cachedRoutes: CachedRoutes | null = null;
  private cachedUiSlots: CachedUiSlots | null = null;
  private cachedUiContributions: CachedUiContributions | null = null;
  private cachedRuntimes: CachedRuntimes | null = null;
  private cachedCliProviderContributions: CachedCliProviderContributions | null = null;
  private cachedSkills: CachedSkills | null = null;
  private cachedWorkflowSteps: CachedWorkflowSteps | null = null;
  private cachedWorkflowStepTemplates: CachedWorkflowStepTemplates | null = null;
  private cachedPromptContributions: CachedPromptContributions | null = null;
  private cachedSetupInfo: CachedSetupInfo | null = null;
  private toolsCacheVersion = 0;
  private routesCacheVersion = 0;
  private uiSlotsCacheVersion = 0;
  private uiContributionsCacheVersion = 0;
  private runtimesCacheVersion = 0;
  private cliProviderContributionsCacheVersion = 0;
  private skillsCacheVersion = 0;
  private workflowStepsCacheVersion = 0;
  private workflowStepTemplatesCacheVersion = 0;
  private promptContributionsCacheVersion = 0;
  private setupCacheVersion = 0;
  private hookTimeoutMs: number;

  // Event handler references for cleanup
  private handlePluginEnabled: (plugin: import("@fusion/core").PluginInstallation) => void;
  private handlePluginDisabled: (plugin: import("@fusion/core").PluginInstallation) => void;
  private handlePluginUnregistered: (plugin: import("@fusion/core").PluginInstallation) => void;
  private handlePluginStateChanged!: () => void;
  private handlePluginUpdated!: () => void;
  private handlePluginLoaded: (event: { pluginId: string }) => void;
  private handlePluginUnloaded: (event: { pluginId: string }) => void;
  private handlePluginReloaded: (event: { pluginId: string }) => void;

  constructor(private options: PluginRunnerOptions) {
    this.hookTimeoutMs = options.hookTimeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;

    // Create bound event handlers for proper cleanup
    this.handlePluginEnabled = this.onPluginEnabled.bind(this);
    this.handlePluginDisabled = this.onPluginDisabled.bind(this);
    this.handlePluginUnregistered = this.onPluginUnregistered.bind(this);
    this.handlePluginStateChanged = this.onPluginStateChanged.bind(this);
    this.handlePluginUpdated = this.onPluginUpdated.bind(this);
    this.handlePluginLoaded = this.onPluginLoaded.bind(this);
    this.handlePluginUnloaded = this.onPluginUnloaded.bind(this);
    this.handlePluginReloaded = this.onPluginReloaded.bind(this);
  }

  /**
   * Initialize the plugin runner.
   * Loads all plugins and subscribes to store events.
   */
  async init(): Promise<void> {
    executorLog.log("Initializing PluginRunner...");

    // Load all enabled plugins
    const result = await this.options.pluginLoader.loadAllPlugins();
    executorLog.log(`PluginRunner loaded ${result.loaded} plugins (${result.errors} errors)`);

    // Execute onSchemaInit hooks from loaded plugins.
    const schemaInitHooks = this.options.pluginLoader.getPluginSchemaInitHooks();
    if (schemaInitHooks.length > 0) {
      executorLog.log(`Executing onSchemaInit hooks from ${schemaInitHooks.length} plugins`);
      try {
        const db = this.options.taskStore.getDatabase();
        await db.runPluginSchemaInits(schemaInitHooks);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        executorLog.log(`onSchemaInit execution failed: ${message}`);
      }
    }

    // Subscribe to store events for task lifecycle hooks
    this.subscribeToStoreEvents();

    // Subscribe to plugin store events for automatic hot-load/unload
    this.options.pluginStore.on("plugin:enabled", this.handlePluginEnabled);
    this.options.pluginStore.on("plugin:disabled", this.handlePluginDisabled);
    this.options.pluginStore.on("plugin:unregistered", this.handlePluginUnregistered);
    this.options.pluginStore.on("plugin:stateChanged", this.handlePluginStateChanged);
    this.options.pluginStore.on("plugin:updated", this.handlePluginUpdated);

    // Subscribe to plugin loader events for cache invalidation
    this.options.pluginLoader.on("plugin:loaded", this.handlePluginLoaded);
    this.options.pluginLoader.on("plugin:unloaded", this.handlePluginUnloaded);
    this.options.pluginLoader.on("plugin:reloaded", this.handlePluginReloaded);

    // Build initial caches
    this.invalidateToolsCache();
    this.invalidateRoutesCache();
    this.invalidateUiSlotsCache();
    this.invalidateUiContributionsCache();
    this.invalidateRuntimesCache();
    this.invalidateCliProviderContributionsCache();
    this.invalidateSkillsCache();
    this.invalidateWorkflowStepsCache();
    this.invalidateWorkflowStepTemplatesCache();
    this.invalidatePromptContributionsCache();
    this.invalidateSetupCache();
  }

  /**
   * Shutdown the plugin runner.
   * Stops all plugins and unsubscribes from events.
   */
  async shutdown(): Promise<void> {
    executorLog.log("Shutting down PluginRunner...");

    // Unsubscribe from task store events
    this.unsubscribeFromStoreEvents();

    // Unsubscribe from plugin store events
    this.options.pluginStore.off("plugin:enabled", this.handlePluginEnabled);
    this.options.pluginStore.off("plugin:disabled", this.handlePluginDisabled);
    this.options.pluginStore.off("plugin:unregistered", this.handlePluginUnregistered);
    this.options.pluginStore.off("plugin:stateChanged", this.handlePluginStateChanged);
    this.options.pluginStore.off("plugin:updated", this.handlePluginUpdated);

    // Unsubscribe from plugin loader events
    this.options.pluginLoader.off("plugin:loaded", this.handlePluginLoaded);
    this.options.pluginLoader.off("plugin:unloaded", this.handlePluginUnloaded);
    this.options.pluginLoader.off("plugin:reloaded", this.handlePluginReloaded);

    // Stop all plugins
    await this.options.pluginLoader.stopAllPlugins();

    executorLog.log("PluginRunner shutdown complete");
  }

  /**
   * Invoke a named hook on all loaded plugins.
   * Errors are isolated - one plugin's failure doesn't affect others.
   * Each hook call has a timeout (default 5 seconds).
   */
  async invokeHook(hookName: keyof FusionPlugin["hooks"], ...args: unknown[]): Promise<void> {
    await this.options.pluginLoader.invokeHook(hookName, ...args);
  }

  /**
   * Get all plugin tools converted to the engine's ToolDefinition format.
   * Tools are cached and only rebuilt when plugin state changes.
   */
  getPluginTools(): ToolDefinition[] {
    if (!this.cachedTools || this.cachedTools.version !== this.toolsCacheVersion) {
      const pluginTools = this.options.pluginLoader.getPluginTools();
      this.cachedTools = {
        tools: this.convertPluginTools(pluginTools),
        version: this.toolsCacheVersion,
      };
    }
    return this.cachedTools.tools;
  }

  /**
   * Get all plugin routes with their plugin IDs.
   * Routes are cached and only rebuilt when plugin state changes.
   */
  getPluginRoutes(): Array<{ pluginId: string; route: PluginRouteDefinition }> {
    if (!this.cachedRoutes || this.cachedRoutes.version !== this.routesCacheVersion) {
      this.cachedRoutes = {
        routes: this.options.pluginLoader.getPluginRoutes(),
        version: this.routesCacheVersion,
      };
    }
    return this.cachedRoutes.routes;
  }

  /**
   * Get all UI slot definitions from loaded plugins.
   * UI slots are cached and only rebuilt when plugin state changes.
   */
  getPluginUiSlots(): Array<{ pluginId: string; slot: PluginUiSlotDefinition }> {
    if (!this.cachedUiSlots || this.cachedUiSlots.version !== this.uiSlotsCacheVersion) {
      this.cachedUiSlots = {
        slots: this.options.pluginLoader.getPluginUiSlots(),
        version: this.uiSlotsCacheVersion,
      };
    }
    return this.cachedUiSlots.slots;
  }

  getPluginUiContributions(): Array<{ pluginId: string; contribution: PluginUiContributionDefinition }> {
    if (!this.cachedUiContributions || this.cachedUiContributions.version !== this.uiContributionsCacheVersion) {
      this.cachedUiContributions = {
        contributions: this.options.pluginLoader.getPluginUiContributions(),
        version: this.uiContributionsCacheVersion,
      };
    }
    return this.cachedUiContributions.contributions;
  }

  /**
   * Get all runtime registrations from loaded plugins.
   * Runtimes are cached and only rebuilt when plugin state changes.
   */
  getPluginRuntimes(): Array<{ pluginId: string; runtime: PluginRuntimeRegistration }> {
    if (!this.cachedRuntimes || this.cachedRuntimes.version !== this.runtimesCacheVersion) {
      this.cachedRuntimes = {
        runtimes: this.options.pluginLoader.getPluginRuntimes(),
        version: this.runtimesCacheVersion,
      };
    }
    return this.cachedRuntimes.runtimes;
  }

  getCliProviderContributions(): Array<{ pluginId: string; contribution: CliProviderContribution }> {
    if (!this.cachedCliProviderContributions || this.cachedCliProviderContributions.version !== this.cliProviderContributionsCacheVersion) {
      this.cachedCliProviderContributions = {
        contributions: this.options.pluginLoader.getCliProviderContributions(),
        version: this.cliProviderContributionsCacheVersion,
      };
    }
    return this.cachedCliProviderContributions.contributions;
  }

  getPluginSkills(): Array<{ pluginId: string; skill: PluginSkillContribution }> {
    if (!this.cachedSkills || this.cachedSkills.version !== this.skillsCacheVersion) {
      this.cachedSkills = {
        skills: this.options.pluginLoader.getPluginSkills(),
        version: this.skillsCacheVersion,
      };
    }
    return this.cachedSkills.skills;
  }

  getPluginWorkflowSteps(): Array<{ pluginId: string; step: PluginWorkflowStepContribution }> {
    if (!this.cachedWorkflowSteps || this.cachedWorkflowSteps.version !== this.workflowStepsCacheVersion) {
      this.cachedWorkflowSteps = {
        steps: this.options.pluginLoader.getPluginWorkflowSteps(),
        version: this.workflowStepsCacheVersion,
      };
    }
    return this.cachedWorkflowSteps.steps;
  }

  getPluginWorkflowStepTemplates(): Array<{ pluginId: string; template: WorkflowStepTemplate }> {
    if (!this.cachedWorkflowStepTemplates || this.cachedWorkflowStepTemplates.version !== this.workflowStepTemplatesCacheVersion) {
      this.cachedWorkflowStepTemplates = {
        templates: this.options.pluginLoader.getPluginWorkflowStepTemplates(),
        version: this.workflowStepTemplatesCacheVersion,
      };
    }
    return this.cachedWorkflowStepTemplates.templates;
  }

  getPluginPromptContributions(): Array<{
    pluginId: string;
    contribution: PluginPromptContribution;
    config: PluginPromptContributions;
  }> {
    if (!this.cachedPromptContributions || this.cachedPromptContributions.version !== this.promptContributionsCacheVersion) {
      this.cachedPromptContributions = {
        contributions: this.options.pluginLoader.getPluginPromptContributions(),
        version: this.promptContributionsCacheVersion,
      };
    }
    return this.cachedPromptContributions.contributions;
  }

  getPluginSetupInfo(): Array<{ pluginId: string; manifest: PluginSetupManifest; hooks: PluginSetupHooks }> {
    if (!this.cachedSetupInfo || this.cachedSetupInfo.version !== this.setupCacheVersion) {
      this.cachedSetupInfo = {
        setups: this.options.pluginLoader.getPluginSetupInfo(),
        version: this.setupCacheVersion,
      };
    }
    return this.cachedSetupInfo.setups;
  }

  async checkPluginSetup(pluginId: string): Promise<PluginSetupCheckResult> {
    try {
      return await this.withTimeout(
        this.options.pluginLoader.checkPluginSetup(pluginId),
        this.hookTimeoutMs,
        `Setup check for plugin ${pluginId} timed out`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.warn(`Setup check failed for plugin ${pluginId}: ${message}`);
      return { status: "error", error: message };
    }
  }

  async installPluginSetup(pluginId: string): Promise<{ success: boolean; error?: string }> {
    try {
      await this.options.pluginLoader.installPluginSetup(pluginId);
      this.invalidateSetupCache();
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.warn(`Setup install failed for plugin ${pluginId}: ${message}`);
      return { success: false, error: message };
    }
  }

  async uninstallPluginSetup(pluginId: string): Promise<{ success: boolean; error?: string }> {
    try {
      await this.options.pluginLoader.uninstallPluginSetup(pluginId);
      this.invalidateSetupCache();
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.warn(`Setup uninstall failed for plugin ${pluginId}: ${message}`);
      return { success: false, error: message };
    }
  }

  async getSetupStatuses(): Promise<Array<{ pluginId: string; manifest: PluginSetupManifest; status?: PluginSetupCheckResult }>> {
    const setupInfo = this.getPluginSetupInfo();
    return Promise.all(
      setupInfo.map(async ({ pluginId, manifest }) => ({
        pluginId,
        manifest,
        status: await this.checkPluginSetup(pluginId),
      })),
    );
  }

  async collectExecutorRuntimeEnv(taskCtx: ExecutorRuntimeTaskContext): Promise<{
    env: Record<string, string>;
    pathPrepend: string[];
    perPluginErrors: Array<{ pluginId: string; error: Error }>;
  }> {
    const loadedPlugins = this.options.pluginLoader.getLoadedPlugins();
    const pluginResults: Array<{ pluginId: string; env: Record<string, string>; pathPrepend: string[] }> = [];
    const perPluginErrors: Array<{ pluginId: string; error: Error }> = [];

    for (const plugin of loadedPlugins) {
      if (!plugin.executorRuntimeEnv) {
        continue;
      }

      const pluginId = plugin.manifest.id;
      try {
        const settings = await this.getPluginSettings(pluginId);
        const context: PluginContext = {
          pluginId,
          taskStore: this.options.taskStore,
          settings,
          logger: this.createPluginLogger(pluginId),
          emitEvent: (event: string, data: unknown) => {
            this.log.log(`[plugin:${pluginId}] Event: ${event}`, data);
          },
        };

        const contribution = await plugin.executorRuntimeEnv(taskCtx, context);
        const env = contribution.env ?? {};
        const pathPrepend = contribution.pathPrepend ?? [];

        if (!Array.isArray(pathPrepend) || pathPrepend.some((entry) => typeof entry !== "string" || !isAbsolute(entry))) {
          throw new Error("executorRuntimeEnv.pathPrepend must be an array of absolute path strings");
        }

        for (const [key, value] of Object.entries(env)) {
          if (key === "PATH") {
            throw new Error("executorRuntimeEnv.env must not contain PATH; use pathPrepend instead");
          }
          if (typeof value !== "string") {
            throw new Error(`executorRuntimeEnv.env.${key} must be a string`);
          }
        }

        pluginResults.push({ pluginId, env, pathPrepend });
      } catch (error) {
        const normalizedError = error instanceof Error ? error : new Error(String(error));
        perPluginErrors.push({ pluginId, error: normalizedError });
        this.log.warn(`executorRuntimeEnv failed for plugin ${pluginId}: ${normalizedError.message}`);
      }
    }

    const mergedEnv: Record<string, string> = {};
    const mergedPathPrepend: string[] = [];

    for (const result of pluginResults) {
      for (const [key, value] of Object.entries(result.env)) {
        if (Object.prototype.hasOwnProperty.call(mergedEnv, key)) {
          this.log.warn(`executorRuntimeEnv key override: ${key} overwritten by plugin ${result.pluginId}`);
        }
        mergedEnv[key] = value;
      }
      mergedPathPrepend.unshift(...result.pathPrepend);
    }

    return {
      env: mergedEnv,
      pathPrepend: mergedPathPrepend,
      perPluginErrors,
    };
  }

  getPromptContributionsForSurface(surface: PluginPromptSurface): Array<{
    pluginId: string;
    contribution: PluginPromptContribution;
    config: PluginPromptContributions;
  }> {
    return this.getPluginPromptContributions().filter(({ pluginId, contribution, config }) => {
      const plugin = this.options.pluginLoader.getPlugin(pluginId);
      if (!plugin || plugin.state !== "started") {
        return false;
      }
      if (contribution.surface !== surface) {
        return false;
      }
      return config.enabledByDefault !== false;
    });
  }

  /**
   * Get a specific runtime registration by its runtimeId.
   *
   * @param runtimeId - The unique runtime identifier to find
   * @returns The runtime registration with plugin ID, or undefined if not found
   */
  getRuntimeById(runtimeId: string): { pluginId: string; runtime: PluginRuntimeRegistration } | undefined {
    const registrations = this.getPluginRuntimes();
    return registrations.find((reg) => reg.runtime.metadata.runtimeId === runtimeId);
  }

  /**
   * Get the underlying plugin loader.
   */
  getLoader(): PluginLoader {
    return this.options.pluginLoader;
  }

  /**
   * Get the underlying plugin store.
   */
  getStore(): PluginStore {
    return this.options.pluginStore;
  }

  /**
   * Reload a plugin: stop the old instance, re-import, and start the new one.
   * This invalidates the tools, routes, uiSlots, and runtimes caches.
   */
  async reloadPlugin(pluginId: string): Promise<void> {
    executorLog.log(`Reloading plugin: ${pluginId}`);
    await this.options.pluginLoader.reloadPlugin(pluginId);
    this.invalidateToolsCache();
    this.invalidateRoutesCache();
    this.invalidateUiSlotsCache();
    this.invalidateUiContributionsCache();
    this.invalidateRuntimesCache();
    this.invalidateCliProviderContributionsCache();
    this.invalidateSkillsCache();
    this.invalidateWorkflowStepsCache();
    this.invalidateWorkflowStepTemplatesCache();
    this.invalidatePromptContributionsCache();
    this.invalidateSetupCache();
    executorLog.log(`Plugin ${pluginId} reloaded`);
  }

  // ── Event Handlers for Hot-Load/Unload ─────────────────────────

  /**
   * Handle plugin:enabled event - automatically load the plugin.
   */
  private async onPluginEnabled(plugin: import("@fusion/core").PluginInstallation): Promise<void> {
    // Invalidate caches before the operation to ensure fresh state regardless of outcome
    this.invalidateToolsCache();
    this.invalidateRoutesCache();
    this.invalidateUiSlotsCache();
    this.invalidateUiContributionsCache();
    this.invalidateRuntimesCache();
    this.invalidateCliProviderContributionsCache();
    this.invalidateSkillsCache();
    this.invalidateWorkflowStepsCache();
    this.invalidateWorkflowStepTemplatesCache();
    this.invalidatePromptContributionsCache();
    this.invalidateSetupCache();

    try {
      executorLog.log(`Auto-loading enabled plugin: ${plugin.id}`);
      await this.options.pluginLoader.loadPlugin(plugin.id);
    } catch (err) {
      this.log.error(`Failed to auto-load plugin ${plugin.id}:`, err);
      // Don't rethrow - error isolation
    }
  }

  /**
   * Handle plugin:disabled event - automatically stop the plugin.
   */
  private async onPluginDisabled(plugin: import("@fusion/core").PluginInstallation): Promise<void> {
    // Invalidate caches before the operation to ensure fresh state regardless of outcome
    this.invalidateToolsCache();
    this.invalidateRoutesCache();
    this.invalidateUiSlotsCache();
    this.invalidateUiContributionsCache();
    this.invalidateRuntimesCache();
    this.invalidateCliProviderContributionsCache();
    this.invalidateSkillsCache();
    this.invalidateWorkflowStepsCache();
    this.invalidateWorkflowStepTemplatesCache();
    this.invalidatePromptContributionsCache();
    this.invalidateSetupCache();

    try {
      executorLog.log(`Auto-stopping disabled plugin: ${plugin.id}`);
      await this.options.pluginLoader.stopPlugin(plugin.id);
    } catch (err) {
      this.log.error(`Failed to auto-stop plugin ${plugin.id}:`, err);
      // Don't rethrow - error isolation
    }
  }

  /**
   * Handle plugin:unregistered event - ensure plugin is stopped.
   */
  private async onPluginUnregistered(plugin: import("@fusion/core").PluginInstallation): Promise<void> {
    // Invalidate caches before the operation to ensure fresh state regardless of outcome
    this.invalidateToolsCache();
    this.invalidateRoutesCache();
    this.invalidateUiSlotsCache();
    this.invalidateUiContributionsCache();
    this.invalidateRuntimesCache();
    this.invalidateCliProviderContributionsCache();
    this.invalidateSkillsCache();
    this.invalidateWorkflowStepsCache();
    this.invalidateWorkflowStepTemplatesCache();
    this.invalidatePromptContributionsCache();
    this.invalidateSetupCache();

    try {
      executorLog.log(`Stopping unregistered plugin: ${plugin.id}`);
      await this.options.pluginLoader.stopPlugin(plugin.id);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn(`Failed to stop unregistered plugin ${plugin.id}: ${msg} (plugin '${plugin.id}')`);
    }
  }

  /**
   * Handle plugin state changes - invalidate caches.
   */
  private onPluginStateChanged(): void {
    this.invalidateToolsCache();
    this.invalidateRoutesCache();
    this.invalidateUiSlotsCache();
    this.invalidateUiContributionsCache();
    this.invalidateRuntimesCache();
    this.invalidateCliProviderContributionsCache();
    this.invalidateSkillsCache();
    this.invalidateWorkflowStepsCache();
    this.invalidateWorkflowStepTemplatesCache();
    this.invalidatePromptContributionsCache();
    this.invalidateSetupCache();
  }

  /**
   * Handle plugin updates - invalidate caches.
   */
  private onPluginUpdated(): void {
    this.invalidateToolsCache();
    this.invalidateRoutesCache();
    this.invalidateUiSlotsCache();
    this.invalidateUiContributionsCache();
    this.invalidateRuntimesCache();
    this.invalidateCliProviderContributionsCache();
    this.invalidateSkillsCache();
    this.invalidateWorkflowStepsCache();
    this.invalidateWorkflowStepTemplatesCache();
    this.invalidatePromptContributionsCache();
    this.invalidateSetupCache();
  }

  /**
   * Handle plugin:loaded event from loader - invalidate caches.
   */
  private onPluginLoaded(_event: { pluginId: string }): void {
    this.invalidateToolsCache();
    this.invalidateRoutesCache();
    this.invalidateUiSlotsCache();
    this.invalidateUiContributionsCache();
    this.invalidateRuntimesCache();
    this.invalidateCliProviderContributionsCache();
    this.invalidateSkillsCache();
    this.invalidateWorkflowStepsCache();
    this.invalidateWorkflowStepTemplatesCache();
    this.invalidatePromptContributionsCache();
    this.invalidateSetupCache();
  }

  /**
   * Handle plugin:unloaded event from loader - invalidate caches.
   */
  private onPluginUnloaded(_event: { pluginId: string }): void {
    this.invalidateToolsCache();
    this.invalidateRoutesCache();
    this.invalidateUiSlotsCache();
    this.invalidateUiContributionsCache();
    this.invalidateRuntimesCache();
    this.invalidateCliProviderContributionsCache();
    this.invalidateSkillsCache();
    this.invalidateWorkflowStepsCache();
    this.invalidateWorkflowStepTemplatesCache();
    this.invalidatePromptContributionsCache();
    this.invalidateSetupCache();
  }

  /**
   * Handle plugin:reloaded event from loader - invalidate caches.
   */
  private onPluginReloaded(_event: { pluginId: string }): void {
    this.invalidateToolsCache();
    this.invalidateRoutesCache();
    this.invalidateUiSlotsCache();
    this.invalidateUiContributionsCache();
    this.invalidateRuntimesCache();
    this.invalidateCliProviderContributionsCache();
    this.invalidateSkillsCache();
    this.invalidateWorkflowStepsCache();
    this.invalidateWorkflowStepTemplatesCache();
    this.invalidatePromptContributionsCache();
    this.invalidateSetupCache();
  }

  // ── Tool Conversion ───────────────────────────────────────────────

  /**
   * Convert PluginToolDefinition[] to ToolDefinition[] for the pi-coding-agent.
   *
   * Plugin tools have this signature:
   *   execute(params: Record<string, unknown>, ctx: PluginContext): Promise<PluginToolResult>
   *
   * Engine ToolDefinition has this signature:
   *   execute(toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult>
   *
   * The conversion:
   * 1. Prefixes the tool name with "plugin_"
   * 2. Maps name/description directly (use name as label)
   * 3. Wraps execute to extract params and call plugin's execute
   * 4. Returns { content: result.content } format
   */
  private convertPluginTools(pluginTools: PluginToolDefinition[]): ToolDefinition[] {
    return pluginTools.map((pluginTool) => {
      // Get the plugin context for this tool
      const pluginId = this.getPluginIdForTool(pluginTool);
      const plugin = pluginId ? this.options.pluginLoader.getPlugin(pluginId) : undefined;

      // Store the timeout for use in the closure
      const timeout = this.hookTimeoutMs;

      // Create wrapper that extracts params and uses stored context
      const wrappedExecute = async (
        _toolCallId: string,
        params: Record<string, unknown>,
        _signal: AbortSignal | undefined,
        _onUpdate: unknown | undefined,
        _ctx: unknown,
      ) => {
        if (!plugin) {
          return {
            content: [{ type: "text" as const, text: "Plugin not available" }],
            details: {},
          };
        }

        // Create context for this specific tool call
        const context = await this.createToolContext(plugin);

        try {
          const result = await this.withTimeout(
            pluginTool.execute(params as Record<string, unknown>, context),
            timeout,
            `Tool ${pluginTool.name} execution timed out`,
          );

          // Convert PluginToolResult to AgentToolResult
          return {
            content: result.content,
            isError: result.isError ?? false,
            details: result.details ?? {},
          };
        } catch (err) {
          return {
            content: [{ type: "text" as const, text: `Tool execution failed: ${err instanceof Error ? err.message : String(err)}` }],
            isError: true,
            details: {},
          };
        }
      };

      // Use Type.Any for plugin tool parameters since plugins use JSON Schema
      // which is compatible with TypeBox's Any type
      const anySchema = Type.Any();

      return {
        name: `plugin_${pluginTool.name}`,
        label: pluginTool.name,
        description: pluginTool.description,
        parameters: anySchema,
        execute: wrappedExecute,
      };
    });
  }

  /**
   * Get the plugin ID that owns a tool.
   * We infer it from the loader's perspective - tools are stored per plugin.
   */
  private getPluginIdForTool(tool: PluginToolDefinition): string | undefined {
    const loadedPlugins = this.options.pluginLoader.getLoadedPlugins();
    for (const plugin of loadedPlugins) {
      if (plugin.tools?.some((t) => t.name === tool.name)) {
        return plugin.manifest.id;
      }
    }
    return undefined;
  }

  /**
   * Create a plugin context for tool execution.
   */
  private async createToolContext(plugin: FusionPlugin): Promise<PluginContext> {
    const settings = await this.getPluginSettings(plugin.manifest.id);
    return {
      pluginId: plugin.manifest.id,
      taskStore: this.options.taskStore,
      settings,
      logger: this.createPluginLogger(plugin.manifest.id),
      emitEvent: (event: string, data: unknown) => {
        this.log.log(`[plugin:${plugin.manifest.id}] Event: ${event}`, data);
      },
    };
  }

  /**
   * Create a plugin context for runtime instantiation.
   *
   * This context is passed to plugin runtime factories to allow them
   * to initialize their runtime instances with access to task store,
   * settings, and logging.
   *
   * @param pluginId - The plugin ID to create context for
   * @returns The plugin context, or null if the plugin is not loaded
   */
  async createRuntimeContext(pluginId: string): Promise<PluginContext | null> {
    const plugin = this.options.pluginLoader.getPlugin(pluginId);
    if (!plugin) {
      this.log.warn(`Plugin "${pluginId}" not loaded, cannot create runtime context`);
      return null;
    }

    const settings = await this.getPluginSettings(pluginId);
    return {
      pluginId,
      taskStore: this.options.taskStore,
      settings,
      logger: this.createPluginLogger(pluginId),
      emitEvent: (event: string, data: unknown) => {
        this.log.log(`[plugin:${pluginId}] Event: ${event}`, data);
      },
    };
  }

  /**
   * Get settings for a plugin from the store.
   */
  private async getPluginSettings(pluginId: string): Promise<Record<string, unknown>> {
    try {
      const plugin = await this.options.pluginStore.getPlugin(pluginId);
      return plugin.settings;
    } catch (err) {
      this.log.warn(`Failed to get settings for plugin ${pluginId}: ${err instanceof Error ? err.message : String(err)}`);
      return {};
    }
  }

  /**
   * Create a logger for a plugin.
   */
  private createPluginLogger(pluginId: string): import("@fusion/core").PluginLogger {
    const prefix = `[plugin:${pluginId}]`;
    return {
      info: (...args: unknown[]) => this.log.log(prefix, ...args),
      warn: (...args: unknown[]) => this.log.warn(prefix, ...args),
      error: (...args: unknown[]) => this.log.error(prefix, ...args),
      debug: (...args: unknown[]) => {
        if (process.env.DEBUG?.includes("plugins")) {
          this.log.log(prefix, ...args);
        }
      },
    };
  }

  // ── Cache Invalidation ───────────────────────────────────────────

  /**
   * Invalidate the tools cache, forcing rebuild on next access.
   */
  private invalidateToolsCache(): void {
    this.toolsCacheVersion++;
    this.log.log(`Tools cache invalidated (version: ${this.toolsCacheVersion})`);
  }

  /**
   * Invalidate the routes cache, forcing rebuild on next access.
   */
  private invalidateRoutesCache(): void {
    this.routesCacheVersion++;
    this.log.log(`Routes cache invalidated (version: ${this.routesCacheVersion})`);
  }

  /**
   * Invalidate the UI slots cache, forcing rebuild on next access.
   */
  private invalidateUiSlotsCache(): void {
    this.uiSlotsCacheVersion++;
    this.log.log(`UI slots cache invalidated (version: ${this.uiSlotsCacheVersion})`);
  }

  private invalidateUiContributionsCache(): void {
    this.uiContributionsCacheVersion++;
    this.log.log(`UI contributions cache invalidated (version: ${this.uiContributionsCacheVersion})`);
  }

  /**
   * Invalidate the runtimes cache, forcing rebuild on next access.
   */
  private invalidateRuntimesCache(): void {
    this.runtimesCacheVersion++;
    this.log.log(`Runtimes cache invalidated (version: ${this.runtimesCacheVersion})`);
  }

  private invalidateCliProviderContributionsCache(): void {
    this.cliProviderContributionsCacheVersion++;
    this.log.log(`CLI provider contributions cache invalidated (version: ${this.cliProviderContributionsCacheVersion})`);
  }

  private invalidateSkillsCache(): void {
    this.skillsCacheVersion++;
    this.log.log(`Skills cache invalidated (version: ${this.skillsCacheVersion})`);
  }

  private invalidateWorkflowStepsCache(): void {
    this.workflowStepsCacheVersion++;
    this.log.log(`Workflow steps cache invalidated (version: ${this.workflowStepsCacheVersion})`);
  }

  private invalidateWorkflowStepTemplatesCache(): void {
    this.workflowStepTemplatesCacheVersion++;
    this.log.log(`Workflow step templates cache invalidated (version: ${this.workflowStepTemplatesCacheVersion})`);
  }

  private invalidatePromptContributionsCache(): void {
    this.promptContributionsCacheVersion++;
    this.log.log(`Prompt contributions cache invalidated (version: ${this.promptContributionsCacheVersion})`);
  }

  private invalidateSetupCache(): void {
    this.setupCacheVersion++;
    this.log.log(`Setup cache invalidated (version: ${this.setupCacheVersion})`);
  }

  // ── Store Event Subscriptions ────────────────────────────────────

  /**
   * Subscribe to TaskStore events for task lifecycle hooks.
   */
  private subscribeToStoreEvents(): void {
    this.options.taskStore.on("task:created", this.handleTaskCreated);
    this.options.taskStore.on("task:moved", this.handleTaskMoved);
  }

  /**
   * Unsubscribe from TaskStore events.
   */
  private unsubscribeFromStoreEvents(): void {
    this.options.taskStore.off("task:created", this.handleTaskCreated);
    this.options.taskStore.off("task:moved", this.handleTaskMoved);
  }

  /**
   * Handle task created event - invoke onTaskCreated hook.
   */
  private handleTaskCreated = (task: Task): void => {
    // Fire and forget - don't await
    void this.invokeHookSafe("onTaskCreated", task);
  };

  /**
   * Handle task moved event - invoke onTaskMoved and onTaskCompleted hooks.
   */
  private handleTaskMoved = (event: TaskMovedEvent): void => {
    const { task, from, to } = event;

    // Fire and forget - don't await
    void this.invokeHookSafe("onTaskMoved", task, from, to);

    // If task completed, invoke onTaskCompleted hook
    if (to === "done") {
      void this.invokeHookSafe("onTaskCompleted", task);
    }
  };

  /**
   * Invoke a hook with error isolation and logging.
   */
  async invokeHookSafe(hookName: keyof FusionPlugin["hooks"], ...args: unknown[]): Promise<void> {
    try {
      await this.withTimeout(
        this.invokeHook(hookName, ...args),
        this.hookTimeoutMs,
        `Hook ${hookName} timed out`,
      );
    } catch (err) {
      this.log.warn(`Hook ${hookName} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── Event Handlers for Cache ────────────────────────────────────

  // Note: handlePluginStateChanged and handlePluginUpdated are defined
  // in the hot-load event handlers section above

  // ── Utilities ────────────────────────────────────────────────────

  /**
   * Execute a promise with a timeout.
   * Returns the result on success, throws on timeout.
   */
  private withTimeout<T>(promise: Promise<T>, ms: number, timeoutMessage: string): Promise<T> {
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
}
