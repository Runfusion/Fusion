/**
 * Plugin Management CLI Commands
 *
 * Provides CLI commands for plugin management:
 * - fn plugin list - List installed plugins
 * - fn plugin install <path> - Install a plugin from local path
 * - fn plugin uninstall <id> - Uninstall a plugin
 * - fn plugin enable <id> - Enable a plugin
 * - fn plugin disable <id> - Disable a plugin
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import * as readline from "node:readline";
import { PluginStore, PluginLoader, validatePluginManifest } from "@fusion/core";
import { resolveProject } from "../project-context.js";

/**
 * Get the project path for plugin operations.
 */
async function getProjectPath(projectName?: string): Promise<string> {
  if (projectName) {
    const context = await resolveProject(projectName);
    return context.projectPath;
  }

  try {
    const context = await resolveProject(undefined);
    return context.projectPath;
  } catch {
    return process.cwd();
  }
}

/**
 * Create a PluginStore for the given project.
 */
async function createPluginStore(projectName?: string): Promise<PluginStore> {
  const projectPath = await getProjectPath(projectName);
  const pluginStore = new PluginStore(projectPath + "/.fusion");
  await pluginStore.init();
  return pluginStore;
}

/**
 * Create a PluginLoader for the given project.
 */
async function createPluginLoader(
  pluginStore: PluginStore,
  projectName?: string,
): Promise<{ store: PluginStore; loader: PluginLoader }> {
  const projectPath = await getProjectPath(projectName);
  // Create a mock TaskStore for the loader (plugins don't need full task store access)
  const mockTaskStore = {
    getFusionDir: () => projectPath + "/.fusion",
    on: () => {},
    off: () => {},
  } as unknown as ConstructorParameters<typeof PluginLoader>[0]["taskStore"];

  const loader = new PluginLoader({
    pluginStore,
    taskStore: mockTaskStore,
  });

  return { store: pluginStore, loader };
}

/**
 * Load plugin manifest from a local path.
 */
async function loadManifestFromPath(
  pluginPath: string,
): Promise<{ manifest: import("@fusion/core").PluginManifest; path: string }> {
  const manifestPath = join(pluginPath, "manifest.json");

  if (!existsSync(manifestPath)) {
    throw new Error(`Plugin manifest not found at: ${manifestPath}`);
  }

  const content = await readFile(manifestPath, "utf-8");
  const manifest = JSON.parse(content);

  const validation = validatePluginManifest(manifest);
  if (!validation.valid) {
    throw new Error(`Invalid plugin manifest: ${validation.errors.join(", ")}`);
  }

  return { manifest, path: pluginPath };
}

/**
 * Colorize plugin state for display.
 */
function colorizeState(state: string): string {
  const colors: Record<string, string> = {
    started: "\x1b[32m", // green
    loaded: "\x1b[33m", // yellow
    error: "\x1b[31m", // red
    stopped: "\x1b[2m", // dim
    installed: "\x1b[34m", // blue
  };
  const reset = "\x1b[0m";
  const color = colors[state] || colors.installed;
  return `${color}${state}${reset}`;
}

/**
 * List all installed plugins.
 */
export async function runPluginList(projectName?: string): Promise<void> {
  const pluginStore = await createPluginStore(projectName);

  const plugins = await pluginStore.listPlugins();

  if (plugins.length === 0) {
    console.log();
    console.log("  No plugins installed");
    console.log();
    return;
  }

  console.log();
  console.log("  ID                  Name                    Version  State     Enabled");
  console.log("  ─────────────────────────────────────────────────────────────────────");

  for (const plugin of plugins) {
    const id = plugin.id.padEnd(19);
    const name = plugin.name.substring(0, 23).padEnd(24);
    const version = plugin.version.padEnd(8);
    const state = colorizeState(plugin.state).padEnd(10);
    const enabled = plugin.enabled ? "yes" : "no";
    console.log(`  ${id} ${name} ${version} ${state} ${enabled}`);
  }

  console.log();
}

/**
 * Install a plugin from a local path.
 */
export async function runPluginInstall(
  source: string,
  options?: { projectName?: string },
): Promise<void> {
  const projectName = options?.projectName;
  const { store, loader } = await createPluginLoader(await createPluginStore(projectName), projectName);

  // Determine if source is a local path or npm package
  if (source.startsWith("@")) {
    // npm package
    console.error("Installing plugins from npm packages is not yet implemented");
    console.error("Please provide a local path to the plugin directory.");
    process.exit(1);
  }

  // Local path
  if (!existsSync(source)) {
    console.error(`Plugin path does not exist: ${source}`);
    process.exit(1);
  }

  try {
    const { manifest, path } = await loadManifestFromPath(source);

    console.log();
    console.log(`  Installing ${manifest.name} v${manifest.version}...`);

    // Register the plugin
    const plugin = await store.registerPlugin({
      manifest,
      path,
    });

    // Try to load it
    if (plugin.enabled) {
      try {
        await loader.loadPlugin(plugin.id);
        console.log(`  ✓ ${manifest.name} installed and loaded`);
      } catch (loadErr) {
        console.log(`  ⚠ ${manifest.name} installed but failed to load: ${loadErr instanceof Error ? loadErr.message : String(loadErr)}`);
      }
    } else {
      console.log(`  ✓ ${manifest.name} installed (disabled)`);
    }
    console.log();
  } catch (err) {
    console.error();
    console.error(`  Failed to install plugin: ${err instanceof Error ? err.message : String(err)}`);
    console.error();
    process.exit(1);
  }
}

/**
 * Uninstall a plugin.
 */
export async function runPluginUninstall(
  id: string,
  options?: { force?: boolean; projectName?: string },
): Promise<void> {
  const projectName = options?.projectName;
  const { store, loader } = await createPluginLoader(await createPluginStore(projectName), projectName);

  // Check if plugin exists
  let plugin;
  try {
    plugin = await store.getPlugin(id);
  } catch {
    console.error(`Plugin "${id}" not found`);
    process.exit(1);
  }

  // Confirm unless force
  if (!options?.force) {
    console.log();
    console.log(`  Uninstall "${plugin.name}"?`);
    console.log(`  This will stop and remove the plugin.`);
    console.log();

    const response = await new Promise<string>((resolve) => {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      rl.question("  Continue? [y/N] ", (answer: string) => {
        rl.close();
        resolve(answer.toLowerCase());
      });
    });

    if (response !== "y" && response !== "yes") {
      console.log("  Cancelled");
      return;
    }
  }

  // Stop the plugin
  try {
    await loader.stopPlugin(id);
  } catch {
    // Ignore - might not be loaded
  }

  // Unregister
  await store.unregisterPlugin(id);

  console.log();
  console.log(`  ✓ ${plugin.name} uninstalled`);
  console.log();
}

/**
 * Enable a plugin.
 */
export async function runPluginEnable(
  id: string,
  options?: { projectName?: string },
): Promise<void> {
  const projectName = options?.projectName;
  const { store, loader } = await createPluginLoader(await createPluginStore(projectName), projectName);

  // Check if plugin exists
  let plugin;
  try {
    plugin = await store.getPlugin(id);
  } catch {
    console.error(`Plugin "${id}" not found`);
    process.exit(1);
  }

  if (plugin.enabled) {
    console.log();
    console.log(`  ${plugin.name} is already enabled`);
    console.log();
    return;
  }

  // Enable and start
  await store.enablePlugin(id);

  try {
    await loader.loadPlugin(id);
  } catch (loadErr) {
    console.log(`  ⚠ ${plugin.name} enabled but failed to load: ${loadErr instanceof Error ? loadErr.message : String(loadErr)}`);
    console.log();
    return;
  }

  console.log();
  console.log(`  ✓ ${plugin.name} enabled and started`);
  console.log();
}

/**
 * Disable a plugin.
 */
export async function runPluginDisable(
  id: string,
  options?: { projectName?: string },
): Promise<void> {
  const projectName = options?.projectName;
  const { store, loader } = await createPluginLoader(await createPluginStore(projectName), projectName);

  // Check if plugin exists
  let plugin;
  try {
    plugin = await store.getPlugin(id);
  } catch {
    console.error(`Plugin "${id}" not found`);
    process.exit(1);
  }

  if (!plugin.enabled) {
    console.log();
    console.log(`  ${plugin.name} is already disabled`);
    console.log();
    return;
  }

  // Stop and disable
  await loader.stopPlugin(id);
  await store.disablePlugin(id);

  console.log();
  console.log(`  ✓ ${plugin.name} disabled and stopped`);
  console.log();
}
