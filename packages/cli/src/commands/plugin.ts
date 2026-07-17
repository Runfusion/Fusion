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
import { dirname, extname, join, resolve } from "node:path";
import { readFile, stat } from "node:fs/promises";
import * as readline from "node:readline";
import { PluginStore, PluginLoader, validatePluginManifest, resolveGlobalDir, CentralCore } from "@fusion/core";
import { resolveProject } from "../project-context.js";

export interface BuiltinPluginCatalogEntry {
  id: string;
  name: string;
  description: string;
  category: "runtime" | "integration";
  path?: string;
  experimental?: boolean;
}

export const BUILTIN_PLUGINS: BuiltinPluginCatalogEntry[] = [
  {
    id: "fusion-plugin-hermes-runtime",
    name: "Hermes Runtime",
    description: "Runtime provider for Hermes CLI-backed execution.",
    category: "runtime",
    path: "./plugins/fusion-plugin-hermes-runtime",
    experimental: true,
  },
  {
    id: "fusion-plugin-paperclip-runtime",
    name: "Paperclip Runtime",
    description: "Runtime provider for Paperclip agent connections.",
    category: "runtime",
    path: "./plugins/fusion-plugin-paperclip-runtime",
  },
  {
    id: "fusion-plugin-openclaw-runtime",
    name: "OpenClaw Runtime",
    description: "Runtime provider for OpenClaw execution.",
    category: "runtime",
    path: "./plugins/fusion-plugin-openclaw-runtime",
    experimental: true,
  },
  {
    id: "fusion-plugin-droid-runtime",
    name: "Droid Runtime",
    description: "Runtime provider for Droid CLI execution.",
    category: "runtime",
    path: "./plugins/fusion-plugin-droid-runtime",
    experimental: true,
  },
  {
    id: "fusion-plugin-acp-runtime",
    name: "ACP Runtime",
    description: "Runtime provider that drives any external Agent Client Protocol agent over JSON-RPC/stdio.",
    category: "runtime",
    path: "./plugins/fusion-plugin-acp-runtime",
    experimental: true,
  },
  {
    id: "fusion-plugin-dependency-graph",
    name: "Dependency Graph",
    description: "Dashboard plugin for task dependency graph visualization.",
    category: "integration",
    path: "./plugins/fusion-plugin-dependency-graph",
  },
  {
    id: "fusion-plugin-agent-browser",
    name: "Agent Browser",
    description: "Built-in integration metadata. Package install support lands in FN-3101.",
    category: "integration",
  },
];

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
export async function createPluginStore(
  projectName?: string,
  options?: { centralGlobalDir?: string },
): Promise<PluginStore> {
  try {
    const context = await resolveProject(projectName, process.cwd(), options?.centralGlobalDir);
    const pluginStore = context.store.getPluginStore();
    await pluginStore.init();
    return pluginStore;
  } catch {
    /*
    FNXC:PostgresOnlyDataAccess 2026-07-17-14:20:
    Unregistered-project fallback. PluginStore persists install/state rows in the
    central DB and needs an AsyncDataLayer to run in PostgreSQL backend mode; the
    old fallback constructed it WITHOUT one, so `init()` hit the removed-SQLite
    stub and threw in every PG deployment. Bootstrap a layer-less CentralCore
    (which self-bootstraps the embedded-PG AsyncDataLayer in init()) and pass its
    layer so the fallback store is backend-mode just like the resolveProject path.
    */
    const projectPath = await getProjectPath(projectName);
    const centralGlobalDir = options?.centralGlobalDir ?? resolveGlobalDir();
    const central = new CentralCore(centralGlobalDir);
    await central.init();
    const backendLayer = central.asyncLayer;
    const pluginStore = new PluginStore(projectPath, {
      centralGlobalDir,
      ...(backendLayer ? { asyncLayer: backendLayer } : {}),
    });
    /*
    FNXC:PostgresOnlyDataAccess 2026-07-17-16:30:
    `central.init()` bootstraps and OWNS an embedded-Postgres backend (pool +
    postmaster). Since we don't return `central`, tie its teardown to the returned
    store: closing the PluginStore also closes the CentralCore so the CLI process
    can exit cleanly instead of leaking the pool. The async close is fire-and-forget
    because PluginStore.close() is synchronous.
    */
    const closePluginStore = pluginStore.close.bind(pluginStore);
    pluginStore.close = () => {
      closePluginStore();
      void central.close().catch(() => undefined);
    };
    try {
      await pluginStore.init();
    } catch (initErr) {
      /*
      FNXC:PostgresOnlyDataAccess 2026-07-17-17:40:
      If init() rejects the store is never returned, so the wrapped close() above is
      unreachable and the owned embedded-Postgres CentralCore would leak. Tear it down
      (via the wrapper, which closes both the store and central) before rethrowing.
      */
      pluginStore.close();
      throw initErr;
    }
    return pluginStore;
  }
}

/**
 * Create a PluginLoader for the given project.
 */
export async function createPluginLoader(
  pluginStore: PluginStore,
  projectName?: string,
): Promise<{ store: PluginStore; loader: PluginLoader }> {
  const projectPath = await getProjectPath(projectName);
  // Create a mock TaskStore for the loader (plugins don't need full task store access)
  const mockTaskStore = {
    getRootDir: () => projectPath,
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

const JS_ENTRY_EXTENSIONS = new Set([".js", ".mjs", ".cjs"]);
const TS_SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);

function isJsEntryFile(path: string): boolean {
  return JS_ENTRY_EXTENSIONS.has(extname(path).toLowerCase());
}

function isTypeScriptSource(path: string): boolean {
  return TS_SOURCE_EXTENSIONS.has(extname(path).toLowerCase());
}

async function statPath(path: string): Promise<import("node:fs").Stats | undefined> {
  try {
    return await stat(path);
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

/**
 * Resolve plugin installation source to a compiled JavaScript entry file.
 */
export async function resolvePluginEntryFile(pluginDir: string): Promise<string> {
  const absoluteInputPath = resolve(pluginDir);
  const inputStats = await statPath(absoluteInputPath);

  if (inputStats?.isFile()) {
    if (isTypeScriptSource(absoluteInputPath)) {
      throw new Error(
        `Plugin entry must be compiled JavaScript, but got TypeScript source: ${absoluteInputPath}. Build the plugin first (for example: pnpm build in the plugin directory).`,
      );
    }
    if (isJsEntryFile(absoluteInputPath)) {
      return absoluteInputPath;
    }
    throw new Error(`Plugin entry file must end with .js, .mjs, or .cjs: ${absoluteInputPath}`);
  }

  const packageJsonPath = join(absoluteInputPath, "package.json");
  let selectedCandidate: string | undefined;

  if (existsSync(packageJsonPath)) {
    const packageJson = JSON.parse(await readFile(packageJsonPath, "utf-8")) as Record<string, unknown>;
    const exportsRecord = asRecord(packageJson.exports);
    const dotExport = exportsRecord?.["."];

    const dotExportRecord = asRecord(dotExport);
    if (typeof dotExportRecord?.import === "string") {
      selectedCandidate = dotExportRecord.import;
    } else if (typeof dotExportRecord?.default === "string") {
      selectedCandidate = dotExportRecord.default;
    } else if (typeof dotExport === "string") {
      selectedCandidate = dotExport;
    } else if (typeof packageJson.main === "string") {
      selectedCandidate = packageJson.main;
    }
  }

  if (selectedCandidate) {
    const absoluteCandidate = resolve(absoluteInputPath, selectedCandidate);
    if (isTypeScriptSource(absoluteCandidate)) {
      throw new Error(
        `Plugin entry resolves to TypeScript source (${absoluteCandidate}). Build the plugin first (for example: pnpm build in the plugin directory).`,
      );
    }
    const candidateStats = await statPath(absoluteCandidate);
    if (!candidateStats?.isFile()) {
      throw new Error(
        `Plugin entry file not found: ${absoluteCandidate}. Build the plugin first (for example: pnpm build in the plugin directory).`,
      );
    }
    return absoluteCandidate;
  }

  const distIndexPath = resolve(absoluteInputPath, "dist/index.js");
  const distStats = await statPath(distIndexPath);
  if (distStats?.isFile()) {
    return distIndexPath;
  }

  const indexPath = resolve(absoluteInputPath, "index.js");
  const indexStats = await statPath(indexPath);
  if (indexStats?.isFile()) {
    return indexPath;
  }

  throw new Error(
    `Could not resolve a plugin JavaScript entry file in ${absoluteInputPath}. Tried package.json exports/main, dist/index.js, and index.js. Build the plugin first (for example: pnpm build in the plugin directory).`,
  );
}

/**
 * Load plugin manifest from a local path.
 */
export async function loadManifestFromPath(
  pluginPath: string,
): Promise<{ manifest: import("@fusion/core").PluginManifest; path: string }> {
  const absoluteInputPath = resolve(pluginPath);
  const inputStats = await statPath(absoluteInputPath);
  const manifestDir = inputStats?.isFile() ? dirname(absoluteInputPath) : absoluteInputPath;
  const manifestPath = join(manifestDir, "manifest.json");

  if (!existsSync(manifestPath)) {
    throw new Error(`Plugin manifest not found at: ${manifestPath}`);
  }

  const content = await readFile(manifestPath, "utf-8");
  const manifest = JSON.parse(content);

  const validation = validatePluginManifest(manifest);
  if (!validation.valid) {
    throw new Error(`Invalid plugin manifest: ${validation.errors.join(", ")}`);
  }

  return { manifest, path: manifestDir };
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
  console.log("  ID                  Name                    Version  State     Project Enabled");
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
  options?: { projectName?: string; aiScan?: boolean },
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
    const entryPath = await resolvePluginEntryFile(source);
    const { manifest } = await loadManifestFromPath(source);

    console.log();
    console.log(`  Installing ${manifest.name} v${manifest.version} globally...`);

    // Register the plugin
    const plugin = await store.registerPlugin({
      manifest,
      path: entryPath,
      aiScanOnLoad: options?.aiScan ?? false,
    });

    // Try to load it
    if (plugin.enabled) {
      try {
        await loader.loadPlugin(plugin.id);
        console.log(`  ✓ ${manifest.name} installed globally and enabled for this project`);
      } catch (loadErr) {
        console.log(`  ⚠ ${manifest.name} installed but failed to load: ${loadErr instanceof Error ? loadErr.message : String(loadErr)}`);
      }
    } else {
      console.log(`  ✓ ${manifest.name} installed globally (disabled for this project)`);
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
    console.log(`  Uninstall "${plugin.name}" globally?`);
    console.log("  This removes it for all projects.");
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
  console.log(`  ✓ ${plugin.name} uninstalled globally`);
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
  console.log(`  ✓ ${plugin.name} enabled for this project and started`);
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
  console.log(`  ✓ ${plugin.name} disabled for this project and stopped`);
  console.log();
}

export async function runPluginSetupStatus(
  id: string,
  options?: { projectName?: string },
): Promise<void> {
  const projectName = options?.projectName;
  const { store, loader } = await createPluginLoader(await createPluginStore(projectName), projectName);

  try {
    await store.getPlugin(id);
  } catch {
    console.error(`Plugin "${id}" not found`);
    process.exit(1);
  }

  if (!loader.isPluginLoaded(id)) {
    console.error(`Plugin "${id}" is not loaded. Enable the plugin first.`);
    process.exit(1);
  }

  const loadedPlugin = loader.getPlugin(id);
  if (!loadedPlugin?.setup) {
    console.log("Plugin has no setup requirements");
    return;
  }

  const result = await loader.checkPluginSetup(id);
  console.log(`status: ${result.status}`);
  if (result.version) console.log(`version: ${result.version}`);
  if (result.binaryPath) console.log(`binaryPath: ${result.binaryPath}`);
  if (result.error) console.log(`error: ${result.error}`);
}

export async function runPluginAvailable(): Promise<void> {
  console.log();
  console.log("  ID                             Name                 Category      Installable");
  console.log("  ──────────────────────────────────────────────────────────────────────────────");
  for (const plugin of BUILTIN_PLUGINS) {
    const id = plugin.id.padEnd(30);
    const name = plugin.name.padEnd(20);
    const category = plugin.category.padEnd(13);
    const installable = plugin.path ? "yes" : "metadata-only";
    console.log(`  ${id} ${name} ${category} ${installable}`);
  }
  console.log();
}

export async function runPluginSettings(
  id: string,
  key?: string,
  value?: string,
  options?: { projectName?: string },
): Promise<void> {
  const pluginStore = await createPluginStore(options?.projectName);
  const plugin = await pluginStore.getPlugin(id);

  if (!key) {
    console.log(JSON.stringify(plugin.settings ?? {}, null, 2));
    return;
  }

  if (value === undefined) {
    const currentValue = (plugin.settings ?? {})[key];
    console.log(currentValue === undefined ? "undefined" : JSON.stringify(currentValue, null, 2));
    return;
  }

  const parsedValue = (() => {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  })();

  await pluginStore.updatePluginSettings(id, { [key]: parsedValue });
  console.log(`✓ Updated ${id}.${key}`);
}

export async function runPluginRescan(
  id: string,
  options?: { projectName?: string },
): Promise<void> {
  const projectName = options?.projectName;
  const { store, loader } = await createPluginLoader(await createPluginStore(projectName), projectName);

  let plugin;
  try {
    plugin = await store.getPlugin(id);
  } catch {
    console.error(`Plugin "${id}" not found`);
    process.exit(1);
  }

  try {
    if (plugin.state === "started" && typeof loader.reloadPlugin === "function") {
      await loader.reloadPlugin(id);
    } else if (plugin.enabled) {
      await loader.loadPlugin(id);
    }
  } catch (error) {
    // keep going to show persisted scan verdict/state
    console.error(`Rescan/load failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  const refreshed = await store.getPlugin(id);
  const scan = refreshed.lastSecurityScan;
  const verdict = scan?.verdict ?? "unavailable";
  const summary = scan?.summary ?? refreshed.error ?? "No scan result available";
  const findingCount = scan?.findings?.length ?? 0;

  console.log(`${refreshed.name}`);
  console.log(`verdict: ${verdict}`);
  console.log(`summary: ${summary}`);
  console.log(`findings: ${findingCount}`);

  if (verdict === "blocked" || verdict === "error" || verdict === "unavailable") {
    process.exit(1);
  }
}

export async function runPluginSetup(
  id: string,
  options?: { action?: "install" | "uninstall"; projectName?: string },
): Promise<void> {
  const projectName = options?.projectName;
  const action = options?.action ?? "install";
  const { store, loader } = await createPluginLoader(await createPluginStore(projectName), projectName);

  let plugin;
  try {
    plugin = await store.getPlugin(id);
  } catch {
    console.error(`Plugin "${id}" not found`);
    process.exit(1);
  }

  if (!loader.isPluginLoaded(id)) {
    console.error(`Plugin "${id}" is not loaded. Enable the plugin first.`);
    process.exit(1);
  }

  const loadedPlugin = loader.getPlugin(id);
  if (!loadedPlugin?.setup) {
    console.log("Plugin has no setup requirements");
    return;
  }

  try {
    if (action === "uninstall") {
      await loader.uninstallPluginSetup(id);
      console.log(`✓ ${plugin.name} setup uninstalled`);
      return;
    }

    if (!loadedPlugin.setup.hooks.install) {
      console.error("Plugin has no install hook");
      process.exit(1);
    }

    await loader.installPluginSetup(id);
    console.log(`✓ ${plugin.name} setup installed`);
  } catch (error) {
    console.error(`Failed to ${action} setup for "${id}": ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
