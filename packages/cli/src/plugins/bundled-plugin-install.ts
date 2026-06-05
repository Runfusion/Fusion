import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validatePluginManifest, type PluginInstallation, type PluginLoader, type PluginManifest, type PluginStore } from "@fusion/core";

const DEPENDENCY_GRAPH_PLUGIN_ID = "fusion-plugin-dependency-graph";
const CURSOR_RUNTIME_PLUGIN_ID = "fusion-plugin-cursor-runtime";

export const BUNDLED_PLUGIN_IDS = [
  "fusion-plugin-dependency-graph",
  "fusion-plugin-reports",
  "fusion-plugin-whatsapp-chat",
  "fusion-plugin-roadmap",
  "fusion-plugin-hermes-runtime",
  "fusion-plugin-openclaw-runtime",
  "fusion-plugin-paperclip-runtime",
  "fusion-plugin-cursor-runtime",
  "fusion-plugin-cli-printing-press",
  "fusion-plugin-compound-engineering",
] as const;

export type BundledPluginId = (typeof BUNDLED_PLUGIN_IDS)[number];

export function isBundledPluginId(id: string): id is BundledPluginId {
  return (BUNDLED_PLUGIN_IDS as readonly string[]).includes(id);
}

export type EnsureBundledResult =
  | "installed"
  | "updated"
  | "already-installed"
  | "missing-bundle";

function getCandidatePluginDirs(pluginId: string): string[] {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const cliPackageRoot = resolve(moduleDir, "..", "..");

  return [
    // Bundled/global runtime: moduleDir is typically <cli>/dist, and plugins are
    // staged under <cli>/dist/plugins/<id>.
    join(moduleDir, "plugins", pluginId),
    // Source/dev fallbacks.
    join(cliPackageRoot, "dist", "plugins", pluginId),
    join(cliPackageRoot, "plugins", pluginId),
    join(cliPackageRoot, "..", "..", "plugins", pluginId),
  ];
}

async function loadManifest(pluginDir: string): Promise<PluginManifest> {
  const manifestPath = join(pluginDir, "manifest.json");
  const content = await readFile(manifestPath, "utf-8");
  const manifest = JSON.parse(content);
  const validation = validatePluginManifest(manifest);
  if (!validation.valid) {
    throw new Error(`Invalid plugin manifest: ${validation.errors.join(", ")}`);
  }
  return manifest;
}

function resolveBundledPluginDir(pluginId: string): string | null {
  for (const path of getCandidatePluginDirs(pluginId)) {
    if (existsSync(join(path, "manifest.json"))) {
      return path;
    }
  }
  return null;
}

/**
 * Resolve the actual loadable entry FILE path for a plugin directory. Node ESM
 * does not allow directory imports, so we must register the explicit file the
 * loader will dynamic-import. Preference order:
 *   1. ./bundled.js   (esbuild-bundled, shipped in npm tarball)
 *   2. ./dist/index.js (legacy prebuilt fallback)
 *   3. ./src/index.ts (workspace/dev fallback when no bundle exists)
 *
 * Returns null when the directory exists but none of the loadable entry files
 * are present. Callers must treat that as a missing bundle rather than
 * persisting a directory path that Node cannot import.
 *
 * Keep in sync with resolvePluginEntryPath in @fusion/core (plugin-loader.ts),
 * which the dashboard install/enable routes use for the same contract.
 */
export function resolvePluginEntryPath(pluginDir: string): string | null {
  const candidates = [
    join(pluginDir, "bundled.js"),
    join(pluginDir, "dist", "index.js"),
    join(pluginDir, "src", "index.ts"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function isDirectoryPath(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export async function ensureBundledPluginInstalled(
  pluginStore: PluginStore,
  pluginLoader: PluginLoader,
  pluginId: string,
): Promise<EnsureBundledResult> {
  let existingPlugin: PluginInstallation | null = null;
  try {
    existingPlugin = await pluginStore.getPlugin(pluginId);
  } catch {
    // Continue; plugin not installed yet.
  }

  const bundledDir = resolveBundledPluginDir(pluginId);
  if (!bundledDir) {
    return "missing-bundle";
  }

  const manifest = await loadManifest(bundledDir);
  const entryPath = resolvePluginEntryPath(bundledDir);

  if (!entryPath) {
    console.warn(`[plugins] Bundled plugin "${pluginId}" is missing a loadable entry file in ${bundledDir}`);
    return "missing-bundle";
  }

  if (existingPlugin) {
    const existingPathIsDirectory = isDirectoryPath(existingPlugin.path);
    const pathChanged = existingPathIsDirectory || existingPlugin.path !== entryPath;
    const versionChanged = existingPlugin.version !== manifest.version;

    if (!pathChanged && !versionChanged) {
      if (existingPlugin.enabled) {
        try {
          await pluginLoader.loadPlugin(existingPlugin.id);
        } catch (err) {
          console.warn("[plugins] failed to load bundled plugin", existingPlugin.id, err);
        }
      }
      return "already-installed";
    }

    await pluginStore.updatePlugin(pluginId, {
      ...(pathChanged ? { path: entryPath } : {}),
      ...(versionChanged ? { version: manifest.version } : {}),
    });

    if (existingPlugin.enabled) {
      try {
        await pluginLoader.loadPlugin(existingPlugin.id);
      } catch (err) {
        console.warn("[plugins] failed to load bundled plugin", existingPlugin.id, err);
      }
    }

    return "updated";
  }

  const plugin = await pluginStore.registerPlugin({
    manifest,
    path: entryPath,
  });

  if (plugin.enabled) {
    try {
      await pluginLoader.loadPlugin(plugin.id);
    } catch (err) {
      console.warn("[plugins] failed to load bundled plugin", plugin.id, err);
    }
  }

  return "installed";
}

/**
 * @deprecated Use {@link ensureBundledPluginInstalled} with the explicit plugin id.
 * Kept for backwards compatibility with existing call sites.
 */
export async function ensureBundledDependencyGraphPluginInstalled(
  pluginStore: PluginStore,
  pluginLoader: PluginLoader,
): Promise<EnsureBundledResult> {
  return ensureBundledPluginInstalled(pluginStore, pluginLoader, DEPENDENCY_GRAPH_PLUGIN_ID);
}

export async function ensureBundledCursorRuntimePluginInstalled(
  pluginStore: PluginStore,
  pluginLoader: PluginLoader,
): Promise<EnsureBundledResult> {
  return ensureBundledPluginInstalled(pluginStore, pluginLoader, CURSOR_RUNTIME_PLUGIN_ID);
}
